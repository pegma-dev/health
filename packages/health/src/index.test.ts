import { fixedClock, type Clock, type Logger } from "@pegma/spine";
import { createMemoryStore } from "@pegma/storage-core";
import { describe, expect, it, vi } from "vitest";

import {
  createDetailCheck,
  createProcessCheck,
  createStorePingCheck,
  healthProbeCollection,
  runHealthChecks,
  toHealthResponse,
  type CheckResult,
  type HealthCheck,
  type HealthProbeRecord,
} from "./index.js";
import type { Store } from "@pegma/storage-core";

const NOW = "2026-07-27T21:00:00.000Z";

/**
 * Stands in for a store adapter error that embeds credential material. The
 * value is deliberately an obvious placeholder so secret scanners ignore it,
 * while the `AccountKey` marker still proves nothing reached the response.
 */
const SECRET_SHAPED_MESSAGE =
  "AccountName=example;AccountKey=PLACEHOLDER_NOT_A_REAL_KEY";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function failingCheck(
  name: string,
  status: CheckResult["status"],
): HealthCheck {
  return {
    name,
    async run() {
      return { status };
    },
  };
}

describe("createProcessCheck", () => {
  it("always returns ok", async () => {
    const result = await createProcessCheck().run();
    expect(result).toEqual({ status: "ok" });
  });
});

describe("createDetailCheck", () => {
  it("returns the supplied detail", async () => {
    const result = await createDetailCheck("logging", {
      cloudflare: true,
      datadog: false,
    }).run();
    expect(result).toEqual({
      status: "ok",
      detail: { cloudflare: true, datadog: false },
    });
  });
});

describe("createStorePingCheck", () => {
  it("constructs when Web Crypto is unavailable", async () => {
    vi.stubGlobal("crypto", undefined);
    try {
      const check = createStorePingCheck({
        store: createMemoryStore(),
        collection: healthProbeCollection,
        clock: fixedClock(NOW),
      });
      await expect(check.run()).resolves.toMatchObject({ status: "ok" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("round-trips a probe write through an injected store", async () => {
    const store = createMemoryStore();
    const check = createStorePingCheck({
      store,
      collection: healthProbeCollection,
      clock: fixedClock(NOW),
    });
    const result = await check.run();
    expect(result.status).toBe("ok");
    expect(result.latencyMs).toBeTypeOf("number");

    const stored = await store
      .collection(healthProbeCollection)
      .list("__health__");
    expect(stored).toEqual([]);
  });

  it("honors an explicit probe id", async () => {
    let stored: HealthProbeRecord | null = null;
    let observed: HealthProbeRecord | null = null;
    const store = {
      collection() {
        return {
          async getVersioned() {
            return stored === null ? null : { value: stored, version: "1" };
          },
          async insertIfAbsent(value: HealthProbeRecord) {
            stored = value;
            observed = value;
            return { inserted: true, value };
          },
          async putIfUnchanged() {
            return false;
          },
          async deleteIfUnchanged() {
            stored = null;
            return true;
          },
        };
      },
    } as unknown as Store;
    const check = createStorePingCheck({
      store,
      collection: healthProbeCollection,
      clock: fixedClock(NOW),
      id: "replica-a",
    });

    await expect(check.run()).resolves.toMatchObject({ status: "ok" });
    expect(observed).toEqual({
      id: "replica-a",
      partition: "__health__",
      probedAt: NOW,
    });
  });

  it("coalesces concurrent calls on one check instance", async () => {
    const writeStarted = deferred<void>();
    let stored: HealthProbeRecord | null = null;
    let writeCalls = 0;
    let nowCalls = 0;
    const clock: Clock = {
      now() {
        nowCalls += 1;
        return nowCalls === 1 ? NOW : "2026-07-27T21:00:01.000Z";
      },
    };
    const store = {
      collection() {
        return {
          async getVersioned() {
            return stored === null ? null : { value: stored, version: "1" };
          },
          async insertIfAbsent(value: HealthProbeRecord) {
            writeCalls += 1;
            await writeStarted.promise;
            stored = value;
            return { inserted: true, value };
          },
          async putIfUnchanged() {
            return false;
          },
          async deleteIfUnchanged() {
            stored = null;
            return true;
          },
        };
      },
    } as unknown as Store;
    const check = createStorePingCheck({
      store,
      collection: healthProbeCollection,
      clock,
    });

    const first = check.run();
    const second = check.run();
    expect(second).toBe(first);
    writeStarted.resolve();

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { status: "ok" },
      { status: "ok" },
    ]);
    expect(writeCalls).toBe(1);
    expect(nowCalls).toBe(1);
  });

  it("isolates separate check instances sharing one store", async () => {
    const firstWrite = deferred<void>();
    const records = new Map<
      string,
      { value: HealthProbeRecord; version: string }
    >();
    const observedIds = new Set<string>();
    let writeCalls = 0;
    const store = {
      collection() {
        return {
          async getVersioned(key: { readonly id: string }) {
            return records.get(key.id) ?? null;
          },
          async insertIfAbsent(value: HealthProbeRecord) {
            writeCalls += 1;
            observedIds.add(value.id);
            records.set(value.id, { value, version: String(writeCalls) });
            if (writeCalls === 1) {
              await firstWrite.promise;
            } else {
              firstWrite.resolve();
            }
            return { inserted: true, value };
          },
          async putIfUnchanged() {
            return false;
          },
          async deleteIfUnchanged(key: { readonly id: string }) {
            return records.delete(key.id);
          },
        };
      },
    } as unknown as Store;
    const first = createStorePingCheck({
      store,
      collection: healthProbeCollection,
      clock: fixedClock(NOW),
    });
    const second = createStorePingCheck({
      store,
      collection: healthProbeCollection,
      clock: fixedClock("2026-07-27T21:00:01.000Z"),
    });

    const results = await Promise.all([first.run(), second.run()]);

    expect(results).toMatchObject([{ status: "ok" }, { status: "ok" }]);
    expect(observedIds.size).toBe(2);
    for (const id of observedIds) {
      expect(id).toMatch(/^ping-/);
    }
  });

  it("recovers while an earlier timed-out write is still pending", async () => {
    vi.useFakeTimers();
    const slowWrite = deferred<void>();
    let stored: { value: HealthProbeRecord; version: string } | null = null;
    let writeCalls = 0;
    let version = 0;
    let nowCalls = 0;
    const clock: Clock = {
      now() {
        nowCalls += 1;
        return nowCalls === 1
          ? NOW
          : nowCalls === 2
            ? "2026-07-27T21:00:01.000Z"
            : "2026-07-27T21:00:02.000Z";
      },
    };
    const store = {
      collection() {
        return {
          async getVersioned() {
            return stored;
          },
          async insertIfAbsent(value: HealthProbeRecord) {
            writeCalls += 1;
            if (writeCalls === 1) {
              await slowWrite.promise;
            }
            if (stored !== null) {
              return { inserted: false, value: stored.value };
            }
            version += 1;
            stored = { value, version: String(version) };
            return { inserted: true, value };
          },
          async putIfUnchanged(value: HealthProbeRecord, expected: string) {
            if (stored?.version !== expected) {
              return false;
            }
            version += 1;
            stored = { value, version: String(version) };
            return true;
          },
          async deleteIfUnchanged(
            _key: { readonly id: string },
            expected: string,
          ) {
            if (stored?.version !== expected) {
              return false;
            }
            stored = null;
            return true;
          },
        };
      },
    } as unknown as Store;
    const check = createStorePingCheck({
      store,
      collection: healthProbeCollection,
      clock,
      id: "replica-a",
      timeoutMs: 5,
    });

    try {
      const timedOut = check.run();
      await vi.advanceTimersByTimeAsync(5);
      await expect(timedOut).resolves.toMatchObject({
        status: "fail",
        detail: { reason: "store_ping_timeout" },
      });

      await expect(check.run()).resolves.toMatchObject({ status: "ok" });
      expect(writeCalls).toBe(2);

      slowWrite.resolve();
      await Promise.resolve();
      await expect(check.run()).resolves.toMatchObject({ status: "ok" });
      expect(nowCalls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails when the store rejects writes", async () => {
    const brokenStore = {
      collection() {
        return {
          async getVersioned() {
            return null;
          },
          async insertIfAbsent() {
            throw new Error("tables unavailable");
          },
        };
      },
    } as unknown as Store;
    const check = createStorePingCheck({
      store: brokenStore,
      collection: healthProbeCollection,
      clock: fixedClock(NOW),
    });
    const result = await check.run();
    expect(result.status).toBe("fail");
    expect(result.detail).toEqual({ reason: "store_ping_failed" });
  });

  it("bounds repeated conditional write conflicts", async () => {
    const existing: HealthProbeRecord = {
      id: "replica-a",
      partition: "__health__",
      probedAt: NOW,
    };
    let reads = 0;
    let writes = 0;
    const store = {
      collection() {
        return {
          async getVersioned() {
            reads += 1;
            return { value: existing, version: "unchanged" };
          },
          async putIfUnchanged() {
            writes += 1;
            return false;
          },
        };
      },
    } as unknown as Store;
    const check = createStorePingCheck({
      store,
      collection: healthProbeCollection,
      clock: fixedClock(NOW),
      id: "replica-a",
    });

    const result = await check.run();

    expect(result).toMatchObject({
      status: "fail",
      detail: { reason: "store_ping_failed" },
    });
    expect(reads).toBe(3);
    expect(writes).toBe(3);
  });

  it("never leaks the store error message into public detail", async () => {
    const brokenStore = {
      collection() {
        return {
          async getVersioned() {
            return null;
          },
          async insertIfAbsent() {
            throw new Error(SECRET_SHAPED_MESSAGE);
          },
        };
      },
    } as unknown as Store;
    const check = createStorePingCheck({
      store: brokenStore,
      collection: healthProbeCollection,
      clock: fixedClock(NOW),
    });
    const result = await check.run();
    expect(JSON.stringify(result)).not.toContain("AccountKey");
    expect(result.detail).toEqual({ reason: "store_ping_failed" });
  });

  it("reports a timeout as its own enumerated reason", async () => {
    vi.useFakeTimers();
    const hangingStore = {
      collection() {
        return {
          async getVersioned() {
            return null;
          },
          insertIfAbsent() {
            return new Promise<never>(() => {
              // never settles
            });
          },
        };
      },
    } as unknown as Store;
    const check = createStorePingCheck({
      store: hangingStore,
      collection: healthProbeCollection,
      clock: fixedClock(NOW),
      timeoutMs: 5,
    });
    try {
      const pending = check.run();
      await vi.advanceTimersByTimeAsync(5);
      const result = await pending;
      expect(result.status).toBe("fail");
      expect(result.detail).toEqual({ reason: "store_ping_timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses one timeout budget across storage operations", async () => {
    vi.useFakeTimers();
    let stored: HealthProbeRecord | null = null;
    const store = {
      collection() {
        return {
          getVersioned() {
            return new Promise<null>((resolve) => {
              setTimeout(() => resolve(null), 3);
            });
          },
          insertIfAbsent(value: HealthProbeRecord) {
            return new Promise<{ inserted: true; value: HealthProbeRecord }>(
              (resolve) => {
                setTimeout(() => {
                  stored = value;
                  resolve({ inserted: true, value });
                }, 3);
              },
            );
          },
        };
      },
    } as unknown as Store;
    const check = createStorePingCheck({
      store,
      collection: healthProbeCollection,
      clock: fixedClock(NOW),
      timeoutMs: 5,
    });

    try {
      const pending = check.run();
      await vi.advanceTimersByTimeAsync(5);
      await expect(pending).resolves.toMatchObject({
        status: "fail",
        latencyMs: 5,
        detail: { reason: "store_ping_timeout" },
      });
      expect(stored).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runHealthChecks", () => {
  it("aggregates ok when every check passes", async () => {
    const events: Array<{ level: string; message: string }> = [];
    const logger: Logger = {
      log(level, message) {
        events.push({ level, message });
      },
    };
    const result = await runHealthChecks({
      service: "pegma-dev-api",
      clock: fixedClock(NOW),
      logger,
      checks: [
        createProcessCheck(),
        createDetailCheck("logging", { datadog: true }),
      ],
    });
    expect(result).toEqual({
      ok: true,
      status: "ok",
      service: "pegma-dev-api",
      checkedAt: NOW,
      checks: {
        process: { status: "ok" },
        logging: { status: "ok", detail: { datadog: true } },
      },
    });
    expect(events).toEqual([{ level: "info", message: "health.ok" }]);
  });

  it("reports degraded without failing HTTP", async () => {
    const events: Array<{ level: string; message: string }> = [];
    const logger: Logger = {
      log(level, message) {
        events.push({ level, message });
      },
    };
    const result = await runHealthChecks({
      service: "retiregolden-api",
      clock: fixedClock(NOW),
      logger,
      checks: [createProcessCheck(), failingCheck("cache", "degraded")],
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("degraded");
    expect(toHealthResponse(result).status).toBe(200);
    expect(events).toEqual([{ level: "warn", message: "health.degraded" }]);
  });

  it("reports fail and maps to 503 when a check fails", async () => {
    const events: Array<{ level: string; message: string }> = [];
    const logger: Logger = {
      log(level, message) {
        events.push({ level, message });
      },
    };
    const result = await runHealthChecks({
      service: "retiregolden-api",
      clock: fixedClock(NOW),
      logger,
      checks: [createProcessCheck(), failingCheck("storage", "fail")],
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("fail");
    expect(toHealthResponse(result)).toEqual({
      status: 503,
      body: result,
    });
    expect(events).toEqual([{ level: "error", message: "health.failed" }]);
  });

  it("keeps a check named __proto__ visible in the aggregate", async () => {
    const result = await runHealthChecks({
      service: "retiregolden-api",
      clock: fixedClock(NOW),
      checks: [createProcessCheck(), failingCheck("__proto__", "fail")],
    });
    expect(Object.keys(result.checks)).toEqual(["process", "__proto__"]);
    expect(result.checks["__proto__"]).toEqual({ status: "fail" });
    expect(result.status).toBe("fail");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.checks)).toContain(
      '"__proto__":{"status":"fail"}',
    );
  });

  it("rejects duplicate check names instead of dropping a result", async () => {
    await expect(
      runHealthChecks({
        service: "retiregolden-api",
        clock: fixedClock(NOW),
        checks: [
          failingCheck("storage", "fail"),
          createProcessCheck("storage"),
        ],
      }),
    ).rejects.toThrow("duplicate health check names: storage");
  });

  it("maps a throwing check to fail without leaking the error", async () => {
    const events: Array<{
      level: string;
      message: string;
      fields?: Readonly<Record<string, unknown>>;
    }> = [];
    const logger: Logger = {
      log(level, message, fields) {
        events.push({ level, message, ...(fields ? { fields } : {}) });
      },
    };
    const throwingCheck: HealthCheck = {
      name: "storage",
      async run() {
        throw new Error(SECRET_SHAPED_MESSAGE);
      },
    };
    const result = await runHealthChecks({
      service: "retiregolden-api",
      clock: fixedClock(NOW),
      logger,
      checks: [createProcessCheck(), throwingCheck],
    });
    expect(result.status).toBe("fail");
    expect(result.checks["storage"]).toEqual({
      status: "fail",
      detail: { reason: "check_threw" },
    });
    expect(JSON.stringify(result)).not.toContain("AccountKey");
    expect(toHealthResponse(result).status).toBe(503);
    expect(events.map((event) => event.message)).toEqual([
      "health.check_threw",
      "health.failed",
    ]);
    expect(events[0]?.fields).toEqual({
      service: "retiregolden-api",
      check: "storage",
      error: SECRET_SHAPED_MESSAGE,
    });
  });

  it("flattens and caps the logged error text", async () => {
    const events: Array<Readonly<Record<string, unknown>> | undefined> = [];
    const logger: Logger = {
      log(_level, _message, fields) {
        events.push(fields);
      },
    };
    const throwingCheck: HealthCheck = {
      name: "storage",
      async run() {
        throw new Error(
          "first line\r\nfake: forged log line " + "x".repeat(400),
        );
      },
    };
    const result = await runHealthChecks({
      service: "retiregolden-api",
      clock: fixedClock(NOW),
      logger,
      checks: [throwingCheck],
    });
    expect(result.status).toBe("fail");
    const logged = events[0]?.["error"];
    expect(logged).toBeTypeOf("string");
    expect(logged as string).not.toMatch(/[\u0000-\u001F\u007F]/);
    expect((logged as string).length).toBe(303);
    expect(logged as string).toMatch(/\.\.\.$/);
  });
});

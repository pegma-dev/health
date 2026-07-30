import { fixedClock, type Logger } from "@pegma/spine";
import { createMemoryStore } from "@pegma/storage-core";
import { describe, expect, it } from "vitest";

import {
  createDetailCheck,
  createProcessCheck,
  createStorePingCheck,
  healthProbeCollection,
  runHealthChecks,
  toHealthResponse,
  type CheckResult,
  type HealthCheck,
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
      .get({ partition: "__health__", id: "ping" });
    expect(stored).toEqual({
      id: "ping",
      partition: "__health__",
      probedAt: NOW,
    });
  });

  it("fails when the store rejects writes", async () => {
    const brokenStore = {
      collection() {
        return {
          async get() {
            return null;
          },
          async put() {
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

  it("never leaks the store error message into public detail", async () => {
    const brokenStore = {
      collection() {
        return {
          async get() {
            return null;
          },
          async put() {
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
    const hangingStore = {
      collection() {
        return {
          async get() {
            return null;
          },
          put() {
            return new Promise<void>(() => {
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
    const result = await check.run();
    expect(result.status).toBe("fail");
    expect(result.detail).toEqual({ reason: "store_ping_timeout" });
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

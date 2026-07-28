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
    expect(result.detail).toEqual({ reason: "tables unavailable" });
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
});

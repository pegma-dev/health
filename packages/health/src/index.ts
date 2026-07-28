import {
  noopLogger,
  systemClock,
  type Clock,
  type IsoTimestamp,
  type Logger,
} from "@pegma/spine";
import {
  defineCollection,
  type CollectionDefinition,
  type Store,
  type StoredRecord,
} from "@pegma/storage-core";

/** Outcome of a single named probe. */
export type CheckStatus = "ok" | "degraded" | "fail";

/** Safe, host-chosen detail — never put secrets here. */
export interface CheckResult {
  readonly status: CheckStatus;
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly latencyMs?: number;
}

/** One named probe the host registers at the composition root. */
export interface HealthCheck {
  readonly name: string;
  run(): Promise<CheckResult>;
}

/** Aggregated result suitable for a public JSON health body. */
export interface HealthResult {
  readonly ok: boolean;
  readonly status: CheckStatus;
  readonly service: string;
  readonly checkedAt: IsoTimestamp;
  readonly checks: Readonly<Record<string, CheckResult>>;
}

export interface RunHealthChecksOptions {
  readonly service: string;
  readonly checks: readonly HealthCheck[];
  readonly clock?: Clock;
  readonly logger?: Logger;
}

export interface HealthHttpResponse {
  readonly status: number;
  readonly body: HealthResult;
}

/** Record written by {@link createStorePingCheck}. */
export interface HealthProbeRecord {
  readonly id: string;
  readonly partition: string;
  readonly probedAt: IsoTimestamp;
}

const DEFAULT_PARTITION = "__health__";
const DEFAULT_PROBE_ID = "ping";
const DEFAULT_TIMEOUT_MS = 5_000;

function requireString(value: StoredRecord, field: string): string {
  const raw = value[field];
  if (typeof raw !== "string") {
    throw new Error(`health probe record missing string field ${field}`);
  }
  return raw;
}

/**
 * Convenience collection for store pings. Hosts may pass their own
 * {@link CollectionDefinition} instead; this package never creates a Store.
 */
export const healthProbeCollection: CollectionDefinition<HealthProbeRecord> =
  defineCollection({
    name: "health_probes",
    key: (value) => ({ partition: value.partition, id: value.id }),
    codec: {
      encode(value) {
        return {
          id: value.id,
          partition: value.partition,
          probedAt: value.probedAt,
        };
      },
      decode(record) {
        return {
          id: requireString(record, "id"),
          partition: requireString(record, "partition"),
          probedAt: requireString(record, "probedAt") as IsoTimestamp,
        };
      },
    },
  });

/** Always-ok check that proves the process handled the request. */
export function createProcessCheck(name = "process"): HealthCheck {
  return {
    name,
    async run() {
      return { status: "ok" };
    },
  };
}

/**
 * Host-owned static detail check (e.g. which log sinks are configured).
 * Values must be safe to expose publicly — booleans and names, never secrets.
 */
export function createDetailCheck(
  name: string,
  detail: Readonly<Record<string, unknown>>,
  status: CheckStatus = "ok",
): HealthCheck {
  return {
    name,
    async run() {
      return { status, detail };
    },
  };
}

export interface StorePingCheckOptions {
  readonly store: Store;
  readonly collection: CollectionDefinition<HealthProbeRecord>;
  /** Defaults to `__health__`. */
  readonly partitionKey?: string;
  /** Defaults to `ping`. */
  readonly id?: string;
  /** Defaults to `storage`. */
  readonly name?: string;
  /** Defaults to 5000. */
  readonly timeoutMs?: number;
  readonly clock?: Clock;
}

/**
 * Put-then-get round-trip against an injected Store. Proves the storage layer
 * accepts writes and returns them — not merely that a TCP port is open.
 */
export function createStorePingCheck(
  options: StorePingCheckOptions,
): HealthCheck {
  const name = options.name ?? "storage";
  const partition = options.partitionKey ?? DEFAULT_PARTITION;
  const id = options.id ?? DEFAULT_PROBE_ID;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clock = options.clock ?? systemClock;
  const probes = options.store.collection(options.collection);

  return {
    name,
    async run() {
      const started = Date.now();
      try {
        const probedAt = clock.now();
        const record: HealthProbeRecord = { id, partition, probedAt };
        await withTimeout(probes.put(record), timeoutMs);
        const got = await withTimeout(probes.get({ partition, id }), timeoutMs);
        if (got === null || got.probedAt !== probedAt) {
          return {
            status: "fail",
            latencyMs: Date.now() - started,
            detail: { reason: "round_trip_mismatch" },
          };
        }
        return {
          status: "ok",
          latencyMs: Date.now() - started,
        };
      } catch (error) {
        return {
          status: "fail",
          latencyMs: Date.now() - started,
          detail: {
            reason:
              error instanceof Error ? error.message : "store_ping_failed",
          },
        };
      }
    },
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function rank(status: CheckStatus): number {
  switch (status) {
    case "ok":
      return 0;
    case "degraded":
      return 1;
    case "fail":
      return 2;
  }
}

function worstStatus(statuses: readonly CheckStatus[]): CheckStatus {
  let worst: CheckStatus = "ok";
  for (const status of statuses) {
    if (rank(status) > rank(worst)) {
      worst = status;
    }
  }
  return worst;
}

/**
 * Runs every registered check, aggregates status, and emits a Spine log event.
 */
export async function runHealthChecks(
  options: RunHealthChecksOptions,
): Promise<HealthResult> {
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? noopLogger;
  const checkedAt = clock.now();
  const checks: Record<string, CheckResult> = {};

  for (const check of options.checks) {
    checks[check.name] = await check.run();
  }

  const status = worstStatus(
    Object.values(checks).map((result) => result.status),
  );
  const ok = status !== "fail";
  const failing = Object.entries(checks)
    .filter(([, result]) => result.status === "fail")
    .map(([checkName]) => checkName);
  const degraded = Object.entries(checks)
    .filter(([, result]) => result.status === "degraded")
    .map(([checkName]) => checkName);

  const result: HealthResult = {
    ok,
    status,
    service: options.service,
    checkedAt,
    checks,
  };

  if (status === "fail") {
    logger.log("error", "health.failed", {
      service: options.service,
      status,
      failing,
      degraded,
    });
  } else if (status === "degraded") {
    logger.log("warn", "health.degraded", {
      service: options.service,
      status,
      degraded,
    });
  } else {
    logger.log("info", "health.ok", {
      service: options.service,
      status,
    });
  }

  return result;
}

/**
 * Maps an aggregated result to an HTTP status and JSON body.
 * `ok` and `degraded` → 200; `fail` → 503.
 */
export function toHealthResponse(result: HealthResult): HealthHttpResponse {
  return {
    status: result.status === "fail" ? 503 : 200,
    body: result,
  };
}

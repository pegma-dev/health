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
const DEFAULT_PROBE_ID_PREFIX = "ping-";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_LOGGED_ERROR_CHARS = 300;
let fallbackProbeId = 0;

/** Marks a probe that exceeded its own timeout rather than rejecting. */
class ProbeTimeoutError extends Error {}

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
  /** Defaults to a unique id for this check instance. */
  readonly id?: string;
  /** Defaults to `storage`. */
  readonly name?: string;
  /** Defaults to 5000. */
  readonly timeoutMs?: number;
  readonly clock?: Clock;
}

function createDefaultProbeId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === "function") {
    return `${DEFAULT_PROBE_ID_PREFIX}${randomUUID.call(globalThis.crypto)}`;
  }

  fallbackProbeId += 1;
  return `${DEFAULT_PROBE_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${fallbackProbeId.toString(36)}`;
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
  const id = options.id ?? createDefaultProbeId();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clock = options.clock ?? systemClock;
  const probes = options.store.collection(options.collection);
  let inFlight: Promise<CheckResult> | undefined;

  async function writeProbe(
    record: HealthProbeRecord,
    deadline: number,
  ): Promise<void> {
    const key = { partition, id };
    for (;;) {
      const current = await withinDeadline(
        () => probes.getVersioned(key),
        deadline,
      );
      if (current === null) {
        const result = await withinDeadline(
          () => probes.insertIfAbsent(record),
          deadline,
        );
        if (result.inserted) {
          return;
        }
      } else {
        const written = await withinDeadline(
          () => probes.putIfUnchanged(record, current.version),
          deadline,
        );
        if (written) {
          return;
        }
      }
    }
  }

  async function runProbe(): Promise<CheckResult> {
    const started = Date.now();
    const deadline = started + timeoutMs;
    try {
      const probedAt = clock.now();
      const record: HealthProbeRecord = { id, partition, probedAt };
      await writeProbe(record, deadline);
      const got = await withinDeadline(
        () => probes.getVersioned({ partition, id }),
        deadline,
      );
      if (got === null || got.value.probedAt !== probedAt) {
        return {
          status: "fail",
          latencyMs: Date.now() - started,
          detail: { reason: "round_trip_mismatch" },
        };
      }

      try {
        await withinDeadline(
          () => probes.deleteIfUnchanged({ partition, id }, got.version),
          deadline,
        );
      } catch {
        // Cleanup is best effort. The verified round trip remains valid, and a
        // later conditional write can safely reuse this check instance's row.
      }
      return {
        status: "ok",
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      // Never surface the underlying error text: store adapter messages
      // routinely embed account names, URLs, and request ids, and this detail
      // is served on a public endpoint. Report an enumerated reason instead.
      return {
        status: "fail",
        latencyMs: Date.now() - started,
        detail: {
          reason:
            error instanceof ProbeTimeoutError
              ? "store_ping_timeout"
              : "store_ping_failed",
        },
      };
    }
  }

  return {
    name,
    run() {
      if (inFlight !== undefined) {
        return inFlight;
      }

      const attempt = runProbe();
      inFlight = attempt;
      void attempt.finally(() => {
        if (inFlight === attempt) {
          inFlight = undefined;
        }
      });
      return attempt;
    },
  };
}

function withinDeadline<T>(
  operation: () => Promise<T>,
  deadline: number,
): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return Promise.reject(new ProbeTimeoutError("probe deadline elapsed"));
  }
  return withTimeout(operation(), remainingMs);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ProbeTimeoutError(`timed out after ${timeoutMs}ms`));
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

function duplicateNames(checks: readonly HealthCheck[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const check of checks) {
    if (seen.has(check.name)) {
      duplicates.add(check.name);
    }
    seen.add(check.name);
  }
  return [...duplicates];
}

/**
 * Error text is host-supplied and may carry remote input, so control characters
 * (which forge log lines in text-oriented sinks) are flattened and the string is
 * capped before it reaches a logger.
 */
function loggableError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const flattened = text.replace(/[\u0000-\u001F\u007F]/g, " ");
  return flattened.length > MAX_LOGGED_ERROR_CHARS
    ? `${flattened.slice(0, MAX_LOGGED_ERROR_CHARS)}...`
    : flattened;
}

/**
 * Runs one check, mapping a throw to a `fail` result so that one broken check
 * cannot turn the whole probe into an unhandled rejection. The error text goes
 * to the host logger only — never into the public response detail.
 */
async function runCheck(
  check: HealthCheck,
  service: string,
  logger: Logger,
): Promise<CheckResult> {
  try {
    return await check.run();
  } catch (error) {
    logger.log("error", "health.check_threw", {
      service,
      check: check.name,
      error: loggableError(error),
    });
    return { status: "fail", detail: { reason: "check_threw" } };
  }
}

/**
 * Runs every registered check, aggregates status, and emits a Spine log event.
 *
 * Check names must be unique; a duplicate would silently drop a result from the
 * aggregate, so it is rejected instead.
 */
export async function runHealthChecks(
  options: RunHealthChecksOptions,
): Promise<HealthResult> {
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? noopLogger;
  const duplicates = duplicateNames(options.checks);
  if (duplicates.length > 0) {
    throw new Error(`duplicate health check names: ${duplicates.join(", ")}`);
  }
  const checkedAt = clock.now();
  // A null-prototype map: assigning a check named `__proto__` to a plain object
  // would hit the prototype setter and drop the result from the aggregate.
  const checks = Object.create(null) as Record<string, CheckResult>;

  for (const check of options.checks) {
    checks[check.name] = await runCheck(check, options.service, logger);
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

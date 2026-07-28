# Health Project Plan

## Status

**Stage:** Phase 1 implemented (`0.1.0`, public API unstable)

**First named consumers:** pegma.dev Worker (`pegma-dev-api`) and the
RetireGolden account API (`GET /api/health`).

**License:** MIT

**Storage:** optional injected `@pegma/storage-core` `Store`. Process and detail
checks depend only on `@pegma/spine`. Dependencies pinned exactly.

## Vision

Every host needs a public liveness surface that uptime monitors, Datadog
Synthetics, and warm-up pings can hit without learning secrets. Hand-rolled
`/health` handlers diverge: one returns `{ ok: true }`, another probes the
wrong table, a third logs nothing useful when storage is down.

One small component that owns the check contract, aggregation, HTTP mapping,
and a Store round-trip helper — while refusing to own backends or invent
domain collections.

## Problem statement

1. **Liveness is not readiness.** A process that answers JSON is not the same
   as a process that can read and write its store.
2. **Detail leaks.** Operators want to know which log sinks are configured;
   attackers want connection strings. The contract must make safe detail the
   default and leave secrets out of the type surface.
3. **Hosts disagree on wiring.** Autodiscovery of checks looks convenient and
   hides the composition root. Pegma requires explicit registration.

## Core model

- **`HealthCheck`** — a named `run()` that returns `ok | degraded | fail`,
  optional safe `detail`, and optional `latencyMs`.
- **`runHealthChecks`** — runs registered checks, aggregates the worst status,
  emits `health.ok` / `health.degraded` / `health.failed` through an injected
  Spine `Logger`.
- **`toHealthResponse`** — `ok`/`degraded` → HTTP 200; `fail` → HTTP 503.
- **Helpers** — `createProcessCheck`, `createDetailCheck`,
  `createStorePingCheck` (put-then-get on an injected Store + collection).

## Design decisions

- **Injected Store only.** No Azure/D1 SDK imports. Adapters stay in
  storage-core.
- **Dedicated probe collection.** Default convenience definition
  `healthProbeCollection`; hosts may substitute their own.
- **No HTTP framework.** Return `{ status, body }` so Workers and Azure
  Functions both map trivially.
- **Degraded stays 200.** Synthetics that only check status codes still pass;
  log monitors can watch `health.degraded`.

## Scope

### In scope

- Check contracts, aggregation, HTTP mapping, process/detail/store helpers.
- Spine log events for probe outcomes.

### Non-goals

- Metrics/APM product, dashboards, or alert routing.
- Autodiscovery of checks.
- Owning a storage adapter or domain data.

## Package architecture

| Package         | Responsibility                    | Phase |
| --------------- | --------------------------------- | ----- |
| `@pegma/health` | Checks, aggregation, HTTP mapping | 1     |

## Delivery phases

### Phase 1 — contracts and helpers (done)

Check types, aggregator, HTTP helper, process/detail/store ping, memory-store
tests, CI.

### Phase 2 — reference wiring

pegma.dev Worker and RetireGolden `/api/health` consume the package.

### Phase 3 — publish

Trusted-publisher npm release once consumers are green.

## Near-term backlog

- Optional timeout / concurrency options on the aggregator.
- Document Datadog Synthetics assertions against the public JSON shape.

# Health

[![CI](https://github.com/pegma-dev/health/actions/workflows/ci.yml/badge.svg)](https://github.com/pegma-dev/health/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Composable health probes and HTTP responses for Pegma hosts.

> [!IMPORTANT]
> Pegma is in early `0.x` development. Packages are published, but no public
> API is stable.

## Why it exists

Hosts need a boring public `/health` that proves the process is alive, optionally
proves storage round-trips, emits a structured log line, and never leaks
secrets. This package owns that contract; the host owns wiring and backends.

## Constraint that shapes everything

**Explicit checks at the composition root.** No autodiscovery. No owned Store.
Safe detail only.

## Usage

```ts
import {
  createDetailCheck,
  createProcessCheck,
  createStorePingCheck,
  healthProbeCollection,
  runHealthChecks,
  toHealthResponse,
} from "@pegma/health";

const result = await runHealthChecks({
  service: "my-api",
  logger,
  checks: [
    createProcessCheck(),
    createDetailCheck("logging", { datadog: true }),
    createStorePingCheck({ store, collection: healthProbeCollection }),
  ],
});
const { status, body } = toHealthResponse(result);
```

## Non-goals

- Metrics, APM, or alert fan-out
- Storage adapters
- UI dashboards

## Development

Requires Node.js 22+.

```sh
npm ci
npm run format:check
npm run check
npm test
```

Maintainers should follow [the release runbook](docs/RELEASING.md). Releases
publish only from protected signed tags through npm trusted publishing.

## License

MIT

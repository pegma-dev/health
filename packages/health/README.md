# `@pegma/health`

Composable health probes and HTTP responses for Pegma hosts.

> [!IMPORTANT]
> Pegma is in early `0.x` development. This package's public API is unstable.

```ts
import {
  createProcessCheck,
  createStorePingCheck,
  runHealthChecks,
  toHealthResponse,
  healthProbeCollection,
} from "@pegma/health";
import { createMemoryStore } from "@pegma/storage-core";

const store = createMemoryStore();
const result = await runHealthChecks({
  service: "my-api",
  checks: [
    createProcessCheck(),
    createStorePingCheck({
      store,
      collection: healthProbeCollection,
    }),
  ],
});
const { status, body } = toHealthResponse(result);
```

Hosts register checks at the composition root. This package never creates a
storage adapter and never invents domain collections for you — pass an
injected `Store` and a collection definition you own (or use the exported
`healthProbeCollection` convenience definition).

Check names must be unique. A check that throws is reported as
`{ status: "fail", detail: { reason: "check_threw" } }` and the error text is
logged through the injected `Logger` only, never placed in the public body. A
check must settle, though: `runHealthChecks` imposes no deadline of its own, so
bound your own I/O the way `createStorePingCheck` bounds its `timeoutMs`.

`createStorePingCheck` performs a write-and-read round trip for each probe
execution, so a host serving it on a public route SHOULD rate limit or briefly
cache that route — see
[`docs/MONITORING.md`](https://github.com/pegma-dev/health/blob/main/docs/MONITORING.md).
Construct the check once at the composition root and reuse it for every health
request. Concurrent callers share one execution and its `latencyMs`. The default
record id is unique to that check instance, which keeps replicas from sharing a
probe row, and a verified row is conditionally removed after the round trip.
Pass an explicit `id` when the host needs a stable key; keep that id distinct
among simultaneously running replicas. Earlier releases used `ping` as the
default, so pass `id: "ping"` to retain that key intentionally.

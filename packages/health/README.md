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

`createStorePingCheck` writes and reads on every call, so a host serving it on a
public route SHOULD rate limit or briefly cache that route — see
[`docs/MONITORING.md`](https://github.com/pegma-dev/health/blob/main/docs/MONITORING.md).

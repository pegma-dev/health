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

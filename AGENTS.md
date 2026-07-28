# Working in this repository

Read this before changing anything. It is short on purpose.

## What this is part of

Health is a component of **Pegma**, a family of MIT-licensed packages a host
application composes. Shared contracts live in `@pegma/spine`; persistence in
`@pegma/storage-core`. They publish under the `@pegma` scope, one repository
per component.

The governing principle, which every rule below follows from:

> **Optimize for a fresh agent context window.** How much must be read to make
> a correct change, and how does the change prove itself correct? Minimize the
> first, mechanize the second.

This package's whole value is a boring, safe public probe a host can mount and
an uptime monitor can trust. A change that quietly exposes secrets, invents a
backend, or auto-discovers checks is worse than no package at all.

## Hard rules

**Take an injected `Store`; never create one.** The host owns the adapter and
the table. If a change here needs to import `@pegma/storage-azure-tables` or
construct a client, the design is wrong.

**A store probe must prove write + read, not only connectivity.** Prefer
put-then-get (or an equivalent round-trip). A TCP ping that never touches the
codec lies about readiness.

**Probes must not invent domain collections.** Use a dedicated health
collection/partition the host registers, or the exported
`healthProbeCollection` convenience definition — never write into accounts,
sessions, or other domain partitions.

**Import shared types from spine; pin `@pegma/*` deps exactly.**
`IsoTimestamp`, `Clock`, and `Logger` come from `@pegma/spine`. A caret would
let CI resolve a version nobody tested against.

**Public detail must stay safe.** Booleans and sink names are fine. API keys,
connection strings, stack traces with secrets, and customer identifiers are
not. Prefer omitting a field over redacting one badly.

**Never write literal control characters into source.** Write them as escape
sequences such as backslash-u-0000 through backslash-u-001F, and verify the
bytes after any tool-assisted edit.

## Packaging traps already paid for

Each published package needs its **own** README and LICENSE inside the package
directory; npm ignores files at the repository root. Each needs `prepack`
running the build. Each package `tsconfig.json` must exclude
`src/**/*.test.ts`, or compiled tests ship to consumers.

## Workflow

Work on a `claude/*` branch and open a pull request. The gate is
`npm run format:check`, `npm run check`, `npm test` — all three, on Node 22
and 24. Store tests run against `createMemoryStore()` from
`@pegma/storage-core`.

Publishing is trusted-publisher only; no tokens exist. A release starts from a
protected signed annotated `vX.Y.Z` tag already on `origin/main`, followed by
`gh release create vX.Y.Z --verify-tag`. The unprivileged preparation job runs
the gate and packs the exact artifact; only the minimal publish job receives
OIDC authority. See `docs/RELEASING.md`.

## Where things stand

`@pegma/health` offers check contracts, `runHealthChecks`, `toHealthResponse`,
`createProcessCheck`, `createDetailCheck`, and `createStorePingCheck`.

Siblings: [spine](https://github.com/pegma-dev/spine),
[storage-core](https://github.com/pegma-dev/storage-core),
[logger-adapters](https://github.com/pegma-dev/logger-adapters).

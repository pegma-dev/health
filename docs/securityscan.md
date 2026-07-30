# Security Scan Report

**Date:** 2026-07-28
**Scope:** Repository-wide security review of `@pegma/health`
**Method:** Manual source review, dependency audit, CI/CD workflow review, configuration review. No files were modified other than this report.

## Findings

_Findings are appended below as the scan progresses._

---

### SEC-001 — Storage error messages leak into the public health response body

- **Severity:** Medium
- **File:** `packages/health/src/index.ts`, lines 172–181 (`createStorePingCheck` → `catch` block)
- **Evidence:**
  ```ts
  } catch (error) {
    return {
      status: "fail",
      ...
      detail: {
        reason:
          error instanceof Error ? error.message : "store_ping_failed",
      },
    };
  }
  ```
  Any error thrown by the injected `Store` (e.g. an Azure Table Storage SDK
  error) has its `error.message` copied verbatim into `detail.reason`, which
  flows into `HealthResult.checks` and then into the public HTTP body produced
  by `toHealthResponse`. Storage SDK error messages routinely embed account
  names, table URLs, request IDs, and sometimes fragments of credentials or
  connection strings (depending on the adapter).
- **Exploitability:** An unauthenticated caller of the mounted health endpoint
  can deliberately induce storage failures (or simply wait for one) and read
  internal infrastructure details from the 503 response. This directly
  violates the repository's own hard rule: "Public detail must stay safe…
  Prefer omitting a field over redacting one badly." No redaction is applied.
- **Recommendation:** Replace `error.message` with a static, enumerated reason
  code (e.g. `"store_ping_failed"`) and log the full error server-side via the
  injected `Logger` instead of returning it.
- ✅ Resolved 2026-07-29 — `createStorePingCheck` now reports only the
  enumerated reasons `store_ping_failed` / `store_ping_timeout`, never
  `error.message`; covered by a test asserting a connection string never
  reaches the response.

---

### SEC-002 — Special object keys in check names corrupt the aggregated result

- **Severity:** Low
- **File:** `packages/health/src/index.ts`, lines 234–238 (`runHealthChecks`)
- **Evidence:**
  ```ts
  const checks: Record<string, CheckResult> = {};
  for (const check of options.checks) {
    checks[check.name] = await check.run();
  }
  ```
  `checks` is a plain object used as a string-keyed map. A check named
  `__proto__` triggers the prototype setter (`checks.__proto__ = result`
  mutates the object's prototype instead of storing an own property), so the
  check silently disappears from `Object.values`, status aggregation, and the
  serialized JSON body — a failing check could report as invisible while the
  aggregate still reads `"ok"`. Names like `constructor` or `toString`
  shadow inherited members, and duplicate names silently overwrite each
  other.
- **Exploitability:** Low — check names are host-controlled constants, not
  attacker input. Exploitation requires a host (or a dependency supplying
  checks) to register an adversarial name, accidentally or maliciously. It is
  a footgun in a package whose entire purpose is trustworthy status
  reporting.
- **Recommendation:** Build the map with `Object.create(null)` or a `Map`
  converted at serialization time, and reject or deduplicate duplicate check
  names at registration.
- ✅ Resolved 2026-07-29 — `runHealthChecks` builds `checks` with
  `Object.create(null)` so a `__proto__` check is a normal own property, and
  rejects duplicate check names before running any check.

---

### SEC-003 — Uncaught check exceptions and no global timeout break the health contract

- **Severity:** Low
- **File:** `packages/health/src/index.ts`, lines 236–238 (`runHealthChecks`)
- **Evidence:** `checks[check.name] = await check.run();` is not wrapped in
  try/catch. Only `createStorePingCheck` handles its own errors (and has a
  timeout); arbitrary host-registered checks that throw or never settle cause
  `runHealthChecks` to reject or hang.
- **Exploitability:** A single buggy check turns the health endpoint from a
  controlled 503 JSON body into an unhandled rejection — which many Node HTTP
  frameworks render as a 500 with a stack trace (a separate information-
  disclosure path) — or into a hung connection, which is an easy way to
  exhaust an uptime monitor's patience and the server's sockets. This
  undermines the package's stated purpose of "a boring, safe public probe."
- **Recommendation:** Wrap each `check.run()` in try/catch and map throws to
  `{ status: "fail", detail: { reason: "check_threw" } }`; consider a
  per-check default timeout like the one in `createStorePingCheck`.
- ✅ Resolved 2026-07-29 — each `check.run()` is wrapped: a throw becomes
  `{ status: "fail", detail: { reason: "check_threw" } }` with the error text
  logged as `health.check_threw` instead of returned. No global timeout was
  added: capping every host check at a fixed deadline would turn a slow but
  healthy check into a false 503, and making the deadline configurable is new
  public API rather than a fix. A check that never settles remains the host's
  responsibility, now stated in the README and `docs/MONITORING.md`.

---

### SEC-004 — Public probe performs a storage write on every request (cost amplification)

- **Severity:** Informational
- **File:** `packages/health/src/index.ts`, lines 154–171 (`createStorePingCheck`)
- **Evidence:** Every call to the health check performs `probes.put(record)`
  followed by `probes.get(...)`. `toHealthResponse` is documented (README,
  `docs/MONITORING.md`) as a public, unauthenticated endpoint body, and
  `docs/MONITORING.md` recommends polling every 1–5 minutes.
- **Exploitability:** Anyone who can reach the health endpoint can force one
  storage write + one read per request, with no rate limiting in this package.
  Against a metered backend (e.g. Azure Table Storage) this is a
  cost-amplification / write-exhaustion vector. This trade-off is intentional
  — the repository's own hard rule requires a put-then-get round trip rather
  than a connectivity ping — so this is recorded as accepted-by-design risk.
- **Recommendation:** Document that hosts SHOULD place rate limiting or a
  short cache in front of the public health route, or scrape it only from
  trusted monitors.
- ✅ Resolved 2026-07-29 — documented as a host responsibility:
  `docs/MONITORING.md` gains a "Protect the route from amplification" section
  and the package README repeats it. No code change; the put-then-get round
  trip is required by the repository's hard rules.

---

## Areas reviewed with no findings

- **Dependency audit:** `npm audit` reports 0 vulnerabilities across 103
  dependencies. All `@pegma/*` dependencies are pinned exactly (no caret
  ranges), per policy. No `git+` or plain `http://` resolved URLs in
  `package-lock.json`.
- **Secret scan:** No API keys, tokens, connection strings, `.env`, `.pem`, or
  `.key` files tracked in git. `.gitignore` excludes `.env*`. Trusted
  publishing is OIDC-only; `id-token: write` is confined to the `publish` job
  (enforced by a test in `tests/release-packages.test.ts`).
- **CI/CD workflows** (`.github/workflows/ci.yml`, `codeql.yml`,
  `publish.yml`): all actions pinned to full commit SHAs; minimal
  `permissions:` blocks (`contents: read` by default); no
  `pull_request_target`, no `workflow_dispatch` on publish, no script
  injection from event data (tag name is used only in a `ref:` checkout
  expression and validated by `scripts/release-packages.mjs` against
  `/^v\d+\.\d+\.\d+$/`).
- **Release script** (`scripts/release-packages.mjs`): signed annotated-tag
  verification with an allowed-signers file, timing-safe comparisons
  (`timingSafeEqual`) for commits/hashes, tarball hash re-verification before
  publish, tarball allowlist (`package.json`, `README.md`, `LICENSE`,
  `dist/` only), smoke test uses `--ignore-scripts`, publish restricted to
  the GitHub release event with npm provenance, no token fallback.
- **Packaging:** `packages/health/package.json` `files` allowlist covers only
  `dist/`; `prepack` builds; `packages/health/tsconfig.json` excludes
  `src/**/*.test.ts`; `sideEffects: false`. Root `package.json` is private.
- **Control characters:** No literal control characters (U+0000–U+001F) found
  in any tracked source file, per the repository hard rule.
- **Store probe design:** Uses the dedicated `health_probes` collection and
  `__health__` partition; never writes to domain collections; never
  constructs a `Store` (injection only). Codec validates field types on
  decode.
- **TypeScript config:** `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noEmitOnError` enabled.

## Summary

| ID      | Severity      | Finding                                                        | Status             |
| ------- | ------------- | -------------------------------------------------------------- | ------------------ |
| SEC-001 | Medium        | Store error messages leak into public health response `detail` | ✅ Resolved        |
| SEC-002 | Low           | `__proto__`/duplicate check names corrupt aggregated results   | ✅ Resolved        |
| SEC-003 | Low           | Uncaught check exceptions / no timeout break health contract   | ✅ Resolved        |
| SEC-004 | Informational | Storage write per public health request (accepted by design)   | ✅ Resolved (docs) |

**Scan completed:** 2026-07-28. No files other than this report were modified.

**Remediation:** 2026-07-29. SEC-001 through SEC-004 addressed in
`packages/health/src/index.ts`, its tests, the package README, and
`docs/MONITORING.md`; the manifest is prepared for a `@pegma/health` 0.1.2
release, which publishes only from a signed release tag.

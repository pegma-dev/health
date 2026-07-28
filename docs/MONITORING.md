# Monitoring contract

Public health responses from `@pegma/health` are safe to scrape. Hosts map
`toHealthResponse` to HTTP:

| Aggregated `status` | HTTP | `ok` |
| ------------------- | ---- | ---- |
| `ok`                | 200  | true |
| `degraded`          | 200  | true |
| `fail`              | 503  | false |

## Example body

```json
{
  "ok": true,
  "status": "ok",
  "service": "pegma-dev-api",
  "checkedAt": "2026-07-27T21:00:00.000Z",
  "checks": {
    "process": { "status": "ok" },
    "logging": {
      "status": "ok",
      "detail": { "cloudflare": true, "datadog": true }
    },
    "storage": { "status": "ok", "latencyMs": 14 }
  }
}
```

## Datadog Synthetics (HTTP)

Create one Synthetic HTTP test per host:

1. **pegma.dev Worker** — `GET https://<pegma-dev-api>.workers.dev/health`
   (or your custom route). Assert:
   - status code is `200`
   - JSONPath `$.ok` equals `true`
   - optional: JSONPath `$.service` equals `pegma-dev-api`
2. **retiregolden.org** — `GET https://retiregolden.org/api/health`  
   **Use the public Static Web Apps host.** Direct
   `*.azurewebsites.net/api/...` calls return **401** and will false-alarm.
   Assert the same `200` + `$.ok == true` (and optional
   `$.service == retiregolden-api`).

Suggested schedule: every 1–5 minutes. Alert on consecutive failures (e.g. 2).

`degraded` still returns HTTP 200 with `ok: true`. If you want to page on
degraded storage/logging, add a JSON assertion on `$.status` or a log monitor
instead of relying on status codes alone.

## Datadog log monitors

Hosts emit Spine events through their teed loggers:

| Event            | Level | When                          |
| ---------------- | ----- | ----------------------------- |
| `health.ok`      | info  | All checks ok                 |
| `health.degraded`| warn  | At least one degraded, none fail |
| `health.failed`  | error | At least one fail             |

Useful monitors:

- **Presence of failure:** query `service:<name> @message:health.failed` →
  alert when count > 0 in a window.
- **Absence of success (warmup / silent death):** query
  `service:<name> @message:health.ok` → alert when count is 0 for N minutes
  (only if something external is probing on a known cadence).

Filter on the JSON `service` field hosts put in the health body / log
attributes (`pegma-dev-api`, `retiregolden-api`).

## Local dashboard

A private Docker board that polls the same URLs lives at
`~/source/repos/site-health-monitor` (not a Pegma package). It is for local
visibility; Datadog remains the alerting system of record.

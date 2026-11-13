---
name: crusaders-mainframe-decisions-platform-ops
description: "Backend-platform pass 2026-11-13: /healthz liveness vs /readyz readiness with the build's revision, capped container logs, EF at Warning, redacted gateway log, durable webhook fan-out, biometric simulator gated."
type: decision
last_verified: 2026-11-13
---

# Live decisions — health, logs, webhooks, biometric (backend-platform pass)

Spec: `docs/specs/deployment.md` "Health, logs and knowing what runs", `webhooks.md`,
`biometric-abstraction.md`. Tests: `PlatformPassUnitTests`, `WebhookRetryTests`, `OutboundGuardTests`.

- **`/healthz` stays liveness, `/readyz` touches the database** (SELECT 1, 2 s). Why two: restarting a
  live API because Postgres blinked adds an outage; a single DB-touching probe would. Both compose
  files' backend healthcheck now use `/readyz` (truthful in Portainer; Docker does not restart on
  unhealthy). The external uptime monitor that would make the ≥99.5 % launch-bar number real is
  still an ops step — nothing in the repo can be it.
- **`revision` comes from `ARG BUILD_SHA` → `SourceRevisionId`**, CI passes `github.sha`. Immutable
  image tags and the rollback runbook (rest of IO-05) are the infra lane's.
- **Logs**: EF and request lines at Warning in the base file (Production ran on it at Information,
  ~50 MB/day idle); every compose service logs through `x-capped-log` (json-file 10m × 5). Why
  request lines too: their query strings carried stream tickets (BM-22).
- **Gateway access log is `crusaders_redacted`**: two nginx maps blank `?ticket=` and the token
  segment of the one-time-link and invite paths; no referrer. Verified against a local nginx 1.27.
  The document CSP gained `img-src 'self' data: blob:` (old rows with outside photo URLs stay dark).
- **Webhooks: rows before attempts.** Deliveries are saved `pending` with a 2-minute grace for the
  retry sweep, then attempted concurrently; four events in flight. Why not a full outbox at emit
  time: every `EmitAsync` caller would have to join its business transaction; the residual window
  (channel → first save) is milliseconds. Member-owned webhooks are removed (route and rows).
- **The courtside PIN/QR match routes stay** (correct identity, the desk's fallback); only the
  biometric simulator was dangerous. `Biometric:Driver=Null` is honoured in Development/Testing
  only; everything else is `NoBiometricDevice` (base appsettings says `None`; tests UseSetting Null).
- **Unique violations stay `503 conflict_retry`** generally (R18: a lost race, re-read sees the
  winner, a box keeps its event on 5xx). BP-16's real case — a duplicate passkey — is now refused by
  the ceremony's own check, so its retry cannot loop.
- **SSRF**: NAT64, 6to4 and IPv4-compatible IPv6 are judged as their embedded IPv4; Teredo and
  64:ff9b:1::/48 are refused outright.
- **Founder decisions of 2026-11-13 bind this lane too** (the last physical flash; nothing an operator
  does may force a reflash; the backend is the source of truth for hardware state — full text in
  `decisions-device-v3.md`). Here that means: no CLI command touches a device key, network or base
  URL — `tenant set-url` changes member-facing links only — and a suspended club's boxes are the
  device lane's to close, over the heartbeat, never by a reflash.

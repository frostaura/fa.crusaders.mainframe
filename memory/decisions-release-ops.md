---
name: crusaders-mainframe-decisions-release-ops
description: "Release and operations (2026-11-13, lane infra-ops): immutable sha tags with a forward-only :latest, daily in-stack backups with a drilled restore, a pre-deploy migration check, a non-root API, pinned images, a stack-size ratchet."
type: decision
last_verified: 2026-11-13
---

# Release and operations — what was decided, and why

**The frame.** Dean's go-ahead for the pre-go-live pass ("fix any and all, full e2e testing") came
with the founder decision that nothing an operator does may force a visit to the box (the flash
itself is now the last *planned* visit, not the last possible one — `decisions-device-v3.md`). Every item below either keeps the club recoverable without the
founder at the box, or makes the release knowable. Procedures: `docs/runbooks/`.

- **Images are released by commit, `:latest` only follows.** Builds push `sha-<commit>-<arch>`;
  one `publish-release` job joins all three `sha-<commit>` manifests after all six builds;
  `promote-latest` moves `:latest` for all three or none, forward only (it reads the revision label
  and requires a descendant), in one never-cancelled group. *Why:* per-image `:latest` writes let a
  failed build leave a mixed set and a late older run put old code back, and with no tag nobody
  could name what the club ran — so neither the owed migrations nor a rollback could be worked out.
  The stack pins `CRUSADERS_IMAGE_TAG`; unset falls back to `:latest` so an old Portainer file keeps
  working.
- **Backups live in the stack, write to the host, and are tested for real.** A `backup` service on
  the server's own `postgres:16-alpine` image (pg_dump must match the server major) dumps daily plus
  the photos, keeps 14 days but never fewer than 3 (a job failing for a month must not prune its
  last good copy), and goes unhealthy past 26 h. Scripts are inline because a Portainer stack has no
  files beside it. `PGPASSWORD` is a YAML anchor of `POSTGRES_PASSWORD` so it cannot drift. *Why:*
  money is ledger-only and the device key lives in the same database; there were no backups at all.
  **Offsite is a host cron, not the stack** — the stack must never hold that credential.
- **The restore refuses unless asked twice and nothing is connected**, and backs up what it
  replaces. Drilled 2026-11-13 by the runbook: 18 s from empty stack to a healthy restored backend,
  same tenant id, photos back. The drill with a real production dump is still owed.
- **A redeploy is preceded by `make migrations-pending`.** The tool classifies every string literal
  outside `Down()` with a small C# lexer, not only `Sql("…")` inside `Up()`: `MinutesReplaceCredits`
  raises from a helper's raw string and the first cut missed exactly the migration that crash-looped
  the 2026-10-06 redeploy. False alarms are accepted (a trigger body reads as `CAN REFUSE`).
- **The API runs as uid 1654, and the image hands itself its volumes**: `src/backend/docker-entrypoint.sh`
  chowns `/app/media` and `/app/biometric` as root, then drops to 1654 via `setpriv` (no caps).
  *Why:* a container escape should not land as root on the Pi, and a non-root image without the
  chown fails every upload on volumes a root backend created. It replaced a `volume-init` service
  (gone from every compose file, `1f5fa9ae`) because the founder required the deploy to stay as
  before: the club's existing Portainer stack file deploys unchanged.
- **Third-party images are pinned** (cloudflared 2026.10.7, nginx 1.31.8-alpine, MailHog v1.0.1,
  arduino-cli v1.5.1, actionlint 1.7.12), so a redeploy changes only what this repository changed.
- **Every service rotates its log and EF Core logs at Warning.** 35 KB/min idle was filling the SD.
- **The on-prem overlay no longer forces MailHog.** It set the flat `SMTP_HOST`, which the API reads
  before `Smtp__Host`, silently replacing a real relay.
- **Stack budgets are a ratchet, not a proof** (`src/iot/tools/stack_budget.json`): loop frame,
  largest frame of ours and, on the ESP8266 only, the deepest `.ci` path from loop(), at the
  2.3.0/1.1.2 values with the analysis' goals beside them. The v3 bridge and gate must not exceed
  them; lower them as the code shrinks. Indirect and precompiled callees are not counted.
- **Not done here, by rule:** GitHub settings (visibility — the repository is public; branch
  protection on `main`) are Dean's; the health endpoint's build SHA is the backend's.

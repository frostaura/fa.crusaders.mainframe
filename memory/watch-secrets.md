---
name: technologies-crusaders-squash-control-system-watch-secrets
description: "Where live secrets sit unencrypted on this Mac: two gitignored .env files (dev clone, iCloud clone), four firmware secrets.h, PayFast credentials in clear in tenant_settings. Read by key name only."
type: watch
last_verified: 2026-11-20
---

# Watch — secrets at rest

Item 1 of [`watch.md`](watch.md), split out by sub-subject. Re-checked 2026-11-20: each `.env` read as key name plus
set/empty, no value printed; `TenantSecretsAccessor.cs:13`; `docs/go-live-checklist.md:158`. **Never transcribe a value.**

- **Two gitignored `.env` files hold several classes of live secret.** The `~/src/technologies.crusaders.squash-control-system` clone's
  populates `JWT_SECRET`, `POSTGRES_PASSWORD`, `BOOTSTRAP_ADMIN_PASSWORD` and a real mailbox in both spellings (`SMTP_*`
  and `Smtp__*`; the flat names win), plus the retired `BOOTSTRAP_SLICE_PRICE_CREDITS` (read by nothing; Dean deletes
  it). The iCloud clone's populates its own `JWT_SECRET`, `POSTGRES_PASSWORD` and `SMTP_PASSWORD`, plus
  `MASTER_SECRETS_ENCRYPTION_KEY`, `LIGHTS_CONTROLLER_DEFAULT_SECRET`, `ConnectionStrings__DefaultConnection` (the
  database password again) and the dead `PEACH_PAYMENTS_BASE_URL`; its four `PORTAINER_*` keys are present but
  **empty** (*corrected 2026-11-20:* this said `PORTAINER_TOKEN` held a live stack-control credential) — delete the
  dead keys anyway.
- **A third copy is gone, not moved** (2026-11-20): the scratch clone under `~/src` that carried its own JWT, SMTP and
  bootstrap-admin values was deleted with every lane worktree, so nothing else on this disk holds a crusaders `.env`.
- **The iCloud clone keeps four ignored firmware `secrets.h`** (court-box and door-gate, `src/` and `arduino/` trees);
  the dev clone has none, only the tracked `secrets.h.example` files.
- **Untracked closes the commit risk and nothing else:** all of the above are unencrypted, the `~/src` copy lives on
  this disk alone, and the iCloud copy is only *synced* — a deletion is mirrored, so it is not a backup.
- **PayFast merchant credentials sit in clear** in `tenant_settings`; `Services/TenantSecretsAccessor.cs`'s comment
  defers a master KEK to unbuilt work.
- **Production's secrets are in the Portainer stack file only** — the password-manager list is the last item of
  `docs/go-live-checklist.md` §2b.

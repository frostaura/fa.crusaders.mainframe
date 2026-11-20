---
name: technologies-crusaders-squash-control-system-watch-rename
description: "The 2026-11-20 rename to Crusaders Squash Control System reached context files only. Members still see Crusaders Mainframe in the passkey prompt and the fallback sender; images, localStorage keys and backup path keep the old name."
type: watch
last_verified: 2026-11-20
---

# Watch — the rename still owed in product files

The founder renamed the repo, the directory and the product on 2026-11-20 ([`state.md`](state.md)). A
memory pass may not edit product files, so every string below still says `Mainframe`. Counted with `git grep -i
mainframe` at `origin/main` on 2026-11-20: about 7,400 hits outside the context files. Delete each line once
it ships. Late that night the `~/src` clone held uncommitted edits to 44 of these files, so a rename was
under way in another session. Re-run the grep against `origin/main` before you trust this list.

**What a person sees, so fix these first:**

- `WEBAUTHN_RP_NAME` defaults to `Crusaders Mainframe` in `.env.example` and `docker-compose.yml`. That is
  the name a member's passkey prompt shows.
- `SMTP_FROM_NAME` defaults to `Crusaders Mainframe` in the same two files, and so does the
  `SmtpEmailService.cs` fallback. A message with no tenant behind it still arrives from the old name
  ([`decisions-email.md`](decisions-email.md)).
- The wallet CSV export is named `crusaders-mainframe_wallet_…csv` (`ReportingEndpoints.cs`).
- `README.md`, `docs/charter.md`, the titles of the specs and the development plan, the review, and both
  founder-facing pages still carry the old name. The pages need a regenerate-and-republish as a pair.

**Renames that break something unless they are migrated:**

- **Docker Hub images** `frostaura/crusaders-mainframe-{backend,frontend,gateway}` are named in `ci.yml` and
  `docker-compose.prod.yml`. The Pi's Portainer stack pulls those names, so renaming them is a
  stack-file change made at a redeploy. It is not a CI-only edit.
- **The backup path** `/var/backups/crusaders-mainframe` in `docker-compose.prod.yml`. Moving it strands the
  existing dumps unless they are moved too.
- **`localStorage` keys** `crusaders.mainframe.*` in the frontend (`club`, `club-mode`, `last-admin`,
  `last-identity`, `mode-switched`). Renaming them makes every device silently forget its remembered club,
  identity and mode. Read the old key once and fall back to it.
- **The health payload** says `Service = "crusaders.mainframe"` (`HealthEndpoints.cs`). Any probe that
  matches on it has to change at the same time.

**Identifiers with no user surface:** the `Crusaders.Mainframe.*` C# namespaces, projects and `.sln`,
`MainframeDbContext`, the `crusaders-mainframe-frontend` package name and the `crusaders-mainframe-gateway:local`
dev tag. A rename here touches every EF migration designer file. It costs churn, not correctness, so it goes
last, if it happens at all.

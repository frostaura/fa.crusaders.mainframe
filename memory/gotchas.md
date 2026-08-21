---
name: crusaders-mainframe-gotchas
description: "MONEY BUG: credits rename half-done — the same column is labelled ZAR and credits; only one migration exists so a deployed DB is stuck; .env holds real SMTP creds"
type: gotcha
last_verified: 2026-07-24
---

# Gotchas

- **MONEY BUG — the 8.2 credits rename is half-done and currently dishonest.** Re-verified 2026-07-24. The column is still `AmountZar numeric(10,2)` (`Migrations/20260506000000_InitialCreate.cs` lines 119, 208), yet `AdminMemberEndpoints.cs` lines 143–148 sum that same field into `top_ups_credits`, `spent_credits`, `refunds_credits`, `penalties_credits` and `adjustments_credits`, while line 35 exposes it as `balance_zar`. **The same field is labelled ZAR in one endpoint and credits in another.** `SlicePriceCredits` does not exist anywhere — the migration still declares `SlicePriceZar`. Fix the unit, then write the migration.
- **Only one migration exists** — `20260506000000_InitialCreate`. No Phase-8 schema change (MemberClass, BookedByUserId/PaidByUserId, credits) has a migration. **Any deployed database is stuck** and cannot be migrated forward. `CLAUDE.md`'s "schema changes need an EF migration" invariant is currently violated by the repo itself.
- **`.env` holds real SMTP credentials.** It is now correctly gitignored (`.gitignore` lines 54–58) and is not tracked — verified. It is still unencrypted and unbacked-up.
- **This repo carries a vendored Gaia toolkit** — `.claude/skills/` (9 skills + `references/`), `.claude/agents/` (6), `.claude/gaia-instructions.md`, and a `.github/` mirror. The `.claude/skills/` tree is **byte-identical to `fa.lifeos`'s** and **differs from the current upstream plugin in all seven engineering skills** (upstream renamed `gaia-*` → `fa-*`). `gaia-default-tech-stack` and `gaia-ui-engineering` are both present and were both ignored — see the frontend deviation.
- **`docs/phases/` does not exist** despite the plan mandating a `phase-<n>.md` execution log per phase. There is no record of *why* any implementation choice was made — only what the specs said should happen.
- Docs use "Arduino" and "ESP32" interchangeably for the same lights controller.
- **Docker device passthrough is undocumented in `docker-compose.yml`**, pending the biometric SDK choice.
- iCloud has fabricated `* 2.dll` / `* 2.pdb` duplicates under `src/backend/.../bin` and `obj`. Build output only, gitignored, harmless — do not treat them as source.
- **Local `dotnet test` fails MSB3021 "Access denied" copying `appsettings*.json` into `bin/`** on this iCloud path (source files carry the protected `com.apple.provenance` xattr; MSBuild's copy is denied on *create* but succeeds on *overwrite*). Recovery: `cp` the two appsettings files into each project's `bin/Debug/net10.0/` by hand once, then rerun — verified 2026-08-21. Plain `cp` and CI (ubuntu) are unaffected.
- **vitest has no `localStorage` under Node ≥25 + jsdom 28** (jsdom 28 defers to Node's flag-gated built-in, which is undefined without `--localstorage-file`). Fixed 2026-08-21 with an in-memory Storage polyfill in `src/frontend/src/test/setup.ts` — keep it if that file is ever rewritten, or App.test.tsx fails on `localStorage.clear()`.
- **Frontend `node_modules` on this iCloud path loses rollup's native optional dep** (build fails with a missing `rollup/dist/native.js` require). Recovery: `rm -rf node_modules && npm ci`.

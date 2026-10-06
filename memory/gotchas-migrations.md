---
name: crusaders-mainframe-gotchas-migrations
description: "EF migration and schema-change traps: a stale Designer snapshot re-adds columns, --no-build scaffolds empty, a rename scaffolds as drop-and-add, int converts to decimal silently, culture-blind ToString."
type: gotcha
last_verified: 2026-10-01
---

# Gotchas — EF migrations and changing the schema

## Scaffolding

- **The newest migration's `.Designer.cs` is the baseline every future migration diffs against, and
  a merge can leave it stale.** `20260921190452_AddDeviceEventReceiptBootId.Designer.cs` was written
  on a branch without `20260921185533_AddDoorTruthColumns`, so it lacked five columns and EVERY
  migration scaffolded after it proposed to ADD them again — a duplicate-column failure mid-chain on
  a fresh database, which only `ApiBoundaryTests.Migrations_apply_cleanly_to_a_fresh_database`
  catches. **Read a newly scaffolded migration before committing it**; delete by hand any operation
  you did not cause. The drift ends at the first migration whose own snapshot is complete (2026-09-22).
- **`dotnet ef migrations add --no-build` scaffolds against the LAST BUILT assembly**, so it silently
  produces an empty migration when the model has changed since; `migrations remove` then rewrites the
  model snapshot from that same stale assembly. Never pass `--no-build` here.
- **A renamed + retyped column scaffolds as DropColumn + AddColumn** — data loss on a table with
  rows. Hand-write `RenameColumn` then `ALTER COLUMN … TYPE integer USING round("X")::integer` (see
  `MinutesReplaceCredits.Retype`). P13's scaffold was otherwise clean; the snapshot drift did not recur.
- **A refusal `DO $$ … $$` block runs inside the migration's transaction**, so a refused `Up` leaves
  the schema untouched (pinned). Its SQL names the columns as they stand at that moment — `Down`'s
  refusal checks `*Minutes`, `Up`'s checks `*Credits`.

## Changing the unit of account (P13 lane B0, 2026-10-01)

- **`int` converts to `decimal` implicitly, so retyping a property compiles far less than it
  should.** Making `AmountMinutes` an `int` left every `decimal x = entry.AmountMinutes`, every
  `Sum(...)` into a decimal local and every `decimal`-typed record member compiling — only
  assignments the OTHER way failed. Grep for `decimal\??\s+\w*Minutes` (and the money words:
  share, owed, paid, price, balance, held) after a retype; `MinutesUnitGuardTests` now fails on
  any `*Minutes` property typed decimal or `*Zar` typed int across the API assembly.
- **`ExecuteScalar()?.ToString()` on a `numeric` takes the process culture**: on this Mac it gave
  `2,8000`, which `decimal.Parse(…, Invariant)` read as 28000. Cast to `::text` in the SQL.
- **The rename script must not touch retired camelCase wire keys.** `slicePriceCredits` in a
  settings-PUT body is a key an old PWA sends and the server binds and ignores; renaming it to
  `slicePriceMinutes` in tests would test a key nobody sends. Skip `*PerZar*` and `SlicePrice*`
  case-insensitively.
- **A char literal `'}'` in a test body defeats naive brace matching** when rewriting methods by
  script; skip strings, verbatim strings, raw `"""` blocks and char literals first.

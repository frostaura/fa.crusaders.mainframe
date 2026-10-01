---
name: crusaders-mainframe-gotchas-unit-rename
description: "Traps met changing the ledger unit (P13 B0): int converts to decimal silently, EF scaffolds a column rename as drop-and-add, the migration's refusal must name columns as they stand, and a culture-blind ToString breaks a raw-SQL test."
type: gotcha
last_verified: 2026-10-01
---

# Gotchas — changing the unit of account (P13 lane B0, 2026-10-01)

- **`int` converts to `decimal` implicitly, so retyping a property compiles far less than it
  should.** Making `AmountMinutes` an `int` left every `decimal x = entry.AmountMinutes`, every
  `Sum(...)` into a decimal local and every `decimal`-typed record member compiling — only
  assignments the OTHER way failed. Grep for `decimal\??\s+\w*Minutes` (and the money words:
  share, owed, paid, price, balance, held) after a retype; `MinutesUnitGuardTests` now fails on
  any `*Minutes` property typed decimal or `*Zar` typed int across the API assembly.
- **`dotnet ef migrations add` scaffolds a renamed + retyped column as DropColumn + AddColumn.**
  On a table with rows that is data loss; hand-write `RenameColumn` then
  `ALTER COLUMN … TYPE integer USING round("X")::integer` (see `MinutesReplaceCredits.Retype`).
  The scaffold was otherwise clean: the designer-snapshot drift in `gotchas-build.md` did not recur.
- **A refusal `DO $$ … $$` block runs inside the migration's transaction**, so a refused `Up`
  leaves the schema untouched (pinned). Its SQL must name the columns as they stand at that
  moment — `Down`'s refusal checks `*Minutes`, `Up`'s checks `*Credits`.
- **`ExecuteScalar()?.ToString()` on a `numeric` takes the process culture**: on this Mac it gave
  `2,8000`, which `decimal.Parse(…, Invariant)` read as 28000. Cast to `::text` in the SQL.
- **The rename script must not touch retired camelCase wire keys.** `slicePriceCredits` in a
  settings-PUT body is a key an old PWA sends and the server binds and ignores; renaming it to
  `slicePriceMinutes` in tests would test a key nobody sends. Skip `*PerZar*` and `SlicePrice*`
  case-insensitively.
- **A char literal `'}'` in a test body defeats naive brace matching** when rewriting methods by
  script; skip strings, verbatim strings, raw `"""` blocks and char literals first.

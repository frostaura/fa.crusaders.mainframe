---
name: crusaders-mainframe-decisions-backend-hygiene
description: "P10 backend hygiene rules: a retired settings key stays bound and ignored, the dev seeder skips any held slot, per-booking codes stay until no rollout phase reaches them, PayFast source check is spec'd but unbuilt."
type: decision
last_verified: 2026-09-29
---

# Live decisions — backend hygiene (P10)

- **A retired settings key is no longer served but stays BOUND on the settings PUT and is
  ignored, whatever it holds** (first case: `action_glyphs`, retired end to end in P10). *Why:*
  the PWA sends the whole settings page back; an older cached PWA that still carries the key would
  be refused 400 on every save for a setting that no longer exists. A value already stored in a
  club's document is left alone and never read. Delete the binding only once no supported PWA
  build can send it.
- **The Development seeder skips any planned demo booking that overlaps a live
  (non-cancelled) booking on its court; it never moves one.** *Why:* it runs on every dev boot
  against a database that has lived — `NoShowWorker` has swept earlier seeded rows to `NoShow`
  and truncated them, developers book over them — and its exact-start check planted a second
  row, `ck_bookings_no_overlapping_slot` refused it, and the one save seeded nothing. Demo data
  has no claim on a held slot; a cancelled one is planted again. `SeederIdempotenceTests`.
- **Per-booking access codes are NOT dead code.** Minting, the legacy roster and resolution are
  gated on the member-code rollout phase and reachable in `legacy` and `v1`, and a rollback out of
  `v1_only` restores them ([`decisions-member-code-backend.md`](decisions-member-code-backend.md)).
  Remove them only once no club can be in, or roll back to, a phase that mints or honours them.
- **Dead code is found by counting, then confirmed by hand.** An identifier declared once and
  referenced nowhere in the API or the tests (comments stripped) is a candidate; extension-method
  classes and endpoint-registration classes are false positives. Test-only wrappers
  (`ChangePasswordAsync`, `IsCaughtUp`, `PendingCount`) are seams, kept.
- **`PayFastProvider.KnownSourceHosts` is referenced by nothing**, yet
  `docs/specs/payments-payfast.md` step 2 names it as the ITN source-address check. The check is
  unbuilt, not dead; left in place for whoever builds it (advisory and configurable per the spec).

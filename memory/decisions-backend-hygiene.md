---
name: crusaders-mainframe-decisions-backend-hygiene
description: "P10 backend hygiene rules: a retired settings key stays bound and ignored, the dev seeder skips any held slot, per-booking codes stay until no rollout phase reaches them, PayFast source check now built (advisory)."
type: decision
last_verified: 2026-10-01
---

# Live decisions — backend hygiene (P10)

- **A retired settings key is no longer served but stays BOUND on the settings PUT and is
  ignored, whatever it holds** (first case: `action_glyphs`, retired end to end in P10). *Why:*
  the PWA sends the whole settings page back; an older cached PWA that still carries the key would
  be refused 400 on every save for a setting that no longer exists. A value already stored in a
  club's document is left alone and never read. Delete the binding only once no supported PWA
  build can send it. P13 retired five money keys the same way (`slicePriceCredits`,
  `creditsPerZarRegular`, `creditsPerZarLeague` — no longer refused — `topupBlockZar`,
  `topupMaxZarPerMember`; `AdminSettingsHttpTests+Economics`).
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
- **The PayFast source check is built** (2026-11-13, money lane): `PayFastSourceCheck` reads
  `PayFastProvider.KnownSourceHosts` and the published ranges, advisory by default and enforceable
  by configuration — see [`decisions-money-golive.md`](decisions-money-golive.md).

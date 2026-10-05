---
name: crusaders-mainframe-decisions-frontend-member-r14
description: "Member money words and interaction, review round 14 (lane FE14m): a share said as the act that moved it, paging focus guarded by a scan, offline said as offline, prefetched tabs never suspend."
type: decision
last_verified: 2026-10-05
---

# Live decisions — member money words and interaction, review round 14 (lane FE14m)

Earlier: `decisions-frontend-member-r13.md`. Contract: BE14b's R14 (`share_cause` narrowed, `actor_name`).
Tests: `walletMovementR14.test.tsx`, `paged-focus-scan.test.ts`, `routeLazy.test.tsx`, `e2e/member-r14-fe14m.spec.ts`.

- **A share moved by an act is said as the act** (X14-2/E14-1): `actedShareSentence` — partner
  "Omar took you off Court 3 · Mon 5 Oct — 7 minutes came back", "Otto changed the split on …",
  "You withdrew from …", "The club took you off …", member cancel "Omar cancelled … — 7 minutes of
  your share came back"; organiser "Sam withdrew from … — went back to them", "You took Sam off …",
  "You changed the split on … — went back to Sam". *Why:* `share_returned` once covered removal and
  split change, and "you withdrew" was false for both. Names: `actor_name`, else the share row's
  `counterparty_name`. The named path (ledger words) carries no full stop — pre-existing, kept.
- **A cancel the frame places names it** (E14-7): "The club cancelled your booking on Court 3 · Mon
  5 Oct: …"; a displacement names court AND time. A late split cancel arrives as `mixed`; with a
  refund and share rows it goes through the cancel sentence (J14-4) — shares are never the penalty.
- **`cancelled_no_refund` is the one zero movement the chip announces** (BE14b §5, E14-5).
- **A free cancel of a split booking names the partners** (J14-6/J14-7): `CANCEL_SHEET.free(whose,
  partners)`, `SPLIT_CANCEL.note(whose, partners)`; one partner is singular.
- **Every paging button is on `usePagedFocus`, by source scan** (X14-1): a `<Button>` whose label is
  a paging label (literal, or a copy key whose value is one) needs a bare handler in a file that calls
  the hook, or an allow-list entry with its reason (AdminLedger/AdminDoorsLog follow a sort; AdminMembers
  reveals client-side; Recent/Upcoming games are disclosures that never unmount).
- **Offline is said as offline** (X14-3): `ConnectionLost` reads `navigator.onLine` — only `false`
  switches it (Wi-Fi without internet leaves it true). `/profile/results` was NOT made
  offline-capable: nothing of it is kept, so it could only fail its read.
- **Prefetched member pages mount in the tap's commit** (PERF): `routeChunks.noteChunk` keeps the
  arrived module, `routeLazy` answers React.lazy synchronously. *Why:* a plain lazy re-imported the
  prefetched module, suspended once, and React holds a shown fallback ≥ 300 ms. Measured (preview →
  :8088, fresh context, tap after 4.5 s idle): Wallet 309–313 → 7–16 ms, Bookings 314–319 → 6–30 ms.
  Bookings did not really "escape" — only after an earlier open had initialised its lazy.
- **The reviewer's 15.1 s / 6.4 s `/my-code` opens**: not reproduced; most likely `POST
  /me/code/enrol`'s `auth` limiter (10/min) — the harness opened /my-code ~50 times per viewport.
- **Owed by backend**: a removed member's wallet group has no court/day — `share_bookings[id]` is
  null by design; asked for an additive `share_places` (scratchpad ask, R14).

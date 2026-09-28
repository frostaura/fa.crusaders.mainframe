---
name: crusaders-mainframe-decisions-member-code-backend
description: "D1/D10 server side: S never stored, one use per code per class claimed before acting, cut-over automatic and forward-only, pay-for through the payer-override path, players behind one seam P11 replaces."
type: decision
last_verified: 2026-09-28
---

# Live decisions — the member code on the server (P7 backend)

Oracle `docs/specs/member-code.md` (its §13 lists where the server differs); built on branch
`be/p7-code`. Firmware and contract decisions are `decisions-member-code.md`.

- **S is derived, never stored**: `member_codes` holds only REF + generation; S = HKDF of
  `MemberCodes:MasterKey`. *Why:* a copy of the table forges nothing. Production refuses to start
  without a real key (`MemberCodeKeyPolicy`, JwtSecretPolicy's rule); Development/Testing use a
  published dev key. **The prod compose carries a CHANGE-ME placeholder — a redeploy without setting
  `MemberCodes__MasterKey` will not start.**
- **A use is CLAIMED before the action and released if the server does not act** (INSERT … ON
  CONFLICT DO NOTHING on `(tenant, ref, step, class)`). *Why:* two concurrent requests with one
  code must not both act, and "a row only when the server acted" must still hold for refusals.
- **Replays are checked before the use table** (walk-up reference, pay-for nonce). *Why:* a box
  retrying its own purchase must get the first answer, never `code_used`.
- **Phase moves forward on its own, via a conditional jsonb merge**; only an admin moves it back.
  *Why:* a heartbeat and an admin saving settings in one second must not erase each other.
- **From `v1` nothing mints per-booking codes** (booking commit, rosters, QR screen); `v1_only`
  refuses legacy everywhere and legacy boards get an empty roster. *Why:* a code nobody will show
  is a live credential with no purpose.
- **Pay-for reuses `ChargeOnActivationAsync`'s payer override** (or `ActivateAsync` when the
  booking is unstarted and its cue window open, which also lights it). *Why:* one reassignment
  path, one payer lock, one concurrency token — no second money path to drift.
- **Evidence re-check accepts the previous generation too.** *Why:* a board offline across a
  rotation verified old codes honestly; flagging them pages every admin for nothing.
- **Players come from `IBookingPlayers`** — organiser-only, never split — the one seam P11 extends
  for partners in rosters, evidence and `split_booking`. *Why:* nothing else has to change.
- **Owed:** a door-corpus vector for `/gate` `code_used` (contract lane); sign-out-everywhere does
  not exist yet and must rotate when it lands; the courtside `/court/{n}/qr/match` kiosk still
  takes legacy codes only.

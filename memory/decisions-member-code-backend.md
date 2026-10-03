---
name: crusaders-mainframe-decisions-member-code-backend
description: "D1/D10 server side: S never stored, one use per code per class claimed before acting, same-board reuse is a receipt, pay-for pinned to its quote and paid in one commit, players behind one seam wired to P11's accepted seats."
type: decision
last_verified: 2026-10-03
---

# Live decisions — the member code on the server (P7 backend)

Oracle `docs/specs/member-code.md` (§13 lists where the server differs); built on branch
`be/p7-code`. Firmware/contract: `decisions-member-code.md`. Rotation, sessions and the rollout
hold: `decisions-member-code-rotation.md`.

- **S is derived, never stored**: `member_codes` holds only REF + generation. *Why:* a copy of the
  table forges nothing. **The prod compose carries a CHANGE-ME placeholder — a redeploy without
  `MemberCodes__MasterKey` will not start.**
- **A use is CLAIMED before the action and released if the server does not act — or throws before
  money commits (a walk-up voided after its purchase keeps its use).**
  *Why:* two concurrent requests with one code must not both act; a claim a 500 stranded read
  `code_used` to the member's own retry. Claims keyed by the box's nonce (`ClaimKey`) re-enter for
  the same device's identical retry — twin walk-up retries in flight were answered `code_used`.
- **Replays are checked before the use table** (walk-up reference, pay-for nonce): a box's retry gets the first answer.
- **Evidence: the same board holding the use is the same act** (its fallback of an online grant,
  or its own re-upload after a failure) → a receipt; only another board is `reused`. *Why:* the
  first shape paged every admin about a member's single scan. Narrowed (refute round 2): an evidence
  claim is keyed by its own event; the board's ONLINE claim counts only if the event is at or after
  it less 5 s. *Why:* an offline open, link back, photo scanned online, then the queued event
  uploaded looked like the same act. The firmware now refuses such a scan locally too.
- **The previous generation counts as evidence for 6 h after a rotation, only for a member active
  at the scan.** *Why:* honest offline verification across a rotation, without a lost phone's codes for ever.
- **A clamped event time is never attendance; what needs the step is `unverifiable`, but a reuse
  by another board or a failed ON still alarms.** *Why:* an alarm on a guess is noise, yet
  suppressing step-free proof let a copied key through on a broken counter (refute round 1).
- **Evidence finds the booking whose SOLD window holds the scan** before any grace tail. *Why:*
  back-to-back 17:00/18:00 slots stamped the 17:00 one and swept the 18:00 player a no-show.
- **Pay-for pays for the booking its quote named** (`device_pay_for_quotes`; else, or unquoted,
  `price_changed` — the reason the box already re-quotes on). *Why:* a label alone let a quote for
  17:00 pay the 18:00 member's court at the same price. No new wire reason, no firmware change.
- **Pay-for's paid state commits WITH the money**; a lost race is `already_paid`, and an unpaid
  nonce row older than 60 s is a crash's leftover the retry clears. *Why:* a second save after the
  money stranded crashed nonces at 503 for ever, and the unclaim's save re-threw the lost race as
  a 500 through a dirty change tracker (now cleared first).
- **An uncharged booking is `not_chargeable` at the box.** *Why:* the PAID glass says "Booker
  refunded" and it is firmware; with nobody refunded every word would be false.
- **Pay-for reuses `ChargeOnActivationAsync`'s payer override** (or `ActivateAsync` when unstarted
  and the CLAMPED cue window is open). *Why:* one reassignment path, one lock, one token.
- **The quote asks SPENDABLE, as the confirm does** (R6 E6-5: held minutes were quoted, then refused).
  The takeover emits `booking.payer_changed`, subject the NEW payer (E6-4 — the payer's side reached
  no webhook); the booker's detail names `money.paid_by` and costs them 0 (E6-2).
- **From `v1` nothing mints per-booking codes; `v1_only` refuses legacy everywhere** — kiosk QR
  match, biometric payer override and legacy evidence (judged at the scan) included — and the
  cut-off expires every access code. *Why:* a code nobody will show is a live credential.
- **`IBookingPlayers` is wired to P11** (2026-09-29): organiser then ACCEPTED active partners by
  seat; split = P11's `IsSplitAsync`, the predicate the payer override reads, so the two cannot
  disagree. Wire code stays `split_booking` (firmware pins it). A v1 roster admits a barred
  organiser's game for its partner; legacy does not — its entry is the organiser's own code.
- **P7 rewrote its migration** (`AddSessionEpochClaimKeysPayForQuotesAndCutoffMarks`): a dev DB migrated at `0bd49d2` needs `make down-reset`.
- **Left by decision:** a pay-for replay re-grants the remainder (review L5; bounded by the sold
  end and the relay cap). **Owed:** a door vector for `/gate` `code_used` and a pay-for vector for
  the wrong-booking `price_changed` (contract lane); the kiosk still takes legacy codes only.

---
name: crusaders-mainframe-decisions-member-code-backend
description: "D1/D10 server side: S never stored, one use per code per class claimed before acting, same-board reuse is a receipt, pay-for pinned to its quote and paid in one commit, players behind one seam wired to P11's accepted seats."
type: decision
last_verified: 2026-11-20
---

# Live decisions — the member code on the server (P7 backend)

Oracle `docs/specs/member-code.md` (§13 lists where the server differs). Firmware/contract:
`decisions-member-code.md`; rotation and sessions: `decisions-member-code-rotation.md`; phases, the cut-over and the
master key: `decisions-member-code-rollout.md`.

- **S is derived, never stored**: `member_codes` holds only REF + generation. *Why:* a copy of the table forges
  nothing. (The master-key rules, and the prod compose's CHANGE-ME placeholder: the rollout topic.)
- **A use is CLAIMED before the action and released if the server does not act — or throws before money commits (a
  walk-up voided after its purchase keeps its use).** *Why:* two concurrent requests with one code must not both act;
  a claim a 500 stranded read `code_used` to the member's own retry. Claims keyed by the box's nonce (`ClaimKey`)
  re-enter for the same device's identical retry — twin walk-up retries in flight were answered `code_used`.
- **A claim that vanished is claimed again; a re-entered claim is held after the purchase** (R19 BE19L, `c1d12904`,
  `R19BusyWalkUpHttpTests`). *Why:* under a refused connection the maker gave its use back while a twin's `ON CONFLICT
  DO NOTHING` had met the row, read it gone and said a false `409 code_used`; `TryClaimAsync` now retries (3) for
  every claimant. A twin that re-entered and bought after the give-back left a purchase with no use, so the code could
  buy again — `HoldAgainAsync` re-claims it once the walk-up commits. Pay-for needs neither (nonce row first).
- **Replays are checked before the use table** (walk-up reference, pay-for nonce): a box's retry gets the first
  answer.
- **Evidence: the same board holding the use is the same act** (its fallback of an online grant, or its own re-upload
  after a failure) → a receipt; only another board is `reused`. *Why:* the first shape paged every admin about a
  member's single scan. Narrowed (refute round 2): an evidence claim is keyed by its own event; the board's ONLINE
  claim counts only if the event is at or after it less 5 s. *Why:* an offline open, link back, photo scanned online,
  then the queued event uploaded looked like the same act. The firmware now refuses such a scan locally too.
- **The previous generation counts as evidence for 6 h after a rotation, only for a member active at the scan.**
  *Why:* honest offline verification across a rotation, without a lost phone's codes for ever.
- **A clamped event time is never attendance; what needs the step is `unverifiable`, but a reuse by another board or a
  failed ON still alarms.** *Why:* an alarm on a guess is noise, yet suppressing step-free proof let a copied key
  through on a broken counter (refute round 1).
- **Evidence finds the booking whose SOLD window holds the scan** before any grace tail. *Why:* back-to-back
  17:00/18:00 slots stamped the 17:00 one and swept the 18:00 player a no-show.
- **Pay-for targets the booking about to start** (R14 E14-6, spec §9.2 delta): of the two earliest live member
  bookings that have started or whose cue window is open, if the earliest is running, ends inside the cue window and a
  later one has not started, the LATER one is the target (quote, confirm, activation); the two writes stay separate
  saves because of the overlap constraint.
- **Pay-for pays for the booking its quote named** (`device_pay_for_quotes`; else, or unquoted, `price_changed` — the
  reason the box already re-quotes on). *Why:* a label alone let a quote for 17:00 pay the 18:00 member's court at the
  same price. No new wire reason, no firmware change.
- **Pay-for's paid state commits WITH the money**; a lost race is `already_paid`, and an unpaid nonce row older than
  60 s is a crash's leftover the retry clears. *Why:* a second save after the money stranded crashed nonces at 503 for
  ever, and the unclaim's save re-threw the lost race as a 500 through a dirty change tracker (now cleared first).
- **An uncharged booking is `not_chargeable` at the box.** *Why:* the PAID glass says "Booker refunded" and it is
  firmware; with nobody refunded every word would be false.
- **Pay-for reuses `ChargeOnActivationAsync`'s payer override** (or `ActivateAsync` when unstarted and the CLAMPED cue
  window is open). *Why:* one reassignment path, one lock, one token.
- **A repeat `/activate` of the session already lit on that device and court claims no court use** (MCV1-02; "lit
  here" = the light state is On for that booking with no device or this device, since the online grant records its
  light with `DeviceId` null). *Why:* the re-grant spent the court use and `/extend` then answered `409 code_used`, so
  extending your own lit court with a v1 code was impossible. Safe: at the victim's own lit court an unused step can
  already buy an extension. (The spec's bridge-side "skip `/activate` for a proved REF" is not built; the bridge
  relies on this rule — [`decisions-bridge-scan-flows.md`](decisions-bridge-scan-flows.md).)
- **`IBookingPlayers` is wired to P11** (2026-09-29): organiser then ACCEPTED active partners by seat; split = P11's
  `IsSplitAsync`, the predicate the payer override reads, so the two cannot disagree. Wire code stays `split_booking`
  (firmware pins it). A v1 roster admits a barred organiser's game for its partner; legacy does not — its entry is the
  organiser's own code.
- **Left by decision:** a pay-for replay re-grants the remainder (review L5; bounded by the sold end and the relay
  cap). **Owed:** a door vector for `/gate` `code_used` and a pay-for vector for the wrong-booking `price_changed`
  (contract lane) — neither is in `membercode/gate.json` / `payfor.json` at `7893321d`.

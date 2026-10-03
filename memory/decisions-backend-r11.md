---
name: crusaders-mainframe-decisions-backend-r11
description: "Backend, review round 11 (lane BE11): box names in ASCII, a desk key is one member's, shares say why, offline refusals and late check-ins name the member."
type: decision
last_verified: 2026-10-03
---

# Live decisions — backend, review round 11 (lane BE11)

- **Every name a box prints is printable ASCII** (D11-1, `MemberDisplay.Shorten`): NFD, combining
  marks dropped, a few undecomposable letters spelled (ß→SS, Æ→AE, Ø→O, Ł→L), anything else
  (emoji, CJK) removed, spaces collapsed; nothing printable left → `MEMBER`. Folded BEFORE the
  16-character cut. *Why:* the HD44780 prints ROM glyphs for UTF-8 bytes and the bridge counted
  "Ë" as two columns. Activate, walk-up and its replay all go through `MemberDisplay.ForAsync`;
  pay-for answers carry no name.
- **A desk idempotency key is one member's movement** (J11-1): `WalletEndpoints.Replay` (adjust and
  the sale replay) compares `stored.UserId` too → 409 `idempotency_key_reused`. *Why:* key K on
  another member's URL answered 200 with the first member's entry and invented balances.
  Red before the fix (the mutation check).
- **The live wallet frame says why a share moved** (E11-1): `share_cause` (`WalletShareCauses`:
  share_paid, club_collected, attended, share_returned, booking_cancelled, club_removed,
  outage_refund, no_show, displaced) and `share_kept_minutes`, carried on the UNSTORED
  `LedgerPosting.Share` and decided by `ShareLedger.CauseOf` from the receipts' own facts. Not on
  `GET /wallet` rows — the cause is not stored, and storing it is a schema change nobody asked for.
- **A no-show share return names the penalty part** (E11-2): headline, mail and payload
  `kept_minutes` = paid before the return − returned ("11 minutes … came back — nobody checked in,
  and 4 minutes are your part of the no-show penalty"). A zero penalty keeps the club-refund words.
- **A late check-in names its scanner everywhere** (E11-3): the receipt row on the Night borrows
  `code_holder` from its server lights-on twin (the receipt stays the measurement; the twin still
  drops); `booking.no_show_reversed` carries actor + `identified_user_id`; and the reversal now
  EMITS `booking.lights_on` (`CourtActivationService.EmitReversedLightsOnAsync`) — decided by the
  webhooks contract, which already listed "roster fallback uploaded later" as a lights-on source.
- **A used-code refusal says the court and the attempt** (E11-4): activate with no booking records
  the court the box reported; trace `detail.attempt` (activate/walkup/pay_for) and the headline is
  worded by it, so distinct attempts never read as one row.
- **An offline refusal of a GENUINE v1 code names its member** (D11-2): `unknown_scan` (door) and
  `court_unknown_scan` (box) are re-checked with `CheckEvidenceAsync` at the scan's instant — no use
  claimed, no forgery, code never stored, clamped clock → unnamed. Outcome `refused_offline`
  (`DoorTrail.Reasons`, CSV "Refused offline", Night "… — refused offline"; the box row gets
  `court_number`); `?reason=not_recognised` excludes it; no second verdict row, no fault filed.
- **`given_minutes` on the member reports** (J11-4, FC11's ask): AdminTopUp with ZarPaid 0, a
  subset of `top_ups_minutes`.
- **The LCD comments match the build** (D10-2): 20×4 driven, rows 0–1 the 16-column safe subset;
  door-gate history has 1.1.0 (D11-3). Header edits change the generated Arduino sketches' comment
  lines — re-export and commit them, or `arduino-check` fails; `build_config.h` does not move.
- Contracts handed over: scratchpad asks BE11→FC11 (frame), →FD11 (attempt, code_holder, door
  reason), →integrator (types, webhooks/door-gate/reporting docs).

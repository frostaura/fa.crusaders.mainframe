---
name: crusaders-mainframe-decisions-frontend-member-r13
description: "Member money words, review round 13 (lane FC13): partners named and counted right, the club's cancel said, settlements with shares as one sentence, gone games lose their link."
type: decision
last_verified: 2026-10-05
---

# Live decisions — member money words, review round 13 (lane FC13)

Earlier: `decisions-frontend-member-r12.md`. Contract: BE13b's C13-1..C13-6.
Specs: `e2e/money-r13-fc13.spec.ts`; tests `*R13*` / `*-r13.test.tsx`.

- **One partner is one share** (X13-2): `cancelSentence` names each partner from the share part's
  `counterparty_name` ("7 minutes went back to Sam for their share"; two: "… to Sam and 7 minutes
  to Nomsa for their shares"), else "your partner" / "your N partners". Never "your partners …
  their shares" for one. *Why:* the organiser's own cancel sheet names each ("Back to Sam").
- **The partner hears who cancelled** (X13-3): `share_cause: booking_cancelled` + `cancelled_by:
  club` → "— the club cancelled the booking" (named and plain toasts).
- **A returned share is "your share"** (J13-4): a known return cause, minutes in, on the plain path
  (the booking 404s for a member taken off it) says "10 minutes of your share of a split booking
  came back — the club took you off the game"; never "A share … moved". `shareMovementPlain`'s 5th
  arg carries `cancelledBy` and an optional `place` (court from the frame, if a server sends one).
- **A settlement with shares is one sentence** (E13-5, C13-2): `settledWithShares` words the
  settlement from its OWN rows, then the partners' share rows, then the net — the sweep had counted
  the share as penalty ("10 minutes charged" for a 4-minute penalty + 6-minute share).
- **Below zero is 0 plus how far under** (J13-1): `DaySummary` (own and member rail) shows 0 and
  "12 minutes below zero", the Booking-for bar's words. The rail exists only from a 72rem page,
  so it never shows at 200 % text on a laptop — the e2e checks it at 100 % only.
- **The desk's split-cancel note is third person** (J13-5): `SPLIT_CANCEL.note(subject)`.
- **A cancelled game says who and why** (J13-6, C13-1): `cancellationWords` → "The club cancelled
  this game." + "Reason: …" on its own line / displacement sentence / "You cancelled" / "Sam
  cancelled"; no fields (older server) → "This game was cancelled." Read through the local
  `CancellationWire` type until `BookingDetail` carries the fields.
- **A gone game has no "View booking"** (J13-3): `share_bookings[id] === null` (key PRESENT) means
  the club says this member can no longer read it; absent means not summarised and keeps the link.
  Mails/inbox carry `?seat=` instead (BE13b C13-6), which `NotOnGame` already answers.
- **E13-3 needed no FE change**: the stored reversal names a different scanner; `MEMBER_VOICE`
  maps only the club's "the member was checked in" (the payer's own scan). Pinned by a test.

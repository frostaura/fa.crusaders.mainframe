---
name: crusaders-mainframe-decisions-frontend-wallet-words
description: "How a money toast is worded: by the frame's cause and sign, one sentence per action naming each partner, a share said as the act that moved it, who acted named and never guessed, the booking placed, the club's voice mapped to you."
type: decision
last_verified: 2026-11-20
---

# Live decisions — the words of a money movement on the phone

Mechanics: [`decisions-frontend-wallet-live.md`](decisions-frontend-wallet-live.md); server causes:
[`decisions-share-causes.md`](decisions-share-causes.md). Copy: `lib/movementCopy.ts` (`movementSentence(…, MovementWho)`),
`lib/shareMovementCopy.ts` (`shareRowSentence`, `shareMovementPlain`, `actedShareSentence`), `lib/walletCopy.ts`.

- **Worded by cause AND sign** (R10 E10-1): outage refund, its reversal (a minus) and a pay-for refund each have their
  own sentence; a no-show's refund-and-penalty is not "The club added 11 minutes". Unknown reasons are neutral.
- **One toast per cancellation** (R12 X12-1): a frame with `parts` + `cancelled_by` is one sentence — "The club
  cancelled your booking: 30 minutes came back, 15 minutes went back to your partners for their shares, so 15 minutes
  came back to your wallet." **One partner is one share** (R13 X13-2): each partner is named from the share part's
  `counterparty_name` ("7 minutes went back to Sam for their share"; two: "… to Sam and 7 minutes to Nomsa for their
  shares"), else "your partner" / "your N partners" — never "your partners … their shares" for one. A late split cancel
  arriving as `mixed` with a refund and share rows goes through the cancel sentence (J14-4) — shares are never the
  penalty. **A settlement with shares is one sentence** (R13 E13-5, `settledWithShares`): its OWN rows, then the
  partners' share rows, then the net (the sweep had counted the share as penalty).
- **A share moved by an act is said as the act** (R14 X14-2, `actedShareSentence`): partner "Omar took you off Court 3 ·
  Mon 5 Oct — 7 minutes came back", "Otto changed the split on …", "You withdrew from …", "The club took you off …";
  organiser "Sam withdrew from … — went back to them", "You took Sam off …". *Why:* `share_returned` once covered removal
  and split change, and "you withdrew" was false for both. `club_settled` reads "… came back — the club recorded that
  you paid {other} by hand" / "… paid you by hand for …" (`shareMovementCopy.ts:105,124`); `share_back` names nobody as
  acting. The partner hears who cancelled (`booking_cancelled` + `cancelled_by: club` → "— the club cancelled the
  booking"); a withdrawal is said ("15 minutes went back to a partner who withdrew from the game", falling back to the
  ledger row's counterparty because a withdrawn partner is no longer on the detail).
- **Who acted is named, never guessed** (R16–R17): `actor_name`, else the share row's `counterparty_name`;
  `personName()` treats blank/"null" as nobody and keeps "The club" whole; the club only when the club did
  (`share_changed_by`); `player_added` names the organiser; settle-outside is "<partner> paid <organiser> by hand", never
  "settled with the club"; the desk-made booking "The club booked you Court 2 · … — 30 minutes went on it."; the scanner
  by first name in every movement toast, and the scanner's own attended share says "you checked in" only with
  `checked_in_by_you` (an older frame claims nobody). A reversal names the scanner — "Dan Splitter checked in, so the
  no-show was reversed: …"; "you were checked in after all" only when `checked_in_by_name` is null.
- **A toast stands alone, so it says which booking** (R14–R16): a placed frame (`court_name` + `booking_starts_at` →
  `BalanceDelta.place`) reads "10 minutes of your share of Court 1 · Tue 8 Oct came back — the club took you off the
  game", "Your missed booking on Court 2 · Mon 5 Oct, 18:30 …", "The club cancelled your booking on Court 3 · Mon 5 Oct:
  …"; `shareRowSentence({ dated: true })` from the chip, while ledger lines under a group heading keep the court alone
  (group headings carry the start time). A returned share is "your share", never "A share … moved". Unplaced frames keep
  the old sentences. Share toasts end with a full stop; the ledger's row lines do not.
- **Pay-for toasts** read the rows' `counterparty_name` with court + day + time; "Another member" is only the null
  fallback now that the server sets the counterparty on both legs (`BookingService.cs` ~3000).
- **A started session the club cancels** names `checked_in_by_name` and tells partners "your share stands" (a second
  balance-neutral frame the chip announces).
- **A stored ledger reason is the club's voice; the member's wallet maps it to "you"** (R10 E10-6, `memberLedgerRows`,
  a regex table; `MEMBER_VOICE` maps only the club's "the member was checked in" — a different scanner's name stays).
  Admin ledgers show the stored text as is. A row's Category says what it was
  ([`decisions-ledger-layout.md`](decisions-ledger-layout.md)).
- **Money figures**: minutes in words inside sentences ([`decisions-minutes-words.md`](decisions-minutes-words.md));
  below zero is 0 plus how far under ("can spend 0 minutes — 12 minutes below zero", never "minus 12"); words agree with
  their figures (`agrees()`: "20 minutes go", "1 minute goes"); a R0.00 desk give names no payment method; "Given by
  the club" is never "Bought" (activity tiles and the daily chart add a Given series only in a period with a gift; the
  Bought bar is `top_ups − given`, `walletBuckets.givenMinutes`).

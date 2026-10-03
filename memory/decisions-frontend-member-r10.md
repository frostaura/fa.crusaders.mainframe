---
name: crusaders-mainframe-decisions-frontend-member-r10
description: "Member screens, review round 10 (lane FC10): the money toast says cause and sign, the Wallet card reads spendable against the shortest slot, Still trying everywhere, short-window sheets."
type: decision
last_verified: 2026-10-03
---

# Live decisions — member screens, review round 10 (lane FC10)

Earlier: `decisions-frontend-member-r9.md`, `decisions-minutes-words.md`.
Specs: `e2e/member-r10-fc10.spec.ts`; tests named `*R10*` / `Wallet.r10`, `stillTryingR10`.

- **The chip's money toast is worded by cause AND sign** (E10-1, `walletCopy.movementSentence`).
  *Why:* an outage refund, its reversal (a minus) and a pay-for refund all arrived as
  `cancellation_refund` and read "A cancelled booking put … back"; a no-show's refund-and-penalty
  (`mixed`, +11) read a green "The club added 11 minutes". The server's stream frame now carries a
  precise `reason` (outage_refund, outage_refund_reversed, no_show_settled, no_show_reversed,
  pay_for_refund, pay_for_charge, displaced_refund, displaced_reinstated) and `parts` (each row's
  type reason + signed minutes; `lib/liveBalance` keeps them only when well-shaped). Rule: a reason
  this build does not know, or `mixed` without rows, is NEUTRAL ("Your wallet went up by …") —
  "the club added" only for `admin_adjustment`. Green only when nothing in `parts` was negative.
- **The Wallet card reads SPENDABLE against the club's shortest booking** (J10-3, `cardLevel`).
  A fourth state `short` (≥1 minute but under `sliceMinutes`) says "You can't book a court with
  10 minutes — the shortest booking is 15 minutes" and makes Buy primary; colour stays the chip's
  amber. The slice comes off a day read the phone holds, else today's grid is read (kept, shared
  with Bookings) only while spendable < 240 (the settings' longest slice). Unknown slice: the plain
  thresholds — an unknown is never "you can't book".
- **A stored ledger reason is the club's voice; the wallet maps it to "you"** (E10-6,
  `memberLedgerRows`, regex table). Admin ledgers show the stored text as is.
- **Still trying on every member first read** (X10-1): Invites, Wallet activity, Buy minutes, a
  booking's page, Profile — outside the skeleton. Profile with nothing kept and no connection says
  the offline line + retry, never red. The avatar's "YA" is AccountMenu's (FA10, asked).
- **Gate `code_used` on the member's door history** (E10-4): chip "Code already used" (warning),
  a line and a decision arm. The member and admin dictionaries share keys (test-pinned).
- **The self-diagnosis code row says time in words** ("fresh, 14 minutes left");
  `spokenCountdown` lives in `lib/memberDoorCopy` so copy never imports a component module.
- **A sheet may drop what it duplicates on a window short for its text** (L10-6,
  `players/invites/useShortSheet`): under 24 root ems of window HEIGHT (measured in JS — a media
  query's rem ignores the page font size) the accept sheet drops Cancel (the × stays; Done stays).
- **Segmented links never shrink below word + padding** (L10-6, `WalletNav`): the bar wraps.
- **Refuted:** the 1280 invite pane's one-tap "Accept and pay N minutes" — the pane draws the
  share, Available now/after and the held line beside it (the sheet's own `AcceptBody`), and an
  accepted partner can withdraw (players-and-splits §withdrawn), so it is the intended action.

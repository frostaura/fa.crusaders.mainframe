---
name: crusaders-mainframe-decisions-frontend-shell-r17
description: "R17 FE17s: conflict_retry is re-read but said as a clash; every overflow-hidden box is scanned for cut rings; navy QR ring; tour clamps; glued toggles."
type: decision
last_verified: 2026-10-06
---

# Live decisions — errors, shell and admin (review round 17, lane FE17s)

- **`503 conflict_retry` stays an unknown outcome (the write is still read back), but it is never
  worded as silence** (X17-1/L17-5). `isConflictRetry(UnsureOutcome.original)` picks the conflict
  words: "Someone else was changing … at the same moment, so we checked: … Try again now." *Why:* a
  batch may land items before the one that gave way, so the look is still owed; but the club DID
  answer, and the clash is over by the time the answer arrives, so "didn't answer … in a minute" was
  false twice. `UnsureWords.conflict` is filled by `unsureWords`; a hand-written pair without it gets
  `LOST_REPLY.conflictGeneric`. Literal pairs elsewhere (bookings `UNSURE_TEXT`, hold lift, top-up
  shelf and open checkouts, bulk-cancel rows) carry their own conflict twins.
  `CONFLICT_RETRY_CAUSE` (no look) ends "Try again now."
- **The desk's cancel 409s are worded and prove the grid stale**: `booking_not_open` → already
  cancelled; `not_cancellable {status}` → played / no-show / a hold (`CANCEL_REFUSAL_TEXT`,
  `cancelRefusal`). Both are in `STALE_GRID_CODES`.
- **`clipped-focus-scan` counts EVERY `overflow-hidden` box** (it required `divide-y`, so the
  combobox's Command root cut its input ring 4px). Boxes that clip but cannot cut a ring live in
  `CLIPS_NO_RING`, keyed by file AND a tag fragment, each asserted still present. *Note:* an
  `Interactable` host that HOLDS controls (InviteCard's `CardWithActions`) is invisible to it.
- **The Command root insets its rings; its input takes `-mx-1 px-1`** so the inset ring clears the
  first letter. Nothing inside a command is a filled button (options are highlighted, not focused).
- **A ring on the QR plate is `brand-strong`** (navy 700 in both themes): the plate is white in both,
  and the dark accent measured 2.02:1 on it.
- **Coach marks are `sticky="always"` with the top bar in their collision padding** (L17-7): the rail
  scrolls on its own and "partial" let the mark ride its anchor off the screen (-498px measured).
- **A required reason never disables its button** (X17-7, ConflictPanel): press → FieldError +
  `focusFirstComplaint`, nothing opens or is sent; the input is `aria-required`.
- **A penalty row that runs INTO the member is "… penalty returned"** on Transactions (E17-5).
- **`glueFigureLabel` (ui/figure-text) is shared by Button, ToggleGroupItem and TabsTrigger** —
  paint glued, accessible name plain. A control whose child is markup glues inside its own
  aria-hidden / aria-labelled span (BadgeGrid status, door peek, sentence chips).
- Proof: `e2e/shell-r17-fe17s.spec.ts` (14 green, mobile + desktop; red at 884423a6 for X17-1,
  L17-3, L17-4 dark, L17-7), `lib/conflictRetryReread.r17.test.ts`, `lib/cancelRefusalsR17.test.ts`,
  `components/schedules/__tests__/conflictPanelReasonR17.test.tsx`, `lib/ledgerCopy.r17.test.ts`,
  `components/ui/__tests__/figureGlueR17.test.tsx`.

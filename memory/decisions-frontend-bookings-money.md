---
name: crusaders-mainframe-decisions-frontend-bookings-money
description: "Bookings screen money and caps: a cap-locked cell says Your limit, held credit per share deadline, money never optimistic, a 402 adopted, a pick past the daily cap said in the selection bar."
type: decision
last_verified: 2026-11-20
---

# Live decisions — the Bookings screen's money, holds and caps

Split from [`decisions-frontend-bookings.md`](decisions-frontend-bookings.md) (the screen's reads, cards and focus),
which keeps the review rounds' pinning tests; the sheets are [`decisions-frontend-book-sheets.md`](decisions-frontend-book-sheets.md).

- **A cap-locked cell says "Your limit" with a gauge, never "Full" with a lock** (F1-6) — the court
  is free; the name says the shown day unless it is today (F1-5).
- **Held credit is explained per share deadline** (C4, F4-18's book-sheet half): `heldPartsOf`
  reads `held_parts` (wire) or `parts` (parsed balance figures); more than one part shows
  each part with its own deadline ("… until … · … until …"; whole minutes since P13), else the single `held_until` line stands.
- **Money is never optimistic; waiting is never silent (perf lane, 2026-09-30).** Book reports the
  slots it sends (`onSending`) and the grid draws them "Holding…" (busy, not pressable, no price,
  no claim of a booking or charge); a refusal takes it back at once, a landed booking becomes the
  confirming cell in the SAME commit (`startTransition`), a sheet closed mid-flight drops it. The
  confirmation is drawn from the POST answer and commits before the grid's re-draw.
- **A 402 `insufficient_balance` is adopted** (R7–R8): its `current_minutes` (the club's SPENDABLE) replaces the
  sheet's figure while the wallet still says the stale one, and the wallet is re-read so the chip follows (an invite
  Accept's 402 too); a slot-cap 409 is said with its figures, joined games counted. Games read `sold_ends_at ?? ends_at`.
  `DaySummary` (in the detail under the grid) says "You can book N more slots today" under a cap, today only, never for an admin.
- **A pick past the daily cap is said in the selection bar** (R4 M4-7): `lib/gridSelection.ts` refuses the pick at the
  cap; the words are `lib/bookingsCopy.ts:194,214`, wired in `pages/Schedule.tsx`. The bar shows the short form
  (`selectionCapShort`, "Limit reached: 4 of 4 today"); the screen reader hears the full rule (`selectionCapSentence`),
  which names what is chosen, never "You can book N more" — *why:* that beside four ticked slots invited a fifth.
  *Corrected 2026-11-20:* both functions were filed under `gridSelection.ts`.

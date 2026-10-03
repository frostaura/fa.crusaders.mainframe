---
name: crusaders-mainframe-decisions-frontend-member-r9
description: "Member screens, review round 9 (lane FC9): the phone opening ignores a leftover scroll, one end time (sold) with lights-off apart, cap words in the pill's figures, stalled reads say Still trying."
type: decision
last_verified: 2026-10-03
---

# Live decisions — member screens, review round 9 (lane FC9)

Earlier: `decisions-frontend-bookings-r5.md` (the opening scroll), `decisions-frontend-offline-data.md`.
Specs: `e2e/member-r9-fc9.spec.ts`; tests named `*R9*`.

- **The phone opening (`useOpenAtWeek`) ignores a scroll already on `<main>`** (J8-3/X8-1 rest).
  *Why:* `<main>` is every page's scroller, so an in-app arrival (member page → "Book for member",
  scrolled to reach the link) kept 980px of the LAST page; "only from the top" skipped the opening —
  the "Booking for" bar 650px above the screen, focus on an H1 at y −871. It measures in the
  scroller's content and stands down only for a wheel/touch/pointer/key on `<main>` before the day
  draws. Opening at the bar, the announcer's heading focus goes to the bar (`tabindex=-1`, no ring),
  since the week may be below the fold at 200 %.
- **One end time: the SOLD end** (`detailModel.soldEnd` = `sold_ends_at ?? ends_at`, E9-7). `ends_at`
  moves (sweep cut; a reversed no-show narrowed to when the relay went dark), so the member read
  12:08–12:22 where the admin read 12:23. A played game that went dark early says "Lights off at …"
  under At the court (`lightsOffAt`); a no-show claims none (its `ends_at` is the sweep's cut).
- **Cap words use the pill's figures** (J9-4): "You've booked 2 of your 4 slots …, so 2 more is the
  most you can choose" / "Limit reached: 4 of 4". Never "the club caps it" — a group may set it, and
  the wire does not say which. The banner's way on moves the SHOWN day: "Try tomorrow" only when that
  is today, else "Try Mon 5 Oct" (`gridCopy.nextDayAction`).
- **A stalled first read says "Still trying"** after 4 s (`lib/offline/StillTrying`, X9-6; the
  session splash's delay) on Bookings, Wallet, Inbox — OUTSIDE the skeleton, whose `aria-busy` would
  mute it. No request-budget change.
- **Accept sheet** (J9-2/X9-5): held minutes with two or more deadlines are listed by part (the
  Wallet's `heldPartsLine`); figures read "Available now / after" with anything held or owed back,
  else "Balance now / after" (the Book sheet's rule). A 402 the re-read explains (now short) is said
  once — by the short notice — not also as a red refusal.
- **"The club booked this for you"** (J9-5): `booked_by_club` on upcoming games and the detail
  (absent = the member's own). The mail half is the server's.
- **A seat chip stacks its photo above the name under 16rem of its own width** (L9-6) — beside it
  the column broke the status pill "Orga/niser". An element cannot container-query ITSELF: the
  `@container` and the `@[16rem]/x:` classes sit on parent and child.

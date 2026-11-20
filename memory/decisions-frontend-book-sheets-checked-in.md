---
name: crusaders-mainframe-decisions-frontend-book-sheets-checked-in
description: "Cancel sheets over a checked-in booking: no member Cancel once attendance is stamped, who checked in is read off the booking record or nobody is named, the desk says partners' shares stand."
type: decision
last_verified: 2026-11-20
---

# Live decisions — cancel sheets over a checked-in booking (rounds 15–19)

The rest of the sheets: [`decisions-frontend-book-sheets.md`](decisions-frontend-book-sheets.md). Tests:
`components/bookings/__tests__/cancelCheckedInByR19`, `e2e/sheets-r19-fe19j`.

- **No member Cancel once `attendance.checked_in_at` is set** (R15 D15-5), whatever an older `can_cancel` says: the
  member-route CancelSheet refuses up front off the quote's `checkedIn` (a member's, or an admin's own — the server's
  member route is `actorIsAdmin: false`) in `ALREADY_CHECKED_IN_TEXT` (subject-free, `bookingErrors.ts:40-41`), with no
  Cancel to press. The club route is unaffected.
- **Who checked in is read off the booking record, never assumed** (R19 J19-3, `checkedInBy.ts`): the quote has no
  scanner; a player row whose own `checked_in_at` is the SAME instant as `attendance.checked_in_at` lit the court (the
  activation and the late-upload reversal stamp the seat with the booking's instant; compared as instants, not strings);
  a partner wins, else the organiser (their seat, or the seatless organiser row, which reads the booking instant only
  when a player lit it — R19 E19-3); no such row (a pay-for payer lit it) or an unreadable record → nobody named
  ("Someone has already checked in…"). One read per sheet (`useCheckedInRecord`, only when the quote says checked in,
  single booking) feeds the desk sentence, the member's own refusal ("You've" only for their own scan), the
  shares-stand note and the toast (`toastSubject`: when nothing came back, whoever the record says scanned, or nobody;
  the organiser where minutes moved); the sentence waits for the record (no swap in a polite region) while Cancel stays
  pressable. Bulk row reason `already_checked_in` is subject-free. A `checked_in_by` quote field would save the read
  (asked; not built). Fixtures that leaned on the old default stamp the organiser's seat at the booking's instant.
- **The desk's club cancel says the partners' shares stand, off the record** (R16 J16-7): on a club cancel whose fresh
  quote says `checkedIn`, `CancelSheet` reads `GET /bookings/{id}` and says `ADMIN_CANCEL.sharesStand` (info, polite) —
  the quote's `partner_refunds` is empty when nothing is refunded. Same rule as `AdminCancelPanel`, both through
  `lib/standingShares.ts`. A failed read says nothing about the shares.

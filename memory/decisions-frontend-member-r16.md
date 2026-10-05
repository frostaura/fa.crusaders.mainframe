---
name: crusaders-mainframe-decisions-frontend-member-r16
description: "Member words and frames, review round 16 (lane FE16m): precise money words out of the entry, a toast says which booking, who acted named, namesakes told apart."
type: decision
last_verified: 2026-10-05
---

# Live decisions — member words and frames, review round 16 (lane FE16m)

Earlier: `decisions-frontend-member-r15.md`. Contract: BE16b's R16 (players_added, share_changed_by,
collect_needs_overdraft, at_daily_limit, cancelled_share_stands, namesake fields).

- **The chip's precise money words live in `lib/movementCopy.ts`, NOT the entry** — the chip
  `import()`s it per frame and says `walletCopy.plainMovementSentence` if the chunk cannot be had
  (a toast is never lost; `MinutesChip.lazyWords` test). *Why:* entry was 494.98/500 kB; moved, ~490.8.
  Never import movementCopy from walletCopy or any static import of `main.tsx`.
- **A toast stands alone, so it says which booking** (J16-4/E16-4): "Your missed booking on Court 2 ·
  Mon 5 Oct, 18:30 …", "The no-show on … was reversed", "Your booking on …: …", pay-for payer
  "Oona's booking on …". Unplaced frames keep the old sentences.
- **Who acted is named, never guessed** — `share_changed_by` (J16-1): the club only when the club did;
  `player_added` (J16-2): the organiser by name, none/"The club" → the club; settle-outside (J16-6) is
  "<partner> paid <organiser> by hand", never "settled with the club"; a started-session club cancel
  names `checked_in_by_name` (E16-3) and tells partners "your share stands" (J16-7, a second
  balance-neutral frame the chip announces).
- **Collect asks for the go-ahead only when the seat says short** (`collect_needs_overdraft`; absent →
  asked, as before; a raced shortfall is asked by the server's refusal).
- **Namesakes** (J16-3): member picker line = games played with you / member since (never email,
  phone, membership number), as the button's description; admin combobox "#1042 · email".
- **X16-5 refuted with measurement:** the share toggle's target is its row (stretched `::after`, R4
  V4-10 keeps no floor on the button). The spec measures the tap run, not the text box.
- **The setup checklist offline reads kept states by `useDataOwner().who`** (X15-4).
- **A refused reason-required admin dialog focuses the first complaint** (`players/admin/complaintFocus.ts`).

## The desk's cancel sheet and Book-as picker (lane FE16s3)

- **The cancel sheet says the partners' shares stand, off the booking's record** (J16-7): on a club
  cancel (admin, not own) whose fresh quote says `checkedIn`, `CancelSheet` reads
  `GET /bookings/{id}` and says `ADMIN_CANCEL.sharesStand` (info alert, polite). *Why the record,
  not a prop from the panel:* the quote's `partner_refunds` is empty when nothing is refunded, and
  the grid's and the member page's sheets (an early check-in) need the line too. Same rule as
  `AdminCancelPanel.standingShares` (accepted member seat, not settled by hand, paid > 0) — the
  two copies should become one helper. A failed read says nothing about the shares (never "none").
- **Book-as rows carry `DETAIL_ADMIN.memberSubtitle`** (J16-3): "#1042 · email", searchable.

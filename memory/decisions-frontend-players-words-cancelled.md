---
name: crusaders-mainframe-decisions-frontend-players-words-cancelled
description: "Member screens for a cancelled or gone game: who cancelled and why, each partner's share named, a paid share stands or went back, and a game the member can no longer read loses its View booking link."
type: decision
last_verified: 2026-11-20
---

# Live decisions — what the member screens say about a cancelled or gone game

Split from [`decisions-frontend-players-words.md`](decisions-frontend-players-words.md); server truth:
[`decisions-share-causes.md`](decisions-share-causes.md).

- **A cancelled game says who and why** (R13 J13-6, `cancellationWords`, fields read via `lib/playersApi.ts:183-185` —
  the interim `CancellationWire` type is gone): "The club cancelled this game." + "Reason: …" on its own line, the
  displacement sentence, "You cancelled", "Sam cancelled"; no fields (older server) → "This game was cancelled." The
  organiser's cancel note and the free cancel name each member partner (`DETAIL_CANCEL.partnersBack`,
  `CANCEL_SHEET.free(whose, partners)`; singular for one; guests and open seats hold no share); the desk's split-cancel
  note is third person (`SPLIT_CANCEL.note(subject, partners)`). A partner's cancelled share: paid → stands; returned →
  "the N you'd paid went back"; by hand → "nothing moved in the app"; paid nothing → "Paid nothing · nothing owed", never
  "went back". A cancelled page draws wrappers only with content and no admin seat hands.
- **A gone game** (R13 J13-3, R14): `share_bookings[id] === null` (key PRESENT) means the member can no longer read it —
  no "View booking"; absent means not summarised and keeps the link; `share_places` fills a null summary as a `gone`
  place-only booking (`LedgerTable.isGone`). A 404 detail reads its own seat (`own_seat_id` or `?seat=` → `NotOnGame`).

---
name: crusaders-mainframe-decisions-frontend-member-r17
description: "Member words and frames, review round 17 (lane FE17m): stale wallet reads dropped, namesakes escalate to a club ref, 44px day chips, kept club zone, paid by hand."
type: decision
last_verified: 2026-10-06
---

# Live decisions — member words and frames, review round 17 (lane FE17m)

Earlier: `decisions-frontend-member-r16.md`. Contracts: BE17b (`actor_name: "The club"` on desk
booking_charge, `checked_in_by_you` on every frame), BE17c (`member_ref`, club-date `member_since`,
Night seat-act kinds). Tests: `liveBalanceR17`, `splitEffectsR17`, `quotaSlotsR17`, `refusalFocusR17`,
`namesakesR17`, `bookingChargeToastR17`, `reversalWordsR17`, `nightTimelineR17`, `conflictWordsR17`,
`shareHeadGlueR17`, `clubZoneKeptR17`, `cancelledWordsR17`, `bulkCancelRefusalR17`, `e2e/member-r17-fe17m`.

- **A wallet read is tagged with the frames seen when it was SENT** (J17-2). An answer that finds a
  frame arrived since is dropped (`framesSeen` in `useLiveBalance`); unnamed twins count. *Why:* a
  slow focus read overwrote a newer frame and toasted "went up" when it went down. `apply()` (a
  booking answer's balance) is not tagged — same class, not seen.
- **Namesakes escalate as a group** (L17-2): own line → "Member since 6 Oct 2026" (club date, string
  maths, never a zone) → "· ref K7Q2". `namesakeDetails(rows, base)` per rendered list; a unique name
  keeps its short line. The painted line is `keepFiguresWhole`d; the description stays heard plain.
- **The daily cap counts slots** (X17-2): `acceptedSlotsOn` sums each partner row's slices; the
  banner says slots are "in" games said yes to.
- **Day strip chips are 44px at 320** (X17-3): `minmax(2.75rem,1fr)`; a row under 310px bleeds ≤12px
  into the gutters, the column gap is the leftover clamped to 2px. *Trap:* `min-[25rem]:` is NOT
  emitted with this config's mixed-unit screens and Tailwind warns on build — use width maths.
  The `sm` button's 44px is its `after:` box — measure a tap run, not `getBoundingClientRect`.
- **A danger notice on the booking page is scrolled to centre and focused** a task after render
  (L17-6), after the closing picker has restored focus to Invite.
- **Picker grids are `grid-cols-[minmax(0,1fr)]`** (L17-1): an auto column took the row's
  min-content and ran 18px past the sheet at 320 / 200 %.
- **Who acted, one form** (E17-1/E17-9): desk booking "The club booked you Court 2 · … — 30 minutes
  went on it."; the scanner by first name everywhere in movement toasts; the scanner's own attended
  share "you checked in" only with `checked_in_by_you` (an older frame claims nobody). Share toasts
  end with a full stop (the ledger's row lines do not).
- **The club's zone is kept on the phone** (X17-5, `crusaders.club-zone`): a cold offline start
  formats kept times in the club's zone; sign-out forgets it; a bad stored zone is ignored.
- **Paid by hand, one wording** (E17-3/L17-8): admin menu "Mark as paid by hand"; a cancelled game's
  seat that paid nothing reads "Paid nothing · nothing owed", never "went back" (E17-2); a settled
  seat in Change split "paid by hand — nothing moves for them in the app" (J17-3).
- **conflict_retry on players surfaces** goes through FE17s's `unsureSentence` conflict pair (invite
  accept/decline, share link `linkUnsure`).
- Night: six seat-act kinds and `court.checked_in` are never folded (each is one person's story).

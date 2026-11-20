---
name: technologies-crusaders-squash-control-system-decisions-frontend-players-words
description: "Member screens for games with partners: the invite and accept sheets show only what a yes means, consent words key on what was agreed, the club's acts are the club's, namesakes escalate, writes hold the page."
type: decision
last_verified: 2026-11-20
---

# Live decisions — what the member screens say about partners and games

Server truth behind these: [`decisions-players-access.md`](decisions-players-access.md),
[`decisions-share-causes.md`](decisions-share-causes.md). Copy lives in `lib/playersCopy.ts`, `lib/inviteFacts*`,
`components/players/**`. A cancelled or gone game: [`decisions-frontend-players-words-cancelled.md`](decisions-frontend-players-words-cancelled.md).

- **Accept sheet** (R9): held minutes with two or more deadlines are listed by part (the Wallet's `heldPartsLine`);
  figures read "Available now / after" with anything held or owed back, else "Balance now / after" (the Book sheet's
  rule); a 402 the re-read explains (now short) is said once, by the short notice. The 1280 invite pane's one-tap
  "Accept and pay N minutes" is intended (refuted R10): it draws the share, Available now/after and the held line.
- **The Decline question is about declining** (R12 J12-3, `invites/AcceptBody`, `inviteFacts.answerHeading`): "Decline
  this game?" with the game only — no share, balance, limit or deadline (they describe a yes); one live region says
  both sentences ("Nothing moves: no minutes leave your wallet."); Keep → figures back, focus on Decline.
- **Consent words key on what was agreed** (R4, R14 J14-9): a seat that said yes and is asked again reads "Your share
  went up" (`inviteHeading`), never "You're invited"; with `consented_minutes` 0 (the club accepted without asking) it is
  `DETAIL_PLAYER.askedFirst` — "The club has asked you for 12 minutes — review it to say yes" (`inviteFacts.neverAgreed`;
  absent field = the old words); the change-split notice says again / first / both (`splitDoneWords`). "You cover X now" is
  price minus the live partner seats (the organiser seat's own figure went stale on removal).
- **Lines that need a fact the phone lacks are drawn only when known**: "Counts toward your own daily limit" only for a
  member with a known cap (`useDailyCap`, off the game day's grid `rules`; 0/null caps or an unreadable day = no line);
  the collect go-ahead only when the seat says `collect_needs_overdraft` (absent → asked; a raced shortfall is asked by
  the server's refusal); its words say "whatever their balance doesn't cover".
- **The quota banner counts slots in games said yes to** (R11 E11-6, R17 X17-2: `acceptedSlotsOn` sums each partner
  row's slices): all accepted → "Your 4 slots for Saturday are in games you said yes to … Pick another day."
  (`gridCopy.ts:116`); some → "Cancel one of your own bookings…"; the locked cell says "you've used your 4 slots".
- **Mixed lengths name their length** (R12 J12-2, `usePlayersStep.confirmLines`): one length → "On each booking you
  pay…"; mixed → "On the 15-minute booking…"; split headings are adjectives ("Each 15-minute booking").
- **The club's acts are the club's** (R15 J15-1): `removed_by` (the seat read, else the 404) → "The club took you off …" /
  "Olga took you off …"; null names nobody ("You were taken off …"), never the organiser; `added_by_club` → "The club
  added you to Owen's game"; `booked_by_club` (R9 J9-5, absent = the member's own) → "The club booked this for you"
  (`DETAIL_COPY.bookedForYou`), "Booked for you" on upcoming games — the admin's "Booked by the club" is another
  page's unnamed-booker fallback (`memberDetailCopy.bookedByUnknown`). One wording for paid
  by hand: admin menu "Mark as paid by hand"; a settled seat in Change split "paid by hand — nothing moves for them in
  the app".
- **The pull-out states the figure** (R12 X12-4): `withdrawBody(paid)` / `withdrawn(paid)` from the seat's
  `paid_minutes`; nothing paid → "nothing moves". Accept confirmation is what THIS press paid, total beside it.
- **Namesakes escalate as a group** (R16–R17): the picker line is games played with you / member since (never email,
  phone, membership number), as the button's description; same names step up to "Member since 6 Oct 2026" (club date,
  string maths) then "· ref K7Q2" (`namesakeDetails(rows, base)` per rendered list); the desk's Book-as rows carry
  `DETAIL_ADMIN.memberSubtitle` ("#1042 · email"). One initials helper, `lib/initials.ts`, mirroring
  `MemberDisplay.SurnameInitial` (last non-suffix word: Jr, Sr, Junior/Júnior, Filho, Neto, II–IV), held single by a scan.
- **Focus and hold** (R5–R18): Remove player and Change split hold the page while in flight (`useSheetHistory`;
  Back/Escape/×/Keep are refused while the write is out, a waiting line in place of Keep/Cancel; a landing after a
  forced teardown is a toast); a danger notice on the booking page is scrolled to centre and focused a task after
  render; the picker keeps a refusal's focus on close (`keepRefusalFocus` — jsdom never animates, so the unit test
  fakes an exit animation); a refused reason-required admin dialog focuses the first complaint (`complaintFocus.ts`);
  "(you)" by member id (`isViewerSeat` — the organiser's own seat may have no id); PauseSwitch is optimistic with rollback.

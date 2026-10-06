---
name: crusaders-mainframe-decisions-frontend-shell-r19
description: "R19 FE19x: counts only from a whole read; passing 503s are busy on the session and door screens; a write's 500 is an error; toasts speak through a waiting region."
type: decision
last_verified: 2026-10-06
---

# Live decisions — shell, errors, admin counts, toasts (review round 19, lane FE19x)

- **The Members chips count only a club read whole** (L19-1, `countableRows`): `readAt` (stamped
  when the last page lands) or a first read still walking (said: "Counts cover those"). A walk that
  failed part way counts nothing. *Why:* page 1 counted as the club read "Pending 1" with the
  applications on the page that answered 503. Other paged admin reads already fail whole
  (`readLedgerStart`, group memberships) or are one reply (a group's members).
- **A passing 503 is the club answering busy** (X19-1.1, X19-1.3): `service_busy` and
  `conflict_retry` on the session check take ConnectionLost's busy title + `SERVICE_BUSY_CAUSE`,
  like a 429. The door card's `ReadFailure` is `network | server | busy | clash`
  (`DOOR_FAILURE_LEADS`): busy/clash are "not your phone, it passes in a moment", never "an error".
  A 503 with no code (restart) stays unreachable / an error.
- **A write's plain 500 is an error, not silence** (X19-2, `unsureReasonOf`): reasons
  `busy | conflict | error | silent`; silent = NetworkError, abort, 502, 504 and a code-less 503
  (R17 pinned it). `unsureWords` builds an `error` twin; a hand-written pair falls back to
  `LOST_REPLY.errorGeneric`. No "in a moment" for an error. The players hooks moved too, and
  `unsureCauseOf` is retired (FE19m, `decisions-frontend-member-r19.md`).
- **Toasts are announced by a region that was there first** (X19-3): the viewport
  (`data-toast-viewport`, `aria-live="polite"`, additions text, NO role) is rendered by the
  provider at the root, empty; toasts (`data-toast`) are inserted into it with no role and no
  `aria-label`. *Why:* NVDA/JAWS may not announce a live region inserted already full, and a
  label overrides the words. Not `role="status"` on the viewport: an always-present status broke
  22 unit tests' unnamed `getByRole("status")`. Find a toast by `[data-toast]`, its spoken words by
  `[data-toast-viewport]`. Dismiss is a real button "Dismiss" (described by the words, inset ring,
  44px hit box); tapping the surface still dismisses.
- **A final cancel refusal is headed "Not cancelled"** (L19-5, `lib/cancelSheetCopy.ts`), and
  "The schedule behind this is up to date now." becomes the place the sheet was opened over, read
  off the route via `UNSAFE_LocationContext`: schedule · `/bookings/:id` · a member's bookings.
- **A message naming two boards has its own fault words** (D19-4 console, `deviceFaultCopy`):
  `TwoBoardsDetail` is "named more than one board" (it WAS read; title ours, never "could not
  read"); D19-4's " (boards named: a, b)" suffix is parsed off any detail and listed, "filed
  against neither". A suffixed row's title is ours: `HeadlineOf`'s EndsWith does not see past it.
- **The door card's margin is `min(1.5rem,24px,4vw)`** (L19-6): ≥ 70 % column at 320/390 · 200 %.
- Proof: `pages/admin-members-partial.r19.test.tsx`, `components/shell/ConnectionLostBusy.r19.test.tsx`,
  `components/member-door/doorBusyLead.r19.test.tsx`, `lib/lostReply.serverError.r19.test.ts`,
  `components/toast-announcer.r19.test.tsx`, `components/bookings/__tests__/cancelEndedR19.test.tsx`,
  `lib/deviceFaultCopy.r19.test.ts`, `e2e/shell-r19-fe19x.spec.ts` (mobile + desktop).

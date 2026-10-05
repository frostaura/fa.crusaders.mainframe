---
name: crusaders-mainframe-decisions-fe15s-r15
description: "R15 FE15s: the worker's activate ends at claim, the rest precaches in its own message; e2e waits are sync; URL text fields debounce; clipping lists inset rings; arrows aria-disabled."
type: decision
last_verified: 2026-10-05
---

# Live decisions — shell, admin, layout and the worker (review round 15, lane FE15s)

- **The worker's `activate` ends at `clients.claim()` + the purge of earlier shells** (X15-2).
  *Why:* the browser HOLDS every fetch of a controlled page until activate's `waitUntil` settles;
  with ~40 desk chunks fetched inside it a reload waited 2.3 s at 100 ms/request, 6.9 s at 300 ms.
  The rest (`finishInstall`: `precacheRest` then purge of the earlier build's assets) runs in a
  message the worker posts ITSELF (`registration.active.postMessage({type:"FINISH_INSTALL"})`, works
  in Chromium, no page code) and behind the first navigation of a later lifetime (single flight).
  Measured after: reload during activation 136 ms @100, 329 ms @300; every chunk still cached.
  `swHarness` models the self-message (`sw.background()`).
- **No e2e wait takes an async predicate** (X15-1): `waitForFunction(async …)` returns a Promise,
  truthy on the first poll — the R14 offline flake. `await navigator.serviceWorker.ready` in an
  evaluate, then a SYNC wait on `controller?.state === "activated"`. Guard: `src/e2e-waits.test.ts`.
- **Chromium's offline emulation leaves `navigator.onLine` TRUE on the next document** (measured):
  a spec that goes offline and then navigates must pin it false (init script), or the app reads
  "can't reach the club" for a phone with no signal. Done in both offline specs I own.
- **A URL-bound text field owns what was typed** (L15-2, `lib/useUrlText`): the URL is written after
  250 ms of quiet; its own echo is not adopted; any other URL move is adopted and cancels a pending
  write. *Why:* a URL write is a navigation committed a render later; a key landing before it was
  reset — "bartholomew" came out "w" under a 6x CPU throttle. Members `?q=` and the ledger's name
  search. Proof: `e2e/url-search-r15.spec.ts` (400 rows, 6x throttle, 30/80 ms keys).
- **A list that clips its rows insets their rings** (L15-1): `[&_:focus-visible]:-outline-offset-2`
  on any `overflow-hidden` + `divide-y` list; guard `src/clipped-focus-scan.test.ts` (an allow-listed
  file must have nothing focusable). A door line focused by "Load older" was clipped too.
- **Stepper arrows are `aria-disabled` at their ends, never `disabled`** (X15-5): a disabled button
  blurs and focus fell to `<body>`. The paging scan now also reads arrow-named attributes
  (aria-label/label "Next", "Previous", "Next week").
- **Record terms use a rem container query and an `auto` term column on a subgrid** (L15-3,
  MemberOverview facts and MemberDoors lines, threshold 30rem): every value in one column, the term
  column as wide as the longest term; the address through `EmailWithBreaks`.
- **Under a 14rem box an Alert's mark takes its own line** (L15-4), never floats into the first line.
- **`Skeleton` is `max-w-full` by default, and that is not enough alone** (L15-5): a flex column's
  floor is its widest child and an implicit grid track is `auto`, so a fixed-rem bar still pushed a
  320 / 200 % phone 97px sideways until the column got `min-w-0` (MemberSkeleton) / the grid a
  `minmax(0,1fr)` track (BookingForBar). Sweep: `e2e/layout-r15-fe15s.spec.ts`.
- **The club cancels a booking from its page, started included** (J15-2, `AdminCancelPanel`): the
  grid's `CancelSheet`, always on the admin route (reason required, server quote names "nothing is
  refunded" once checked in), hidden beside the organiser's own Cancel and on any non-booked status.

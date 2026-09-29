---
name: crusaders-mainframe-gotchas-real-stack
description: "Real-stack walk (e2e-real) traps: the anonymous auth limit, past_time for a booking now, the box's cue window, courts held by earlier runs, sessions expiring in the wait, celebrations mid-walk, 21:00 quiet hours."
type: gotcha
last_verified: 2026-09-29
---

# Gotchas — the real-stack walk (`e2e-real/`)

Found getting `e2e-real/play.spec.ts` green on 2026-09-29. Each one failed the walk once.

- **Rebuild the frontend container too.** `docker compose up --build -d backend` leaves the
  12-hour-old nginx build serving a PWA with no new screens; the walk drives the production
  build behind the gateway, not Vite. `up --build -d backend frontend` — never `down -v`.
- **Anonymous auth routes allow 10 a minute per IP**, and a walk that registers two members per
  test in two viewports passes it. A `429` on `verify-email` renders **"That link didn't work"**
  — a member would believe a good link is dead (a PWA defect, not fixed). The spec waits out
  `Retry-After` and repeats the step; a 429 is refused before the token is spent.
- **A booking "for now" is `past_time`** once the current slice has begun — book the NEXT slice
  boundary. The box then answers `too_early` until `StartsAt − activation_cue_window_minutes`
  (10), so the walk waits up to five minutes before it can check in.
- **Every run holds a court until its booking ends**, and the seeder books the evening. A spec
  that takes "the first court" is refused on the second run; take the first FREE court across a
  few boundaries, and book one slice.
- **The wait for a court and its cue can outlast a session.** A dev-admin session cached for the
  worker's life came back `401 invalid_token` 25 minutes in; `devAdminSession` now re-logs after
  five minutes and the play walk signs both members back in after the check-in.
- **A box's roster can hold two entries on one relay** — the booking still running on that court
  and yours. Pick the entry by its `closes_in` (`token|relay|opens_in|closes_in`), not "relay 0".
- **A fresh member's "First court" celebration arrives within the play worker's minute and may
  cover the booking page** mid-step (allowed there by §9.3). Dismiss it before clicking.
- **`play.result_to_confirm` is held by quiet hours (21:00–07:00 club time).** After 21:00 the
  confirm mail never arrives and the walk's mail step times out — run it in the evening, early.

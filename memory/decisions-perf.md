---
name: crusaders-mainframe-decisions-perf
description: "Perf round 2026-09-30 backend: writes get their own per-member rate limit, confirmation mail is composed after the response, slug lookups are cached, gzip on both hops, additive paging, photo links, wallet share summaries."
type: decision
last_verified: 2026-09-30
---

# Live decisions — the perf round's backend changes (2026-09-30, lane B)

Measured numbers and method: [`gotchas-perf.md`](gotchas-perf.md). Sign-in limits: [`decisions-sessions.md`](decisions-sessions.md).

- **Writes have their own limiter, `writes`** (`RateLimitPolicies.Writes`): per member, a token
  bucket of `RateLimits:WritesBurst` (20) refilled at `WritesPerMinute` (60), **never tighter than
  `AuthPerMinute`**. Member and admin booking, bulk, players, play and desk-credit writes use it.
  *Why:* they shared `auth`'s 10/min with password and code guessing, so the 11th booking-ish
  call in a minute (book, invite, accept, cancel) was a 429. **`auth` (10/min) stays on** the
  guessing and secret-handing routes only: register/verify, PIN and QR match, QR generate, code
  enrol, revoke-all. *Why the floor:* the suite and load tests raise `AuthPerMinute`, and the
  factory only forwards the keys it lists — a writes ceiling below it would 429 them.
- **Quotes are reads.** The member cancellation-quote GET has no named policy (global backstop
  only), as the admin quotes already did (P2-1): a quote must never spend the budget of the
  cancel it quotes.
- **The booking confirmation is composed after the response.** The request fixes the figures
  (post-charge balance, penalty policy) and hands the booking id to a `Task.Run` with its own
  scope and tenant; that reads the address, the membership name and the club, builds the PDF and
  sends. *Why:* four reads and the PDF sat on the booking POST. **Durability is unchanged** — it
  was already an in-process fire-and-forget for the SMTP half. NOT a hosted service on purpose:
  `TestWebAppFactory` removes every `IHostedService`, and the mail must reach the suite.
- **The tenant slug lookup is cached per host** (`IMemoryCache`, 5 min, hits only). *Why safe:*
  a club row is only ever added — no rename, no delete. **`PasswordChangeGate` is not folded:**
  it must be exact, and a claim-based gate needs every token mint site changed. Not worth it.
- **Compression lives in nginx, not Kestrel.** The SPA image gzips its assets; the gateway gzips
  the API's JSON and passes the SPA's through. **`text/event-stream` is never in `gzip_types`**
  (a gzip buffer stops SSE streaming) and **`/api/v1/auth/` is uncompressed** (token beside
  caller-chosen text is the BREACH shape; the bodies are tiny). `CompressionPostureTests`.
- **Paging is additive, switched by the PRESENCE of `cursor`.** `/admin/members/` and
  `/admin/ledger/` answer the bare array exactly as before without it; with `cursor=` (empty for
  page one) they answer `{ items, next_cursor }` (+ `total` on members), keyset by (at, id).
  *Why a presence switch:* the ledger already took `limit`, so `limit` could not change the shape.
  R4: the paged ledger's first page also carries the whole range's `totals` (null on later pages).
- **`photos=url` hands a data-URI photo out as `/api/v1/photos/{userId:N}/{hash16}`** on
  `/schedule` and `/admin/members/`. Anonymous (an `<img>` sends no token), tenantless, and the
  SHA-256 prefix of the stored value is the check — the same exposure model as `/uploads/`.
  `immutable` for a year because the URL changes with the photo; SVG served under
  `sandbox` CSP. `/uploads/` photos pass through unchanged.
- **`/wallet?include=share_bookings`** adds `share_bookings: { bookingId: summary | null }` for
  the page's ShareTransfer rows (first 20), by the detail's own access and visibility rules
  (`PlayersQuery.IsShown`); `null` where the detail would 404. Without it the field is `null`.

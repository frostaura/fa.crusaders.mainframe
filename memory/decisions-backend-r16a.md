---
name: crusaders-mainframe-decisions-backend-r16a
description: "Backend round 16 (lane BE16a): unstorable text is a 400 not a 500, device time saturates, per-board device limiter, reversal on stamped at emission, checker named on a started cancel."
type: decision
last_verified: 2026-10-05
---

# Live decisions: backend, review round 16 (lane BE16a)

- **A value PostgreSQL cannot store is the caller's, never a 500** (D16-1). Three layers:
  `Security/StorableText.RefuseUnstorableText()` on the auth, admin-device and webhook groups refuses
  a NUL (400 `invalid_body`; `bad_request` for a route/query string); columns are checked by name
  where a route writes them (`url_too_long`/`event_filter_too_long`/`description_too_long`,
  `email_too_long`/`membership_number_too_long`, each with `max_length`); and the stable-error handler
  maps SQLSTATE 22001/22021 anywhere in the exception chain to 400 (`malformed_body` on a device
  route). *Why:* a NUL in a login email 500'd from the lookup's parameter alone.
- **Device bodies stay lenient**: a `\u0000` escape is read as U+FFFD exactly like invalid UTF-8
  (fault filed, body used). A heartbeat version past 32 characters is NOT kept (the row keeps the old
  one, never a cut string) and the heartbeat is still answered. *Why:* a 400 heartbeat is a box with
  no roster; a diagnostic field must not take a court out of service (the `NoPush` precedent).
- **Arithmetic on a board's numbers saturates** (`Endpoints/DeviceTime`): uptime deltas in decimal,
  instants clamped to `DateTimeOffset.Min/MaxValue`, which every caller already reads as out of range
  (clock_clamped, unpaired release, bounded lit window). Never `AddMilliseconds` on a device number.
- **D16-5:** `malformed_body` details are plain words — `DeviceBody.ReplacedDetail` ("some characters
  could not be read and were replaced; the rest was read and used") vs `NotJsonDetail` ("the message
  could not be read at all, so nothing in it was used"), plus `DeviceEndpoints.VersionTooLongDetail`.
  The headline follows the detail: `DeviceErrorCodes.HeadlineOf(code, detail)` on every row surface
  (list, CSV, SSE). Same code, so firmware and the closed vocabulary are unchanged.
- **The device limiter is per board** (`Security/DeviceRateKey`, ahead of `UseRateLimiter`): key
  `device:{tenant}:{mac}` from the first 4 KB of the body, else `tenant:`, else `ip:`. *Why found:*
  the Device scheme is not the default one, so `UseAuthentication` never ran it and the limiter had
  partitioned every device call by client ADDRESS — one board refused 403 (bridge 2.2.5 spinning)
  spent every board's minute. The middleware authenticates the key itself (cached for the request):
  one key lookup per device request before the limiter, bounded by the global per-address ceiling.
  A key holder can spread over invented MACs; that is a stolen key, not this limiter's job.
- **A reversal's `lights_on` is stamped at its emission when an off for the court was already said
  after the scan AND the restored session is still running** (E16-2); `data.scanned_at` carries the
  scan on every `lights_on`. "Already said": the booking's own `LightsOffCuedAt` after the scan, or
  another booking on the court cued off whose `EndsAt` is after the scan and past. *Why the running
  condition:* an over session's off is in the past; an on stamped now would sort after it and hold
  the court lit for ever, so it keeps the scan stamp (R14/R15 behaviour).
- **lights-controller.md's "cancellation fires an immediate off" is false in code:** a lit cancelled
  booking's off is said at its `EndsAt` by the sweep (R14 D14-2); an unlit one gets none.
- **A cancelled relit reversal is swept like any lit cancellation** (D16-4): the off sweep takes
  `Cancelled && CheckedInAt && NoShowReversedAt > LightsOffCuedAt` (within the 2 h lookback), and the
  walk counts it as a holder whose off is to come.
- **The checker of a started session** (E16-3): the seat stamped at `CheckedInAt`, else the earliest
  `court.activated` scanner (jsonb containment), else the booker. Mail "X had checked in already" /
  "You had…", inbox "(X|you had checked in)", frame `checked_in_by_name` (null for the booker). The
  frame is built in `BookingService` and sent with `LedgerService.PublishFrameAsync`.
- No-show/reversal/outage-reversal mails take `EmailTemplates.CourtSlot(court, startsLocal)`: subject
  "… — Court 1 on Tue 13 Oct at 06:00" and a When row (E16-4).
- Tests (38 of 43 red at 65f8e7bc, the rest are guards): `R16StorableInputHttpTests`,
  `R16DeviceRateHttpTests`, `R16LightsHttpTests`, `R16BookingWordsHttpTests`.

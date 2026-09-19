---
name: crusaders-mainframe-decisions-door-gate-http
description: "One HTTP call on the door gate: the framing the real server sends and how G2's fix made every call time out, the three phases and their budgets, and the two since-boot counters the board has nowhere else to put."
type: decision
last_verified: 2026-09-19
---

# Live decisions — the door gate's HTTP call

The edges around it — the URL grammar, the secrets guard, the UART — are in
[`decisions-door-gate-io.md`](decisions-door-gate-io.md); what the loop does with the call is
in [`decisions-door-gate-loop.md`](decisions-door-gate-loop.md).

- **The response body is read into the caller's buffer, capped, FRAMED, and on its own
  deadline.** G2 made it capped and deadlined — `http.getString()` had heap-allocated the whole
  body under two comments promising it did not, then TRUNCATED it into `out` and returned the
  peer's 200, and `{"opened":true,` cut after the comma is a door that opens. **G3 found that
  fix was a CRITICAL regression on real hardware:** it consulted only `http.getSize()` (-1
  unless Content-Length) and read until the peer closed, while Kestrel answers every device
  route `Transfer-Encoding: chunked` with no Content-Length on a keep-alive socket. Every call
  timed out → status 0 → no roster → **the door refused everyone**, and nothing here could see
  it because no test in this repo reads a real socket. Fixed belt and braces: the port asks for
  HTTP/1.0 (`useHTTP10(true)` + `setReuse(false)`) so the body is close-delimited, AND the pure
  reader de-chunks when a collected `Transfer-Encoding` says to — a proxy that re-chunks anyway
  would otherwise take every door out of service. Malformed framing is a reported failure, not
  a salvaged half-document. Fixtures are the real captured bytes.
- **A call is THREE phases, not two, and the body's deadline is sampled AFTER the headers.**
  Sampling it from the start of the call left a slow header phase handing the body a deadline
  already in the past. `kWorstBlockingCallMs` = 4 s connect + 4 s headers + 4 s body = **12 s**,
  `GATE_WATCHDOG_SECONDS` = **15**, release overrun **12 010 ms** and a worst-case physical
  release of **42.01 s**. **Residual, unchanged:** HTTPClient's own header loop inside `POST()`
  cannot be interrupted, so a peer that dribbles HEADERS can outlast the bound. That is the
  watchdog's case and the one precondition on the sentence.
- **Two diagnostic counters ride in the heartbeat request, because nothing else on this board
  can show them.** `no_push`: heartbeats the server answered from which no roster could be
  adopted — a body cut short (`devlink::applyRoster` cannot tell a short roster from a cut one),
  bad framing, or a missing key. **G2's own fix silenced it**: a failed body became status 0 and
  `adoptHeartbeat` returned early, so the diagnostic went quiet in exactly the case it was built
  for; `IHttpPort` reports the peer's status alongside the actionable one to tell that apart
  from a host that never answered. `events_lost`: `EventQueue::overflowed()`, which that header
  promised was "reported, never silent" and which **nothing read until G3** — 64 slots against
  a door doing 720 scans an hour. Both are SINCE-BOOT TOTALS, both omitted at zero (so a healthy
  body stays byte-identical to the corpus vector) and both **saturate at INT32_MAX** rather than
  wrapping, because the API ignores an out-of-range value instead of answering 400. A diagnostic
  lamp pattern was rejected for both: this lamp is what tells a member their scan was seen.

- **Both cores' `HTTPClient` is the same API and very nearly the same code.** Verified G3:
  `HTTPClient.h` is byte-identical between `espressif32@6.9.0`'s framework package and
  arduino-cli's `esp32:esp32@2.0.17`, and the two `.cpp`s differ only inside `writeToStream`'s
  chunk handling, which this firmware does not call. `useHTTP10(true)` also sets `_reuse =
  false` in both; `setReuse(false)` is written out anyway so the intent survives a core that
  stops doing that.

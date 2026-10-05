# `src/iot/door-gate` — door-gate firmware

One ESP32 per door. A QR scanner on a UART, one relay driving the door lock, one
LED. A member scans; the board asks the API; the lock releases for a few seconds.
When the API cannot be reached the board decides from the roster its heartbeat
filled, and tells the API what it did once the link comes back.

No LCD, no buttons, no second microcontroller, and **no inbound network
surface**: this firmware opens no listening socket, calls no `WiFi.config()` and
takes a DHCP lease. The sketch this replaces ran an unauthenticated HTTP server
whose `/open` endpoint unlocked the door for anyone on the club WiFi.

**One firmware for every door.** Nothing per-gate is compiled in. A door is named
in the admin console (`gate_key`), the API keys that name to the board's MAC, and
**the board never needs to know it** — nothing in this firmware reads `gate_key`
and there is no field to keep one in. Two doors run byte-identical images and a
spare board is a spare board rather than a board for one particular door.

Everything in `lib/` except `esp32_hal/` is free of Arduino headers, so the same
sources compile for the ESP32 and for the host test runner — which is what lets
`pio test -e native` prove every decision with no board attached.

---

## Wiring — Carl's, and fixed

| | Pin | Notes |
|---|---|---|
| Scanner TX → ESP32 RX | **GPIO 4** | `Serial2`, 9600 8N1 |
| ESP32 TX → scanner | **GPIO 17** | wired and unused — the scanner only talks |
| Relay module input | **GPIO 26** | drives the door lock |
| LED | **GPIO 27** | the board's entire user interface |

Every one of those is a build flag with Carl's value as its default, because
nothing about the second door has been confirmed. The flags are in
[`platformio.ini`](platformio.ini) and the defaults are repeated in
[`lib/gatelogic/include/gatelogic/GateConfig.h`](lib/gatelogic/include/gatelogic/GateConfig.h)
so the headers still compile with no build system at all.

| Flag | Default | What it is |
|---|---|---|
| `GATE_SCANNER_RX_PIN` / `GATE_SCANNER_TX_PIN` | 4 / 17 | the scanner UART |
| `GATE_SCANNER_BAUD` | 9600 | 8N1 |
| `GATE_RELAY_PIN` | 26 | the lock relay |
| `GATE_RELAY_ACTIVE_HIGH` | 1 | **the relay module**: 1 if driving its input HIGH energises the coil |
| `GATE_UNLOCK_ENERGISES_RELAY` | 1 | **the lock's wiring**: 1 if an energised coil *releases* the lock |
| `GATE_LED_PIN` / `GATE_LED_ACTIVE_HIGH` | 27 / 1 | the lamp and its polarity |
| `GATE_UNLOCK_DEFAULT_MS` | 15000 | release time until the first heartbeat. **Was 3000** — Carl's `delay(3000)`, which is how long a lock takes to *throw*, not how long a person takes to notice a lamp go solid, move a bag and pull a door. It is only what a board runs on before the server has answered, and `gate.unlock_seconds` overrides it within [1 s, 30 s] on the first heartbeat that carries one |
| `GATE_UNLOCK_HARD_CAP_MS` | 30000 | the longest ONE release window may last. On its own this is not a bound on the DOOR — see *the hard cap is a bound on a window* below |
| `GATE_RELOCK_DWELL_MS` | 3000 | after a window the hard cap ended, the lock stays locked for at least this long and no grant may energise the relay inside it. It used to be described as "the same number as `GATE_UNLOCK_DEFAULT_MS`" and no longer is: this is a door-*closing* time, that is a door-*open* time, and fifteen seconds of this would refuse a queue of innocent members for a quarter of a minute |
| `GATE_MIN_RELOCK_MS` | 400 | the same, after ANY close: the floor that makes sure the lock is actually de-energised between two windows |
| `GATE_MAX_TOKEN_LEN` | 20 | `= roster::kMaxTokenLen`, asserted |
| `GATE_WATCHDOG_SECONDS` | 15 | task watchdog period; **asserted** to exceed one worst-case HTTP call. Was 12, when a call was two phases rather than three. |
| `HEARTBEAT_INTERVAL_MS` | 30000 | starting cadence; the tenant's is adopted |
| `ROSTER_MAX_AGE_MS` | 21600000 | 6 h, same as the court box |
| `EVENTQ_SLOTS` | 64 | offline events held before the oldest is lost |
| `FAULT_REPORT` | 1 | whether this board reports faults at all, until a heartbeat says otherwise. See *What the board says about itself* |
| `FAULT_MAX_PER_HOUR` | 20 | fault **events** per code per hour — one every three minutes per code. A fault is *counted*, never queued, so the rate bounds the reporting and not the counting |

Three more are not build flags because nothing about a door should make them
negotiable per board, and they are one budget rather than three numbers
(`lib/gatelogic/include/gatelogic/GateConfig.h`):

| Constant | Value | What it is |
|---|---|---|
| `kHttpConnectTimeoutMs` / `kHttpResponseTimeoutMs` | 4000 / 4000 | the connect and the **header** phase. The core applies them **separately** and a single call can spend both. |
| `kHttpBodyBudgetMs` | 4000 | the **body** phase, which is this firmware's own and is sampled **after** the headers return. It used to share the whole call's budget, so a slow header phase handed the body a deadline already in the past and a perfectly good roster was reported as a transport failure. |
| `kWorstBlockingCallMs` | 12000 | their sum — three phases, not two — and the spine of three guarantees: the watchdog period, the release-overrun bound, and the scanner buffer. Derived, never written out. |
| `kScannerRxBufferBytes` | 1024 | the UART receive buffer, set **before** `Serial2.begin`. The core's 256-byte default is 267 ms at 9600 baud and overruns while the loop is inside a blocking call. |

`GATE_WATCHDOG_SECONDS` is `static_assert`ed to exceed `kWorstBlockingCallMs`
plus a 2 s margin. It was 8 — exactly one worst-case call — which against an API
host that silently drops packets is a guaranteed reset loop: the board panics
before the call it is waiting on can return, boots, heartbeats, and does it
again, never loading a roster and admitting nobody.

A value outside its range is a **compile error**, not a surprise on a wall:
`GateConfig.h` `static_assert`s the pins are output-capable (GPIO 34–39 on an
ESP32 are input-only, and a relay on one of them is a lock that never opens and
a pin that reads back exactly what was written to it), that the lock does not
share a pin with the LED or the scanner, that the hard cap is inside the
contract's [1 s, 30 s], and that the token cap equals `roster::kMaxTokenLen`.

---

## The two polarity flags, and what a dead board does to the door

`GATE_RELAY_ACTIVE_HIGH` is a fact about the **relay module**. Driving its input
HIGH or LOW is what energises the coil; the cheap opto-isolated boards are
usually active LOW and Carl's is active HIGH.

`GATE_UNLOCK_ENERGISES_RELAY` is a fact about **the lock's own wiring** — which
contact of the relay the lock is fed through. Through the normally-OPEN contact,
energising the coil completes the circuit; through the normally-CLOSED contact,
energising it breaks the circuit.

They are independent, and only their composition says anything about the door.

### Truth table

| `ACTIVE_HIGH` | `UNLOCK_ENERGISES` | pin when **locked** | pin when **released** | dead or rebooting board |
|:---:|:---:|:---:|:---:|---|
| 1 | 1 | LOW | HIGH | coil de-energised → **locked** |
| 1 | 0 | HIGH | LOW | coil de-energised → **released** |
| 0 | 1 | HIGH | LOW | coil de-energised → **locked** |
| 0 | 0 | LOW | HIGH | coil de-energised → **released** |

Read the last column as: with no power, or with the board held in reset, the
relay coil is de-energised whatever the pin was doing. What the door then does is
decided by `GATE_UNLOCK_ENERGISES_RELAY` alone — **`0` means a de-energised coil
releases the door.**

The last column is **a statement about the relay module and the lock, not about
this firmware**, and nothing here can test it. It is on the go-live bench list
(§12) with a meter, and it is the reason that item exists.

A *rebooting* board is different from a dead one, and this firmware makes it the
same **from `setup()` onward**: `GateApp::beginOutputs()` is the first statement
of `setup()` and writes the LOCKED level into the pin's output register **before**
`pinMode(OUTPUT)` makes the pin drive anything, so the relay's first instruction
this firmware issues is the one that keeps the door shut. The sketch this
replaces does `pinMode` first and `digitalWrite` second, which on a board wired
`ACTIVE_HIGH=0, UNLOCK_ENERGISES=0` is a door that clicks open on every reset.

**What it cannot cover is the window before `setup()` runs.** From the reset
release until the first instruction of `setup()` — the ROM bootloader and the
second-stage loader, roughly 0.3–0.7 s — GPIO 26 is an input with no drive, and
what the relay module does with a floating input is decided by that module's own
input bias, not by anything in this repository. On Carl's board, wired
`UNLOCK_ENERGISES=1`, a floating input that the module reads as inactive leaves
the door locked; on a board wired `UNLOCK_ENERGISES=0` the same float is a door
that is open for that window. **This is a bench check, not a claim** — it is in
the go-live checklist beside the dead-board row, and it is measured with a meter
and an audible lock, not reasoned about.

### "The door is released when there is no power"

That is the owner's stated expectation, and two different failures hide inside it.
Keep them apart:

- **A power cut takes the lock's own supply with it.** What the door does then is
  decided by the **lock**, not by this board and not by either flag: a fail-safe
  lock (a magnetic lock, a fail-safe strike — held shut by current) releases; a
  fail-secure one stays shut.
- **A dead, unplugged or resetting board while the lock's supply is still up**
  de-energises the relay coil and nothing else. That is the truth table's last
  column, and `GATE_UNLOCK_ENERGISES_RELAY` alone decides it.

The polarity defaults are Carl's own sketch, which he has run on the real door:
the coil is energised to release. **The release TIME is no longer his** — his
sketch is `delay(3000)` and `GATE_UNLOCK_DEFAULT_MS` is 15 000 ms, because three
seconds is how long a strike takes to throw rather than how long a member takes
to reach a handle; the wiring is untouched and only the timing moved. **Which
lock is fitted, and which
relay contact it is fed through, are not recorded anywhere in this repository**,
so nothing here claims what that door does in either failure. It is measured on
the go-live bench (§12) with the real lock — pull the mains, then separately pull
only the board — and the answer is written down beside the owner's expectation.

The wiring is fixed. If a measurement disagrees with what the owner wants, that is
a conversation between the owner and Carl about the lock; the only thing this
repository offers is the flag, and the flag must match the wiring that exists —
setting it to describe a wiring that is not on the wall inverts the firmware's
whole idea of the door.

Firmware cannot create this property. What this firmware guarantees is only the
three things it can: the locked level is asserted before the pin drives anything,
the two flags are independent and all four combinations are tested, and this
table is true.

> **Fire egress must be mechanical and independent of this board.** A door on an
> escape route has to open from the inside by pushing it — a panic bar, a
> mechanical handle — with no power, no relay and no firmware involved. Nothing
> in this repository is a life-safety device, nothing here is rated or certified
> as one, and no combination of the flags above turns it into one. If the only
> way out of a room is through a door this board controls, the installation is
> wrong regardless of how the flags are set.

---

## How a scan is decided

**Online first.** With the radio associated and the circuit breaker closed, the
board POSTs `{"mac":…,"method":"qr","token":…}` to `/api/v1/device/gate` and obeys
the answer. Only the API knows about a booking made thirty seconds ago, a
membership suspended this morning, or a 60-second member-identification code that
was never in any roster.

**Two statuses are answers.** `200` carries the decision: `opened:true` releases
the lock for `unlock_seconds`, clamped to [1 s, hard cap]; `opened:false`
**refuses, and is never second-guessed against the roster** — falling back after
a refusal would let exactly the people the club has just barred in through a
booking nobody cancelled.

`403` is the second, and it is a refusal too: it means the club took this board
**out of service** in the admin console. A board that fell back to its roster
after a 403 would keep admitting every rostered member for the next six hours,
which is precisely what the admin pressed the button to stop. The board answers
`out_of_service`, and a 403 on **any** of the three device paths — the scan, the
heartbeat, or the event drain — commits an **empty** roster for the same reason.
All three, because the drain is often the path a board speaks on first: a club
that disables a board a second after its last heartbeat would otherwise leave it
holding a full roster for the rest of that interval.

*The residual, stated plainly, and it is narrower than it was but not closed:*
**only** a board that cannot **reach** the server never hears the 403. It keeps
admitting rostered bookings until its roster goes stale at `ROSTER_MAX_AGE_MS`,
and no firmware can close that window.

Everything else — a transport failure, 401, 404, 408, 429, any 5xx, or a 200
whose body cannot be read — says the board learned *nothing*, and the roster gets
its turn.

**A single spurious 403 costs the offline fallback one heartbeat interval.** The
roster is committed empty the moment the board hears one, and the next accepted
heartbeat refills it — so the window is one interval, **30 s at the default
cadence and up to 5 minutes** at the longest the server may push. A member
arriving inside that window with the link ALSO down is refused, which is the
price of the 403 being authoritative. Measured: 30 020 ms at a 30-second
cadence, 300 020 ms at 300.

**A 404 on `/events` keeps the event.** `devapi::react` classes a 404 as
"a 4xx this box caused — drop it", which is right for the court box and is
shared code, so the gate's drain has its own rule: on this route a 404 means the
API did not recognise this MAC because the device row was deleted in the
console, the board re-registers on its next heartbeat, and the very same event
is then accepted. Dropping the backlog would throw away an evening of door
entries to save twelve requests an hour. It is paced by the same backoff a 429
is.

**A response body that does not fit, or does not arrive, is a transport failure
— never a short body.** It is read a byte at a time into the caller's buffer
under that buffer's cap and the call's own deadline; a body longer than the
buffer is refused with nothing written rather than truncated, because
`{"opened":true,` cut after the comma is a door that opens for a body nobody
could have read. A refused or unfinished body is reported as status 0, so the
scan goes to the roster rather than to a parser holding half an object.

**And the board asks for a framing it can read.** This is round G3's critical,
and on a real board it took every door out of service. Kestrel answers every
device route `Transfer-Encoding: chunked` with **no** `Content-Length` and
**holds the socket open**, because `HTTPClient` defaults to keep-alive. The
reader consulted only `http.getSize()` — which is -1 unless there is a
Content-Length — and read until the peer closed. It never closed. Every call
spent its whole budget and returned a transport failure, so the roster never
loaded and the door refused everyone; and had the peer closed, the framing bytes
would have gone to the parser, because `5d1\r\n{"kind":"gate",…}\r\n0\r\n\r\n`
is not a document. Nothing in this repository could see it: no test here reads a
real socket.

Two halves, because a proxy that ignores the first takes every door in the club
out of service and nothing says why:

- the port asks for **HTTP/1.0** — `useHTTP10(true)` with `setReuse(false)` —
  and the same server then answers close-delimited with `Connection: close`;
- `gatelogic::readBody` takes the **framing** as an input rather than guessing
  it: known length, chunked, or until-close, derived in one place from
  `getSize()` and a collected `Transfer-Encoding` header. It **de-chunks**, and
  framing that does not parse is a reported failure rather than a salvaged half
  of a document.

The fixtures are the bytes off the wire: the 61-byte `3d\r\n…\r\n0\r\n\r\n`
gate response, a full 48-entry heartbeat as one 0x5d1 = 1489-byte chunk, both
split at every boundary, a peer that hangs up mid-chunk, and the keep-alive read
that produced the outage.

**Offline, the roster decides**, and the degraded mode is narrower than the court
box's: only a member with a rostered booking gets in. A walk-up member's
60-second code can never be in a roster, so while the link is down they go to the
desk. A roster past `ROSTER_MAX_AGE_MS` admits **nobody**, however good the match
looks; so does a board that has never had a heartbeat.

**What the board queues** is only what the API does not already know: `gate_open`
for an open it decided from its own roster, `unknown_scan` for a refusal it
decided from its own roster, and `boot`. An open the API granted is already in
the API's audit trail. None of it ever touches attendance — walking through a
door is not playing a booking.

**Repeat scans are ignored.** A scanner re-reads while a phone is held at the
window; the same token within 2 s of a *decision* for it is dropped without an
API call, an audit row or a re-armed lock. A different token is never suppressed.

**A scan while the door is already open extends the window, never shortens it** —
and no sequence of scans can set a deadline later than the hard cap measured from
the moment the door first opened.

**What that means for back-to-back scans at a 15-second door**, in the words the
programme asked for:

> A member at a 15-second door gets **one** extension from back-to-back scans and
> no more: the first scan opens the lock until t = 15 s; a second scan at
> t = 14 s carries the deadline to t = 29 s; a third arriving just before that
> gets only the ~1 s left of the 30-second cap measured from the moment the door
> **first** opened; and the scan after it is refused with `relocking`, because
> the cap-forced close owes the door `GATE_RELOCK_DWELL_MS` of dark time. At the
> old three-second default the identical rule allowed **nine** extensions
> instead of one.

That is a consequence of raising the default, not a change to the cap, and it is
the **safe** direction: the cap is what bounds the door, and a longer grant
spends more of it per scan. Nobody who scans once notices. Somebody holding a
phone at the reader reaches the cap nine times faster and then meets the dwell.

**What the deadline does not bound is when the loop next looks at it.** The lock
is taken back by the loop, and the loop can be inside a blocking HTTP call when
the deadline passes. The deadline is re-checked with a fresh clock immediately
after every call, and a pass makes at most one, so the true bound is:

> physical release ≤ granted window + `kWorstBlockingCallMs` + `kIdleDelayMs`
> — **12 010 ms** over the deadline with this image's numbers, and a worst case
> of **42.01 s** against the 30-second hard cap.

It was 8 010 ms and 38.01 s until round G3 gave the response body its own
budget. The number went **up** because the old one was measured against a call
whose body phase could be handed no time at all.

**Raising `GATE_UNLOCK_DEFAULT_MS` from 3 s to 15 s did not move the 42.01 s**,
and that is worth stating term by term rather than assuming, because it is the
first thing a reader expects to have changed:

| | term | ms |
|---|---|---|
| worst case, **any** grant | granted window, bounded by `GATE_UNLOCK_HARD_CAP_MS` | 30 000 |
| | one worst-case blocking call in flight (4 000 + 4 000 + 4 000) | 12 000 |
| | one pass tick, `kIdleDelayMs` | 10 |
| | **total** | **42 010 = 42.01 s** |
| worst case on the **default**, one grant, no re-arms | `GATE_UNLOCK_DEFAULT_MS` | 15 000 |
| | one worst-case blocking call in flight | 12 000 |
| | one pass tick | 10 |
| | **total** | **27 010 = 27.01 s** (was 15 010) |

The first table's opening term is the **cap**, which a single answer cannot
exceed and which no sequence of re-arms may pass either — the default is one of
the values that term is a bound *on*. What moved is the second: a board that has
never heard a heartbeat now holds a door for 27.01 s in the worst case rather
than 15.01 s, and after it closes the lock is genuinely dark for at least
`GATE_MIN_RELOCK_MS`, or at least `GATE_RELOCK_DWELL_MS` when the cap forced the
close. Both are pinned by
`test_config_the_worst_call_is_connect_plus_headers_plus_body`.

**And it has now been MEASURED, not only derived.** `test/e2e-device`'s `DS8`
step drives the native simulator — this firmware, over a real socket — against
a peer that accepts the connection and then never answers, presenting a second
scan a hundred and fifty milliseconds before a thirty-second release is due to
end so a call is certainly in flight when the deadline passes:

| | Derived | Measured |
|---|---|---|
| one blocking call | 12 000 ms | **4 000 ms** |
| release overrun | 12 010 ms | **3 916 ms** |
| physical release, 30 s grant | 42 010 ms | **33 916 ms** |
| longest interval with the watchdog unkicked | — | **4 001 ms** (period 15 000) |

**The bound holds and is conservative, and the reason is worth knowing: the
three phases are not all reachable in one call.** A connect that times out is
followed by no header phase and no body phase, so that call costs 4 s and
stops; a peer that answers the connect promptly spends nothing on it. The full
12 000 ms therefore needs a connect that is *slow but successful* — a SYN
retransmit completing just inside four seconds — followed by a slow header
phase and a slow body. That is a real network state, so 12 000 ms remains a
correct upper bound; it is simply not what a hung or absent host produces, and
the honest worst case against those is **about 34 seconds**.

The connect budget itself was exercised separately, against `192.0.2.1`
(TEST-NET-1, routed nowhere): **4 019 ms**, which is `kHttpConnectTimeoutMs`
plus the pass tick.

That sentence replaces "the lock can never stay released longer than the hard
cap", which was false: the loop used to check the deadline once per pass
*before* the blocking calls, so the overrun was a whole pass's worth of them.

**Its one precondition, which is the core's and not ours.** The bound assumes a
call really is bounded by `kWorstBlockingCallMs`. The connect is, and so is the
body — that phase is ours and takes an absolute deadline sampled **after the
headers return**. `HTTPClient`'s own **header** loop is not: `setTimeout` is an *inter-byte*
timeout, so a peer sending one byte every three seconds resets it forever, and
there is no way to interrupt `POST()` from here. A peer that dribbles headers
can hold one call past the bound. That case is the **watchdog's**, deliberately,
and it is why the watchdog exists rather than being belt and braces.

**So the board's true worst case is the watchdog's number, not the budgets'**
(round G4, A3). Against a peer that dribbles headers the call is unbounded by
anything in `GateConfig.h`; what ends it is `GATE_WATCHDOG_SECONDS`, which
resets the part. A door released for the full cap when that happens stays
released for the cap, plus up to the watchdog period, plus the boot that follows
— and the boot is what actually takes the lock back, because `beginOutputs()`
writes the LOCKED level into the output register before the pin ever drives.
With this image's numbers:

| | against a slow-but-answering peer | against a peer that dribbles headers |
|---|---|---|
| one blocking call | 12 000 ms | unbounded; ends at the watchdog |
| physical release, 30 s grant | **42 010 ms** | **≈ 45 500 ms** (30 000 + 15 000 + boot) |

Both are true, of different peers, and **the larger one is the number to plan a
door around**. Giving the whole call one absolute deadline would collapse the
second into the first and is not available: the ESP32 core exposes no way to
abort a `POST()` in flight. The native simulator's `SocketHttpPort` bounds its
own header read, so the measured figures above are the three-budget case and the
simulator **cannot** reproduce the watchdog one — said here rather than left for
somebody to find by comparing a transcript against a board.

### The hard cap is a bound on a window; two dwells make it a bound on the door

Round G4, finding A1. `GATE_UNLOCK_HARD_CAP_MS` bounds one release *window* two
ways — no single answer may ask for more, and no sequence of re-arms may push a
deadline past the cap measured from the moment the door first opened. Both held.
Neither bounded the **door**, because the cap closed the window and the very
next accepted scan opened a fresh one, legally.

On a board the two happen in the *same pass*: `pass()` calls `pumpLock()` out of
`afterBlocking()` and applies the decision that blocking call produced two lines
later. Measured against the compiled simulator with two alternating tokens
offered every 50 ms — which defeats the single-slot debounce — the relay went
**OFF at t=31034 ms and ON at t=31034 ms**, dark for **0 ms**, then again at
+42 ms and +45 ms, for ever. A relay de-energised for zero milliseconds was
never de-energised: the strike does not drop and the maglock keeps its armature.
The door physically never relocked, and no single request broke any rule. One
token alone was saved only by the debounce's *phase*, which is a coincidence of
cadence rather than a rule.

So a close now guarantees dark time, and a grant inside it is **refused**:

| | after | for | because |
|---|---|---|---|
| `GATE_MIN_RELOCK_MS` | any close | 400 ms | long enough for a strike to drop or a maglock to re-magnetise, short enough that a second member behind the first does not notice it |
| `GATE_RELOCK_DWELL_MS` | a close the **cap** forced | 3000 ms | that close is the board overruling somebody who has held the door open for the whole cap, and the point of overruling them is that the door shuts. Long enough for any strike or maglock to relatch and for a normal doorway's closer to swing, short enough that a legitimate member caught inside it pays one re-scan |

This row **used to justify itself as "it is `GATE_UNLOCK_DEFAULT_MS`"**, and that
justification is gone rather than quietly falsified. The default is 15 000 ms
now and this is still 3 000 ms, because the two answer different questions and
only ever looked like one number by coincidence: the default is how long a
member is given to get *through* a door, and this is how long a door somebody
has held open for the whole cap has to stay *shut*. Fifteen seconds of it would
refuse a queue of innocent members for a quarter of a minute over something one
person did, and every one of those refusals costs a denial blink and, offline, a
ring slot.

A refused scan is **answered, never swallowed**: the lamp gives the denial cue,
the decision carries the reason `relocking`, and offline it is queued as an
`unknown_scan` — never as a `gate_open` for a door that did not move. It is
refused **before the API is asked**, on the debounce's own precedent, so the
server never writes an `opened` row for an opening that did not happen and the
pass is not spent on a question whose answer cannot be acted on.

**What is NOT on the wire, said plainly.** A window the cap ended increments
`GateApp::capForcedCloses()`, which reaches the native simulator's `status` line
and the host suite and **nothing else**. There is no event kind for it and no
heartbeat field; both are wire changes needing a corpus vector and a backend
that tolerates them. The `relocking` refusals the dwell then produces *do* reach
the queue when the board is offline, so an evening of somebody holding a door
open is not invisible — but the cap itself is not a number an admin can read.
Putting it on the wire is owed.

**The release window is timed from after the call that granted it**, on every
branch. It was timed from before, which made a 2.9-second round trip on a
three-second grant a 100-millisecond relay pulse: the door did not open, and the
server logged an entry.

**At most one blocking call per pass**, with the watchdog kicked immediately
before and after each one. Three scans in the buffer are three passes' work; the
two that wait are not lost, they are still in the UART buffer ten milliseconds
later.

**The link is read before the scanner decides**, so the first scan after the
radio re-associates is decided online. Read after it, `linkUp_` was a whole pass
out of date and that scan went to the roster — which on a board whose roster is
empty or stale is a member refused at a door whose network is working.

**The member at the door wins the pass, but not forever.** The scanner is
drained first, so a scan that arrived a moment ago is decided now rather than
after a heartbeat has spent its whole timeout finding out the API is gone. A
scanner that never stops talking would otherwise win *every* pass: after four
consecutive passes in which a scan took the call with an **upload** already
waiting — a due heartbeat *or* a ready event drain — the upload goes first.

**What that costs the fifth member, as a number rather than as a word.** This
paragraph used to say the scan "waits ten milliseconds". Ten milliseconds is
what it waits when the upload returns instantly; what it can wait is one whole
blocking call plus the pass tick — `kWorstBlockingCallMs` + `kIdleDelayMs`,
**12 010 ms** with this image's numbers. Measured against an eight-second
heartbeat before the budgets changed: 8 081 ms, with the four scans ahead of it
waiting 71 ms each.

**Both uploads are bounded, not just the heartbeat.** Round G2 bounded the
heartbeat alone. Measured afterwards: with a scan offered every 210 ms for a
simulated hour the heartbeat kept its cadence — 116 calls — and the event drain
posted **nothing at all**, so a door back from a night offline spent the morning
holding entries the club never learned about while its ring overwrote its own
oldest rows. The counter is cleared by whichever upload takes the pass, and by a
link drop: four passes spent deferring an upload that could not have run are not
a debt the member on the other side of an outage owes.

**No heartbeat is attempted within 15 s of the previous attempt**, whatever
armed it. A link-up edge arms one for "now" — the heartbeat is what fills the
roster, and until it has, an offline scan is refused — which on a door at the
edge of the AP's range is one call *per pass*. Measured against the real loop
with the link toggling every pass for a simulated hour: **179 999 heartbeats**
against a cadence that says 120, an API the club would read as an attack and a
board that spends its life inside a connect. The floor bounds it at **240 an
hour**, twice the healthy cadence, and it is measured from the previous
*attempt* rather than the previous success, because a flapping radio is exactly
the case that produces failing calls. It equals `devlink::kMinHeartbeatMs`, the
shortest interval the server may push, so it can never make the board disobey a
cadence it was told to keep.

**A due heartbeat goes before the event drain**, and a drain that posts without
moving its queue backs off — 15 s, doubling to a five-minute cap, cleared the
moment the queue actually moves. Both halves exist for the same failure: the two
share the pass's one blocking call, so with the drain first an `/events` that
refused while *keeping* the head event — a 401, a 408, a 429, any 5xx, or a 200
whose `accepted_through` does not reach the head — was re-posted on every pass,
about twenty-five times a second, and the heartbeat never ran again. `begin()`
queues a `boot` event on every boot, so that was the normal path for any board
that met a rate limiter, a WAF, or a club that disabled it. Measured against the
real loop over seven simulated hours: **0 heartbeats and 630 000 event posts
before, 840 and 88 after** — and before the fix a rostered member arriving at
the end of it was **refused**, because the roster had aged out.

**A scanner overrun costs everything that was buffered when it happened, and
nothing after the next terminator.** A receive FIFO overruns when it is *full*:
what the driver keeps is the *old* bytes and what it drops is what arrived next,
so the hole is at the **tail** of about a kilobyte the loop drains sixty-four
bytes at a time. Poisoning only the line in assembly poisoned the wrong line — a
good buffered line was dropped and the holed one was handed up several passes
later as a perfectly valid token. A member re-scans; nobody else's booking opens
a door.

Two consequences of that rule, stated because both look like faults:

- **an error with an EMPTY buffer costs the NEXT line.** There is nothing
  buffered to discard, so the assembler is marked corrupt and stays that way
  until a terminator arrives — which means the next whole line a member scans is
  thrown away and they scan again. Discarding nothing instead would leave the
  far side of the hole to be assembled as a token;
- **a scanner that never sends a terminator produces nothing at all.** No token,
  no refusal, no queued event, no blink: the assembler refuses a line past the
  token cap and then waits for the terminator that ends it. A code taped over
  the window is therefore a silent door rather than a door refusing repeatedly,
  and the thing to look at is the scanner's own configuration.

---

## What the board says about itself — aggregated `fault` events

This board has **one LED and no screen**. Everything it notices about itself — a
corrupt line off the GM65, a `/gate` call that 500ed, a ring that overflowed
while the radio was away, a release time the server and the board disagree about
— used to be visible **nowhere at all**. `eventq::Kind::Fault` has existed since
the queue was written, renders as `"fault"`, and nothing ever emitted one.

**The channel is the event queue, not the heartbeat.** A fault channel carried
on the heartbeat is lost on every *missed* heartbeat, which is precisely when
faults happen: a board that cannot reach the API is a board whose faults are
about not reaching the API. The queue survives an outage and is already
deduplicated on `(TenantId, DeviceId, Seq)`.

**No new field on `eventq::Event`, and `devlink::renderEventBody` is
unchanged.** A fault reuses what is already there:

| field | carries |
|---|---|
| `kind` | `"fault"` |
| `subject` | the fault **code** |
| `duration_ms` | the **count** since the last report of that code |
| `court` | `-1` — a door is not on a court |
| `method` | `null` — a fault is not an identification |

```json
{"mac":"5ccf7f0a1b2c","boot_id":2596069104,"uptime_ms":86400000,
 "events":[{"seq":412,"uptime_ms":86390000,"kind":"fault","court":-1,
            "method":null,"subject":"scanner_uart_error","duration_ms":37}]}
```

**Aggregation IS the rate limit.** A fault is *counted*, never queued; one event
per code per window carries everything since the last one, where the window is
`3600 / device_fault_max_per_hour` seconds — three minutes per code at the
default of 20. Four hundred errors a minute cost **one event every three minutes
carrying 1200**, not four hundred events a minute carrying 1. Dropping a fault is
then impossible rather than merely unlikely: what would be dropped is a *report*,
and the number it would have carried is still in the next one. The **first**
occurrence of a code is reported at once rather than a window later — it is what
tells somebody a door has started misbehaving.

**Two bounds, because a window bounds the rate and not the variety.** At most
**8 distinct codes** are tracked at once; a ninth increments `fault_overflow`,
which is reported under its own code and has a counter of its *own* rather than
one of the eight — a board with eight live faults must still be able to say
there were more than eight. A slot is reclaimed only when it is idle **and** out
of its own window, so cycling codes cannot be used to walk out of the rate limit.

**A diagnostic never evicts an admission.** The ring fills only while the board
is offline, and offline every slot is a `gate_open` nobody else knows about — so
a fault is not queued at all while the ring is full. Nothing is lost by waiting:
the count stays in the log and goes out whole once the drain makes room.

**The vocabulary is closed**, lowercase snake, ≤ 32 characters, every code a
literal in `gatelogic/FaultLog.h`. A code that does not fit is *ignored*, never
truncated — the same rule the scanner and the roster are held to.

| code | raised when |
|---|---|
| `http_4xx` · `http_5xx` · `http_timeout` | every completed call, from one place — `GateApi::post` |
| `queue_overflow` | the ring's since-boot loss total jumped, counted as the whole jump |
| `api_breaker_open` | the breaker's closed→**open** edge. A breaker that *stays* open is still one fault |
| `heartbeat_rejected` | the heartbeat specifically was refused — this door has no roster and offline admits nobody. Distinct from the `http_4xx` the same call produced |
| `wdt_reset` | this board is in a consecutive-watchdog-reset run |
| `clock_corrected` | **shared vocabulary only — a gate never raises it.** There is no RTC on this hardware and nothing corrects a clock |
| `fault_overflow` | a ninth distinct code arrived |
| `scanner_uart_error` | a UART overrun, **or** a line corrupted by a byte outside the roster's alphabet. Both, because an overrun that ends on a terminator never produces the second and a framing error never produces the first |
| `scan_oversize` | `ScanAssembler` refused a line for being longer than the token cap — somebody presenting the wrong *kind* of code, which is answered at the desk rather than with a cable |
| `nvs_write_failed` | a `hal::IStore` write did not complete. Counted by a decorator round the port, because the queue and the store are shared with the court box |
| `unlock_clamped` | the adopted `gate.unlock_seconds` was outside [1, 30] and the board's own clamp changed it — the server and this board disagree about this door |
| `relock_overdue` | the relay was energised for longer than `kMaxPhysicalReleaseMs` (42 010 ms), which means the loop did not get back to its own lock inside the budget the release arithmetic above is built on |
| `boot_reason_<x>` | every boot, from `esp_reset_reason()`. A healthy board reports `boot_reason_power_on` — a channel that only speaks when something is wrong cannot be told apart from a channel that is broken |

**Two settings, delivered inside the heartbeat's existing `gate` object** and
adopted on exactly the rule `gate.unlock_seconds` follows — read from the
**top-level** `gate` object, clamped by the board, and an absent key or one of
the wrong JSON type leaves the working value alone:

| key | default | range |
|---|---|---|
| `device_fault_reporting` | `true` (`FAULT_REPORT`) | bool. Turning it **off clears the counts**: a count kept while off would arrive as one enormous number nobody could date |
| `device_fault_max_per_hour` | `20` (`FAULT_MAX_PER_HOUR`) | `[1, 120]`, clamped here as well as on the server |

> **The API does not send these yet, and there is deliberately no corpus
> response vector for them.** The gate corpus is pinned byte-for-byte against
> `GateHeartbeatView.Of` in the backend's `DeviceGateProtocolCorpusTests`, so a
> vector carrying keys the server does not emit would turn that test red while
> pinning bytes nobody produces — a corpus that agrees with neither side, which
> is the exact failure `make corpus-check` exists to prevent. The firmware reads
> them with a compile-time fallback, so a board deployed before the backend
> lands runs on the build flags and adopts the settings the moment they appear,
> with no flag day. **The vector is owed once the backend emits them**, in the
> `gate` object, after `unlock_seconds`.

**Where a gate-local `FaultLog` sits is a compromise, not a judgement.** By
[`../README.md`](../README.md)'s own test — *would a device with different
hardware want this unchanged* — this belongs in `shared/lib`, and the court box
is building a second copy against the same wire contract. Merging the two is
owed and is a shared-library change neither device's lane could make alone.

## What the LED means

| Pattern | Meaning |
|---|---|
| Solid | the lock is released — push the door |
| 3 fast blinks | refused |
| Slow 1 Hz blink | the radio is not associated; the board is deciding from its roster |
| Fast 4 Hz blink | the task watchdog refused to arm — a board to look at |
| 2 quick blinks | the board has just booted |

Solid beats everything: while the door is open the lamp is solid even if the WiFi
dropped a second ago, because "you may go in" is the only thing that matters to
the person in the doorway. A refusal or a boot blink beats the link blink for as
long as it lasts, then the link blink comes back. The **fault** blink beats the
link blink too — a board with no watchdog *and* no radio is a board to look at
for the first reason, and 1 Hz would hide it behind the second — but it never
beats a member-facing cue. Nothing blocks: the lamp is asked what level it
should be showing once per pass and answers from the clock.

**The fault blink does not change what the door does, in either direction.** A
board that refused to open because its watchdog would not arm would be a door
that admits nobody, which is far worse than one running on the core's own five
seconds instead of the fifteen this image asks for. The board retries three
times, then says so and
carries on.

**A board that accepted a heartbeat carrying no usable roster counts it**, and
sends the running total as `no_push` in its next heartbeat request. That case is
otherwise invisible: the roster silently does not change, its age silently keeps
running, and this lamp has nothing to say about it. A diagnostic pattern *on the
lamp* was rejected for it — this is what tells a member their scan was seen, and
a blink they cannot interpret is worse than none. A heartbeat the server
answered whose **body** never arrived whole counts too: that is exactly the case
the counter exists for, and it was the one case the counter missed.

**And a board that lost queued events says so**, as `events_lost` in the same
request. The ring holds 64 and overwrites its oldest entry when it is full, so a
door offline overnight comes back having already discarded an evening of
entries. `EventQueue.h` has promised since it was written that "an overflow is
reported, never silent" and until round G3 nothing anywhere read the counter.

Both are **totals since boot**, not deltas — the board has no way to know which
reports the server kept — and both **saturate** at 2 147 483 647 rather than
wrapping, because the API binds them as a signed 64-bit value and silently
ignores a negative or oversized one. Both are **omitted at zero**, so a healthy
board's request stays byte-identical to the contract corpus's vector.

**Where they actually go, and it is not the device row.** The server *logs* both
against the device code and stores neither — a column would be an EF migration
for a diagnostic, and the gate corpus's own vector says so. So they reach a
server log and the native simulator's transcript, and **no console anywhere
shows them**. That is still better than a counter nothing reads, which is what
`events_lost` was until round G3; it is not what this section used to claim.
Surfacing them belongs to whoever owns the admin console. The same is true of
`GateApp::capForcedCloses()` — the count of release windows the hard cap ended,
which is new in round G4 and reaches the simulator's `status` line and nothing
else.

**A refusal while the door is already released shows nothing**, and that is
intended: solid outranks the three blinks, so the second member of a pair —
refused while the first one's window is still open — sees a steady lamp. The door
is open in front of them, which is the true and more useful thing for the lamp to
be saying. It is on the go-live bench list (§12) so the person testing knows to
expect it rather than reporting it as a dead LED.

---

## Every behavioural sentence above, and the test that pins it

A sentence in this file that no test holds true is a sentence that will be wrong
within a month and nobody will notice. Every row below is checked; all the tests
are in [`test/`](test/) and run by `make test-iot`.

| Sentence | Pinned by |
|---|---|
| The truth table's four rows, both lock states | `test_lock_level_for_all_four_polarity_combinations` |
| The locked level is written before the pin drives anything | `test_lock_boot_writes_the_locked_level_before_the_pin_drives_anything` |
| The commanded level follows the wiring | `test_lock_set_drives_the_level_its_wiring_calls_for` |
| The flag defaults in this README are the ones the code carries | `test_config_defaults_are_carls_wiring` |
| The token cap equals `roster::kMaxTokenLen` | `test_config_token_cap_matches_the_roster` + `static_assert` in `GateConfig.h` |
| Online only with a link and a closed breaker | `test_flow_asks_the_api_only_with_a_link_and_a_closed_breaker` |
| A 200 refusal is never second-guessed | `test_flow_a_200_refusal_is_never_second_guessed_against_the_roster` |
| A 200 nobody can read falls back rather than refusing | `test_flow_a_malformed_200_falls_back_rather_than_refusing` |
| `unlock_seconds` is clamped to [1 s, hard cap] | `test_flow_an_open_carries_the_servers_seconds_clamped_at_both_ends` |
| A roster open releases for the unlock time, not the booking | `test_flow_a_roster_open_is_queued_and_a_roster_refusal_is_too` |
| A stale roster admits nobody | `test_flow_a_stale_roster_admits_nobody` |
| A board that never heard from the API admits nobody | `test_flow_a_gate_that_has_never_heard_from_the_api_admits_nobody` |
| Only roster decisions are queued, as `gate_open` / `unknown_scan` | `test_flow_a_roster_open_is_queued_and_a_roster_refusal_is_too`, `test_flow_a_200_refusal_is_never_second_guessed_against_the_roster` |
| Two transport failures send the next scan to the roster | `test_api_two_transport_failures_send_the_next_scan_straight_to_the_roster` |
| The scan body and path are the contract's | `test_api_a_scan_posts_the_contract_body_to_the_gate_path`, `test_every_request_vector_is_rendered_byte_for_byte` |
| The same token within 2 s of a decision is dropped | `test_debounce_suppresses_the_same_token_inside_the_window_and_not_outside_it` |
| A different token is never suppressed | `test_debounce_never_suppresses_a_different_token` |
| The window runs from the decision | `test_debounce_measures_from_the_decision_not_from_the_scan` |
| A re-arm never shortens the window | `test_unlock_a_re_arm_never_shortens_the_window` |
| No sequence of scans passes the hard cap | `test_unlock_the_hard_cap_bounds_both_one_answer_and_the_whole_window` |
| The 15 s default is only what runs until the server answers, and `gate.unlock_seconds` overrides it at both clamp bounds while an absent or wrongly-typed key leaves it alone | `test_config_the_default_is_only_what_runs_until_the_server_answers` |
| A burst of one code is ONE event carrying the count, at every clock base | `test_fault_a_burst_is_one_event_carrying_its_count_at_every_base` |
| The rendered `fault` body is the agreed wire shape | `test_fault_the_rendered_body_is_the_agreed_wire_shape` |
| A chatty code cannot starve the other seven | `test_fault_a_chatty_code_cannot_starve_the_others` |
| A ninth distinct code is counted under `fault_overflow`, which has a counter of its own | `test_fault_a_ninth_distinct_code_is_counted_under_its_own_name` |
| A slot inside its own window is never reclaimed, so cycling codes cannot escape the rate limit | `test_fault_a_slot_inside_its_own_window_is_never_reclaimed` |
| Reporting off counts nothing and forgets what it had | `test_fault_reporting_off_counts_nothing_and_forgets_what_it_had` |
| A code that does not fit the wire is refused, never truncated; the whole vocabulary fits | `test_fault_a_code_that_does_not_fit_is_refused_rather_than_truncated` |
| `device_fault_max_per_hour` is clamped at both ends by the board | `test_fault_the_rate_is_clamped_at_both_ends_by_the_board` |
| The two settings are adopted independently, clamped, and an absent or wrongly-typed key changes nothing | `test_heartbeat_adopts_the_two_fault_settings_and_clamps_them` |
| The board says when its own clamp had to change the release time | `test_heartbeat_says_when_its_own_clamp_had_to_change_the_release_time` |
| A store write that did not complete is `nvs_write_failed`; a `get` that finds nothing is not | `test_fault_a_store_write_that_did_not_complete_is_counted` |
| Every boot reports its reason, and a watchdog run is reported with it | `test_app_a_boot_reports_its_reason_and_a_watchdog_run_with_it` |
| HTTP faults are classified from what the peer actually said | `test_app_http_faults_are_classified_from_what_the_peer_actually_said` |
| A breaker that opens is one fault, not one per pass | `test_app_a_breaker_that_opens_is_one_fault_not_one_per_pass` |
| The ring's loss total is a jump, and the whole jump is counted — and a diagnostic never evicts an admission | `test_app_a_ring_that_overflowed_reports_the_whole_jump` |
| A healthy capped release is NOT `relock_overdue` | `test_app_a_release_past_the_documented_bound_is_reported` |
| A pass queues at most one fault | `test_app_a_pass_queues_at_most_one_fault` |
| The heartbeat's settings reach the log, and a board told to be quiet queues nothing | `test_app_the_heartbeat_settings_reach_the_fault_log` |
| A clamped `unlock_seconds` reaches the ring as `unlock_clamped` | `test_app_a_clamped_unlock_seconds_reaches_the_ring` |
| A refused heartbeat is its own code as well as its status; an outage is not a refusal | `test_app_a_refused_heartbeat_is_reported_as_well_as_its_status` |
| The 42.01 s / 27.01 s release arithmetic above, term by term | `test_config_the_worst_call_is_connect_plus_headers_plus_body` |
| The lock opens once and closes once | `test_unlock_opens_once_and_closes_once_at_every_clock_base` |
| CR/LF is one terminator; empty lines are ignored; lines are trimmed | `test_scan_assembles_a_line_and_treats_crlf_as_one_terminator`, `test_scan_trims_and_ignores_an_empty_line` |
| An over-long line is refused, not truncated, and costs only itself | `test_scan_refuses_a_token_one_character_over_the_cap_without_truncating` |
| A non-printable byte discards the line | `test_scan_a_non_printable_byte_discards_the_whole_line` |
| An unreadable scan is refused, and queued only while offline | `test_flow_an_unreadable_scan_is_refused_and_queued_only_while_offline` |
| Solid while released, beating everything | `test_led_is_solid_while_the_lock_is_released_whatever_else_is_happening` |
| 3 blinks on a refusal, 2 at boot | `test_led_blinks_three_times_for_a_refusal_and_twice_at_boot` |
| 1 Hz while the radio is down, dark when it is up | `test_led_blinks_slowly_while_the_radio_is_down_and_is_dark_when_it_is_up` |
| A cue beats the link blink, then gives it back | `test_led_a_cue_outranks_the_link_blink_and_then_gives_it_back` |
| The LED's own polarity flag | `test_led_level_for_both_polarities` |
| The heartbeat carries `kind:"gate"` last | `test_heartbeat_body_carries_kind_last_and_refuses_rather_than_truncating` |
| `gate.unlock_seconds` is adopted and clamped | `test_heartbeat_adopts_the_gate_objects_unlock_seconds_and_clamps_it` |
| It is read from the `gate` object, not from anywhere else | `test_heartbeat_ignores_an_unlock_seconds_outside_the_gate_object` |
| A 403 is authoritative and denies with `out_of_service` | `test_flow_a_403_denies_with_its_own_reason_and_no_roster_fallback` |
| Every status, and which two are answers | `test_flow_the_status_table_says_which_statuses_are_answers` |
| A 403 on the heartbeat commits an empty roster | `test_app_a_403_on_the_heartbeat_commits_an_empty_roster` |
| Every other status leaves the roster alone | `test_app_every_status_but_200_and_403_leaves_the_roster_alone` |
| The release window is timed from **after** the call | `test_app_a_release_is_timed_from_after_the_call_that_granted_it` |
| The debounce window is stamped from the decision | `test_app_the_debounce_window_starts_when_the_decision_was_made` |
| At most one blocking call per pass | `test_app_a_pass_makes_at_most_one_blocking_call` |
| The watchdog is kicked around every blocking call | `test_app_the_watchdog_is_kicked_around_every_blocking_call` + the `static_assert` in `GateConfig.h` |
| A dead API host never trips the watchdog or starves the lock | `test_app_a_dead_api_host_never_starves_the_watchdog_or_the_lock` |
| The 12 010 ms release-overrun bound above | `test_app_a_release_outlives_its_deadline_by_at_most_one_blocking_call`, `test_config_the_worst_call_is_connect_plus_headers_plus_body` |
| ...and the same bound MEASURED, on a real socket against a hung peer | `test/e2e-device`'s `DS8`, via `gate_sim.measure_worst_case_release` |
| Every decision reaches the log with the reason it acted on, and a board with no log decides identically | `test_app_every_decision_reaches_the_log_with_the_reason_it_acted_on`, `test_app_a_debounced_repeat_is_not_logged_as_a_decision`, `test_app_a_board_with_no_decision_log_decides_exactly_the_same` |
| A call is three phases and the watchdog exceeds their sum | `test_config_the_worst_call_is_connect_plus_headers_plus_body` + the `static_assert` in `GateConfig.h` |
| An overrun costs everything buffered, and nothing after the next terminator | `test_app_an_rx_error_discards_everything_that_was_buffered_when_it_happened` |
| Boot and a link event throw away a partial line | `test_app_boot_and_a_link_event_throw_away_a_partial_line` |
| The heartbeat interval is armed after the call | `test_app_the_heartbeat_interval_is_armed_after_the_call` |
| A cut-short heartbeat body never replaces the roster | `test_app_a_truncated_heartbeat_body_never_replaces_the_roster`, `test_apply_roster_a_truncated_body_never_replaces_the_roster` |
| A queued open carries what the lock was **given** | `test_app_a_queued_open_carries_what_the_lock_was_given` |
| An unreadable line queues on the same judgement a scan makes | `test_app_an_unreadable_line_queues_on_the_same_judgement_a_scan_makes` |
| The link is read before the scanner decides | `test_app_the_link_is_read_before_the_scanner_decides` |
| A refusing `/events` never starves the heartbeat | `test_app_a_refusing_events_endpoint_never_starves_the_heartbeat` |
| A heartbeat goes before the drain even when the drain is succeeding | `test_app_a_full_ring_draining_slowly_still_lets_the_heartbeat_through` |
| The drain's backoff, and that progress clears it | `test_app_the_event_backoff_resets_once_the_drain_moves_again` |
| An unacknowledged boot event is not a hot loop | `test_app_a_boot_event_the_server_never_acknowledges_is_not_a_hot_loop` |
| A 403 on `/events` empties the roster too | `test_app_a_403_on_events_takes_the_board_out_of_service_too` |
| A permanently busy scanner cannot starve the heartbeat | `test_app_a_permanently_busy_scanner_cannot_starve_the_heartbeat` + the `static_assert` in `GateConfig.h` |
| …nor the event drain | `test_app_a_permanently_busy_scanner_cannot_starve_the_event_drain` |
| A draining backlog still lets the member at the door through | `test_app_a_draining_backlog_still_lets_the_member_at_the_door_through` |
| A link drop clears the deferral debt | `test_app_a_link_drop_clears_the_scan_deferral_debt` |
| A flapping link buys at most one heartbeat per 15 s | `test_app_a_flapping_link_cannot_hammer_the_heartbeat`, `test_app_the_heartbeat_floor_bounds_failing_calls_too` |
| A 404 on `/events` keeps the backlog and retries it | `test_app_a_404_on_events_keeps_the_backlog_and_retries_it` |
| A body that fits arrives whole, however the TCP segments fall | `test_body_a_body_that_fits_arrives_whole_however_the_segments_fall` |
| A chunked keep-alive response is read by its framing or not at all | `test_body_a_chunked_keep_alive_capture_is_read_by_its_framing_or_not_at_all` |
| The chunk framing survives every split, including a 1489-byte chunk | `test_body_chunk_framing_survives_every_split`, `test_body_a_full_heartbeat_arrives_as_one_1489_byte_chunk` |
| Malformed chunk framing is a failure, never garbage | `test_body_malformed_chunk_framing_is_a_failure_not_garbage` |
| A chunked peer that hangs up early is not a short body | `test_body_a_chunked_peer_that_hangs_up_early_is_not_a_short_body` |
| An empty body is a whole body | `test_body_an_empty_body_is_a_whole_body` |
| The framing comes from Content-Length and Transfer-Encoding | `test_body_the_framing_comes_from_content_length_and_transfer_encoding` |
| A body over the cap is refused, never truncated | `test_body_a_body_over_the_cap_is_refused_rather_than_truncated` |
| A dribbling peer is cut off at the body phase's own deadline | `test_body_a_dribbling_peer_is_bounded_by_the_body_budget` |
| A FAILURE status survives a body that did not arrive; a 2xx does not | `test_body_a_failure_status_survives_a_body_that_did_not`, `test_app_a_403_whose_body_did_not_fit_still_takes_the_board_out_of_service` |
| The uptime an offline record goes up with is one the server can read, at every clock base | `test_app_an_offline_record_is_stamped_with_an_uptime_the_server_can_read`, `test_uptime64_low_bits_are_millis_at_every_seed`, `test_widen_cannot_underflow_when_the_stamp_is_ahead_of_the_batch` |
| The hard cap bounds the DOOR and not only a window, with two alternating tokens and one, at every base | `test_unlock_a_capped_window_is_followed_by_real_dark_time`, `test_app_two_alternating_tokens_cannot_hold_the_door_open_for_ever` |
| Every close leaves the lock genuinely de-energised, including one that closes inside the call that granted the next scan | `test_unlock_any_close_guarantees_the_lock_actually_relatches`, `test_app_a_window_that_closes_inside_the_call_that_granted_the_next_one` |
| A scan inside the dwell is refused, without asking the API and without recording an opening | `test_app_a_scan_inside_the_relock_dwell_never_reaches_the_api`, `test_app_a_scan_inside_the_relock_dwell_costs_no_call_and_records_no_opening`, and `test/e2e-device`'s `DS4b` |
| No scanned line can forge a field in either body, fuzzed | `test_render_no_scanned_line_can_forge_a_field_in_the_scan_body`, `test_render_no_scanned_subject_can_forge_a_field_in_the_event_body`, `test_the_event_body_escapes_a_subject_whatever_bytes_are_in_it` |
| A line is held to the roster's own token alphabet, exhaustively over every byte | `test_scan_refuses_every_byte_outside_the_rosters_token_alphabet` |
| A corrupt line is ANSWERED, and line noise can neither strobe the lamp nor fill the ring | `test_app_a_corrupt_line_gives_the_member_an_answer`, `test_app_line_noise_cannot_strobe_the_lamp_or_fill_the_ring` |
| `opened`, `reason` and `unlock_seconds` are read from the TOP-LEVEL object only | `test_gate_response_reads_only_the_top_level_object`, `test_gate_response_takes_its_duration_and_reason_from_the_top_level_too`, `test_top_level_readers_see_only_the_outermost_objects_members` |
| A full ring evicts refusals before admissions, keeps the order of what survives, and counts every loss | `test_queue_a_full_ring_evicts_refusals_before_it_evicts_admissions`, `test_queue_eviction_keeps_the_order_of_what_it_keeps`, `test_only_the_kinds_that_cost_nothing_to_lose_are_discardable` |
| Every batch names the boot it came from, so a renumbered board is not deduped away | `test_app_every_uploaded_batch_carries_this_boots_identity`, `test_app_two_boots_that_both_start_at_seq_one_are_told_apart`, and the API's `A_board_that_renumbered_after_a_torn_sequence_mark_is_not_deduped_away` |
| Alternating tokens cannot hammer `/gate`, and a rate-limited scan is never answered from the roster | `test_app_alternating_tokens_cannot_hammer_the_gate_endpoint`, `test_debounce_remembers_several_tokens_and_still_never_delays_a_new_one`, `test_app_a_rate_limited_scan_is_refused_rather_than_decided_from_the_roster` |
| A board the watchdog reset holds its first call back, and a healthy boot waits for nothing | `test_boot_recovery_backs_off_only_after_a_watchdog_reset`, `test_app_a_board_the_watchdog_reset_holds_its_first_call_back` |
| `no_push` and `events_lost` are sent only when there are some, and saturate | `test_heartbeat_body_carries_its_counters_only_when_there_are_some` |
| A heartbeat whose body never arrived counts as a no-push | `test_app_a_heartbeat_whose_body_never_arrived_counts_as_a_no_push` |
| Events the ring discarded reach the next heartbeat | `test_app_events_the_ring_discarded_are_reported_in_the_next_heartbeat` |
| A heartbeat that pushed no roster is counted and reported | `test_app_a_heartbeat_that_pushed_no_roster_is_counted_and_reported` |
| The 4 Hz fault blink, and that a cue still outranks it | `test_led_a_watchdog_that_would_not_arm_blinks_four_times_as_fast` |
| A refused watchdog changes nothing about the door | `test_app_a_refused_watchdog_changes_nothing_about_the_door` |
| `API_BASE_URL` is `http://` + an IPv4 literal + optional port | `test_url_accepts_only_cleartext_http_to_an_ipv4_literal` + `static_assert`s in `main.cpp` |
| `0.0.0.0` and `255.255.255.255` are refused as reserved hosts | `test_url_accepts_only_cleartext_http_to_an_ipv4_literal` + `static_assert`s in the suite |
| An unedited `secrets.h.example` does not compile, on either route | the `static_assert`s in `main.cpp`; proved by compiling the example file with `pio run -e door_gate` and `arduino-cli compile` |
| Every wire body and every response shape | `test/test_gate_corpus/` — all 15 vectors of `src/contracts/device-protocol/gate/` |

Four sentences above are **not** pinned by a test and cannot be, and are marked
as such here rather than left to look checked: what a **dead** board does to the
door and the truth table's last column (that is the relay coil and the lock, not
software); the **pre-`setup()`** window in which GPIO 26 floats (that is the
relay module's input bias); and the fire-egress paragraph (that is an
installation property). The go-live checklist carries all of them as bench
checks, §12.

---

## Flashing

**The Arduino IDE is the deployment route**, exactly as it is for the court box.
[`arduino/door_gate/`](arduino/door_gate/) is a ready-to-open sketch folder —
board *ESP32 Dev Module*, pick the port, Upload — needing no terminal, no `make`
and nothing from the Library Manager. Its own
[`arduino/README.md`](arduino/README.md) is written for the person holding the
screwdriver and carries the core version to install, the polarity truth table
and every flag in `build_config.h` that is safe to change.

That folder is **generated** and is never hand-edited: `make arduino-export`
writes it from `lib/`, `../shared/lib/`, `src/` and the `-D` flags in
[`platformio.ini`](platformio.ini) (with `build_unflags` applied, which is what
makes the sketch report **1.1.1** — the single rotating member code,
[`docs/specs/member-code.md`](../../../docs/specs/member-code.md), with every
gating window spent on the pass it ends (review round 17) — rather than
the 2.0.0 `[common]` pins for the court box), and `make arduino-check`
regenerates and fails on a diff. A hand-edit
there is deleted by the next export, not flagged.

The developer route is PlatformIO, and it is what the tests and the gates run
against:

```bash
make install-iot                 # once: creates src/iot/.venv
cp src/iot/door-gate/src/common/secrets.h.example \
   src/iot/door-gate/src/common/secrets.h
# fill in WIFI_SSID, WIFI_PASSWORD, API_BASE_URL, DEVICE_API_KEY — it is gitignored
make build-iot                   # compiles every board target, this one included
src/iot/.venv/bin/pio run -d src/iot/door-gate -e door_gate -t upload
src/iot/.venv/bin/pio device monitor -d src/iot/door-gate -e door_gate
```

Either route **refuses** without `secrets.h` and `static_assert`s on an empty
value in it. That is deliberate: an image that joins an empty SSID, or posts to
an empty base URL with an empty bearer key, looks identical to a working one
until it is screwed to a wall. Each route reads its own copy — the PlatformIO
build `src/common/secrets.h`, the sketch `arduino/door_gate/secrets.h` — and
both are gitignored.

The monitor runs at 115200 — unlike the court bridge, whose UART0 *is* its link
to the Mega. On this board UART0 is the USB console and nothing else; the scanner
is on `Serial2`.

## Layout

```
door-gate/
  platformio.ini          the wiring flags, the board pin and the host test envs
  lib/gatelogic/          every decision, pure, host-tested
    GateApp               the loop itself — one pass, over ports a fake answers
    GatePorts             watchdog, link, scanner-error and decision-log ports
    ApiBaseUrl/StaticText compile-time checks on API_BASE_URL, C++11-clean
  lib/esp32_hal/          the only place allowed to include Arduino headers
  lib/posix_gate_hal/     the SIMULATOR's drivers — never reaches a board
  src/gate/main.cpp       wiring only: construction, begin(), pass()
  src/simulator/main.cpp  the native simulator's wiring — the same two calls
  src/common/             secrets.h.example (secrets.h is gitignored)
  test/test_gatelogic/    the unit suite, including the whole loop
  test/test_gate_corpus/  all 15 contract vectors, executed and counted
```

**`main.cpp` decides nothing.** `build_src_filter = -<*>` means the host suite
cannot see it, so anything decided there is decided where nothing can check it —
and a round-G1 review found four serious defects living in it at once. The loop
is `gatelogic::GateApp` now, driven by a fake HTTP port that **advances the fake
clock**, which is the single thing that makes a stale instant expressible in a
test at all.

The device-agnostic libraries — `timebase`, `hal`, `hal_fakes`, `devcrypto`,
`fwversion`, `devapi`, `eventq`, `roster`, `devlink`, `posix_hal` — are **not**
here. They are
in [`../shared/lib`](../shared/lib) and arrive through one line of
`platformio.ini`; `roster::Roster<48>`, `devlink::parseRosterElement`,
`devlink::renderEventBody`, `devapi`'s bearer header and its heapless JSON
scanner, and `eventq` are all used unchanged. The gate's only addition to them is
`eventq::Kind::GateOpen`.

`posix_hal` is in that list because it moved there when this project grew a
simulator: a clock that can start near the `millis()` wrap, a file-backed store
and a non-blocking stdin reader are as true of a door as of a court box, and two
copies of the rollover clock would be two things that can disagree about the one
behaviour it exists to reproduce.

---

## The native simulator — the real firmware with no board

```bash
pio run -d src/iot/door-gate -e simulator      # or make build-iot
.pio/build/simulator/program --api-base http://127.0.0.1:8088 --mac 02d0deadbeef
```

`[env:simulator]` builds a host binary running **this firmware**: the same
`GateApp` loop, the same `GateApi`, the same `GateFlow` status table, the same
`ResponseBody` framing and de-chunker, the same `UnlockTimer`, `LockDriver`,
`ScanAssembler`, `ScanDebounce` and `LedPattern` — over `lib/posix_gate_hal` and
the shared `posix_hal` instead of `lib/esp32_hal`, making **real HTTP calls over
a real socket**, bounded by the same three budgets whose sum is
`kWorstBlockingCallMs`.

It exists for one reason, and it is the court box's: **a stub only ever agrees
with itself**, because both ends of the conversation get written from one reading
of the spec, so a misreading passes. `test/e2e-device/door_evening.py` had
exactly that shape — a Python script played the whole board — and the two defect
classes that hides are the two this project has already paid for: round G1's four
defects in a `loop()` no host test could see, and round G3's chunked framing that
no test in this tree read a real socket to find.

**Nothing secret and nothing per-door is compiled in.** The API base URL, the
device API key and the MAC arrive at run time from flags or from
`GATE_API_BASE` / `GATE_DEVICE_KEY` / `GATE_MAC`, and the key is never printed.
The base URL is checked at startup against the same `gatelogic::isValidApiBaseUrl`
grammar `src/gate/main.cpp` `static_assert`s, so the simulator cannot accept a URL
the firmware would refuse. Every pin, polarity and timing is `GateConfig.h`'s
default, which is Carl's value; there are no wiring flags in that environment at
all.

| Console | What it does |
|---|---|
| `scan <code>` | present a code at the reader, as a line of scanner bytes through the real `ScanAssembler` |
| `rxerror` | raise the UART's receive-error flag, as an overrun does |
| `wifi up` / `wifi down` | associate or drop the radio — the input that chooses the API or the cached roster |
| `status` | one line of everything observable, including the worst blocking call and the worst unkicked watchdog gap |
| `quit` | stop, locking the door on the way out |

Stdout carries one line per **relay** and **LED** transition with the board's own
`millis()` stamp and the electrical level, one per **decision** with the reason
the firmware acted on and what the lock was actually given, plus `[hb]`, `[evq]`,
`[link]` and a `[wdt]` line wherever a real board would have reset.

**What it does not simulate, stated rather than implied:** the WiFi radio (the
link is told, not sensed), the GM-series scanner's own UART (bytes come from a
console line, one at a time), the physical relay and lock (there is no coil, no
contact and no readback — and there is none on the real board either), the
watchdog's *reset* (it prints the breach so the transcript carries the evidence),
and NVS (the sequence high-water mark is a file, which cannot tear).

`gatelogic::IDecisionLog` is the one port that exists for this build. It is
`nullptr` on every board — there is no console on an ESP32 door gate — and it is
how a harness can assert that a given server reason produced a refusal rather
than that a relay happened not to move. It returns void, it is called last on
every decision path, and nothing in this firmware reads anything back from it.

## The rollover rule

Never compare two `millis()` readings directly. `millis()` wraps at 2^32 — about
49.7 days — and a board in an electrical cupboard is expected to run for months,
so the wrap is the normal case and not an edge case. Every duration comparison
here goes through `tb::reached()` or `tb::Deadline`, and `make lint-iot` greps
for the raw form across every project at once. Every deadline, age and debounce
test in this project runs at four clock bases, two of which put the wrap inside
the scenario.

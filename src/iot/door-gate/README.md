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
| `GATE_UNLOCK_DEFAULT_MS` | 3000 | release time until the first heartbeat |
| `GATE_UNLOCK_HARD_CAP_MS` | 30000 | the lock can never stay released longer |
| `GATE_MAX_TOKEN_LEN` | 20 | `= roster::kMaxTokenLen`, asserted |
| `GATE_WATCHDOG_SECONDS` | 12 | task watchdog period; **asserted** to exceed one worst-case HTTP call |
| `HEARTBEAT_INTERVAL_MS` | 30000 | starting cadence; the tenant's is adopted |
| `ROSTER_MAX_AGE_MS` | 21600000 | 6 h, same as the court box |
| `EVENTQ_SLOTS` | 64 | offline events held before the oldest is lost |

Three more are not build flags because nothing about a door should make them
negotiable per board, and they are one budget rather than three numbers
(`lib/gatelogic/include/gatelogic/GateConfig.h`):

| Constant | Value | What it is |
|---|---|---|
| `kHttpConnectTimeoutMs` / `kHttpResponseTimeoutMs` | 4000 / 4000 | the two halves of one blocking call. The core applies them **separately** and a single call can spend **both**. |
| `kWorstBlockingCallMs` | 8000 | their sum, and the spine of three guarantees: the watchdog period, the release-overrun bound, and the scanner buffer. Derived, never written out. |
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

The defaults are Carl's own sketch, which he has run on the real door: the coil
is energised to release, for three seconds. **Which lock is fitted, and which
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
`out_of_service`, and a 403 on the **heartbeat** commits an **empty** roster for
the same reason. *The residual, stated plainly:* a board that cannot **reach**
the server never hears the 403, and keeps admitting rostered bookings until its
roster goes stale at `ROSTER_MAX_AGE_MS`. No firmware can close that window.

Everything else — a transport failure, 401, 404, 408, 429, any 5xx, or a 200
whose body cannot be read — says the board learned *nothing*, and the roster gets
its turn.

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

**What the deadline does not bound is when the loop next looks at it.** The lock
is taken back by the loop, and the loop can be inside a blocking HTTP call when
the deadline passes. The deadline is re-checked with a fresh clock immediately
after every call, and a pass makes at most one, so the true bound is:

> physical release ≤ granted window + `kWorstBlockingCallMs` + `kIdleDelayMs`
> — **8 010 ms** over the deadline with this image's numbers, and a worst case of
> **38.01 s** against the 30-second hard cap.

That sentence replaces "the lock can never stay released longer than the hard
cap", which was false: the loop used to check the deadline once per pass
*before* the blocking calls, so the overrun was a whole pass's worth of them.

**The release window is timed from after the call that granted it**, on every
branch. It was timed from before, which made a 2.9-second round trip on a
three-second grant a 100-millisecond relay pulse: the door did not open, and the
server logged an entry.

**At most one blocking call per pass**, with the watchdog kicked immediately
before and after each one. Three scans in the buffer are three passes' work; the
two that wait are not lost, they are still in the UART buffer ten milliseconds
later.

**A scanner overrun costs its line and nothing else.** A serial FIFO overrun
drops bytes silently and what arrives afterwards is in order, printable and
short — it trims, it fits the token cap, and it is not what anybody scanned. The
UART's error callback discards the line in flight through its next terminator.

---

## What the LED means

| Pattern | Meaning |
|---|---|
| Solid | the lock is released — push the door |
| 3 fast blinks | refused |
| Slow 1 Hz blink | the radio is not associated; the board is deciding from its roster |
| 2 quick blinks | the board has just booted |

Solid beats everything: while the door is open the lamp is solid even if the WiFi
dropped a second ago, because "you may go in" is the only thing that matters to
the person in the doorway. A refusal or a boot blink beats the link blink for as
long as it lasts, then the link blink comes back. Nothing blocks: the lamp is
asked what level it should be showing once per pass and answers from the clock.

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
| Every other status falls back to the roster | `test_flow_every_status_but_200_falls_back_to_the_roster` |
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
| The 8 010 ms release-overrun bound above | `test_app_a_release_outlives_its_deadline_by_at_most_one_blocking_call` |
| A UART overrun costs its line and only its line | `test_app_an_rx_error_discards_the_line_it_holed_and_only_that_line` |
| Boot and a link event throw away a partial line | `test_app_boot_and_a_link_event_throw_away_a_partial_line` |
| The heartbeat interval is armed after the call | `test_app_the_heartbeat_interval_is_armed_after_the_call` |
| A cut-short heartbeat body never replaces the roster | `test_app_a_truncated_heartbeat_body_never_replaces_the_roster`, `test_apply_roster_a_truncated_body_never_replaces_the_roster` |
| A queued open carries what the lock was **given** | `test_app_a_queued_open_carries_what_the_lock_was_given` |
| An unreadable line queues on the same judgement a scan makes | `test_app_an_unreadable_line_queues_on_the_same_judgement_a_scan_makes` |
| `API_BASE_URL` is `http://` + an IPv4 literal + optional port | `test_url_accepts_only_cleartext_http_to_an_ipv4_literal` + `static_assert`s in `main.cpp` |
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
makes the sketch report **1.0.0** rather than the 2.0.0 `[common]` pins for the
court box), and `make arduino-check` regenerates and fails on a diff. A hand-edit
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
    GatePorts             watchdog, link and scanner-error ports
    ApiBaseUrl/StaticText compile-time checks on API_BASE_URL, C++11-clean
  lib/esp32_hal/          the only place allowed to include Arduino headers
  src/gate/main.cpp       wiring only: construction, begin(), pass()
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
`fwversion`, `devapi`, `eventq`, `roster`, `devlink` — are **not** here. They are
in [`../shared/lib`](../shared/lib) and arrive through one line of
`platformio.ini`; `roster::Roster<48>`, `devlink::parseRosterElement`,
`devlink::renderEventBody`, `devapi`'s bearer header and its heapless JSON
scanner, and `eventq` are all used unchanged. The gate's only addition to them is
`eventq::Kind::GateOpen`.

## The rollover rule

Never compare two `millis()` readings directly. `millis()` wraps at 2^32 — about
49.7 days — and a board in an electrical cupboard is expected to run for months,
so the wrap is the normal case and not an edge case. Every duration comparison
here goes through `tb::reached()` or `tb::Deadline`, and `make lint-iot` greps
for the raw form across every project at once. Every deadline, age and debounce
test in this project runs at four clock bases, two of which put the wrap inside
the scenario.

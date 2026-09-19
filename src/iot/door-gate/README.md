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
in the admin console (`gate_key`) and the board learns its name from the
heartbeat, so two doors run byte-identical images and a spare board is a spare
board rather than a board for one particular door.

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
| `GATE_WATCHDOG_SECONDS` | 8 | task watchdog period |
| `HEARTBEAT_INTERVAL_MS` | 30000 | starting cadence; the tenant's is adopted |
| `ROSTER_MAX_AGE_MS` | 21600000 | 6 h, same as the court box |
| `EVENTQ_SLOTS` | 64 | offline events held before the oldest is lost |

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

A *rebooting* board is different from a dead one, and this firmware makes it the
same: `LockDriver::begin()` writes the LOCKED level into the pin's output
register **before** `pinMode(OUTPUT)` makes the pin drive anything, so the relay's
first instruction of every boot — including the ones a watchdog reset causes at
three in the morning — is the one that keeps the door shut. The sketch this
replaces does `pinMode` first and `digitalWrite` second, which on a board wired
`ACTIVE_HIGH=0, UNLOCK_ENERGISES=0` is a door that clicks open on every reset.

### Which wiring gives "the door is released when there is no power"

The owner's stated requirement is that the door is **open when there is no
power**. That needs a **fail-safe lock** — one that is held shut by current and
releases when the current stops, such as a fail-safe electric strike or a
magnetic lock — fed through the relay's **normally-CLOSED** contact, with
`GATE_UNLOCK_ENERGISES_RELAY=0`. In that wiring the board energises the coil to
*hold the door locked* and de-energises it to release, so a power cut, a blown
fuse, a pulled plug and a board in reset all release the door.

**Carl's board is wired the other way** (`GATE_UNLOCK_ENERGISES_RELAY=1`): the
coil is energised to release, so a power cut leaves the door **locked**. That is
the default in `platformio.ini` because it is what is on the wall today, not
because it is what the owner asked for. Changing it is a lock change and a
rewire, not a flag change — flipping the flag alone, on hardware wired for `1`,
inverts the firmware's whole idea of the door.

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

**A 200 is the only answer.** `opened:true` releases the lock for
`unlock_seconds`, clamped to [1 s, hard cap]. `opened:false` **refuses, and is
never second-guessed against the roster** — falling back after a refusal would
let exactly the people the club has just barred in through a booking nobody
cancelled. Everything else — a transport failure, 401, 403, 404, 429, any 5xx, or
a 200 whose body cannot be read — says the board learned *nothing*, and the
roster gets its turn.

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
and no sequence of scans can hold the door open past the hard cap measured from
the moment it first opened.

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
| Every wire body and every response shape | `test/test_gate_corpus/` — all 14 vectors of `src/contracts/device-protocol/gate/` |

Two sentences above are **not** pinned by a test and cannot be, and are marked as
such here rather than left to look checked: what a **dead** board does to the
door (that is the relay coil and the lock, not software), and the fire-egress
paragraph (that is an installation property). The go-live checklist carries both
as bench checks.

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
  lib/esp32_hal/          the only place allowed to include Arduino headers
  src/gate/main.cpp       the only composition root
  src/common/             secrets.h.example (secrets.h is gitignored)
  test/test_gatelogic/    the unit suite
  test/test_gate_corpus/  all 14 contract vectors, executed and counted
```

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

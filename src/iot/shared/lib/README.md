# `src/iot/shared/lib` — the device-agnostic firmware modules

Every Crusaders firmware compiles these, and none of them owns any of it. A
module earns a place here when a **second, unrelated device would want it
unchanged**: rollover-safe time, the HAL ports and their recording fakes, hex,
the firmware-version string, the device API client, the event queue, the roster
cache, and the API-link logic in `devlink` — the heartbeat body and the interval
it adopts, one queued event as an upload body, the roster push out of a
heartbeat response, and the circuit breaker in front of every call.

Anything that knows about a relay, a DIP switch, a court or a particular serial
dialect belongs to the firmware project that owns that hardware — see
[`../../court-box/lib`](../../court-box/lib) for the worked contrast. "Could be
shared" is not the test; "would be correct on different hardware" is.

Everything here is **pure**: no `<Arduino.h>`, no `<WiFi.h>`, no `String`, no
heap, so the same sources compile for AVR, Xtensa and the host test runner. CI
enforces that with a grep gate covering every project's `lib/` at once, and
`../test` proves these modules on the host with no board and no firmware
attached.

**Nothing here may include a device project's headers.** The dependency only
ever points inward; where a shared constant and a device constant genuinely have
to agree, the `static_assert` lives on the device side, which knows about both.
`court-box/lib/bridgelogic/RosterTokenFits.h` is the example.

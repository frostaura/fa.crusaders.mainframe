# `src/iot/shared/lib` — the device-agnostic firmware modules

Every Crusaders firmware compiles these, and none of them owns any of it. A
module earns a place here when a **second, unrelated device would want it
unchanged**: rollover-safe time, the HAL ports and their recording fakes, hex
and the SHA-256/HMAC/base64url primitives, the firmware-version string, the
device API client, the event queue, the roster cache, `memcode` — the single
rotating member code a court box and a door both verify offline — and the
API-link logic in `devlink` — the heartbeat body and the interval it adopts, one
queued event as an upload body, the roster push and the member-code sync out of
a heartbeat response, and the circuit breaker in front of every call.

Anything that knows about a relay, a DIP switch, a court or a particular serial
dialect belongs to the firmware project that owns that hardware — see
[`../../court-box/lib`](../../court-box/lib) for the worked contrast. "Could be
shared" is not the test; "would be correct on different hardware" is.

Everything here except `posix_hal/` is **pure**: no `<Arduino.h>`, no
`<WiFi.h>`, no `String`, no heap, so the same sources compile for AVR, Xtensa
and the host test runner. CI enforces that with a grep gate covering every
project's `lib/` at once, and `../test` proves these modules on the host with no
board and no firmware attached.

## `posix_hal/` — the one host-only module, and why it is here

`posix_hal` implements the **shared** `hal/` ports — the clock, the store, the
relay, the display, the buttons, the scanner, the transport — on a POSIX host,
so a native *simulator* can run the real firmware logic with no board attached.
It is `platforms = native` in its `library.json`, so no board build ever
compiles it.

It lived in `court-box/lib` until the door gate needed a simulator too, and
three of its files — `PosixClock`, `FileStore`, `StdinLines` — are exactly as
true of a door as of a court box. Copying them would have been two
implementations of "what does the clock read at startup" that can disagree, and
the rollover behaviour is the one thing the clock exists to reproduce. So the
whole module moved here rather than half of it: everything in it implements a
port that already lives in `hal/`, and the alternative was two libraries with
one name in two `lib_extra_dirs`, which PlatformIO resolves by picking one.

**A port a device project owns cannot be implemented here.** The door gate's
own ports — `gatelogic::IPinOut`, `IHttpPort`, `IWatchdog`, `ILink`,
`IScannerBytes` — are its own, so their host implementations live in
`door-gate/lib/posix_gate_hal`, which is where the dependency is allowed to
point.

**Nothing here may include a device project's headers.** The dependency only
ever points inward; where a shared constant and a device constant genuinely have
to agree, the `static_assert` lives on the device side, which knows about both.
`court-box/lib/bridgelogic/RosterTokenFits.h` is the example.

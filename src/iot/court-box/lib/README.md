# `src/iot/court-box/lib` — the court box's own modules

Everything here is true of **this hardware**: the Mega↔ESP serial codec, the
Mega's relay and button behaviour, what a scan at a court means, and the ESP's
decisions about lighting one of four relays. A device with different hardware
would want none of it unchanged, which is exactly why it is not in
[`../../shared/lib`](../../shared/lib).

The device-agnostic modules — `timebase`, `hal`, `hal_fakes`, `devcrypto`,
`fwversion`, `devapi`, `eventq`, `roster`, `devlink` — are compiled in from
there through `lib_extra_dirs` in `platformio.ini`. An `#include` does not say
which directory a module came from, and does not need to. **`posix_hal` is one
of them now**: the simulator's host drivers moved to `../../shared/lib` when the
door gate grew a simulator of its own, because a clock that starts near the
`millis()` wrap, a file-backed store and a non-blocking stdin reader are as true
of a door as of a court box, and two copies of the rollover clock is two things
that can disagree about it. `#include "posix_hal/…"` is unchanged.

Everything here except `arduino_hal/` is **pure**: no
`<Arduino.h>`, no `<WiFi.h>`, no `String`, no heap. That is what lets the same
sources compile for the ATmega2560, the ESP8266 and the host test runner — and
it is why `pio test -e native` can prove the logic with no board attached.

CI enforces the purity rule with a grep gate, over this directory and the shared
one together. If you need hardware, take a port from `hal/` by reference and let
`main.cpp` — the only composition root — decide which implementation to hand you.

# `src/iot/door-gate/lib` — the door gate's own modules

Everything here is true of **this hardware**: which electrical level locks a
door, how long a release lasts, what a line of scanner bytes is, what the one
LED is saying, and what a `/gate` response means. A device with different
hardware would want none of it unchanged, which is exactly why it is not in
[`../../shared/lib`](../../shared/lib).

The device-agnostic modules — `timebase`, `hal`, `hal_fakes`, `devcrypto`,
`fwversion`, `devapi`, `eventq`, `roster`, `devlink` — are compiled in from
there through `lib_extra_dirs` in `platformio.ini`. An `#include` does not say
which directory a module came from, and does not need to.

| | |
|---|---|
| `gatelogic/` | Every decision. **Pure**: no `<Arduino.h>`, no `String`, no heap. |
| `esp32_hal/` | The real drivers. The only directory here allowed to include Arduino headers, and it decides nothing. |

CI enforces the purity rule with a grep gate over every project's `lib/` at once,
excluding the HAL-implementation directories by name — `arduino_hal`,
`posix_hal`, `esp32_hal`. If you need hardware, take a port by reference and let
`src/gate/main.cpp` — the only composition root — decide which implementation to
hand you.

## Two ports live here rather than in `shared/lib/hal`

`gatelogic::IPinOut` and `gatelogic::IHttpPort` look device-agnostic, and they
are not promoted for a reason. The test for `shared/lib` is not "could a second
device want this" — almost anything could — it is "**would a second device want
it unchanged**", and the only other device in this tree makes its HTTP calls with
no port at all and drives its relays through `hal::IRelayPort`, whose four
channels and single `set(channel, on)` say nothing about the level-before-mode
contract a door needs. Promoting either the day a third firmware wants exactly
this signature is one `git mv`; promoting them now would put two ports in the
shared library on the strength of one user each.

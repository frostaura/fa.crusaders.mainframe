# `src/iot/lib` — shared firmware modules

Everything here except `arduino_hal/` and `posix_hal/` is **pure**: no
`<Arduino.h>`, no `<WiFi.h>`, no `String`, no heap. That is what lets the same
object code compile for the ATmega2560, the ESP8266 and the host test runner —
and it is why `pio test -e native` can prove the logic with no board attached.

CI enforces the purity rule with a grep gate. If you need hardware, take a port
from `hal/` by reference and let `main.cpp` — the only composition root — decide
which implementation to hand you.

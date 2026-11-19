// Crusaders Mainframe — court-pi compat: the slice of the Arduino core that
// court-box/src/court_bridge/ and arduino_hal's clock, serial and store use,
// implemented on Linux.
//
// WHY A SHIM AND NOT A PORT
// -------------------------
// court_bridge/main.cpp is ~3000 lines of orchestration over bridgelogic, and
// every line of it is reviewed, versioned firmware (bridge 3.1.0). Forking it
// for the Pi would give the club two bridges that drift. Instead the Pi build
// compiles the UNCHANGED file against these headers: what the ESP8266 core gave
// it — millis(), a UART, an HTTP client, WiFi, LittleFS, RTC memory, reset
// info — is answered by Linux. The surface is exactly what the bridge calls
// and nothing more; a call the bridge starts making that this does not provide
// is a compile error on the Pi build, not a silent gap.
//
// No ESP8266 / ARDUINO_ARCH_* macro is defined: the bridge's flash-placement
// paths (FlashTable.h, Sha256.cpp) take their host branch, as in `pio test`.

#ifndef CRUSADERS_COURT_PI_COMPAT_ARDUINO_H
#define CRUSADERS_COURT_PI_COMPAT_ARDUINO_H

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "Esp.h"

uint32_t millis();
uint32_t micros();
void delay(uint32_t ms);
void delayMicroseconds(unsigned int us);
void yield();

namespace compat {
uint32_t randomWord();
} // namespace compat

/// The ESP8266's hardware RNG register. getrandom(2) on the Pi.
#define RANDOM_REG32 (compat::randomWord())

#define HIGH 0x1
#define LOW 0x0

/// The ESP's UART0 — on the Pi, the Unix socket to court-io.
class HardwareSerial {
public:
  void begin(unsigned long baud);
  size_t setRxBufferSize(size_t size);
  int available();
  int availableForWrite();
  int read();

  size_t write(uint8_t value) { return write(&value, 1U); }

  size_t write(const uint8_t* data, size_t len);

  void flush() {}

  /// The bridge never prints on its UART (it IS the Mega link); a stray debug
  /// line goes to the journal instead of into the protocol.
  size_t println(const char* text);
  size_t print(const char* text);
};

extern HardwareSerial Serial;

#endif // CRUSADERS_COURT_PI_COMPAT_ARDUINO_H

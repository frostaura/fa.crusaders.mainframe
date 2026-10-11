// Crusaders Mainframe — the wiring, written down once.
//
// WHY THE PIN NUMBERS ARE HERE AND NOWHERE ELSE
// ---------------------------------------------
// The board is already built and working. Every number below reflects a wire
// that exists; firmware adapts to the hardware, never the reverse. A pin number
// repeated in two files is a pin number that gets changed in one of them, and
// the failure that produces is a relay driving the wrong court — which looks
// exactly like a booking system bug and is not one.
//
// The court relay pins are also the mapping from `!ON,<court>` to a physical
// contact: index 0 is court A. If the panel is ever rewired, this array is the
// change, and nothing above hal/ needs to know.
//
// This directory is the only part of lib/ permitted to include Arduino headers;
// `make lint-iot` greps for the rule and excludes exactly this directory and
// posix_hal/. Note this particular file does not need any: it is numbers.

#ifndef CRUSADERS_ARDUINO_HAL_PINS_H
#define CRUSADERS_ARDUINO_HAL_PINS_H

#include <stdint.h>

#include "hal/Button.h"
#include "hal/Relay.h"

namespace arduino_hal {

/// Courts A-D. Polarity is the RELAY_ACTIVE_LOW build flag — see
/// courtRelayLevelFor() in ArduinoRelay.cpp.
inline constexpr uint8_t kRelayPins[hal::kRelayChannelCount] = {2U, 3U, 4U, 5U};

/// Courts A-D (green) then durations 1-4 (black), all INPUT_PULLUP.
inline constexpr uint8_t kButtonPins[hal::kButtonCount] = {22U, 24U, 26U, 28U, 30U, 32U, 34U, 36U};

/// The one LED on the board. Lit while a court is on, so a technician standing
/// at the cupboard can tell "the box is dead" from "the box thinks it is idle".
inline constexpr uint8_t kStatusLedPin = 13U;

/// PCF8574 backpack address. The panel fitted is a 2004A and the firmware now
/// drives all 20x4 of it; LCD_PHYSICAL_COLS/ROWS record what is soldered in and
/// LCD_COLS/ROWS what is painted, so a smaller panel swapped in degrades to a
/// smaller screen instead of to garbage. Geometry reaches code as
/// hal::kDisplayCols/Rows — the address and the bus are untouched either way,
/// because using more of a panel is not rewiring it.
inline constexpr uint8_t kLcdI2cAddress = 0x27U;

/// Both UARTs on the Mega run at 9600: the scanner module and the DIP-routed
/// link to the ESP8266. Neither can change — the scanner is configured in
/// hardware and the DIP block does not care what the firmware would prefer.
inline constexpr uint32_t kScannerBaud = 9600UL;
inline constexpr uint32_t kBridgeBaud = 9600UL;

#ifdef SCANNER_BAUD
static_assert(SCANNER_BAUD == kScannerBaud,
              "kScannerBaud and the SCANNER_BAUD build flag have drifted apart");
#endif
#ifdef BRIDGE_BAUD
static_assert(BRIDGE_BAUD == kBridgeBaud, "kBridgeBaud and the BRIDGE_BAUD build flag have drifted apart");
#endif

} // namespace arduino_hal

#endif // CRUSADERS_ARDUINO_HAL_PINS_H

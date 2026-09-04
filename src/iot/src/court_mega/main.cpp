// Crusaders Mainframe — ATmega2560 firmware: the composition root.
//
// WHAT THIS FILE IS
// -----------------
// Wiring, and nothing else. lib/README.md calls main.cpp "the only composition
// root" and that is meant literally: every decision about WHICH implementation
// of a hal/ port to use is here, and every decision about WHAT to do with them
// is in courtlogic::CourtBox, which `pio test -e native` drives with fakes and
// a clock it can park four milliseconds before the 49.7-day millis() wrap.
//
// If you are looking for the relay auto-off timer, the debounce window, the
// authorisation window or the frame dispatcher, they are in lib/courtlogic.
// None of them can be here, because src/ is filtered out of the host test build
// (build_src_filter = -<*>) and behaviour that turns a court's lights on is not
// allowed to live where no test can reach it.
//
// WHY THIS HALF EXISTS AT ALL
// ---------------------------
// The ATmega cannot be flashed over WiFi: its ESP8266 sits on Serial3, not the
// Serial0 bootloader port, and no GPIO reaches RESET. So the Mega is the
// near-static half and the ESP is the half that changes. What the Mega keeps is
// the one thing that must survive the ESP being dead: the relay deadline. In
// the system this replaces, the off command was scheduled by a VBA macro on a
// Windows PC — close the workbook mid-session and a court burned until somebody
// noticed. The timer running here, behind nothing, is the fix.
//
// WHAT THIS FIRMWARE DELIBERATELY DEFERS
// --------------------------------------
//   * Legacy-dialect emission. proto::encodeLegacy() exists and is tested, but
//     nothing here selects it. Choosing a dialect needs peer detection, and the
//     peer is an ESP running firmware from this repo — so the case only arises
//     when a v2 Mega is paired with Carl's original bridge, which is a bench
//     scenario, not an installation.
//   * Persistence. arduino_hal::EepromStore is built and compiled by this
//     environment but nothing here instantiates it: the Mega has nothing of its
//     own to remember. The device key, the API URL and the WiFi credentials all
//     belong to the ESP, which is the half that can be re-provisioned. An
//     unused store would cost SRAM on a part that has 8 KB of it.
//   * Anything that knows what a member is. Bookings, credits and the roster
//     are the ESP's, because they will change and this half cannot be updated.

#include <Arduino.h>

#include "arduino_hal/ArduinoButtons.h"
#include "arduino_hal/ArduinoClock.h"
#include "arduino_hal/ArduinoRelay.h"
#include "arduino_hal/LcdDisplay.h"
#include "arduino_hal/Pins.h"
#include "arduino_hal/SerialScanner.h"
#include "arduino_hal/SerialTransport.h"
#include "arduino_hal/Watchdog.h"
#include "courtlogic/CourtBox.h"

namespace {

// File-scope, in dependency order: the ports first, then the box that borrows
// them. None of these constructors touches hardware — every driver has a
// separate begin() — so nothing here runs before the Arduino core has brought
// up the timers that millis() counts.
arduino_hal::ArduinoRelay gRelay;
arduino_hal::LcdDisplay gDisplay;
arduino_hal::SerialScanner gScanner(Serial2);
arduino_hal::ArduinoButtons gButtons;
arduino_hal::SerialTransport gBridge(Serial3);
arduino_hal::ArduinoClock gClock;

// LegacyDialect::Refuse — the production box takes only checksummed `!` frames.
// The legacy `A` is the one message that closes a relay with no checksum, and
// this UART receives the ESP's 74880-baud boot banner at every ESP reset. The
// codec still speaks the dialect for the simulator and the bench; a real box
// does not opt in. See proto::LegacyDialect.
courtlogic::CourtBox gBox(courtlogic::CourtPorts{gRelay, gDisplay, gScanner, gButtons, gBridge, gClock},
                          proto::LegacyDialect::Refuse);

} // namespace

void setup() {
  // Relays first, before anything else can take time. begin() drives every pin
  // to the released level BEFORE configuring it as an output, because an AVR
  // output latches its power-on LOW — which on an active-LOW board is four
  // courts' lights coming on at every reset.
  gRelay.begin();

  gButtons.begin();
  gDisplay.begin();
  gScanner.begin();
  gBridge.begin();

  gBox.begin();

  // Last, once nothing above can spend tens of milliseconds in an init
  // delay(). From here on a pass of loop() that does not return within two
  // seconds is a hardware reset — which lands back at gRelay.begin() above,
  // with every contact open. That is the property this half of the box exists
  // for, and until now a wedged I2C bus under the LCD could take it away.
  arduino_hal::watchdogBegin();
}

void loop() {
  // One pass, no delay(). A blocking delay anywhere in this loop stops the
  // relay auto-off timer for its duration, which is the one thing this half of
  // the box exists to keep running. The watchdog is kicked HERE and nowhere
  // else: a driver that kicked it from inside its own spin would hide exactly
  // the stall the watchdog is for.
  arduino_hal::watchdogKick();
  gBox.poll();
}

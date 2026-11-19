// Crusaders Mainframe — the court box on a Raspberry Pi: WHICH header pin does
// what. The Pi counterpart of court-box/lib/arduino_hal/Pins.h, and like it the
// one place a pin number is written down.
//
// Numbers are BCM GPIO numbers (the kernel's line offsets on gpiochip
// "pinctrl-bcm2835" / "pinctrl-bcm2711" / "pinctrl-rp1"), with the 40-pin
// header's PHYSICAL pin beside each in the comment, because the physical pin is
// what an installer counts.
//
// WHY THESE PINS
// --------------
//   * Relays sit on GPIO 17, 27, 22, 23. Three things hold them DOWN before
//     court-io runs, and the box relies on the last one alone:
//       - the SoC's reset default (GPIO 0-8 pull up, 9-27 pull down on the
//         BCM2835/2711; the Pi 5's RP1 is not relied on for it);
//       - config.txt `gpio=17,27,22,23=ip,pd`, applied by the firmware before
//         Linux starts, on every model including the Pi 5;
//       - the external 10 k pull-down on each buffer input, which holds every
//         court DARK with the Pi off, booting, crashed or mid-watchdog-reset.
//     This replaces the Mega's "released = INPUT" rule with a resistor that
//     says the same thing.
//   * The target board is the Raspberry Pi 5 (RP1 I/O controller). Its 40-pin
//     header is pin-for-pin the Pi 4's, so this table holds for both.
//   * Nothing here touches GPIO 0/1 (HAT ID EEPROM), 2/3 (I2C1 — the LCD),
//     14/15 (UART0 — the scanner), 4 (1-wire default) or 7-11 (SPI0).
//   * Buttons use the SoC's own pull-ups, set by court-io at start; the panel
//     switches to GND exactly as on the Mega (pressed = LOW).
//
// No Linux headers here: the table is checked by a host test and by the
// static_asserts below in every build.

#ifndef CRUSADERS_LINUX_HAL_PIPINS_H
#define CRUSADERS_LINUX_HAL_PIPINS_H

#include <stdint.h>

#include "hal/Button.h"
#include "hal/Relay.h"

namespace linux_hal {

/// Courts A-D. Physical pins 11, 13, 15, 16.
inline constexpr uint8_t kRelayGpio[hal::kRelayChannelCount] = {17U, 27U, 22U, 23U};

/// Court keys A-D (green) then duration keys 15/30/45/60 (black) — the same
/// channel order as arduino_hal::kButtonPins (22..36 on the Mega).
/// Physical pins 29, 31, 33, 35 and 37, 36, 38, 40.
inline constexpr uint8_t kButtonGpio[hal::kButtonCount] = {5U, 6U, 13U, 19U, 26U, 16U, 20U, 21U};

/// The status LED (Mega pin 13): lit while any court is lit. Physical pin 18.
inline constexpr uint8_t kStatusLedGpio = 24U;

/// The physical header pin of a BCM GPIO, for log lines and the wiring sheet.
/// 0 for a number that is not on the 40-pin header.
inline constexpr uint8_t physicalPinOf(uint8_t gpio) {
  return gpio == 2U    ? 3U
         : gpio == 3U  ? 5U
         : gpio == 4U  ? 7U
         : gpio == 5U  ? 29U
         : gpio == 6U  ? 31U
         : gpio == 13U ? 33U
         : gpio == 14U ? 8U
         : gpio == 15U ? 10U
         : gpio == 16U ? 36U
         : gpio == 17U ? 11U
         : gpio == 19U ? 35U
         : gpio == 20U ? 38U
         : gpio == 21U ? 40U
         : gpio == 22U ? 15U
         : gpio == 23U ? 16U
         : gpio == 24U ? 18U
         : gpio == 25U ? 22U
         : gpio == 26U ? 37U
         : gpio == 27U ? 13U
                       : 0U;
}

/// True for a GPIO this box must never claim: ID EEPROM, I2C1, UART0, 1-wire, SPI0.
inline constexpr bool reservedGpio(uint8_t gpio) {
  return gpio <= 4U || (gpio >= 7U && gpio <= 11U) || gpio == 14U || gpio == 15U || gpio > 27U;
}

/// The SoC's reset-default pull: true when it is DOWN (GPIO 9-27).
inline constexpr bool resetPullsDown(uint8_t gpio) {
  return gpio >= 9U && gpio <= 27U;
}

// Every relay pin is pulled down from reset. Single-expression constexpr only:
// the Arduino rule (C++11-valid) does not bind this tree, but the habit costs
// nothing and keeps the table readable to the same eye.
static_assert(resetPullsDown(kRelayGpio[0]) && resetPullsDown(kRelayGpio[1]) &&
                  resetPullsDown(kRelayGpio[2]) && resetPullsDown(kRelayGpio[3]),
              "a relay GPIO the SoC does not pull down from reset can light a court while the Pi boots");
static_assert(physicalPinOf(kStatusLedGpio) != 0U && !reservedGpio(kStatusLedGpio),
              "the LED pin is not usable");

/// Default device paths. All are overridable on court-io's command line.
inline constexpr char kDefaultI2cBus[] = "/dev/i2c-1";
/// UART0 on GPIO 14/15. NOT /dev/serial0: on a Pi 5 that alias is the 3-pin
/// debug-UART connector (ttyAMA10), not the header. ttyAMA0 is GPIO 14/15 on a
/// Pi 5 with `dtparam=uart0=on` and on a Pi 3/4 with `dtoverlay=disable-bt`.
inline constexpr char kDefaultScannerTty[] = "/dev/ttyAMA0";
inline constexpr char kDefaultLinkSocket[] = "/run/court-box/link.sock";

} // namespace linux_hal

#endif // CRUSADERS_LINUX_HAL_PIPINS_H

// Crusaders Mainframe — hal::IDisplayPort on the PCF8574-backed HD44780.
//
// The panel fitted is a 2004A (20x4) at I2C 0x27, and this driver initialises
// it as hal::kDisplayCols x hal::kDisplayRows — 16x2 by decision. 16x2 renders
// correctly on either panel, so a display swapped at the club degrades to a
// smaller screen rather than to garbage on a box nobody can service quickly.
// The columns past 15 exist physically and are simply never written, which is
// why every caller repaints a full-width, space-padded row: stale characters
// out there would sit unrefreshed indefinitely.
//
// WHY NOTHING HERE WRAPS
// ----------------------
// On an HD44780 the DDRAM rows are not contiguous in the order a human expects:
// line 1 continues into line 3 and line 2 into line 4. Text running off the
// right of line 1 reappears in the MIDDLE of line 3. There is no wrapping worth
// having, so print() stops at the last column exactly as the port promises.
//
// WHY THE BUS HAS A TIMEOUT, AND WHAT A TIMEOUT DOES
// -------------------------------------------------
// Every character is ~6 synchronous `Wire` transactions and the pinned core
// ships with its bus timeout disabled, so a PCF8574 transaction corrupted by a
// relay-coil transient could spin forever inside loop() — with a court lit and
// the auto-off timer behind the spin. begin() arms the core's per-transaction
// timeout with reset-on-timeout, so one wedge costs ~25 ms. After a timeout the
// rest of the write is abandoned and the next writes are skipped for a while
// (courtlogic::DisplayHoldoff, which is pure and host-tested); the panel is
// then tried again, because a transient is transient. The relay timer never
// waits on the glass.
//
// Compiled only for the Mega. The ESP8266 has no I2C peripheral on this board
// and LiquidCrystal_I2C is not one of court_bridge's dependencies, so the guard
// is what keeps the bridge build from needing a library it has no display for.

#ifndef CRUSADERS_ARDUINO_HAL_LCDDISPLAY_H
#define CRUSADERS_ARDUINO_HAL_LCDDISPLAY_H

#ifdef TARGET_COURT_MEGA

#include <LiquidCrystal_I2C.h>

#include <stdint.h>

#include "hal/Display.h"

#include "courtlogic/DisplayHoldoff.h"

namespace arduino_hal {

/// Per-transaction I2C timeout. Long enough for a healthy PCF8574 at 100 kHz
/// by two orders of magnitude; short enough that an abandoned write is a blink,
/// not a stall the watchdog notices.
inline constexpr uint32_t kWireTimeoutMicros = 25000UL;

class LcdDisplay final : public hal::IDisplayPort {
public:
  LcdDisplay();

  /// Initialise the panel and switch the backlight on. Call once, from setup().
  void begin();

  void clear() override;

  void print(uint8_t row, uint8_t col, const char* text) override;

  /// Bus timeouts since boot, for the diagnostics the Mega has nowhere to send.
  uint16_t busTimeouts() const { return holdoff_.timeouts(); }

private:
  /// True when the bus timed out since the flag was last cleared. Clears it.
  static bool busTimedOut();

  LiquidCrystal_I2C lcd_;
  courtlogic::DisplayHoldoff holdoff_;
};

} // namespace arduino_hal

#endif // TARGET_COURT_MEGA

#endif // CRUSADERS_ARDUINO_HAL_LCDDISPLAY_H

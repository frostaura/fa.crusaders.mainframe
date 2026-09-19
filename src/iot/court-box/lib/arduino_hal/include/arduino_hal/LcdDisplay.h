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
// THE TIMEOUT BOUNDS THE STALL. IT DOES NOT RECOVER THE DISPLAY.
// -------------------------------------------------------------
// This header used to stop at the paragraph above, and that was a promise the
// code did not keep (review 3, finding 12). An abandoned write can take an En
// edge with it, and the HD44780 then pairs every later nibble with the wrong
// partner — every screen after it is garbage on a bus that is now healthy.
// `Wire`'s reset-on-timeout re-initialises the MASTER and clocks nothing, so it
// also cannot free a slave that is holding SDA low mid-byte. So the first write
// allowed after a holdoff run (courtlogic::DisplayHoldoff::takeResync) does
// both: up to nine bit-banged SCL clocks and a STOP while SDA reads low, then
// Wire.begin() with the timeout re-armed, then the 4-bit reset sequence with
// the datasheet's own ~10 ms of timing rather than the library's 1.05 s of
// power-on waits — comfortably inside the watchdog's two seconds.
//
// WHAT IS STILL OUT OF REACH: whether a PCF8574 on THIS backpack actually holds
// SDA across a Mega-only reset, and how often a coil transient desynchronises a
// nibble in practice. Software bounds the damage; only the bench measures the
// rate.
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
  ///
  /// Brings the bus up and arms its timeout BEFORE touching the panel: the
  /// library's own init() is over a second of synchronous Wire traffic, and
  /// with the timeout still disabled a held-low SDA hung setup() forever.
  void begin();

  void clear() override;

  void print(uint8_t row, uint8_t col, const char* text) override;

  /// Bus timeouts since boot, for the diagnostics the Mega has nowhere to send.
  uint16_t busTimeouts() const { return holdoff_.timeouts(); }

private:
  /// True when the bus timed out since the flag was last cleared. Clears it.
  static bool busTimedOut();

  /// True when the write about to start may proceed. Performs the bounded
  /// re-sync first when the holdoff says one is owed.
  bool ready();

  /// Frees the bus and re-establishes the controller's nibble phase. Bounded,
  /// ~10 ms, no 1 s power-on delays.
  void resync();

  LiquidCrystal_I2C lcd_;
  courtlogic::DisplayHoldoff holdoff_;
};

} // namespace arduino_hal

#endif // TARGET_COURT_MEGA

#endif // CRUSADERS_ARDUINO_HAL_LCDDISPLAY_H

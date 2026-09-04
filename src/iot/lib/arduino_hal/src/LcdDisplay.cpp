// The LCD driver. See include/arduino_hal/LcdDisplay.h.

#include "arduino_hal/LcdDisplay.h"

#ifdef TARGET_COURT_MEGA

#include <Arduino.h>
#include <Wire.h>

#include "arduino_hal/Pins.h"

// The pinned core (framework-arduino-avr 5.2.0) has Wire::setWireTimeout(). It
// exposes no feature macro, so the guard against a core that lacks it is the
// call itself: a core without the method does not compile this file, which is
// the right outcome — the alternative is silently rebuilding the driver that
// spins forever on a wedged bus.

namespace arduino_hal {

LcdDisplay::LcdDisplay() : lcd_(kLcdI2cAddress, hal::kDisplayCols, hal::kDisplayRows), holdoff_() {
}

void LcdDisplay::begin() {
  // The library's init() calls Wire.begin() itself; the timeout is set after it
  // so the library cannot re-initialise the peripheral over the setting.
  lcd_.init();
  Wire.setWireTimeout(kWireTimeoutMicros, true);
  static_cast<void>(busTimedOut());
  lcd_.backlight();
  lcd_.clear();
}

bool LcdDisplay::busTimedOut() {
  if (!Wire.getWireTimeoutFlag()) {
    return false;
  }
  Wire.clearWireTimeoutFlag();
  return true;
}

void LcdDisplay::clear() {
  if (!holdoff_.allow()) {
    return;
  }
  lcd_.clear();
  if (busTimedOut()) {
    holdoff_.noteTimeout();
  }
}

void LcdDisplay::print(uint8_t row, uint8_t col, const char* text) {
  if (row >= hal::kDisplayRows || col >= hal::kDisplayCols || text == nullptr) {
    // A partially rendered screen on the wrong line is worse than a missing
    // line: the operator reads whatever is on the glass as current.
    return;
  }
  if (!holdoff_.allow()) {
    return;
  }
  lcd_.setCursor(col, row);
  if (busTimedOut()) {
    holdoff_.noteTimeout();
    return;
  }
  uint8_t c = col;
  for (uint16_t i = 0U; text[i] != '\0' && c < hal::kDisplayCols; ++i) {
    lcd_.write(static_cast<uint8_t>(text[i]));
    if (busTimedOut()) {
      // Abandon the row. Each remaining character would be another bounded
      // stall, and sixteen of them add up to more than the watchdog allows.
      holdoff_.noteTimeout();
      return;
    }
    ++c;
  }
}

} // namespace arduino_hal

#endif // TARGET_COURT_MEGA

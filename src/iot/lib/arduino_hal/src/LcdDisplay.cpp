// The LCD driver. See include/arduino_hal/LcdDisplay.h.

#include "arduino_hal/LcdDisplay.h"

#ifdef TARGET_COURT_MEGA

#include <Arduino.h>

#include "arduino_hal/Pins.h"

namespace arduino_hal {

LcdDisplay::LcdDisplay() : lcd_(kLcdI2cAddress, hal::kDisplayCols, hal::kDisplayRows) {
}

void LcdDisplay::begin() {
  lcd_.init();
  lcd_.backlight();
  lcd_.clear();
}

void LcdDisplay::clear() {
  lcd_.clear();
}

void LcdDisplay::print(uint8_t row, uint8_t col, const char* text) {
  if (row >= hal::kDisplayRows || col >= hal::kDisplayCols || text == nullptr) {
    // A partially rendered screen on the wrong line is worse than a missing
    // line: the operator reads whatever is on the glass as current.
    return;
  }
  lcd_.setCursor(col, row);
  uint8_t c = col;
  for (uint16_t i = 0U; text[i] != '\0' && c < hal::kDisplayCols; ++i) {
    lcd_.write(static_cast<uint8_t>(text[i]));
    ++c;
  }
}

} // namespace arduino_hal

#endif // TARGET_COURT_MEGA

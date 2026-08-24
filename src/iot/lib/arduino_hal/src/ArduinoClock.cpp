// millis() behind hal::IClock. See include/arduino_hal/ArduinoClock.h.

#include "arduino_hal/ArduinoClock.h"

#include <Arduino.h>

namespace arduino_hal {

uint32_t ArduinoClock::nowMs() {
  return millis();
}

} // namespace arduino_hal

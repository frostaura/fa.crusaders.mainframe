// Crusaders Mainframe — hal::IClock on millis().
//
// Nothing here wraps or corrects anything: millis() rolls over at 2^32 and this
// port hands that value up unaltered, because tb::reached() and tb::Deadline
// are correct across the wrap and a second correction layer here would be a
// second implementation that can disagree with them.
//
// There is deliberately no delay() anywhere in this directory. A blocking delay
// stops the relay auto-off timer, the scanner drain and the bridge link for its
// duration, and the auto-off timer is the one safety mechanism that still works
// when the ESP, the WiFi and the backend are all gone.

#ifndef CRUSADERS_ARDUINO_HAL_ARDUINOCLOCK_H
#define CRUSADERS_ARDUINO_HAL_ARDUINOCLOCK_H

#include <stdint.h>

#include "hal/Clock.h"

namespace arduino_hal {

class ArduinoClock final : public hal::IClock {
public:
  uint32_t nowMs() override;
};

} // namespace arduino_hal

#endif // CRUSADERS_ARDUINO_HAL_ARDUINOCLOCK_H

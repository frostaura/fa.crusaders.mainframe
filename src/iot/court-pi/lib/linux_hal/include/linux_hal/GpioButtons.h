// Crusaders Mainframe — the eight-button panel on Raspberry Pi GPIO.
//
// The Pi counterpart of arduino_hal::ArduinoButtons: SoC pull-ups, switch to
// GND, pressed = LOW. Debouncing is NOT here — it is courtlogic::ButtonPanel's,
// unchanged, exactly as on the Mega.
//
// All eight lines are read in one ioctl and the snapshot is reused for 1 ms, so
// one pass of CourtBox::poll() sees one consistent panel for one syscall.

#ifndef CRUSADERS_LINUX_HAL_GPIOBUTTONS_H
#define CRUSADERS_LINUX_HAL_GPIOBUTTONS_H

#include <stdint.h>

#include "hal/Button.h"
#include "hal/Clock.h"

#include "linux_hal/GpioChip.h"

namespace linux_hal {

class GpioButtons final : public hal::IButtonPort {
public:
  explicit GpioButtons(hal::IClock& clock) : clock_(clock) {}

  bool begin(int chipFd);
  hal::PinLevel read(uint8_t channel) override;

private:
  hal::IClock& clock_;
  GpioInputs lines_;
  uint64_t bits_ = ~0ULL; // all released until the first read
  uint32_t readAtMs_ = 0U;
  bool haveRead_ = false;
};

} // namespace linux_hal

#endif // CRUSADERS_LINUX_HAL_GPIOBUTTONS_H

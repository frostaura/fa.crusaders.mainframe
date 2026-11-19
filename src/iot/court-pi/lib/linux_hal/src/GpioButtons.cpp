#include "linux_hal/GpioButtons.h"

#include "linux_hal/PiPins.h"
#include "timebase/TimeBase.h"

namespace linux_hal {

bool GpioButtons::begin(int chipFd) {
  return lines_.request(chipFd, kButtonGpio, hal::kButtonCount, Bias::PullUp, "court-buttons");
}

hal::PinLevel GpioButtons::read(uint8_t channel) {
  if (channel >= hal::kButtonCount) {
    return hal::kButtonReleasedLevel;
  }
  const uint32_t now = clock_.nowMs();
  if (!haveRead_ || tb::since(now, readAtMs_) >= 1U) {
    uint64_t bits = 0U;
    if (lines_.read(bits)) {
      bits_ = bits;
    } else {
      bits_ = ~0ULL; // a panel that cannot be read is a panel nobody is pressing
    }
    readAtMs_ = now;
    haveRead_ = true;
  }
  return ((bits_ >> channel) & 1ULL) != 0U ? hal::PinLevel::kHigh : hal::PinLevel::kLow;
}

} // namespace linux_hal

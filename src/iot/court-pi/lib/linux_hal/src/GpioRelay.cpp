#include "linux_hal/GpioRelay.h"

#include "linux_hal/PiPins.h"

namespace linux_hal {

GpioRelay::GpioRelay(hal::RelayPolarity bootPolarity) : polarity_(bootPolarity) {
}

bool GpioRelay::begin(int chipFd) {
  bool ok = true;
  for (uint8_t i = 0U; i < hal::kRelayChannelCount; ++i) {
    // Input with bias DISABLED: the external pull-down decides, exactly as the
    // Mega's high-Z release left it to the module.
    ok = lines_[i].requestInput(chipFd, kRelayGpio[i], Bias::Disabled, "court-relay") && ok;
    state_[i] = false;
  }
  ok = led_.requestInput(chipFd, kStatusLedGpio, Bias::Disabled, "court-led") && led_.makeOutput(false) && ok;
  return ok;
}

void GpioRelay::drive(uint8_t channel, bool on) {
  const hal::PinDrive d = hal::relayDriveFor(on, polarity_);
  const bool ok = d == hal::PinDrive::kInput ? lines_[channel].makeInput(Bias::Disabled)
                                             : lines_[channel].makeOutput(d == hal::PinDrive::kHigh);
  if (!ok) {
    ++driveFailures_;
    if (!on) {
      // A release the kernel refused: drive the OFF level rather than leave the
      // line where it was. Off is off whichever way it is reached.
      static_cast<void>(
          lines_[channel].makeOutput(hal::relayLevelFor(false, polarity_) == hal::PinLevel::kHigh));
    }
  }
}

void GpioRelay::set(uint8_t channel, bool on) {
  if (channel >= hal::kRelayChannelCount) {
    return; // ignored, never clamped — see ArduinoRelay::set
  }
  state_[channel] = on;
  drive(channel, on);
  bool any = false;
  for (uint8_t i = 0U; i < hal::kRelayChannelCount; ++i) {
    any = any || state_[i];
  }
  static_cast<void>(led_.setValue(any));
}

bool GpioRelay::isOn(uint8_t channel) const {
  return channel < hal::kRelayChannelCount && state_[channel];
}

void GpioRelay::allOff() {
  for (uint8_t i = 0U; i < hal::kRelayChannelCount; ++i) {
    set(i, false);
  }
}

void GpioRelay::setPolarity(hal::RelayPolarity polarity) {
  if (polarity == polarity_) {
    return;
  }
  polarity_ = polarity;
  for (uint8_t i = 0U; i < hal::kRelayChannelCount; ++i) {
    if (state_[i]) {
      drive(i, true);
    }
  }
}

bool GpioRelay::releaseAll(int chipFd) {
  bool ok = true;
  for (uint8_t i = 0U; i < hal::kRelayChannelCount; ++i) {
    GpioLine line;
    ok = line.requestInput(chipFd, kRelayGpio[i], Bias::Disabled, "court-release") && ok;
  }
  GpioLine led;
  ok = led.requestInput(chipFd, kStatusLedGpio, Bias::Disabled, "court-release") && ok;
  return ok;
}

} // namespace linux_hal

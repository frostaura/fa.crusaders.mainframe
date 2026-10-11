// The console relay. See include/posix_hal/ConsoleRelay.h.

#include "posix_hal/ConsoleRelay.h"

#include <stdio.h>

namespace posix_hal {

ConsoleRelay::ConsoleRelay(hal::RelayPolarity polarity) : polarity_(polarity), state_() {
  for (uint8_t i = 0U; i < hal::kRelayChannelCount; ++i) {
    state_[i] = false;
  }
}

void ConsoleRelay::set(uint8_t channel, bool on) {
  if (channel >= hal::kRelayChannelCount) {
    // Ignored, never clamped, for the same reason as the real driver: on
    // hardware, clamping drives a real and wrong court.
    return;
  }
  if (state_[channel] == on) {
    return;
  }
  state_[channel] = on;
  printf("[relay] court %c %s (pin level %s)\n", static_cast<char>('A' + channel), on ? "ON " : "OFF",
         hal::relayLevelFor(on, polarity_) == hal::PinLevel::kLow ? "LOW" : "HIGH");
  static_cast<void>(fflush(stdout));
}

bool ConsoleRelay::isOn(uint8_t channel) const {
  return channel < hal::kRelayChannelCount && state_[channel];
}

void ConsoleRelay::allOff() {
  for (uint8_t i = 0U; i < hal::kRelayChannelCount; ++i) {
    set(i, false);
  }
}

} // namespace posix_hal

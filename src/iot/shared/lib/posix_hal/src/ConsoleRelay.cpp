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
  print(channel);
}

void ConsoleRelay::print(uint8_t channel) const {
  // A released relay is an input (Mega 3.0.0, HW-1), never a driven level.
  const hal::PinDrive drive = hal::relayDriveFor(state_[channel], polarity_);
  printf("[relay] court %c %s (%s)\n", static_cast<char>('A' + channel), state_[channel] ? "ON " : "OFF",
         drive == hal::PinDrive::kInput ? "pin input" : (drive == hal::PinDrive::kLow ? "pin level LOW" : "pin level HIGH"));
  static_cast<void>(fflush(stdout));
}

void ConsoleRelay::setPolarity(hal::RelayPolarity polarity) {
  if (polarity == polarity_) {
    return;
  }
  polarity_ = polarity;
  for (uint8_t i = 0U; i < hal::kRelayChannelCount; ++i) {
    if (state_[i]) {
      print(i);
    }
  }
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

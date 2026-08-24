// The console button panel. See include/posix_hal/ConsoleButtons.h.

#include "posix_hal/ConsoleButtons.h"

namespace posix_hal {

ConsoleButtons::ConsoleButtons(hal::IClock& clock) : clock_(clock), held_() {
}

hal::PinLevel ConsoleButtons::read(uint8_t channel) {
  if (channel >= hal::kButtonCount) {
    return hal::kButtonReleasedLevel;
  }
  tb::Deadline& hold = held_[channel];
  if (!hold.isArmed()) {
    return hal::kButtonReleasedLevel;
  }
  if (hold.expired(clock_.nowMs())) {
    hold.disarm();
    return hal::kButtonReleasedLevel;
  }
  // INPUT_PULLUP on the real panel: pressed is LOW. Read out of hal/Button.h
  // rather than written again, so the simulator and the board cannot disagree
  // about which level means pressed.
  return hal::kButtonPressedLevel;
}

void ConsoleButtons::press(uint8_t channel) {
  if (channel >= hal::kButtonCount) {
    return;
  }
  held_[channel].arm(clock_.nowMs(), kSyntheticPressMs);
}

} // namespace posix_hal

// Crusaders Mainframe — hal::IButtonPort driven from the simulator's console.
//
// WHY A PRESS IS HELD FOR A DURATION RATHER THAN TOGGLED
// ------------------------------------------------------
// The rule above this port is that a level has to hold for 80 ms to count. A
// console command that simply flipped a level would either have to be followed
// by a second command to release it — leaving a stuck button if the operator
// forgot — or would flip back immediately and never survive the debounce. So a
// press arms a deadline and the port reads LOW until it passes, which is what a
// finger on a switch actually does.
//
// The hold is deliberately several times the debounce window: a simulator loop
// that is momentarily busy must not lose a press that a real 200 ms press would
// have registered.
//
// This port takes the clock by reference, unlike its hardware counterpart. That
// is not an inconsistency to tidy away — a real switch's timing is in the
// operator's hand and needs no clock; a synthesised one has to keep time itself.

#ifndef CRUSADERS_POSIX_HAL_CONSOLEBUTTONS_H
#define CRUSADERS_POSIX_HAL_CONSOLEBUTTONS_H

#include <stdint.h>

#include "hal/Button.h"
#include "hal/Clock.h"
#include "hal/PinLevel.h"

#include "timebase/TimeBase.h"

namespace posix_hal {

/// How long a synthesised press stays down. Well past the 80 ms debounce.
inline constexpr uint32_t kSyntheticPressMs = 250U;

class ConsoleButtons final : public hal::IButtonPort {
public:
  explicit ConsoleButtons(hal::IClock& clock);

  hal::PinLevel read(uint8_t channel) override;

  /// Hold `channel` down for kSyntheticPressMs. Out-of-range is ignored: a
  /// phantom press starts a court and spends a member's credits.
  void press(uint8_t channel);

private:
  hal::IClock& clock_;
  tb::Deadline held_[hal::kButtonCount];
};

} // namespace posix_hal

#endif // CRUSADERS_POSIX_HAL_CONSOLEBUTTONS_H

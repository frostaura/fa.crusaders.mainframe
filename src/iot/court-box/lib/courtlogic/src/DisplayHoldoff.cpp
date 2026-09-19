#include "courtlogic/DisplayHoldoff.h"

namespace courtlogic {

bool DisplayHoldoff::allow() {
  if (remaining_ == 0U) {
    return true;
  }
  --remaining_;
  return false;
}

void DisplayHoldoff::noteTimeout() {
  remaining_ = kHoldoffWrites;
  // The abandoned write may have taken an En edge with it, and a
  // nibble-desynchronised HD44780 renders every later character as garbage. The
  // next write that is allowed through has to reset the controller first.
  resync_ = true;
  if (timeouts_ < UINT16_MAX) {
    ++timeouts_;
  }
}

bool DisplayHoldoff::takeResync() {
  if (!resync_) {
    return false;
  }
  resync_ = false;
  return true;
}

} // namespace courtlogic

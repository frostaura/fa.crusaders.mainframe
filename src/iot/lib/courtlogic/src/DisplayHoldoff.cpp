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
  if (timeouts_ < UINT16_MAX) {
    ++timeouts_;
  }
}

} // namespace courtlogic

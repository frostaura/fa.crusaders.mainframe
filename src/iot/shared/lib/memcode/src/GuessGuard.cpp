#include "memcode/GuessGuard.h"

namespace memcode {

void GuessGuard::failed(uint32_t nowMs) {
  if (!window_.isArmed() || window_.expired(nowMs)) {
    window_.arm(nowMs, kGuessWindowMs);
    failures_ = 0U;
  }
  ++failures_;
  if (failures_ < kGuessFailures) {
    return;
  }
  lockedUntil_.arm(nowMs, lockMs_);
  lockMs_ = lockMs_ >= kGuessLockMaxMs / 2U ? kGuessLockMaxMs : lockMs_ * 2U;
  failures_ = 0U;
  window_.disarm();
}

void GuessGuard::succeeded() {
  failures_ = 0U;
  lockMs_ = kGuessLockBaseMs;
  window_.disarm();
  lockedUntil_.disarm();
}

} // namespace memcode

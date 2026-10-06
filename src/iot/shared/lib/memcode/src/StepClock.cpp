#include "memcode/StepClock.h"

namespace memcode {

bool StepClock::sync(uint32_t step, uint32_t stepMs, uint32_t nowMs) {
  if (stepMs >= kStepMs) {
    return false;
  }
  step_ = step;
  stepMs_ = stepMs;
  anchorMs_ = nowMs;
  synced_ = true;
  agedOut_ = false;
  return true;
}

uint32_t StepClock::ageMs(uint32_t nowMs) const {
  return synced_ ? tb::since(nowMs, anchorMs_) : 0U;
}

void StepClock::observe(uint32_t nowMs) {
  if (synced_ && tb::since(nowMs, anchorMs_) > maxAgeMs_) {
    agedOut_ = true;
  }
}

bool StepClock::trusted(uint32_t nowMs) const {
  return synced_ && !agedOut_ && ageMs(nowMs) <= maxAgeMs_;
}

uint32_t StepClock::stepAt(uint32_t nowMs) const {
  if (!trusted(nowMs)) {
    return 0U;
  }
  // 64-bit, so the phase plus a maximum-age elapsed time cannot wrap whatever
  // maxAgeMs a caller configures.
  const uint64_t elapsed = static_cast<uint64_t>(stepMs_) + static_cast<uint64_t>(ageMs(nowMs));
  return step_ + static_cast<uint32_t>(elapsed / kStepMs);
}

} // namespace memcode

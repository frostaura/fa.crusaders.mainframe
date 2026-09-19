#include "gatelogic/LedPattern.h"

namespace gatelogic {

void LedPattern::cue(LedCue which, uint32_t nowMs) {
  switch (which) {
  case LedCue::Boot:
    cueHalfMs_ = kBootHalfMs;
    cueHalves_ = static_cast<uint8_t>(kBootBlinks * 2U);
    break;
  case LedCue::Denied:
    cueHalfMs_ = kDeniedHalfMs;
    cueHalves_ = static_cast<uint8_t>(kDeniedBlinks * 2U);
    break;
  }
  cueStartedAtMs_ = nowMs;
  cueActive_ = true;
}

bool LedPattern::on(uint32_t nowMs) const {
  // Released wins outright. Somebody is pushing the door.
  if (released_) {
    return true;
  }

  if (cueActive_) {
    // tb::since, never a subtraction of two clock readings: a cue started four
    // milliseconds before the 49.7-day wrap would otherwise run for seven weeks.
    const uint32_t elapsed = tb::since(nowMs, cueStartedAtMs_);
    const uint32_t total = cueHalfMs_ * static_cast<uint32_t>(cueHalves_);
    if (elapsed < total) {
      // Even half-period on, odd off, so a pattern always STARTS lit — a
      // refusal whose first half were dark would be invisible to somebody who
      // glanced away for a moment.
      return ((elapsed / cueHalfMs_) % 2U) == 0U;
    }
    // Expired. Not cleared here: this function is const and a caller sampling
    // it twice must get the same answer both times. The state falls through to
    // the link blink below, which is where it belongs once the cue is over.
  }

  if (!linkUp_) {
    // Free-running off the raw clock rather than off a stored mark: there is no
    // start instant for "the WiFi is still down", and a mark would be one more
    // thing to keep rollover-safe for no gain. At the wrap the lamp holds one
    // half-period longer than it should, once every 49.7 days, which is not a
    // fact about a door anybody can observe.
    return ((nowMs / kLinkDownHalfMs) % 2U) == 0U;
  }

  return false;
}

} // namespace gatelogic

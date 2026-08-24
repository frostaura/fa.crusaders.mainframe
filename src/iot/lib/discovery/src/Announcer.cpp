// Announce scheduling. See include/discovery/Announcer.h.

#include "discovery/Announcer.h"

namespace discovery {

Announcer::Announcer() : next_(), state_(State::Unclaimed), announces_(0) {
}

void Announcer::linkUp(uint32_t nowMs) {
  if (state_ == State::Unclaimed) {
    state_ = State::Announcing;
  }
  // Zero delay rather than a "dueNow" flag: tb::Deadline already answers "has
  // this moment arrived", and a second mechanism meaning the same thing is a
  // second mechanism that can disagree with the first.
  next_.arm(nowMs, 0U);
}

void Announcer::linkDown() {
  if (state_ == State::Announcing) {
    state_ = State::Unclaimed;
  }
  next_.disarm();
}

void Announcer::claimed(uint32_t nowMs) {
  state_ = State::Claimed;
  next_.arm(nowMs, 0U);
}

uint32_t Announcer::intervalMs() const {
  return state_ == State::Claimed ? kClaimedIntervalMs : kUnclaimedIntervalMs;
}

bool Announcer::due(uint32_t nowMs) {
  if (!next_.expired(nowMs)) {
    return false;
  }
  // Rearmed from `nowMs`, not from the deadline that just passed. Arming from
  // the old deadline would make a board that was blocked — an OTA, a long DNS
  // timeout — emit a burst of catch-up announces the moment it came back, which
  // is the opposite of what a broadcast interval is for.
  next_.arm(nowMs, intervalMs());
  announces_ = announces_ + 1U;
  return true;
}

} // namespace discovery

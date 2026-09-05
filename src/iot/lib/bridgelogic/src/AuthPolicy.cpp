#include "bridgelogic/AuthPolicy.h"

namespace bridgelogic {

AuthCommand AuthPolicy::arm(uint8_t court, uint32_t nowMs) {
  until_.arm(nowMs, ttlMs_);
  court_ = court;
  return AuthCommand::Arm;
}

AuthCommand AuthPolicy::disarm() {
  until_.disarm();
  court_ = kUnbound;
  // Sent even when this half believed the window shut: the Mega's window is
  // the one that forwards presses, and the explicit zero is what keeps the two
  // from drifting by a loop pass.
  return AuthCommand::Disarm;
}

AuthCommand AuthPolicy::afterScan(const court::Outcome& outcome, uint32_t nowMs) {
  if (!outcome.recognised) {
    // Nobody the box or the API knows. No buttons: with a mapped OFF button a
    // window here was relay control for any barcode.
    return disarm();
  }
  if (outcome.action == court::Action::TurnOn) {
    // Bound to the court that just lit, for its owner's OFF press.
    return arm(outcome.court, nowMs);
  }
  // Recognised and refused: a known member who may still buy time. Any
  // previous binding is gone — this scan is a new identity at the panel.
  return arm(kUnbound, nowMs);
}

AuthCommand AuthPolicy::afterHeldCourtRescan(uint8_t court, uint32_t nowMs) {
  return arm(court, nowMs);
}

AuthCommand AuthPolicy::afterWalkUp(const court::Outcome& outcome, uint32_t nowMs) {
  if (outcome.action != court::Action::TurnOn) {
    return AuthCommand::None;
  }
  return arm(outcome.court, nowMs);
}

bool AuthPolicy::allowsRelease(uint8_t court, uint32_t nowMs) const {
  return armed(nowMs) && court_ != kUnbound && court_ == court;
}

bool AuthPolicy::lapsed(uint32_t nowMs) {
  if (!until_.expired(nowMs)) {
    return false;
  }
  until_.disarm();
  court_ = kUnbound;
  return true;
}

} // namespace bridgelogic

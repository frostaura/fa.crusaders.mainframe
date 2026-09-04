#include "bridgelogic/Relight.h"

#include "protocol/Protocol.h"

namespace bridgelogic {

namespace {

constexpr uint32_t kCapMs = static_cast<uint32_t>(proto::kRelayHardCapSeconds) * 1000UL;

} // namespace

void Relight::onGrant(const court::Outcome& outcome, uint32_t nowMs) {
  if (outcome.action != court::Action::TurnOn || outcome.court >= kStateCourts) {
    return;
  }
  Court& c = courts_[outcome.court];
  if (outcome.bookingRemainingMs <= outcome.durationMs) {
    // The relay will outlast the booking on its own. Nothing to extend, and a
    // stale record from an earlier booking must not extend THIS one.
    c.bookingEnd.disarm();
    c.relayEnd.disarm();
    return;
  }
  c.bookingEnd.arm(nowMs, outcome.bookingRemainingMs);
  c.relayEnd.arm(nowMs, outcome.durationMs);
}

void Relight::onRelease(uint8_t court) {
  if (court >= kStateCourts) {
    return;
  }
  courts_[court].bookingEnd.disarm();
  courts_[court].relayEnd.disarm();
}

bool Relight::tracking(uint8_t court) const {
  return court < kStateCourts && courts_[court].bookingEnd.isArmed();
}

Extension Relight::check(uint8_t court, uint32_t nowMs) const {
  Extension ext;
  if (!tracking(court)) {
    return ext;
  }
  const Court& c = courts_[court];
  const uint32_t bookingLeft = c.bookingEnd.remaining(nowMs);
  const uint32_t relayLeft = c.relayEnd.remaining(nowMs);
  if (bookingLeft == 0U || relayLeft > kExtLeadMs || bookingLeft <= relayLeft) {
    // Booking over (the Mega's timer will end it), deadline not yet close, or
    // the relay already covers what is left.
    return ext;
  }
  const uint32_t grantMs = bookingLeft > kCapMs ? kCapMs : bookingLeft;
  ext.due = true;
  // Rounded UP to whole seconds so the relay never runs short of the booking
  // by a fraction, and never below the wire's one-second floor.
  ext.seconds = (grantMs + 999U) / 1000U;
  return ext;
}

void Relight::extended(uint8_t court, uint32_t seconds, uint32_t nowMs) {
  if (!tracking(court)) {
    return;
  }
  const uint32_t ms = seconds > UINT32_MAX / 1000U ? UINT32_MAX : seconds * 1000U;
  courts_[court].relayEnd.arm(nowMs, ms > kCapMs ? kCapMs : ms);
}

} // namespace bridgelogic

#include "bridgelogic/RestorePlan.h"

namespace bridgelogic {

namespace {

/// The `!ON` duration: clamped to the relay hard cap, because one command
/// cannot buy more than that. Saturating on the way into uint16_t as well —
/// a remainder of four billion seconds truncated to sixteen bits is a small
/// plausible number, and a small plausible number is acted on rather than
/// questioned.
uint16_t clampToCap(uint32_t seconds) {
  return seconds > proto::kRelayHardCapSeconds ? proto::kRelayHardCapSeconds : static_cast<uint16_t>(seconds);
}

/// The uncapped remainder in milliseconds, saturating rather than wrapping.
uint32_t bookingMsOf(uint32_t seconds) {
  return seconds > (UINT32_MAX / 1000UL) ? UINT32_MAX : seconds * 1000UL;
}

} // namespace

RestorePlan planRestore(const devlink::RelayRestore* entries, uint8_t entryCount, uint8_t courtCount) {
  RestorePlan plan;
  if (entries == nullptr) {
    return plan;
  }
  for (uint8_t i = 0U; i < entryCount; ++i) {
    const devlink::RelayRestore& entry = entries[i];
    if (entry.relay >= courtCount || entry.relay >= kStateCourts) {
      // A relay this box does not drive. Counted, never acted on: the server
      // believing this box owns a court it does not is a configuration fault
      // somebody has to see, and lighting relay 3 on a two-court box would put
      // a member on a court the club did not sell.
      if (plan.rejected < UINT8_MAX) {
        ++plan.rejected;
      }
      continue;
    }
    if (entry.remainingSeconds == 0U) {
      // The booking ends now. Skipped rather than clamped up to the relay
      // minimum — a one-second flash of the lights is a worse answer than
      // leaving them off, and it would queue a release a second later.
      continue;
    }
    if (plan.count >= kStateCourts) {
      if (plan.rejected < UINT8_MAX) {
        ++plan.rejected;
      }
      continue;
    }
    RestoreAction& action = plan.action[plan.count];
    action.court = entry.relay;
    action.seconds = clampToCap(entry.remainingSeconds);
    action.bookingRemainingMs = bookingMsOf(entry.remainingSeconds);
    ++plan.count;
  }
  return plan;
}

} // namespace bridgelogic

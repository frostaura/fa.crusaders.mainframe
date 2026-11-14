#include "bridgelogic/MegaLink.h"

namespace bridgelogic {

bool shouldRepaintIdentity(bool seenPong, uint32_t previousSeconds, uint32_t seconds) {
  if (!seenPong) {
    // The Mega has just become reachable. Nothing it is showing came from this
    // bridge, whether it was powered off, or the DIP block had the ESP's UART
    // on the USB socket while a credential was typed in.
    return true;
  }
  // Uptime cannot go backwards on a running part, so this is a reset. Equal is
  // not a reset: the Mega reports whole seconds and two pongs inside one second
  // are ordinary.
  return seconds < previousSeconds;
}

bool MegaBootClock::observe(uint32_t nowMs, uint32_t uptimeSeconds) {
  // Saturated: an uptime longer than this half's own clock has run is a Mega
  // that booted before the bridge did, which is the first observation's case.
  const uint32_t upMs = uptimeSeconds > (UINT32_MAX / 1000UL) ? UINT32_MAX : uptimeSeconds * 1000UL;
  const uint32_t bootAt = nowMs - upMs;
  if (!seen_) {
    seen_ = true;
    bootAtMs_ = bootAt;
    return false;
  }
  // How much LATER this boot instant is than the known one (modular: both are
  // instants on the same 32-bit clock, never far apart in practice).
  const int32_t later = static_cast<int32_t>(bootAt - bootAtMs_);
  if (later > static_cast<int32_t>(kSlackMs)) {
    bootAtMs_ = bootAt;
    return true;
  }
  if (later > 0) {
    // Inside the slack: rounding of the same boot, kept as the latest estimate
    // would let the estimate creep; keep the earliest.
    return false;
  }
  bootAtMs_ = bootAt;
  return false;
}

bool MegaProbe::lineLost(uint32_t nowMs) {
  if (!started_) {
    started_ = true;
    refilledAtMs_ = nowMs;
  }
  while (tokens_ < kBurst && static_cast<uint32_t>(nowMs - refilledAtMs_) >= kRefillMs) {
    ++tokens_;
    refilledAtMs_ += kRefillMs;
  }
  if (tokens_ == kBurst) {
    // A full bucket does not bank time: the next refill is a whole period on.
    refilledAtMs_ = nowMs;
  }
  if (tokens_ == 0U) {
    return false;
  }
  --tokens_;
  return true;
}

IdentityScreen identityScreen(bool wifiUp) {
  if (wifiUp) {
    return IdentityScreen{kIdentityOnlineLine1, kIdentityOnlineLine2};
  }
  return IdentityScreen{kIdentityOfflineLine1, kIdentityOfflineLine2};
}

} // namespace bridgelogic

// The Mega's independent relay timer. See include/courtlogic/RelayGuard.h.

#include "courtlogic/RelayGuard.h"

namespace courtlogic {

RelayGuard::RelayGuard(hal::IRelayPort& relay)
    : relay_(relay), until_(), cap_(), locked_(), capMs_(static_cast<uint32_t>(kCapDefaultMinutes) * 60000UL),
      autoOffs_(0U), capOffs_(0U), capReleased_(0U) {
}

uint32_t RelayGuard::clampMs(uint32_t seconds) {
  // Compared in seconds, not milliseconds: `seconds * 1000` overflows a
  // uint32_t at about 49.7 days, which would wrap a huge request to a short
  // one. Comparing first keeps the multiply in range.
  constexpr uint32_t kCapSeconds = kRelayHardCapMs / 1000UL;
  if (seconds >= kCapSeconds) {
    return kRelayHardCapMs;
  }
  const uint32_t ms = seconds * 1000UL;
  return ms < kRelayMinMs ? kRelayMinMs : ms;
}

uint16_t RelayGuard::setCapMinutes(uint32_t minutes) {
  const uint16_t m = minutes < kCapMinMinutes
                         ? kCapMinMinutes
                         : (minutes > kCapMaxMinutes ? kCapMaxMinutes : static_cast<uint16_t>(minutes));
  capMs_ = static_cast<uint32_t>(m) * 60000UL;
  return m;
}

bool RelayGuard::on(uint8_t channel, uint32_t seconds, uint32_t nowMs) {
  if (channel >= hal::kRelayChannelCount) {
    return false;
  }
  const uint32_t ms = clampMs(seconds);
  // Never shortens (FSF-12): a later, shorter !ON for a lit court keeps the
  // longer deadline. remaining() is 0 for a dark relay.
  if (!relay_.isOn(channel) || until_[channel].remaining(nowMs) < ms) {
    until_[channel].arm(nowMs, ms);
  }
  cap_[channel].arm(nowMs, capMs_);
  locked_[channel] = false;
  relay_.set(channel, true);
  return true;
}

void RelayGuard::open(uint8_t channel) {
  relay_.set(channel, false);
  until_[channel].disarm();
  cap_[channel].disarm();
}

bool RelayGuard::off(uint8_t channel) {
  if (channel >= hal::kRelayChannelCount) {
    return false;
  }
  // Open first, then disarm: if anything between the two lines faulted, the
  // safe half has already happened.
  open(channel);
  return true;
}

WantResult RelayGuard::want(uint8_t channel, uint32_t seconds, uint32_t nowMs, bool& closed) {
  closed = false;
  if (channel >= hal::kRelayChannelCount || locked_[channel]) {
    return WantResult::Refused;
  }
  const uint32_t ms = clampMs(seconds);
  if (!relay_.isOn(channel)) {
    until_[channel].arm(nowMs, ms);
    cap_[channel].arm(nowMs, capMs_);
    relay_.set(channel, true);
    closed = true;
    return WantResult::Satisfied;
  }
  if (until_[channel].remaining(nowMs) < ms) {
    until_[channel].arm(nowMs, ms);
  }
  return WantResult::Satisfied;
}

bool RelayGuard::extend(uint8_t channel, uint32_t seconds, uint32_t nowMs) {
  if (channel >= hal::kRelayChannelCount || !relay_.isOn(channel) || locked_[channel]) {
    return false;
  }
  const uint32_t ms = clampMs(seconds);
  if (until_[channel].remaining(nowMs) < ms) {
    until_[channel].arm(nowMs, ms);
  }
  return true;
}

void RelayGuard::allOff() {
  relay_.allOff();
  for (uint8_t i = 0U; i < hal::kRelayChannelCount; ++i) {
    until_[i].disarm();
    cap_[i].disarm();
    locked_[i] = false;
  }
}

uint8_t RelayGuard::tick(uint32_t nowMs) {
  uint8_t released = 0U;
  capReleased_ = 0U;
  for (uint8_t i = 0U; i < hal::kRelayChannelCount; ++i) {
    if (until_[i].expired(nowMs)) {
      open(i);
      released = static_cast<uint8_t>(released | relayBit(i));
      if (autoOffs_ < UINT16_MAX) {
        ++autoOffs_;
      }
      continue;
    }
    if (cap_[i].expired(nowMs) && relay_.isOn(i)) {
      open(i);
      locked_[i] = true;
      released = static_cast<uint8_t>(released | relayBit(i));
      capReleased_ = static_cast<uint8_t>(capReleased_ | relayBit(i));
      if (capOffs_ < UINT16_MAX) {
        ++capOffs_;
      }
    }
  }
  return released;
}

uint8_t RelayGuard::mask() const {
  uint8_t m = 0U;
  for (uint8_t i = 0U; i < hal::kRelayChannelCount; ++i) {
    if (relay_.isOn(i)) {
      m = static_cast<uint8_t>(m | relayBit(i));
    }
  }
  return m;
}

uint16_t RelayGuard::remainingSeconds(uint8_t channel, uint32_t nowMs) const {
  if (channel >= hal::kRelayChannelCount) {
    return 0U;
  }
  // remaining() is already 0 for a disarmed or expired deadline, and bounded
  // by kRelayHardCapMs, so the narrowing is safe.
  return static_cast<uint16_t>(until_[channel].remaining(nowMs) / 1000UL);
}

} // namespace courtlogic

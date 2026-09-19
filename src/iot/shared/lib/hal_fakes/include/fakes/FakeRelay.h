// Crusaders Mainframe — recording fake for hal::IRelayPort.
//
// WHAT THIS CAN AND CANNOT CATCH
// ------------------------------
// It records the LOGICAL state a caller commanded and, separately, the
// ELECTRICAL level that a driver must put on the pin for that state. A test can
// assert both, so a logic layer that says `set(court, false)` when it means
// "lights on" fails on the logical channel, and a change to the active-LOW
// mapping in hal/Relay.h fails on the electrical one.
//
// It cannot catch a driver in arduino_hal/ that ignores relayLevelFor() and
// writes its own inverted digitalWrite — nothing on the host can, because
// nothing on the host runs that code. That is why the mapping is a constexpr in
// the port header with exactly one caller, and why the drivers stay thin enough
// to read in one screen.
//
// OVERFLOW IS A FLAG, NOT A RING
// ------------------------------
// The event log stops recording and raises overflowed() rather than wrapping.
// A ring buffer would keep the LAST 32 events under the same indices, so
// event(0) would silently start answering with a different event and every
// assertion against it would still pass. A fake that lies is worse than no fake.
//
// No Arduino headers, no heap, no String.

#ifndef CRUSADERS_FAKES_FAKERELAY_H
#define CRUSADERS_FAKES_FAKERELAY_H

#include <stdint.h>

#include "hal/PinLevel.h"
#include "hal/Relay.h"

namespace fakes {

class FakeRelay final : public hal::IRelayPort {
public:
  /// One court-hour of activity is a handful of events; 32 is generous and
  /// costs 64 bytes.
  static constexpr uint8_t kMaxEvents = 32U;

  struct Event {
    uint8_t channel;
    bool on;
  };

  void set(uint8_t channel, bool on) override {
    if (channel >= hal::kRelayChannelCount) {
      ++badChannelCalls_;
      return;
    }
    if (state_[channel] != on) {
      ++transitions_[channel];
    }
    state_[channel] = on;
    record(channel, on);
  }

  bool isOn(uint8_t channel) const override { return channel < hal::kRelayChannelCount && state_[channel]; }

  void allOff() override {
    ++allOffCalls_;
    for (uint8_t i = 0U; i < hal::kRelayChannelCount; ++i) {
      set(i, false);
    }
  }

  // --- observation ---------------------------------------------------------

  /// The level a correct driver would have put on the pin for the current
  /// logical state. Out-of-range channels report the released level.
  hal::PinLevel level(uint8_t channel) const { return hal::relayLevelFor(isOn(channel)); }

  /// The same thing as the 0/1 a digitalWrite() would receive, for tests that
  /// want to assert the raw number rather than the enum.
  uint8_t digitalLevel(uint8_t channel) const { return hal::toDigital(level(channel)); }

  bool anyOn() const {
    for (uint8_t i = 0U; i < hal::kRelayChannelCount; ++i) {
      if (state_[i]) {
        return true;
      }
    }
    return false;
  }

  /// Every set() call in order, including redundant re-asserts of a state the
  /// channel was already in — those are meaningful, because the Mega re-drives
  /// its pins defensively and a test may care how often.
  uint8_t eventCount() const { return eventCount_; }

  Event event(uint8_t index) const {
    if (index >= eventCount_) {
      return Event{0U, false};
    }
    return events_[index];
  }

  bool overflowed() const { return overflowed_; }

  /// Off->on and on->off changes for one channel. This is what a duration test
  /// counts, and it is insensitive to redundant re-asserts.
  uint16_t transitions(uint8_t channel) const {
    return channel < hal::kRelayChannelCount ? transitions_[channel] : 0U;
  }

  /// set() calls with an index no relay exists at. Never zero silently: an
  /// out-of-range command means the caller's court mapping is wrong.
  uint16_t badChannelCalls() const { return badChannelCalls_; }

  uint16_t allOffCalls() const { return allOffCalls_; }

  /// Clears the log and the counters but NOT the relay states, matching a
  /// firmware restart of the logic layer with the contacts left as they were.
  void resetLog() {
    eventCount_ = 0U;
    overflowed_ = false;
    badChannelCalls_ = 0U;
    allOffCalls_ = 0U;
    for (uint8_t i = 0U; i < hal::kRelayChannelCount; ++i) {
      transitions_[i] = 0U;
    }
  }

private:
  void record(uint8_t channel, bool on) {
    if (eventCount_ >= kMaxEvents) {
      overflowed_ = true;
      return;
    }
    events_[eventCount_].channel = channel;
    events_[eventCount_].on = on;
    ++eventCount_;
  }

  bool state_[hal::kRelayChannelCount] = {false, false, false, false};
  uint16_t transitions_[hal::kRelayChannelCount] = {0U, 0U, 0U, 0U};
  Event events_[kMaxEvents] = {};
  uint8_t eventCount_ = 0U;
  bool overflowed_ = false;
  uint16_t badChannelCalls_ = 0U;
  uint16_t allOffCalls_ = 0U;
};

} // namespace fakes

#endif // CRUSADERS_FAKES_FAKERELAY_H

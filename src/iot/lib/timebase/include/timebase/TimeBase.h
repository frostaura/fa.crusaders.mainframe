// Crusaders Mainframe — rollover-safe time primitives.
//
// WHY THIS EXISTS
// ---------------
// Arduino's millis() is a uint32_t that wraps to 0 after ~49.71 days. A court
// controller in an electrical cupboard is normally up that long, so the wrap is
// the expected case, not an edge case.
//
// The firmware this replaces (src/firmware/lights-controller) contained BOTH of
// the classic mistakes, on adjacent lines:
//
//     channels[i].expiresAtMs != 0          // 0 used as a "disarmed" sentinel
//     now >= channels[i].expiresAtMs        // direct comparison of wrapping values
//
// The sentinel is wrong because 0 is a legal millis() value, reached once every
// 49.7 days. The comparison is wrong because after the wrap `now` is small and
// `expiresAt` is large, so `now >= expiresAt` is false and the relay is NEVER
// released — the court burns for up to 49.7 days.
//
// Every duration comparison in this codebase goes through reached() or Deadline.
// CI greps for raw comparisons against any identifier matching
// *deadline|*expires|*AtMs outside this directory, so a regression cannot land.
//
// No Arduino headers. Compiles for AVR, Xtensa and the host test runner.

#ifndef CRUSADERS_TIMEBASE_H
#define CRUSADERS_TIMEBASE_H

#include <stdint.h>

namespace tb {

/// True once `now` has reached or passed `deadline`, correct across the uint32
/// wrap. Works because unsigned subtraction wraps consistently: the difference
/// is the true elapsed distance as long as it is under 2^31 ms (~24.8 days),
/// which every timer in this system is by a wide margin.
inline bool reached(uint32_t now, uint32_t deadline) {
  return static_cast<int32_t>(now - deadline) >= 0;
}

/// Elapsed milliseconds from `mark` to `now`, correct across the wrap.
inline uint32_t since(uint32_t now, uint32_t mark) {
  return now - mark;
}

/// A deadline that may be armed or disarmed.
///
/// `armed` is a separate flag on purpose. Using a sentinel value (0, or
/// UINT32_MAX) to mean "disarmed" is the bug described at the top of this file:
/// every possible uint32_t is a legal millis() reading, so no value is free to
/// carry a second meaning.
struct Deadline {
  uint32_t at = 0;
  bool armed = false;

  void arm(uint32_t now, uint32_t inMs) {
    at = now + inMs;
    armed = true;
  }

  void disarm() {
    armed = false;
    at = 0;
  }

  bool isArmed() const { return armed; }

  /// True only when armed AND the deadline has passed. A disarmed Deadline
  /// never expires, however far the clock advances.
  bool expired(uint32_t now) const { return armed && reached(now, at); }

  /// Milliseconds left, saturating at 0. Returns 0 when disarmed.
  uint32_t remaining(uint32_t now) const {
    if (!armed) {
      return 0U;
    }
    const int32_t delta = static_cast<int32_t>(at - now);
    return delta <= 0 ? 0U : static_cast<uint32_t>(delta);
  }
};

/// Accumulates a 64-bit millisecond counter from a wrapping 32-bit source, so
/// uptime and log timestamps stay monotonic past 49.7 days.
///
/// Contract: tick() must be called at least once every 2^31 ms (~24.8 days).
/// The main loop calls it every pass, so this holds trivially — but it is a
/// real precondition, not a formality, and it is why this is not simply a
/// free function.
class Uptime64 {
public:
  /// Feed the current raw millis() value; returns accumulated milliseconds.
  uint64_t tick(uint32_t now) {
    acc_ += static_cast<uint32_t>(now - last_);
    last_ = now;
    return acc_;
  }

  uint64_t value() const { return acc_; }

  /// Seed the counter at construction-time clock value, so the first tick()
  /// does not count the boot instant as elapsed time.
  void seed(uint32_t now) { last_ = now; }

private:
  uint32_t last_ = 0;
  uint64_t acc_ = 0;
};

} // namespace tb

#endif // CRUSADERS_TIMEBASE_H

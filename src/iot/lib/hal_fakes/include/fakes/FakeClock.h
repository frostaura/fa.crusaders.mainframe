// Crusaders Mainframe — controllable fake for hal::IClock.
//
// WHY THIS IS THE MOST IMPORTANT FAKE IN THE SET
// ----------------------------------------------
// The uint32 millis() wrap at ~49.71 days is the bug class that left a court
// lit for weeks in the system this replaces. A real clock cannot be put four
// milliseconds before the wrap; this one can, and advance() wraps exactly the
// way the hardware counter does — deliberately, by unsigned overflow, with no
// clamp and no saturation. Clamping at UINT32_MAX would remove the only
// interesting behaviour the fake has.
//
// Do NOT add rollover-safe comparison helpers here. That logic exists once, in
// lib/timebase, is tested there, and a second implementation living in test
// infrastructure is a second implementation that can disagree with production.
// Tests compare with tb::reached() / tb::Deadline against nowMs().
//
// No Arduino headers, no heap, no String.

#ifndef CRUSADERS_FAKES_FAKECLOCK_H
#define CRUSADERS_FAKES_FAKECLOCK_H

#include <stdint.h>

#include "hal/Clock.h"

namespace fakes {

class FakeClock final : public hal::IClock {
public:
  FakeClock() = default;

  explicit FakeClock(uint32_t startMs) : now_(startMs) {}

  uint32_t nowMs() override {
    ++reads_;
    return now_;
  }

  // --- stimulus ------------------------------------------------------------

  /// Jump the clock anywhere, including 0xFFFFFFFF. There is no ordering
  /// constraint: a test may move it backwards to set up a scenario. Production
  /// code must never observe that, which is why nothing here pretends to
  /// enforce monotonicity — the fake is a knob, not a model of the counter.
  void setNow(uint32_t value) { now_ = value; }

  /// Advance by `ms`, wrapping at 2^32 exactly as the hardware does.
  void advance(uint32_t ms) { now_ += ms; }

  // --- observation ---------------------------------------------------------

  uint32_t value() const { return now_; }

  /// nowMs() calls. A main loop should sample the clock about once per pass;
  /// a jump in this count is how "the timeout is checked against three
  /// different `now` values in one iteration" gets noticed.
  uint32_t reads() const { return reads_; }

  void resetReads() { reads_ = 0U; }

private:
  uint32_t now_ = 0U;
  uint32_t reads_ = 0U;
};

} // namespace fakes

#endif // CRUSADERS_FAKES_FAKECLOCK_H

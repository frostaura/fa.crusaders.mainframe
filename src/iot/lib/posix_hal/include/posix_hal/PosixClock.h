// Crusaders Mainframe — hal::IClock on the host's monotonic clock.
//
// WHY IT TAKES A STARTING VALUE
// -----------------------------
// The interesting bug in this firmware is the uint32 millis() wrap at ~49.71
// days, and a simulator that always starts at zero can never be driven into it:
// nobody is going to run the integration suite for seven weeks. So the
// constructor takes the value the clock should read at startup, and the
// simulator exposes it as --start-ms. Passing 0xFFFFF000 puts the wrap four
// seconds after launch, which turns "does the relay still release across the
// rollover" into something the .NET boundary tests can assert in one run.
//
// steady_clock, not system_clock: an NTP step or a daylight-saving change must
// not move a relay deadline. That is the same property millis() has on the real
// board, and a simulator that did not share it would disagree with the device
// about when a court goes dark.
//
// Wrapping is by unsigned arithmetic, exactly as the hardware counter does.
// There is no clamp and no saturation, because clamping would remove the only
// behaviour this class exists to reproduce.

#ifndef CRUSADERS_POSIX_HAL_POSIXCLOCK_H
#define CRUSADERS_POSIX_HAL_POSIXCLOCK_H

#include <stdint.h>

#include "hal/Clock.h"

namespace posix_hal {

class PosixClock final : public hal::IClock {
public:
  /// `startMs` is what nowMs() returns at construction time.
  explicit PosixClock(uint32_t startMs = 0U);

  uint32_t nowMs() override;

private:
  uint64_t originNs_;
  uint32_t startMs_;
};

} // namespace posix_hal

#endif // CRUSADERS_POSIX_HAL_POSIXCLOCK_H

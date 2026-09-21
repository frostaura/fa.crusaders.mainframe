// The host monotonic clock. See include/posix_hal/PosixClock.h.

#include "posix_hal/PosixClock.h"

#include <chrono>

namespace posix_hal {

namespace {

uint64_t steadyNs() {
  const auto now = std::chrono::steady_clock::now().time_since_epoch();
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(now).count());
}

} // namespace

PosixClock::PosixClock(uint32_t startMs) : originNs_(steadyNs()), startMs_(startMs) {
}

uint32_t PosixClock::nowMs() {
  const uint64_t elapsedMs = (steadyNs() - originNs_) / 1000000ULL;
  // Truncating to 32 bits IS the wrap. Nothing here corrects it: tb::reached()
  // and tb::Deadline are correct across it, and a second correction here would
  // be a second implementation that can disagree with them.
  return startMs_ + static_cast<uint32_t>(elapsedMs);
}

} // namespace posix_hal

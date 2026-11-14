// Crusaders Mainframe — one deadline for a whole blocking HTTP call (BR-11).
//
// The ESP8266 HTTPClient's timeout bounds each PHASE — the connect, then the
// wait for the status line, then (here) the body read — so a server that
// stalls in each phase in turn held the loop for three times the timeout, and a
// 401 retry doubled it. Two things are sized to the call, not to a phase: the
// six-second wait screen in front of every member call, and the Mega receive
// ring, which holds about 4.3 s of uplink. So the call gets ONE budget from
// the moment it starts: each phase is given at most half of what is left (the
// connect and the status line together therefore fit what is left), the body
// read stops at the deadline, and a retry is only started with a useful amount
// of the budget still to spend.
//
// No Arduino headers, no heap. Compiles for Xtensa and the host.

#ifndef CRUSADERS_BRIDGELOGIC_CALLBUDGET_H
#define CRUSADERS_BRIDGELOGIC_CALLBUDGET_H

#include <stdint.h>

#include "timebase/TimeBase.h"

namespace bridgelogic {

/// The whole call, from its first byte to its last, retry included. Ends
/// inside the wait screen (kWaitSeconds, 6 s) with room for the 200 ms flush
/// in front of it, and inside the Mega receive ring's ~4.3 s.
inline constexpr uint32_t kCallBudgetMs = 4000UL;

/// The least worth starting an attempt — or a retry — with.
inline constexpr uint32_t kMinAttemptMs = 750UL;

class CallBudget {
public:
  CallBudget(uint32_t startMs, uint32_t budgetMs) : startMs_(startMs), budgetMs_(budgetMs) {}

  uint32_t remainingMs(uint32_t nowMs) const {
    const uint32_t spent = tb::since(nowMs, startMs_);
    return spent >= budgetMs_ ? 0U : budgetMs_ - spent;
  }

  bool expired(uint32_t nowMs) const { return remainingMs(nowMs) == 0U; }

  /// The timeout to give the client for each phase of the POST: half of what
  /// is left, so connect + status line together end by the deadline. At least
  /// 1 ms (0 would mean "the core's default"), at most 65535.
  uint16_t phaseTimeoutMs(uint32_t nowMs) const {
    const uint32_t half = remainingMs(nowMs) / 2U;
    if (half == 0U) {
      return 1U;
    }
    return half > 0xFFFFU ? static_cast<uint16_t>(0xFFFFU) : static_cast<uint16_t>(half);
  }

  /// Whether another attempt (a 401 retry) may start now.
  bool allowsAttempt(uint32_t nowMs) const { return remainingMs(nowMs) >= kMinAttemptMs; }

private:
  uint32_t startMs_;
  uint32_t budgetMs_;
};

} // namespace bridgelogic

#endif // CRUSADERS_BRIDGELOGIC_CALLBUDGET_H

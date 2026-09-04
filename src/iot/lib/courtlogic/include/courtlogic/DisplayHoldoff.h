// Crusaders Mainframe — what the Mega does with a display whose bus has wedged.
//
// WHY THIS EXISTS
// ---------------
// Every LCD character is ~6 synchronous I2C transactions through AVR `Wire`,
// and the pinned core ships with its bus timeout DISABLED: if SDA sticks low
// mid-transaction — a relay coil transient on the shared 5 V rail is enough —
// the spin loop in twi.c never exits, `loop()` never returns, and the
// "independent" relay auto-off timer stops ticking with a court lit. The
// Mega/ESP split exists to make that impossible, and it was reachable from a
// paint.
//
// The driver now arms the core's per-transaction timeout with reset-on-timeout
// (arduino_hal::LcdDisplay), so one wedged transaction costs ~25 ms, not
// forever. What THIS type decides is what happens next, and it is pure so the
// host suite can pin it:
//
//   * the rest of the write that timed out is abandoned — a 16-column row is
//     ~100 transactions, and 100 × 25 ms is 2.5 s, which is past the watchdog;
//   * the next kHoldoffWrites writes are skipped outright, so a display that is
//     genuinely dead costs one bounded stall per holdoff rather than one per
//     paint, and the relay tick behind those paints keeps its cadence;
//   * after the holdoff the driver tries again, because a transient IS
//     transient and a display that recovers should start rendering again
//     without a power cycle.
//
// No Arduino headers, no heap.

#ifndef CRUSADERS_COURTLOGIC_DISPLAYHOLDOFF_H
#define CRUSADERS_COURTLOGIC_DISPLAYHOLDOFF_H

#include <stdint.h>

namespace courtlogic {

/// Writes skipped after a bus timeout before the driver tries the panel again.
/// Paints are event-driven (a scan, an `!LCD`, an idle repaint), so this is a
/// count rather than a time: the HAL has no clock and does not need one here.
inline constexpr uint8_t kHoldoffWrites = 20U;

class DisplayHoldoff {
public:
  /// True when the write that is about to start should be attempted at all.
  /// Counts a skipped write down the holdoff; the write after the holdoff is
  /// allowed, so a recovered bus is noticed without any other stimulus.
  bool allow();

  /// The bus timed out during a write. The remainder of that write is the
  /// caller's to abandon; this arms the holdoff for the writes that follow.
  void noteTimeout();

  /// True while writes are being skipped. What the composition root would
  /// report if it had anywhere to report to.
  bool holding() const { return remaining_ > 0U; }

  /// Timeouts since boot. Diagnostics: a count that climbs on one box and not
  /// its neighbours is a wiring or rail problem, not a firmware one.
  uint16_t timeouts() const { return timeouts_; }

private:
  uint8_t remaining_ = 0U;
  uint16_t timeouts_ = 0U;
};

} // namespace courtlogic

#endif // CRUSADERS_COURTLOGIC_DISPLAYHOLDOFF_H

// Crusaders Mainframe — the club's wall clock, adopted from the heartbeat and
// advanced on millis() between them.
//
// WHY THE BOX HAS ONE AT ALL, HAVING DELIBERATELY NO RTC
// ------------------------------------------------------
// `server_time` has been served on every heartbeat since the contract was
// written and read by NO firmware. Meanwhile every screen that wanted to name a
// TIME had to name a DURATION instead — "WAIT 9 MIN" rather than "at 18:00",
// "45 MIN" rather than "Ends 18:45" — because the box could not honestly print
// a clock. A member standing in a corridor can act on either, but only one of
// them is still true when they look up thirty seconds later.
//
// This is not a clock the box keeps. It is a clock the box BORROWS, once per
// heartbeat, and stops claiming when the lender goes quiet. Nothing on the
// money path reads it: the relay deadline is the Mega's, the booking window is
// the roster's, and both are millis()-relative for exactly the reasons
// timebase/TimeBase.h gives. This decides what a screen may SAY.
//
// LOADING, FAILED AND EMPTY ARE THREE DIFFERENT STATES
// ----------------------------------------------------
// A box that has never had a heartbeat does not know the time. A box whose link
// died forty minutes ago still does, near enough. A box whose link died four
// hours ago does NOT, and the difference matters: a stale clock reads exactly
// like a live one, so "18:45" on a box that has been offline since lunchtime is
// worse than no clock at all — it is a number the member will plan around. Past
// `clock_trust_minutes` the clock BLANKS, on the wire (`proto::kNoClock`) and
// on every screen row that would have rendered it.
//
// WHY THE DRIFT IS ACCEPTABLE AND THE STALENESS IS NOT
// -----------------------------------------------------
// The ESP8266's crystal is good to a few tens of ppm, so ninety minutes of
// free-running costs well under a second. What a long gap actually costs is not
// accuracy: it is that nothing has confirmed the box and the club still agree
// about anything. The trust window is a link-liveness bound wearing a clock's
// clothes, which is why it is a tenant setting and not a tolerance.
//
// WHAT THE SERVER HAS TO SEND — see the report and `docs/specs/`. The digits
// are read AS WRITTEN: `server_time`'s `HH:MM:SS` must be CLUB-LOCAL wall time,
// not UTC. The box has no timezone database and cannot be given one worth
// having; at the time of writing the endpoint sends `DateTimeOffset.UtcNow`,
// which for a South African club is two hours out and would be silently, and
// plausibly, wrong on the glass.
//
// No Arduino headers, no heap, no String. Compiles for Xtensa and the host.

#ifndef CRUSADERS_BRIDGELOGIC_WALLCLOCK_H
#define CRUSADERS_BRIDGELOGIC_WALLCLOCK_H

#include <stddef.h>
#include <stdint.h>

#include "timebase/TimeBase.h"

namespace bridgelogic {

/// How long the box goes on believing its borrowed clock with no accepted
/// heartbeat, until the tenant's `clock_trust_minutes` says otherwise.
///
/// Ninety minutes is three heartbeats at the 300 s ceiling and a hundred and
/// eighty at the 30 s default, so it takes a genuine outage rather than a
/// dropped packet to reach it — and it is short enough that a box left offline
/// over a lunchtime has stopped claiming to know the time by the evening.
inline constexpr uint32_t kDefaultClockTrustMinutes = 90U;

/// The bounds `clock_trust_minutes` is clamped into. Zero would mean a clock
/// that is never trusted, which is a box that never shows a time and cannot say
/// why; the ceiling is a day, past which "trusted" has stopped meaning anything.
inline constexpr uint32_t kMinClockTrustMinutes = 1U;
inline constexpr uint32_t kMaxClockTrustMinutes = 1440U;

inline constexpr uint32_t kSecondsPerDay = 86400UL;

/// Characters an `HH:MM` display string needs, terminator included.
inline constexpr size_t kDisplayTimeLen = 6U;

/// Characters the wire's four-digit `hhmm` needs, terminator included. The same
/// width as `proto::kNoClock`, deliberately.
inline constexpr size_t kWireTimeLen = 5U;

/// Reads the club-local second-of-day out of an ISO-8601 `server_time`.
///
/// Strict about shape — `YYYY-MM-DDTHH:MM:SS` with the separators where they
/// belong, and every digit a digit — because the alternative to refusing a
/// string this does not understand is printing whatever two bytes happened to
/// sit at offset 11. The date is checked for shape and then discarded: the box
/// shows a time, never a date, and a box that thinks it is Tuesday changes
/// nothing about how it behaves.
///
/// False leaves `out` untouched.
bool secondOfDayFrom(const char* serverTime, uint32_t& out);

class WallClock {
public:
  /// A heartbeat was ACCEPTED and carried `server_time`. True when the shape
  /// was one this understands and the clock was adopted; false leaves the
  /// previous adoption — and its age — exactly as they were, because a
  /// malformed field is not evidence that the last good one has gone stale.
  bool adopt(const char* serverTime, uint32_t nowMs);

  /// The tenant's `clock_trust_minutes`, clamped. Takes effect immediately:
  /// unlike a selection TTL there is nobody mid-interaction to surprise, and an
  /// admin who shortens this wants the stale clock gone now.
  void setTrustMinutes(uint32_t minutes);

  uint32_t trustMinutes() const { return trustMinutes_; }

  /// Whether the clock may be shown. False before the first adoption and once
  /// more than `trustMinutes()` has passed without another one.
  bool trusted(uint32_t nowMs) const;

  /// Second of the club's day, 0..86399, advanced on millis() since the last
  /// adoption and wrapped at midnight. Meaningless — and never rendered — when
  /// `trusted()` is false.
  uint32_t secondOfDay(uint32_t nowMs) const;

  /// The `!IDLE` argument: four digits, or `proto::kNoClock` when the clock is
  /// not trusted. `cap` must be at least kWireTimeLen.
  void wireTime(uint32_t nowMs, char* out, size_t cap) const;

  /// A screen row's `HH:MM`, or an EMPTY string when the clock is not trusted.
  /// A screen renders the blank rather than a guess — see the file header.
  /// `cap` must be at least kDisplayTimeLen.
  void displayTime(uint32_t nowMs, char* out, size_t cap) const;

  /// `HH:MM` for a club-local second-of-day that is not NOW — the end of a
  /// booking, the start of the next one — or an empty string when the clock is
  /// not trusted. Every screen that names a future time goes through here, so
  /// there is one place that can lie and it is guarded once.
  void displayTimeAt(uint32_t nowMs, uint32_t secondOfDayAt, char* out, size_t cap) const;

  /// `secondOfDay(nowMs)` plus `deltaSeconds`, wrapped at midnight. What turns
  /// "2700 seconds left" into "Ends 18:45".
  uint32_t secondOfDayIn(uint32_t nowMs, uint32_t deltaSeconds) const;

private:
  uint32_t trustMs() const;

  uint32_t trustMinutes_ = kDefaultClockTrustMinutes;
  uint32_t adoptedSecondOfDay_ = 0U;
  /// When the last adoption happened. A separate `adopted_` flag rather than
  /// "zero means never", which is the rule TimeBase.h states outright: every
  /// uint32_t is a legal millis() reading, so no value is free to carry a
  /// second meaning.
  uint32_t adoptedSinceMs_ = 0U;
  bool adopted_ = false;
};

} // namespace bridgelogic

#endif // CRUSADERS_BRIDGELOGIC_WALLCLOCK_H

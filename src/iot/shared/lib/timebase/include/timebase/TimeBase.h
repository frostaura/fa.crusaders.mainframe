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

#include <stddef.h>
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
class Deadline {
public:
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

private:
  /// Deliberately private.
  ///
  /// These were public, and that made the canonical bug writable again:
  ///
  ///     if (d.isArmed() && now >= d.at)   // wrong at the wrap
  ///
  /// which is exactly what this type exists to prevent, and exactly what the
  /// deleted lights-controller sketch did. The lint gate did not catch it
  /// either — it matches identifier NAMES ending in Deadline/Expires/AtMs, and
  /// `d.at` matches none of them. Only a test caught it, and only because
  /// someone thought to write one at the wrap.
  ///
  /// Private, the unsafe comparison does not compile. Use expired() or
  /// remaining(); both go through reached(), which uses signed difference.
  uint32_t at = 0;
  bool armed = false;
};

/// Accumulates a 64-bit millisecond counter from a wrapping 32-bit source, so
/// uptime and log timestamps stay monotonic past 49.7 days.
///
/// Contract: tick() must be called at least once every 2^31 ms (~24.8 days).
/// The main loop calls it every pass, so this holds trivially — but it is a
/// real precondition, not a formality, and it is why this is not simply a
/// free function.
///
/// THE INVARIANT EVERYTHING DOWNSTREAM RESTS ON
/// --------------------------------------------
/// **`low32(value()) == millis()`, always.** Events are stamped with the RAW
/// 32-bit `millis()` reading of the moment they happened, and `widen()` below
/// puts one back on the right side of the 49.7-day wrap by assuming exactly
/// this.
///
/// It did not hold, and that was round G4's C1. `seed()` set `last_` and left
/// `acc_` at zero, so the accumulator ran R milliseconds BEHIND `millis()` for
/// the whole life of the boot, where R is whatever the clock read when the
/// firmware's `begin()` was called. On the native simulator's default
/// `--start-ms 0` R is zero and nothing is wrong; on an ESP32 it is the Arduino
/// core's init plus `Serial.begin`, NVS, the UART driver and `WiFi.begin` —
/// hundreds of milliseconds on every board on every boot. `widen()` then
/// UNDERFLOWED for any event uploaded less than R ms after it was stamped and
/// produced a stamp of about 1.8e19, which the server binds as a signed 64-bit
/// and refuses with a 400 — which the event drain reads as "a 4xx the board
/// caused" and DROPS. Every offline door entry on every real board, lost, with
/// no test anywhere able to see it because the one clock base the simulator ran
/// at was the one that hides it.
///
/// WHAT "UPTIME" THEREFORE MEANS ON THE WIRE, SAID DELIBERATELY
/// ------------------------------------------------------------
/// It is `millis()` widened, so it INCLUDES the milliseconds before `begin()`
/// ran. That is truthful — the part was powered for them — and it is the only
/// definition under which the invariant above can hold, because `millis()`
/// counts them and a stamp IS a `millis()` reading. Nothing downstream can see
/// the difference either: the server dates an event by SUBTRACTING its uptime
/// from the batch's, and the offset cancels.
class Uptime64 {
public:
  /// Feed the current raw millis() value; returns accumulated milliseconds.
  uint64_t tick(uint32_t now) {
    acc_ += static_cast<uint32_t>(now - last_);
    last_ = now;
    return acc_;
  }

  uint64_t value() const { return acc_; }

  /// Seed the counter at the construction-time clock value.
  ///
  /// BOTH FIELDS, and that is the whole of the fix. `last_` so the first tick()
  /// does not count the boot instant as elapsed time, and `acc_` so the
  /// accumulator's low 32 bits are the raw `millis()` reading from the very
  /// first pass — see the class comment for what seeding only the first of the
  /// two cost.
  void seed(uint32_t now) {
    last_ = now;
    acc_ = now;
  }

private:
  uint32_t last_ = 0;
  uint64_t acc_ = 0;
};

/// The 64-bit uptime a 32-bit millis() stamp belongs to.
///
/// WHY THIS EXISTS
/// ---------------
/// An event is stamped with the 32-bit millis() reading of the moment it
/// happened and may sit in the queue for days before it is uploaded. Sent as
/// 32 bits, a stamp taken before the 49.7-day wrap and uploaded after it reads
/// as a moment 49.7 days AHEAD of the batch's own 64-bit uptime, and the
/// server — which dates an event by subtracting its uptime from the batch's —
/// dates it at upload time and files a "the counter cannot be believed" audit
/// row against a perfectly healthy box (review 3, finding 25).
///
/// So the stamp is widened at the moment it goes on the wire, against the
/// accumulator that has been counting wraps all along: the answer is the
/// LARGEST value not after `now64` whose low 32 bits are `stamp`. Exact for
/// anything queued less than 49.7 days ago, which is every event the server
/// will accept (its own bound is 30 days).
///
/// IT CANNOT UNDERFLOW, and that is a second defence rather than a restatement
/// of the first. `now64 - back` is unsigned, so `back > now64` used to produce
/// about 1.8e19 — a number the server refuses with a 400 and the drain drops
/// the record over. Seeding `Uptime64` correctly (above) makes that state
/// unreachable, but one defence that an unrelated edit can remove is not a
/// defence, and the value this returns reaches a database column.
///
/// There is no honest answer when `back > now64`: the largest v <= now64 with
/// `low32(v) == stamp` is negative, and the next candidate up is LATER than
/// now. So it clamps to `now64` — "no earlier than this batch", an age of zero,
/// which is what the server does with an unbelievable stamp anyway and is the
/// one answer that cannot overflow anything.
inline uint64_t widen(uint64_t now64, uint32_t stamp) {
  const uint32_t low = static_cast<uint32_t>(now64 & 0xFFFFFFFFULL);
  const uint32_t back = low - stamp; // modulo 2^32, which is what makes this work
  const uint64_t backWide = static_cast<uint64_t>(back);
  return backWide > now64 ? now64 : now64 - backWide;
}

/// Renders `value` as decimal into `out`. Returns the length, or 0 when it
/// would not fit — never a truncated number.
///
/// snprintf's `%llu` is NOT available: avr-libc has no 64-bit printf at all,
/// and the ESP8266 core's is a build-time choice this firmware does not make.
/// A number that silently prints as garbage on one of the two targets is the
/// kind of thing that only shows up in an audit trail months later, so the
/// conversion is done here, in code both targets compile and the host suite
/// pins.
inline size_t formatU64(uint64_t value, char* out, size_t cap) {
  if (out == nullptr || cap == 0U) {
    return 0U;
  }
  char digits[20]; // 2^64-1 is 20 digits
  size_t n = 0U;
  do {
    digits[n] = static_cast<char>('0' + static_cast<char>(value % 10ULL));
    ++n;
    value /= 10ULL;
  } while (value != 0ULL);
  if (n + 1U > cap) {
    out[0] = '\0';
    return 0U;
  }
  for (size_t i = 0U; i < n; ++i) {
    out[i] = digits[n - 1U - i];
  }
  out[n] = '\0';
  return n;
}

} // namespace tb

#endif // CRUSADERS_TIMEBASE_H

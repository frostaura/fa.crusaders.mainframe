// Crusaders Mainframe — who may open a court, decided locally.
//
// WHY A CACHE AND NOT A LOOKUP
// ----------------------------
// A member scans and expects the lights within a second or so. Asking the API
// first makes every activation depend on a consumer router, an ISP and a
// container being up, and turns a two-second DNS stall into a member standing
// in the dark pressing the button again. It also means the court simply stops
// working when the WiFi does, which for a club that had a working spreadsheet
// system is a regression they will notice immediately.
//
// So the box holds the near-future bookings for its own courts and decides on
// its own. The API pushes the roster on the heartbeat; the box records what it
// did in the event queue and uploads that when it can.
//
// WHY ENTRIES EXPIRE, AND WHY THAT IS THE SAFE DIRECTION
// ------------------------------------------------------
// A cache that is allowed to go stale forever will eventually let somebody onto
// a court against a booking that was cancelled a week ago. `ROSTER_MAX_AGE_MS`
// (6 hours) bounds that: past it the roster is not trusted and the box falls
// back to refusing rather than to guessing.
//
// Refusing is the safe direction ONLY because of what a refusal costs. The
// member goes to the desk and an admin lets them on — annoying, recoverable. An
// over-permissive stale cache lights a court nobody is charged for, and the
// club finds out at month end. Note that this is the opposite of the choice the
// relay timer makes, where the safe direction is to release: there, failing
// closed would leave lights burning all night.
//
// WHY MATCHING IS BY OPAQUE TOKEN
// -------------------------------
// The box compares the scanned bytes against a token the API supplied. It never
// sees a membership number, a name, an email or a PIN — a court box lives in an
// unlocked cupboard, and a stolen one must not be a member database. The token
// is what the API can recognise; to the box it is just bytes.
//
// No Arduino headers, no heap, no String. Compiles for AVR, Xtensa and the host.

#ifndef CRUSADERS_ROSTER_ROSTER_H
#define CRUSADERS_ROSTER_ROSTER_H

#include <stddef.h>
#include <stdint.h>

#include "timebase/TimeBase.h"

namespace roster {

/// Longest identification token the box will match. QR payloads and PIN
/// derivations both fit; anything longer is refused rather than truncated,
/// because a truncated token matches the wrong member.
inline constexpr size_t kMaxTokenLen = 40U;

/// One booking, as far as the box needs to know about it.
///
/// No member name and no membership number. See the header — the box holds a
/// token it can compare and nothing anybody could read off a stolen board.
struct Entry {
  /// The opaque identifier the API will recognise. NUL-terminated.
  char token[kMaxTokenLen + 1U] = {};

  /// 0-3 for courts A-D.
  uint8_t court = 0U;

  /// Milliseconds from the moment the roster was accepted until this booking
  /// opens and closes. Relative, not absolute: the box has no RTC, so an
  /// absolute time would be meaningless across the reboot that clears millis().
  uint32_t opensAtMs = 0U;
  uint32_t closesAtMs = 0U;

  /// What the court is granted for once opened.
  uint32_t durationMs = 0U;

  bool valid = false;
};

/// Why a scan was or was not honoured. Every refusal is a distinct value
/// because the LCD has to say something useful — "TOO EARLY 18:00" and "NOT
/// FOUND" send a member to two different places.
enum class Verdict : uint8_t {
  /// Open the court.
  Allow = 0U,
  /// The token matches nothing the box knows about.
  Unknown = 1U,
  /// Matched, but the booking has not opened yet.
  TooEarly = 2U,
  /// Matched, but the booking has already closed.
  TooLate = 3U,
  /// Matched a booking on a DIFFERENT court from the one scanned at.
  WrongCourt = 4U,
  /// The roster is older than its maximum age and is not trusted.
  Stale = 5U,
};

struct Decision {
  Verdict verdict = Verdict::Unknown;
  /// The matched entry, meaningful only for Allow. For TooEarly and WrongCourt
  /// it is also populated, so the display can say WHEN and WHERE.
  Entry entry;
};

/// A bounded, age-limited set of bookings for this box's courts.
template <uint8_t Capacity> class Roster {
public:
  static_assert(Capacity >= 1U, "a roster of nothing cannot admit anybody");

  explicit Roster(uint32_t maxAgeMs) : maxAgeMs_(maxAgeMs) {}

  /// Replaces the whole roster. Wholesale rather than incremental on purpose:
  /// a cancelled booking is expressed by its ABSENCE from the next push, and an
  /// incremental protocol needs a delete verb that can be lost — which is
  /// exactly how a cancelled booking survives in a cache.
  void beginReplace(uint32_t nowMs);

  /// Adds an entry to the replacement in progress. False when full — reported,
  /// not silently dropped, because a truncated roster refuses real members.
  bool add(const Entry& entry);

  /// Commits the replacement. Until this is called the previous roster stays
  /// live, so a push that fails halfway leaves a working court rather than an
  /// empty one.
  void commitReplace();

  /// How the box should answer a scan at `court` presenting `token`.
  Decision decide(const char* token, uint8_t court, uint32_t nowMs) const;

  /// True when the roster has aged out and can no longer be trusted.
  bool stale(uint32_t nowMs) const;

  /// Milliseconds since the roster was accepted. Zero if never.
  uint32_t ageMs(uint32_t nowMs) const;

  uint8_t size() const { return count_; }

  bool everLoaded() const { return loaded_; }

  static constexpr uint8_t capacity() { return Capacity; }

  /// Entries that did not fit in the most recent replacement. Non-zero means
  /// the box is refusing members it should be admitting.
  uint8_t dropped() const { return dropped_; }

private:
  static bool tokenEquals(const char* a, const char* b);

  uint32_t maxAgeMs_;

  Entry entries_[Capacity];
  uint8_t count_ = 0U;

  Entry staging_[Capacity];
  uint8_t stagingCount_ = 0U;
  bool replacing_ = false;

  uint32_t acceptedAtMs_ = 0U;
  uint32_t stagingAtMs_ = 0U;
  bool loaded_ = false;
  uint8_t dropped_ = 0U;
};

// --- implementation ---------------------------------------------------------

namespace detail {

/// Copies a NUL-terminated token, refusing rather than truncating.
bool copyToken(char* dest, size_t destCap, const char* src);

} // namespace detail

template <uint8_t Capacity> void Roster<Capacity>::beginReplace(uint32_t nowMs) {
  stagingCount_ = 0U;
  stagingAtMs_ = nowMs;
  replacing_ = true;
  dropped_ = 0U;
}

template <uint8_t Capacity> bool Roster<Capacity>::add(const Entry& entry) {
  if (!replacing_) {
    return false;
  }
  if (stagingCount_ >= Capacity) {
    ++dropped_;
    return false;
  }
  staging_[stagingCount_] = entry;
  staging_[stagingCount_].valid = true;
  ++stagingCount_;
  return true;
}

template <uint8_t Capacity> void Roster<Capacity>::commitReplace() {
  if (!replacing_) {
    return;
  }
  for (uint8_t i = 0U; i < stagingCount_; ++i) {
    entries_[i] = staging_[i];
  }
  count_ = stagingCount_;
  acceptedAtMs_ = stagingAtMs_;
  loaded_ = true;
  replacing_ = false;
}

template <uint8_t Capacity> uint32_t Roster<Capacity>::ageMs(uint32_t nowMs) const {
  if (!loaded_) {
    return 0U;
  }
  // tb::since, not subtraction: millis() wraps at 49.7 days and a court box
  // is expected to run for months.
  return tb::since(nowMs, acceptedAtMs_);
}

template <uint8_t Capacity> bool Roster<Capacity>::stale(uint32_t nowMs) const {
  if (!loaded_) {
    return true;
  }
  return ageMs(nowMs) > maxAgeMs_;
}

template <uint8_t Capacity> bool Roster<Capacity>::tokenEquals(const char* a, const char* b) {
  size_t i = 0U;
  while (a[i] != '\0' && b[i] != '\0' && i < kMaxTokenLen) {
    if (a[i] != b[i]) {
      return false;
    }
    ++i;
  }
  return a[i] == b[i];
}

template <uint8_t Capacity>
Decision Roster<Capacity>::decide(const char* token, uint8_t court, uint32_t nowMs) const {
  Decision decision;

  if (token == nullptr || token[0] == '\0') {
    decision.verdict = Verdict::Unknown;
    return decision;
  }
  if (stale(nowMs)) {
    // Checked BEFORE matching, so a stale roster cannot admit anybody however
    // good the match looks.
    decision.verdict = Verdict::Stale;
    return decision;
  }

  const uint32_t age = ageMs(nowMs);
  bool sawToken = false;

  for (uint8_t i = 0U; i < count_; ++i) {
    const Entry& e = entries_[i];
    if (!e.valid || !tokenEquals(e.token, token)) {
      continue;
    }
    sawToken = true;

    if (e.court != court) {
      // Keep looking: the same member may hold bookings on two courts, and the
      // one they are standing at should win over the one they are not.
      decision.verdict = Verdict::WrongCourt;
      decision.entry = e;
      continue;
    }
    if (age < e.opensAtMs) {
      decision.verdict = Verdict::TooEarly;
      decision.entry = e;
      continue;
    }
    if (age >= e.closesAtMs) {
      decision.verdict = Verdict::TooLate;
      decision.entry = e;
      continue;
    }

    decision.verdict = Verdict::Allow;
    decision.entry = e;
    return decision;
  }

  if (!sawToken) {
    decision.verdict = Verdict::Unknown;
  }
  return decision;
}

} // namespace roster

#endif // CRUSADERS_ROSTER_ROSTER_H

#include "bridgelogic/WallClock.h"

#include <stdio.h>
#include <string.h>

#include "protocol/Protocol.h"

namespace bridgelogic {

namespace {

bool isDigit(char c) {
  return c >= '0' && c <= '9';
}

/// Two decimal digits at `at`. False for anything else, including a sign, a
/// space or a short string — the caller has already checked the length.
bool twoDigits(const char* s, size_t at, uint32_t& out) {
  if (!isDigit(s[at]) || !isDigit(s[at + 1U])) {
    return false;
  }
  out = static_cast<uint32_t>(s[at] - '0') * 10U + static_cast<uint32_t>(s[at + 1U] - '0');
  return true;
}

/// `YYYY-MM-DDTHH:MM:SS` — the fixed 19-character prefix of every ISO-8601
/// instant the contract sends. Anything after it (a fractional part, `Z`, an
/// offset) is the SERVER's business and is not read here: the digits above are
/// club-local wall time by contract, so an offset would only ever be a second,
/// disagreeing answer to a question already answered.
constexpr size_t kIsoPrefixLen = 19U;

/// The separators, checked BEFORE the digits.
///
/// A string that is the right length but the wrong shape would otherwise yield
/// a plausible time from whatever bytes happened to sit at the offsets — and a
/// plausible time is acted on rather than questioned. `T`, `t` and a space are
/// all legal date-time separators in the wild.
bool isoShapeIsRight(const char* s) {
  const char sep = s[10];
  return s[4] == '-' && s[7] == '-' && (sep == 'T' || sep == 't' || sep == ' ') && s[13] == ':' &&
         s[16] == ':';
}

/// The date, checked for shape and DISCARDED. The box shows a time, never a
/// date, and nothing about its behaviour changes if it thinks it is Tuesday —
/// but a date that is not digits means the offsets below are not either.
bool dateIsDigits(const char* s) {
  uint32_t scratch = 0U;
  return twoDigits(s, 0U, scratch) && twoDigits(s, 2U, scratch) && twoDigits(s, 5U, scratch) &&
         twoDigits(s, 8U, scratch);
}

/// The three time fields, in range.
///
/// 60 is a leap second, which this does not model; 61 upwards is nonsense.
/// Both are REFUSED rather than folded into the next minute, on the rule every
/// reader in this tree follows: report absence, never a guess.
bool timeOfDayFrom(const char* s, uint32_t& out) {
  uint32_t hours = 0U;
  uint32_t minutes = 0U;
  uint32_t seconds = 0U;
  if (!twoDigits(s, 11U, hours) || !twoDigits(s, 14U, minutes) || !twoDigits(s, 17U, seconds)) {
    return false;
  }
  if (hours > 23U || minutes > 59U || seconds > 59U) {
    return false;
  }
  out = hours * 3600U + minutes * 60U + seconds;
  return true;
}

} // namespace

bool secondOfDayFrom(const char* serverTime, uint32_t& out) {
  return serverTime != nullptr && strnlen(serverTime, kIsoPrefixLen) >= kIsoPrefixLen &&
         isoShapeIsRight(serverTime) && dateIsDigits(serverTime) && timeOfDayFrom(serverTime, out);
}

uint32_t WallClock::trustMs() const {
  return trustMinutes_ * 60000UL;
}

bool WallClock::adopt(const char* serverTime, uint32_t nowMs) {
  uint32_t secondOfDay = 0U;
  if (!secondOfDayFrom(serverTime, secondOfDay)) {
    // A malformed field is not evidence that the last good adoption has gone
    // stale, so the age is left alone: a server that starts sending rubbish
    // costs the box its clock after trustMinutes(), not immediately.
    return false;
  }
  adoptedSecondOfDay_ = secondOfDay;
  adoptedSinceMs_ = nowMs;
  adopted_ = true;
  return true;
}

void WallClock::setTrustMinutes(uint32_t minutes) {
  uint32_t bounded = minutes;
  if (bounded < kMinClockTrustMinutes) {
    bounded = kMinClockTrustMinutes;
  }
  if (bounded > kMaxClockTrustMinutes) {
    bounded = kMaxClockTrustMinutes;
  }
  trustMinutes_ = bounded;
}

bool WallClock::trusted(uint32_t nowMs) const {
  return adopted_ && tb::since(nowMs, adoptedSinceMs_) <= trustMs();
}

uint32_t WallClock::secondOfDay(uint32_t nowMs) const {
  const uint32_t elapsed = tb::since(nowMs, adoptedSinceMs_) / 1000UL;
  // Both operands are already inside a day's worth of seconds by construction
  // — the trust window is at most a day — so one modulo is enough and cannot
  // overflow.
  return (adoptedSecondOfDay_ + (elapsed % kSecondsPerDay)) % kSecondsPerDay;
}

uint32_t WallClock::secondOfDayIn(uint32_t nowMs, uint32_t deltaSeconds) const {
  return (secondOfDay(nowMs) + (deltaSeconds % kSecondsPerDay)) % kSecondsPerDay;
}

void WallClock::wireTime(uint32_t nowMs, char* out, size_t cap) const {
  if (out == nullptr || cap < kWireTimeLen) {
    return;
  }
  if (!trusted(nowMs)) {
    snprintf(out, cap, "%s", proto::kNoClock);
    return;
  }
  const uint32_t second = secondOfDay(nowMs);
  snprintf(out, cap, "%02u%02u", static_cast<unsigned>(second / 3600U),
           static_cast<unsigned>((second / 60U) % 60U));
}

void WallClock::displayTime(uint32_t nowMs, char* out, size_t cap) const {
  displayTimeAt(nowMs, secondOfDay(nowMs), out, cap);
}

void WallClock::displayTimeAt(uint32_t nowMs, uint32_t secondOfDayAt, char* out, size_t cap) const {
  if (out == nullptr || cap == 0U) {
    return;
  }
  // EMPTY, never a guess. Every screen row that would name a time renders this,
  // so the one place that could lie is guarded once rather than per screen.
  if (!trusted(nowMs) || cap < kDisplayTimeLen) {
    out[0] = '\0';
    return;
  }
  const uint32_t second = secondOfDayAt % kSecondsPerDay;
  snprintf(out, cap, "%02u:%02u", static_cast<unsigned>(second / 3600U),
           static_cast<unsigned>((second / 60U) % 60U));
}

} // namespace bridgelogic

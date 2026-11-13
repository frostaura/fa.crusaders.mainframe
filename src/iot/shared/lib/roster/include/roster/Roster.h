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

/// Longest identification token the box will match. Anything longer is refused
/// rather than truncated, because a truncated token matches the wrong member.
///
/// 20, not 40. The token has to transit the scanner line and the `!SCAN` frame,
/// whose argument is capped at proto::kMaxArgLen (24), so a 40-character roster
/// token was one the box could hold and never match — the scanner would have
/// refused it before the roster ever saw it. The heartbeat contract pins the
/// token as Crockford base32, typically 12 characters, and bounds it at 20; this
/// constant is that bound. `bridgelogic/RosterTokenFits.h`, over in the
/// court-box project, asserts it against that protocol's argument cap — where
/// the two constants actually meet — because this library must not depend on
/// the protocol to state its own limit, and must not drag one device family's
/// serial codec into a firmware that speaks a different link.
inline constexpr size_t kMaxTokenLen = 20U;

/// Characters a roster token may contain, and therefore the only characters a
/// scanned line can ever MATCH one with.
///
/// The contract's Crockford alphabet is uppercase alphanumerics; lowercase, `-`
/// and `_` are tolerated so a token minted in a neighbouring alphabet is not
/// refused for being wire-safe in a way a given build did not anticipate.
/// Everything else — whitespace, quotes, the `|` separator, a backslash, the
/// `!SCAN` frame's `,`/`*`/`%` — is refused, because each of those breaks
/// either the JSON string, the roster element, or the frame the token will
/// later have to match through.
///
/// IT LIVES HERE, IN THE LIBRARY THAT OWNS THE TOKENS, and that is round G4's
/// B1. It used to be a file-local helper inside `devlink`'s roster-element
/// parser, so the ELEMENT was checked against it and the SCANNER was not: the
/// door admitted every printable byte, `"` and `\` included, and a twenty-
/// character QR code re-wrote the fields of the JSON body it was interpolated
/// into. A token outside this set can never match anything in the roster, so
/// admitting one only ever spends an API call or forges a record — it is a
/// refusal, and now it is one in both places from one definition.
///
/// One return statement: the generated sketches compile at gnu++11.
constexpr bool isTokenChar(char c) {
  return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '-' || c == '_';
}

/// THE v1 ENTRY: A BOOKING NAMED BY ITS PLAYERS, NOT BY A CODE.
///
/// Under the single rotating member code (docs/specs/member-code.md) a member's
/// code changes every thirty seconds, so a roster cannot hold it. It holds the
/// booking's PLAYERS instead: `m` followed by one to four four-character member
/// REFs, organiser first, then accepted partners — `mK7M2P4XR` is a booking two
/// people may open. Five to seventeen characters, inside the same `TOKEN|relay|
/// opens_in|closes_in` element and the same kMaxTokenLen, so a court box's four
/// players fit (4 x 4 = 16 <= 20) and nothing about the element grammar moves.
///
/// A lower-case `m` cannot begin a legacy code — those are upper-case Crockford
/// — so the marker is unambiguous. `devlink::parseRosterElement` refuses a REF
/// list that is not whole, canonical REFs.
///
/// A REF IS NOT A SECRET — it is printed in every code a member shows — and that
/// is why the two paths below never cross. A REF list is matched only against a
/// REF the member code verifier has already PROVED (decideMember); a scanned
/// string is matched only against entries that are NOT REF lists. Otherwise
/// `m` plus somebody's REF, typed into anything that emits a barcode, would be a
/// key to their court.
inline constexpr char kRefListMarker = 'm';
inline constexpr size_t kRefLen = 4U;
inline constexpr uint8_t kMaxRefs = 4U;

static_assert(1U + (kRefLen * kMaxRefs) <= kMaxTokenLen, "four players must fit one roster token");

/// True when `token` is a v1 entry's REF list rather than a code.
inline bool isRefList(const char* token) {
  return token != nullptr && token[0] == kRefListMarker;
}

/// True when the REF list `token` names `ref` (exactly kRefLen characters) in
/// one of its whole-REF positions. A REF straddling two slots never matches.
bool refListNames(const char* token, const char* ref);

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
  /// The matched entry, populated for every verdict that matched one — Allow,
  /// TooEarly, TooLate and WrongCourt — so the display can say WHEN and WHERE,
  /// and so the caller can light the court the ENTRY names rather than the one
  /// it guessed. Untouched for Unknown and Stale.
  Entry entry;
  /// What to grant now, for Allow: the time REMAINING on the booking, not its
  /// nominal length. A member who arrives twenty minutes into a 45-minute slot
  /// gets 25, which is what they booked and what the next member's start time
  /// depends on. Zero for every other verdict.
  uint32_t grantMs = 0U;
};

/// How many relays a box drives, for the shared-scanner decide() overload.
///
/// A distinct type rather than a second uint8_t, because a court INDEX and a
/// court COUNT are the same width and the wrong one compiles silently: passing
/// a count of 2 where an index was expected refuses every member on court C.
struct CourtCount {
  explicit constexpr CourtCount(uint8_t n) : value(n) {}

  uint8_t value;
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

  /// Back to exactly the state a fresh Roster(maxAgeMs) is in: nothing loaded,
  /// never loaded, no replacement in progress. In place, because assigning a
  /// fresh Roster builds a whole second table on the stack first (the gate's
  /// cold-trust expiry was a 3.9 KB frame on an 8 KB task).
  void forget() {
    for (Entry& e : entries_) {
      e = Entry();
    }
    for (Entry& e : staging_) {
      e = Entry();
    }
    count_ = 0U;
    stagingCount_ = 0U;
    replacing_ = false;
    acceptedAtMs_ = 0U;
    stagingAtMs_ = 0U;
    loaded_ = false;
    agedOut_ = false;
    dropped_ = 0U;
  }

  /// Adds an entry to the replacement in progress. False when full — reported,
  /// not silently dropped, because a truncated roster refuses real members.
  bool add(const Entry& entry);

  /// Commits the replacement. Until this is called the previous roster stays
  /// live, so a push that fails halfway leaves a working court rather than an
  /// empty one.
  void commitReplace();

  /// How the box should answer a scan at `court` presenting `token`. For a box
  /// with one scanner per court.
  Decision decide(const char* token, uint8_t court, uint32_t nowMs) const;

  /// How the box should answer `token` presented at its ONE scanner, when that
  /// scanner serves the first `courts.value` relays. The matched entry names the
  /// court; an entry on a relay this box does not drive is WrongCourt.
  ///
  /// A scanned token is compared with legacy entries ONLY — never with a v1
  /// entry's REF list. See kRefListMarker.
  Decision decide(const char* token, CourtCount courts, uint32_t nowMs) const;

  /// The same decisions for a member whose single code the verifier has
  /// already proved: `ref` is their canonical four-character REF, matched
  /// against v1 entries' REF lists and nothing else. Every player a booking
  /// names — organiser or accepted partner — may open it.
  Decision decideMember(const char* ref, uint8_t court, uint32_t nowMs) const;
  Decision decideMember(const char* ref, CourtCount courts, uint32_t nowMs) const;

  /// True when an entry on relay `court` is open at `nowMs`: somebody holds the
  /// court now. What the court box asks before it offers to let a member PAY
  /// for a court (D10) rather than buy time on it. False on a stale roster.
  bool occupied(uint8_t court, uint32_t nowMs) const;

  /// True when the roster has aged out and can no longer be trusted.
  bool stale(uint32_t nowMs) const;

  /// Look at the roster's age on THIS pass, and remember for good that it
  /// aged out if it has. The loop calls it on every pass, link or no link.
  ///
  /// WHY AN AGE LATCHES (review round 18, D18-2). `ageMs` is a 32-bit
  /// difference, so a roster accepted 2^32 ms + 1 s ago reads ONE SECOND old:
  /// a box offline for 49.7 days admitted a booking from seven weeks earlier.
  /// No single reading can tell those two apart — the arguments are
  /// bit-identical — so the age has to be WATCHED: once any pass sees it past
  /// `maxAgeMs`, the roster stays stale until the next one is accepted.
  /// Contract: called at least once between the maximum age and 2^32 ms after
  /// acceptance (49.4 days of slack against a loop that runs every few
  /// milliseconds), the same kind of precondition `tb::Uptime64` states.
  void observe(uint32_t nowMs);

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

  /// The one matching loop every overload shares. An entry is "at this
  /// scanner" when `firstCourt <= entry.court < endCourt`: a single court is the
  /// range [court, court + 1) and a shared scanner is [0, count). `byRef`
  /// chooses which of the two never-crossing paths `key` is matched on.
  Decision decideWithin(const char* key, bool byRef, uint8_t firstCourt, uint8_t endCourt,
                        uint32_t nowMs) const;

  /// Whether entry `e` is the one `key` names on the path `byRef` chooses.
  static bool entryMatches(const Entry& e, const char* key, bool byRef);

  uint32_t maxAgeMs_;

  Entry entries_[Capacity];
  uint8_t count_ = 0U;

  Entry staging_[Capacity];
  uint8_t stagingCount_ = 0U;
  bool replacing_ = false;

  uint32_t acceptedAtMs_ = 0U;
  uint32_t stagingAtMs_ = 0U;
  bool loaded_ = false;
  /// Latched by observe() once the age passed maxAgeMs_; cleared only by
  /// commitReplace(). See observe().
  bool agedOut_ = false;
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
  // A new anchor, and the only thing that clears an aged-out one.
  agedOut_ = false;
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

template <uint8_t Capacity> void Roster<Capacity>::observe(uint32_t nowMs) {
  if (loaded_ && tb::since(nowMs, acceptedAtMs_) > maxAgeMs_) {
    agedOut_ = true;
  }
}

template <uint8_t Capacity> bool Roster<Capacity>::stale(uint32_t nowMs) const {
  if (!loaded_ || agedOut_) {
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
  return decideWithin(token, false, court, static_cast<uint8_t>(court + 1U), nowMs);
}

template <uint8_t Capacity>
Decision Roster<Capacity>::decide(const char* token, CourtCount courts, uint32_t nowMs) const {
  return decideWithin(token, false, 0U, courts.value, nowMs);
}

template <uint8_t Capacity>
Decision Roster<Capacity>::decideMember(const char* ref, uint8_t court, uint32_t nowMs) const {
  return decideWithin(ref, true, court, static_cast<uint8_t>(court + 1U), nowMs);
}

template <uint8_t Capacity>
Decision Roster<Capacity>::decideMember(const char* ref, CourtCount courts, uint32_t nowMs) const {
  return decideWithin(ref, true, 0U, courts.value, nowMs);
}

template <uint8_t Capacity> bool Roster<Capacity>::entryMatches(const Entry& e, const char* key, bool byRef) {
  if (!e.valid) {
    return false;
  }
  // THE TWO PATHS NEVER CROSS. A REF list answers only a proved REF; a code
  // answers only a legacy entry. See kRefListMarker for what crossing costs.
  return byRef ? refListNames(e.token, key) : (!isRefList(e.token) && tokenEquals(e.token, key));
}

template <uint8_t Capacity> bool Roster<Capacity>::occupied(uint8_t court, uint32_t nowMs) const {
  if (stale(nowMs)) {
    return false;
  }
  const uint32_t age = ageMs(nowMs);
  for (uint8_t i = 0U; i < count_; ++i) {
    const Entry& e = entries_[i];
    if (e.valid && e.court == court && age >= e.opensAtMs && age < e.closesAtMs) {
      return true;
    }
  }
  return false;
}

template <uint8_t Capacity>
Decision Roster<Capacity>::decideWithin(const char* key, bool byRef, uint8_t firstCourt, uint8_t endCourt,
                                        uint32_t nowMs) const {
  Decision decision;

  if (key == nullptr || key[0] == '\0') {
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
    if (!entryMatches(e, key, byRef)) {
      continue;
    }
    sawToken = true;

    if (e.court < firstCourt || e.court >= endCourt) {
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
    // Remaining, not nominal. The TooLate check above established that the age
    // is still inside the window, so this cannot underflow, and a late arrival
    // gets what is left of the slot.
    decision.grantMs = e.closesAtMs - age;
    return decision;
  }

  if (!sawToken) {
    decision.verdict = Verdict::Unknown;
  }
  return decision;
}

} // namespace roster

#endif // CRUSADERS_ROSTER_ROSTER_H

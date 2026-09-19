// Crusaders Mainframe — filling the roster from the heartbeat response.
//
// WHY THIS IS A LIBRARY AND NOT A FUNCTION IN main.cpp
// ----------------------------------------------------
// The roster cache existed for a year with nothing filling it. Roster.h said
// "the API pushes the roster on the heartbeat"; the heartbeat handler applied
// the button map and nothing else, so every booked member's scan was refused as
// Stale, forever (review C2). The parse lived nowhere, so no test could notice
// that it did not exist. It lives here now, where `pio test -e native` runs it
// against inline fixture bodies shaped by the wire contract.
//
// THE WIRE SHAPE
// --------------
//     "court_numbers": [7, 8, 9]              position == relay index 0..3
//     "roster": ["TOKEN|relay|opens_in|closes_in", ...]
//
// Each roster element is four `|`-separated fields: the opaque token the API
// will later recognise, the relay (0-3) it opens, and two SIGNED second counts
// relative to the moment the response was produced — until the booking's window
// opens (negative means already open) and until it closes. Strings rather than
// objects because this end has no JSON parser, only a scanner, and four fields
// behind one delimiter is a shape it can read without one.
//
// REFUSE, NEVER TRUNCATE
// ----------------------
// A token cut short matches a different member; a relay clamped to a neighbour
// lights a different court. Every field that does not fit or does not parse
// refuses the whole element, the element is counted, and the rest of the roster
// is still applied — one bad booking must not blank the evening's other fifteen.
//
// No Arduino headers, no heap, no String. Compiles for Xtensa and the host.

#ifndef CRUSADERS_DEVLINK_ROSTERSYNC_H
#define CRUSADERS_DEVLINK_ROSTERSYNC_H

#include <stddef.h>
#include <stdint.h>

#include "devapi/Json.h"
#include "roster/Roster.h"

namespace devlink {

// The roster token must also fit a `!SCAN` argument, but that is a fact about
// ONE device family's serial link and this is a device-agnostic library: a
// shared lib that included `protocol/` would drag the court box's Mega<->ESP
// codec into every firmware that ever reuses this one. The cross-assert lives
// where the two actually meet — `bridgelogic/RosterTokenFits.h` in the
// court-box project — and is compiled by the court_bridge build and by the
// native suite, so it still cannot silently lapse.

/// Relays a box drives, and therefore the longest `court_numbers` array.
inline constexpr uint8_t kMaxCourts = 4U;

/// The contract's cap on roster entries per heartbeat. A roster sized to this
/// holds every entry the API will ever send; anything past it is dropped and
/// counted by the roster itself.
inline constexpr uint8_t kMaxRosterEntries = 16U;

/// What one heartbeat did to the roster.
struct SyncResult {
  /// False when the response carried no `roster` key at all: the cache is left
  /// exactly as it was, staleness included. An older API that does not send one
  /// must not blank a roster a newer one filled.
  bool replaced = false;
  /// Elements admitted to the new roster.
  uint8_t accepted = 0U;
  /// Elements refused as malformed. Non-zero is a contract drift an admin
  /// should hear about; it is never a reason to abandon the rest of the push.
  uint8_t rejected = 0U;
  /// Well-formed elements that did not fit the roster's capacity.
  uint8_t dropped = 0U;
};

/// Parses one `TOKEN|relay|opens_in|closes_in` element of `len` bytes into
/// `out`. False, with `out` untouched, on: a token longer than
/// roster::kMaxTokenLen or empty or outside `[0-9A-Za-z_-]`; a relay past 3; a
/// missing or extra field; a second count whose millisecond value would not fit
/// a uint32_t; a booking that closes before it opens. A negative `opens_in`
/// clamps to zero — the window is already open.
bool parseRosterElement(const char* text, size_t len, roster::Entry& out);

/// The NUL-terminated form of the above.
bool parseRosterElement(const char* text, roster::Entry& out);

/// Reads `court_numbers` into `out`, position == relay index. False, with `out`
/// and `count` untouched, when the key is absent, is not an array, holds more
/// than kMaxCourts elements, or holds anything that is not a court number. An
/// empty array is a box that drives no courts and reads as true with count 0.
bool parseCourtNumbers(const char* body, size_t len, int16_t out[kMaxCourts], uint8_t& count);

namespace detail {

/// Finds the next `"..."` element in the array at `at`, without copying it.
/// Yields the span of the string's contents and advances `at` past the closing
/// quote. False at the closing bracket or the end of the buffer.
///
/// By position rather than through devapi::json::nextStringElement, which copies
/// into a caller buffer and cannot skip an element that does not fit — and one
/// over-long element must cost that element, not every element after it.
bool nextStringSpan(const char* body, size_t len, size_t& at, size_t& start, size_t& n);

} // namespace detail

/// Applies the `roster` array out of a heartbeat response to `target`.
///
/// Absent key → untouched. Present → a wholesale replacement through
/// beginReplace/add/commitReplace, so an EMPTY array commits an empty roster:
/// a cancelled booking is expressed by its absence from the next push, and
/// "everything was cancelled" has to be expressible too. Malformed elements are
/// skipped and counted; the remainder is still committed.
///
/// Entry times are relative to `nowMs`, the moment this box accepted the push.
template <class RosterT>
SyncResult applyRoster(const char* body, size_t len, RosterT& target, uint32_t nowMs) {
  SyncResult result;

  size_t at = devapi::json::findArray(body, len, "roster");
  if (at == devapi::json::kNotFound) {
    return result;
  }

  target.beginReplace(nowMs);

  size_t start = 0U;
  size_t n = 0U;
  while (detail::nextStringSpan(body, len, at, start, n)) {
    roster::Entry entry;
    if (!parseRosterElement(body + start, n, entry)) {
      if (result.rejected < UINT8_MAX) {
        ++result.rejected;
      }
      continue;
    }
    if (target.add(entry) && result.accepted < UINT8_MAX) {
      ++result.accepted;
    }
  }

  result.dropped = target.dropped();
  target.commitReplace();
  result.replaced = true;
  return result;
}

} // namespace devlink

#endif // CRUSADERS_DEVLINK_ROSTERSYNC_H

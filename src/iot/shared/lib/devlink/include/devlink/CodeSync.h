// Crusaders Mainframe — the member-code sync out of a heartbeat response.
//
// WHAT THE SERVER SENDS, AND ONLY TO A DEVICE THAT ASKED
// ------------------------------------------------------
// A device that reports the `codes:m1` capability on its heartbeat is answered
// with four more TOP-LEVEL keys (docs/specs/member-code.md §5):
//
//     "code_step":    59672640            the TOTP step the body was written in
//     "code_step_ms": 17000               how far into it, 0..29999
//     "code_days":    ["<first>|<end>", …] day slots, half-open step ranges, ≤ 2
//     "code_keys":    ["K7M20<16 b64url>", …] REF + slot + K_day, ≤ 24 / ≤ 72
//
// A device that did not ask — every board flashed before this — gets none of
// them and is exactly as it was. The capacities are the DEVICE's: a court box
// holds 24 keys and a door 72, and the budgets that make those fit the 2048 and
// 4096-byte bodies are pinned by `heartbeat-response-codes-full` in the corpus.
//
// THE RULES, WHICH ARE THE ROSTER'S RULES
// ---------------------------------------
//   * A body that is not one COMPLETE JSON object adopts nothing — not even the
//     clock. A cut body is whatever landed, and a ring committed from half a key
//     list refuses every member whose key was in the half that did not.
//   * Top level only. A `code_keys` nested in some other object is not the ring.
//   * Clock: `code_step` AND `code_step_ms` together, the phase inside a step,
//     or the clock is left exactly as it was.
//   * Ring: an absent `code_keys` leaves the ring (and its days) untouched — an
//     older API must not blank a ring a newer one filled; a present one REPLACES
//     it wholesale, empty included. A malformed element is skipped and counted,
//     and a key naming a day slot `code_days` did not fill is refused with it;
//     the rest is still committed. One bad key costs one member, not the club.
//
// No Arduino headers, no heap. Compiles for Xtensa and the host.

#ifndef CRUSADERS_DEVLINK_CODESYNC_H
#define CRUSADERS_DEVLINK_CODESYNC_H

#include <stddef.h>
#include <stdint.h>

#include "devapi/Json.h"
#include "devcrypto/Sha256.h"
#include "devlink/RosterSync.h"
#include "memcode/KeyRing.h"
#include "memcode/StepClock.h"
#include "memcode/Token.h"
#include "roster/Roster.h"

namespace devlink {

// The roster names players by the same four characters the token carries. The
// two constants live in two libraries that must not depend on each other, so
// the assertion lives here, in the one that includes both.
static_assert(memcode::kRefLen == roster::kRefLen,
              "a roster REF and a token REF are the same four characters");
static_assert(memcode::kTokenLen <= roster::kMaxTokenLen,
              "a v1 token must fit every buffer a roster token fits, or a scanner that accepts one truncates "
              "the other");

struct CodeSyncResult {
  /// The step clock was (re)anchored from this body.
  bool clockSynced = false;
  /// `code_keys` was present and the ring was replaced, empty included.
  bool keysReplaced = false;
  /// Keys committed, keys refused as malformed or slot-less, and well-formed
  /// keys the ring had no room for.
  uint8_t accepted = 0U;
  uint8_t rejected = 0U;
  uint8_t dropped = 0U;
};

namespace detail {

/// The clock half of the sync. True when the body anchored `clock`.
bool syncStepClock(const char* body, size_t len, memcode::StepClock& clock, uint32_t nowMs);

// nextArrayElement is declared in devlink/RosterSync.h (the roster's first pass uses it too).

} // namespace detail

namespace detail {

/// The day slots out of `code_days` into the replacement in progress. Position
/// is the slot number, so every element occupies one — a value that is not a
/// day leaves its slot empty rather than renumbering the rest — and a third
/// element is past the two slots a ring has and is ignored.
template <class KeyRingT> void stageDays(const char* body, size_t len, KeyRingT& ring) {
  size_t at = devapi::json::findTopLevelArray(body, len, "code_days");
  if (at == devapi::json::kNotFound) {
    return;
  }
  size_t start = 0U;
  size_t n = 0U;
  bool isString = false;
  uint8_t slot = 0U;
  while (slot < memcode::kMaxDaySlots && nextArrayElement(body, len, at, start, n, isString)) {
    memcode::DaySlot day;
    if (isString && memcode::parseDaySlot(body + start, n, day)) {
      static_cast<void>(ring.setDay(slot, day));
    }
    ++slot;
  }
}

/// The keys out of `code_keys`, starting at element position `at`, into the
/// replacement in progress. Malformed or slot-less keys are counted; the local
/// copy of every key is wiped whichever way it went.
template <class KeyRingT>
void stageKeys(const char* body, size_t len, size_t at, KeyRingT& ring, CodeSyncResult& result) {
  size_t start = 0U;
  size_t n = 0U;
  bool isString = false;
  while (nextArrayElement(body, len, at, start, n, isString)) {
    memcode::DayKey key;
    const bool good = isString && memcode::parseKeyElement(body + start, n, key) && ring.stagedDay(key.slot);
    if (!good) {
      result.rejected = result.rejected < UINT8_MAX ? static_cast<uint8_t>(result.rejected + 1U) : UINT8_MAX;
    } else if (ring.add(key) && result.accepted < UINT8_MAX) {
      ++result.accepted;
    }
    dc::wipe(key.key, sizeof(key.key));
  }
}

/// The `code_days` slots, for the first pass: which slots a key may name.
inline void readDaySlots(const char* body, size_t len, memcode::DaySlot (&days)[memcode::kMaxDaySlots]) {
  size_t dayAt = devapi::json::findTopLevelArray(body, len, "code_days");
  size_t start = 0U;
  size_t n = 0U;
  bool isString = false;
  uint8_t slot = 0U;
  while (dayAt != devapi::json::kNotFound && slot < memcode::kMaxDaySlots &&
         nextArrayElement(body, len, dayAt, start, n, isString)) {
    if (isString) {
      static_cast<void>(memcode::parseDaySlot(body + start, n, days[slot]));
    }
    ++slot;
  }
}

/// FC-1's first pass over `code_keys` at `at`: how many elements it has
/// (`elements`, saturating) and how many of them are a readable key naming a
/// valid day slot (the return, saturating). Every parsed key is wiped.
inline uint8_t countReadableKeys(const char* body, size_t len, size_t at, uint8_t& elements) {
  memcode::DaySlot days[memcode::kMaxDaySlots];
  readDaySlots(body, len, days);
  uint8_t readable = 0U;
  elements = 0U;
  size_t start = 0U;
  size_t n = 0U;
  bool isString = false;
  size_t probe = at;
  while (nextArrayElement(body, len, probe, start, n, isString)) {
    memcode::DayKey key;
    elements = elements < UINT8_MAX ? static_cast<uint8_t>(elements + 1U) : UINT8_MAX;
    if (isString && memcode::parseKeyElement(body + start, n, key) && key.slot < memcode::kMaxDaySlots &&
        days[key.slot].valid) {
      readable = readable < UINT8_MAX ? static_cast<uint8_t>(readable + 1U) : UINT8_MAX;
    }
    dc::wipe(key.key, sizeof(key.key));
  }
  return readable;
}

} // namespace detail

/// Applies the member-code sync in `body` to `clock` and `ring`, anchored at
/// `nowMs` — a FRESH read taken after the call returned, like the roster's.
template <class KeyRingT>
CodeSyncResult applyCodeSync(const char* body, size_t len, memcode::StepClock& clock, KeyRingT& ring,
                             uint32_t nowMs) {
  CodeSyncResult result;
  if (body == nullptr || !devapi::json::isCompleteObject(body, len)) {
    return result;
  }
  result.clockSynced = detail::syncStepClock(body, len, clock, nowMs);

  const size_t at = devapi::json::findTopLevelArray(body, len, "code_keys");
  if (at == devapi::json::kNotFound) {
    return result;
  }
  // FIRST PASS (device-api.md §11.2, FC-1): a non-empty `code_keys` of which
  // NOTHING is readable keeps the ring this board has, and is counted so the
  // caller reports drift; `[]` still withdraws every key (member-code.md
  // §5.2). The ring replaces in place, so this is decided before it begins.
  uint8_t elements = 0U;
  if (detail::countReadableKeys(body, len, at, elements) == 0U && elements > 0U) {
    result.rejected = elements;
    return result;
  }
  ring.beginReplace();
  detail::stageDays(body, len, ring);
  detail::stageKeys(body, len, at, ring, result);
  ring.commitReplace();
  result.dropped = ring.dropped();
  result.keysReplaced = true;
  return result;
}

} // namespace devlink

#endif // CRUSADERS_DEVLINK_CODESYNC_H

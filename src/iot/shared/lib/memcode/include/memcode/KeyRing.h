// Crusaders Mainframe — the per-day keys a device verifies OFF codes with.
//
// WHAT A DEVICE HOLDS
// -------------------
// For each member it may have to admit offline, that member's K_day for the
// club day — or for each of the two days a roster window can straddle — and
// nothing else. Never a member secret, never the master key, never an ON. So a
// stolen box or a copied roster forges OFF halves for at most the members it
// was handed and only for the days its keys cover, and every forged OFF is
// caught the moment its evidence reaches the server, because the server checks
// ON as well (docs/specs/member-code.md §7).
//
// WHY THE DAYS COME AS STEP RANGES
// --------------------------------
// The board has no calendar and no time zone. The server says which steps
// each day slot covers — `code_days: ["<first>|<end>", ...]`, half-open, at most
// two slots — and a key names its slot. A candidate step finds its slot by
// range and its key by (REF, slot). A day with a daylight-saving change is 2760
// or 3000 steps rather than 2880, and a board handed ranges never has to know.
//
// THE WIRE GRAMMAR (`code_keys` elements), fixed-width, 21 characters:
//
//     K7M2 0 <16 base64url characters = 12 bytes>
//     REF  slot  K_day
//
// No separator, because every field is fixed-width and 72 keys to a door is
// 144 bytes of separators the door's body budget does not have. The REF must
// be CANONICAL — this is server data, and a non-canonical REF there is a bug to
// refuse, not a typo to forgive.
//
// WHOLESALE, LIKE THE ROSTER
// --------------------------
// beginReplace / add / commitReplace, with the previous ring serving until the
// commit. A key that should no longer be held is expressed by its ABSENCE from
// the next push, and an empty `code_keys` commits an empty ring.
//
// No Arduino headers, no heap. Compiles for AVR, Xtensa and the host.

#ifndef CRUSADERS_MEMCODE_KEYRING_H
#define CRUSADERS_MEMCODE_KEYRING_H

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "devcrypto/Sha256.h"
#include "memcode/Token.h"
#include "memcode/Totp.h"

namespace memcode {

/// Day slots a ring can hold: today, and the day a roster window runs into.
inline constexpr uint8_t kMaxDaySlots = 2U;

/// The longest day a slot may span: 26 hours. Daylight saving's usual hour
/// makes 25; one inhabited zone (Antarctica/Troll) shifts by two.
inline constexpr uint32_t kMaxDaySteps = 3120U;

/// Characters of a `code_keys` element, and of its base64url key field.
inline constexpr size_t kKeyFieldLen = 16U;
inline constexpr size_t kKeyElementLen = kRefLen + 1U + kKeyFieldLen;

static_assert(kKeyElementLen == 21U, "REF + slot + sixteen base64url characters");

/// One day slot, as `code_days` delivered it: steps [firstStep, endStep).
struct DaySlot {
  uint32_t firstStep = 0U;
  uint32_t endStep = 0U;
  bool valid = false;
};

/// One member's key for one day slot.
struct DayKey {
  uint32_t ref = 0U;
  uint8_t slot = 0U;
  uint8_t key[kDayKeyBytes] = {};
};

/// Parses one `code_keys` element of `len` bytes. False, with `out` untouched,
/// on any length but 21, a non-canonical or reserved REF, a slot other than `0`
/// or `1`, or a key field that is not exactly twelve bytes of strict base64url.
bool parseKeyElement(const char* text, size_t len, DayKey& out);

/// Parses one `code_days` element: `<first>|<end>`, two unsigned decimal step
/// numbers, first < end, and at most kMaxDaySteps apart. False, with `out`
/// untouched, on anything else.
bool parseDaySlot(const char* text, size_t len, DaySlot& out);

template <uint8_t Capacity> class KeyRing {
public:
  static_assert(Capacity >= 1U, "a ring of nothing verifies nobody");

  void beginReplace() {
    stagingCount_ = 0U;
    stagingDropped_ = 0U;
    for (uint8_t i = 0U; i < kMaxDaySlots; ++i) {
      stagingDays_[i] = DaySlot();
    }
    replacing_ = true;
  }

  /// Sets day slot `slot` of the replacement in progress.
  bool setDay(uint8_t slot, const DaySlot& day) {
    if (!replacing_ || slot >= kMaxDaySlots || !day.valid) {
      return false;
    }
    stagingDays_[slot] = day;
    return true;
  }

  /// Whether slot `slot` of the replacement in progress holds a day. A key
  /// naming a slot that does not is refused: it could never be looked up.
  bool stagedDay(uint8_t slot) const { return slot < kMaxDaySlots && stagingDays_[slot].valid; }

  /// Adds a key to the replacement. False when full — counted in dropped(),
  /// because a key that did not fit is a member refused offline.
  bool add(const DayKey& key) {
    if (!replacing_) {
      return false;
    }
    if (stagingCount_ >= Capacity) {
      if (stagingDropped_ < UINT8_MAX) {
        ++stagingDropped_;
      }
      return false;
    }
    staging_[stagingCount_] = key;
    ++stagingCount_;
    return true;
  }

  /// Commits the replacement. KEY MATERIAL IS WIPED on the way: the staging
  /// copy once it is live, and whatever tail of the old ring the new one did
  /// not overwrite — a key a board no longer holds must not still be in its RAM.
  void commitReplace() {
    if (!replacing_) {
      return;
    }
    for (uint8_t i = 0U; i < stagingCount_; ++i) {
      keys_[i] = staging_[i];
    }
    dc::wipe(keys_ + stagingCount_, sizeof(DayKey) * (Capacity - stagingCount_));
    dc::wipe(staging_, sizeof(staging_));
    for (uint8_t i = 0U; i < kMaxDaySlots; ++i) {
      days_[i] = stagingDays_[i];
    }
    count_ = stagingCount_;
    dropped_ = stagingDropped_;
    stagingCount_ = 0U;
    replacing_ = false;
  }

  /// Empties the ring now, keys wiped. A board taken out of service verifies
  /// nobody and keeps nothing.
  void clear() {
    dc::wipe(keys_, sizeof(keys_));
    dc::wipe(staging_, sizeof(staging_));
    count_ = 0U;
    stagingCount_ = 0U;
    dropped_ = 0U;
    for (uint8_t i = 0U; i < kMaxDaySlots; ++i) {
      days_[i] = DaySlot();
    }
    replacing_ = false;
  }

  /// The key for (`ref`, the slot whose range holds `step`), or null.
  const uint8_t* keyFor(uint32_t ref, uint32_t step) const {
    for (uint8_t s = 0U; s < kMaxDaySlots; ++s) {
      const DaySlot& day = days_[s];
      if (!day.valid || step < day.firstStep || step >= day.endStep) {
        continue;
      }
      for (uint8_t i = 0U; i < count_; ++i) {
        if (keys_[i].ref == ref && keys_[i].slot == s) {
          return keys_[i].key;
        }
      }
    }
    return nullptr;
  }

  const DayKey& at(uint8_t index) const { return keys_[index]; }

  const DaySlot& day(uint8_t slot) const { return days_[slot]; }

  uint8_t size() const { return count_; }

  /// Keys that did not fit the most recent replacement.
  uint8_t dropped() const { return dropped_; }

  static constexpr uint8_t capacity() { return Capacity; }

private:
  DayKey keys_[Capacity];
  DayKey staging_[Capacity];
  DaySlot days_[kMaxDaySlots];
  DaySlot stagingDays_[kMaxDaySlots];
  uint8_t count_ = 0U;
  uint8_t stagingCount_ = 0U;
  uint8_t dropped_ = 0U;
  uint8_t stagingDropped_ = 0U;
  bool replacing_ = false;
};

} // namespace memcode

#endif // CRUSADERS_MEMCODE_KEYRING_H

// Crusaders Mainframe — recording fake for hal::IStore.
//
// WHAT IT CAN SIMULATE, AND WHY EACH ONE IS REAL
// ----------------------------------------------
//   setWriteFailure() / failNextWrite()
//       The write is refused outright and nothing changes. The clean failure.
//
//   tearNextWriteAfter(n)
//       Power goes away n bytes into the record. The first n bytes hold the NEW
//       value, the rest still hold the OLD one, and the stored length is
//       unchanged — the length is written last, on purpose, because a length
//       written first makes a half-written record look complete to the next
//       reader. put() reports kWriteFailed, and then get() cheerfully returns
//       the mongrel value with kOk, because nothing in EEPROM or LittleFS
//       remembers that a write was interrupted.
//
//       This is the case that decides an interface: it is why every caller must
//       store an integrity check with the value and treat a mismatch as absent.
//       A court box shares a board with four switching relay coils and lives
//       behind a breaker; losing power mid-write is a normal event over a
//       device's life, not a thought experiment.
//
//   setWriteLimit(n) [+ setSilentWearOut(true)]
//       Endurance. ATmega EEPROM is ~100k cycles per cell and LittleFS wears
//       its flash too — a device that rewrites a token every heartbeat gets
//       there. Reporting kWornOut is the polite version. The default-off silent
//       mode is the honest one: real cells mostly do NOT report, the write
//       claims success and the cell reads back stale, so code that only handles
//       the kWornOut enumerator has not actually handled wear-out.
//
// No Arduino headers, no heap, no String.

#ifndef CRUSADERS_FAKES_FAKESTORE_H
#define CRUSADERS_FAKES_FAKESTORE_H

#include <stdint.h>
#include <string.h>

#include "hal/Store.h"

namespace fakes {

class FakeStore final : public hal::IStore {
public:
  /// Device id, bridge token, WiFi SSID, WiFi password, court map, plus room to
  /// prove kNoSpace is reachable in a test.
  static constexpr uint8_t kSlots = 6U;

  hal::StoreResult put(const char* key, const uint8_t* value, uint8_t len) override {
    if (!validKey(key) || value == nullptr || len > hal::kStoreMaxValueLen) {
      return hal::StoreResult::kTooLarge;
    }
    if (consumeWriteFailure()) {
      return hal::StoreResult::kWriteFailed;
    }
    const uint8_t slot = slotFor(key);
    if (slot >= kSlots) {
      return hal::StoreResult::kNoSpace;
    }
    return commit(slot, key, value, len);
  }

  hal::StoreResult get(const char* key, uint8_t* out, uint8_t cap, uint8_t& outLen) override {
    outLen = 0U;
    if (!validKey(key) || out == nullptr) {
      return hal::StoreResult::kTooLarge;
    }
    const uint8_t slot = find(key);
    if (slot >= kSlots) {
      return hal::StoreResult::kNotFound;
    }
    if (length_[slot] > cap) {
      return hal::StoreResult::kTooLarge;
    }
    for (uint8_t i = 0U; i < length_[slot]; ++i) {
      out[i] = value_[slot][i];
    }
    outLen = length_[slot];
    ++reads_;
    return hal::StoreResult::kOk;
  }

  hal::StoreResult erase(const char* key) override {
    if (!validKey(key)) {
      return hal::StoreResult::kTooLarge;
    }
    const uint8_t slot = find(key);
    if (slot >= kSlots) {
      return hal::StoreResult::kNotFound;
    }
    used_[slot] = false;
    length_[slot] = 0U;
    key_[slot][0] = '\0';
    return hal::StoreResult::kOk;
  }

  // --- stimulus ------------------------------------------------------------

  /// Fail exactly the next put(), then behave normally.
  void failNextWrite() { failNext_ = true; }

  /// Fail every put() until switched off.
  void setWriteFailure(bool failing) { failAll_ = failing; }

  /// The next put() copies only `bytes` bytes of the new value and reports
  /// kWriteFailed. See the file header — the stored length does not change.
  void tearNextWriteAfter(uint8_t bytes) {
    tearArmed_ = true;
    tearBytes_ = bytes;
  }

  /// Writes per slot before the cell is worn out. 0 disables the limit.
  void setWriteLimit(uint16_t limit) { writeLimit_ = limit; }

  /// When true, a worn cell reports kOk and keeps its old contents instead of
  /// reporting kWornOut. This is what real hardware does.
  void setSilentWearOut(bool silent) { silentWearOut_ = silent; }

  // --- observation ---------------------------------------------------------

  bool exists(const char* key) const { return find(key) < kSlots; }

  /// Completed and torn writes to a key's slot, which is what wears a cell —
  /// a torn write still costs an erase cycle.
  uint16_t writeCount(const char* key) const {
    const uint8_t slot = find(key);
    return slot < kSlots ? writes_[slot] : 0U;
  }

  uint8_t slotsUsed() const {
    uint8_t count = 0U;
    for (uint8_t i = 0U; i < kSlots; ++i) {
      if (used_[i]) {
        ++count;
      }
    }
    return count;
  }

  uint16_t reads() const { return reads_; }

private:
  /// Length of `key`, stopping one past the limit. Hand-rolled rather than
  /// strnlen() because strnlen is not in AVR's newlib-nano and this header is
  /// held to the same no-surprises rule as the firmware it stands in for.
  /// A return of kStoreMaxKeyLen + 1 means "too long", not a real length.
  static uint8_t boundedKeyLen(const char* key) {
    uint8_t n = 0U;
    while (n <= hal::kStoreMaxKeyLen && key[n] != '\0') {
      ++n;
    }
    return n;
  }

  static bool validKey(const char* key) {
    if (key == nullptr || key[0] == '\0') {
      return false;
    }
    return boundedKeyLen(key) <= hal::kStoreMaxKeyLen;
  }

  uint8_t find(const char* key) const {
    if (key == nullptr) {
      return kSlots;
    }
    for (uint8_t i = 0U; i < kSlots; ++i) {
      if (used_[i] && strncmp(key_[i], key, static_cast<size_t>(hal::kStoreMaxKeyLen) + 1U) == 0) {
        return i;
      }
    }
    return kSlots;
  }

  /// The slot this key already occupies, or a free one. kSlots when the store
  /// is full.
  uint8_t slotFor(const char* key) {
    const uint8_t existing = find(key);
    if (existing < kSlots) {
      return existing;
    }
    for (uint8_t i = 0U; i < kSlots; ++i) {
      if (!used_[i]) {
        return i;
      }
    }
    return kSlots;
  }

  bool consumeWriteFailure() {
    if (failAll_) {
      return true;
    }
    if (failNext_) {
      failNext_ = false;
      return true;
    }
    return false;
  }

  hal::StoreResult commit(uint8_t slot, const char* key, const uint8_t* value, uint8_t len) {
    if (worn(slot)) {
      ++writes_[slot];
      return silentWearOut_ ? hal::StoreResult::kOk : hal::StoreResult::kWornOut;
    }
    const bool fresh = !used_[slot];
    if (fresh) {
      claim(slot, key);
    }
    ++writes_[slot];
    if (tearArmed_) {
      return tear(slot, value, len, fresh);
    }
    for (uint8_t i = 0U; i < len; ++i) {
      value_[slot][i] = value[i];
    }
    length_[slot] = len;
    return hal::StoreResult::kOk;
  }

  bool worn(uint8_t slot) const { return writeLimit_ > 0U && writes_[slot] >= writeLimit_; }

  void claim(uint8_t slot, const char* key) {
    used_[slot] = true;
    length_[slot] = 0U;
    const uint8_t keyLen = boundedKeyLen(key);
    for (uint8_t i = 0U; i < keyLen; ++i) {
      key_[slot][i] = key[i];
    }
    key_[slot][keyLen] = '\0';
  }

  /// Copy the first tearBytes_ bytes and stop. A slot created by a torn write
  /// keeps whatever length the interrupted write managed, which is the honest
  /// outcome: nothing recorded that it was ever complete.
  hal::StoreResult tear(uint8_t slot, const uint8_t* value, uint8_t len, bool fresh) {
    tearArmed_ = false;
    const uint8_t stop = tearBytes_ < len ? tearBytes_ : len;
    for (uint8_t i = 0U; i < stop; ++i) {
      value_[slot][i] = value[i];
    }
    if (fresh) {
      length_[slot] = stop;
    }
    return hal::StoreResult::kWriteFailed;
  }

  char key_[kSlots][hal::kStoreMaxKeyLen + 1U] = {};
  uint8_t value_[kSlots][hal::kStoreMaxValueLen] = {};
  uint8_t length_[kSlots] = {};
  bool used_[kSlots] = {};
  uint16_t writes_[kSlots] = {};

  bool failNext_ = false;
  bool failAll_ = false;
  bool tearArmed_ = false;
  uint8_t tearBytes_ = 0U;
  uint16_t writeLimit_ = 0U;
  bool silentWearOut_ = false;
  uint16_t reads_ = 0U;
};

} // namespace fakes

#endif // CRUSADERS_FAKES_FAKESTORE_H

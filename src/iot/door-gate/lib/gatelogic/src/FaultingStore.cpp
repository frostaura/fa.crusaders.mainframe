#include "gatelogic/FaultingStore.h"

namespace gatelogic {

hal::StoreResult FaultingStore::put(const char* key, const uint8_t* value, uint8_t len) {
  if (inner_ == nullptr) {
    // The same answer `EventQueue` already expects from no store at all. Not a
    // fault: a board built without persistence is a choice, not a failure.
    return hal::StoreResult::kNotFound;
  }
  const hal::StoreResult result = inner_->put(key, value, len);
  if (result != hal::StoreResult::kOk) {
    // EVERY NON-OK RESULT, not `kWriteFailed` alone. `kNoSpace`, `kTooLarge`
    // and `kWornOut` all mean the same thing to the one record this board keeps
    // — the sequence mark did not get where it was going — and a counter that
    // only knew one enumerator would read as healthy on a full partition.
    faults_.record(kFaultNvsWriteFailed, clock_.nowMs());
  }
  return result;
}

hal::StoreResult FaultingStore::get(const char* key, uint8_t* out, uint8_t cap, uint8_t& outLen) {
  if (inner_ == nullptr) {
    outLen = 0U;
    return hal::StoreResult::kNotFound;
  }
  // NOT COUNTED. A `get` that answers `kNotFound` is the normal first boot of
  // every board ever flashed, and a fault raised on it would fire once on every
  // healthy board and teach whoever reads the trail to ignore the code.
  return inner_->get(key, out, cap, outLen);
}

hal::StoreResult FaultingStore::erase(const char* key) {
  if (inner_ == nullptr) {
    return hal::StoreResult::kNotFound;
  }
  // Not counted either: nothing on this board erases the sequence mark in
  // normal service, so an erase is a person doing something deliberate.
  return inner_->erase(key);
}

} // namespace gatelogic

#include "otacore/BootGuard.h"

#include <string.h>

namespace ota {

namespace {

/// The pending record is "<attempts>:<version>". One byte of count and a version
/// string, comfortably inside hal::kStoreMaxValueLen.
constexpr char kSeparator = ':';

bool copyBounded(char* dest, size_t destCap, const char* src, size_t srcLen) {
  if (srcLen + 1U > destCap) {
    return false;
  }
  memcpy(dest, src, srcLen);
  dest[srcLen] = '\0';
  return true;
}

} // namespace

void BootGuard::writePending(const char* version, uint8_t attempts) {
  if (store_ == nullptr) {
    return;
  }
  char record[hal::kStoreMaxValueLen];
  const size_t versionLen = strlen(version);
  if (versionLen + 2U > sizeof(record)) {
    return;
  }
  record[0] = static_cast<char>('0' + (attempts % 10U));
  record[1] = kSeparator;
  memcpy(record + 2U, version, versionLen);

  static_cast<void>(store_->put(kKeyPending, reinterpret_cast<const uint8_t*>(record),
                                static_cast<uint8_t>(versionLen + 2U)));
}

void BootGuard::clearPending() {
  if (store_ != nullptr) {
    static_cast<void>(store_->erase(kKeyPending));
  }
  pending_[0] = '\0';
  attempts_ = 0U;
}

BootState BootGuard::begin() {
  state_ = BootState::Settled;
  attempts_ = 0U;
  pending_[0] = '\0';
  bad_[0] = '\0';

  if (store_ == nullptr) {
    return state_;
  }

  uint8_t raw[hal::kStoreMaxValueLen];
  uint8_t len = 0U;
  if (store_->get(kKeyBad, raw, sizeof(raw), len) == hal::StoreResult::kOk && len > 0U) {
    static_cast<void>(copyBounded(bad_, sizeof(bad_), reinterpret_cast<const char*>(raw), len));
  }

  len = 0U;
  if (store_->get(kKeyPending, raw, sizeof(raw), len) != hal::StoreResult::kOk || len < 3U ||
      raw[1] != static_cast<uint8_t>(kSeparator)) {
    // No marker, or one too short or malformed to trust. Either way there is no
    // update to prove, so this is an ordinary boot.
    return state_;
  }

  const uint8_t previous = static_cast<uint8_t>(raw[0] - static_cast<uint8_t>('0'));
  if (!copyBounded(pending_, sizeof(pending_), reinterpret_cast<const char*>(raw + 2), len - 2U)) {
    return state_;
  }

  attempts_ = static_cast<uint8_t>(previous + 1U);

  if (attempts_ >= kMaxAttempts) {
    // Rebooted through its allowance without ever making an accepted API call.
    // Condemn the build so the box stops taking it, and clear the marker so the
    // NEXT update — the fix — gets a clean set of attempts.
    state_ = BootState::Failed;
    static_cast<void>(copyBounded(bad_, sizeof(bad_), pending_, strlen(pending_)));
    static_cast<void>(
        store_->put(kKeyBad, reinterpret_cast<const uint8_t*>(bad_), static_cast<uint8_t>(strlen(bad_))));
    clearPending();
    return state_;
  }

  state_ = BootState::Proving;
  writePending(pending_, attempts_);
  return state_;
}

void BootGuard::arm(const char* version) {
  if (version == nullptr || version[0] == '\0') {
    return;
  }
  // Attempt zero: begin() increments, so the first boot of the new image counts
  // as attempt one.
  writePending(version, 0U);
}

void BootGuard::confirm() {
  if (state_ != BootState::Proving) {
    return;
  }
  // The update worked. Note this is driven by an ACCEPTED API call and nothing
  // else — a firmware that boots and cannot authenticate is worse than one that
  // does not boot, because it looks alive.
  clearPending();
  state_ = BootState::Settled;
}

bool BootGuard::isKnownBad(const char* version) const {
  if (version == nullptr || bad_[0] == '\0') {
    return false;
  }
  return strcmp(version, bad_) == 0;
}

} // namespace ota

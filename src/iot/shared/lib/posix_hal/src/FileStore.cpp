// The file-backed store. See include/posix_hal/FileStore.h.

#include "posix_hal/FileStore.h"

#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

namespace posix_hal {

namespace {

bool validKey(const char* key) {
  if (key == nullptr || key[0] == '\0') {
    return false;
  }
  for (uint8_t i = 0U; i <= hal::kStoreMaxKeyLen; ++i) {
    if (key[i] == '\0') {
      return true;
    }
    // Keys become path components. A '/' or a '.' would let one key name a file
    // outside the store directory, which is a path-traversal bug in something
    // whose whole job is holding a device key.
    if (key[i] == '/' || key[i] == '.') {
      return false;
    }
  }
  return false;
}

} // namespace

FileStore::FileStore() : dir_(), ready_(false) {
  dir_[0] = '\0';
}

bool FileStore::begin(const char* dir) {
  if (dir == nullptr) {
    return false;
  }
  const size_t len = strlen(dir);
  if (len == 0U || len + 1U >= kStorePathMax) {
    return false;
  }
  memcpy(dir_, dir, len + 1U);
  // Already existing is success: a simulator restarted against the same store
  // directory is the point of having one.
  if (::mkdir(dir_, 0700) != 0 && ::access(dir_, W_OK) != 0) {
    return false;
  }
  ready_ = true;
  return true;
}

bool FileStore::pathFor(const char* key, char* out, uint16_t cap) const {
  const int written = snprintf(out, cap, "%s/%s", dir_, key);
  return written > 0 && static_cast<uint16_t>(written) < cap;
}

hal::StoreResult FileStore::put(const char* key, const uint8_t* value, uint8_t len) {
  if (!validKey(key) || value == nullptr || len > hal::kStoreMaxValueLen) {
    return hal::StoreResult::kTooLarge;
  }
  char path[kStorePathMax];
  if (!ready_ || !pathFor(key, path, kStorePathMax)) {
    return hal::StoreResult::kWriteFailed;
  }
  FILE* file = fopen(path, "wb");
  if (file == nullptr) {
    return hal::StoreResult::kWriteFailed;
  }
  const size_t wrote = len == 0U ? 0U : fwrite(value, 1U, len, file);
  const bool closed = fclose(file) == 0;
  return (wrote == len && closed) ? hal::StoreResult::kOk : hal::StoreResult::kWriteFailed;
}

hal::StoreResult FileStore::get(const char* key, uint8_t* out, uint8_t cap, uint8_t& outLen) {
  outLen = 0U;
  if (!validKey(key) || out == nullptr) {
    return hal::StoreResult::kTooLarge;
  }
  char path[kStorePathMax];
  if (!ready_ || !pathFor(key, path, kStorePathMax)) {
    return hal::StoreResult::kNotFound;
  }
  FILE* file = fopen(path, "rb");
  if (file == nullptr) {
    return hal::StoreResult::kNotFound;
  }
  uint8_t buffer[hal::kStoreMaxValueLen + 1U];
  const size_t got = fread(buffer, 1U, sizeof(buffer), file);
  static_cast<void>(fclose(file));
  if (got > hal::kStoreMaxValueLen) {
    // Longer than this store can have written, so it is not one of its records.
    return hal::StoreResult::kNotFound;
  }
  if (got > cap) {
    return hal::StoreResult::kTooLarge;
  }
  memcpy(out, buffer, got);
  outLen = static_cast<uint8_t>(got);
  return hal::StoreResult::kOk;
}

hal::StoreResult FileStore::erase(const char* key) {
  if (!validKey(key)) {
    return hal::StoreResult::kTooLarge;
  }
  char path[kStorePathMax];
  if (!ready_ || !pathFor(key, path, kStorePathMax)) {
    return hal::StoreResult::kNotFound;
  }
  // Reported, not treated as success: an absent key is how a typo in the
  // factory-reset path shows itself.
  return ::unlink(path) == 0 ? hal::StoreResult::kOk : hal::StoreResult::kNotFound;
}

} // namespace posix_hal

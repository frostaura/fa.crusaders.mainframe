// The ESP8266 LittleFS store. See include/arduino_hal/LittleFsStore.h.

#include "arduino_hal/LittleFsStore.h"

#ifdef TARGET_COURT_BRIDGE

#include <Arduino.h>

#include <LittleFS.h>
#include <string.h>

namespace arduino_hal {

namespace {

/// "/kv/" plus the longest key plus a terminator.
constexpr size_t kPathLen = sizeof(kStoreDir) + 1U + hal::kStoreMaxKeyLen + 1U;

bool validKey(const char* key) {
  if (key == nullptr || key[0] == '\0') {
    return false;
  }
  for (uint8_t i = 0U; i <= hal::kStoreMaxKeyLen; ++i) {
    if (key[i] == '\0') {
      return true;
    }
    // Keys become path components, so a '/' would silently create a
    // subdirectory and two different keys could name one file.
    if (key[i] == '/') {
      return false;
    }
  }
  return false;
}

bool pathFor(const char* key, char* out, size_t cap) {
  const size_t keyLen = strlen(key);
  const size_t need = strlen(kStoreDir) + 1U + keyLen + 1U;
  if (need > cap) {
    return false;
  }
  strcpy(out, kStoreDir);
  strcat(out, "/");
  strcat(out, key);
  return true;
}

} // namespace

LittleFsStore::LittleFsStore() : mounted_(false) {
}

bool LittleFsStore::begin() {
  mounted_ = LittleFS.begin();
  if (!mounted_) {
    // A partition that has never been written has no filesystem on it. One
    // format on first boot is expected; a format on every boot would be a
    // device that loses its key at each power cut, so this is not retried.
    mounted_ = LittleFS.format() && LittleFS.begin();
  }
  if (mounted_) {
    LittleFS.mkdir(kStoreDir);
  }
  return mounted_;
}

hal::StoreResult LittleFsStore::put(const char* key, const uint8_t* value, uint8_t len) {
  if (!validKey(key) || value == nullptr || len > hal::kStoreMaxValueLen) {
    return hal::StoreResult::kTooLarge;
  }
  char path[kPathLen];
  if (!mounted_ || !pathFor(key, path, sizeof(path))) {
    return hal::StoreResult::kWriteFailed;
  }
  File file = LittleFS.open(path, "w");
  if (!file) {
    return hal::StoreResult::kWriteFailed;
  }
  const size_t wrote = len == 0U ? 0U : file.write(value, len);
  file.close();
  if (wrote != len) {
    // The file exists and holds some prefix of the new value. Reported as
    // kWriteFailed with the record partially updated, exactly as the port's
    // contract describes; the caller's integrity check is what catches it.
    return hal::StoreResult::kWriteFailed;
  }
  return hal::StoreResult::kOk;
}

hal::StoreResult LittleFsStore::get(const char* key, uint8_t* out, uint8_t cap, uint8_t& outLen) {
  outLen = 0U;
  if (!validKey(key) || out == nullptr) {
    return hal::StoreResult::kTooLarge;
  }
  char path[kPathLen];
  if (!mounted_ || !pathFor(key, path, sizeof(path))) {
    return hal::StoreResult::kNotFound;
  }
  File file = LittleFS.open(path, "r");
  if (!file) {
    return hal::StoreResult::kNotFound;
  }
  const size_t size = file.size();
  if (size > hal::kStoreMaxValueLen) {
    // Not a record this store wrote. Truncating to the first 32 bytes would
    // hand back a value nobody ever stored.
    file.close();
    return hal::StoreResult::kNotFound;
  }
  if (size > cap) {
    file.close();
    return hal::StoreResult::kTooLarge;
  }
  const size_t read = size == 0U ? 0U : file.read(out, size);
  file.close();
  if (read != size) {
    return hal::StoreResult::kNotFound;
  }
  outLen = static_cast<uint8_t>(size);
  return hal::StoreResult::kOk;
}

hal::StoreResult LittleFsStore::erase(const char* key) {
  if (!validKey(key)) {
    return hal::StoreResult::kTooLarge;
  }
  char path[kPathLen];
  if (!mounted_ || !pathFor(key, path, sizeof(path))) {
    return hal::StoreResult::kNotFound;
  }
  if (!LittleFS.exists(path)) {
    return hal::StoreResult::kNotFound;
  }
  return LittleFS.remove(path) ? hal::StoreResult::kOk : hal::StoreResult::kWriteFailed;
}

} // namespace arduino_hal

#endif // TARGET_COURT_BRIDGE

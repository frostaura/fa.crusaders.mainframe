#include "bridgelogic/CredentialStore.h"

#include <string.h>

namespace bridgelogic {

// --- checked text records ------------------------------------------------

uint8_t crc8(const uint8_t* data, size_t len) {
  uint8_t crc = 0U;
  for (size_t i = 0U; i < len; ++i) {
    crc = static_cast<uint8_t>(crc ^ data[i]);
    for (uint8_t bit = 0U; bit < 8U; ++bit) {
      crc = (crc & 0x80U) != 0U ? static_cast<uint8_t>(static_cast<uint8_t>(crc << 1) ^ 0x07U)
                                : static_cast<uint8_t>(crc << 1);
    }
  }
  return crc;
}

bool putCheckedText(hal::IStore& store, const char* key, const char* text) {
  if (text == nullptr) {
    return false;
  }
  const size_t n = strlen(text);
  if (n + 1U > hal::kStoreMaxValueLen) {
    return false;
  }
  uint8_t record[hal::kStoreMaxValueLen];
  memcpy(record, text, n);
  record[n] = crc8(record, n);
  return store.put(key, record, static_cast<uint8_t>(n + 1U)) == hal::StoreResult::kOk;
}

bool getCheckedText(hal::IStore& store, const char* key, char* out, size_t cap) {
  if (out == nullptr || cap == 0U) {
    return false;
  }
  out[0] = '\0';
  uint8_t record[hal::kStoreMaxValueLen];
  uint8_t len = 0U;
  if (store.get(key, record, sizeof(record), len) != hal::StoreResult::kOk || len == 0U) {
    return false;
  }
  const size_t n = static_cast<size_t>(len) - 1U;
  if (record[n] != crc8(record, n) || n + 1U > cap) {
    return false;
  }
  memcpy(out, record, n);
  out[n] = '\0';
  return true;
}

// --- the API base URL -----------------------------------------------------

bool loadApiUrl(hal::IStore& store, char* out, size_t cap) {
  if (getCheckedText(store, kKeyApiBase, out, cap)) {
    return true;
  }
  // A box provisioned before the checked record existed. Unchecked and
  // 32-byte capped, exactly as it was written.
  uint8_t raw[hal::kStoreMaxValueLen];
  uint8_t len = 0U;
  if (store.get(kKeyApiUrlLegacy, raw, sizeof(raw), len) != hal::StoreResult::kOk || len == 0U ||
      static_cast<size_t>(len) + 1U > cap) {
    out[0] = '\0';
    return false;
  }
  memcpy(out, raw, len);
  out[len] = '\0';
  return true;
}

bool storeApiUrl(hal::IStore& store, const char* url) {
  if (url == nullptr || url[0] == '\0' || strlen(url) > kMaxApiUrlLen) {
    return false;
  }
  if (!putCheckedText(store, kKeyApiBase, url)) {
    return false;
  }
  // Retired, not required: a legacy record that will not erase is a record
  // that is simply never read again, because api_base is checked first.
  static_cast<void>(store.erase(kKeyApiUrlLegacy));
  return true;
}

} // namespace bridgelogic

#include "bridgelogic/CredentialStore.h"

#include <string.h>

namespace bridgelogic {

namespace {

constexpr char kWifiPrefix[] = "!WIFI,";
constexpr size_t kWifiPrefixLen = sizeof(kWifiPrefix) - 1U;

bool hexNibble(char c, uint8_t& out) {
  if (c >= '0' && c <= '9') {
    out = static_cast<uint8_t>(c - '0');
    return true;
  }
  if (c >= 'A' && c <= 'F') {
    out = static_cast<uint8_t>(10 + (c - 'A'));
    return true;
  }
  if (c >= 'a' && c <= 'f') {
    out = static_cast<uint8_t>(10 + (c - 'a'));
    return true;
  }
  return false;
}

/// Copies `[start, end)` of `line` into `out`, unescaping `%XX`. False when
/// the result would not fit `cap` or an escape is malformed.
bool unescapeInto(const char* line, size_t start, size_t end, char* out, size_t cap) {
  size_t n = 0U;
  size_t i = start;
  while (i < end) {
    char c = line[i];
    if (c == '%') {
      uint8_t hi = 0U;
      uint8_t lo = 0U;
      if (i + 2U >= end || !hexNibble(line[i + 1U], hi) || !hexNibble(line[i + 2U], lo)) {
        return false;
      }
      c = static_cast<char>(static_cast<uint8_t>(hi << 4) | lo);
      i += 3U;
    } else {
      ++i;
    }
    if (n + 1U >= cap) {
      return false;
    }
    out[n] = c;
    ++n;
  }
  out[n] = '\0';
  return true;
}

uint8_t xorOf(const char* s, size_t n) {
  uint8_t x = 0U;
  for (size_t i = 0U; i < n; ++i) {
    x = static_cast<uint8_t>(x ^ static_cast<uint8_t>(s[i]));
  }
  return x;
}

void copyBounded(char* out, size_t cap, const char* text) {
  size_t n = 0U;
  while (text[n] != '\0' && n + 1U < cap) {
    out[n] = text[n];
    ++n;
  }
  out[n] = '\0';
}

} // namespace

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

// --- the WiFi credential --------------------------------------------------

bool WifiCredential::set(const char* newSsid, const char* newPassword) {
  ssid[0] = '\0';
  password[0] = '\0';
  if (newSsid == nullptr || newPassword == nullptr || newSsid[0] == '\0' || strlen(newSsid) > kMaxSsidLen ||
      strlen(newPassword) > kMaxWifiPasswordLen) {
    return false;
  }
  copyBounded(ssid, sizeof(ssid), newSsid);
  copyBounded(password, sizeof(password), newPassword);
  return true;
}

bool WifiCredential::equals(const WifiCredential& other) const {
  return strcmp(ssid, other.ssid) == 0 && strcmp(password, other.password) == 0;
}

WifiSource chooseWifiCredential(const WifiCredential& compiledIn, const WifiCredential& stored,
                                WifiCredential& out) {
  // The store first. A `!WIFI` rotation has to survive a power cycle, and it
  // only does if what the technician typed outranks what the image was built
  // with — see the header for what the other order cost.
  if (stored.present()) {
    out = stored;
    return WifiSource::Stored;
  }
  if (compiledIn.present()) {
    out = compiledIn;
    return WifiSource::CompiledIn;
  }
  out = WifiCredential();
  return WifiSource::None;
}

void WifiJoinPlan::begin(WifiSource source, bool alternate, uint32_t nowMs) {
  source_ = source;
  alternate_ = alternate && source != WifiSource::None;
  switchAt_.disarm();
  if (alternate_) {
    switchAt_.arm(nowMs, kWifiJoinFallbackMs);
  }
}

WifiSwitch WifiJoinPlan::tick(uint32_t nowMs) {
  if (!alternate_ || !switchAt_.expired(nowMs)) {
    return WifiSwitch::None;
  }
  switchAt_.arm(nowMs, kWifiJoinFallbackMs);
  if (source_ == WifiSource::Stored) {
    source_ = WifiSource::CompiledIn;
    return WifiSwitch::ToCompiledIn;
  }
  source_ = WifiSource::Stored;
  return WifiSwitch::ToStored;
}

void WifiJoinPlan::joined() {
  alternate_ = false;
  switchAt_.disarm();
}

void WifiJoinPlan::restart(uint32_t nowMs) {
  static_cast<void>(nowMs);
  source_ = WifiSource::Stored;
  alternate_ = false;
  switchAt_.disarm();
}

bool shouldPersistWifi(const WifiCredential& joined, const WifiCredential& stored) {
  return joined.present() && !joined.equals(stored);
}

bool loadWifiCredential(hal::IStore& store, WifiCredential& out) {
  out = WifiCredential();
  char ssid[kMaxSsidLen + 1U] = {};
  char password[kMaxWifiPasswordLen + 1U] = {};
  if (!getCheckedText(store, kKeyWifiSsid, ssid, sizeof(ssid)) ||
      !getCheckedText(store, kKeyWifiPassword, password, sizeof(password))) {
    return false;
  }
  return out.set(ssid, password);
}

bool storeWifiCredential(hal::IStore& store, const WifiCredential& credential) {
  if (!credential.present()) {
    return false;
  }
  // SSID last: a torn write between the two leaves a password with no SSID,
  // which loads as absent, rather than an SSID with the previous password,
  // which loads as a credential that does not work.
  return putCheckedText(store, kKeyWifiPassword, credential.password) &&
         putCheckedText(store, kKeyWifiSsid, credential.ssid);
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

// --- the `!WIFI` provisioning line ----------------------------------------

bool parseWifiLine(const char* line, size_t n, WifiCredential& out) {
  out = WifiCredential();
  if (line == nullptr || n <= kWifiPrefixLen || strncmp(line, kWifiPrefix, kWifiPrefixLen) != 0) {
    return false;
  }

  // An optional `*CC` trailer, verified over everything between `!` and `*`
  // — the v2 frame rule, so a technician who pastes a frame a tool produced is
  // checked and one who types by hand is not asked to compute a checksum.
  size_t bodyEnd = n;
  if (n >= 4U && line[n - 3U] == '*') {
    uint8_t hi = 0U;
    uint8_t lo = 0U;
    if (!hexNibble(line[n - 2U], hi) || !hexNibble(line[n - 1U], lo)) {
      return false;
    }
    bodyEnd = n - 3U;
    if (xorOf(line + 1U, bodyEnd - 1U) != static_cast<uint8_t>(static_cast<uint8_t>(hi << 4) | lo)) {
      return false;
    }
  }

  size_t comma = kWifiPrefixLen;
  while (comma < bodyEnd && line[comma] != ',') {
    ++comma;
  }
  if (comma >= bodyEnd) {
    return false; // no password field at all; an open network sends an empty one
  }

  char ssid[kMaxSsidLen + 1U] = {};
  char password[kMaxWifiPasswordLen + 1U] = {};
  if (!unescapeInto(line, kWifiPrefixLen, comma, ssid, sizeof(ssid)) ||
      !unescapeInto(line, comma + 1U, bodyEnd, password, sizeof(password))) {
    return false;
  }
  return out.set(ssid, password);
}

void WifiLineAssembler::reset() {
  len_ = 0U;
  discarding_ = false;
  ready_ = false;
}

bool WifiLineAssembler::feed(char c) {
  if (ready_) {
    // The previous line was handed out; this byte starts the next one.
    reset();
  }
  if (c == '\n' || c == '\r') {
    if (discarding_ || len_ <= kWifiPrefixLen) {
      reset();
      return false;
    }
    line_[len_] = '\0';
    ready_ = true;
    return true;
  }
  if (discarding_) {
    return false;
  }
  if (len_ < kWifiPrefixLen && c != kWifiPrefix[len_]) {
    // Not this line. Nothing else that travels on this UART is ever kept.
    discarding_ = true;
    return false;
  }
  if (len_ >= kMaxLineLen) {
    discarding_ = true;
    return false;
  }
  line_[len_] = c;
  ++len_;
  return false;
}

} // namespace bridgelogic

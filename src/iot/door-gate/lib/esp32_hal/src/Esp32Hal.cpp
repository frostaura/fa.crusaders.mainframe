#include "esp32_hal/Esp32Hal.h"

#include <Arduino.h>
#include <WiFiClient.h>

#include <HTTPClient.h>
#include <Preferences.h>
#include <esp_task_wdt.h>
#include <string.h>

namespace esp32_hal {
namespace {

/// The NVS namespace and the one key in it.
constexpr char kNamespace[] = "crusaders";

Preferences gPrefs;

} // namespace

// --- clock ------------------------------------------------------------------

uint32_t Esp32Clock::nowMs() {
  return static_cast<uint32_t>(millis());
}

// --- pin --------------------------------------------------------------------

void Esp32PinOut::write(hal::PinLevel level) {
  level_ = level;
  // Legal before pinMode(OUTPUT): the write lands in the output register and
  // takes effect the instant the pin starts driving. That IS the boot-safety
  // property — see the header.
  digitalWrite(pin_, hal::toDigital(level) != 0U ? HIGH : LOW);
}

void Esp32PinOut::driveOutput() {
  pinMode(pin_, OUTPUT);
  // Again, after the mode change. Belt and braces: some cores clear the output
  // latch when a pin's mode changes, and this costs one register write on a
  // path that runs twice in the life of a boot.
  digitalWrite(pin_, hal::toDigital(level_) != 0U ? HIGH : LOW);
}

// --- scanner ----------------------------------------------------------------

void Esp32Scanner::begin(uint32_t baud, uint8_t rxPin, uint8_t txPin) {
  Serial2.begin(static_cast<unsigned long>(baud), SERIAL_8N1, static_cast<int8_t>(rxPin),
                static_cast<int8_t>(txPin));
}

bool Esp32Scanner::read(uint8_t& out) {
  if (Serial2.available() <= 0) {
    return false;
  }
  const int value = Serial2.read();
  if (value < 0) {
    return false;
  }
  out = static_cast<uint8_t>(value);
  return true;
}

// --- store ------------------------------------------------------------------

bool Esp32NvsStore::begin() {
  ready_ = gPrefs.begin(kNamespace, false);
  return ready_;
}

hal::StoreResult Esp32NvsStore::put(const char* key, const uint8_t* value, uint8_t len) {
  if (!ready_ || key == nullptr || value == nullptr) {
    return hal::StoreResult::kWriteFailed;
  }
  if (strlen(key) > hal::kStoreMaxKeyLen || len > hal::kStoreMaxValueLen) {
    return hal::StoreResult::kTooLarge;
  }
  const size_t written = gPrefs.putBytes(key, value, len);
  // A short write is a torn write, which hal/Store.h says is part of the
  // contract: the stored value may be PARTIALLY updated and the caller has to
  // verify with its own integrity check rather than assume either outcome.
  return written == len ? hal::StoreResult::kOk : hal::StoreResult::kWriteFailed;
}

hal::StoreResult Esp32NvsStore::get(const char* key, uint8_t* out, uint8_t cap, uint8_t& outLen) {
  outLen = 0U;
  if (!ready_ || key == nullptr || out == nullptr) {
    return hal::StoreResult::kNotFound;
  }
  if (strlen(key) > hal::kStoreMaxKeyLen) {
    return hal::StoreResult::kTooLarge;
  }
  const size_t stored = gPrefs.getBytesLength(key);
  if (stored == 0U) {
    return hal::StoreResult::kNotFound;
  }
  if (stored > cap) {
    // Refused, never truncated. A partial record is not the record.
    return hal::StoreResult::kTooLarge;
  }
  const size_t read = gPrefs.getBytes(key, out, stored);
  if (read != stored) {
    return hal::StoreResult::kNotFound;
  }
  outLen = static_cast<uint8_t>(read);
  return hal::StoreResult::kOk;
}

hal::StoreResult Esp32NvsStore::erase(const char* key) {
  if (!ready_ || key == nullptr) {
    return hal::StoreResult::kNotFound;
  }
  // Reported rather than silently treated as success: erasing an absent key is
  // how a key typo shows up in a factory-reset path.
  return gPrefs.remove(key) ? hal::StoreResult::kOk : hal::StoreResult::kNotFound;
}

// --- http -------------------------------------------------------------------

uint16_t Esp32HttpPort::post(const char* path, const char* body, char* out, size_t outCap) {
  if (baseUrl_ == nullptr || authorization_ == nullptr || authorization_[0] == '\0') {
    return 0U;
  }

  char url[160];
  const int written = snprintf(url, sizeof(url), "%s%s", baseUrl_, path);
  if (written < 0 || static_cast<size_t>(written) >= sizeof(url)) {
    return 0U;
  }

  WiFiClient client;
  HTTPClient http;
  if (!http.begin(client, url)) {
    return 0U;
  }
  http.setTimeout(timeoutMs_);
  http.setConnectTimeout(timeoutMs_);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", authorization_);

  // The ESP32 core's HTTPClient::POST takes a NON-const payload pointer — the
  // ESP8266 core's takes a const one — and it does not write through it. The
  // cast is the whole of the difference between the two cores here, and it is
  // in the driver rather than anywhere a decision lives.
  const int status = http.POST(const_cast<uint8_t*>(reinterpret_cast<const uint8_t*>(body)), strlen(body));
  if (status > 0 && out != nullptr && outCap > 0U) {
    const String payload = http.getString();
    const size_t n = payload.length() < outCap - 1U ? payload.length() : outCap - 1U;
    memcpy(out, payload.c_str(), n);
    out[n] = '\0';
  }
  http.end();
  // A negative status is an HTTPClient error code, not an HTTP status. It maps
  // to 0 — "the request never completed" — which is the one answer that says
  // nothing about what the server thinks, and the only one the breaker counts.
  return status > 0 ? static_cast<uint16_t>(status) : 0U;
}

// --- watchdog ---------------------------------------------------------------

void watchdogBegin(uint8_t seconds) {
  esp_task_wdt_init(static_cast<uint32_t>(seconds), true);
  esp_task_wdt_add(nullptr);
}

void watchdogKick() {
  esp_task_wdt_reset();
}

} // namespace esp32_hal

// Crusaders Mainframe — hal::IStore on the ESP8266's LittleFS partition.
//
// This is the half of the box that has something to persist: the device key
// issued at claim time, the remembered API URL that makes discovery a first-run
// problem rather than a per-boot one, and the WiFi credentials. All of it is
// short — the port's uint8_t lengths are sized for identifiers and tokens, not
// blobs — so one small file per key is the whole design.
//
// WHY ONE FILE PER KEY AND NOT ONE PACKED RECORD FILE
// ---------------------------------------------------
// A packed file has to be rewritten in full to change one value, which turns
// every credential update into a window in which ALL of them are lost if the
// power goes. Separate files put that window around one key at a time. LittleFS
// is log-structured and copy-on-write, so the cost of the extra inodes is small
// and the wear is spread rather than concentrated on one file's blocks.
//
// WHY THERE IS NO INTEGRITY CHECK INSIDE THIS DRIVER
// --------------------------------------------------
// The same reason as EepromStore's: hal/Store.h puts that obligation on the
// caller, and a driver that verified for them would be stricter than
// fakes::FakeStore and would hide the recovery path the interface exists to
// force. LittleFS's own metadata CRC protects the FILESYSTEM from a torn write;
// it says nothing about whether the value in the file is the one the caller
// meant to write, which is the question that matters for a device key.
//
// A file longer than kStoreMaxValueLen reads as kNotFound rather than being
// truncated: it is not a record this store wrote, so guessing at its first 32
// bytes would hand back a value nobody stored.

#ifndef CRUSADERS_ARDUINO_HAL_LITTLEFSSTORE_H
#define CRUSADERS_ARDUINO_HAL_LITTLEFSSTORE_H

#ifdef TARGET_COURT_BRIDGE

#include <stdint.h>

#include "hal/Store.h"

namespace arduino_hal {

/// Directory holding one file per key. A directory rather than the root so a
/// future OTA staging file or log cannot collide with a key name.
inline constexpr char kStoreDir[] = "/kv";

class LittleFsStore final : public hal::IStore {
public:
  LittleFsStore();

  /// Mount the partition, formatting it once if it has never been mounted.
  /// Returns false when neither works, which is a board that cannot be claimed
  /// — worth reporting rather than discovering at the first put().
  bool begin();

  bool mounted() const { return mounted_; }

  hal::StoreResult put(const char* key, const uint8_t* value, uint8_t len) override;

  hal::StoreResult get(const char* key, uint8_t* out, uint8_t cap, uint8_t& outLen) override;

  hal::StoreResult erase(const char* key) override;

private:
  bool mounted_;
};

} // namespace arduino_hal

#endif // TARGET_COURT_BRIDGE

#endif // CRUSADERS_ARDUINO_HAL_LITTLEFSSTORE_H

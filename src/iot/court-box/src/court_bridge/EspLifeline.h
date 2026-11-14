// Crusaders Mainframe — the ESP8266 side of bridge 3.1.0's lifeline: its files
// on LittleFS and the warm epoch in RTC memory (docs/specs/device-api.md §4).
//
// Each class is the thinnest bridge between one bridgelogic port and the core;
// every decision is in lib/bridgelogic, where the host suite drives it. It sits
// beside main.cpp rather than in lib/arduino_hal because it speaks bridgelogic's
// ports, and arduino_hal is compiled into the Mega image too.

#ifndef CRUSADERS_COURT_BRIDGE_ESPLIFELINE_H
#define CRUSADERS_COURT_BRIDGE_ESPLIFELINE_H

#ifdef TARGET_COURT_BRIDGE

#include <stddef.h>
#include <stdint.h>

#include "bridgelogic/Lifeline.h"
#include "bridgelogic/Records.h"

namespace arduino_hal {

/// bridgelogic::IFiles on LittleFS (mounted by LittleFsStore::begin). Atomic
/// writes: `<path>.tmp`, then a rename over `<path>`.
class LittleFsFiles final : public bridgelogic::IFiles {
public:
  bool write(const char* path, const bridgelogic::Part* parts, uint8_t count) override;
  size_t read(const char* path, uint32_t offset, void* out, size_t cap) override;
  uint32_t size(const char* path) override;
  void remove(const char* path) override;
  bool begin(const char* path) override;
  bool append(const void* data, size_t len) override;
  bool end(bool keep) override;

  /// The directory the records live in.
  static void prepare();
};

/// Milliseconds that carry on across every reset but a power-on, kept in RTC
/// user memory (the top four words, clear of the core's eboot command) and
/// written once a second.
class RtcEpoch {
public:
  /// Reads the carried epoch unless this boot was a power-on. True when it
  /// carried (a warm boot).
  bool begin(bool powerOn, uint32_t nowMs);

  /// The epoch now; written to RTC memory at most once a second.
  uint64_t tick(uint32_t nowMs);

  uint64_t now(uint32_t nowMs) const { return base_ + static_cast<uint32_t>(nowMs - bootMs_); }

private:
  uint64_t base_ = 0U;
  uint32_t bootMs_ = 0U;
  uint32_t writtenAtMs_ = 0U;
  bool written_ = false;
};

} // namespace arduino_hal

#endif // TARGET_COURT_BRIDGE

#endif // CRUSADERS_COURT_BRIDGE_ESPLIFELINE_H

// Crusaders Mainframe — the ESP8266 side of bridge 3.1.0's lifeline: its files
// on LittleFS, its OTA staging area, the firmware download, the warm epoch in
// RTC memory and the setup portal (docs/specs/device-api.md §4, §7, §8).
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

#include "bridgelogic/BridgeOta.h"
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

  /// The two directories the records live in.
  static void prepare();
};

/// The 4m2m staging area through the core's Updater, whose own verify hook
/// reads the staged bytes back from flash and asks our check before it arms
/// the eboot copy — so what is verified is what eboot will copy.
class EspImageFlash final : public bridgelogic::IImageFlash {
public:
  uint32_t runningSize() override;
  bool readRunning(uint32_t offset, uint8_t* out, size_t len) override;
  uint32_t capacity() override;
  bool begin(uint32_t size) override;
  bool write(const uint8_t* data, size_t len) override;
  bool commit(bridgelogic::IStagedCheck& check) override;
  void abort() override;
};

/// A streaming GET of the firmware from this board's own server: HTTP/1.0,
/// no reuse, `Content-Length` equal to the size or nothing is read.
class EspDownload final : public bridgelogic::IDownload {
public:
  EspDownload(const char* (*baseUrl)(), const char* (*authHeader)(), uint8_t* buffer, size_t bufferCap)
      : baseUrl_(baseUrl), authHeader_(authHeader), buffer_(buffer), cap_(bufferCap) {}

  uint16_t get(const char* path, uint32_t expectBytes, bridgelogic::IChunkSink& sink) override;

private:
  const char* (*baseUrl_)();
  const char* (*authHeader_)();
  uint8_t* buffer_;
  size_t cap_;
};

/// Milliseconds that carry on across every reset but a power-on, kept in RTC
/// user memory (above the eboot command's words) and written once a second.
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

/// The setup portal: a WPA2 access point and one page (§8). Owns the web
/// server only while open; the page's form is validated by
/// bridgelogic::validatePortalForm and saved by the callback.
class SetupPortal {
public:
  /// What the portal saves, validated: a local network set, and optionally a
  /// device key. False when the save failed (the page says so).
  using Save = bool (*)(const devnet::NetSet& net, const char* keyId, const char* key);

  bool open(const char* apName, const char* apPassword, Save save, char* scratch, size_t scratchCap);
  /// Serves; true once a save succeeded (the caller restarts).
  bool pump();
  void close();

  bool isOpen() const { return open_; }

private:
  bool open_ = false;
  bool saved_ = false;
};

} // namespace arduino_hal

#endif // TARGET_COURT_BRIDGE

#endif // CRUSADERS_COURT_BRIDGE_ESPLIFELINE_H

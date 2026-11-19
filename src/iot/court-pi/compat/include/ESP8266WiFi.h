// Crusaders Mainframe — court-pi compat: the ESP8266 WiFi station and the TCP
// client the HTTP client reads through, on Linux. (The ESP object is Esp.h's,
// reached through Arduino.h as on the real core.)
//
//   WiFi.status()      WL_CONNECTED while the box has a default route
//                      (/proc/net/route) — WiFi or Ethernet alike.
//   WiFi.macAddress()  the identity interface's MAC (COURT_BRAIN_IFACE), or
//                      COURT_BRAIN_MAC to keep the retired ESP's identity.
//   WiFi.begin()       `nmcli device wifi connect` in the background when
//                      COURT_BRAIN_MANAGE_WIFI=1 — this is how the server's
//                      runtime `net` (device-api.md §8) still moves the box to a
//                      new access point with no visit. A no-op otherwise.

#ifndef CRUSADERS_COURT_PI_COMPAT_ESP8266WIFI_H
#define CRUSADERS_COURT_PI_COMPAT_ESP8266WIFI_H

#include <stddef.h>
#include <stdint.h>

#include "Arduino.h"

enum wl_status_t { WL_IDLE_STATUS = 0, WL_NO_SSID_AVAIL = 1, WL_CONNECTED = 3, WL_DISCONNECTED = 6 };

enum WiFiMode_t { WIFI_OFF = 0, WIFI_STA = 1 };

class ESP8266WiFiClass {
public:
  wl_status_t status();
  uint8_t* macAddress(uint8_t* mac);
  int begin(const char* ssid, const char* passphrase);
  bool disconnect(bool wifiOff = false);
  bool mode(WiFiMode_t mode);
  void persistent(bool persistent);
};

extern ESP8266WiFiClass WiFi;

/// A plain TCP connection (the base URL grammar refuses https, device-api.md §8).
class WiFiClient {
public:
  WiFiClient() = default;
  ~WiFiClient();
  WiFiClient(const WiFiClient&) = delete;
  WiFiClient& operator=(const WiFiClient&) = delete;

  /// Connects within `timeoutMs`. False on DNS failure, refusal or timeout.
  bool connect(const char* host, uint16_t port, uint32_t timeoutMs);
  /// Bytes buffered or readable now. Never blocks.
  int available();
  int read(uint8_t* out, size_t len);
  /// True while the peer has not closed and no error occurred.
  uint8_t connected();
  bool sendAll(const char* data, size_t len, uint32_t timeoutMs);
  /// Reads one header line (to CRLF, CRLF stripped) within the deadline.
  bool readLine(char* out, size_t cap, uint64_t deadlineMs);
  void stop();

private:
  bool fill(int waitMs);
  int fd_ = -1;
  bool eof_ = false;
  uint8_t buf_[1024] = {};
  size_t head_ = 0U;
  size_t len_ = 0U;
};

#endif // CRUSADERS_COURT_PI_COMPAT_ESP8266WIFI_H

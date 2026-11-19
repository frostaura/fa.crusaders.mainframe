// Crusaders Mainframe — court-pi compat: court-brain's run-time settings.
//
// Read once from the environment (systemd's EnvironmentFile=
// /etc/court-box/court-box.env) before the bridge's setup() runs. None of them
// is a club setting: the club's settings still arrive in the heartbeat. These
// say only where Linux keeps what the ESP8266 kept in silicon.

#ifndef CRUSADERS_COURT_PI_COMPAT_BRAINCONFIG_H
#define CRUSADERS_COURT_PI_COMPAT_BRAINCONFIG_H

#include <stdint.h>

namespace compat {

struct BrainConfig {
  /// COURT_BRAIN_LINK — court-io's socket (the Mega's Serial3).
  char link[108] = "/run/court-box/link.sock";
  /// COURT_BRAIN_DATA — LittleFS's root on the SD card.
  char data[160] = "/var/lib/court-box/brain";
  /// COURT_BRAIN_RUN — tmpfs: the RTC-memory file and the restart marker.
  char run[160] = "/run/court-box";
  /// COURT_BRAIN_IFACE — whose MAC is the box's identity, and which radio
  /// WiFi.begin() drives.
  char iface[32] = "wlan0";
  /// COURT_BRAIN_MAC — aa:bb:cc:dd:ee:ff to keep the retired ESP8266's identity
  /// (its court numbers, button map and LCD settings on the admin Devices page).
  uint8_t mac[6] = {};
  bool macSet = false;
  /// COURT_BRAIN_MANAGE_WIFI — 1: the server's `net` drives nmcli. 0: the OS
  /// owns the network (Ethernet, or a hand-configured WiFi).
  bool manageWifi = true;
};

BrainConfig& config();

/// Fills config() from the environment. False (with a message on stderr) on a
/// malformed value.
bool loadConfig();

/// Parses "aa:bb:cc:dd:ee:ff" (or 12 bare hex digits). Exposed for the test.
bool parseMac(const char* text, uint8_t out[6]);

} // namespace compat

#endif // CRUSADERS_COURT_PI_COMPAT_BRAINCONFIG_H

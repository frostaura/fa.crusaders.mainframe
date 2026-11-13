// Crusaders Mainframe — how a 2.0.0 gate reaches the club, and changes how
// without a cable (docs/specs/device-api.md §8, door-gate.md §14.3, DG-1, DG-3).
//
//   * The compiled WIFI_SSID / WIFI_PASSWORD / API_BASE_URL are the FIRST-BOOT
//     DEFAULTS only. A `net` object from the server (all or nothing, validated
//     by devnet) or the setup portal replaces them, persisted.
//   * The previous set is kept as the fallback. WiFi profiles are tried new
//     first, then the previous set, then the compiled defaults — so a router
//     migration is "add the new network as the second profile, wait for every
//     board's net_ver, switch the router", with no visit.
//   * A new base URL that yields no accepted heartbeat within
//     `net_fallback_minutes` is abandoned for the previous one, and that version
//     is never re-adopted (a typo cannot strand the fleet, and cannot make it
//     flap either: re-adopting the same bad URL every time the old one reached
//     the server would be a ten-minute outage on a loop).
//   * A `local` set (the portal's) is never replaced by the server's `net`
//     unless the server sends one anyway, which it does only when an admin
//     pushes the club's configuration to this board.
//
// No heap, no Arduino headers, valid C++11.

#ifndef CRUSADERS_GATELOGIC_GATENET_H
#define CRUSADERS_GATELOGIC_GATENET_H

#include <stddef.h>
#include <stdint.h>

#include "devnet/Net.h"
#include "gatelogic/GateStore.h"

namespace gatelogic {

enum class NetSource : uint8_t { Compiled = 0U, Server = 1U, Local = 2U };

const char* netSourceName(NetSource source);

/// What is persisted.
struct NetRecord {
  devnet::NetSet current;
  devnet::NetSet previous;
  bool hasCurrent = false;
  bool hasPrevious = false;
  uint8_t source = 0U;
  /// The current set's base has not yet been proven by an accepted heartbeat.
  bool baseUnproven = false;
  /// A server version whose base URL was abandoned; never adopted again.
  uint32_t abandonedVer = 0U;
};

/// Up to two profiles from each of the current and previous sets, plus the
/// compiled one.
constexpr uint8_t kMaxProfiles = 5U;

class GateNet {
public:
  void begin(const char* ssid, const char* psk, const char* baseUrl, IBlobStore* store);

  /// The base URL in use. A stable buffer: the HTTP port holds this pointer.
  const char* baseUrl() const { return base_; }

  uint8_t profileCount() const { return profileCount_; }

  const devnet::Profile& profile(uint8_t index) const { return profiles_[index % kMaxProfiles]; }

  /// The profile the radio should join now, and the one after it on a
  /// supervisor reconnect.
  uint8_t activeProfile() const { return active_; }

  uint8_t advanceProfile();

  /// The server's `net` object. Adopted, persisted and made current; the
  /// caller restarts the radio on the new first profile.
  devnet::NetResult adopt(const char* object, size_t len, uint32_t nowMs);

  /// The setup portal's set: source `local`, version 0.
  bool adoptLocal(const devnet::NetSet& local);

  /// Starts the fallback window's clock at boot: a base persisted unproven is
  /// given its whole window again on every boot.
  void startClock(uint32_t nowMs) { adoptedAtMs_ = nowMs; }

  /// An accepted heartbeat: the base in use works.
  void heartbeatAccepted();

  /// Abandons an unproven base after `fallbackMinutes`. True when it did,
  /// which the caller reports (fault `net_fallback`) and acts on.
  bool tick(uint32_t nowMs, uint32_t fallbackMinutes);

  uint32_t version() const;

  NetSource source() const { return static_cast<NetSource>(record_.source); }

  const NetRecord& record() const { return record_; }

private:
  void rebuild();
  bool persist();

  NetRecord record_;
  IBlobStore* store_ = nullptr;
  devnet::Profile compiled_;
  char compiledBase_[devnet::kBaseUrlMax + 1U] = {};
  char base_[devnet::kBaseUrlMax + 1U] = {};
  devnet::Profile profiles_[kMaxProfiles];
  uint8_t profileCount_ = 0U;
  uint8_t active_ = 0U;
  uint32_t adoptedAtMs_ = 0U;
};

// --- the setup portal's form -------------------------------------------------

/// One submitted form, already URL-decoded field by field.
struct PortalForm {
  const char* ssid = nullptr;
  const char* psk = nullptr;
  const char* ssid2 = nullptr;
  const char* psk2 = nullptr;
  const char* base = nullptr;
  const char* keyId = nullptr;
  const char* key = nullptr;
};

/// Validates the form with the `provision/` rules (the same as a server `net`)
/// into `out`. The reason names the first bad field, for the page to show.
devnet::Refusal validatePortalForm(const PortalForm& form, devnet::NetSet& out);

/// Decodes one `application/x-www-form-urlencoded` value. False if it does not
/// fit or carries a bad `%xx`.
bool urlDecode(const char* in, size_t inLen, char* out, size_t cap);

/// The setup gesture: the BOOT button held for five seconds within 60 s of
/// power-on, after the boot blinks (door-gate.md §14.3).
class SetupGesture {
public:
  static constexpr uint32_t kWindowMs = 60000UL;
  static constexpr uint32_t kHoldMs = 5000UL;

  void begin(uint32_t nowMs) {
    bootMs_ = nowMs;
    heldSinceMs_ = 0U;
    held_ = false;
    fired_ = false;
  }

  /// True exactly once, on the pass the hold completes.
  bool tick(uint32_t nowMs, bool pressed);

private:
  uint32_t bootMs_ = 0U;
  uint32_t heldSinceMs_ = 0U;
  bool held_ = false;
  bool fired_ = false;
};

} // namespace gatelogic

#endif // CRUSADERS_GATELOGIC_GATENET_H

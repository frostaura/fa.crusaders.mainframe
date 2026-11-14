// Crusaders Mainframe — how bridge 3.1.0 reaches the club, and changes how
// without a cable (docs/specs/device-api.md §6, §8, §11.1; HW-8).
//
// THE FOUNDER'S RULE
// ------------------
// NOTHING an operator does may force a reflash: the bridge is updated only by
// cable, at the box, so a new router, a moved server or a rotated key must not
// need one. So the four values compiled into `secrets.h` — the WiFi SSID and
// password, the API base URL and the device key — are only the FIRST-BOOT
// DEFAULTS here:
//
//   * BridgeKeys   — the device key ring: the current key and the previous
//                    one, `k0` being the compiled key. `key_next` is adopted,
//                    persisted BEFORE it is used, and authenticates the next
//                    request; a 401 is retried once with the other key and
//                    neither is ever erased (§6).
//   * BridgeNet    — the network set: up to two WiFi profiles and the base
//                    URL from the server's `net` (all or nothing), the
//                    previous set kept as the fallback,
//                    and a base URL that never earns an accepted heartbeat
//                    abandoned after `device_net_fallback_minutes` (§8).
//   * StallWatch   — the link is up and nothing has been accepted for six
//                    hours: restart when idle (HW-8). devnet::Supervisor does
//                    the link-down half (30 s grace, 30–300 s backoff, a
//                    restart at 15 min).
//
// The door gate implements the same contract in gatelogic::GateNet/GateKeys;
// these are the court box's own, over its own flash (bridgelogic::IFiles), and
// compact because the ESP8266's heap is the 24 KB floor's.
//
// No Arduino headers, no heap. C++11-valid.

#ifndef CRUSADERS_BRIDGELOGIC_LIFELINE_H
#define CRUSADERS_BRIDGELOGIC_LIFELINE_H

#include <stddef.h>
#include <stdint.h>

#include "bridgelogic/Records.h"
#include "bridgelogic/V3Heartbeat.h"
#include "devapi/DeviceClient.h"
#include "devnet/Net.h"

namespace bridgelogic {

// --- the device keys (§6) -------------------------------------------------------

class BridgeKeys {
public:
  /// `compiledKey` is `k0` and must outlive this object (a literal). A
  /// persisted ring that reads whole wins: it is what the server has been told
  /// this board holds.
  void begin(const char* compiledKey, IFiles* files);

  /// `Bearer <key>` for the key tried first.
  const char* header() const { return header_; }

  /// A 401 arrived: switch to the other held key for ONE retry. False when
  /// there is no other key (the header is unchanged).
  bool switchForRetry();

  /// The retry failed too: back to the key tried first.
  void retryFailed();

  /// `key_next`'s object (braces included), from an accepted heartbeat.
  /// Persisted before use; any refusal (the corpus reason) changes nothing.
  devnet::Refusal adopt(const char* object, size_t len);

  const devnet::KeyRing& ring() const { return ring_; }

  /// The id of the key the header carries (`k0` for the compiled one).
  const char* activeId() const { return onPrevious_ ? ring_.previousId : ring_.currentId; }

private:
  void render();
  bool persist(const devnet::KeyRing& ring);

  devnet::KeyRing ring_;
  IFiles* files_ = nullptr;
  const char* compiled_ = "";
  bool onPrevious_ = false;
  char header_[devapi::kAuthorizationBufSize] = {};
};

// --- the network (§8) -----------------------------------------------------------

enum class NetSource : uint8_t { Compiled = 0U, Server = 1U };

const char* netSourceName(NetSource source);

struct NetMeta {
  uint8_t source = 0U;
  uint8_t hasCurrent = 0U;
  uint8_t hasPrevious = 0U;
  /// The current set's base has not yet been proven by an accepted heartbeat.
  uint8_t baseUnproven = 0U;
  /// A server version whose base URL was abandoned; never adopted again.
  uint32_t abandonedVer = 0U;
};

/// What is persisted: written from its three parts, never via a second copy.
struct NetRecord {
  NetMeta meta;
  devnet::NetSet current;
  devnet::NetSet previous;
};

class BridgeNet {
public:
  /// The compiled values must outlive this object (literals).
  void begin(const char* ssid, const char* psk, const char* baseUrl, IFiles* files);

  /// The base URL to dial now: the current set's, else the previous set's,
  /// else the compiled one.
  const char* baseUrl() const;

  /// WiFi profiles in the order they are tried: the current set's, the
  /// previous set's, the compiled one — each once.
  uint8_t profileCount() const;
  const char* ssid(uint8_t index) const;
  const char* psk(uint8_t index) const;

  uint8_t activeProfile() const { return active_; }

  /// The supervisor said reconnect: the next profile (wrapping).
  uint8_t advanceProfile();

  /// The server's `net`. Adopted all or nothing, persisted and made current;
  /// the caller re-joins on profile 0 when the WiFi changed. A version
  /// abandoned before is `not_newer`.
  devnet::NetResult adopt(const char* object, size_t len, uint32_t nowMs);

  /// Starts the fallback window's clock (at boot and on adoption).
  void startClock(uint32_t nowMs) { adoptedAtMs_ = nowMs; }

  /// An accepted heartbeat: the base in use works.
  void heartbeatAccepted();

  /// Abandons an unproven base after `fallbackMinutes`. True on the pass it did.
  bool tick(uint32_t nowMs, uint32_t fallbackMinutes);

  /// `net_ver`: the server version applied, 0 for compiled.
  uint32_t version() const;

  NetSource source() const { return static_cast<NetSource>(record_.meta.source); }

  const NetRecord& record() const { return record_; }

private:
  /// Profile `index` in try order, or nullptr.
  const devnet::Profile* profileAt(uint8_t index) const;
  bool persist(const NetMeta& meta, const devnet::NetSet& current, const devnet::NetSet& previous);

  NetRecord record_;
  IFiles* files_ = nullptr;
  devnet::Profile compiled_;
  const char* compiledBase_ = "";
  uint8_t active_ = 0U;
  uint32_t adoptedAtMs_ = 0U;
};

// --- the lifeline settings (§5) -------------------------------------------------

/// `device_power_restore_trust_minutes` (0–120, default 20),
/// `device_net_fallback_minutes` (3–60, 10) and `relay_reconcile_min_seconds`
/// (30–600, 60): read from INSIDE `config`, each by its exact kind and clamped
/// independently (§11.2).
struct LifelineSettings {
  uint32_t trustMinutes = 20U;
  uint32_t fallbackMinutes = 10U;
  uint32_t reconcileMinSeconds = 60U;
};

/// Reads the three from `config` in `body` over `current`; every key present
/// but unreadable is named in `drift` (when not null) and keeps its value.
void readLifelineSettings(const char* body, size_t len, LifelineSettings& current, Drift* drift);

// --- the stall watchdog (HW-8) --------------------------------------------------

class StallWatch {
public:
  static constexpr uint32_t kStallMs = 6UL * 3600UL * 1000UL;

  void begin(uint32_t nowMs) { sinceMs_ = nowMs; }

  /// An accepted heartbeat (or the link going down, which is the supervisor's).
  void reset(uint32_t nowMs) { sinceMs_ = nowMs; }

  /// True when the link has been up with nothing accepted for six hours. The
  /// caller restarts when idle; a restart itself starts the next six hours.
  bool stalled(uint32_t nowMs, bool linkUp);

private:
  uint32_t sinceMs_ = 0U;
};

} // namespace bridgelogic

#endif // CRUSADERS_BRIDGELOGIC_LIFELINE_H

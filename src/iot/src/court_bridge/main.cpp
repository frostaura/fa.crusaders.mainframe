// Crusaders Mainframe — ESP8266 firmware: the composition root.
//
// WHAT THIS FILE IS
// -----------------
// Wiring, and the small amount of sequencing that only a composition root can
// do. Every decision about WHICH implementation of a port to use is here; the
// announce schedule, the beacon codec, the claim commitment and the OFFER
// acceptance rule are all in lib/discovery, where `pio test -e native` drives
// them against the shared corpus with no board attached.
//
// WHY THIS HALF EXISTS
// --------------------
// It is the half that can be updated. The ATmega cannot be flashed over WiFi —
// its ESP sits on Serial3, not the Serial0 bootloader port, and no GPIO reaches
// RESET — so everything volatile lives here and the Mega stays near-static.
//
// NO STATIC IP, DELIBERATELY
// --------------------------
// Carl's sketch hardcodes 192.168.68.150 with WiFi.config(). That works exactly
// until somebody changes the router, the subnet, or plugs in a second board,
// and it is invisible to the API either way — "connecting a board" meant an
// admin reading an IP off a sticker. This firmware takes a DHCP lease and
// announces itself instead. There is no WiFi.config() call anywhere in this
// repo and there must not be one.
//
// WHY THERE IS NO SERIAL DEBUG OUTPUT
// -----------------------------------
// `Serial` IS the link to the Mega on this board, at 9600 8N1, routed by the
// DIP block. A Serial.println() here is a line of debug text arriving at the
// Mega's frame decoder, which answers it with `!EVT,BADFRAME`. Diagnostics go
// out as protocol frames or as the discovery beacon's fields, not as prose.
//
// WHAT THIS FIRMWARE DELIBERATELY DEFERS
// --------------------------------------
// These are LATER phases and the seams for them are marked, not built:
//   * The session state machine. Nothing here turns a `!BTN` or a `!SCAN` into
//     a booking; uplink frames are decoded, counted and dropped. That decision
//     needs the roster and the ledger, which need the API client.
//   * The roster cache and the event queue. ROSTER_MAX_AGE_MS and EVENTQ_SLOTS
//     are already build flags with nothing reading them, on purpose: the queue
//     is what makes a court usable while the WiFi is down, and it is worth
//     building deliberately rather than as a side effect of this file.
//   * Provisioning. The claim commitment is broadcast and the code is shown on
//     the Mega's LCD, which is the half of claiming that belongs to the board.
//     The `POST /api/v1/device/provision` fetch that collects the key, and the
//     signed claimed-ANNOUNCE that follows it, need an HTTP client and the
//     device key store — both of which exist as ports here already.
//   * OTA. The whole reason this half is separate; it needs a signed-image
//     policy decided before any code, not after.

#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <WiFiUdp.h>

#include <stddef.h>
#include <stdint.h>

#include "arduino_hal/ArduinoClock.h"
#include "arduino_hal/LittleFsStore.h"
#include "arduino_hal/SerialTransport.h"
#include "devcrypto/Hex.h"
#include "discovery/Announcer.h"
#include "discovery/Beacon.h"
#include "discovery/BeaconCodec.h"
#include "discovery/Claim.h"
#include "discovery/Offer.h"
#include "fwversion/Version.h"
#include "protocol/Codec.h"
#include "protocol/Protocol.h"
#include "timebase/TimeBase.h"

// secrets.h is gitignored and is absent on a CI runner, so its presence cannot
// be a build requirement — a firmware that only compiles on the machine holding
// the club's WiFi password is a firmware CI never checks. The defaults below
// produce a board that boots, talks to the Mega and refuses to join a network,
// which is the honest behaviour for an unconfigured box.
#if __has_include("common/secrets.h")
#include "common/secrets.h"
#endif

#ifndef WIFI_SSID
#define WIFI_SSID ""
#endif
#ifndef WIFI_PASSWORD
#define WIFI_PASSWORD ""
#endif

namespace {

/// Bytes of nonce per boot, per the discovery spec's `n` field.
constexpr size_t kNonceBytes = 8U;

/// The `n` field's text, which is ALSO what the claim commitment is computed
/// over — the ASCII characters, not the eight bytes they decode to. Both
/// readings are defensible from the spec's wording and produce different
/// digests, so the corpus settles it and this comment records which one won.
constexpr size_t kNonceHexLen = dc::hex::encodedSize(kNonceBytes);

/// Store keys. Short ASCII literals, well inside hal::kStoreMaxKeyLen.
constexpr char kKeyApiUrl[] = "api_url";

/// UDP datagrams handled per pass, so a flooded port cannot starve the Mega
/// link. Discovery traffic is one packet every few seconds in normal service.
constexpr uint8_t kPacketsPerPass = 4U;

/// Bytes drained from the Mega link per pass, matching the UART ring.
constexpr uint16_t kBytesPerPass = 64U;

constexpr uint32_t kHeartbeatMs = 30000UL;

#ifdef HEARTBEAT_INTERVAL_MS
static_assert(HEARTBEAT_INTERVAL_MS == kHeartbeatMs,
              "kHeartbeatMs and the HEARTBEAT_INTERVAL_MS build flag have drifted apart");
#endif

/// The ESP8266's hardware RNG register, behind discovery::IEntropySource.
///
/// Injected rather than called directly because a generator that reaches for a
/// platform RNG cannot be tested: the shared corpus's worked examples exist so
/// that a SPECIFIC claim code can be produced on demand, which needs a scripted
/// byte source on the host.
///
/// HONEST LIMIT: RANDOM_REG32 is fed by RF noise and is only well distributed
/// once the radio is up. setupIdentity() therefore runs after WiFi.begin(), and
/// the claim code is regenerated on every boot anyway, so a weak first read
/// costs one boot's commitment rather than a permanent secret.
class HardwareEntropy final : public discovery::IEntropySource {
public:
  uint8_t nextByte() override { return static_cast<uint8_t>(RANDOM_REG32 & 0xFFU); }
};

arduino_hal::ArduinoClock gClock;
arduino_hal::SerialTransport gMega(Serial);
arduino_hal::LittleFsStore gStore;

WiFiUDP gUdp;
HardwareEntropy gEntropy;
discovery::Announcer gAnnouncer;
proto::Decoder gUplink(proto::Link::Uplink);
tb::Uptime64 gUptime;
tb::Deadline gHeartbeat;

/// Identity, filled once at boot and then read-only.
char gMacHex[dc::hex::encodedSize(6U)];
char gNonceHex[kNonceHexLen];
discovery::ClaimCode gClaimCode;
discovery::ClaimCommitment gCommitment;

/// The Mega's firmware version, learned from `!PONG`. Empty until the first
/// answer arrives, which is what makes the beacon's `mega` field honest: an
/// absent field and a field reading "unknown" are different facts.
char gMegaVersion[proto::kMaxArgLen + 1] = {'\0'};

/// The Mega's uptime from the last `!PONG`, so a restart can be detected and
/// the claim prompt repainted. The Mega clears its screen on reset and has no
/// idea a claim is in progress.
uint32_t gMegaUptime = 0U;

bool gWifiUp = false;

uint32_t uptimeSeconds() {
  return static_cast<uint32_t>(gUptime.value() / 1000ULL);
}

/// Write a frame to the Mega, all of it or none of it. A fragment would fail
/// the Mega's checksum AND be read as the head of the next frame.
bool sendToMega(const proto::Frame& frame) {
  char buf[proto::kMaxFrameLen];
  const size_t len = proto::encode(frame, buf, sizeof(buf));
  if (len == 0U || gMega.writable() < len) {
    return false;
  }
  return gMega.write(reinterpret_cast<const uint8_t*>(buf), len) == len;
}

void showClaimPrompt() {
  // The claim code goes out on the ONE channel nothing on the network can read:
  // the Mega's LCD. That is the whole point of the commitment scheme — the code
  // is never on the wire, only SHA256(code ":" nonce) truncated to 16 hex.
  static_cast<void>(sendToMega(proto::Frame::lcd("CLAIM CODE", gClaimCode.lcdText())));
}

void setupIdentity() {
  uint8_t mac[6] = {0U, 0U, 0U, 0U, 0U, 0U};
  WiFi.macAddress(mac);
  static_cast<void>(dc::hex::encodeLower(mac, sizeof(mac), gMacHex, sizeof(gMacHex)));

  uint8_t nonce[kNonceBytes];
  for (size_t i = 0U; i < kNonceBytes; ++i) {
    nonce[i] = gEntropy.nextByte();
  }
  static_cast<void>(dc::hex::encodeLower(nonce, sizeof(nonce), gNonceHex, sizeof(gNonceHex)));

  gClaimCode = discovery::ClaimCode::generate(gEntropy);
  gCommitment = gClaimCode.commit(gNonceHex);
}

discovery::Identity identity() {
  discovery::Identity id;
  id.mac = gMacHex;
  id.hardware = "esp8266";
  id.firmware = fw::kFirmwareVersion;
  // Null omits the field entirely, which is correct until the Mega has answered
  // a `!PING`.
  id.megaFirmware = gMegaVersion[0] == '\0' ? nullptr : gMegaVersion;
  return id;
}

void broadcastAnnounce() {
  const discovery::Packet packet =
      discovery::Packet::announceUnclaimed(identity(), gNonceHex, gCommitment, uptimeSeconds());
  char buf[discovery::kMaxPacketLen];
  const size_t len = discovery::encode(packet, buf, sizeof(buf));
  if (len == 0U) {
    // Never a partial datagram: a truncated beacon still has a plausible
    // checksum position and would be answered.
    return;
  }
  if (gUdp.beginPacket(IPAddress(255U, 255U, 255U, 255U), discovery::kUdpPort) != 1) {
    return;
  }
  static_cast<void>(gUdp.write(reinterpret_cast<const uint8_t*>(buf), len));
  static_cast<void>(gUdp.endPacket());
}

void rememberApiUrl(const char* url) {
  const size_t len = strlen(url);
  if (len == 0U || len > hal::kStoreMaxValueLen) {
    return;
  }
  static_cast<void>(gStore.put(kKeyApiUrl, reinterpret_cast<const uint8_t*>(url), static_cast<uint8_t>(len)));
}

void handleOffer(const discovery::Packet& packet) {
  // UnclaimedBox, not ClaimedBox: this board has no device key yet, so it has
  // nothing to verify a signature with and says so through its type rather
  // than through a comment. The moment provisioning lands, this becomes a
  // ClaimedBox whose constructor REQUIRES the key — which is what makes "a
  // claimed box refuses an unsigned OFFER" structural instead of an `if`.
  const discovery::UnclaimedBox box(gNonceHex);
  discovery::AcceptedOffer offer;
  if (!box.accept(packet, offer)) {
    return;
  }
  rememberApiUrl(offer.url());
}

void pumpOffers() {
  for (uint8_t i = 0U; i < kPacketsPerPass; ++i) {
    const int size = gUdp.parsePacket();
    if (size <= 0) {
      return;
    }
    char buf[discovery::kMaxPacketLen];
    const int read = gUdp.read(buf, sizeof(buf));
    if (read <= 0) {
      return;
    }
    discovery::Packet packet;
    if (discovery::decode(buf, static_cast<size_t>(read), packet) != discovery::DecodeError::None) {
      // Port 48653 on a club LAN receives traffic that was never meant for it.
      // A packet that does not parse is dropped and the next announce is five
      // seconds behind it.
      continue;
    }
    if (packet.verb() == discovery::Verb::Offer) {
      handleOffer(packet);
    }
  }
}

void noteMegaPong(const proto::Frame& frame) {
  const char* version = frame.arg(0);
  size_t i = 0U;
  while (version[i] != '\0' && i < proto::kMaxArgLen) {
    gMegaVersion[i] = version[i];
    ++i;
  }
  gMegaVersion[i] = '\0';

  uint32_t seconds = 0U;
  const char* text = frame.arg(1);
  for (size_t j = 0U; text[j] >= '0' && text[j] <= '9'; ++j) {
    seconds = seconds * 10U + static_cast<uint32_t>(text[j] - '0');
  }
  if (seconds < gMegaUptime) {
    // The Mega restarted: its screen is back to the idle text and it has no
    // idea a claim is in progress.
    showClaimPrompt();
  }
  gMegaUptime = seconds;
}

void handleUplink(const proto::Decoder::Result& result) {
  if (!result.isFrame()) {
    // LATER: `!EVT` and `!ERR` from the Mega belong in the event queue, which
    // is what carries them to the API once the WiFi comes back. Dropped for now
    // rather than half-queued.
    return;
  }
  if (result.frame.verb() == proto::Verb::Pong) {
    noteMegaPong(result.frame);
  }
  // LATER: `!BTN`, `!SCAN` and `!STATE` feed the session state machine. Nothing
  // here decides what a scan means, because that needs the roster and the
  // ledger, and a half-built version of it would turn the lights on for the
  // wrong member rather than not at all.
}

void pumpMegaLink() {
  uint8_t byte = 0U;
  for (uint16_t i = 0U; i < kBytesPerPass && gMega.read(byte); ++i) {
    if (!gUplink.feed(static_cast<char>(byte))) {
      continue;
    }
    proto::Decoder::Result result;
    while (gUplink.pop(result)) {
      handleUplink(result);
    }
  }
}

void pumpWifiLink(uint32_t nowMs) {
  const bool up = WiFi.status() == WL_CONNECTED;
  if (up == gWifiUp) {
    return;
  }
  gWifiUp = up;
  if (up) {
    static_cast<void>(gUdp.begin(discovery::kUdpPort));
    // Immediately, not after a full interval: the case that matters is a box
    // that just got its DHCP lease with an admin standing at the cupboard.
    gAnnouncer.linkUp(nowMs);
    showClaimPrompt();
    return;
  }
  gUdp.stop();
  gAnnouncer.linkDown();
}

void pumpHeartbeat(uint32_t nowMs) {
  if (!gHeartbeat.expired(nowMs)) {
    return;
  }
  gHeartbeat.arm(nowMs, kHeartbeatMs);
  // `!PING` is the only thing that tells this half whether the other half is
  // alive: a UART has no carrier, so silence and a dead peer look identical.
  // The answer also carries the Mega's firmware version for the beacon.
  static_cast<void>(sendToMega(proto::Frame::ping()));
}

} // namespace

void setup() {
  gMega.begin();
  static_cast<void>(gStore.begin());

  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  if (WIFI_SSID[0] != '\0') {
    // DHCP. No WiFi.config(), no static address — see the header.
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }

  setupIdentity();

  const uint32_t now = gClock.nowMs();
  gUptime.seed(now);
  gHeartbeat.arm(now, kHeartbeatMs);
}

void loop() {
  // One clock read per pass, shared by every sub-step, so the heartbeat and the
  // announce schedule are never evaluated against two different instants.
  const uint32_t now = gClock.nowMs();
  gUptime.tick(now);

  pumpWifiLink(now);
  pumpMegaLink();
  pumpHeartbeat(now);
  pumpOffers();

  if (gAnnouncer.due(now)) {
    broadcastAnnounce();
  }
}

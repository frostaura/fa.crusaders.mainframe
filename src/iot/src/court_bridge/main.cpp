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
// THE COURT WORKS WHEN THE NETWORK DOES NOT
// -----------------------------------------
// A scan is decided HERE, from the roster cache, in microseconds. Putting an
// HTTPS round trip on that path would make every activation depend on a
// consumer router and an ISP, and turn a DNS stall into a member standing in a
// dark corridor pressing the button again. So the box decides locally and
// queues what it did; the API hears about it when it can.
//
// The event queue is therefore not a nicety. Under charge-at-booking the member
// has ALREADY been debited, and the activation event is what stops the no-show
// sweep reversing it — a court lit and never reported looks exactly like a
// member who stayed home. See lib/eventq, which also states plainly what the
// queue does not survive.
//
// WHAT THIS FIRMWARE DELIBERATELY DEFERS
// --------------------------------------
//   * OTA. The whole reason this half is separate; it needs a signed-image
//     policy decided before any code, not after.
//   * Remappable buttons. `!BTN` frames are decoded and counted but do not yet
//     choose a court or a duration — that map is a tenant setting and arrives
//     on the heartbeat config payload.

#include <Arduino.h>
#include <ESP8266HTTPClient.h>
#include <ESP8266WiFi.h>
#include <ESP8266httpUpdate.h>
#include <WiFiUdp.h>

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "arduino_hal/ArduinoClock.h"
#include "arduino_hal/LittleFsStore.h"
#include "arduino_hal/SerialTransport.h"
#include "court/ButtonMap.h"
#include "court/Session.h"
#include "court/WalkUpPad.h"
#include "devapi/DeviceClient.h"
#include "devapi/Json.h"
#include "devcrypto/Hex.h"
#include "discovery/Announcer.h"
#include "discovery/Beacon.h"
#include "discovery/BeaconCodec.h"
#include "discovery/Claim.h"
#include "discovery/Offer.h"
#include "eventq/EventQueue.h"
#include "fwversion/Version.h"
#include "otacore/BootGuard.h"
#include "otacore/UpdatePolicy.h"
#include "protocol/Codec.h"
#include "protocol/Protocol.h"
#include "roster/Roster.h"
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
constexpr char kKeyDeviceId[] = "dev_id";
constexpr char kKeyDeviceKey[] = "dev_key";

/// The device key as hex, so it survives a byte-array store with no encoding of
/// its own. 32 bytes of key is 64 characters, which is over hal::kStoreMaxValueLen
/// — so the key is stored in two halves under one key each, which the store's
/// 32-byte value limit forces and which is worth stating rather than discovering.
constexpr char kKeyDeviceKey2[] = "dev_key2";
constexpr size_t kDeviceKeyBytes = 32U;

/// The tenant this board belongs to, stored so a claimed board can announce
/// itself as claimed. Without it a provisioned box kept broadcasting the
/// unclaimed beacon every five seconds and kept appearing in the admin's
/// "connect a board" list as though it were still up for grabs.
constexpr char kKeyTenantSlug[] = "ten_slug";

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

/// The three things that let a court work with no network.
///
/// Sizes come from build flags so they are visible in platformio.ini next to
/// the board they have to fit in, and so the linker can prove they do. 64 slots
/// of ~48 bytes is about 3 KB — affordable on the ESP8266, and a whole busy
/// evening's worth of events.
constexpr uint8_t kRosterSlots = 32U;

eventq::EventQueue<EVENTQ_SLOTS> gQueue(&gStore);
roster::Roster<kRosterSlots> gRoster(ROSTER_MAX_AGE_MS);
court::Session<roster::Roster<kRosterSlots>, eventq::EventQueue<EVENTQ_SLOTS>> gSession(gRoster, gQueue);

/// Bytes for request nonces. Same register as the claim entropy, behind the
/// client's own port — the two are separate interfaces because one is testable
/// against a corpus and the other has to be, for the same reason.
class RequestEntropy final : public devapi::IEntropySource {
public:
  uint8_t nextByte() override { return static_cast<uint8_t>(RANDOM_REG32 & 0xFFU); }
};

RequestEntropy gRequestEntropy;
devapi::DeviceClient gApi(devapi::Credentials{}, gRequestEntropy);

/// Which court this box is fitted at, from the heartbeat. 0-3 for A-D.
///
/// The API assigns it; the box does not guess. A default of 0 means an
/// unprovisioned box would answer scans as court A — which is why the roster
/// starts stale, and a stale roster refuses everything regardless of court.
uint8_t gCourtNumber = 0U;

/// When each court's lights went on, so a release can report how long it was
/// actually held. This is the number a dispute about a 45-minute booking turns
/// on, and the Mega's own timer is what ends it — so the ESP has to watch for
/// the end rather than schedule it.
///
/// `held` is a separate flag rather than "zero means not held", which is the
/// rule TimeBase.h states outright: every possible uint32_t is a legal millis()
/// reading, so no value is free to carry a second meaning. tb::Deadline carries
/// its own `armed` flag for exactly this. A court lit in the one millisecond the
/// clock reads zero — once per 49.7 days — reported a session of zero length,
/// which is the same defect class the file exists to prevent, in the one file no
/// gate covers. (The CI lint described in TimeBase.h matches identifiers ending
/// Deadline|Expires|AtMs; `gHeldSinceMs` ends in SinceMs and slipped through.)
struct HeldSince {
  uint32_t sinceMs = 0U;
  bool held = false;
};

HeldSince gHeld[4];

/// What the eight buttons do, and the two presses that use them.
///
/// The map starts as the original wiring — courts A-D then 15/30/45/60 — and is
/// replaced from the heartbeat's config payload. A box that has never had a
/// heartbeat therefore behaves exactly as the hand-built box did, which is what
/// stops the first deploy changing every panel in the club.
court::ButtonMap gButtons;
court::WalkUpPad gPad;

/// How long a scan is remembered for a following walk-up.
///
/// The same reasoning as the pad's own selection lapse, and it has to be at least as long or
/// the two disagree: somebody who scans, wanders off and comes back to a different member's
/// button presses must not have bought them court time. The QR itself expires in 60 seconds
/// at the API, which is the real backstop.
constexpr uint32_t kScanMemoryMs = 30000UL;

/// The last thing the scanner read, verbatim. Cleared when it lapses or is spent.
char gLastScan[proto::kMaxArgLen + 1] = {'\0'};
tb::Deadline gScanAt;

/// The guard that stops a broken build being taken twice.
///
/// There is no reverting on this part — a 4M ESP carrying a 1 MB sketch and 2 MB
/// of LittleFS has no second OTA slot, and the filesystem is not optional because
/// it holds the device credential. What the guard buys instead is the thing that
/// actually takes out a fleet: every box heartbeats against the same manifest, so
/// without it a bad image would reflash itself forever on every board at once.
ota::BootGuard gBootGuard(&gStore);

/// The credential, once provisioning has fetched it. Held as raw bytes plus the
/// id text, because that is what dc::signer wants and re-decoding hex on every
/// request would be work done four times a minute for no reason.
char gDeviceId[devapi::kMaxDeviceIdLen + 1U] = {};
uint8_t gDeviceKey[kDeviceKeyBytes] = {};
bool gProvisioned = false;

/// The tenant slug, present once provisioned. Empty falls the announce back to
/// the unclaimed form — a claimed board that somehow lost its slug is better
/// listed as connectable than not listed at all.
char gTenantSlug[hal::kStoreMaxValueLen + 1U] = {};

/// Where the API is, learned from the discovery OFFER or from provisioning.
char gApiUrl[hal::kStoreMaxValueLen + 1U] = {};

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

/// The announce this board should be sending right now.
///
/// A provisioned board announces CLAIMED, signed with its device key, and the
/// server drops a claimed announce out of the "connect a board" list — which is
/// the whole point. Before this it always announced unclaimed, so a board that
/// was already connected kept advertising itself as available every five seconds.
///
/// The fallback to unclaimed is deliberate rather than defensive: a board with a
/// device id and key but no tenant slug (provisioned before the slug was stored)
/// still works, and being listed as connectable is a smaller wrong than
/// vanishing from the admin's view entirely.
discovery::Packet buildAnnounce() {
  const bool canAnnounceClaimed =
      discovery::Packet::shouldAnnounceClaimed(gProvisioned, gDeviceId, gTenantSlug);
  if (!canAnnounceClaimed) {
    return discovery::Packet::announceUnclaimed(identity(), gNonceHex, gCommitment, uptimeSeconds());
  }

  discovery::Packet packet =
      discovery::Packet::announceClaimed(identity(), gNonceHex, gDeviceId, gTenantSlug, uptimeSeconds());

  // Signed, without which anyone on the WiFi could assert this device had moved
  // to their address — the server verifies the signature against the device key
  // and marks an unsigned or wrongly-signed claimed announce unverified.
  if (!discovery::sign(packet, dc::ByteSpan{gDeviceKey, kDeviceKeyBytes})) {
    // A packet that will not sign is not sent claimed-but-unsigned; fall back to
    // the unclaimed form, which at least keeps the board discoverable.
    return discovery::Packet::announceUnclaimed(identity(), gNonceHex, gCommitment, uptimeSeconds());
  }
  return packet;
}

void broadcastAnnounce() {
  const discovery::Packet packet = buildAnnounce();
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

/// Persists the API base URL. False when it will not fit the store.
///
/// The caller must honour that false rather than carrying on: gApiUrl is sized to
/// the store's value cap, while an OFFER may carry up to discovery::kMaxValueLen.
/// So a longer URL used to be silently truncated into RAM by snprintf while this
/// function quietly declined to persist it — leaving the box calling a mangled
/// host until the next reboot, and a different mangled host after it.
bool rememberApiUrl(const char* url) {
  const size_t len = strlen(url);
  if (len == 0U || len > hal::kStoreMaxValueLen) {
    return false;
  }
  return gStore.put(kKeyApiUrl, reinterpret_cast<const uint8_t*>(url), static_cast<uint8_t>(len)) ==
         hal::StoreResult::kOk;
}

void handleOffer(const discovery::Packet& packet) {
  // The type carries the rule, which is the whole reason both types exist — and
  // until now this built an UnclaimedBox unconditionally, so ClaimedBox was
  // constructed nowhere in the firmware and its guarantee was a comment.
  //
  // What that cost: pumpOffers() runs on every loop() with WiFi up, provisioned
  // or not, so a board already holding a device key still accepted any datagram
  // on the discovery port that parsed as an OFFER and echoed its nonce — and the
  // nonce is not a secret, it goes out in a broadcast ANNOUNCE every five
  // seconds. Anyone on the club WiFi could repoint gApiUrl at a host they
  // controlled, and from there drive walk-up grants — lights on, on any court,
  // for as long as the cap allows, as often as they liked.
  //
  // An unclaimed board still accepts an unsigned OFFER: it has nothing to verify
  // with, and refusing would mean an API that always signs could never claim a
  // board. A claimed one verifies, always, because ClaimedBox has no overload
  // that does otherwise.
  discovery::AcceptedOffer offer;
  if (gProvisioned) {
    const discovery::ClaimedBox box(dc::ByteSpan{gDeviceKey, kDeviceKeyBytes}, gNonceHex);
    if (!box.accept(packet, offer)) {
      return;
    }
  } else {
    const discovery::UnclaimedBox box(gNonceHex);
    if (!box.accept(packet, offer)) {
      return;
    }
  }

  // Refused rather than truncated. A base URL this box cannot hold is one it
  // cannot call correctly, and half of one is a request to somewhere else.
  // gApiUrl is sized to the store's value cap while an OFFER may carry up to
  // discovery::kMaxValueLen, so this is a real gap and not a defensive nicety.
  const size_t urlLen = strlen(offer.url());
  if (urlLen == 0U || urlLen >= sizeof(gApiUrl)) {
    return;
  }
  static_cast<void>(rememberApiUrl(offer.url()));
  memcpy(gApiUrl, offer.url(), urlLen);
  gApiUrl[urlLen] = '\0';
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

/// Paints an outcome and, when it is an activation, opens the court.
///
/// The LCD is written FIRST. If the `!ON` fails — a full TX ring, a dead cable
/// — the member is looking at "COURT C 45 MIN" and no lights, which is a
/// complaint with a clear cause. The other order gives them lights and a blank
/// screen, which reads as the box being broken.
void applyOutcome(const court::Outcome& outcome) {
  static_cast<void>(sendToMega(proto::Frame::lcd(outcome.line1, outcome.line2)));
  if (outcome.action != court::Action::TurnOn) {
    return;
  }
  const proto::Court court = static_cast<proto::Court>(outcome.court);
  static_cast<void>(sendToMega(proto::Frame::on(court, outcome.durationMs / 1000U)));
  if (outcome.court < 4U) {
    gHeld[outcome.court] = HeldSince{gClock.nowMs(), true};
  }
}

void handleScan(const proto::Frame& frame, uint32_t nowMs) {
  // Remembered so a following walk-up knows WHO is buying. The scanned bytes, not the
  // roster's token: a walk-up member has no booking and so no roster entry, and the API is
  // the only thing that can verify a 60-second signed QR anyway.
  snprintf(gLastScan, sizeof(gLastScan), "%s", frame.arg(0));
  gScanAt.arm(nowMs, kScanMemoryMs);

  // The court a scan belongs to is the court the box is fitted at, which is the
  // court_number the API assigned it — not something in the scanned bytes. A
  // barcode that could name its own court would be a barcode that opens any
  // court in the club.
  const court::Outcome outcome = gSession.onScan(frame.arg(0), gCourtNumber, eventq::Method::Qr, nowMs);
  applyOutcome(outcome);
}

void handleMegaEvent(const proto::Frame& frame, uint32_t nowMs) {
  // `!EVT,AUTOOFF,<court>` is the Mega's independent timer releasing a court on
  // its own. It is the one event the ESP does not initiate and must not miss:
  // it is how the club learns the court was used for the time it was used,
  // rather than for the time it was booked.
  const char* name = frame.arg(0);
  if (strcmp(name, "AUTOOFF") != 0 && strcmp(name, "OFF") != 0) {
    return;
  }
  const char* courtText = frame.arg(1);
  if (courtText[0] < 'A' || courtText[0] > 'D') {
    return;
  }
  const uint8_t court = static_cast<uint8_t>(courtText[0] - 'A');
  applyOutcome(
      gSession.onRelease(court, gHeld[court].held ? tb::since(nowMs, gHeld[court].sinceMs) : 0U, nowMs));
  gHeld[court] = HeldSince{};
}

/// Forward declaration: the button handler sits with the rest of the uplink handling, and
/// the walk-up request sits with the other API calls it shares helpers with. Moving either
/// to satisfy the compiler would put it away from the code it belongs with.
void requestWalkUp(const court::WalkUpIntent& intent);

/// A debounced press, interpreted through the map the API pushed.
///
/// The walk-up request is deliberately NOT priced here. A walk-up is truncated at
/// the next booking and charged pro rata, and the box knows neither the tariff nor
/// the next booking — so it asks. That makes walk-ups the one thing that needs the
/// network, which is the right way round: refusing to sell new time is a member at
/// the desk, where refusing a booking they already paid for is a member in the dark.
void handleButton(const proto::Frame& frame, uint32_t nowMs) {
  // `!BTN` carries a key CHARACTER — 'A'-'D' then '1'-'4' — not a decimal index.
  // The translation lives in lib/court so the corpus tests it; see
  // court::buttonIndexFromWire for what reading it as decimal used to cost.
  uint8_t index = 0U;
  if (!court::buttonIndexFromWire(frame.arg(0), index)) {
    return;
  }

  switch (gPad.press(gButtons, index, nowMs)) {
  case court::PadResult::CourtSelected: {
    char line[court::kLineLen + 1U] = "COURT ?";
    line[6] = static_cast<char>('A' + gPad.selectedCourt());
    static_cast<void>(sendToMega(proto::Frame::lcd(line, "CHOOSE TIME")));
    return;
  }
  case court::PadResult::Requested:
    requestWalkUp(gPad.intent());
    return;
  case court::PadResult::ReleaseRequested:
    static_cast<void>(sendToMega(proto::Frame::off(static_cast<proto::Court>(gPad.intent().court))));
    return;
  case court::PadResult::Ignored:
    return;
  }
}

void handleUplink(const proto::Decoder::Result& result, uint32_t nowMs) {
  if (!result.isFrame()) {
    // A line from the Mega that did not decode. Counted by the decoder; nothing
    // to queue, because there is no event here — only a bad cable.
    return;
  }

  switch (result.frame.verb()) {
  case proto::Verb::Pong:
    noteMegaPong(result.frame);
    return;
  case proto::Verb::Scan:
    handleScan(result.frame, nowMs);
    return;
  case proto::Verb::Evt:
    handleMegaEvent(result.frame, nowMs);
    return;
  case proto::Verb::Btn:
    handleButton(result.frame, nowMs);
    return;
  default:
    // `!STATE` is the Mega telling us which relays it believes are closed. Read for
    // diagnostics only: the Mega's own timer is the authority on when a court goes
    // dark, and second-guessing it from here is how the two halves start
    // disagreeing about a live court.
    return;
  }
}

void pumpMegaLink(uint32_t nowMs) {
  uint8_t byte = 0U;
  for (uint16_t i = 0U; i < kBytesPerPass && gMega.read(byte); ++i) {
    if (!gUplink.feed(static_cast<char>(byte))) {
      continue;
    }
    proto::Decoder::Result result;
    while (gUplink.pop(result)) {
      handleUplink(result, nowMs);
    }
  }
}

/// Reads a stored value into a NUL-terminated buffer. False when absent.
bool loadText(const char* key, char* out, size_t cap) {
  uint8_t raw[hal::kStoreMaxValueLen];
  uint8_t len = 0U;
  if (gStore.get(key, raw, sizeof(raw), len) != hal::StoreResult::kOk || len == 0U || len + 1U > cap) {
    return false;
  }
  memcpy(out, raw, len);
  out[len] = '\0';
  return true;
}

/// Rebuilds the credential from the store at boot.
///
/// Both halves of the key must be present and decode. A box holding half a key
/// would sign every request wrongly and read the resulting 401 as a revoked
/// credential — so a partial store is treated as no credential at all, and the
/// box goes back to announcing itself for an admin to claim.
bool loadCredentials() {
  char keyHexA[hal::kStoreMaxValueLen + 1U] = {};
  char keyHexB[hal::kStoreMaxValueLen + 1U] = {};
  if (!loadText(kKeyDeviceId, gDeviceId, sizeof(gDeviceId)) ||
      !loadText(kKeyDeviceKey, keyHexA, sizeof(keyHexA)) ||
      !loadText(kKeyDeviceKey2, keyHexB, sizeof(keyHexB))) {
    return false;
  }

  char keyHex[(kDeviceKeyBytes * 2U) + 1U] = {};
  const size_t lenA = strlen(keyHexA);
  const size_t lenB = strlen(keyHexB);
  if (lenA + lenB != kDeviceKeyBytes * 2U) {
    return false;
  }
  memcpy(keyHex, keyHexA, lenA);
  memcpy(keyHex + lenA, keyHexB, lenB);

  size_t decoded = 0U;
  if (!dc::hex::decode(keyHex, kDeviceKeyBytes * 2U, gDeviceKey, sizeof(gDeviceKey), &decoded) ||
      decoded != kDeviceKeyBytes) {
    return false;
  }

  // Best-effort: a board provisioned before the slug was stored still runs, it
  // just falls back to the unclaimed announce until it is re-provisioned. The
  // device id and key are what make it FUNCTION; the slug only changes what it
  // says about itself.
  if (!loadText(kKeyTenantSlug, gTenantSlug, sizeof(gTenantSlug))) {
    gTenantSlug[0] = '\0';
  }

  devapi::Credentials credentials;
  credentials.deviceId = gDeviceId;
  credentials.key = dc::ByteSpan{gDeviceKey, kDeviceKeyBytes};
  gApi.setCredentials(credentials);
  return true;
}

/// One signed call. Returns the HTTP status, or 0 when it never completed.
///
/// The response body is read into a caller buffer rather than a String: the ESP's
/// heap is shared with the TLS stack, and a heartbeat that allocates four times a
/// minute is a heap that fragments over a season in a cupboard.
uint16_t callApi(const char* method, const char* path, const char* body, char* out, size_t outCap) {
  if (gApiUrl[0] == '\0') {
    return 0U;
  }

  devapi::Call call;
  call.method = method;
  call.pathAndQuery = path;
  call.body = body;
  call.bodyLen = body == nullptr ? 0U : strlen(body);

  devapi::RequestBuffers buffers;
  devapi::SignedRequest signed_;
  if (!gApi.sign(call, static_cast<uint32_t>(gUptime.value()), buffers, signed_)) {
    // No credential, or no clock yet. Both are local refusals on purpose — a
    // request signed with a timestamp of zero comes back 401 and reads exactly
    // like a revoked key.
    return 0U;
  }

  char url[160];
  snprintf(url, sizeof(url), "%s%s", gApiUrl, path);

  WiFiClient client;
  HTTPClient http;
  if (!http.begin(client, url)) {
    return 0U;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader(devapi::kHeaderDeviceId, signed_.deviceId);
  http.addHeader(devapi::kHeaderTimestamp, signed_.timestamp);
  http.addHeader(devapi::kHeaderNonce, signed_.nonce);
  http.addHeader(devapi::kHeaderSignature, signed_.signature);

  const int status = http.POST(reinterpret_cast<const uint8_t*>(signed_.body), signed_.bodyLen);
  if (status > 0 && out != nullptr && outCap > 0U) {
    const String payload = http.getString();
    const size_t n = payload.length() < outCap - 1U ? payload.length() : outCap - 1U;
    memcpy(out, payload.c_str(), n);
    out[n] = '\0';
  }
  http.end();
  return status > 0 ? static_cast<uint16_t>(status) : 0U;
}

/// Buys court time, which is the one court-box operation that needs the network.
///
/// The price is not decided here and cannot be: a walk-up is truncated at the next booking
/// and charged pro rata, and the box knows neither the tariff nor the next booking. Guessing
/// at either sells a member something the club did not agree to. So it asks, and shows what
/// the API answered.
void requestWalkUp(const court::WalkUpIntent& intent) {
  if (gLastScan[0] == '\0') {
    // Nobody has identified. The buttons alone cannot say WHO is buying, and a walk-up
    // charged to the last person who happened to scan is worse than one refused.
    static_cast<void>(sendToMega(proto::Frame::lcd("SCAN FIRST", "THEN PICK A TIME")));
    return;
  }

  static_cast<void>(sendToMega(proto::Frame::lcd("ONE MOMENT", "")));

  char body[320];
  snprintf(body, sizeof(body), "{\"minutes\":%u,\"method\":\"qr\",\"token\":\"%s\"}",
           static_cast<unsigned>(intent.minutes), gLastScan);

  char response[256] = {};
  const uint16_t status = callApi("POST", "/api/v1/device/walkup", body, response, sizeof(response));

  if (status != 200U) {
    // Every refusal reads differently to somebody standing in a corridor. 402 is the one
    // they can act on themselves.
    const char* line = status == 402U   ? "NOT ENOUGH CREDIT"
                       : status == 409U ? "COURT NOT FREE"
                       : status == 0U   ? "NO CONNECTION"
                                        : "SEE THE DESK";
    static_cast<void>(sendToMega(proto::Frame::lcd(line, "SCAN TO START")));
    return;
  }

  // What was ACTUALLY sold, from the response — not what was asked for. Twenty minutes may
  // be all there was, and telling the member sixty would be a complaint waiting to happen.
  const size_t len = strlen(response);
  uint32_t granted = intent.minutes;
  static_cast<void>(devapi::json::unsignedField(response, len, "granted_minutes", granted));

  char line2[court::kLineLen + 1U];
  snprintf(line2, sizeof(line2), "%lu MIN", static_cast<unsigned long>(granted));

  char line1[court::kLineLen + 1U] = "COURT ?";
  line1[6] = static_cast<char>('A' + intent.court);
  static_cast<void>(sendToMega(proto::Frame::lcd(line1, line2)));
  static_cast<void>(sendToMega(proto::Frame::on(static_cast<proto::Court>(intent.court), granted * 60U)));
  if (intent.court < 4U) {
    gHeld[intent.court] = HeldSince{gClock.nowMs(), true};
  }
  gLastScan[0] = '\0';
}

/// Persists what provisioning returned.
///
/// The key is written in two halves because hal::IStore caps a value at 32 bytes
/// and 32 key bytes are 64 hex characters. Both halves and the id must land or
/// the whole thing is treated as absent — see loadCredentials.
bool storeProvisioning(const char* body, size_t len) {
  char deviceId[devapi::kMaxDeviceIdLen + 1U] = {};
  char keyHex[(kDeviceKeyBytes * 2U) + 1U] = {};
  char baseUrl[hal::kStoreMaxValueLen + 1U] = {};

  if (!devapi::json::stringField(body, len, "device_id", deviceId, sizeof(deviceId)) ||
      !devapi::json::stringField(body, len, "device_key", keyHex, sizeof(keyHex))) {
    return false;
  }
  if (strlen(keyHex) != kDeviceKeyBytes * 2U) {
    return false;
  }

  const uint8_t half = static_cast<uint8_t>(kDeviceKeyBytes);
  bool ok =
      gStore.put(kKeyDeviceId, reinterpret_cast<const uint8_t*>(deviceId),
                 static_cast<uint8_t>(strlen(deviceId))) == hal::StoreResult::kOk &&
      gStore.put(kKeyDeviceKey, reinterpret_cast<const uint8_t*>(keyHex), half) == hal::StoreResult::kOk &&
      gStore.put(kKeyDeviceKey2, reinterpret_cast<const uint8_t*>(keyHex + half), half) ==
          hal::StoreResult::kOk;

  // The tenant slug, so the board can announce as claimed. Part of the credential
  // set: a stored key with no slug beside it cannot say which club it belongs to,
  // and would go on advertising itself as unclaimed.
  char tenantSlug[hal::kStoreMaxValueLen + 1U] = {};
  if (devapi::json::stringField(body, len, "tenant_slug", tenantSlug, sizeof(tenantSlug)) &&
      tenantSlug[0] != '\0') {
    ok = ok && gStore.put(kKeyTenantSlug, reinterpret_cast<const uint8_t*>(tenantSlug),
                          static_cast<uint8_t>(strlen(tenantSlug))) == hal::StoreResult::kOk;
  } else {
    ok = false;
  }

  // An explicitly advertised base URL wins over the one discovery offered, for a
  // club that fronts the API with a name the boards must use instead.
  if (devapi::json::stringField(body, len, "api_base_url", baseUrl, sizeof(baseUrl))) {
    rememberApiUrl(baseUrl);
    snprintf(gApiUrl, sizeof(gApiUrl), "%s", baseUrl);
  }
  return ok;
}

/// The one unsigned call: collecting a device key with the claim code.
///
/// Unsigned because the box has nothing to sign with yet, which is the whole
/// reason this endpoint is anonymous on the server. It also seeds the clock: the
/// response carries server_unix, and without it the first signed request would be
/// refused locally for having no clock at all.
void tryProvision() {
  if (gProvisioned || !gWifiUp || gApiUrl[0] == '\0') {
    return;
  }

  char body[128];
  snprintf(body, sizeof(body), "{\"mac\":\"%s\",\"claim_code\":\"%s\"}", gMacHex, gClaimCode.lcdText());

  char url[160];
  snprintf(url, sizeof(url), "%s/api/v1/device/provision", gApiUrl);

  WiFiClient client;
  HTTPClient http;
  if (!http.begin(client, url)) {
    return;
  }
  http.addHeader("Content-Type", "application/json");
  const int status = http.POST(body);
  if (status != 200) {
    // A 404 is the normal answer: no admin has pressed "connect" yet. It is
    // indistinguishable from a wrong code on purpose, so there is nothing to
    // report and nothing to back off from beyond the announce interval.
    http.end();
    return;
  }

  const String payload = http.getString();
  http.end();

  gApi.adoptServerTime(devapi::findServerUnix(payload.c_str(), payload.length()),
                       static_cast<uint32_t>(gUptime.value()));

  if (!storeProvisioning(payload.c_str(), payload.length())) {
    return;
  }
  gProvisioned = loadCredentials();
  if (gProvisioned) {
    static_cast<void>(sendToMega(proto::Frame::lcd("CONNECTED", "SCAN TO START")));
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

/// Applies the `button_map` array out of a heartbeat response.
///
/// Reset first, so a response carrying fewer than eight entries cannot leave the
/// tail of the previous map behind — a partial map is a panel where some buttons
/// obey the admin and others obey whoever set them last.
///
/// An absent array leaves the working map alone. An older API that does not send
/// one must not blank a panel an admin configured through a newer one.
void applyButtonMap(const char* body, size_t len) {
  size_t at = devapi::json::findArray(body, len, "button_map");
  if (at == devapi::json::kNotFound) {
    return;
  }

  gButtons.reset();
  char token[32] = {};
  for (uint8_t index = 0U; index < court::kButtonCount; ++index) {
    if (!devapi::json::nextStringElement(body, len, at, token, sizeof(token))) {
      break;
    }
    // A token this build does not understand leaves that entry at its default,
    // which is a working button rather than a dead one.
    static_cast<void>(gButtons.setFromWire(index, token));
  }
}

/// Takes the update the heartbeat offered, if the policy says so.
///
/// The public half of the firmware signing pair, compiled in at build time.
///
/// Empty by default, and an empty key means no update installs at all. Supply it
/// with -DCRUSADERS_OTA_SIGNED=1 and -DCRUSADERS_OTA_PUBLIC_KEY='"...PEM..."'
/// once the pair exists; generating it is go-live item 5. Ed25519 or RSA, not an
/// HMAC with the device key — a shared secret means one compromised box can
/// forge firmware for the whole fleet, which is the failure this is here to
/// prevent.
#ifndef CRUSADERS_OTA_SIGNED
#define CRUSADERS_OTA_SIGNED 0
#endif
#ifndef CRUSADERS_OTA_PUBLIC_KEY
#define CRUSADERS_OTA_PUBLIC_KEY ""
#endif

constexpr char kOtaPublicKey[] = CRUSADERS_OTA_PUBLIC_KEY;

/// True only when this build carries a key it can verify against.
constexpr bool kOtaSignatureEnforced = (CRUSADERS_OTA_SIGNED != 0) && (sizeof(kOtaPublicKey) > 1U);

/// Every refusal reason is logged to the Mega's display rather than swallowed: a
/// fleet quietly declining an update is exactly the silence that gets noticed a
/// week after the release was promoted everywhere.
void considerUpdate(const char* body, size_t len) {
  const ota::Manifest manifest = ota::parseManifest(body, len);
  const ota::Decision decision =
      ota::decide(manifest, fw::kFirmwareVersion, gBootGuard, ESP.getFreeSketchSpace());

  if (decision != ota::Decision::Install) {
    return;
  }

  // Armed BEFORE the flash. An update interrupted mid-write leaves a box that may
  // not come up at all, and this marker is the only thing that will tell the next
  // working firmware what happened.
  gBootGuard.arm(manifest.version);
  static_cast<void>(sendToMega(proto::Frame::lcd("UPDATING", "DO NOT POWER OFF")));

  // NOTHING IS INSTALLED UNTIL THERE IS A KEY TO VERIFY IT WITH.
  //
  // This used to carry a comment saying "the image is signature-checked by the
  // core's Updater against a public key compiled into this build". It was not.
  // There is no Update.installSignature call, no BearSSL::PublicKey, no
  // SigningVerifier and no .pem anywhere in the tree — the key pair has never
  // been generated, which is go-live item 5 and known. The comment described the
  // intended design as though it were the shipped one, which is the worst kind of
  // comment to leave on a security boundary: a reviewer reads it and signs off.
  //
  // What was actually there: a plain-HTTP fetch of a URL taken from an
  // unauthenticated response body, flashed and rebooted into, on a board driving
  // four mains lighting relays. Refusing is the only honest behaviour until the
  // key exists, and refusing LOUDLY — on the display and through the boot guard —
  // is what stops a fleet silently declining every release.
  if (!kOtaSignatureEnforced) {
    gBootGuard.confirm();
    static_cast<void>(sendToMega(proto::Frame::lcd("UPDATE BLOCKED", "NO SIGNING KEY")));
    return;
  }

  WiFiClient client;
  ESPhttpUpdate.rebootOnUpdate(true);
#if CRUSADERS_OTA_SIGNED
  // Verified by the core's Updater against the key compiled into this build. A
  // box that has been stolen yields nothing that can sign firmware for any other,
  // which is why this is a public key here and not the device's HMAC secret.
  static BearSSL::PublicKey otaKey(kOtaPublicKey);
  static BearSSL::HashSHA256 otaHash;
  static BearSSL::SigningVerifier otaVerifier(&otaKey);
  Update.installSignature(&otaHash, &otaVerifier);
#endif
  const t_httpUpdate_return outcome = ESPhttpUpdate.update(client, manifest.url);
  if (outcome == HTTP_UPDATE_FAILED) {
    // Never installed, so the marker would condemn a build that never ran. Clearing
    // it by confirming is correct: nothing is pending.
    gBootGuard.confirm();
    static_cast<void>(sendToMega(proto::Frame::lcd("UPDATE FAILED", "SCAN TO START")));
  }
}

/// One queued event as the upload endpoint's JSON.
///
/// `method` is omitted as a null rather than sent as the string "none", matching what
/// eventq::methodName returns — a release has no identification method, and pretending it
/// had one puts a fiction in the audit trail.
void renderEvent(const eventq::Event& event, char* out, size_t outCap) {
  char subject[eventq::kMaxSubjectLen + 1U] = {};
  memcpy(subject, event.subject, event.subjectLen);

  const char* method = eventq::methodName(event.method);
  char methodJson[16] = "null";
  if (method != nullptr) {
    snprintf(methodJson, sizeof(methodJson), "\"%s\"", method);
  }

  snprintf(out, outCap,
           "{\"uptime_ms\":%lu,\"events\":[{\"seq\":%lu,\"uptime_ms\":%lu,\"kind\":\"%s\","
           "\"court\":%d,\"method\":%s,\"subject\":\"%s\",\"duration_ms\":%lu}]}",
           static_cast<unsigned long>(gUptime.value()), static_cast<unsigned long>(event.seq),
           static_cast<unsigned long>(event.uptimeMs), eventq::kindName(event.kind),
           event.court == eventq::Event::kNoCourt ? -1 : static_cast<int>(event.court), methodJson, subject,
           static_cast<unsigned long>(event.durationMs));
}

/// Uploads what the box did, oldest first, and releases only what was acknowledged.
///
/// Peek-then-release rather than pop-then-upload: an event must not leave the queue until
/// the API has taken it, or a flaky link loses exactly the events it produces. The response
/// names the highest sequence accepted, so a partial success costs nothing — whatever came
/// after simply stays queued and is offered again.
void drainEvents() {
  if (!gProvisioned || !gWifiUp || gQueue.empty()) {
    return;
  }

  // One event per pass. A board back from a week offline has a full ring, and draining it
  // all in one loop iteration would starve the Mega link — which is how a flooded uplink
  // becomes a court whose lights stay on.
  eventq::Event event;
  if (!gQueue.peek(event)) {
    return;
  }

  char body[384];
  renderEvent(event, body, sizeof(body));

  char response[192] = {};
  devapi::Response result;
  result.status = callApi("POST", "/api/v1/device/events", body, response, sizeof(response));
  result.serverUnix = devapi::findServerUnix(response, strlen(response));

  switch (gApi.react(result, static_cast<uint32_t>(gUptime.value()))) {
  case devapi::Reaction::Accepted: {
    uint32_t through = 0U;
    if (devapi::json::unsignedField(response, strlen(response), "accepted_through", through)) {
      static_cast<void>(gQueue.releaseThrough(through));
    }
    return;
  }
  case devapi::Reaction::Rejected:
    // A 4xx the box caused. Retrying an identical request forever pins every later event
    // behind one the server will never take, so it is dropped and the next one gets a turn.
    static_cast<void>(gQueue.release());
    return;
  default:
    // Transient, or the clock was corrected. Keep the event and try again next pass.
    return;
  }
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

  if (!gProvisioned || !gWifiUp) {
    return;
  }

  char body[192];
  snprintf(body, sizeof(body),
           "{\"running_version\":\"%s\",\"mega_version\":\"%s\",\"uptime_seconds\":%lu,"
           "\"wifi_rssi\":%ld,\"failed_version\":\"%s\"}",
           fw::kFirmwareVersion, gMegaVersion[0] == '\0' ? "" : gMegaVersion,
           static_cast<unsigned long>(uptimeSeconds()), static_cast<long>(WiFi.RSSI()),
           gBootGuard.badVersion());

  char response[512] = {};
  devapi::Response result;
  result.status = callApi("POST", "/api/v1/device/heartbeat", body, response, sizeof(response));
  result.serverUnix = devapi::findServerUnix(response, strlen(response));

  switch (gApi.react(result, static_cast<uint32_t>(gUptime.value()))) {
  case devapi::Reaction::Accepted:
    // The evidence that clears a pending update. Not "it booted" — a firmware that
    // comes up and cannot authenticate looks alive and does nothing, which is worse
    // than one that does not come up at all.
    gBootGuard.confirm();
    applyButtonMap(response, strlen(response));
    considerUpdate(response, strlen(response));
    return;
  case devapi::Reaction::ClockCorrected:
    // The offset is fixed and the next attempt is expected to work, so do not
    // wait a full interval to find out.
    gHeartbeat.arm(nowMs, 1000UL);
    return;
  case devapi::Reaction::Reprovision:
    // The server does not accept this credential. Hammering it with a revoked key
    // is how a board gets rate limited out of ever recovering, so the box goes
    // back to announcing itself and waits to be claimed again.
    gProvisioned = false;
    showClaimPrompt();
    return;
  case devapi::Reaction::Rejected:
  case devapi::Reaction::Retry:
    return;
  }
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

  // A box that has been claimed before comes back up already provisioned: the key
  // is in flash and there is nothing for an admin to do. One that has not falls
  // through to announcing itself, which is the same path a brand-new board takes.
  // Before anything else touches the store: this counts the boot against a pending
  // update and may condemn a build that has never worked.
  static_cast<void>(gBootGuard.begin());

  static_cast<void>(loadText(kKeyApiUrl, gApiUrl, sizeof(gApiUrl)));
  gProvisioned = loadCredentials();

  const uint32_t now = gClock.nowMs();
  gUptime.seed(now);
  gHeartbeat.arm(now, kHeartbeatMs);

  gQueue.begin();
  gSession.onBoot(now);
}

void loop() {
  // One clock read per pass, shared by every sub-step, so the heartbeat and the
  // announce schedule are never evaluated against two different instants.
  const uint32_t now = gClock.nowMs();
  gUptime.tick(now);

  // A court selected and then abandoned lapses on its own, so the next member to
  // press a duration button does not inherit somebody else's half-made purchase.
  if (gPad.tick(now)) {
    static_cast<void>(sendToMega(proto::Frame::lcd("CRUSADERS COURTS", "SCAN TO START")));
  }
  if (gLastScan[0] != '\0' && gScanAt.expired(now)) {
    gLastScan[0] = '\0';
  }

  pumpWifiLink(now);
  tryProvision();
  pumpMegaLink(now);
  drainEvents();
  pumpHeartbeat(now);
  pumpOffers();

  if (gAnnouncer.due(now)) {
    broadcastAnnounce();
  }
}

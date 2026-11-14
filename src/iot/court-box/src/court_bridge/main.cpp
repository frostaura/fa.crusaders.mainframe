// Crusaders Mainframe — ESP8266 firmware: the composition root.
//
// WHAT THIS FILE IS
// -----------------
// Wiring, and the small amount of sequencing that only a composition root can
// do. Every decision about WHICH implementation of a port to use is here; every
// decision a host test could want to drive is in lib/, where
// `pio test -e native` reaches it with no board attached.
//
// WHY THIS HALF EXISTS
// --------------------
// It is the half that talks to the network, so everything volatile lives here
// and the Mega stays near-static. The bridge is updated only by cable, at the
// box, so nothing an operator does — a rotated key, a new router, a moved
// server — may need one (device-api.md §6, §8). The four
// values compiled in from src/common/secrets.h (the WiFi SSID and password, the
// API base URL and the device API key) are only the FIRST-BOOT DEFAULTS; what
// the server sends since is kept in flash. There is still
// no discovery and no claim flow. See src/iot/court-box/README.md's Flashing
// section.
//
// HOW THE BOX AUTHENTICATES
// -------------------------
// `Authorization: Bearer <key>` on every call — the compiled DEVICE_API_KEY
// (k0) until the server's `key_next` replaces it — and its own MAC in
// every request body. The server resolves the key to a tenant and the MAC to a
// device, registering the device itself the first time it sees a new one. There
// is no signature, no timestamp and no clock: the box has no RTC, and the whole
// apparatus that used to let it sign anyway — an offset over millis(), a
// zero-timestamp probe, a skew tolerance, two strike counters — existed only to
// support signing.
//
// The key is a real secret even though the box never leaves the club LAN. The
// backend is on that LAN with it, but its public surface is a Cloudflare tunnel
// — that is how members book and how the admin works remotely — so
// `/api/v1/device/*` is reachable from the internet and the key is what stands
// in front of it.
//
// NO STATIC IP, DELIBERATELY
// --------------------------
// Carl's sketch hardcodes 192.168.68.150 with WiFi.config(). That works exactly
// until somebody changes the router, the subnet, or plugs in a second board.
// This firmware takes a DHCP lease and identifies itself by MAC instead. There
// is no WiFi.config() call anywhere in this repo and there must not be one.
//
// WHY THERE IS NO SERIAL DEBUG OUTPUT
// -----------------------------------
// `Serial` IS the link to the Mega on this board, at 9600 8N1, routed by the
// DIP block. A Serial.println() here is a line of debug text arriving at the
// Mega's frame decoder, which answers it with `!EVT,BADFRAME` — and that report
// is an `!ON`/`!EXT` retry trigger, so stray prose is not merely untidy.
// Nothing in this file writes prose to the UART.
//
// THE COURT WORKS WHEN THE NETWORK DOES NOT
// -----------------------------------------
// A scan on a box that can reach the API asks the API, because only the API
// knows about a booking made thirty seconds ago, a walk-up member with no
// booking, or a balance too low to admit. Its answer is final. When the API
// cannot be asked — no link, a transport failure, a 5xx — the scan is decided
// HERE, from the roster cache the heartbeat fills, in microseconds, and the box
// queues what it did; the API hears about it when it can. A router reboot is a
// slower scan, not a dark court. The flow itself is in lib/bridgelogic/ScanFlow,
// where the host suite drives every branch.
//
// The event queue is therefore not a nicety. Under charge-at-booking the member
// has ALREADY been debited, and the activation event is what stops the no-show
// sweep reversing it — a court lit and never reported looks exactly like a
// member who stayed home. See lib/eventq, which also states plainly what the
// queue does not survive. An activation the API itself granted is NOT queued:
// the queue is the record of what the API did not hear.
//
// WHAT THIS FILE DOES NOT DECIDE
// ------------------------------
// Anything a host test could want to drive. What a heartbeat's roster means,
// what an activate response means, when a `!STATE` mask contradicts a held
// court, what any request body looks like on the wire — all of it is in
// lib/bridgelogic. This file owns the socket, the flash store and the Mega
// link, and wires the answers to them.

#include <Arduino.h>
#include <ESP8266HTTPClient.h>
#include <ESP8266WiFi.h>

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "EspLifeline.h"
#include "arduino_hal/ArduinoClock.h"
#include "arduino_hal/LittleFsStore.h"
#include "arduino_hal/SerialTransport.h"
#include "bridgelogic/AuthPolicy.h"
#include "bridgelogic/BootId.h"
#include "bridgelogic/CallBudget.h"
#include "bridgelogic/EventDrain.h"
#include "bridgelogic/Extend.h"
#include "bridgelogic/FaultLog.h"
#include "bridgelogic/Lifeline.h"
#include "bridgelogic/MegaLink.h"
#include "bridgelogic/MegaTx.h"
#include "bridgelogic/MemberScan.h"
#include "bridgelogic/OnRetry.h"
#include "bridgelogic/Persist.h"
#include "bridgelogic/Relight.h"
#include "bridgelogic/RestorePlan.h"
#include "bridgelogic/ScanFlow.h"
#include "bridgelogic/ScanMemory.h"
#include "bridgelogic/ScreenScript.h"
#include "bridgelogic/StateReconcile.h"
#include "bridgelogic/V3Heartbeat.h"
#include "bridgelogic/WalkUp.h"
#include "bridgelogic/WallClock.h"
#include "court/ButtonMap.h"
#include "court/Session.h"
#include "court/WalkUpPad.h"
#include "devapi/DeviceClient.h"
#include "devapi/Json.h"
#include "devcrypto/Hex.h"
#include "devlink/ApiBreaker.h"
#include "devlink/Cadence.h"
#include "devlink/CodeSync.h"
#include "devlink/EventUpload.h"
#include "devlink/LcdSettings.h"
#include "devlink/RosterSync.h"
#include "devnet/JsonMember.h"
#include "devnet/Net.h"
#include "eventq/EventQueue.h"
#include "fwversion/Version.h"
#include "memcode/GuessGuard.h"
#include "memcode/KeyRing.h"
#include "memcode/ReplayRing.h"
#include "memcode/StepClock.h"
#include "memcode/Token.h"
#include "protocol/Codec.h"
#include "protocol/Protocol.h"
#include "roster/Roster.h"
#include "timebase/TimeBase.h"

// The four compiled-in values, all MANDATORY, and all first-boot defaults:
// the runtime set the server sends, kept in flash, wins once there is one.
//
// The build fails rather than producing an image with a blank in it — an image
// that joins an empty SSID, or posts to an empty base URL with an empty bearer
// key, looks identical to a working one until it is screwed to a wall.
#if !__has_include("common/secrets.h")
#error                                                                                                       \
    "src/iot/court-box/src/common/secrets.h is missing — copy secrets.h.example to secrets.h and fill in WIFI_SSID, WIFI_PASSWORD, API_BASE_URL and DEVICE_API_KEY"
#endif
#include "common/secrets.h"

#ifndef WIFI_SSID
#error "secrets.h does not define WIFI_SSID — see src/iot/court-box/src/common/secrets.h.example"
#endif
#ifndef WIFI_PASSWORD
#error "secrets.h does not define WIFI_PASSWORD — see src/iot/court-box/src/common/secrets.h.example"
#endif
#ifndef API_BASE_URL
#error "secrets.h does not define API_BASE_URL — see src/iot/court-box/src/common/secrets.h.example"
#endif
#ifndef DEVICE_API_KEY
#error "secrets.h does not define DEVICE_API_KEY — see src/iot/court-box/src/common/secrets.h.example"
#endif
static_assert(sizeof(WIFI_SSID) > 1U,
              "WIFI_SSID in secrets.h is empty — fill it in before flashing the bridge");
static_assert(sizeof(WIFI_PASSWORD) > 1U,
              "WIFI_PASSWORD in secrets.h is empty — fill it in before flashing the bridge");
static_assert(sizeof(API_BASE_URL) > 1U,
              "API_BASE_URL in secrets.h is empty — e.g. \"http://192.168.1.10:8088\"");
static_assert(sizeof(DEVICE_API_KEY) > 1U,
              "DEVICE_API_KEY in secrets.h is empty — copy it from the admin Devices page");
static_assert(sizeof(DEVICE_API_KEY) - 1U <= devapi::kMaxApiKeyLen,
              "DEVICE_API_KEY is longer than devapi::kMaxApiKeyLen — a truncated key is a 401 that "
              "reads exactly like the wrong key");

namespace {

/// The receive ring for bytes coming FROM the Mega, sized to the worst-case
/// blocking HTTP window.
///
/// The ESP8266 makes synchronous HTTP calls in its main loop, and its UART fills
/// this ring by interrupt while a call is in flight. The core default is 256
/// bytes — ~267 ms at 9600 baud — so a scan or an `!EVT,AUTOOFF` release arriving
/// during a heartbeat or walk-up POST was dropped mid-frame. At 960 bytes/s, this
/// holds ~4.3 s, which covers a call bounded by bridgelogic::kCallBudgetMs even if the ring
/// was not freshly drained. It is a mitigation, not a cure: only non-blocking
/// HTTP removes the window entirely, and a call that exceeds the timeout can
/// still overrun this. The per-frame cost of an overrun is bounded to one frame
/// regardless, because the decoder resynchronises on the next delimiter.
constexpr size_t kMegaRxBufferBytes = 4096U;

/// Blocking HTTP is bounded so the window above stays inside the ring: ONE
/// budget for the whole call, retry included (bridgelogic::CallBudget, BR-11 —
/// a per-phase timeout let a stalled server hold the loop three times over). A
/// genuinely slow response is retried on the next heartbeat rather than allowed
/// to starve the Mega link.
static_assert(bridgelogic::kCallBudgetMs * 960UL / 1000UL <= kMegaRxBufferBytes,
              "the whole-call budget must fit the Mega receive ring at 9600 baud");

/// Bytes drained from the Mega link per pass, matching the UART ring.
constexpr uint16_t kBytesPerPass = 64U;

/// The heartbeat interval until the API says otherwise. The tenant's
/// `heartbeat_seconds` is adopted from every accepted heartbeat, bounded by
/// devlink::Cadence; this is only where a box starts.
constexpr uint32_t kHeartbeatMs = 30000UL;

#ifdef HEARTBEAT_INTERVAL_MS
static_assert(HEARTBEAT_INTERVAL_MS == kHeartbeatMs,
              "kHeartbeatMs and the HEARTBEAT_INTERVAL_MS build flag have drifted apart");
#endif

uint32_t gHeartbeatMs = kHeartbeatMs;

arduino_hal::ArduinoClock gClock;
arduino_hal::SerialTransport gMega(Serial);

/// The ONLY thing this box persists: the event queue's sequence high-water
/// mark. Everything else that used to live in flash — the device id, the device
/// key, the tenant slug, the API base URL, the WiFi credential — is compiled in
/// or does not exist any more.
///
/// The mark stays because the API deduplicates events on `(tenant, device,
/// seq)` with a unique index, permanently. A box that restarted its numbering
/// at 1 after every power cut would have every event up to its previous
/// high-water silently discarded as a duplicate — which, under charge-at-
/// booking, is the no-show sweep refunding-and-penalising members who played.
/// One record, one write per 64 events. See lib/eventq.
arduino_hal::LittleFsStore gStore;

proto::Decoder gUplink(proto::Link::Uplink);
tb::Uptime64 gUptime;
tb::Deadline gHeartbeat;

/// This box's MAC as 12 lowercase hex characters, filled once at boot and then
/// read-only. It is the whole of the box's identity: it goes in the body of
/// every request, and an unknown one auto-registers a device against the key's
/// tenant.
char gMacHex[dc::hex::encodedSize(6U)];

/// THIS BOOT'S IDENTITY — the third field of the server's idempotency key.
///
/// Drawn once in setup(), after WiFi.begin(), and read-only thereafter. The ESP
/// hardware RNG (RANDOM_REG32) is fed by RF noise and is only well distributed
/// once the radio is up, which is why it is not a static initialiser: this is a
/// de-duplication tag rather than a credential, so "well distributed enough
/// that two consecutive boots differ" is the whole requirement, but drawing it
/// before WiFi.begin() would not even meet that.
///
/// Zero is the wire's "no boot identity" and is what this file used to pass. It
/// omits the field, the server falls back to (device, seq), and a torn
/// sequence checkpoint therefore renumbers the box from 1 and has every event
/// of the next evening receipted as a duplicate — including the `boot` event
/// queued so an operator can see the restart. Under charge-at-booking that is
/// the no-show sweep refunding and penalising members who played. The
/// never-zero rule is bridgelogic::bootIdFrom's, where a test can reach it.
uint32_t gBootId = bridgelogic::kBootIdForZeroDraw;

/// The Mega's uptime from the last `!PONG`, so a restart can be detected and
/// the identity screen repainted. The Mega clears its screen on reset.
uint32_t gMegaUptime = 0U;

/// Whether any `!PONG` has arrived since this bridge booted. A separate flag
/// because `gMegaUptime` starts at 0 and 0 is a legal uptime: testing
/// `seconds < gMegaUptime` alone made the first pong of every boot invisible,
/// which is half of why the identity screen was never painted (review 3,
/// finding 9). The rule is bridgelogic::shouldRepaintIdentity's.
bool gMegaSeen = false;

/// The Mega's boot instant on this half's clock, and the `!PING` a lost line
/// earns (bridgelogic/MegaLink.h): together they find a Mega-only reset whose
/// `!BOOT` and `!STATE` the link garbled, within a second instead of ten.
bridgelogic::MegaBootClock gMegaBootClock;
bridgelogic::MegaProbe gMegaProbe;

bool gWifiUp = false;

/// The three things that let a court work with no network.
///
/// Sizes come from build flags so they are visible in platformio.ini next to
/// the board they have to fit in, and so the linker can prove they do. 64 slots
/// of ~48 bytes is about 3 KB — affordable on the ESP8266, and a whole busy
/// evening's worth of events. The roster holds exactly what the heartbeat
/// contract can send: sixteen entries, two copies (live and staging).
constexpr uint8_t kRosterSlots = devlink::kMaxRosterEntries;

eventq::EventQueue<EVENTQ_SLOTS> gQueue(&gStore);
roster::Roster<kRosterSlots> gRoster(ROSTER_MAX_AGE_MS);
court::Session<roster::Roster<kRosterSlots>, eventq::EventQueue<EVENTQ_SLOTS>> gSession(gRoster, gQueue);

/// THE SINGLE ROTATING MEMBER CODE, offline (docs/specs/member-code.md §6).
///
/// Which 30-second step it is, counted on millis() from the last heartbeat's
/// `code_step`; the per-day keys that let this box check a code's OFF half;
/// and the uses it has acted on. All three are filled by the heartbeat alone,
/// all three are RAM only — a reboot is a box that verifies nothing until its
/// first accepted heartbeat, which is also when its roster comes back — and the
/// clock is trusted for exactly as long as the roster is.
memcode::StepClock gStepClock(ROSTER_MAX_AGE_MS);
memcode::KeyRing<bridgelogic::kCourtKeyRingSlots> gKeyRing;
memcode::ReplayRing<bridgelogic::kCourtReplaySlots> gReplay;

/// How many wrong OFF codes anybody may present here before offline
/// verification locks for a while — a REF is public, so an unguarded box in its
/// offline fallback is a box that can be guessed open. memcode/GuessGuard.h.
memcode::GuessGuard gGuessGuard;

/// The server just acted on the remembered scan: record the use here too, so a
/// photo of the same v1 code cannot be used offline at this box inside its
/// window the moment the link drops. A legacy code records nothing.
void noteOnlineUse(const char* token) {
  memcode::recordOnlineUse(token, gStepClock, gKeyRing, gReplay, gClock.nowMs());
}

/// Which member each court was lit for by this box's own online call, until it
/// goes dark: a replay of that member's code on that court is their own game
/// (bridgelogic::OnlineGrants, D7-1), which the roster may not name yet.
bridgelogic::OnlineGrants gOnlineGrants;

/// Bytes for walk-up purchase nonces, from the ESP8266's hardware RNG register.
///
/// Injected behind devapi::IEntropySource rather than called directly because a
/// generator that reaches for a platform RNG cannot be tested against a fixture
/// — and the walk-up body IS pinned against one, because a nonce rendered
/// differently from the way the server reads it is a member charged twice.
///
/// HONEST LIMIT: RANDOM_REG32 is fed by RF noise and is only well distributed
/// once the radio is up. Nothing here reads it before WiFi.begin(), and it is
/// an idempotency key rather than a secret: a poor value costs a duplicate
/// purchase being wrongly deduplicated, not a security property.
class HardwareEntropy final : public devapi::IEntropySource {
public:
  uint8_t nextByte() override { return static_cast<uint8_t>(RANDOM_REG32 & 0xFFU); }
};

HardwareEntropy gRequestEntropy;

/// The courts this box drives, from the heartbeat's `court_numbers`: array
/// position is the relay index, value is the club's court number. Empty until
/// the first accepted heartbeat, and a box that drives no courts it knows of
/// refuses every walk-up locally rather than selling court zero.
///
/// The API assigns them; the box does not guess. One box serves up to four
/// courts through one scanner, so a scan's court comes from the matched roster
/// entry or the API's answer, never from a single configured number (review C4).
int16_t gCourtNumbers[devlink::kMaxCourts] = {};
uint8_t gCourtCount = 0U;

/// When each court's lights went on, so a release can report how long it was
/// actually held. This is the number a dispute about a 45-minute booking turns
/// on, and the Mega's own timer is what ends it — so the ESP has to watch for
/// the end rather than schedule it: the `!EVT` release, or failing that the
/// `!STATE` mask, which bridgelogic::reconcile compares against this.
///
/// `held` is a separate flag rather than "zero means not held", which is the
/// rule TimeBase.h states outright: every possible uint32_t is a legal millis()
/// reading, so no value is free to carry a second meaning. `sinceMs` is when the
/// belief last changed, in either direction — see StateReconcile.h for why the
/// release instant matters too.
bridgelogic::HeldState gHeld[bridgelogic::kStateCourts];

/// The club's wall clock, borrowed from `server_time` on every accepted
/// heartbeat and advanced on millis() between them. It decides what a screen
/// may SAY and nothing else: the relay deadline is the Mega's and the booking
/// window is the roster's, both millis()-relative. Past clock_trust_minutes it
/// blanks — on the wire and on every screen row that would have named a time —
/// because a stale clock reads exactly like a live one.
/// The nine operator settings, adopted from every accepted heartbeat and
/// applied NONE OF THEM RETROACTIVELY: a window that shortened under somebody
/// mid-decision is the one timeout on this box that can lose a half-made
/// purchase. Until the first heartbeat these are the compiled-in defaults,
/// which are the behaviour the hand-built box already had.
devlink::LcdSettings gLcdSettings;

bridgelogic::WallClock gWallClock;

/// Whether the power-dip restore is still outstanding. True from boot until the
/// first accepted heartbeat has been acted on; `!IDLE` bit3, which is what puts
/// `STARTING UP` on the Mega's landing screen. A scan is accepted throughout —
/// the offline roster path works and a member must not be blocked by a restore
/// that may never come.
bool gRestorePending = true;

/// Whether the one-shot restore has RUN. Separate from gRestorePending, which
/// is what the glass says: the restore is marked done the moment it is
/// attempted, success or not, so a box the server keeps offering a restore to
/// does not re-light a court every thirty seconds for ever.
bool gRestoreDone = false;

/// How many relays the last restore re-energised, carried on the NEXT heartbeat
/// request. A served restore followed by a zero is the row an admin must see:
/// it means a court is dark that should not be.
uint8_t gRestoredRelays = 0U;

/// What this box believes is closed, from the Mega's last `!STATE`, carried on
/// the heartbeat request so the control board can stop guessing. THREE STATES:
/// the key is absent only when this firmware does not report, `[]` means the
/// box believes nothing is closed, and a populated array is what it believes
/// is on. A board that could not tell those apart would show a dark court as
/// unknown and an unknown court as dark.
devlink::RelayState gRelayState[devlink::kMaxRelayStateElements];
uint8_t gRelayStateCount = 0U;

static_assert(devlink::kMaxRelayStateElements >= bridgelogic::kStateCourts,
              "this box has more relays than a heartbeat can report, so its own state would be "
              "silently truncated — and the assertion lives HERE because only the device side "
              "knows about both numbers");

/// Counted faults, one event per code per window. The seam
/// (`eventq::Kind::Fault`) has existed since the beginning and nothing emitted
/// it; aggregation is what stops a link producing four hundred CRC errors a
/// minute from racing the scan frames on the same 9600 baud line.
bridgelogic::FaultLog gFaults;

/// The Mega's since-boot counters at the last `!PONG`, so the DELTA is what is
/// reported. A decrease means the Mega restarted, and the new absolute value is
/// what counts then — never a wrap.
uint16_t gMegaTxDropped = 0U;
uint16_t gMegaRxErrors = 0U;
uint16_t gMegaUnauthorised = 0U;
uint16_t gMegaOversize = 0U;
uint16_t gMegaScanJunk = 0U;

/// The `!IDLE` flags at the last send, so the Mega is told on every CHANGE
/// rather than once a second. The Mega advances its own copy of the clock.
uint8_t gIdleFlags = 0xFFU;
char gIdleClock[bridgelogic::kWireTimeLen] = {};

// --- v3 (bridge 3.0.0) -------------------------------------------------------

/// The Mega link: queued, paced, tagged and acknowledged (DL-01, DL-06).
bridgelogic::MegaTx gTx;

/// The last accepted heartbeat's `courts` (device-api.md §3), aged by this
/// half's clock, and the continuous reconcile it drives (§4).
bridgelogic::Snapshot gSnapshot;
bridgelogic::Reconciler gReconciler;

/// The Mega's settings as the last answer had them (hardware first), and the
/// names that answer could not be read, for the next heartbeat's `drift`.
bridgelogic::MegaConfig gMegaCfg = bridgelogic::defaultMegaConfig();
bridgelogic::Drift gDrift;
const char* gDriftNames[bridgelogic::Drift::kMax] = {};

/// What the Mega said about itself this Mega boot (`!BOOT`, `!HW`, `!DIAG`).
devlink::MegaReport gMegaReport;
bool gMegaHeard = false;
char gMegaVersion[16] = {};
/// `relay_state` stays absent until the first `!STATE` of this Mega boot —
/// never `[]`, which the server reads as "confirmed off" (BR-12).
bool gMegaStateSeen = false;
/// After a Mega boot, `!STATE`'s all-dark mask is the reset, not a release:
/// courts the snapshot owes are re-lit by `!WANT` and released by nobody.
tb::Deadline gBootGrace;
constexpr uint32_t kBootGraceMs = 5000UL;
/// A court `!ON`'d this recently is never reconciled as released (MCV1-01).
uint32_t gOnSentAt[bridgelogic::kStateCourts] = {};
bool gOnSent[bridgelogic::kStateCourts] = {};
constexpr uint32_t kOnGraceMs = 3000UL;

/// Relays re-lit from the snapshot since the last accepted beat (`relight`).
devlink::RelightEntry gRelit[devlink::kMaxRelightElements];
uint8_t gRelitCount = 0U;

/// `!LIVE,5` every five seconds; `!IDLE` every thirty and on every beat.
tb::Deadline gLiveDue;
tb::Deadline gIdleDue;
constexpr uint32_t kLiveEveryMs = 5000UL;
constexpr uint32_t kIdleEveryMs = 30000UL;

/// The lowest free heap seen since boot (`diag.heap_min`).
uint32_t gHeapMin = UINT32_MAX;

/// The scan flow's decision core and the walk-up nonce policy. Both stateless
/// or nearly so; both live in lib/bridgelogic so the host suite owns them.
bridgelogic::ScanFlow gScanFlow;
bridgelogic::WalkUpNonce gWalkUpNonce;

/// The circuit breaker in front of every API call. Two consecutive transport
/// failures and the API is treated as down for a backoff window: scans go
/// straight to the roster and the event drain waits, instead of every scan
/// standing in a 4 s connect timeout twice (review #13).
devlink::ApiBreaker gBreaker;

/// The event drain's own backoff: 15 s doubling to 5 min, armed by every post
/// that left the head event where it was and cleared by one that moved the
/// queue. The breaker does not cover this and must not: a 401, 403, 404 or 429
/// means the API is THERE, so it keeps the breaker closed and scans online, but
/// the same event re-posted every pass is a hot loop (review round 16, D16-2).
bridgelogic::DrainPace gDrainPace;

/// Which courts have a booking longer than the ninety-minute relay cap, and
/// when each needs its `!EXT`. The Mega's cap is still the safety net.
bridgelogic::Relight gRelight;

/// The last relay-affecting downlink (`!ON` or `!EXT`), kept for one retry if
/// the Mega reports it did not decode.
bridgelogic::OnRetry gOnRetry;

/// What the eight buttons do, and the two presses that use them.
///
/// The map starts as the original wiring — courts A-D then 15/30/45/60 — and is
/// replaced from the heartbeat's config payload. A box that has never had a
/// heartbeat therefore behaves exactly as the hand-built box did, which is what
/// stops the first deploy changing every panel in the club.
court::ButtonMap gButtons;
court::WalkUpPad gPad;

/// How long a scan is remembered for a following walk-up — and, on the Mega,
/// how long the button window it opens stays armed. ONE number: the two are
/// the same fact seen from either end of the cable, and when they were two
/// literals the ESP forgot the scan while the Mega was still forwarding the
/// presses, or the reverse.
///
/// The same reasoning as the pad's own selection lapse, and it has to be at least as long or
/// the two disagree: somebody who scans, wanders off and comes back to a different member's
/// button presses must not have bought them court time. The QR itself expires in 60 seconds
/// at the API, which is the real backstop.
constexpr uint32_t kScanMemoryMs = AUTH_TTL_MS;

/// The live value, from the tenant's `scan_memory_seconds`. A variable rather
/// than the constant above because it is adopted per heartbeat; the constant is
/// where a box starts and what its `!AUTH` sends until it is told otherwise.
uint32_t gScanMemoryMs = kScanMemoryMs;

/// What `!AUTH` is sent with when the window is armed.
uint16_t authSeconds() {
  return static_cast<uint16_t>(gScanMemoryMs / 1000UL);
}

/// The last thing the scanner read, verbatim. Cleared when it lapses or is spent.
char gLastScan[proto::kMaxArgLen + 1] = {'\0'};

/// How long the scan above is remembered, and when it was read. A v1 member
/// code carries `scan_age_ms` on every call it is sent with, and a walk-up or a
/// pay-for is sent after one or two button presses, so the server has to be
/// told how old the code on the wire is to check it at the instant it was
/// read. One object since R19 (D19-1 to D19-3): the scan, the quote and PRESS
/// AGAIN each armed it by a different rule, and the three disagreed.
bridgelogic::ScanMemory gScan(kScanMemoryMs, devlink::kLcdChoiceDefaultMs);

/// The Mega's last `!STATE`, per court: the mask bit, the seconds it reported
/// and when. What an unscanned court press (MinutesLeft) and an extension read
/// a court's time left from (bridge 2.3.0). The Mega is the authority; this is
/// its last word, aged on millis() since.
uint8_t gStateMask = 0U;
uint16_t gStateSecs[bridgelogic::kStateCourts] = {};
uint32_t gStateAt[bridgelogic::kStateCourts] = {};

/// The court an EXTEND prompt is on the glass for, or kNoExtend. Set when a
/// scanned member presses a lit court; the duration press that follows buys an
/// extension on it instead of a walk-up.
constexpr uint8_t kNoExtend = 0xFFU;
uint8_t gExtendCourt = kNoExtend;

/// The extension's idempotency key — the walk-up's rule, its own instance so
/// the two purchases never share a nonce.
bridgelogic::WalkUpNonce gExtendNonce;

/// THE GREETING (bridge 2.3.0). A recognised scan is greeted first, and the
/// outcome's screen is held back until the greeting's card hold ends — the
/// relay itself is never held back. Any screen a member's own press produces
/// replaces both at once.
tb::Deadline gGreetUntil;
bool gFollowUpPending = false;
bridgelogic::Screen gFollowUp = {};

/// Milliseconds since the remembered scan was read.
uint32_t scanAgeMs() {
  return gScan.ageMs(gClock.nowMs());
}

/// When the Mega's button window is armed, and which court an OFF press may
/// release. Armed only for a scan somebody recognised; bound to the court a
/// grant lit so its owner can switch it off; refused for every other court.
/// The rule and its tests are bridgelogic::AuthPolicy's (review #4/#14).
bridgelogic::AuthPolicy gAuth(kScanMemoryMs);

/// The heartbeat response. File scope, not stack: the contract allows 2048
/// bytes — sixteen roster entries plus the button map, plus whatever else the
/// API chooses to send that this build does not read — and
/// loop() runs on the ESP8266's 4 KB continuation stack, where a 2.5 KB local
/// under an HTTP call is a crash that looks like a random reset.
/// ONE 5 KB buffer for jobs that never overlap (bridge 3.1.0, the heap floor):
/// the heartbeat ANSWER (from byte 0), the heartbeat REQUEST (its tail — sent
/// before the answer is read over it) and a member call's reply. Word-aligned, as the flash reads of a record
/// want it.
union BigBuffer {
  char text[bridgelogic::kHeartbeatResponseCap];
  uint32_t align;
};

BigBuffer gBig = {};
char* const gHeartbeatBody = gBig.text;
constexpr size_t kHeartbeatBodyCap = bridgelogic::kHeartbeatResponseCap;

/// The heartbeat REQUEST, static for the same reason (ESPR-1, HW-6): the v3
/// body carries the Mega's and this board's health and is up to 1023 bytes.
char* const gHeartbeatRequest = gBig.text + (bridgelogic::kHeartbeatResponseCap - devlink::kHeartbeatBodyCap);
constexpr size_t kHeartbeatRequestCap = devlink::kHeartbeatBodyCap;

// --- bridge 3.1.0: the lifeline (device-api.md §4, §6-§8) --------------------------

/// The flash: LittleFS records.
arduino_hal::LittleFsFiles gFiles;
arduino_hal::RtcEpoch gEpoch;

/// The device keys and the network set.
bridgelogic::BridgeKeys gKeys;
bridgelogic::BridgeNet gNet;

/// The link supervisor (30 s grace, 30-300 s backoff, restart at 15 min down)
/// and the stall watchdog (link up, nothing accepted for 6 h: HW-8).
devnet::Supervisor gSupervisor;
bridgelogic::StallWatch gStall;
bool gRestartWanted = false;

/// The four lifeline settings from `config`.
bridgelogic::LifelineSettings gLife;

/// What a boot restored, said once on the first accepted beat.
bridgelogic::BodyStore gBody;
bridgelogic::CarriedEvents gCarried;
bridgelogic::RestoreKind gRestoreKind = bridgelogic::RestoreKind::None;
bool gRestoreReported = false;
/// Relays a COLD restore lit on stale evidence; the first accepted snapshot
/// confirms or switches each one off (device-api.md §4).
uint8_t gProvisional = 0U;
/// A cold restore's roster is trusted only this long without a beat.
tb::Deadline gColdTrust;
bool gColdTrustArmed = false;
bool gEverAccepted = false;

/// The live event queue, written out when it changes (BR-07).
uint16_t gEventsSize = 0U;
uint32_t gEventsLastSeq = 0U;
uint32_t gEventsHeadSeq = 0U;

/// The last member input (scan or press), for the restart's idle rule.
uint32_t gLastInputMs = 0U;

/// The ONE reply buffer of the three member-facing calls — /activate,
/// /walkup and /extend — which never run at the same time: 512 bytes (2.3.0:
/// three of 384), the compat budget the server holds each reply to (FC-5,
/// device-api.md §11.4). Static, never a stack local under an HTTP call.
inline constexpr size_t kReplyBodyCap = 512U;
/// In gBig as well (bridge 3.1.0, the heap floor): a member's call never runs
/// while the heartbeat answer is still wanted — that answer is adopted in the
/// pass it arrives and written to flash at the top of the next, before any
/// scan of that pass is read.
char* const gReplyBody = gBig.text;

/// Write a frame to the Mega, all of it or none of it. A fragment would fail
/// the Mega's checksum AND be read as the head of the next frame.
///
/// THE SINGLE REGISTRATION POINT FOR bridgelogic::OnRetry (D1-3). `!ERR,BADCRC`
/// says "the last line I received did not decode" and says nothing about WHICH
/// line, so the only sound way to answer it is for the retry memory to track
/// the last line this half actually wrote. It used to be registered at one call
/// site — applyOutcome's `!ON` — while `!LCD`, `!AUTH`, `!OFF`, `!PING` and the
/// `!EXT` from pumpRelight went out unregistered, and OnRetry::sent returned
/// early for them without clearing. A CRC failure on the `!AUTH` that follows
/// every grant therefore replayed the `!ON`; a corrupted `!OFF,B` lit court A
/// again for a fresh full duration while B was never released. That is the
/// "it added time to the wrong court" defect.
///
/// Registered only on a SUCCESSFUL write: a frame that never left the bridge is
/// not the Mega's last received line, and clearing on it would throw away a
/// retry that is still legitimately owed.
bool sendToMega(const proto::Frame& frame) {
  const uint32_t now = gClock.nowMs();
  const proto::Verb v = frame.verb();
  const bool command = v == proto::Verb::On || v == proto::Verb::Off || v == proto::Verb::Ext ||
                       v == proto::Verb::Auth || v == proto::Verb::Want || v == proto::Verb::Cfg;
  const bool queued = command ? gTx.command(frame, now) : gTx.plain(frame);
  if (!queued) {
    return false;
  }
  if (v == proto::Verb::On) {
    proto::Court c = proto::Court::A;
    if (proto::courtFromChar(frame.arg(0)[0], c)) {
      gOnSent[static_cast<uint8_t>(c)] = true;
      gOnSentAt[static_cast<uint8_t>(c)] = now;
    }
  }
  // A v2 Mega acknowledges nothing: its BADCRC retry is still OnRetry's.
  if (gTx.dialect() != bridgelogic::MegaDialect::V3) {
    gOnRetry.sent(frame, now);
  }
  return true;
}

/// Pushes the queued Mega frames out for up to `budgetMs` (yielding), so the
/// screen a member is waiting on is on the glass before a blocking HTTP call.
void flushMega(uint32_t budgetMs) {
  const uint32_t start = gClock.nowMs();
  while (gTx.queued() > 0U && tb::since(gClock.nowMs(), start) < budgetMs) {
    gTx.pump(gMega, gClock.nowMs());
    yield();
  }
}

/// Stages a whole screen and commits it: `!ROW` for each non-empty row, then
/// one `!SHOW`.
///
/// ATOMIC ON THE MEGA'S SIDE — `!ROW` paints nothing, and `!SHOW` commits the
/// staged rows together — so a frame lost mid-screen cannot leave half of one
/// verdict above half of another. And every screen carries a DEADLINE: the hold
/// is clamped by the factory, by the decoder and by ScreenScript, which is what
/// makes a permanent screen unrepresentable rather than merely discouraged.
///
/// A row that is empty is not sent: the Mega clears the staging area on
/// `!SHOW`, so an omitted row is a blank row and a frame saved on a 9600 link.
void sendScreen(const bridgelogic::Screen& screen) {
  // Whatever was waiting behind a greeting is superseded by this screen.
  gFollowUpPending = false;
  gGreetUntil.disarm();
  bridgelogic::Screen s = screen;
  if (gTx.ackedLayout() != 1 && strlen(s.rows[1]) > 12U) {
    // Composed for the layout the Mega acknowledged: compact draws the
    // countdown in row 1's last three cells, which a long row 1 needs.
    s.flags = static_cast<uint8_t>(s.flags & ~0x01U);
  }
  static_cast<void>(gTx.screen(s, gClock.nowMs()));
}

/// The screen for `id` with the tenant's holds, and never inviting a court
/// press past the remembered scan's life (R19): a club whose revert window is
/// longer than its scan memory used to count the court cells down on a scan
/// that had already lapsed.
bridgelogic::Screen screenNow(bridgelogic::ScreenId id, const bridgelogic::ScreenFacts& facts) {
  return bridgelogic::screenFor(id, facts, gLcdSettings, gScan.remainingMs(gClock.nowMs()));
}

/// The facts every screen is built from that only this file knows: the live
/// button map, and the clock.
bridgelogic::ScreenFacts screenFacts(uint32_t nowMs) {
  bridgelogic::ScreenFacts facts;
  facts.buttons = &gButtons;
  gWallClock.displayTime(nowMs, facts.atTime, sizeof(facts.atTime));
  return facts;
}

void showScreen(bridgelogic::ScreenId id, uint32_t nowMs) {
  sendScreen(screenNow(id, screenFacts(nowMs)));
}

/// Two lines as a whole screen with the tenant's revert hold — the `!LCD`
/// overlay's shape, as a value that can wait behind a greeting.
bridgelogic::Screen linesScreen(const char* line1, const char* line2) {
  bridgelogic::Screen screen = {};
  snprintf(screen.rows[0], sizeof(screen.rows[0]), "%s", line1 != nullptr ? line1 : "");
  snprintf(screen.rows[1], sizeof(screen.rows[1]), "%s", line2 != nullptr ? line2 : "");
  uint32_t seconds = gLcdSettings.revertMs / 1000UL;
  if (seconds < proto::kShowHoldMinSeconds) {
    seconds = proto::kShowHoldMinSeconds;
  }
  if (seconds > proto::kShowHoldMaxSeconds) {
    seconds = proto::kShowHoldMaxSeconds;
  }
  screen.holdSeconds = static_cast<uint16_t>(seconds);
  screen.flags = 0U;
  return screen;
}

bool greetingActive(uint32_t nowMs) {
  return gGreetUntil.isArmed() && !gGreetUntil.expired(nowMs);
}

/// Paints `screen` now, or right after the greeting if one is on the glass.
void sendAfterGreeting(const bridgelogic::Screen& screen) {
  if (greetingActive(gClock.nowMs())) {
    gFollowUp = screen;
    gFollowUpPending = true;
    return;
  }
  sendScreen(screen);
}

/// An outcome's two lines, after the greeting if one is showing.
void paintLines(const char* line1, const char* line2) {
  sendAfterGreeting(linesScreen(line1, line2));
}

/// An outcome as its designed screen (BR-14) — composed for the acknowledged
/// layout by sendScreen, held to the scan's life by screenNow — or as its two
/// lines when no designed screen holds what they say. After the greeting.
__attribute__((noinline)) void paintOutcome(const court::Outcome& outcome, uint32_t nowMs) {
  bridgelogic::ScreenFacts facts = screenFacts(nowMs);
  bridgelogic::ScreenId id = bridgelogic::ScreenId::SeeTheDesk;
  if (bridgelogic::verdictScreen(outcome, id, facts)) {
    sendAfterGreeting(screenNow(id, facts));
    return;
  }
  paintLines(outcome.line1, outcome.line2);
}

/// Two lines NOW, whatever was waiting: a failure the member must see.
void sendLinesNow(const char* line1, const char* line2) {
  sendScreen(linesScreen(line1, line2));
}

/// `HI <NAME>` / `BALANCE <n> MIN` (or `WELCOME`), for the card hold. What
/// the scan decided is painted when it ends (sendAfterGreeting).
void greet(const bridgelogic::Greeting& greeting, uint32_t nowMs) {
  bridgelogic::ScreenFacts facts = screenFacts(nowMs);
  const bridgelogic::ScreenId id = bridgelogic::greetingScreen(greeting, facts);
  const bridgelogic::Screen screen = screenNow(id, facts);
  sendScreen(screen);
  gGreetUntil.arm(nowMs, static_cast<uint32_t>(screen.holdSeconds) * 1000UL);
}

/// The follow-up screen, once the greeting's hold is over.
void pumpFollowUp(uint32_t nowMs) {
  if (!gFollowUpPending || greetingActive(nowMs)) {
    return;
  }
  const bridgelogic::Screen screen = gFollowUp;
  sendScreen(screen);
}

/// Seconds the RELAY on `court` has left, from the Mega's last `!STATE`.
uint32_t relaySecondsLeft(uint8_t court, uint32_t nowMs) {
  if (court >= bridgelogic::kStateCourts || (gStateMask & static_cast<uint8_t>(1U << court)) == 0U) {
    return 0U;
  }
  const uint32_t elapsed = tb::since(nowMs, gStateAt[court]) / 1000UL;
  return gStateSecs[court] > elapsed ? gStateSecs[court] - elapsed : 0U;
}

/// Seconds the SESSION on `court` has left: the relay's, or a longer booking
/// Relight is holding the court to past the ninety-minute cap.
uint32_t courtSecondsLeft(uint8_t court, uint32_t nowMs) {
  const uint32_t relay = relaySecondsLeft(court, nowMs);
  const uint32_t booking =
      court < bridgelogic::kStateCourts ? gRelight.bookingRemainingMs(court, nowMs) / 1000UL : 0U;
  return booking > relay ? booking : relay;
}

/// Whether `court` is lit, as far as this half knows.
bool courtLit(uint8_t court, uint32_t nowMs) {
  return court < gCourtCount && court < bridgelogic::kStateCourts &&
         (gHeld[court].held || relaySecondsLeft(court, nowMs) > 0U);
}

/// `!IDLE` — what the Mega's own landing screen's status row says.
///
/// bit0 WiFi up, bit1 API reachable, bit2 the clock is trusted, bit3 a
/// power-dip restore is still pending. `hhmm` is four digits of club-local wall
/// time, or proto::kNoClock: the Mega advances its own copy on millis(), which
/// is why this goes out on a CHANGE and on every accepted heartbeat and NEVER
/// once a second — a status row repainted at 9600 baud is a link a scan has to
/// share.
///
/// bit3 is what puts `STARTING UP` on the glass from boot until the first
/// accepted heartbeat. A scan is accepted THROUGHOUT: the offline roster path
/// works, and a member must not be blocked by a restore that may never come.
void sendIdle(uint32_t nowMs, bool force = false) {
  uint8_t flags = 0U;
  if (gWifiUp) {
    flags |= 0x01U;
  }
  if (!gBreaker.open(nowMs)) {
    flags |= 0x02U;
  }
  if (gWallClock.trusted(nowMs)) {
    flags |= 0x04U;
  }
  if (gRestorePending) {
    flags |= 0x08U;
  }

  char hhmm[bridgelogic::kWireTimeLen] = {};
  gWallClock.wireTime(nowMs, hhmm, sizeof(hhmm));
  if (!force && flags == gIdleFlags && strcmp(hhmm, gIdleClock) == 0) {
    // Nothing the Mega does not already know. It advances the clock itself.
    return;
  }
  gIdleFlags = flags;
  snprintf(gIdleClock, sizeof(gIdleClock), "%s", hhmm);
  static_cast<void>(sendToMega(proto::Frame::idle(flags, hhmm)));
}

/// `!MAP` — the club court number behind each relay index, 0 = unmapped.
///
/// Until it arrives the Mega renders every court cell BLANK rather than as a
/// dark court, which is correct: the box does not drive a relay the heartbeat
/// never mapped and must not claim to.
void sendCourtMap() {
  int16_t numbers[4] = {0, 0, 0, 0};
  for (uint8_t i = 0U; i < 4U; ++i) {
    numbers[i] = i < gCourtCount ? gCourtNumbers[i] : static_cast<int16_t>(0);
  }
  static_cast<void>(sendToMega(proto::Frame::map(numbers)));
}

/// Paints what this board IS: two screens, chosen by whether the WiFi is up.
///
/// One function for both because every caller has the same question — "the
/// screen may be stale, what should it say?" — after a Mega reset, a WiFi
/// link-up, a link-down. The lines themselves are bridgelogic::MegaLink's, so
/// the composition root cannot invent a third screen nothing tests.
void showIdentityScreen() {
  // `!IDLE` only (bridge 3.0.0, BR-10, DL-08). The CONNECTED / CRUSADERS
  // COURTS overlays were painted on every WiFi edge and a marginal access
  // point kept them up instead of the landing; the landing's own status item
  // (READY / NO WIFI / NO SERVER / STARTING UP) says the same thing without
  // leaving landing.
  sendIdle(gClock.nowMs(), true);
}

/// Sends what bridgelogic::AuthPolicy decided to the Mega, whose window is the
/// one that actually forwards presses.
void applyAuth(bridgelogic::AuthCommand command) {
  switch (command) {
  case bridgelogic::AuthCommand::Arm:
    static_cast<void>(sendToMega(proto::Frame::auth(authSeconds())));
    return;
  case bridgelogic::AuthCommand::Disarm:
    static_cast<void>(sendToMega(proto::Frame::auth(0U)));
    return;
  case bridgelogic::AuthCommand::None:
    return;
  }
}

/// Forgets the remembered scan — the identity a walk-up would be bought on.
/// Does NOT touch the button window: a grant spends the scan and keeps the
/// window armed for the member who just lit the court, so their OFF press
/// works (review #4); a lapse spends it and closes the window (forgetScan).
void spendScan() {
  gLastScan[0] = '\0';
  gScan.forget();
}

/// The scan lapsed unspent, or was thrown away. Identity and window both go:
/// a window that outlives the scan is thirty seconds of buttons on the
/// previous member's identity for whoever walks up next.
///
/// A pay-for quote goes with it: a quote is a question about THIS scan, and
/// one left armed behind a forgotten scan is a confirm on nobody's code.
void forgetScan() {
  spendScan();
  applyAuth(gAuth.disarm());
}

/// A question the glass would ask — a quote, or PRESS AGAIN — cannot be held
/// for its whole countdown inside the server's bound on the scan's age
/// (R19 D19-2). The scan is forgotten, the half-made purchase with it, and the
/// glass asks for the one thing that works: a fresh scan.
void scanAgain(uint32_t nowMs) {
  gPad.clear();
  forgetScan();
  showScreen(bridgelogic::ScreenId::ScanAgain, nowMs);
}

/// A walk-up, a pay-for quote or a pay-for confirm got no decision and the
/// glass says PRESS AGAIN for the choice window (review round 18, D18-4). The
/// press it asks for needs BOTH ends of the cable: the scan remembered here,
/// and the Mega's button window to forward it. Each used to be left where the
/// SCAN left it, so a press late in the countdown went nowhere. A decided
/// refusal whose words ask for another press — TOO LONG / TRY LESS TIME,
/// PRICE CHANGED / Press court again — is held the same way (R19).
///
/// False when the whole countdown no longer fits inside the server's bound on
/// the scan's age (R19 D19-2): SCAN AGAIN is already on the glass, and the
/// caller paints nothing that invites a press.
bool holdForPressAgain(uint32_t nowMs) {
  if (!gScan.holdForPressAgain(nowMs)) {
    scanAgain(nowMs);
    return false;
  }
  applyAuth(gAuth.afterUndecided(nowMs));
  return true;
}

/// A screen asking for a press on the remembered scan is about to go up:
/// re-arm the Mega's window for what is left of the scan (BR-09, DL-07). False
/// when not a whole second is left — SCAN AGAIN is then on the glass and
/// nothing may invite a press.
/// Out of line, like answerIgnoredPress: handleButton's frame is on the
/// deepest path from loop() and the stack budget gate holds it (ESPR-4).
__attribute__((noinline)) bool coverScanForPress(uint32_t nowMs) {
  const uint32_t left = gScan.remainingMs(nowMs);
  if (left < 1000UL) {
    scanAgain(nowMs);
    return false;
  }
  if (gAuth.coverScan(left, nowMs) == bridgelogic::AuthCommand::Arm) {
    static_cast<void>(sendToMega(proto::Frame::auth(static_cast<uint16_t>(left / 1000UL))));
  }
  return true;
}

/// Learns this board's MAC and renders the one header every call carries.
///
/// The MAC is available before the radio associates — it is a fact about the
/// part, not about the link — so this runs at the top of setup() and everything
/// afterwards can assume both are filled.
void setupIdentity() {
  uint8_t mac[6] = {0U, 0U, 0U, 0U, 0U, 0U};
  WiFi.macAddress(mac);
  static_cast<void>(dc::hex::encodeLower(mac, sizeof(mac), gMacHex, sizeof(gMacHex)));
}

/// Decimal value of an argument the decoder already validated.
uint32_t argU32(const proto::Frame& frame, uint8_t index) {
  uint32_t value = 0U;
  const char* text = frame.arg(index);
  for (size_t j = 0U; text[j] >= '0' && text[j] <= '9'; ++j) {
    value = value * 10U + static_cast<uint32_t>(text[j] - '0');
  }
  return value;
}

/// What a since-boot counter GAINED, and what to do when it went backwards.
///
/// The Mega's counters are absolute since ITS boot, and the Mega can reset
/// without the ESP doing so — a watchdog, a loose USB lead, somebody pressing
/// the button. A decrease is therefore a restart, and the new value is the
/// whole of what has happened since: subtracting would wrap it into sixty-five
/// thousand faults reported in one window.
uint16_t counterDelta(uint16_t& previous, uint32_t current) {
  const uint16_t now = current > UINT16_MAX ? UINT16_MAX : static_cast<uint16_t>(current);
  const uint16_t delta = now < previous ? now : static_cast<uint16_t>(now - previous);
  previous = now;
  return delta;
}

/// The Mega's three counters, diffed into faults.
///
/// They have existed on that board since the beginning and NOTHING off it could
/// read them. A climbing "presses thrown away because the window was shut" is a
/// stuck contact or a bridge that stopped sending `!AUTH`, and it was invisible
/// from the office; a climbing "lines that did not decode" is the first
/// measurement anyone has ever had of a 9600 baud cable running beside four
/// switching relay coils.
void noteMegaCounters(const proto::Frame& frame, uint32_t nowMs) {
  if (frame.argCount() < 5U) {
    // A Mega that has not been reflashed answers with two arguments. The
    // counters are additive, so an older peer costs the diagnostics and
    // nothing else.
    return;
  }
  gFaults.noteMany(bridgelogic::Fault::RelayCmdDropped, counterDelta(gMegaTxDropped, argU32(frame, 2U)),
                   eventq::Event::kNoCourt, nowMs);
  gFaults.noteMany(bridgelogic::Fault::SerialBadCrc, counterDelta(gMegaRxErrors, argU32(frame, 3U)),
                   eventq::Event::kNoCourt, nowMs);
  gFaults.noteMany(bridgelogic::Fault::ButtonUnauthorised, counterDelta(gMegaUnauthorised, argU32(frame, 4U)),
                   eventq::Event::kNoCourt, nowMs);
}

// Defined beside releaseCourt, which they need.
void sendMegaSettings();
void sendLand(uint32_t nowMs);
void onMegaBoot(uint32_t nowMs);
void adoptLifeline(const char* response, size_t responseLen, uint32_t nowMs);
void settleProvisional(uint32_t nowMs);

void noteMegaPong(const proto::Frame& frame, uint32_t nowMs) {
  const uint32_t seconds = argU32(frame, 1U);
  noteMegaCounters(frame, nowMs);
  // The dialect follows the Mega's version (a 2.1.0 Mega sends no !BOOT).
  gTx.setMegaVersion(frame.arg(0));
  snprintf(gMegaVersion, sizeof(gMegaVersion), "%s", frame.arg(0));
  // A restart is a boot instant that moved, not merely an uptime smaller than
  // the last one: after a heard !BOOT the last figure is 0 (MegaBootClock).
  const bool restarted = gMegaBootClock.observe(nowMs, seconds) && gMegaSeen;
  const bool first = !gMegaSeen;
  gMegaSeen = true;
  gMegaUptime = seconds;
  if (restarted) {
    // A Mega restart this half heard no !BOOT for (a 2.x Mega, or a !BOOT the
    // link lost): the same reconcile trigger.
    onMegaBoot(nowMs);
  } else if (first) {
    sendMegaSettings();
    sendCourtMap();
    showIdentityScreen();
    sendLand(nowMs);
  }
}

/// `!BOOT,<version>,<cause>,<held>` — the Mega's first frame after a reset.
void noteMegaBoot(const proto::Frame& frame, uint32_t nowMs) {
  gTx.setMegaVersion(frame.arg(0));
  snprintf(gMegaVersion, sizeof(gMegaVersion), "%s", frame.arg(0));
  gMegaReport = devlink::MegaReport();
  gMegaReport.reset = static_cast<uint8_t>(strtoul(frame.arg(1), nullptr, 16));
  gMegaHeard = true;
  gMegaSeen = true;
  gMegaUptime = 0U;
  static_cast<void>(gMegaBootClock.observe(nowMs, 0U));
  onMegaBoot(nowMs);
}

/// `!HW` — the hardware facts the Mega is actually running with.
void noteMegaHardware(const proto::Frame& frame) {
  static const uint32_t kBauds[6] = {0U, 9600U, 19200U, 38400U, 57600U, 115200U};
  gMegaReport.lcd = static_cast<uint8_t>(strtoul(frame.arg(0), nullptr, 16));
  gMegaReport.relayLow = frame.arg(1)[0] == '1';
  const uint32_t code = argU32(frame, 2U);
  gMegaReport.scanBaud = code < 6U ? kBauds[code] : 0U;
  gMegaReport.scanCrlf = frame.arg(3)[0] == '1';
  gMegaReport.keys = static_cast<uint8_t>(strtoul(frame.arg(4), nullptr, 16));
  gMegaHeard = true;
}

/// `!DIAG` — the Mega's since-boot counters, carried in the heartbeat's `mega`.
void noteMegaDiag(const proto::Frame& frame) {
  for (uint8_t i = 0U; i < 5U; ++i) {
    const uint32_t v = argU32(frame, i);
    gMegaReport.counters[i] = v > UINT16_MAX ? UINT16_MAX : static_cast<uint16_t>(v);
  }
}

/// Paints an outcome and, when it is an activation, opens the court.
///
/// The LCD is written FIRST. If the `!ON` fails — a full TX ring, a dead cable
/// — the member is looking at "COURT C 45 MIN" and no lights, which is a
/// complaint with a clear cause. The other order gives them lights and a blank
/// screen, which reads as the box being broken. A failed `!ON` then repaints
/// "TRY AGAIN" and leaves the court dark in this half's books, so the next
/// `!STATE` does not synthesise a Release for a session that never started —
/// bridgelogic::afterOnAttempt is the rule.
///
/// True when an `!ON` left the bridge on THIS call — what a caller remembering
/// whose game the court is must ask, never the held state, which a previous
/// game can leave true (D8-3).
bool applyOutcome(const court::Outcome& outcome, uint32_t nowMs) {
  // After the greeting, when one is on the glass (bridge 2.3.0); the relay
  // below is never held back for it. The designed 4-row screen where the
  // outcome names one (BR-14), else its two lines.
  paintOutcome(outcome, nowMs);
  if (outcome.action != court::Action::TurnOn || outcome.court >= bridgelogic::kStateCourts) {
    return false;
  }
  const proto::Court court = static_cast<proto::Court>(outcome.court);
  const proto::Frame on = proto::Frame::on(court, outcome.durationMs / 1000U);
  const bool sent = sendToMega(on);
  gHeld[outcome.court] = bridgelogic::afterOnAttempt(gHeld[outcome.court], sent, nowMs);
  if (!sent) {
    // The lights did not come on and the member is being told so. The club
    // hears about it too — a court that repeatedly cannot be commanded is a
    // cable, and the member at the panel cannot diagnose one.
    gFaults.note(bridgelogic::Fault::RelayCmdDropped, outcome.court, nowMs);
    sendLinesNow(bridgelogic::kOnNotSentLine1, bridgelogic::kOnNotSentLine2);
  }
  // The `!ON` left the bridge, which is not the same as reached the Mega: a
  // checksum that dies on the wire comes back as `!ERR,BADCRC`, and it is then
  // sent once more (bridgelogic::OnRetry). sendToMega registered it — there is
  // exactly ONE registration point and this is deliberately not a second one.
  return sent;
}

/// An ONLINE decision just tried to light a court for whoever scanned `token`:
/// remember whose game it is, so their own rescan of the same code reads its
/// ON screen (D7-1) — only when `lit`, the `!ON` of this very attempt, left
/// (D8-3). Must run before spendScan(), which forgets the token.
void noteOnlineLit(const court::Outcome& outcome, bool lit, const char* token) {
  bridgelogic::noteOnlineLighting(gOnlineGrants, outcome, gHeld, lit, token);
}

/// A scan has been decided, by whichever path: paint it, light it, spend the
/// scan if it lit, arm or close the button window, and remember a booking
/// longer than the relay cap for its `!EXT`. ONE function for the online and
/// roster paths so the two cannot disagree about any of those. True when an
/// `!ON` left on this call.
bool settleScan(const court::Outcome& outcome, uint32_t nowMs, bool regrant = false) {
  const bool lit = applyOutcome(outcome, nowMs);
  if (regrant) {
    // The member's own lit court, re-granted (FSF-06): the scan stays buyable
    // for the extension they rescanned for, and the window is bound to the
    // court so their OFF works too.
    gRelight.onGrant(outcome, nowMs);
    applyAuth(gAuth.afterHeldCourtRescan(outcome.court, nowMs));
    return lit;
  }
  if (!bridgelogic::scanStaysBuyable(outcome)) {
    // A lit court spends the scan (review H1): the next walk-up must not buy
    // on this member's token. The window is the policy's, below — kept armed
    // and bound to the court for THIS member's OFF press. A scan nobody
    // vouched for — `code_used` above all, which may be a photo of the code
    // that just lit somebody's court — is forgotten too, and the policy closes
    // the window: it buys nothing (review round 8, D8-1).
    spendScan();
  }
  if (bridgelogic::spendsScan(outcome)) {
    gRelight.onGrant(outcome, nowMs);
  }
  applyAuth(gAuth.afterScan(outcome, nowMs));
  return lit;
}

/// Forward declarations: the API calls sit together further down, with the
/// helpers they share. Moving them up to satisfy the compiler would put them
/// away from the code they belong with.
bool activateOnline(const char* token, bridgelogic::OnlineMiss& miss);
void requestWalkUp(const court::WalkUpIntent& intent);
void requestExtend(const court::WalkUpIntent& intent);

void handleScan(const proto::Frame& frame, uint32_t nowMs) {
  // Remembered so a following walk-up knows WHO is buying. The scanned bytes, not the
  // roster's token: a walk-up member has no booking and so no roster entry, and the API is
  // the only thing that can verify a 60-second signed QR anyway.
  snprintf(gLastScan, sizeof(gLastScan), "%s", frame.arg(0));
  // For the TENANT's scan memory, not the compile-time one (R19 D19-3).
  gScan.remember(nowMs);
  // A new identity at the panel: any EXTEND prompt was somebody else's court
  // press.
  gExtendCourt = kNoExtend;

  // No `!AUTH` yet. The window used to be armed HERE, before anything had
  // decided what the scan was — so any barcode bought thirty seconds of
  // buttons, and with a mapped OFF button that was a lit court going dark
  // from a stranger's receipt. The window is armed by settleScan(), for a
  // recognised scan only, once there is a decision (review #4/#14).

  bridgelogic::LinkState link;
  link.wifiUp = gWifiUp;
  link.courtCount = gCourtCount;
  link.apiDown = gBreaker.open(nowMs);
  link.knownReplay = memcode::knownReplay(frame.arg(0), gStepClock, gKeyRing, gReplay, nowMs);

  // Why the server, if asked, decided nothing — so a member the roster does
  // not know reads what is true rather than NOT RECOGNISED (BR-08, MCV1-08).
  bridgelogic::OnlineMiss miss = bridgelogic::OnlineMiss::NotAsked;
  switch (gScanFlow.onScan(link)) {
  case bridgelogic::Attempt::Online:
    if (activateOnline(frame.arg(0), miss)) {
      return;
    }
    // No decision from the API. The roster's scan, as below.
    break;
  case bridgelogic::Attempt::RosterOnly:
    break;
  }

  // The court a scan belongs to is the one the matched booking names — the
  // roster entry carries it — never something in the scanned bytes. A barcode
  // that could name its own court would be a barcode that opens any court in
  // the club. The scanner serves the first gCourtCount relays.
  //
  // A fresh clock read, not the pass's: activateOnline may have just spent
  // four seconds in a connect timeout, and a held-since stamped before that
  // call is old enough for the next `!STATE` to read as a lost release.
  const uint32_t now = gClock.nowMs();

  // A SINGLE ROTATING MEMBER CODE is never in the roster — it changes every
  // thirty seconds — so it cannot be matched there as bytes. It is VERIFIED
  // instead, and the member it proves is looked up in the roster's REF lists.
  // The re-scan guard, the event and the relay are the same rules as below;
  // bridgelogic::decideOfflineMemberCode is where the host suite drives them.
  if (memcode::looksLikeV1(frame.arg(0))) {
    const memcode::OfflineCodes<memcode::KeyRing<bridgelogic::kCourtKeyRingSlots>,
                                memcode::ReplayRing<bridgelogic::kCourtReplaySlots>>
        codes = {gStepClock, gKeyRing, gReplay, gGuessGuard};
    const bridgelogic::BoxCourts box = {gHeld, gCourtCount, &gOnlineGrants};
    bridgelogic::MemberScanResult member =
        bridgelogic::decideOfflineMemberCode(frame.arg(0), codes, gRoster, gSession, box, now);
    static_cast<void>(bridgelogic::explainNoDecision(member.outcome, miss, member.couldBeMember));
    if (member.alreadyOn) {
      if (member.scanSpent) {
        // The same code again on the member's own lit court: their OFF works,
        // but a used code buys nothing at the buttons.
        spendScan();
      }
      static_cast<void>(sendToMega(proto::Frame::lcd(member.outcome.line1, member.outcome.line2)));
      applyAuth(gAuth.afterHeldCourtRescan(member.outcome.court, now));
      return;
    }
    if (member.outcome.recognised) {
      // Offline: no name and no balance to state (bridge 2.3.0).
      greet(bridgelogic::Greeting(), now);
    }
    settleScan(member.outcome, now);
    if (member.outcome.action == court::Action::TurnOn && member.outcome.court < bridgelogic::kStateCourts &&
        gHeld[member.outcome.court].held) {
      // USED only once the court is actually lit. A code whose `!ON` never
      // left the bridge is a member told TRY AGAIN, and the code they try
      // again with must not be refused as a replay of a lighting that did not
      // happen.
      gReplay.commit(member.verdict.token.ref, member.verdict.step);
    }
    return;
  }

  // The roster has no idea whether a court is already lit — it holds bookings,
  // and a booking is "allowed" for its whole window — so a member who scanned
  // again mid-game was re-granted, which sent a second `!ON` (silently
  // re-arming the relay from the rescan) and queued a second Activation for one
  // booking. The decision, and the lines, are bridgelogic::regrantsHeldCourt's;
  // the decide() here is the same pure call gSession.onScan makes below, run
  // once more against sixteen entries so the guard sits in front of the event
  // rather than behind it.
  court::Outcome alreadyOn;
  const roster::Decision held = gRoster.decide(frame.arg(0), roster::CourtCount(gCourtCount), now);
  if (bridgelogic::regrantsHeldCourt(held, gHeld, alreadyOn)) {
    static_cast<void>(sendToMega(proto::Frame::lcd(alreadyOn.line1, alreadyOn.line2)));
    // Bound to the lit court: they are the member standing at the panel and
    // their OFF press has to work. The scan itself stays live, so they can
    // still buy a second court at the buttons.
    applyAuth(gAuth.afterHeldCourtRescan(alreadyOn.court, now));
    return;
  }

  court::Outcome rostered =
      gSession.onScan(frame.arg(0), roster::CourtCount(gCourtCount), eventq::Method::Qr, now);
  // A legacy token the roster does not hold may be any member with nothing
  // booked here; offline, the box cannot tell.
  static_cast<void>(bridgelogic::explainNoDecision(rostered, miss, held.verdict == roster::Verdict::Unknown));
  if (rostered.recognised) {
    greet(bridgelogic::Greeting(), now);
  }
  settleScan(rostered, now);
}

/// Queues the Release for a court and forgets it. The one place a held court
/// becomes a released one, whichever messenger — `!EVT` or `!STATE` — said so.
void releaseCourt(uint8_t court, uint32_t heldMs, uint32_t nowMs, eventq::Cause cause) {
  // The Release event only. Its `CRUSADERS COURTS / SCAN TO START` overlay is
  // no longer painted (bridge 2.3.0): the Mega's own landing screen — SCAN
  // YOUR CODE over the lit courts' minutes — is what a released court leaves.
  static_cast<void>(gSession.onRelease(court, heldMs, nowMs, cause));
  gHeld[court] = bridgelogic::HeldState{nowMs, false};
  gRelight.onRelease(court);
  gOnlineGrants.released(court);
  // Only THIS court's retry. Clearing unconditionally meant court A's timer
  // expiring inside the 1.5 s window threw away the retry court B's grant was
  // waiting on — and A's coil switching is a plausible cause of B's CRC failure
  // in the first place (review 3, finding 24).
  gOnRetry.clearIfCourt(court);
}

// --- v3: the Mega's settings, the landing figures and the reconcile ----------

/// The whole `!CFG` set — hardware first, KEYS from the button map — on every
/// Mega boot, every revival and every accepted heartbeat. Idempotent.
void sendMegaSettings() {
  bridgelogic::setCfg(gMegaCfg, "KEYS", bridgelogic::keysFromButtonMap(gButtons));
  bridgelogic::setCfg(gMegaCfg, "HINT", static_cast<uint16_t>(gLcdSettings.hintMs / 1000UL));
  bridgelogic::setCfg(gMegaCfg, "SCANH", static_cast<uint16_t>(gLcdSettings.revertMs / 1000UL));
  for (uint8_t i = 0U; i < gMegaCfg.count; ++i) {
    if (!sendToMega(proto::Frame::cfg(0U, gMegaCfg.items[i].key, gMegaCfg.items[i].value))) {
      gFaults.note(bridgelogic::Fault::RelayCmdDropped, gClock.nowMs());
    }
  }
}

/// `!LAND`: the paid seconds of every relay as the aged snapshot has them.
void sendLand(uint32_t nowMs) {
  int32_t seconds[4] = {proto::kNoOpinion, proto::kNoOpinion, proto::kNoOpinion, proto::kNoOpinion};
  for (uint8_t i = 0U; i < 4U; ++i) {
    seconds[i] = bridgelogic::Reconciler::paidSeconds(gSnapshot, i, nowMs);
  }
  static_cast<void>(sendToMega(proto::Frame::land(seconds)));
}

/// One `!WANT` for every relay the snapshot owes light (device-api.md §4).
void reconcileNow(uint32_t nowMs, bool force) {
  bridgelogic::RelayView view[bridgelogic::kSnapshotRelays];
  for (uint8_t i = 0U; i < bridgelogic::kSnapshotRelays; ++i) {
    view[i].lit = (gStateMask & static_cast<uint8_t>(1U << i)) != 0U;
    view[i].seconds = relaySecondsLeft(i, nowMs);
  }
  bridgelogic::ReconcileSettings settings;
  settings.restoreEnabled = gLcdSettings.relayRestoreEnabled;
  settings.minSeconds = gLife.reconcileMinSeconds;
  int32_t want[bridgelogic::kSnapshotRelays];
  if (!gReconciler.plan(gSnapshot, view, settings, nowMs, force, want)) {
    return;
  }
  if (!sendToMega(proto::Frame::want(0U, want))) {
    return;
  }
  for (uint8_t i = 0U; i < bridgelogic::kSnapshotRelays; ++i) {
    if (want[i] == proto::kNoOpinion) {
      continue;
    }
    // Held in this half's books from now: the Mega's !STATE confirms it.
    if (!gHeld[i].held) {
      gHeld[i] = bridgelogic::HeldState{nowMs, true};
      if (gRelitCount < devlink::kMaxRelightElements) {
        gRelit[gRelitCount].relay = i;
        for (uint8_t c = 0U; c < gSnapshot.count; ++c) {
          if (gSnapshot.courts[c].relay == i) {
            memcpy(gRelit[gRelitCount].ref, gSnapshot.courts[c].ref, sizeof(gRelit[gRelitCount].ref));
          }
        }
        ++gRelitCount;
      }
    }
  }
}

/// The Mega restarted (`!BOOT`, or a 2.x `!PONG` whose uptime went back): its
/// relays are all open and its settings are the boot defaults. Settings first
/// (the hardware keys before any relay frame), then the landing, then the
/// reconcile, within seconds (FWM-01, DL-03, BR-03). A held court the
/// snapshot does not owe is released with cause mega_reset.
void onMegaBoot(uint32_t nowMs) {
  gTx.megaBooted();
  gMegaStateSeen = false;
  gBootGrace.arm(nowMs, kBootGraceMs);
  sendMegaSettings();
  sendCourtMap();
  sendIdle(nowMs, true);
  sendLand(nowMs);
  static_cast<void>(sendToMega(proto::Frame::live(kLiveEveryMs / 1000UL)));
  for (uint8_t i = 0U; i < bridgelogic::kStateCourts; ++i) {
    const int32_t owed = bridgelogic::Reconciler::paidSeconds(gSnapshot, i, nowMs);
    if (gHeld[i].held && (owed <= 0 || !gLcdSettings.relayRestoreEnabled)) {
      releaseCourt(i, tb::since(nowMs, gHeld[i].sinceMs), nowMs, eventq::Cause::MegaReset);
    }
  }
  gStateMask = 0U;
  reconcileNow(nowMs, true);
}

/// The Mega said something about the last line it received. If that line was a
/// relay-affecting frame — the `!ON` that lights a paid court, or the `!EXT`
/// that holds a long booking past the ninety-minute cap — and the report means
/// "did not decode", it goes once more; otherwise nothing, because a repaint
/// the Mega missed is a repaint and the next one is a second away.
void handleReceiveError(const proto::Frame& frame, uint32_t nowMs) {
  const bridgelogic::ReceiveErrorAction action =
      bridgelogic::classifyReceiveError(frame.verb(), frame.arg(0), frame.arg(1), gOnRetry.verb());
  if (action == bridgelogic::ReceiveErrorAction::None) {
    return;
  }
  if (action == bridgelogic::ReceiveErrorAction::ExtRefused) {
    // `!ERR,BADARG` after an `!EXT` is not a lost frame. It is the Mega saying
    // the relay is already OPEN — the court went dark between the extension
    // being decided and the frame arriving — so there is nothing to extend and
    // re-sending would be a court lit for nobody. Forget the extension and let
    // the next `!STATE` reconcile the court, which is what queues the Release.
    //
    // UNREACHABLE UNTIL D1-6 (D1-3's fix is what made it reachable): nothing
    // registered the `!EXT` with gOnRetry, so verb() could only ever be `On` or
    // `Unknown`, BADARG fell to the resend test below and compared "BADARG"
    // against "BADCRC", and gRelight kept believing it held a dark court.
    const uint8_t court = gOnRetry.court();
    // Today this is invisible: the branch was unreachable and the flood it
    // caused self-limited after about twelve seconds of `!EXT` at loop rate.
    // Twelve seconds of a saturated 9600 baud link is twelve seconds a scan
    // has to share.
    gFaults.note(bridgelogic::Fault::ExtRefused, court, nowMs);
    gOnRetry.clear();
    if (court < bridgelogic::kStateCourts) {
      gRelight.onRelease(court);
    }
    return;
  }

  proto::Frame pending;
  if (!gOnRetry.shouldResend(nowMs, pending)) {
    return;
  }
  const uint8_t court = static_cast<uint8_t>(pending.arg(0)[0] - 'A');
  if (court >= bridgelogic::kStateCourts) {
    return;
  }
  const bool sent = sendToMega(pending);
  // A retry fired at all. The count has existed since the type did and nothing
  // could read it; a climbing one is the cable D1-3 was arguing about, measured
  // rather than reasoned about.
  gFaults.note(bridgelogic::Fault::OnNotAcked, court, nowMs);
  // ONCE, not until acknowledged: a second failure is a cable, not a transient.
  // sendToMega re-registered the frame it just wrote — it registers everything,
  // which is the whole point — so this is what spends the one retry.
  gOnRetry.clear();
  if (pending.verb() == proto::Verb::Ext) {
    // An extension is about a court that is ALREADY held, so nothing about the
    // held state changes either way. A second failure costs nothing beyond the
    // lead time: `!STATE`'s remaining seconds keep gRelight honest, so the next
    // pass sees the deadline is still short and tries again.
    return;
  }
  if (sent) {
    // Held from NOW: the first attempt's stamp is the one a `!STATE` in flight
    // would have contradicted.
    gHeld[court] = bridgelogic::afterOnAttempt(gHeld[court], true, nowMs);
    return;
  }
  // Twice is a cable. The court is dark in this half's books so the next
  // `!STATE` does not synthesise a Release for a session that never started,
  // and the member is told to try again.
  // And nobody's game is on it: the online grant goes with it, as it does on
  // every other path a court goes dark by (D8-3).
  bridgelogic::courtStaysDark(court, gHeld, gOnlineGrants, nowMs);
  sendLinesNow(bridgelogic::kOnNotSentLine1, bridgelogic::kOnNotSentLine2);
}

void handleMegaEvent(const proto::Frame& frame, uint32_t nowMs) {
  // `!EVT,AUTOOFF,<court>` is the Mega's independent timer releasing a court on
  // its own. It is the one event the ESP does not initiate and must not miss:
  // it is how the club learns the court was used for the time it was used,
  // rather than for the time it was booked.
  const char* name = frame.arg(0);
  // The scanner's thrown-away lines, which the Mega counts and which nothing
  // off that board could read until it started saying so. TWO names, because
  // they are two different site visits: OVERSIZE is a reader configured for a
  // different symbology or appending a suffix; SCANJUNK is a cable, a
  // connector or interference — and the second is the one that explains a
  // member whose code "sometimes does not work".
  //
  // Both carry the Mega's RUNNING TOTAL, so they are diffed exactly like the
  // `!PONG` counters and for the same reason: the Mega can restart without
  // this half doing so.
  if (strcmp(name, "OVERSIZE") == 0) {
    gFaults.noteMany(bridgelogic::Fault::ScanOversize, counterDelta(gMegaOversize, argU32(frame, 1U)),
                     eventq::Event::kNoCourt, nowMs);
    return;
  }
  if (strcmp(name, "SCANJUNK") == 0) {
    gFaults.noteMany(bridgelogic::Fault::ScannerUartError, counterDelta(gMegaScanJunk, argU32(frame, 1U)),
                     eventq::Event::kNoCourt, nowMs);
    return;
  }
  if (strcmp(name, "LIVE") == 0) {
    // The Mega had declared this bridge dead and dropped its settings'
    // dependants: send them again (device-serial-protocol.md v3, liveness).
    sendMegaSettings();
    sendCourtMap();
    sendIdle(nowMs, true);
    sendLand(nowMs);
    return;
  }
  const bool capOff = strcmp(name, "CAPOFF") == 0;
  const bool autoOff = strcmp(name, "AUTOOFF") == 0;
  if (!capOff && !autoOff && strcmp(name, "OFF") != 0) {
    return;
  }
  const char* courtText = frame.arg(1);
  if (courtText[0] < 'A' || courtText[0] > 'D') {
    return;
  }
  const uint8_t court = static_cast<uint8_t>(courtText[0] - 'A');
  if (!gHeld[court].held) {
    // Already dark in this half's books: a `!STATE` got here first and the
    // release is queued. Exactly one Release per lighting, whichever messenger
    // survived the Mega's TX ring.
    return;
  }
  const eventq::Cause cause =
      capOff ? eventq::Cause::Cap : (autoOff ? eventq::Cause::AutoOff : eventq::Cause::Member);
  if (cause == eventq::Cause::Member) {
    // Never re-lit for this booking by the snapshot that still lists it.
    gReconciler.memberReleased(court, gSnapshot, nowMs);
  }
  releaseCourt(court, tb::since(nowMs, gHeld[court].sinceMs), nowMs, cause);
}

/// The Mega's own account of what each relay has left, adopted: the relay
/// deadline Relight re-sends against, what MinutesLeft and an extension read,
/// and the heartbeat's relay_state.
///
/// It is the AUTHORITY on the relay deadline; this half only ever had a belief
/// about it, stamped the instant an `!EXT` left the TX ring. A corrupted
/// extension therefore left gRelight quiet for another half hour and the court
/// went dark mid-game with the bridge convinced it had extended it (review 3,
/// finding 7). And it is the only account of the relays anybody outside this
/// box has ever had: the heartbeat carries it on, so the control board can say
/// "lights on, confirmed by the box" instead of only what the server believes.
void adoptRelayState(const proto::Frame& frame, uint8_t mask, uint32_t nowMs) {
  gRelayStateCount = 0U;
  gStateMask = mask;
  gMegaStateSeen = true;
  for (uint8_t i = 0U; i < bridgelogic::kStateCourts; ++i) {
    uint16_t seconds = 0U;
    if (bridgelogic::parseStateSeconds(frame.arg(static_cast<uint8_t>(i + 1U)), seconds)) {
      gRelight.observeRelayRemaining(i, seconds, nowMs);
    }
    const bool closed = (mask & static_cast<uint8_t>(1U << i)) != 0U;
    // What MinutesLeft and an extension read (bridge 2.3.0).
    gStateSecs[i] = closed ? seconds : 0U;
    gStateAt[i] = nowMs;
    if (!closed) {
      continue;
    }
    gRelayState[gRelayStateCount].relay = i;
    gRelayState[gRelayStateCount].remainingSeconds = seconds;
    ++gRelayStateCount;
  }
}

/// What bridgelogic::reconcile decided per court, applied. A synthesized
/// release is not one when it is the !STATE right after a Mega boot (the
/// !WANT re-lights what is owed), or one that crossed an !ON still on the wire
/// (MCV1-01).
void applyStatePlan(const bridgelogic::Reconciliation& plan, uint32_t nowMs) {
  for (uint8_t i = 0U; i < bridgelogic::kStateCourts; ++i) {
    if (plan.action[i] == bridgelogic::CourtAction::AdoptHeld) {
      gHeld[i] = bridgelogic::HeldState{nowMs, true};
      continue;
    }
    if (plan.action[i] != bridgelogic::CourtAction::SynthesizeRelease) {
      continue;
    }
    const bool booting = gBootGrace.isArmed() && !gBootGrace.expired(nowMs);
    const bool justOn = gOnSent[i] && tb::since(nowMs, gOnSentAt[i]) < kOnGraceMs;
    if (!booting && !justOn) {
      releaseCourt(i, plan.heldMs[i], nowMs, eventq::Cause::AutoOff);
    }
  }
}

/// `!STATE,<mask>,...` — the Mega's own account of which relays are closed,
/// on every change and every ten seconds. Reconciled against gHeld so that a
/// release whose `!EVT` was dropped from the Mega's 64-byte TX ring still
/// reaches the API (review A2-6). The rule is in bridgelogic::reconcile; this
/// only applies what it says.
void handleState(const proto::Frame& frame, uint32_t nowMs) {
  uint8_t mask = 0U;
  if (!bridgelogic::parseStateMask(frame.arg(0), mask)) {
    return;
  }
  // Adopting the Mega's truth here is what makes the next pass re-send in time.
  adoptRelayState(frame, mask, nowMs);

  for (uint8_t i = 0U; i < bridgelogic::kStateCourts; ++i) {
    if ((mask & static_cast<uint8_t>(1U << i)) != 0U) {
      gReconciler.confirmed(i);
    }
  }
  applyStatePlan(bridgelogic::reconcile(mask, gHeld, nowMs), nowMs);
  // A !STATE that contradicts the snapshot is a reconcile trigger (§4); the
  // planner's own 60 s pace keeps this from becoming a !WANT every ten seconds.
  reconcileNow(nowMs, false);
}

/// A debounced press, interpreted through the map the API pushed.
///
/// The walk-up request is deliberately NOT priced here. A walk-up is truncated at
/// the next booking and charged pro rata, and the box knows neither the tariff nor
/// the next booking — so it asks. That makes walk-ups the one thing that needs the
/// network, which is the right way round: refusing to sell new time is a member at
/// the desk, where refusing a booking they already paid for is a member in the dark.
/// The glass's answer to a press the pad ignored (FSF-11). Out of line so its
/// Screen and ScreenFacts stay out of handleButton's frame (ESPR-4).
__attribute__((noinline)) void answerIgnoredPress(uint32_t nowMs) {
  sendScreen(screenNow(bridgelogic::pressFirst(gLastScan[0] != '\0'), screenFacts(nowMs)));
}

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
    // Bridge 2.3.0. The Mega now forwards COURT keys with its window shut, so
    // this is where an unscanned court press is answered, and a lit court is
    // an EXTEND rather than a pay-for or the first half of switching off.
    const uint8_t relay = gPad.selectedCourt();
    const bool lit = courtLit(relay, nowMs);
    bridgelogic::ScreenFacts facts = screenFacts(nowMs);
    facts.court = relay;
    facts.minutes = (courtSecondsLeft(relay, nowMs) + 59U) / 60U;
    if (gLastScan[0] == '\0') {
      // Nobody has scanned: a lit court says how long it has left and how to
      // add to it; a dark one asks for the scan. Nothing stays selected — no
      // duration press may follow an unscanned court press.
      gPad.clear();
      gExtendCourt = kNoExtend;
      sendScreen(
          screenNow(lit ? bridgelogic::ScreenId::MinutesLeft : bridgelogic::ScreenId::ScanFirst, facts));
      return;
    }
    // Both screens ask for a black button, which needs the scan AND the
    // Mega's window: held to the scan's life (screenNow), the window re-armed
    // for exactly that long so a lost `!AUTH` cannot strand the press, and
    // with no second of scan left the glass asks for a fresh one (BR-09,
    // DL-07).
    if (!coverScanForPress(nowMs)) {
      return;
    }
    if (lit) {
      // Anybody's lit court, the scanner's own included: the next black
      // button extends it on the scanner's minutes.
      gExtendCourt = relay;
      sendScreen(screenNow(bridgelogic::ScreenId::ExtendPrompt, facts));
      return;
    }
    // The one screen whose hold is the CHOICE window and whose countdown is the
    // point: a half-made purchase is the one thing on this box a timeout can
    // lose, so the member watches it go rather than finding out afterwards.
    gExtendCourt = kNoExtend;
    sendScreen(screenNow(bridgelogic::ScreenId::ChooseTime, facts));
    return;
  }
  case court::PadResult::Requested: {
    const court::WalkUpIntent intent = gPad.intent();
    const bool extend = gExtendCourt == intent.court;
    gExtendCourt = kNoExtend;
    if (extend) {
      requestExtend(intent);
    } else {
      requestWalkUp(intent);
    }
    return;
  }
  case court::PadResult::ReleaseRequested: {
    // Only the court the current window is bound to — the one this member's
    // scan or purchase lit. Anything else is somebody else's game, and the
    // press that used to darken it mid-match now says so (review #4/#14).
    const uint8_t court = gPad.intent().court;
    if (!gAuth.allowsRelease(court, nowMs)) {
      // STUCK FOREVER until this carried a hold: a bare `!LCD` with nothing to
      // replace it left `NOT YOUR COURT` on the glass until somebody scanned.
      showScreen(bridgelogic::ScreenId::NotYourCourt, nowMs);
      return;
    }
    static_cast<void>(sendToMega(proto::Frame::off(static_cast<proto::Court>(court))));
    return;
  }
  case court::PadResult::Ignored:
    // A black button (or OFF) with no court selected was answered by
    // nothing, and the Mega's 1.5 s hint said ONE MOMENT about a press that
    // was never going anywhere (FSF-11). Say what comes first.
    answerIgnoredPress(nowMs);
    return;
  }
}

/// A decode failure on the uplink, named.
///
/// The five codes are five different cables. BADCRC is noise on the line;
/// BADFRAME is a glitch byte ahead of the sentinel, which is the commonest way
/// a frame is lost because the link is idle far more than it is busy; OVERRUN
/// is this half not draining fast enough; BADVERB is a peer talking a dialect
/// this build does not know. Lumping them would give an admin one number that
/// cannot be acted on.
bridgelogic::Fault faultForDecodeError(proto::DecodeError error) {
  switch (error) {
  case proto::DecodeError::BadCrc:
    return bridgelogic::Fault::SerialBadCrc;
  case proto::DecodeError::BadVerb:
    return bridgelogic::Fault::SerialBadVerb;
  case proto::DecodeError::BadArg:
    return bridgelogic::Fault::SerialBadArg;
  case proto::DecodeError::NoCourt:
    return bridgelogic::Fault::SerialNoCourt;
  case proto::DecodeError::Overrun:
    return bridgelogic::Fault::SerialOverrunRx;
  case proto::DecodeError::BadFrame:
  case proto::DecodeError::None:
    break;
  }
  return bridgelogic::Fault::SerialBadFrame;
}

void handleUplink(const proto::Decoder::Result& result, uint32_t nowMs) {
  if (!result.isFrame()) {
    // A line from the Mega that did not decode. There is no EVENT here — only a
    // bad cable — which is exactly what the fault channel is for: this is the
    // first measurement anybody has had of a 9600 baud link running beside four
    // switching relay coils, and the first week's numbers are expected to be
    // surprising.
    gFaults.note(faultForDecodeError(result.error), nowMs);
    // The lost line may have been a `!BOOT`: ask for the uptime that proves it.
    if (gMegaProbe.lineLost(nowMs)) {
      static_cast<void>(sendToMega(proto::Frame::ping()));
    }
    return;
  }

  switch (result.frame.verb()) {
  case proto::Verb::Pong:
    noteMegaPong(result.frame, nowMs);
    return;
  case proto::Verb::Ack:
    gTx.onAck(result.frame, nowMs);
    return;
  case proto::Verb::Boot:
    noteMegaBoot(result.frame, nowMs);
    return;
  case proto::Verb::Hw:
    noteMegaHardware(result.frame);
    return;
  case proto::Verb::Diag:
    noteMegaDiag(result.frame);
    return;
  case proto::Verb::Scan:
    gLastInputMs = nowMs;
    handleScan(result.frame, nowMs);
    return;
  case proto::Verb::Evt:
    handleReceiveError(result.frame, nowMs);
    handleMegaEvent(result.frame, nowMs);
    return;
  case proto::Verb::Err:
    handleReceiveError(result.frame, nowMs);
    return;
  case proto::Verb::Btn:
    gLastInputMs = nowMs;
    handleButton(result.frame, nowMs);
    return;
  case proto::Verb::State:
    // The Mega's timer is still the authority on when a court goes dark. This
    // half does not second-guess it — it CATCHES UP with it, when the event
    // that should have said so was dropped.
    handleState(result.frame, nowMs);
    return;
  default:
    // Downlink verbs echoed by a crossed cable. Counted by the decoder;
    // nothing to act on.
    return;
  }
}

// Never inlined (nor pumpMegaV3): each is called once from loop(), and inlined
// its frame lands in loop()'s own — 928 B against stack_budget.json's 208 B.
__attribute__((noinline)) void pumpMegaLink(uint32_t nowMs) {
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

/// One API call. Returns the HTTP status, or 0 when it never completed.
///
/// The response body is read into a caller buffer rather than a String: the ESP's
/// heap is shared with the network stack, and a heartbeat that allocates four
/// times a minute is a heap that fragments over a season in a cupboard.
/// One POST, its answer read into `out` by a bounded reader. Returns the HTTP
/// status, or 0 when it never completed.
///
/// HTTP/1.0 and no reuse (ESPR-5: a kept-alive socket per call left TIME_WAIT
/// pcbs on the heap), and no `String` (ESPR-3, BR-16: getString() held a second
/// copy of a 4 KB answer on the heap): the body is streamed straight into the
/// caller's buffer, and one whose `Content-Length` is at or past the buffer is
/// refused before a byte is read — EMPTY, NOT HALF. A response cut mid-object
/// is a body whose readers see whichever fields landed inside the buffer.
/// Reads from `stream` into `out` until `want` bytes, the server closes, or
/// the call's whole budget runs out (BR-11). Returns the bytes read.
size_t readUpTo(WiFiClient* stream, char* out, size_t want, const bridgelogic::CallBudget& budget) {
  size_t got = 0U;
  while (stream != nullptr && got < want && !budget.expired(gClock.nowMs())) {
    const int avail = stream->available();
    if (avail <= 0) {
      if (!stream->connected()) {
        break;
      }
      delay(1);
      continue;
    }
    const size_t room = want - got;
    const int n = stream->read(reinterpret_cast<uint8_t*>(out) + got,
                               static_cast<size_t>(avail) < room ? static_cast<size_t>(avail) : room);
    if (n > 0) {
      got += static_cast<size_t>(n);
    }
  }
  return got;
}

/// The body's length in `out`, or 0 — EMPTY, NOT HALF — when its declared
/// length is at or past the buffer, it was cut short, or an undeclared body
/// is longer than the buffer.
size_t readBody(WiFiClient* stream, int declared, char* out, size_t outCap,
                const bridgelogic::CallBudget& budget) {
  if (declared >= 0 && static_cast<size_t>(declared) >= outCap) {
    return 0U;
  }
  const size_t want = declared < 0 ? outCap - 1U : static_cast<size_t>(declared);
  const size_t got = readUpTo(stream, out, want, budget);
  if (declared >= 0 && got != static_cast<size_t>(declared)) {
    return 0U; // cut short: nothing, never half
  }
  if (declared < 0 && stream != nullptr && stream->available() > 0) {
    return 0U; // undeclared and longer than the buffer
  }
  return got;
}

/// One POST inside `budget` (BR-11): the client's per-phase timeout is half of
/// what is left, so the connect and the status line together end by the
/// deadline, and the body read stops at it.
int postOnce(const char* url, const char* body, char* out, size_t outCap, bool readRefusal,
             const bridgelogic::CallBudget& budget) {
  WiFiClient client;
  HTTPClient http;
  if (!http.begin(client, url)) {
    return 0;
  }
  http.useHTTP10(true);
  http.setReuse(false);
  http.setTimeout(budget.phaseTimeoutMs(gClock.nowMs()));
  http.addHeader("Content-Type", "application/json");
  http.addHeader(devapi::kHeaderAuthorization, gKeys.header());
  const int status = http.POST(reinterpret_cast<const uint8_t*>(body), strlen(body));
  const bool hasOut = status > 0 && out != nullptr && outCap > 0U;
  if (hasOut) {
    out[0] = '\0';
  }
  if (hasOut && (readRefusal || (status >= 200 && status < 300))) {
    out[readBody(http.getStreamPtr(), http.getSize(), out, outCap, budget)] = '\0';
  }
  http.end();
  return status;
}

/// What one settled call teaches the fault log. Classified rather than lumped:
/// a 4xx is this box sending something the server will never take and is fixed
/// by a reflash or a setting, a 5xx is the club's server, and a zero is the
/// network between them. Three different people fix them.
void noteCallFaults(uint16_t result, bool breakerWasOpen, uint32_t settledAt) {
  if (result == 0U) {
    gFaults.note(bridgelogic::Fault::HttpTimeout, settledAt);
  } else if (result >= 500U) {
    gFaults.note(bridgelogic::Fault::Http5xx, settledAt);
  } else if (result >= 400U) {
    gFaults.note(bridgelogic::Fault::Http4xx, settledAt);
  }
  if (!breakerWasOpen && gBreaker.open(settledAt)) {
    // The EDGE, not the state. Noting it every pass while the breaker is open
    // would report the same outage several hundred times an hour under a rate
    // limit designed to stop exactly that.
    gFaults.note(bridgelogic::Fault::ApiBreakerOpen, settledAt);
  }
}

uint16_t callApi(const char* path, const char* body, char* out, size_t outCap) {
  // The screen the member is waiting on reaches the glass before this call
  // blocks for up to four seconds (bounded: 200 ms is ~190 bytes at 9600).
  flushMega(200UL);
  if (body == nullptr || gKeys.header()[0] == '\0') {
    // An unrenderable body, or a key that would not fit its buffer. Refused
    // locally rather than sent as something the server has to reject, and it
    // teaches the breaker nothing because it says nothing about the host.
    return 0U;
  }

  // The base URL is the network set's (device-api.md §8): the compiled one is
  // only the first-boot default.
  char url[devnet::kBaseUrlMax + 64U];
  const int urlLen = snprintf(url, sizeof(url), "%s%s", gNet.baseUrl(), path);
  if (urlLen <= 0 || static_cast<size_t>(urlLen) >= sizeof(url)) {
    return 0U;
  }

  // The heartbeat's request lives in the tail of its own answer buffer, so a
  // refusal's body is not read over it: the 401 retry must resend it whole.
  const bool aliased = out != nullptr && body >= out && body < out + outCap;
  // ONE deadline for the whole call, retry included (BR-11): it ends inside
  // the six-second wait screen and inside the Mega receive ring.
  const bridgelogic::CallBudget budget(gClock.nowMs(), bridgelogic::kCallBudgetMs);
  int status = postOnce(url, body, out, outCap, !aliased, budget);
  if (status == 401 && budget.allowsAttempt(gClock.nowMs()) && gKeys.switchForRetry()) {
    // A 401 is as likely a server restored to the old key as a retired one:
    // ONE retry with the other key held, and neither is ever erased (§6).
    status = postOnce(url, body, out, outCap, !aliased, budget);
    if (status == 401) {
      gKeys.retryFailed();
    }
  }
  const uint16_t result = status > 0 ? static_cast<uint16_t>(status) : 0U;
  // Every call that actually went to the socket teaches the breaker. A fresh
  // clock read, because the call may have just spent its whole budget.
  const uint32_t settledAt = gClock.nowMs();
  const bool wasOpen = gBreaker.open(settledAt);
  gBreaker.onResult(result, settledAt);
  // ONE place, because every call comes through here.
  noteCallFaults(result, wasOpen, settledAt);
  return result;
}

/// Asks the API to activate the remembered scan. True when the API DECIDED —
/// granted or refused — and the outcome has been applied; false when it could
/// not be asked or gave no decision, in which case the caller falls back to
/// the roster. The interpretation is bridgelogic::ScanFlow's; this owns the
/// socket and the one side effect it cannot see: the Mega.
bool activateOnline(const char* token, bridgelogic::OnlineMiss& miss) {
  // Its own wait screen: OneMoment says "Buying your time", which is the
  // walk-up's sentence and false here (D8-2).
  showScreen(bridgelogic::kActivateWaitScreen, gClock.nowMs());

  char body[bridgelogic::kActivateBodyCap];
  if (bridgelogic::renderActivateBody(body, sizeof(body), gMacHex, token, scanAgeMs()) == 0U) {
    miss = bridgelogic::OnlineMiss::Refused;
    return false;
  }

  // Static, not stack: this runs under the HTTP call on the 4 KB continuation
  // stack, beside callApi's own url buffer. 384 rather than 256: the contract
  // body is ~150 bytes, `member_display` adds up to 16 more, and a response
  // that does not fit is discarded whole rather than read in part (callApi).
  char* const response = gReplyBody;
  response[0] = '\0';

  const uint16_t status = callApi("/api/v1/device/activate", body, response, kReplyBodyCap);

  const bridgelogic::ActivationResult decision =
      gScanFlow.onActivateResponse(status, response, strlen(response), gCourtNumbers, gCourtCount);
  if (decision.fallbackToRoster) {
    miss = bridgelogic::missFor(status);
    return false;
  }
  // Sampled AFTER the blocking call, not at the top of the pass: the held-since
  // stamp on a grant is what the reconcile grace is measured from, and a stamp
  // four seconds old at birth let a `!STATE` already in flight synthesise a
  // Release for a court that was coming on. (decision.disarmAuth is what
  // settleScan's spendsScan reads; the two are pinned to agree.)
  if (decision.outcome.action == court::Action::TurnOn) {
    noteOnlineUse(token);
  }
  if (decision.outcome.recognised) {
    // HI <NAME> / BALANCE <n> MIN first; the outcome follows the card hold
    // (bridge 2.3.0). Both fields are optional — an older backend greets
    // with HI / WELCOME.
    bridgelogic::Greeting greeting;
    bridgelogic::readGreeting(response, strlen(response), greeting);
    greet(greeting, gClock.nowMs());
  }
  const bool regrant =
      bridgelogic::regrantsLitCourt(decision.outcome, decision.outcome.court < bridgelogic::kStateCourts &&
                                                          courtLit(decision.outcome.court, gClock.nowMs()));
  const bool lit = settleScan(decision.outcome, gClock.nowMs(), regrant);
  noteOnlineLit(decision.outcome, lit, token);
  if (regrant && lit) {
    // Straight to the extend prompt for that court, the court already
    // selected: the next black button extends it (FSF-06, MCV1-02).
    const uint32_t now = gClock.nowMs();
    bridgelogic::ScreenFacts facts = screenFacts(now);
    facts.court = decision.outcome.court;
    facts.minutes = (courtSecondsLeft(decision.outcome.court, now) + 59U) / 60U;
    gPad.select(decision.outcome.court, now);
    gExtendCourt = decision.outcome.court;
    sendAfterGreeting(screenNow(bridgelogic::ScreenId::ExtendPrompt, facts));
  }
  if (decision.invitesWalkUp && gLastScan[0] != '\0') {
    // A known member with nothing to light: invite the walk-up instead of
    // NO BOOKING / SEE THE DESK.
    sendAfterGreeting(screenNow(bridgelogic::ScreenId::PickCourt, screenFacts(gClock.nowMs())));
  }
  return true;
}

/// Buys court time, which is the one court-box operation that needs the network.
///
/// The price is not decided here and cannot be: a walk-up is truncated at the next booking
/// and charged pro rata, and the box knows neither the tariff nor the next booking. Guessing
/// at either sells a member something the club did not agree to. So it asks, and shows what
/// the API answered. The request names the COURT the pressed relay maps to and carries a
/// per-purchase nonce; both are bridgelogic::WalkUp's, which says why.
void requestWalkUp(const court::WalkUpIntent& intent) {
  if (gLastScan[0] == '\0') {
    // Nobody has identified. The buttons alone cannot say WHO is buying, and a walk-up
    // charged to the last person who happened to scan is worse than one refused.
    // STUCK FOREVER until this carried a hold, exactly like NOT YOUR COURT.
    showScreen(bridgelogic::ScreenId::ScanFirst, gClock.nowMs());
    return;
  }
  if (intent.court >= gCourtCount) {
    // A relay the heartbeat never mapped to a court. Refused here rather than
    // sold as court zero — the API cannot book a court this box did not name.
    showScreen(bridgelogic::ScreenId::SeeTheDesk, gClock.nowMs());
    return;
  }

  showScreen(bridgelogic::ScreenId::OneMoment, gClock.nowMs());

  bridgelogic::WalkUpRequest request;
  request.mac = gMacHex;
  request.intent = intent;
  request.courtNumber = gCourtNumbers[intent.court];
  request.token = gLastScan;
  request.nonce = gWalkUpNonce.forPurchase(intent, gLastScan, gRequestEntropy);
  request.scanAgeMs = scanAgeMs();

  // kWalkUpBodyCap holds the worst body there is — a 24-byte scan escaped six
  // bytes for one (R15 D15-1) — and the host suite renders into the same size.
  char body[bridgelogic::kWalkUpBodyCap];
  if (bridgelogic::renderWalkUpBody(body, sizeof(body), request) == 0U) {
    showScreen(bridgelogic::ScreenId::SeeTheDesk, gClock.nowMs());
    return;
  }

  // 384 for the same reason as the activate response above.
  char* const response = gReplyBody;
  response[0] = '\0';
  const uint16_t status = callApi("/api/v1/device/walkup", body, response, kReplyBodyCap);

  const bridgelogic::WalkUpResult answer =
      bridgelogic::onWalkUpResponse(status, response, strlen(response), intent.court, intent.minutes);
  if (answer.decided) {
    // Granted or refused, the nonce is spent. An UNDECIDED attempt keeps it, so
    // a repeat of the same purchase is answered with the first one rather than
    // charged twice.
    gWalkUpNonce.decided();
  }
  // After the call, for the same reason as activateOnline.
  const uint32_t nowMs = gClock.nowMs();
  if ((!answer.decided || answer.invitesPress) && !holdForPressAgain(nowMs)) {
    // BUSY / PRESS AGAIN, NO CONNECTION or TOO LONG / TRY LESS TIME — each asks
    // for another press on this scan — but the scan cannot be held for the
    // choice window that press needs inside the server's bound on its age
    // (R19 D19-2). SCAN AGAIN is on the glass instead; painting the invitation
    // first would flash a press the box has already withdrawn.
    return;
  }
  if (answer.outcome.action == court::Action::TurnOn) {
    noteOnlineUse(gLastScan);
  }
  const bool lit = applyOutcome(answer.outcome, nowMs);
  noteOnlineLit(answer.outcome, lit, gLastScan);
  if (bridgelogic::spendsScan(answer.outcome)) {
    // The identity is spent on the purchase: the next member's presses must not
    // buy on this one's token. The window stays, bound to the court just
    // bought, so the buyer can still switch it off.
    spendScan();
    gRelight.onGrant(answer.outcome, nowMs);
  }
  if (answer.forgetsScan) {
    // A decided refusal of the CODE — `code_used`, `not_recognised`: the scan
    // buys nothing more, so it is forgotten and the window closed (D8-1). Every
    // other refusal keeps both — TOO LONG / TRY LESS TIME is a sentence the
    // member answers with a shorter press, which the Mega drops unless the
    // window is still armed (D9-1). An UNDECIDED attempt keeps both, with its
    // nonce, for the same purchase.
    forgetScan();
    return;
  }
  if (!answer.decided) {
    // BUSY / PRESS AGAIN or NO CONNECTION: the scan and the nonce are kept,
    // and so is the way to press again — held above, before the glass said
    // so (D18-4, D19-2).
    return;
  }
  applyAuth(gAuth.afterWalkUp(answer.outcome, nowMs));
}

/// Whether an extension on `intent` may be asked for at all, painting the
/// reason when it may not. Needs a scan, a court this box drives and a link —
/// extending moves money, so it is NEVER done offline.
bool extendPreflight(const court::WalkUpIntent& intent, uint32_t nowMs) {
  if (gLastScan[0] == '\0') {
    showScreen(bridgelogic::ScreenId::ScanFirst, nowMs);
    return false;
  }
  if (intent.court >= gCourtCount || intent.court >= bridgelogic::kStateCourts) {
    showScreen(bridgelogic::ScreenId::SeeTheDesk, nowMs);
    return false;
  }
  if (!gWifiUp || gBreaker.open(nowMs)) {
    const court::Outcome offline = bridgelogic::onExtendResponse(0U, nullptr, 0U).refusal;
    sendLinesNow(offline.line1, offline.line2);
    return false;
  }
  return true;
}

/// The server granted `answer.extendedMinutes` on relay `court`: re-arm the
/// relay with `!EXT`, hold anything past the ninety-minute cap with Relight,
/// and say so on the glass.
void applyExtension(uint8_t court, const bridgelogic::ExtendResult& answer, uint32_t nowMs) {
  noteOnlineUse(gLastScan);
  const uint32_t relayLeft = relaySecondsLeft(court, nowMs);
  const bridgelogic::ExtendPlan plan =
      bridgelogic::planExtension(courtSecondsLeft(court, nowMs), answer.extendedMinutes);

  // Relight first, from the relay's CURRENT deadline: if the `!EXT` below
  // does not leave, pumpRelight sends it before the relay runs out.
  court::Outcome session;
  session.action = court::Action::TurnOn;
  session.court = court;
  session.recognised = true;
  session.durationMs = relayLeft * 1000UL;
  session.bookingRemainingMs =
      plan.sessionSeconds > UINT32_MAX / 1000U ? UINT32_MAX : plan.sessionSeconds * 1000UL;
  gRelight.onGrant(session, nowMs);
  if (sendToMega(proto::Frame::ext(static_cast<proto::Court>(court), plan.relaySeconds))) {
    gRelight.extended(court, plan.relaySeconds, nowMs);
    gStateMask = static_cast<uint8_t>(gStateMask | (1U << court));
    gStateSecs[court] = static_cast<uint16_t>(plan.relaySeconds);
    gStateAt[court] = nowMs;
  } else {
    gFaults.note(bridgelogic::Fault::RelayCmdDropped, court, nowMs);
  }

  bridgelogic::ScreenFacts facts = screenFacts(nowMs);
  const bridgelogic::ScreenId id = bridgelogic::extendedScreen(answer, court, facts);
  sendScreen(screenNow(id, facts));
  // The identity is spent on the purchase, as a walk-up's is.
  spendScan();
}

/// Extends a lit court on the scanning member's minutes (bridge 2.3.0).
///
/// Never decided here: the server truncates before the next booking and
/// answers with what it actually added, which is what the relay is given. The
/// `!EXT` sets the new relay deadline from now, capped at ninety minutes; a
/// longer session is held past the cap by Relight exactly as a long booking is.
///
/// (The D10 pay-for flow left the image at bridge 3.1.0: a lit court press is
/// an extension, and nothing in this file can reach /pay-for.)
void requestExtend(const court::WalkUpIntent& intent) {
  uint32_t nowMs = gClock.nowMs();
  if (!extendPreflight(intent, nowMs)) {
    return;
  }
  showScreen(bridgelogic::ScreenId::OneMoment, nowMs);

  bridgelogic::ExtendRequest request;
  request.mac = gMacHex;
  request.courtNumber = gCourtNumbers[intent.court];
  request.minutes = intent.minutes;
  request.token = gLastScan;
  request.nonce = gExtendNonce.forPurchase(intent, gLastScan, gRequestEntropy);
  request.scanAgeMs = scanAgeMs();
  char body[bridgelogic::kExtendBodyCap];
  if (bridgelogic::renderExtendBody(body, sizeof(body), request) == 0U) {
    showScreen(bridgelogic::ScreenId::SeeTheDesk, gClock.nowMs());
    return;
  }

  char* const response = gReplyBody;
  response[0] = '\0';
  const uint16_t status = callApi(bridgelogic::kPathExtend, body, response, kReplyBodyCap);
  const bridgelogic::ExtendResult answer = bridgelogic::onExtendResponse(status, response, strlen(response));
  if (answer.decided) {
    gExtendNonce.decided();
  }
  nowMs = gClock.nowMs();

  if (answer.extended) {
    applyExtension(intent.court, answer, nowMs);
    return;
  }
  if ((!answer.decided || answer.invitesPress) && !holdForPressAgain(nowMs)) {
    // SCAN AGAIN is already on the glass (R19).
    return;
  }
  sendLinesNow(answer.refusal.line1, answer.refusal.line2);
  if (answer.forgetsScan) {
    forgetScan();
  }
}

/// Moves at most ONE due fault into the event queue per pass.
///
/// One, for the same reason the event drain uploads one: a board coming back
/// from an hour of trouble must not spend a loop pass emptying itself while the
/// Mega link waits. The queue is the right channel — it survives an outage, it
/// is deduplicated on (tenant, device, seq) permanently, and a fault channel on
/// the heartbeat would be lost on every missed heartbeat, which is precisely
/// when faults happen.
///
/// `eventq` marks Fault DISCARDABLE, so a ring that fills evicts a diagnostic
/// before it evicts an Activation. That is what makes putting faults in the
/// same queue as the money safe.
void drainFaults(uint32_t nowMs) {
  eventq::Event event;
  if (!gFaults.next(nowMs, event)) {
    return;
  }
  if (gQueue.push(event) == eventq::PushResult::Rejected) {
    // Nowhere to put a record of there being nowhere to put records. Counted
    // for the NEXT window rather than dropped silently.
    gFaults.note(bridgelogic::Fault::QueueOverflow, nowMs);
  }
}

void pumpWifiLink(uint32_t nowMs) {
  const bool up = WiFi.status() == WL_CONNECTED;
  if (up == gWifiUp) {
    return;
  }
  gWifiUp = up;
  if (up) {
    // Immediately, not after a full interval: the heartbeat is what fills the
    // court list and the roster, and until it has, a scan is refused locally
    // rather than recorded server-side and then refused at the box (review #12).
    gHeartbeat.arm(nowMs, 0U);
  }
  showIdentityScreen();
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

/// Uploads what the box did, oldest first, and releases only what was acknowledged.
///
/// Peek-then-release rather than pop-then-upload: an event must not leave the queue until
/// the API has taken it, or a flaky link loses exactly the events it produces. The response
/// names the highest sequence accepted, so a partial success costs nothing — whatever came
/// after simply stays queued and is offered again.
///
/// The step itself — the pace, the render, the outcome table — is
/// bridgelogic::pumpEventDrain, where the host suite can run it across an hour
/// of passes. It used to be here, and re-posted a refused head event on EVERY
/// pass: a disabled box answered 403 in milliseconds spent the club's whole
/// device budget and pushed every other box into 429 (review round 16, D16-2).
void drainEvents(uint32_t nowMs) {
  // The breaker: with the host unreachable this used to cost a 4 s connect
  // timeout on EVERY loop pass, in front of every scan, for as long as the
  // queue was non-empty — which after the first scan is always. Offline, the
  // drain posts nothing.
  //
  // BUT IT IS STILL CALLED. This returned here, before the drain, and that
  // meant its pace was never observed while offline: a backoff window armed by
  // a refusal just before an outage of more than 2^31 ms read as pending again
  // afterwards and stalled the drain for up to 24.8 more days (review round
  // 17, D17-2). The verdict goes in as `online`; the pace is observed anyway.
  const bool online = gWifiUp && !gBreaker.open(nowMs);

  // THIS BOOT'S ID, not the literal 0 that stood here with a comment saying the
  // fix was owed. 0 omits the field and gives the server the old (device, seq)
  // key, so the torn-checkpoint renumbering round G4's C2 describes was a
  // court-box defect exactly as it was a gate defect. See gBootId.
  bridgelogic::DrainSource source;
  source.mac = gMacHex;
  source.bootId = gBootId;
  source.uptimeMs = gUptime.value();
  const auto post = [](const char* body, char* response, size_t cap) -> uint16_t {
    return callApi("/api/v1/device/events", body, response, cap);
  };
  if (!gCarried.empty()) {
    // Earlier boots' undelivered events first, one per call, under the boot
    // they were queued in (BR-07): the server deduplicates on (device,
    // boot_id, seq), so one whose receipt the cut lost is a no-op.
    bridgelogic::DrainSource carried;
    carried.mac = gMacHex;
    carried.bootId = gCarried.headBootId();
    carried.uptimeMs = gCarried.headUptimeMs();
    static_cast<void>(bridgelogic::pumpEventDrain(gCarried, gDrainPace, carried, online, gClock, post));
    return;
  }
  static_cast<void>(bridgelogic::pumpEventDrain(gQueue, gDrainPace, source, online, gClock, post));
}

/// Re-energises the courts a power dip took out, EXACTLY ONCE.
///
/// The reasoning — why one-shot rather than a reconcile, why an empty list
/// switches nothing off, and why nothing here queues an Activation — is in
/// bridgelogic/RestorePlan.h, which is where the decisions are tested. This is
/// the half that owns a Mega link and therefore cannot be.
///
/// Marked done the moment it is ATTEMPTED, success or not. A box the server
/// keeps offering a restore to must not re-light a court every thirty seconds
/// for ever, and a restore that could not be sent is a fault rather than a
/// thing to retry: the member is standing on a dark court either way, and the
/// club finding out is worth more than a second attempt down the same cable.
void applyRestore(const char* body, size_t len, uint32_t nowMs) {
  if (gRestoreDone) {
    return;
  }
  gRestoreDone = true;
  gRestorePending = false;
  gRestoredRelays = 0U;
  if (!gLcdSettings.relayRestoreEnabled) {
    return;
  }

  devlink::RelayRestore served[devlink::kMaxCourts];
  uint8_t count = 0U;
  uint8_t malformed = 0U;
  if (!devlink::parseRelayRestore(body, len, served, devlink::kMaxCourts, count, &malformed)) {
    // No `relays` key at all: this API does not do restore. Nothing to wait
    // for and nothing to say.
    return;
  }

  const bridgelogic::RestorePlan plan = bridgelogic::planRestore(served, count, gCourtCount);
  for (uint8_t i = 0U; i < plan.count; ++i) {
    const bridgelogic::RestoreAction& action = plan.action[i];
    const proto::Frame on = proto::Frame::on(static_cast<proto::Court>(action.court), action.seconds);
    const bool sent = sendToMega(on);
    gHeld[action.court] = bridgelogic::afterOnAttempt(gHeld[action.court], sent, nowMs);
    if (!sent) {
      gFaults.note(bridgelogic::Fault::RestoreFailed, action.court, nowMs);
      continue;
    }
    // Armed from the UNCAPPED remainder, so a booking with two hours left still
    // gets its `!EXT` before the ninety-minute cap runs out. A court restored
    // and then allowed to go dark at minute ninety would be the original bug
    // wearing the fix's clothes.
    court::Outcome grant;
    grant.action = court::Action::TurnOn;
    grant.court = action.court;
    grant.durationMs = static_cast<uint32_t>(action.seconds) * 1000UL;
    grant.bookingRemainingMs = action.bookingRemainingMs;
    gRelight.onGrant(grant, nowMs);
    if (gRestoredRelays < UINT8_MAX) {
      ++gRestoredRelays;
    }
  }

  const uint16_t refused = static_cast<uint16_t>(malformed) + static_cast<uint16_t>(plan.rejected);
  if (refused > 0U) {
    // The server named a court this box did not light. Counted rather than
    // swallowed: it is either a malformed element or a device whose court map
    // the server disagrees with, and both are somebody's to fix.
    gFaults.noteMany(bridgelogic::Fault::RestoreFailed, refused, eventq::Event::kNoCourt, nowMs);
  }
}

/// The ESP8266's own reset reason as the `diag.reset` word (device-api.md §13).
const char* bridgeResetWord() {
  const rst_info* info = ESP.getResetInfoPtr();
  switch (info != nullptr ? info->reason : 0U) {
  case REASON_DEFAULT_RST:
    return "power_on";
  case REASON_WDT_RST:
    return "hw_wdt";
  case REASON_EXCEPTION_RST:
    return "exception";
  case REASON_SOFT_WDT_RST:
    return "soft_wdt";
  case REASON_SOFT_RESTART:
    return "software";
  case REASON_DEEP_SLEEP_AWAKE:
    return "deep_sleep";
  case REASON_EXT_SYS_RST:
    return "external";
  default:
    return "unknown";
  }
}

/// The v3 fields of this beat (device-api.md §2): caps, versions, the layout
/// the Mega acknowledged, what was re-lit, the Mega's own report.
void fillHeartbeatV3(devlink::HeartbeatV3& v3) {
  // Bridge 3.1.0 names the lifeline: key rotation and network changes are real
  // in this image (device-api.md §1), so the server may rotate keys and move
  // the box.
  v3.caps = devlink::kCapCodes | devlink::kCapHb3 | devlink::kCapLcd2 | devlink::kCapKey | devlink::kCapNet;
  v3.megaVersion = gMegaVersion[0] != '\0' ? gMegaVersion : nullptr;
  v3.netReported = true;
  v3.netVer = gNet.version();
  v3.netSrc = bridgelogic::netSourceName(gNet.source());
  // `restore` on the first accepted beat of a boot only (§2).
  v3.restore = gRestoreReported ? nullptr : bridgelogic::restoreName(gRestoreKind);
  v3.lcdLayout = gTx.ackedLayout() < 0 ? nullptr : (gTx.ackedLayout() == 1 ? "expanded" : "compact");
  v3.relight = gRelitCount > 0U ? gRelit : nullptr;
  v3.relightCount = gRelitCount;
  v3.mega = gMegaHeard ? &gMegaReport : nullptr;
  // The keys of the previous answer this box could not read (§11.2).
  for (uint8_t i = 0U; i < gDrift.count; ++i) {
    gDriftNames[i] = gDrift.names[i];
  }
  v3.drift = gDrift.count > 0U ? gDriftNames : nullptr;
  v3.driftCount = gDrift.count;
}

/// The bridge's own health (§13): reset cause, heap, stack and flash.
void fillDiag(devlink::DiagReport& diag) {
  diag.reset = bridgeResetWord();
  const rst_info* resetInfo = ESP.getResetInfoPtr();
  if (resetInfo != nullptr && resetInfo->reason == REASON_EXCEPTION_RST) {
    diag.exc = resetInfo->exccause;
    diag.epc1 = resetInfo->epc1;
  }
  diag.heap = ESP.getFreeHeap();
  gHeapMin = diag.heap < gHeapMin ? diag.heap : gHeapMin;
  diag.heapMin = gHeapMin;
  diag.block = ESP.getMaxFreeBlockSize();
  diag.stackMin = ESP.getFreeContStack();
  diag.sketchFree = ESP.getFreeSketchSpace();
  diag.flashMb = ESP.getFlashChipRealSize() / (1024UL * 1024UL);
}

/// The operator settings an accepted beat carries, before anything that consumes them.
void adoptOperatorSettings(const char* response, size_t responseLen) {
  // The nine operator settings, before anything that consumes them. Each is
  // clamped by the parser and none of them refuses the eight beside it: a club
  // that typed 3600 into one field must not thereby lose its button map.
  static_cast<void>(devlink::parseLcdSettings(response, responseLen, gLcdSettings));
  gPad.setTtlMs(gLcdSettings.choiceMs);
  gScanMemoryMs = gLcdSettings.scanMemoryMs;
  gAuth.setTtlMs(gLcdSettings.scanMemoryMs);
  // The bridge's own memory of who scanned follows the same setting (D19-3),
  // and a shorter one applies to a scan already held (D19-2: the server
  // measures its age against what it holds now).
  gScan.setLimits(gLcdSettings.scanMemoryMs, gLcdSettings.choiceMs, gClock.nowMs());
  gWallClock.setTrustMinutes(gLcdSettings.clockTrustMs / 60000UL);
  gFaults.setEnabled(gLcdSettings.faultReporting);
  gFaults.setMaxPerHour(gLcdSettings.faultMaxPerHour);
  // The four lifeline settings, read from inside `config` by exact kind.
  bridgelogic::readLifelineSettings(response, responseLen, gLife, &gDrift);
}

/// The button map, the court list, the roster and the member-code sync.
void adoptCourtsRosterAndCodes(const char* response, size_t responseLen, uint32_t anchorMs, bool codes) {
  applyButtonMap(response, responseLen);
  // Absent keys leave the previous set alone, for the same reason the button
  // map's does: an older API must not blank what a newer one configured.
  static_cast<void>(devlink::parseCourtNumbers(response, responseLen, gCourtNumbers, gCourtCount));
  // The roster's times are relative to the instant the server produced them,
  // and `nowMs` was sampled before an HTTP call that may have taken four
  // seconds — so the roster is anchored to a fresh read, not the pass's.
  // Every accepted heartbeat re-anchors it, which is what resets staleness;
  // ROSTER_MAX_AGE_MS only governs how long the last one survives offline.
  const devlink::SyncResult sync = devlink::applyRoster(response, responseLen, gRoster, anchorMs);
  if (sync.rejected > 0U) {
    // Bookings the server sent that this box could not read. It has always been
    // counted and never reported, and it is contract drift — the shape of an
    // element changing under a firmware that cannot be updated over the air is
    // exactly the thing an admin needs to hear about early.
    gFaults.noteMany(bridgelogic::Fault::RosterRejected, sync.rejected, eventq::Event::kNoCourt,
                     gClock.nowMs());
  }
  // The member-code sync: the step clock, the day slots and the per-day keys.
  // Anchored to a FRESH read for the roster's reason, and wholesale like the
  // roster — an absent `code_keys` (a server that has not shipped member codes)
  // leaves both exactly as they were.
  if (!codes) {
    // A cold restore: the step clock cannot be re-derived, so offline member
    // codes wait for the first heartbeat (device-api.md §4).
    return;
  }
  const devlink::CodeSyncResult codeSync =
      devlink::applyCodeSync(response, responseLen, gStepClock, gKeyRing, anchorMs);
  if (codeSync.rejected > 0U || codeSync.dropped > 0U) {
    // A key this box could not read, or could not hold, is a member it will
    // refuse offline. Contract drift or a server over the cap — both an admin's.
    gFaults.noteMany(bridgelogic::Fault::RosterRejected,
                     static_cast<uint32_t>(codeSync.rejected) + codeSync.dropped, eventq::Event::kNoCourt,
                     gClock.nowMs());
  }
}

/// The v3 snapshot and Mega settings from a whole body, else the v2 one-shot restore.
void adoptSnapshot(const char* response, size_t responseLen, bool whole, uint32_t settledAt) {
  // v3: the snapshot is the source of truth for what should be lit, and the
  // box reconciles on EVERY accepted beat (device-api.md §4). Only a whole
  // body is ever applied (BR-02, FSF-04); an absent `courts` changes nothing.
  bridgelogic::ReadResult snap = bridgelogic::ReadResult::Absent;
  if (whole) {
    snap = bridgelogic::readSnapshot(response, responseLen, gSnapshot, settledAt);
    if (snap == bridgelogic::ReadResult::Unreadable) {
      gDrift.add("courts");
    }
    bridgelogic::MegaConfig next;
    bridgelogic::readMegaConfig(response, responseLen, gMegaCfg, next, gDrift);
    gMegaCfg = next;
  }
  if (snap == bridgelogic::ReadResult::Absent && whole && gCourtCount > 0U) {
    // A pre-v3 server, or an unacknowledged box: the v2 one-shot `relays`
    // restore, spent only by a whole body with the court list adopted (FC-2).
    applyRestore(response, responseLen, settledAt);
  } else if (snap != bridgelogic::ReadResult::Absent) {
    gRestorePending = false;
  }
  if (gRestorePending && gUptime.value() > 10ULL * 60000ULL) {
    gRestorePending = false; // ten minutes of uptime: stop waiting for it
  }
}

void pumpHeartbeat(uint32_t nowMs) {
  if (!gHeartbeat.expired(nowMs)) {
    return;
  }
  gHeartbeat.arm(nowMs, gHeartbeatMs);

  // `!PING` is the only thing that tells this half whether the other half is
  // alive: a UART has no carrier, so silence and a dead peer look identical.
  // The answer also carries the Mega's uptime, which is how a Mega reset is
  // noticed and the identity screen repainted.
  static_cast<void>(sendToMega(proto::Frame::ping()));

  if (!gWifiUp) {
    return;
  }

  // `firmware_version` is what the Devices screen reports as this box's
  // firmware. It is a fact about the board, not an input to any decision —
  // there is no update mechanism left for it to feed.
  devlink::HeartbeatReport report;
  // Absent until the first !STATE of this Mega boot, never `[]` (BR-12): a
  // non-null pointer with a count of zero means "nothing is closed".
  report.relayState = gMegaStateSeen ? gRelayState : nullptr;
  report.relayStateCount = gRelayStateCount;

  // The v3 fields (device-api.md §2, §13). The caps name what THIS image does:
  // member codes, the snapshot reconcile, both layouts, key rotation and
  // network changes.
  devlink::HeartbeatV3 v3;
  fillHeartbeatV3(v3);
  devlink::DiagReport diag;
  fillDiag(diag);
  v3.diag = &diag;
  report.v3 = &v3;

  char* body = gHeartbeatRequest;
  if (devlink::renderHeartbeatBody(body, kHeartbeatRequestCap, gMacHex, fw::kFirmwareVersion, gUptime.value(),
                                   report) == 0U) {
    return;
  }
  // The answer is read over the request's buffer (gBig): any persisted copy of
  // the previous answer was written at the top of this pass (pumpLifeline).

  char* response = gHeartbeatBody;
  response[0] = '\0';
  const uint16_t status = callApi("/api/v1/device/heartbeat", body, response, kHeartbeatBodyCap);
  const size_t responseLen = strlen(response);

  if (devapi::react(status) != devapi::Reaction::Accepted) {
    // Transient, refused, or a key the tenant does not know. Nothing to adopt
    // and nothing to do but keep the cadence: the heartbeat IS the probe the
    // breaker closes on, and a box whose key is wrong is fixed by a reflash.
    //
    // Counted, though. A box that has not been accepted since Tuesday has no
    // court list, no roster and no settings, and from the office it looks
    // exactly like a quiet club.
    gFaults.note(bridgelogic::Fault::HeartbeatRejected, gClock.nowMs());
    return;
  }

  // Accepted: what this beat reported has been heard.
  gRelitCount = 0U;
  gDrift.clear();
  gRestoreReported = true;
  gStall.reset(gClock.nowMs());
  gNet.heartbeatAccepted();
  const bool whole = devapi::json::isCompleteObject(response, responseLen);
  // The lifeline first, from any complete object, even when everything else
  // has drifted (§11.1): it is how this box stays reachable.
  if (whole) {
    adoptLifeline(response, responseLen, gClock.nowMs());
  }
  if (!whole) {
    // ACCEPTED, AND NOTHING TO ADOPT. A body longer than gHeartbeatBody arrives
    // here as an empty buffer (callApi refuses to keep half of one) and a cut
    // one as a partial object; every reader below would silently keep what it
    // had — roster, keys, clock, settings — until they all went stale. Counted,
    // because the member-code keys brought the widest body within 64 bytes of
    // its contract and a server that outgrows it must not be silent.
    gFaults.note(bridgelogic::Fault::HeartbeatRejected, gClock.nowMs());
  }

  adoptOperatorSettings(response, responseLen);

  adoptCourtsRosterAndCodes(response, responseLen, gClock.nowMs(), true);
  // The tenant's cadence, bounded. Takes effect from the NEXT arm; the one
  // above already used the old value, which is a one-interval delay and not
  // worth a re-arm that could shorten this interval to nothing.
  static_cast<void>(devlink::parseHeartbeatInterval(response, responseLen, gHeartbeatMs));

  // The club's clock, from `server_time`, anchored to a FRESH read for the same
  // reason the roster is: the call above may have taken four seconds.
  const uint32_t settledAt = gClock.nowMs();
  char serverTime[32] = {};
  if (devapi::json::topLevelStringField(response, responseLen, "server_time", serverTime,
                                        sizeof(serverTime))) {
    static_cast<void>(gWallClock.adopt(serverTime, settledAt));
  }

  adoptSnapshot(response, responseLen, whole, settledAt);
  if (whole) {
    // Kept whole for a boot with the server down (device-api.md §4), written
    // at the top of a later pass.
    gBody.accepted(gSnapshot, gEpoch.now(settledAt), settledAt);
    settleProvisional(settledAt);
  }

  // The Mega: its settings, the court numbers, the status row, the landing's
  // paid minutes, then the reconcile — on every accepted heartbeat.
  sendMegaSettings();
  sendCourtMap();
  sendIdle(settledAt, true);
  sendLand(settledAt);
  reconcileNow(settledAt, false);
  // Unknown keys in the response — anything a later contract adds — are ignored
  // by construction: every reader above looks up the key it wants and leaves
  // the rest alone.
}

/// Sends `!EXT` for any lit court whose booking outlasts its relay deadline
/// and whose deadline is close. The Mega clamps the extension to its own cap,
/// so a bridge that dies after this still fails open at the next cap.
void pumpRelight(uint32_t nowMs) {
  for (uint8_t i = 0U; i < bridgelogic::kStateCourts; ++i) {
    if (!gHeld[i].held) {
      continue;
    }
    const bridgelogic::Extension ext = gRelight.check(i, nowMs);
    if (!ext.due) {
      continue;
    }
    if (sendToMega(proto::Frame::ext(static_cast<proto::Court>(i), ext.seconds))) {
      gRelight.extended(i, ext.seconds, nowMs);
    }
    // A frame that did not go is still due next pass; the lead time is what
    // makes a dropped one survivable.
  }
}

/// The v3 link's own cadence and its failures: `!LIVE,5` every five seconds,
/// `!IDLE` every thirty (DL-13, FSF-10), the queue out to the UART, and every
/// frame the Mega never acknowledged reported — a relay one painted TRY AGAIN
/// and left dark in this half's books, exactly as an unsendable `!ON` is.
__attribute__((noinline)) void pumpMegaV3(uint32_t nowMs) {
  if (!gLiveDue.isArmed() || gLiveDue.expired(nowMs)) {
    gLiveDue.arm(nowMs, kLiveEveryMs);
    static_cast<void>(sendToMega(proto::Frame::live(kLiveEveryMs / 1000UL)));
  }
  if (!gIdleDue.isArmed() || gIdleDue.expired(nowMs)) {
    gIdleDue.arm(nowMs, kIdleEveryMs);
    sendIdle(nowMs, true);
  }
  gTx.pump(gMega, nowMs);
  bridgelogic::UnackedFrame lost;
  while (gTx.takeUnacked(lost)) {
    gFaults.note(bridgelogic::Fault::MegaUnacked, nowMs);
    if (lost.verb == proto::Verb::On && lost.court < bridgelogic::kStateCourts) {
      gHeld[lost.court] = bridgelogic::afterOnAttempt(gHeld[lost.court], false, nowMs);
      gOnlineGrants.released(lost.court);
      sendLinesNow("TRY AGAIN", "SCAN TO START");
    }
  }
  static uint16_t screensDropped = 0U;
  if (gTx.screensDropped() != screensDropped) {
    gFaults.noteMany(bridgelogic::Fault::ScreenDropped,
                     static_cast<uint16_t>(gTx.screensDropped() - screensDropped), eventq::Event::kNoCourt,
                     nowMs);
    screensDropped = gTx.screensDropped();
  }
  uint8_t relay = 0U;
  while (gReconciler.takeFailed(relay)) {
    gFaults.note(bridgelogic::Fault::RelightFailed, relay, nowMs);
  }
}

// --- bridge 3.1.0: the lifeline ---------------------------------------------------

/// The lifeline objects of an accepted, complete answer (§11.1): read
/// independently of everything else, so a body whose roster or config this
/// image can no longer read can still rotate its key and move it.
void adoptLifeline(const char* response, size_t responseLen, uint32_t nowMs) {
  const char* object = nullptr;
  size_t objectLen = 0U;
  if (devnet::json::topLevelObjectText(response, responseLen, "key_next", object, objectLen)) {
    const devnet::Refusal key = gKeys.adopt(object, objectLen);
    if (key != devnet::Refusal::Ok && key != devnet::Refusal::Current && key != devnet::Refusal::Held) {
      gDrift.add("key_next");
    }
  }
  if (devnet::json::topLevelObjectText(response, responseLen, "net", object, objectLen)) {
    const char* ssidBefore = gNet.ssid(0U);
    char before[devnet::kSsidMax + 1U];
    snprintf(before, sizeof(before), "%s", ssidBefore);
    const devnet::NetResult net = gNet.adopt(object, objectLen, nowMs);
    if (net.adopted()) {
      if (strcmp(before, gNet.ssid(0U)) != 0) {
        // A new first profile: join it now. The previous one is still listed,
        // so a wrong password costs one supervisor step, never the box.
        WiFi.disconnect();
        WiFi.begin(gNet.ssid(0U), gNet.psk(0U));
      }
    } else if (net.reason != devnet::Refusal::NotNewer) {
      gDrift.add("net");
    }
  }
}

/// The first accepted snapshot after a COLD restore: each provisional light is
/// confirmed by the reconcile, or — where the server says dark — switched off
/// by the bridge itself, cause `reconcile` (device-api.md §4).
void settleProvisional(uint32_t nowMs) {
  gEverAccepted = true;
  gColdTrustArmed = false;
  if (gProvisional == 0U || !gSnapshot.valid) {
    return;
  }
  const uint8_t off = bridgelogic::provisionalToRelease(gProvisional, gSnapshot);
  for (uint8_t i = 0U; i < bridgelogic::kStateCourts; ++i) {
    if ((off & (1U << i)) == 0U) {
      continue;
    }
    if (sendToMega(proto::Frame::off(static_cast<proto::Court>(i))) && gHeld[i].held) {
      releaseCourt(i, tb::since(nowMs, gHeld[i].sinceMs), nowMs, eventq::Cause::Reconcile);
    }
  }
  gProvisional = 0U;
}

/// Restores the last accepted answer from flash at boot: warm exactly, cold
/// inside the trust window (device-api.md §4).
void restoreFromFlash(bool epochCarried, uint32_t nowMs) {
  bridgelogic::BodyMeta meta;
  const size_t len = gBody.load(gHeartbeatBody, kHeartbeatBodyCap, meta);
  bridgelogic::LifelineSettings stored = gLife;
  if (len > 0U) {
    bridgelogic::readLifelineSettings(gHeartbeatBody, len, stored, nullptr);
  }
  gRestoreKind = bridgelogic::classifyRestore(epochCarried, len > 0U, stored.trustMinutes);
  if (gRestoreKind == bridgelogic::RestoreKind::None) {
    gHeartbeatBody[0] = '\0';
    return;
  }
  gLife = stored;
  const bool warm = gRestoreKind == bridgelogic::RestoreKind::Warm;
  // Warm: aged exactly by the epoch the reset did not interrupt. Cold: as of
  // now, and trusted only for the window.
  const uint64_t epochNow = gEpoch.now(nowMs);
  const uint64_t age = warm && epochNow > meta.epochMs ? epochNow - meta.epochMs : 0U;
  const uint32_t anchor = nowMs - static_cast<uint32_t>(age > 0x7FFFFFFFULL ? 0x7FFFFFFFULL : age);
  adoptOperatorSettings(gHeartbeatBody, len);
  adoptCourtsRosterAndCodes(gHeartbeatBody, len, anchor, warm);
  bridgelogic::MegaConfig next;
  bridgelogic::readMegaConfig(gHeartbeatBody, len, gMegaCfg, next, gDrift);
  gMegaCfg = next;
  gDrift.clear(); // our own flash is not the server's drift
  if (bridgelogic::readSnapshot(gHeartbeatBody, len, gSnapshot, anchor) == bridgelogic::ReadResult::Adopted &&
      !warm) {
    gProvisional = bridgelogic::capColdSnapshot(gSnapshot, gLife.trustMinutes);
  }
  if (!warm) {
    gColdTrust.arm(nowMs, gLife.trustMinutes * 60000UL);
    gColdTrustArmed = true;
  }
  gRestorePending = false;
  gHeartbeatBody[0] = '\0';
}

/// The restart's idle rule: no scan remembered, no button window or choice
/// armed, nothing waiting on the Mega, and no member input for a minute. Lit
/// courts are fine — the Mega holds them.
bool bridgeIdle(uint32_t nowMs) {
  return gLastScan[0] == '\0' && !gAuth.armed(nowMs) && !gPad.hasSelection() && gExtendCourt == kNoExtend &&
         !gFollowUpPending && gTx.idle() && tb::since(nowMs, gLastInputMs) >= 60000UL;
}

/// The live event queue to flash whenever it changed (BR-07), from the top of
/// loop(): a cheap signature (size, newest and oldest seq) says when.
void persistEvents() {
  eventq::Event head;
  const uint32_t headSeq = gQueue.peek(head) ? head.seq : 0U;
  if (gQueue.size() == gEventsSize && gQueue.lastSeq() == gEventsLastSeq && headSeq == gEventsHeadSeq) {
    return;
  }
  if (bridgelogic::writeLiveEvents(gFiles, gQueue, gBootId, gUptime.value())) {
    gEventsSize = gQueue.size();
    gEventsLastSeq = gQueue.lastSeq();
    gEventsHeadSeq = headSeq;
  }
}

/// The link supervisor and the stall watchdog (device-api.md §8, HW-8), and an
/// unproven base URL's fallback.
void superviseLink(uint32_t nowMs) {
  const bool up = WiFi.status() == WL_CONNECTED;
  switch (gSupervisor.tick(nowMs, up)) {
  case devnet::Action::ReconnectNextProfile: {
    const uint8_t next = gNet.advanceProfile();
    WiFi.disconnect();
    WiFi.begin(gNet.ssid(next), gNet.psk(next));
    break;
  }
  case devnet::Action::Restart:
    gRestartWanted = true;
    break;
  case devnet::Action::None:
    break;
  }
  if (gStall.stalled(nowMs, up)) {
    gRestartWanted = true;
  }
  if (gNet.tick(nowMs, gLife.fallbackMinutes)) {
    gFaults.note(bridgelogic::Fault::NetFallback, nowMs);
  }
  if (gColdTrustArmed && gColdTrust.expired(nowMs)) {
    // A cold restore nobody confirmed: the roster it brought back is past its
    // trust window and admits nobody offline any more.
    gColdTrustArmed = false;
    gRoster.forget();
  }
  if (gRestartWanted && bridgeIdle(nowMs)) {
    // Safe: the Mega holds its relays, and every record is in flash.
    flushMega(300UL);
    ESP.restart();
  }
}

/// Everything the lifeline does from the TOP of loop(), where a flash write is
/// shallowest (ESPR-1).
void pumpLifeline(uint32_t nowMs) {
  static_cast<void>(gEpoch.tick(nowMs));
  if (gBody.due()) {
    gBody.flush(gHeartbeatBody, strlen(gHeartbeatBody), nowMs);
  }
  persistEvents();
  superviseLink(nowMs);
}

} // namespace

void setup() {
  // A large receive ring, because this loop blocks on HTTP and the UART fills the
  // ring meanwhile — see kMegaRxBufferBytes. The Mega, which never blocks, opens
  // its own link with the core default.
  gMega.begin(kMegaRxBufferBytes);
  static_cast<void>(gStore.begin());
  arduino_hal::LittleFsFiles::prepare();

  // The compiled WiFi, base URL and key are only the first-boot defaults: the
  // persisted network set and key ring win (device-api.md §6, §8).
  gKeys.begin(DEVICE_API_KEY, &gFiles);
  gNet.begin(WIFI_SSID, WIFI_PASSWORD, API_BASE_URL, &gFiles);
  // persistent(false) keeps the core from writing a second, invisible copy of
  // the credential in its own flash record. DHCP: no WiFi.config(), no static
  // address — see the header.
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.begin(gNet.ssid(0U), gNet.psk(0U));

  setupIdentity();

  // After WiFi.begin(), because RANDOM_REG32 is fed by RF noise. See gBootId.
  gBootId = bridgelogic::bootIdFrom(RANDOM_REG32);

  const uint32_t now = gClock.nowMs();
  gUptime.seed(now);
  // A fallback only: the link-up edge re-arms this to "now" (pumpWifiLink).
  gHeartbeat.arm(now, gHeartbeatMs);

  // Every court starts dark AS OF NOW, not as of millis() zero: the reconcile
  // grace period is measured from this, and a Mega still holding a court across
  // an ESP reboot is adopted from its first `!STATE` after the grace elapses.
  for (uint8_t i = 0U; i < bridgelogic::kStateCourts; ++i) {
    gHeld[i] = bridgelogic::HeldState{now, false};
  }

  gQueue.begin();
  gSession.onBoot(now);

  // What survived the reset (device-api.md §4): the epoch decides warm or
  // cold, the carried events go first, the last answer comes back.
  const rst_info* reset = ESP.getResetInfoPtr();
  const bool powerOn = reset == nullptr || reset->reason == REASON_DEFAULT_RST;
  const bool warm = gEpoch.begin(powerOn, now);
  gBody.begin(&gFiles);
  gCarried.begin(&gFiles);
  restoreFromFlash(warm, now);
  gNet.startClock(now);
  gStall.begin(now);
  gLastInputMs = now - 60000UL;

  // LAST. A freshly flashed box should say what it is from the moment it comes
  // up, rather than leaving the Mega's own idle text on the glass and letting
  // the technician read that as "already working" (review 3, finding 9). If the
  // Mega has not answered yet the frame is simply lost, and the first `!PONG`
  // repaints it (noteMegaPong).
  showIdentityScreen();
}

void loop() {
  // One clock read per pass, shared by every sub-step, so the heartbeat and the
  // lapse deadlines are never evaluated against two different instants.
  const uint32_t now = gClock.nowMs();
  gUptime.tick(now);

  // The lifeline from the TOP of the pass: flash writes and the supervisor.
  pumpLifeline(now);

  // EVERY "HOW OLD IS IT?" AGE, ON EVERY PASS, LINK OR NO LINK (review round
  // 18, D18-2). Each is a 32-bit difference, so one 2^32 ms + 1 s old reads
  // one second old: a box offline for 49.7 days trusted a roster from seven
  // weeks earlier, a step clock 143 165 steps behind, and a wall clock about
  // seventeen hours wrong. Observed here, each latches on the pass it passes
  // its bound and stays so until the next heartbeat re-anchors it.
  gRoster.observe(now);
  gStepClock.observe(now);
  gWallClock.observe(now);

  // A court selected and then abandoned lapses on its own, so the next member to
  // press a duration button does not inherit somebody else's half-made purchase.
  //
  // showIdentityScreen(), not the offline lines: this branch painted
  // kIdentityOffline* unconditionally, so a member who selected a court and
  // walked away left a box that is on the WiFi telling the next member it is
  // not — until a WiFi edge, a Mega reset or a scan repainted it (D1-7).
  if (gPad.tick(now)) {
    // No repaint (bridge 2.3.0): the choice screen's own hold returns the
    // glass to the Mega's landing screen, and an identity overlay here hid it.
    gExtendCourt = kNoExtend;
  }
  // The outcome a greeting was holding back, once its card hold is over.
  pumpFollowUp(now);
  if (gLastScan[0] != '\0' && gScan.expired(now)) {
    // Lapsed unspent. The Mega's own window lapses at the same TTL, but the
    // explicit `!AUTH,0` is what keeps the two from drifting by a loop pass.
    forgetScan();
  }
  if (gAuth.lapsed(now)) {
    // The release-only window a grant left open for its owner ran out.
    applyAuth(bridgelogic::AuthCommand::Disarm);
  }

  pumpWifiLink(now);

  // Drain the Mega link BEFORE the blocking calls below, so the receive ring
  // starts each HTTP call as empty as possible and has the whole kMegaRxBufferBytes
  // to absorb what arrives during it. drainEvents and pumpHeartbeat both block
  // on HTTP; pumping first is what keeps a scan or an auto-off release that
  // arrived a moment ago from sharing the ring with the frames the call is
  // about to let pile up.
  pumpMegaLink(now);
  pumpMegaV3(now);
  pumpRelight(now);
  drainFaults(now);
  drainEvents(now);
  pumpHeartbeat(now);
}

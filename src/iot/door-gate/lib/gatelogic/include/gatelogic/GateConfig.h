// Crusaders Mainframe — the door gate's wiring and timing facts, as one
// compile-time table.
//
// WHY EVERY ONE OF THESE IS A BUILD FLAG
// --------------------------------------
// Carl wired the first door and his values are the defaults below. Nobody has
// confirmed the second door, the third, or the relay module the club buys next
// — so the pins, the two polarity questions and the timings are `-D` flags in
// platformio.ini, visible next to the board they have to fit, rather than
// literals scattered through the firmware.
//
// WHY THE DEFAULTS ARE HERE AND NOT ONLY IN platformio.ini
// --------------------------------------------------------
// tools/strict_compile.sh compiles these headers with no PlatformIO flags at
// all, and so does any editor. A header that only compiled under one build
// system is a header nobody can read in isolation. The defaults are Carl's
// values, which means a host test sees the wiring the first door actually has.
//
// WHY A struct AND NOT LOOSE constexpr VALUES
// -------------------------------------------
// The polarity pair is the dangerous part: `GATE_RELAY_ACTIVE_HIGH` is about
// the relay MODULE and `GATE_UNLOCK_ENERGISES_RELAY` is about the LOCK's own
// wiring, they are independent, and either one alone reads like "the flag that
// says which way round the door works". Carried together in one value, a
// function that needs the pair cannot be handed half of it — and a test can
// build all four combinations without recompiling anything.
//
// No Arduino headers, no heap, no String. Compiles for Xtensa and the host.

#ifndef CRUSADERS_GATELOGIC_GATECONFIG_H
#define CRUSADERS_GATELOGIC_GATECONFIG_H

#include <stddef.h>
#include <stdint.h>

#include "devlink/Cadence.h"
#include "roster/Roster.h"

// --- Carl's wiring, as defaults ---------------------------------------------

#ifndef GATE_SCANNER_RX_PIN
#define GATE_SCANNER_RX_PIN 4
#endif
#ifndef GATE_SCANNER_TX_PIN
#define GATE_SCANNER_TX_PIN 17
#endif
#ifndef GATE_SCANNER_BAUD
#define GATE_SCANNER_BAUD 9600UL
#endif
#ifndef GATE_RELAY_PIN
#define GATE_RELAY_PIN 26
#endif
/// 1 when driving the relay input HIGH energises the coil; 0 for an active-LOW
/// relay module, which is what most of the cheap boards are.
#ifndef GATE_RELAY_ACTIVE_HIGH
#define GATE_RELAY_ACTIVE_HIGH 1
#endif
/// 1 when an energised coil RELEASES the lock (Carl's sketch). 0 when an
/// energised coil HOLDS it locked, so a dead or rebooting board releases the
/// door. This is a fact about which contact the lock is wired through, not
/// about the relay module — see README.md's truth table.
#ifndef GATE_UNLOCK_ENERGISES_RELAY
#define GATE_UNLOCK_ENERGISES_RELAY 1
#endif
#ifndef GATE_LED_PIN
#define GATE_LED_PIN 27
#endif
#ifndef GATE_LED_ACTIVE_HIGH
#define GATE_LED_ACTIVE_HIGH 1
#endif

// --- timings ----------------------------------------------------------------

/// How long the lock is released, until the first heartbeat says otherwise.
#ifndef GATE_UNLOCK_DEFAULT_MS
#define GATE_UNLOCK_DEFAULT_MS 3000UL
#endif
/// The longest ONE release window may last, whatever the server answers and
/// however often somebody scans. A safety bound, not a default.
///
/// IT IS A BOUND ON A WINDOW AND NOT, ON ITS OWN, A BOUND ON THE DOOR. Round
/// G4's A1: the cap closed the window and the very next accepted scan opened a
/// fresh one, in the same pass, so the relay went OFF and ON at the same
/// millisecond and the lock never physically relatched. Two alternating tokens
/// offered every 50 ms held a measured door open for ever, one legal window at
/// a time, with no single request breaking any rule. GATE_RELOCK_DWELL_MS below
/// is what turns this into a bound on the door.
#ifndef GATE_UNLOCK_HARD_CAP_MS
#define GATE_UNLOCK_HARD_CAP_MS 30000UL
#endif
/// After a window the HARD CAP ended, the lock stays locked for at least this
/// long and no grant may energise the relay inside it.
///
/// WHY A CAP-FORCED CLOSE EARNS A LONG ONE. That close is the board overruling
/// somebody who has been holding a door open for the whole cap, and the point of
/// overruling them is that the door shuts. A dwell shorter than a door-closer's
/// swing is a door that never actually closes between two windows, which is the
/// same outcome the cap exists to prevent, reached more slowly.
///
/// Three seconds, which is GATE_UNLOCK_DEFAULT_MS: the door is shut for at least
/// as long as an ordinary grant holds it open. It is longer than any electric
/// strike or maglock needs to relatch and longer than a normal doorway's closer
/// takes to swing, and it costs a legitimate member who scans inside it one
/// re-scan — which is what the denial blink tells them to do.
#ifndef GATE_RELOCK_DWELL_MS
#define GATE_RELOCK_DWELL_MS 3000UL
#endif
/// After ANY close, the floor on how long the lock is actually locked.
///
/// WHY EVERY CLOSE AND NOT ONLY A CAP-FORCED ONE. `pass()` calls `pumpLock()`
/// from `afterBlocking()` and then applies the decision the blocking call
/// produced, so a scan answered `opened` by the API lands in the SAME call that
/// just closed the window — relay OFF and ON at the same millisecond, measured.
/// A lock that is de-energised for zero milliseconds was never de-energised: the
/// strike does not drop, the maglock does not release its armature, and two
/// back-to-back members are one continuous opening with two audit rows.
///
/// 400 ms is a relatch floor rather than a door-closing time — an electric
/// strike drops in tens of milliseconds and a maglock re-magnetises in about
/// 300 — so it is long enough to be real and short enough that a second member
/// arriving behind the first does not notice it.
#ifndef GATE_MIN_RELOCK_MS
#define GATE_MIN_RELOCK_MS 400UL
#endif
#ifndef GATE_MAX_TOKEN_LEN
#define GATE_MAX_TOKEN_LEN 20
#endif
/// Longer than ONE worst-case blocking HTTP call plus its margin — see
/// kWorstBlockingCallMs below, which static_asserts the relation. Eight seconds
/// was exactly the worst call and therefore a guaranteed reset loop against a
/// silently-dropping API host: the board would panic before the call it was
/// waiting on could return, boot, and do it again, never loading a roster and
/// admitting nobody.
///
/// TWELVE WAS RIGHT FOR A TWO-PHASE CALL AND IS NOT RIGHT FOR A THREE-PHASE
/// ONE. Round G3 gave the response BODY its own budget, sampled after the
/// headers return, because sharing one budget with the header phase is how a
/// slow evening left a 4.6 KB roster no time at all. The worst call is
/// therefore connect + headers + body, and the assert below moved with it.
#ifndef GATE_WATCHDOG_SECONDS
#define GATE_WATCHDOG_SECONDS 15
#endif
#ifndef HEARTBEAT_INTERVAL_MS
#define HEARTBEAT_INTERVAL_MS 30000UL
#endif
#ifndef ROSTER_MAX_AGE_MS
#define ROSTER_MAX_AGE_MS 21600000UL
#endif
#ifndef EVENTQ_SLOTS
#define EVENTQ_SLOTS 64
#endif

namespace gatelogic {

// --- contract constants, not tenant settings --------------------------------

/// `GateRosterMaxEntries` from the contract. The API will never send more, so a
/// roster sized to this holds every entry there can be.
inline constexpr uint8_t kGateRosterEntries = 48U;

/// The event ring's depth, as a value rather than as a macro, so the queue type
/// the orchestration is written against is the one the board actually builds.
inline constexpr uint16_t kGateEventSlots = static_cast<uint16_t>(EVENTQ_SLOTS);

/// The contract's whole-body budget for a heartbeat response (4096) with room
/// to spare. Static, because loop() makes blocking HTTP calls and a 4.6 KB
/// local under one of them is a crash that reads as a random reset.
inline constexpr size_t kGateResponseCap = 4608U;

/// The lower bound of the server's own `clamp(gate_unlock_seconds, 1, 30)`.
/// Applied again here because a zero-second release is a door that clicks and
/// stays shut, and the board must not depend on the server having clamped.
inline constexpr uint32_t kMinUnlockMs = 1000UL;

/// A scan of the SAME token within this window of a decision for it is ignored.
/// Scanners repeat while a phone is held at the window, and each repeat would
/// otherwise be an API call, an audit row and a re-armed lock.
inline constexpr uint32_t kScanDebounceMs = 2000UL;

/// How many recently-decided tokens the debounce remembers.
///
/// ONE WAS NOT ENOUGH, AND THAT WAS ROUND G4's A2. A single slot held THE LAST
/// token, so ALTERNATING two defeated it completely — every scan differed from
/// the one before, nothing was ever suppressed, and the board made a measured
/// ~18 POSTs per second to `/gate`. A code taped beside a reader plus a
/// member's own phone is enough to produce it.
///
/// Four, because it is about how many PEOPLE can be at one door inside one
/// two-second window, not about how many an attacker can invent. Four covers a
/// queue at a club door with room to spare; a fifth arrival in two seconds is
/// simply asked about, which is the safe direction. This bounds nothing on its
/// own against somebody rotating five codes — `kMinScanCallSpacingMs` is what
/// does that — but it is the half that costs a legitimate member nothing.
inline constexpr uint8_t kDebounceSlots = 4U;

/// THE FLOOR UNDER `/gate` CALLS, WHATEVER TOKEN ASKS FOR ONE.
///
/// The debounce above is about REPEATS, so it cannot bound anything against a
/// stream of tokens it has never seen — and that is exactly what a rotating
/// generator, or a scanner pointed at a sheet of printed codes, produces. This
/// is the bound that does not care what the token is.
///
/// 250 ms, which is four calls a second against a measured eighteen, and which
/// NO PERSON CAN MEET. Presenting two DIFFERENT codes at one reader a quarter
/// of a second apart is not something a queue of members does; two members
/// arriving together are hundreds of milliseconds apart at best, and a member
/// holding one phone is suppressed by the debounce rather than by this. So the
/// legitimate cost is zero in every case anybody has been able to describe, and
/// a scan that does meet it is REFUSED with its own reason rather than lost —
/// the scanner repeats while a code is presented, so the re-read a moment later
/// is decided normally.
inline constexpr uint32_t kMinScanCallSpacingMs = 250UL;

/// How often an UNREADABLE line may produce an answer — a denial blink and,
/// offline, one queued record.
///
/// Round G4's L1 gave a corrupt line feedback it had never had, and this is
/// what makes that safe to give. 9600 baud beside a switching relay coil
/// produces holed lines by the hundred; unlimited, the lamp would strobe and an
/// offline ring would fill with noise and evict the admissions that matter.
/// The same number as the debounce, because it is the same question asked about
/// a line with no token in it: a member presenting something this board cannot
/// read is answered at the rate a member presenting something it CAN read is.
inline constexpr uint32_t kUnreadableFeedbackMs = kScanDebounceMs;

// --- the loop's own timings -------------------------------------------------
//
// These were literals in main.cpp, where `build_src_filter = -<*>` meant no
// host test could see them and no static_assert could relate them to anything.
// They are here because the watchdog, the HTTP timeouts and the scanner buffer
// are ONE budget: get the relation wrong and the board resets every time the
// API is slow, which is the failure that admits nobody at all.

/// The CONNECT half of one blocking HTTP call.
///
/// Separate from the response half below because the core applies them
/// separately — `HTTPClient::setConnectTimeout` bounds the TCP handshake and
/// `setTimeout` bounds waiting for bytes afterwards — so one call can spend
/// BOTH before it returns. Budgeting only one of them is how an eight-second
/// call gets planned for as a four-second one.
inline constexpr uint16_t kHttpConnectTimeoutMs = 4000U;

/// The HEADER half: how long `HTTPClient::POST` may wait for the status line
/// and the headers. A genuinely slow answer is retried on the next heartbeat
/// rather than allowed to hold the loop — and therefore the release deadline
/// and the watchdog — for the core's five-second default.
///
/// It is an INTER-BYTE timeout, which is why it bounds the header phase only
/// nominally: a peer that dribbles headers resets it on every byte and no
/// number here bounds that. See kWorstBlockingCallMs's precondition.
inline constexpr uint16_t kHttpResponseTimeoutMs = 4000U;

/// THE BODY PHASE'S OWN BUDGET, sampled AFTER the headers return.
///
/// It used to have none of its own. Round G2 gave `readBody` an absolute
/// deadline computed from the instant the WHOLE call started, so a connect and
/// a header phase that between them spent eight seconds left the body a
/// deadline already in the past — and a 4.6 KB roster that was arriving
/// perfectly well was reported as a transport failure before a byte of it was
/// read. Three phases on one peer, three budgets of the same size, and their
/// sum is what the watchdog is asserted against.
///
/// Four seconds is ~37 kbit/s for the largest response the contract allows
/// (4096 bytes), which is a club WiFi having a genuinely bad day rather than a
/// club WiFi being busy.
inline constexpr uint16_t kHttpBodyBudgetMs = 4000U;

/// The longest ONE blocking call can take while the port honours its budgets.
///
/// This number is the spine of three separate guarantees: the watchdog assert
/// below, the bound on how far a physical release may overrun its deadline
/// (GateApp.h), and the size of the scanner's receive buffer. It is derived and
/// never written out, so changing a budget moves all three together.
///
/// THREE PHASES, not two: the TCP connect, the status line and headers, and the
/// body. The core applies the first two itself, through `setConnectTimeout` and
/// `setTimeout`; the third is this firmware's own, in `gatelogic::readBody`.
inline constexpr uint32_t kWorstBlockingCallMs = static_cast<uint32_t>(kHttpConnectTimeoutMs) +
                                                 static_cast<uint32_t>(kHttpResponseTimeoutMs) +
                                                 static_cast<uint32_t>(kHttpBodyBudgetMs);

/// What the watchdog must have left over the worst call: enough for a whole
/// pass, the ESP32's own housekeeping and the idle delay, several times over.
inline constexpr uint32_t kWatchdogMarginMs = 2000UL;

/// Scanner bytes drained per pass. A ceiling rather than a budget: it exists so
/// a jammed scanner streaming forever cannot starve the loop.
inline constexpr uint16_t kScannerBytesPerPass = 64U;

/// WHERE THE EVENT DRAIN'S BACKOFF STARTS, AND WHERE THE DOUBLING STOPS.
///
/// A post that leaves the head event exactly where it was — a 401, a 408, a
/// 429, a 5xx, or a 200 whose `accepted_through` does not reach the head — is
/// not a reason to stop uploading, and the drain keeps the event. What it used
/// to be was a reason to re-post it on EVERY PASS, about twenty-five times a
/// second, which starved the heartbeat that shares the pass's one blocking
/// call: the roster then aged out at six hours and the door admitted nobody, a
/// board taken out of service never heard the heartbeat's 403 and kept
/// admitting rostered members, and the API was hammered by a device that is
/// supposed to speak twice a minute.
///
/// Fifteen seconds is short enough that a rate limiter lifting is noticed
/// within one heartbeat interval; five minutes is long enough that a
/// permanently refusing endpoint costs twelve requests an hour instead of
/// ninety thousand. Anything that actually MOVES the queue clears it.
inline constexpr uint32_t kEventRetryStartMs = 15000UL;
inline constexpr uint32_t kEventRetryMaxMs = 300000UL;

/// The most CONSECUTIVE passes a scan may take the pass's one blocking call
/// while an UPLOAD — a due heartbeat or a ready event drain — is waiting for it.
///
/// The member at the door wins the pass — that is the whole reason the scanner
/// is drained first — but a scanner that never stops talking would otherwise
/// win every pass forever, and a board that never heartbeats is a board whose
/// roster ages out. Four passes is at most four worst-case calls of delay on a
/// cadence measured in tens of seconds, which no door can notice, and it is a
/// bound rather than a hope.
///
/// IT SAID `Heartbeat` AND COVERED ONLY THE HEARTBEAT, which round G2 asked for
/// and round G3 measured: with a scan offered every 210 ms the heartbeat kept
/// its cadence (116 in an hour) and the EVENT DRAIN posted nothing at all for
/// the whole hour, so an evening of offline entries sat in a ring that then
/// overflowed silently. Both uploads are bounded by this one counter now.
inline constexpr uint8_t kMaxScanPassesBeforeUpload = 4U;

/// THE FLOOR UNDER THE HEARTBEAT, whatever armed it.
///
/// `pumpLink` re-arms the heartbeat to "now" on every link-UP edge, because the
/// heartbeat is what fills the roster and until it has, an offline scan is
/// refused. On a board whose radio is flapping — a door at the edge of the AP's
/// range, which is where doors are — that is one heartbeat PER PASS: measured
/// at 179 999 in a simulated hour against a cadence of 120, an API the club
/// would read as an attack and a board that spends its whole life in a connect.
///
/// So no heartbeat is ATTEMPTED within this of the previous ATTEMPT — attempt,
/// not success, because a failing call must not be retried faster than a
/// succeeding one. Fifteen seconds bounds the flapping case at 240 an hour,
/// twice the healthy cadence, and equals `devlink::kMinHeartbeatMs`, which is
/// the shortest interval the server is allowed to push: the floor can therefore
/// never make the board disobey a cadence it was told to keep.
inline constexpr uint32_t kMinHeartbeatSpacingMs = 15000UL;

/// The ceiling on every diagnostic counter that rides in the heartbeat request.
///
/// `no_push` and `events_lost` are both since-boot totals bound as a signed
/// 64-bit value by the API, which ignores a negative or oversized one rather
/// than answering 400. A counter that wrapped would report a board that has
/// lost 4 billion events as a healthy one, so they saturate here instead: a
/// count pinned at this number means "at least this many", which is the honest
/// reading and the one nobody has to check.
inline constexpr uint32_t kMaxDiagnosticCount = 2147483647UL;

/// The longest idle the loop ever takes. Ten milliseconds of doing nothing
/// costs nothing a door can notice and keeps the ESP32's own housekeeping tasks
/// scheduled. It is the ONLY delay in this firmware.
inline constexpr uint32_t kIdleDelayMs = 10UL;

/// A backoff shorter than one pass would not be a backoff, and one that starts
/// past its own cap would never double.
static_assert(kEventRetryStartMs >= kIdleDelayMs && kEventRetryStartMs <= kEventRetryMaxMs,
              "the event backoff must start somewhere between one pass and its own cap");

/// The UART receive buffer, set BEFORE `Serial2.begin` — afterwards it is too
/// late, the driver has already allocated.
///
/// The core's default is 256 bytes, which is 267 ms of line-rate data at 9600
/// baud. A blocking call holds the loop for up to kWorstBlockingCallMs, and a
/// member holding a phone at the reader produces a repeated line every few
/// hundred milliseconds throughout, so the default overruns in ordinary service
/// — silently, dropping bytes out of the middle of a line that then trims,
/// fits the token cap, and is handed up as somebody else's token.
///
/// 1024 bytes holds a full blocking call's worth of REPEATED SCANS. It does not
/// hold a full blocking call's worth of CONTINUOUS bytes — that would need
/// about 7.7 kB at this baud — and it is not meant to: a scanner streaming
/// without pause is a broken scanner, and the guarantee for that case is the
/// overrun callback, not the buffer size.
inline constexpr uint16_t kScannerRxBufferBytes = 1024U;

/// Bytes the loop discards in one go when the driver reports a receive error.
///
/// THE WHOLE BUFFER, because the hole is at the TAIL of what is buffered and
/// not at the head of it. An overrun happens when the FIFO is full: everything
/// the driver had, it keeps, and what it drops is what arrived next — so the
/// bytes `read()` hands up afterwards are the OLD ones, in order and printable,
/// followed by the far side of a hole. Poisoning only the line in assembly
/// therefore poisoned the wrong line: a good buffered line was dropped and the
/// holed one was handed up later as a perfectly valid token.
///
/// An overrun costs everything that was buffered when it happened, and nothing
/// after the next terminator. A member re-scans; nobody else's booking opens a
/// door.
inline constexpr uint16_t kScannerDrainOnErrorBytes = kScannerRxBufferBytes;

/// Every wiring and timing fact this firmware has, in one value.
struct GateConfig {
  uint8_t scannerRxPin;
  uint8_t scannerTxPin;
  uint32_t scannerBaud;

  uint8_t relayPin;
  /// True when a HIGH level energises the relay coil.
  bool relayActiveHigh;
  /// True when an energised coil releases the lock.
  bool unlockEnergisesRelay;

  uint8_t ledPin;
  bool ledActiveHigh;

  uint32_t unlockDefaultMs;
  uint32_t unlockHardCapMs;
  /// The dark time a cap-forced close guarantees, and the floor under every
  /// close. See the two macros above for why there are two of them.
  uint32_t relockDwellMs;
  uint32_t minRelockMs;
  uint32_t rosterMaxAgeMs;
  uint32_t heartbeatMs;
  uint16_t eventQueueSlots;
  uint8_t maxTokenLen;
  uint8_t watchdogSeconds;
};

inline constexpr GateConfig kGateConfig = {
    static_cast<uint8_t>(GATE_SCANNER_RX_PIN),
    static_cast<uint8_t>(GATE_SCANNER_TX_PIN),
    static_cast<uint32_t>(GATE_SCANNER_BAUD),
    static_cast<uint8_t>(GATE_RELAY_PIN),
    GATE_RELAY_ACTIVE_HIGH != 0,
    GATE_UNLOCK_ENERGISES_RELAY != 0,
    static_cast<uint8_t>(GATE_LED_PIN),
    GATE_LED_ACTIVE_HIGH != 0,
    static_cast<uint32_t>(GATE_UNLOCK_DEFAULT_MS),
    static_cast<uint32_t>(GATE_UNLOCK_HARD_CAP_MS),
    static_cast<uint32_t>(GATE_RELOCK_DWELL_MS),
    static_cast<uint32_t>(GATE_MIN_RELOCK_MS),
    static_cast<uint32_t>(ROSTER_MAX_AGE_MS),
    static_cast<uint32_t>(HEARTBEAT_INTERVAL_MS),
    static_cast<uint16_t>(EVENTQ_SLOTS),
    static_cast<uint8_t>(GATE_MAX_TOKEN_LEN),
    static_cast<uint8_t>(GATE_WATCHDOG_SECONDS),
};

// --- what the flags may not say ---------------------------------------------
//
// Every one of these is a mistake that produces a board which compiles, boots,
// and is wrong about a door.

/// GPIO 34-39 on an ESP32 are INPUT ONLY. A relay on one of them is a lock
/// that never opens and a pin that reads back exactly what was written to it,
/// so nothing in the firmware notices.
static_assert(kGateConfig.relayPin <= 33U, "GATE_RELAY_PIN must be an output-capable GPIO (0-33)");
static_assert(kGateConfig.ledPin <= 33U, "GATE_LED_PIN must be an output-capable GPIO (0-33)");
static_assert(kGateConfig.scannerRxPin <= 39U, "GATE_SCANNER_RX_PIN is not an ESP32 GPIO");
static_assert(kGateConfig.scannerTxPin <= 33U, "GATE_SCANNER_TX_PIN must be output-capable");
static_assert(kGateConfig.relayPin != kGateConfig.ledPin,
              "the lock and the LED cannot share a pin — the LED would open the door");
static_assert(kGateConfig.relayPin != kGateConfig.scannerRxPin &&
                  kGateConfig.relayPin != kGateConfig.scannerTxPin,
              "the lock cannot share a pin with the scanner UART");

static_assert(kGateConfig.scannerBaud >= 1200UL && kGateConfig.scannerBaud <= 115200UL,
              "GATE_SCANNER_BAUD is outside what the scanner module can be set to");

/// The server clamps to [1, 30] seconds and so does the board. A hard cap over
/// 30 s would let a server answer hold a door open longer than the contract
/// allows anybody to ask for.
static_assert(kGateConfig.unlockHardCapMs >= kMinUnlockMs && kGateConfig.unlockHardCapMs <= 30000UL,
              "GATE_UNLOCK_HARD_CAP_MS must be within the contract's [1s, 30s]");
static_assert(kGateConfig.unlockDefaultMs >= kMinUnlockMs,
              "GATE_UNLOCK_DEFAULT_MS below one second is a door that clicks and stays shut");
static_assert(kGateConfig.unlockDefaultMs <= kGateConfig.unlockHardCapMs,
              "GATE_UNLOCK_DEFAULT_MS is longer than the hard cap, so the default could never apply");

/// THE TWO DWELLS ARE WHAT MAKE THE HARD CAP A BOUND ON THE DOOR (round G4, A1).
///
/// A dwell of zero is the shipped defect exactly: the relay writes OFF and ON in
/// one pass and the lock is never de-energised at all. A dwell of one pass is
/// not meaningfully different — the ESP32 writes both levels inside 10 ms and no
/// strike or maglock responds to that — so the floor is stated in the terms the
/// hardware is specified in rather than in passes.
static_assert(kGateConfig.minRelockMs >= 100UL,
              "GATE_MIN_RELOCK_MS below a strike's own relatch time is a lock that is never actually "
              "de-energised between two windows — see round G4's A1");
static_assert(kGateConfig.relockDwellMs >= kGateConfig.minRelockMs,
              "a cap-forced close must dwell at least as long as an ordinary one: it is the close "
              "that overrules somebody holding the door open");

/// And the cap plus its dwell is a DUTY CYCLE, which is the sentence that
/// actually bounds the door. Anything approaching the roster's staleness window
/// would mean a board could be held open for a meaningful part of the time it
/// trusts its own cache for.
static_assert(kGateConfig.relockDwellMs <= kGateConfig.unlockHardCapMs,
              "a relock dwell longer than the cap itself would make a busy door spend most of its "
              "time refusing members who have done nothing wrong");

static_assert(kGateConfig.rosterMaxAgeMs > 0UL,
              "a roster with no maximum age eventually admits a booking cancelled last week");

/// The event drain's backoff exists so a refusing `/events` cannot starve the
/// heartbeat. A backoff longer than the staleness window it protects would give
/// that back: the roster could age out between two attempts.
static_assert(kEventRetryMaxMs < kGateConfig.rosterMaxAgeMs,
              "the event backoff cap must be well inside ROSTER_MAX_AGE_MS");

/// The bound a busy scanner may put on an upload, stated against what the
/// heartbeat is FOR rather than against its own cadence.
///
/// The worst case is kMaxScanPassesBeforeUpload whole blocking calls — 48 s
/// with this image's numbers — so a permanently busy door heartbeats at roughly
/// twice its cadence rather than, as it used to, never. Stating it against the
/// cadence would be the wrong comparison and would not hold: the server may
/// push an interval as short as `devlink::kMinHeartbeatMs`. What the heartbeat
/// protects is the roster's age and hearing a 403, and forty-eight seconds is
/// under half a percent of ROSTER_MAX_AGE_MS.
static_assert(static_cast<uint32_t>(kMaxScanPassesBeforeUpload) * kWorstBlockingCallMs <
                  kGateConfig.rosterMaxAgeMs / 100UL,
              "a busy scanner may delay an upload by a fraction of the staleness window, never by a "
              "meaningful part of it");
static_assert(kGateConfig.heartbeatMs >= devlink::kMinHeartbeatMs &&
                  kGateConfig.heartbeatMs <= devlink::kMaxHeartbeatMs,
              "HEARTBEAT_INTERVAL_MS is outside what devlink::Cadence will adopt, so the board would "
              "start at a cadence it can never return to");

/// The spacing floor may never be longer than the shortest cadence the server
/// is allowed to push. If it were, a board told to heartbeat every 15 s would
/// quietly heartbeat at the floor instead and nothing would say so.
static_assert(kMinHeartbeatSpacingMs <= devlink::kMinHeartbeatMs,
              "kMinHeartbeatSpacingMs is longer than the shortest interval devlink::Cadence will adopt, "
              "so the board would silently disobey a cadence the server pushed");

static_assert(kGateConfig.eventQueueSlots >= 1U, "a queue of nothing records nothing");

/// The scanner refuses anything longer than the roster can hold. If these two
/// drifted apart the board would either truncate a token — matching the wrong
/// member — or hold one the roster could never match.
static_assert(kGateConfig.maxTokenLen == roster::kMaxTokenLen,
              "GATE_MAX_TOKEN_LEN and roster::kMaxTokenLen must be the same number");

static_assert(kGateConfig.watchdogSeconds >= 1U && kGateConfig.watchdogSeconds <= 30U,
              "GATE_WATCHDOG_SECONDS outside [1, 30] is either a reset storm or no watchdog at all");

/// THE RELATION THE ROUND-G1 REVIEW WAS FOUND BY.
///
/// The loop makes at most ONE blocking call per pass and kicks the watchdog
/// immediately before and immediately after it, so the longest the countdown
/// ever runs unkicked is one worst-case call. With a watchdog no longer than
/// that call, an API host that silently drops packets resets the board before
/// the call it is waiting on can return — every time, from the first heartbeat
/// after boot, so the roster never loads and the door admits nobody. The
/// original eight-second watchdog against two four-second timeouts was exactly
/// that case.
///
/// Changing either timeout, or the watchdog, without the other is a compile
/// error rather than a board that reset-loops in a cupboard.
static_assert(static_cast<uint32_t>(kGateConfig.watchdogSeconds) * 1000UL >=
                  kWorstBlockingCallMs + kWatchdogMarginMs,
              "GATE_WATCHDOG_SECONDS must exceed one worst-case blocking HTTP call (connect + "
              "response) with room for a whole pass on top, or a slow API host is a reset loop");

static_assert(kScannerRxBufferBytes >= 1024U,
              "the scanner's receive buffer must hold a blocking call's worth of repeated scans — "
              "the core's 256-byte default is 267 ms at 9600 baud and overruns in normal service");

/// Milliseconds of continuous line-rate data the buffer holds at the configured
/// baud. Tied to the baud rather than written out, so raising GATE_SCANNER_BAUD
/// without raising the buffer is a compile error.
inline constexpr uint32_t kScannerRxBufferMs =
    (static_cast<uint32_t>(kScannerRxBufferBytes) * 10UL * 1000UL) / kGateConfig.scannerBaud;

static_assert(kScannerRxBufferMs >= 1000UL,
              "the scanner's receive buffer holds under a second at this baud — raise "
              "kScannerRxBufferBytes or lower GATE_SCANNER_BAUD");

} // namespace gatelogic

#endif // CRUSADERS_GATELOGIC_GATECONFIG_H

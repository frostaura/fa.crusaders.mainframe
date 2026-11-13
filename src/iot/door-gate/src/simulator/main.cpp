// Crusaders Mainframe — the DOOR GATE's native simulator: the composition root.
//
// WHAT THIS IS FOR
// ----------------
// `test/e2e-device/door_evening.py` proves the door end of the device chain
// against the real API, the real gateway and a real Postgres — and until this
// binary existed, a PYTHON SCRIPT PLAYED THE WHOLE BOARD. Its own README said
// so in as many words: *"The firmware's own decisions. `gatelogic` is
// host-tested in `src/iot/door-gate/test/`. `wire.py` re-implements the
// reader's framing rules to read the server the way a board would; it does not
// execute the firmware."*
//
// That is the shape of gap the court box closed years ago with
// `court-box/src/simulator`, and its header says why it matters: a stub only
// ever agrees with itself, because both ends of the conversation are written
// from one reading of the spec, so a misreading passes. This repository has
// already paid for that twice — round G1 found four serious defects in the
// gate's own `loop()` in one pass, because `build_src_filter = -<*>` meant
// nothing could see it; round G3 found the API chunking every device route on a
// kept-open socket, against which the real firmware's reader timed out on every
// call, because no test in the tree read a real socket.
//
// So this is the SAME `gatelogic::GateApp` loop, the SAME `GateApi`, the SAME
// `GateFlow` status table, the SAME `ResponseBody` framing and de-chunker, the
// SAME `UnlockTimer` and `LockDriver` and `ScanAssembler` and `ScanDebounce`
// and `LedPattern` the ESP32 runs — over `posix_gate_hal` and `posix_hal`
// instead of `esp32_hal`, with a REAL socket to a REAL API. If the firmware
// refuses a token, so does this; if the firmware releases the lock for three
// seconds, so does this. That is what makes it evidence rather than a second
// opinion.
//
// NOTHING PER-DOOR AND NOTHING SECRET IS COMPILED IN
// --------------------------------------------------
// The board gets its four values from a gitignored `src/common/secrets.h` and
// `#error`s without it. This binary takes the two that matter — the API base
// URL and the device API key — from FLAGS OR THE ENVIRONMENT, and the MAC too,
// because a simulator with a credential baked into it is a credential in a
// build directory and, one `make arduino-export` later, in a sketch folder.
// `--device-key` is read but never printed: the transcript is an artefact CI
// uploads on failure.
//
// The API base URL is checked against `gatelogic::isValidApiBaseUrl` AT
// STARTUP, with the same grammar `src/gate/main.cpp` static_asserts at compile
// time. A simulator that accepted a URL the firmware would refuse would be
// testing a different firmware.
//
// WHAT THIS DELIBERATELY DOES NOT SIMULATE
// ----------------------------------------
//   * The WiFi radio. `ConsoleLink` is told up or down from the console,
//     because a host socket is always there and "the router rebooted" has to be
//     said rather than sensed. What the firmware DOES about it — the roster
//     fallback, the heartbeat re-arm on the up edge, the spacing floor, the
//     deferral debt — is all real.
//   * The GM-series scanner's UART. Bytes arrive from a console line instead of
//     from a 9600 baud module on GPIO 4. They arrive ONE AT A TIME through the
//     real `ScanAssembler`, and a receive error can be injected, but the module
//     itself is not here.
//   * The physical relay and the lock. There is no coil, no contact and no
//     readback — and there is no readback on the real board either, which is a
//     hardware fact and not a simulator gap. What the pin was COMMANDED is
//     printed, with its electrical level.
//   * The watchdog's reset. `ConsoleWatchdog` prints the breach instead of
//     killing the process, so the transcript carries the evidence.
//   * NVS. The event queue's sequence high-water mark lives in a directory of
//     files through `posix_hal::FileStore`, which cannot produce a torn write —
//     `fakes::FakeStore` is where that case is exercised.
//
// THE CONSOLE
// -----------
// Deliberately not the wire: a person driving this by hand wants
// `scan CODE`, and a harness that wants a real HTTP request has the API for it.
//
//   scan <code>     present <code> at the reader, as a line of scanner bytes
//   rxerror         raise the UART's receive-error flag, as an overrun does
//   wifi up|down    the radio associates or goes away
//   status          one line of everything observable
//   quit            stop, locking the door on the way out

#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "devapi/DeviceClient.h"
#include "devlink/ApiBreaker.h"
#include "fwversion/Version.h"
#include "gatelogic/ApiBaseUrl.h"
#include "gatelogic/FaultLog.h"
#include "gatelogic/FaultingStore.h"
#include "gatelogic/GateApi.h"
#include "gatelogic/GateApp.h"
#include "gatelogic/GateConfig.h"
#include "gatelogic/GateKeys.h"
#include "gatelogic/GateNet.h"
#include "gatelogic/GateStore.h"
#include "gatelogic/LedPattern.h"
#include "gatelogic/LockDriver.h"
#include "gatelogic/ScanAssembler.h"
#include "gatelogic/ScanDebounce.h"
#include "gatelogic/UnlockTimer.h"
#include "posix_gate_hal/PosixGateHal.h"
#include "posix_hal/FileStore.h"
#include "posix_hal/PosixClock.h"
#include "posix_hal/StdinLines.h"

namespace {

using namespace gatelogic;

constexpr char kDefaultStoreDir[] = ".gatestore";

/// Twelve lowercase hex, exactly as `WiFi.macAddress()` renders on the board.
/// A default rather than a requirement so the binary can be run by hand; every
/// harness passes one, because an unknown MAC auto-registers a Gate row and two
/// runs sharing one would share a device.
constexpr char kDefaultMac[] = "02d0deadbeef";

/// What the clock reads at launch unless a harness says otherwise.
///
/// NOT ZERO, AND THAT IS THE WHOLE POINT OF THE CONSTANT. Zero is the one value
/// of millis()-at-begin() that no real board ever has: the Arduino core's init,
/// `Serial.begin`, NVS, the UART driver and `WiFi.begin` all run before
/// `gApp.begin()` does. It is also the one value that HID round G4's C1 — the
/// uptime accumulator was seeded R ms behind the clock every event is stamped
/// from, and with R = 0 the bug is arithmetically invisible. A simulator whose
/// default is the single value that cannot occur in the field is a simulator
/// that can be green by construction, and this one was, for every run of
/// `door_evening.py` there has ever been.
///
/// The exact number is deliberately not round and is not load-bearing: nothing
/// may come to depend on it. It is larger than a real board's few hundred
/// milliseconds on purpose, because the window C1 lived in is R wide and a
/// harness wants it visible rather than marginal. `--start-ms 0` still says
/// zero, for a test that specifically wants it.
constexpr uint32_t kDefaultStartMs = 4200U;

volatile sig_atomic_t gStopRequested = 0;

void onSignal(int) {
  gStopRequested = 1;
}

struct Options {
  const char* apiBase = nullptr;
  const char* deviceKey = nullptr;
  const char* mac = kDefaultMac;
  const char* storeDir = kDefaultStoreDir;
  /// What the clock reads at launch. 4294963200 puts the 49.7-day millis()
  /// rollover four seconds after startup, so a harness can assert "the lock
  /// still releases across the wrap" in one run instead of in seven weeks.
  /// Defaults to kDefaultStartMs — see there for why it is not zero.
  uint32_t startMs = kDefaultStartMs;
  /// Start with the radio down, so a harness can prove what a board does before
  /// it has ever loaded a roster.
  bool linkDown = false;
  /// THIS BOOT'S IDENTITY, the third field of the server's idempotency key
  /// (round G4, C2). `esp_random()` on the board; SEEDABLE here, because a
  /// harness that wants to prove "the same board, restarted, is not deduped
  /// away" has to be able to say which boot is which — and one that wants to
  /// prove the opposite has to be able to repeat one. Zero means "draw one",
  /// which is what a run that does not care gets.
  uint32_t bootId = 0U;
  /// Read the response headers the way the BOARD does — an inter-byte timeout
  /// a dribbling peer can hold open for ever — instead of the absolute deadline
  /// this simulator uses by default. Round G4, A4: the one unbounded path in
  /// this firmware was the one path no test vehicle could reach.
  bool boardHeaderTimeout = false;
  /// A warm boot: the RTC memory the last run left in the store is believed, as
  /// the board believes RTC memory after any reset but a power-on (§14.1).
  bool warm = false;
};

/// A boot identity for a run that did not name one.
///
/// NOT `rand()`. The requirement is that two consecutive runs of one simulator
/// — and two simulators a harness gave the same MAC — do not collide, and a
/// PRNG seeded from a one-second clock gives two processes started in the same
/// second the same answer. The clock's nanoseconds and the pid are what
/// actually differ between two runs of this binary.
uint32_t drawBootId() {
  timespec now;
  static_cast<void>(clock_gettime(CLOCK_REALTIME, &now));
  const uint32_t mixed = static_cast<uint32_t>(now.tv_nsec) ^ (static_cast<uint32_t>(now.tv_sec) << 11) ^
                         (static_cast<uint32_t>(getpid()) * 2654435761UL);
  // Never zero: zero is the wire's "this board has no boot identity", which
  // omits the field and hands the server the (device, seq) behaviour C2 exists
  // to close.
  return mixed == 0U ? 1U : mixed;
}

void usage() {
  printf("usage: gate-simulator --api-base URL --device-key KEY [--mac HEX12] [--store DIR]\n"
         "                      [--start-ms MS] [--link-down]\n"
         "  --api-base    http:// + an IPv4 literal + an optional :port, no trailing slash\n"
         "                (or GATE_API_BASE). The SAME grammar the board static_asserts.\n"
         "  --device-key  the tenant's device API key (or GATE_DEVICE_KEY). NEVER printed.\n"
         "  --mac         this board's MAC as 12 lowercase hex (or GATE_MAC)\n"
         "  --store       directory for the event queue's persisted sequence\n"
         "  --start-ms    what the millis() clock reads at launch; 4294963200 puts\n"
         "                the 49.7-day rollover four seconds from now. Defaults to\n"
         "                a NON-ZERO value: zero is the one reading no real board\n"
         "                has at begin(), and it is the one that hid G4's C1\n"
         "  --boot-id     this boot's identity, the third field of the server's\n"
         "                idempotency key. Drawn from the clock and the pid when\n"
         "                absent; give one to repeat or to distinguish a boot\n"
         "  --link-down   boot with the radio not associated\n"
         "  --board-header-timeout\n"
         "                read response headers with the BOARD's inter-byte timeout\n"
         "                instead of an absolute deadline. A peer that dribbles then\n"
         "                holds the call open past the watchdog, exactly as on the\n"
         "                hardware, and the breach is reported instead of resetting\n"
         "  --warm        a warm boot: the RTC memory the last run left in --store is\n"
         "                believed, as after a watchdog or software reset. Without it\n"
         "                every launch is a power-on (the flash records alone)\n"
         "console: 'scan <code>', 'rxerror', 'wifi up|down', 'status', 'quit'\n");
}

/// `--name VALUE`, consumed. Advances `i` past the value on a match.
bool takeValue(int argc, char** argv, int& i, const char* name, const char** out) {
  if (strcmp(argv[i], name) != 0 || (i + 1) >= argc) {
    return false;
  }
  *out = argv[++i];
  return true;
}

/// One argument. False for anything this binary does not know, which is a usage
/// message rather than a silently ignored flag — a simulator that shrugged at
/// `--api_base` would run against a default nobody chose.
bool parseArgument(int argc, char** argv, int& i, Options& out) {
  const char* value = nullptr;
  if (takeValue(argc, argv, i, "--api-base", &out.apiBase) ||
      takeValue(argc, argv, i, "--device-key", &out.deviceKey) ||
      takeValue(argc, argv, i, "--mac", &out.mac) || takeValue(argc, argv, i, "--store", &out.storeDir)) {
    return true;
  }
  if (takeValue(argc, argv, i, "--start-ms", &value)) {
    out.startMs = static_cast<uint32_t>(strtoul(value, nullptr, 10));
    return true;
  }
  if (takeValue(argc, argv, i, "--boot-id", &value)) {
    out.bootId = static_cast<uint32_t>(strtoul(value, nullptr, 10));
    return true;
  }
  if (strcmp(argv[i], "--link-down") == 0) {
    out.linkDown = true;
    return true;
  }
  if (strcmp(argv[i], "--warm") == 0) {
    out.warm = true;
    return true;
  }
  if (strcmp(argv[i], "--board-header-timeout") == 0) {
    out.boardHeaderTimeout = true;
    return true;
  }
  return false;
}

/// The environment is the fallback for the two secrets-shaped values, so a
/// harness never has to put a device key in an argv that `ps` shows.
void applyEnvironment(Options& out) {
  if (out.apiBase == nullptr) {
    out.apiBase = getenv("GATE_API_BASE");
  }
  if (out.deviceKey == nullptr) {
    out.deviceKey = getenv("GATE_DEVICE_KEY");
  }
  const char* macEnv = getenv("GATE_MAC");
  if (macEnv != nullptr && strcmp(out.mac, kDefaultMac) == 0) {
    out.mac = macEnv;
  }
}

bool parseOptions(int argc, char** argv, Options& out) {
  for (int i = 1; i < argc; ++i) {
    if (!parseArgument(argc, argv, i, out)) {
      return false;
    }
  }
  applyEnvironment(out);
  if (out.bootId == 0U) {
    out.bootId = drawBootId();
  }
  return out.apiBase != nullptr && out.deviceKey != nullptr;
}

bool isTwelveLowerHex(const char* mac) {
  if (mac == nullptr || strlen(mac) != 12U) {
    return false;
  }
  for (size_t i = 0U; i < 12U; ++i) {
    const char c = mac[i];
    const bool digit = c >= '0' && c <= '9';
    const bool lower = c >= 'a' && c <= 'f';
    if (!digit && !lower) {
      return false;
    }
  }
  return true;
}

/// The loop's own idle, and it is the BOARD's number rather than a convenient
/// one. `kIdleDelayMs` is the only delay in this firmware and it is one of the
/// three terms in the release-overrun bound, so a simulator that idled for one
/// millisecond would measure a bound the hardware does not have.
void idle() {
  timespec ts;
  ts.tv_sec = 0;
  ts.tv_nsec = static_cast<long>(kIdleDelayMs) * 1000000L;
  static_cast<void>(nanosleep(&ts, nullptr));
}

/// Whether the options the binary was given describe a board it could be.
///
/// The BOARD checks all of this at COMPILE time, against literals in
/// `src/common/secrets.h`. This build has no literals to assert, so the same
/// grammar runs at startup — a simulator that accepted a URL the firmware would
/// refuse would be testing a different firmware.
bool validate(const Options& options) {
  if (!isValidApiBaseUrl(options.apiBase) || !apiBaseUrlFits(options.apiBase)) {
    // A hostname is a DNS wait bounded by neither HTTP timeout; `https://` is
    // accepted and then spoken as cleartext to :443; a trailing slash is a 404
    // that reads at the door as an outage.
    fprintf(stderr, "[sim] --api-base must be http:// + an IPv4 literal + an optional :port, with no "
                    "trailing slash and no path — the same grammar src/gate/main.cpp static_asserts\n");
    return false;
  }
  if (!isTwelveLowerHex(options.mac)) {
    fprintf(stderr, "[sim] --mac must be twelve lowercase hex characters, as WiFi.macAddress() "
                    "renders on the board\n");
    return false;
  }
  if (strlen(options.deviceKey) > devapi::kMaxApiKeyLen) {
    fprintf(stderr, "[sim] --device-key is longer than devapi::kMaxApiKeyLen — a truncated key is a "
                    "401 that reads exactly like the wrong key\n");
    return false;
  }
  return true;
}

/// One whole board, wired the way src/gate/main.cpp wires it.
///
/// A struct rather than twenty locals in main() for the reason `GateApp::Ports`
/// is a struct: the ports have to be constructed before the app that borrows
/// them, and declaration order is the only thing that guarantees it. Nothing
/// here decides anything — it is the composition root, in a shape the
/// complexity gate can read.
class Board {
public:
  explicit Board(const Options& options)
      : options_(options), clock_(options.startMs),
        relayPin_("relay", lockPinLevel(true, kGateConfig.relayActiveHigh, kGateConfig.unlockEnergisesRelay),
                  clock_),
        ledPin_("led", ledPinLevel(true, kGateConfig.ledActiveHigh), clock_), link_(clock_),
        watchdog_(kGateConfig.watchdogSeconds, clock_), http_(net_.baseUrl(), keys_.header(), clock_),
        api_(http_, breaker_, clock_, faults_),
        lock_(relayPin_, kGateConfig.relayActiveHigh, kGateConfig.unlockEnergisesRelay),
        unlockTimer_(kGateConfig.unlockHardCapMs, kGateConfig.minRelockMs, kGateConfig.relockDwellMs),
        countedStore_(&store_, faults_, clock_), queue_(&countedStore_), roster_(kGateConfig.rosterMaxAgeMs),
        app_(wire()) {}

  /// `Bearer <key>`, rendered once, exactly as setupIdentity() does at boot.
  /// Static and filled before the Board is constructed, because SocketHttpPort
  /// holds it by pointer for the life of the process.
  static bool renderIdentity(const char* deviceKey) {
    char header[devapi::kAuthorizationBufSize] = {};
    return devapi::renderAuthorization(header, sizeof(header), deviceKey) != 0U;
  }

  /// Opens the store and the console. False when the store directory cannot be
  /// used — reported rather than run with a store that silently loses the event
  /// queue's sequence across a restart.
  bool begin() {
    if (!store_.begin(options_.storeDir) || !blobs_.begin(options_.storeDir)) {
      fprintf(stderr, "[sim] cannot use store directory %s\n", options_.storeDir);
      return false;
    }
    static_cast<void>(console_.begin());
    loadWarm();
    // BEFORE ANY CALL. See Options::boardHeaderTimeout and round G4's A4.
    http_.useBoardHeaderTimeout(options_.boardHeaderTimeout);

    // FIRST, before anything else can take time or fail, exactly as setup()
    // does: the lock's LOCKED level into the output register before the pin
    // drives it.
    app_.beginOutputs();
    // The watchdog is a report rather than a reset here, so it always "arms" —
    // and the lamp is therefore not showing the fault pattern, which is the
    // state a healthy board is in.
    app_.setWatchdogArmed(true);
    banner();

    // The radio, BEFORE the logical boot, because `begin()` arms the first
    // heartbeat as a fallback and `pumpLink`'s up edge is what re-arms it to now.
    link_.set(!options_.linkDown);
    app_.begin();
    return true;
  }

  bool restartRequested() const { return system_.requested(); }

  void run() {
    while (gStopRequested == 0 && !system_.requested()) {
      app_.pass();
      saveWarm();
      reportChanges();
      while (console_.poll()) {
        command(console_.line());
      }
      idle();
    }
    // LOCKED on the way out. A simulator that left its "relay" believing the
    // door was open would hand the next run a state the hardware cannot be in,
    // and it is the one habit this whole system is built around.
    lock_.set(false);
    printf("[sim] stopped after %lu calls, worst call %lu ms, worst unkicked gap %lu ms, "
           "%lu watchdog breach(es)\n",
           static_cast<unsigned long>(http_.calls()), static_cast<unsigned long>(http_.worstCallMs()),
           static_cast<unsigned long>(watchdog_.worstGapMs()),
           static_cast<unsigned long>(watchdog_.breaches()));
    static_cast<void>(fflush(stdout));
  }

private:
  /// The RTC memory file: what the last run left, believed only with --warm.
  void loadWarm() {
    char p[300];
    if (!options_.warm || snprintf(p, sizeof(p), "%s/warm.bin", options_.storeDir) <= 0) {
      return;
    }
    FILE* f = fopen(p, "rb");
    if (f != nullptr) {
      static_cast<void>(fread(warm_, 1U, sizeof(warm_), f));
      static_cast<void>(fclose(f));
    }
  }

  void saveWarm() {
    if (memcmp(warm_, warmSaved_, sizeof(warm_)) == 0) {
      return;
    }
    memcpy(warmSaved_, warm_, sizeof(warm_));
    char p[300];
    if (snprintf(p, sizeof(p), "%s/warm.bin", options_.storeDir) <= 0) {
      return;
    }
    FILE* f = fopen(p, "wb");
    if (f != nullptr) {
      static_cast<void>(fwrite(warm_, 1U, sizeof(warm_), f));
      static_cast<void>(fclose(f));
    }
  }

  GateApp::Ports wire() {
    GateApp::Ports ports;
    ports.clock = &clock_;
    ports.scanner = &scanner_;
    ports.watchdog = &watchdog_;
    ports.link = &link_;
    ports.api = &api_;
    ports.breaker = &breaker_;
    ports.lock = &lock_;
    ports.unlock = &unlockTimer_;
    ports.led = &led_;
    ports.ledPin = &ledPin_;
    ports.ledActiveHigh = kGateConfig.ledActiveHigh;
    ports.assembler = &assembler_;
    ports.debounce = &debounce_;
    ports.roster = &roster_;
    ports.queue = &queue_;
    ports.faults = &faults_;
    // THE ONE PORT THE BOARD LEAVES NULL. A refusal reason reaches no surface
    // on the hardware — see gatelogic/GatePorts.h — so on this build it reaches
    // stdout, and that is what lets a harness assert that a given server reason
    // produced a refusal rather than that a relay happened not to move.
    ports.log = &decisions_;
    ports.mac = options_.mac;
    ports.firmwareVersion = fw::kFirmwareVersion;
    ports.bootId = options_.bootId;
    // NULL, HONESTLY. `esp_reset_reason()` is a fact about a part, and this
    // process was started by a shell. A simulator that invented
    // `boot_reason_power_on` would put a reading in the transcript that no
    // hardware produced — and the harness reads this transcript.
    ports.bootReason = nullptr;
    ports.heartbeatBody = heartbeatBody_;
    ports.heartbeatBodyCap = sizeof(heartbeatBody_);
    // 2.0.0. No OTA slot and no setup portal: a simulator cannot replace its own
    // image or open an access point, and pretending would test the pretence.
    // Both are proven against the same GateApp in test/test_gate_v3.
    ports.blobs = &blobs_;
    ports.warmBytes = warm_;
    ports.warmBytesCap = sizeof(warm_);
    ports.warmClock = &rtc_;
    ports.coldBoot = !options_.warm;
    ports.keys = &keys_;
    ports.net = &net_;
    ports.compiledKey = options_.deviceKey;
    ports.compiledSsid = "SIMULATOR";
    ports.compiledPsk = "simulator-pass";
    ports.compiledBase = options_.apiBase;
    ports.radio = &radio_;
    ports.system = &system_;
    ports.diag = &diag_;
    return ports;
  }

  /// Five lines at boot, then nothing in the loop. The key is not among them.
  void banner() {
    printf("[sim] crusaders door-gate simulator %s\n", fw::kFirmwareVersion);
    printf("[sim] mac=%s api=%s store=%s boot_id=%lu\n", options_.mac, options_.apiBase, options_.storeDir,
           static_cast<unsigned long>(options_.bootId));
    printf("[sim] clock starts at %lu ms, idle %lu ms/pass, watchdog %us, worst call %lu ms\n",
           static_cast<unsigned long>(options_.startMs), static_cast<unsigned long>(kIdleDelayMs),
           static_cast<unsigned>(kGateConfig.watchdogSeconds),
           static_cast<unsigned long>(kWorstBlockingCallMs));
    printf("[sim] unlock default %lu ms, hard cap %lu ms, heartbeat %lu ms, roster max age %lu ms\n",
           static_cast<unsigned long>(kGateConfig.unlockDefaultMs),
           static_cast<unsigned long>(kGateConfig.unlockHardCapMs),
           static_cast<unsigned long>(kGateConfig.heartbeatMs),
           static_cast<unsigned long>(kGateConfig.rosterMaxAgeMs));
    if (options_.boardHeaderTimeout) {
      printf("[sim] header phase uses the BOARD's INTER-BYTE timeout: a dribbling peer can hold a "
             "call past the watchdog, and the breach is reported rather than resetting\n");
    }
    printf("[sim] console: scan <code> | rxerror | wifi up|down | status | quit\n");
    static_cast<void>(fflush(stdout));
  }

  /// THE HEARTBEAT HAS NO PORT OF ITS OWN, and does not need one: everything a
  /// harness has to know about it is already public on GateApp and on the
  /// roster it filled. A re-anchored roster — its age DROPPING — happens on
  /// exactly one event: an accepted heartbeat whose body was adopted.
  void reportChanges() {
    const uint32_t age = roster_.ageMs(clock_.nowMs());
    const uint8_t size = roster_.size();
    if (!reported_ || age < lastRosterAge_ || size != lastRosterSize_ || app_.unlockMs() != lastUnlockMs_ ||
        app_.noPushHeartbeats() != lastNoPush_) {
      printf("[hb] roster=%u age_ms=%lu unlock_ms=%lu no_push=%lu link=%d t=%lums\n",
             static_cast<unsigned>(size), static_cast<unsigned long>(age),
             static_cast<unsigned long>(app_.unlockMs()), static_cast<unsigned long>(app_.noPushHeartbeats()),
             app_.linkUp() ? 1 : 0, static_cast<unsigned long>(clock_.nowMs()));
      static_cast<void>(fflush(stdout));
      reported_ = true;
    }
    lastRosterAge_ = age;
    lastRosterSize_ = size;
    lastUnlockMs_ = app_.unlockMs();
    lastNoPush_ = app_.noPushHeartbeats();

    // A WINDOW THE HARD CAP ENDED. Printed rather than left to `status`, because
    // it is an EVENT — somebody is holding this door open — and a transcript
    // that only carried the final total could not say when. Round G4, A1.
    if (app_.capForcedCloses() != lastCapped_) {
      lastCapped_ = app_.capForcedCloses();
      printf("[cap] window ended by the hard cap, total=%lu, lock dark for %lums t=%lums\n",
             static_cast<unsigned long>(lastCapped_), static_cast<unsigned long>(kGateConfig.relockDwellMs),
             static_cast<unsigned long>(clock_.nowMs()));
      static_cast<void>(fflush(stdout));
    }

    // ON THE SIZE OR ON THE LOSS, and the second is round G4's H1. A ring that
    // is FULL does not change size when it overflows — it evicts one event and
    // takes another — so every loss after the first was invisible in a
    // transcript, which is exactly the state (offline, ring full) the losses
    // happen in. `lost` is what a harness asserts the eviction policy with.
    if (queue_.size() != lastQueued_ || queue_.overflowed() != lastLost_) {
      printf("[evq] held=%u lost=%lu t=%lums\n", static_cast<unsigned>(queue_.size()),
             static_cast<unsigned long>(queue_.overflowed()), static_cast<unsigned long>(clock_.nowMs()));
      static_cast<void>(fflush(stdout));
      lastQueued_ = queue_.size();
      lastLost_ = queue_.overflowed();
    }
  }

  void status() {
    printf(
        "[status] link=%d released=%d relocking_ms=%lu capped=%lu roster=%u age_ms=%lu unlock_ms=%lu "
        "queued=%u lost=%lu no_push=%lu calls=%lu worst_call_ms=%lu worst_gap_ms=%lu wdt_breaches=%lu "
        "dropped_scan_bytes=%lu fault_report=%d fault_per_hour=%u fault_window_ms=%lu fault_codes=%u "
        "fault_overflow=%lu t=%lums\n",
        app_.linkUp() ? 1 : 0, lock_.released() ? 1 : 0,
        static_cast<unsigned long>(unlockTimer_.relockingForMs(clock_.nowMs())),
        static_cast<unsigned long>(app_.capForcedCloses()), static_cast<unsigned>(roster_.size()),
        static_cast<unsigned long>(roster_.ageMs(clock_.nowMs())),
        static_cast<unsigned long>(app_.unlockMs()), static_cast<unsigned>(queue_.size()),
        static_cast<unsigned long>(queue_.overflowed()), static_cast<unsigned long>(app_.noPushHeartbeats()),
        static_cast<unsigned long>(http_.calls()), static_cast<unsigned long>(http_.worstCallMs()),
        static_cast<unsigned long>(watchdog_.worstGapMs()), static_cast<unsigned long>(watchdog_.breaches()),
        static_cast<unsigned long>(scanner_.droppedBytes()), faults_.reporting() ? 1 : 0,
        static_cast<unsigned>(faults_.maxPerHour()), static_cast<unsigned long>(faults_.windowMs()),
        static_cast<unsigned>(faults_.tracked()), static_cast<unsigned long>(faults_.overflowPending()),
        static_cast<unsigned long>(clock_.nowMs()));
    static_cast<void>(fflush(stdout));
  }

  /// The console's own vocabulary. Deliberately not the wire: a person driving
  /// this by hand wants `scan MEM-0042`, and a harness that wants a real HTTP
  /// request has the API for it.
  void command(const char* line) {
    if (strcmp(line, "quit") == 0) {
      gStopRequested = 1;
    } else if (strncmp(line, "scan ", 5U) == 0) {
      scanner_.feedLine(line + 5);
    } else if (strcmp(line, "rxerror") == 0) {
      scanner_.injectRxError();
    } else if (strcmp(line, "wifi up") == 0) {
      link_.set(true);
    } else if (strcmp(line, "wifi down") == 0) {
      link_.set(false);
    } else if (strcmp(line, "status") == 0) {
      status();
    } else {
      printf("[sim] unknown command: %s\n", line);
      static_cast<void>(fflush(stdout));
    }
  }

  Options options_;

  posix_hal::PosixClock clock_;
  // The keys and the network before the HTTP port, which holds their header
  // and base-URL buffers (GateApp::begin fills them).
  GateKeys keys_;
  GateNet net_;
  posix_gate_hal::FileBlobs blobs_;
  posix_gate_hal::MonotonicRtc rtc_;
  posix_gate_hal::ConsoleRadio radio_;
  posix_gate_hal::ConsoleSystem system_;
  posix_gate_hal::SimDiag diag_{options_.warm};
  uint8_t warm_[sizeof(WarmImage)] = {};
  uint8_t warmSaved_[sizeof(WarmImage)] = {};
  posix_hal::FileStore store_;
  posix_hal::StdinLines console_;

  posix_gate_hal::ConsolePinOut relayPin_;
  posix_gate_hal::ConsolePinOut ledPin_;
  posix_gate_hal::ConsoleScanner scanner_;
  posix_gate_hal::ConsoleLink link_;
  posix_gate_hal::ConsoleWatchdog watchdog_;
  posix_gate_hal::SocketHttpPort http_;
  posix_gate_hal::ConsoleDecisionLog decisions_;

  /// ONE LOG FOR THE WHOLE SIMULATOR, exactly as the board has one: the API
  /// client, the store wrapper and the loop all report into it, and a second
  /// instance would be a second set of rate-limit windows.
  ///
  /// DECLARED BEFORE `api_`, because member initialisation follows declaration
  /// order and `api_` binds a reference to it.
  FaultLog faults_;

  devlink::ApiBreaker breaker_;
  GateApi api_;

  LockDriver lock_;
  UnlockTimer unlockTimer_;
  LedPattern led_;
  ScanAssembler assembler_;
  ScanDebounce debounce_;
  /// The FileStore with its failed writes counted — the same decorator the
  /// board wires round its NVS store, so `nvs_write_failed` is exercised by the
  /// end-to-end harness and not only by a host test.
  FaultingStore countedStore_;
  GateQueue queue_;
  GateRoster roster_;

  /// The heartbeat response. A member rather than a local, because the contract
  /// allows 4096 bytes and a 4.6 KB stack frame under a blocking HTTP call is a
  /// crash that reads as a random reset — the same reason it is file scope in
  /// src/gate/main.cpp.
  char heartbeatBody_[kGateResponseCap] = {};

  GateApp app_;

  uint32_t lastCapped_ = 0U;
  uint32_t lastLost_ = 0U;
  uint32_t lastRosterAge_ = 0U;
  uint32_t lastUnlockMs_ = 0U;
  uint32_t lastNoPush_ = 0U;
  uint16_t lastQueued_ = 0U;
  uint8_t lastRosterSize_ = 0U;
  bool reported_ = false;
};


} // namespace

int main(int argc, char** argv) {
  Options options;
  if (!parseOptions(argc, argv, options)) {
    usage();
    return 2;
  }
  if (!validate(options)) {
    return 2;
  }
  if (!Board::renderIdentity(options.deviceKey)) {
    fprintf(stderr, "[sim] the device key does not fit the Authorization buffer\n");
    return 2;
  }

  static Board board(options);
  if (!board.begin()) {
    return 1;
  }

  static_cast<void>(signal(SIGINT, onSignal));
  static_cast<void>(signal(SIGTERM, onSignal));

  board.run();
  return board.restartRequested() ? posix_gate_hal::ConsoleSystem::kRestartExit : 0;
}

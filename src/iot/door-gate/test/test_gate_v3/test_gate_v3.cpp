// Gate 2.0.0 through the whole board (docs/specs/door-gate.md §14): what
// survives a reset, changing a door's key and network without a cable, and the
// checks the analysis asked for. Every scenario here fails on 1.1.2 behaviour
// and passes on 2.0.0.
//
// THE BOARD AND THE BOOT ARE TWO OBJECTS. `Board` is what survives a reset —
// the flash records, the RTC memory and its counter, and the clock the test
// drives. `Boot` is one power-up of the firmware over it: every
// RAM structure, constructed fresh, exactly as a reset leaves the part. A power
// cut is a new Boot with `coldBoot` true and the RTC memory scrambled; a
// watchdog reset is a new Boot with `coldBoot` false.

#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unity.h>

#include <map>
#include <memory>
#include <new>
#include <string>
#include <vector>

#include "devapi/DeviceClient.h"
#include "devcrypto/Base64Url.h"
#include "devlink/ApiBreaker.h"
#include "fakes/FakeClock.h"
#include "fakes/FakeStore.h"
#include "gatelogic/FaultingStore.h"
#include "gatelogic/GateApi.h"
#include "gatelogic/GateApp.h"
#include "gatelogic/GateConfig.h"
#include "gatelogic/GateNet.h"
#include "gatelogic/LedPattern.h"
#include "gatelogic/LockDriver.h"
#include "gatelogic/ScanAssembler.h"
#include "gatelogic/ScanDebounce.h"
#include "gatelogic/UnlockTimer.h"
#include "memcode/Token.h"
#include "memcode/Totp.h"

namespace {

constexpr char kMac[] = "5ccf7f0a1b2c";
constexpr char kCompiledKey[] = "k7Qz3mR9vT1bXf5NpYw2LcJd8HsA4EgU";
constexpr char kNewKey[] = "Zq7Hn2Vb5Rt8Wy1Lp4Mk6Xc9Ds3Fg0Jh_a-QeUoIiEr";
constexpr char kBase[] = "http://192.168.1.10:8088";

// --- the parts of the board that survive a reset ------------------------------

class RamBlobs final : public gatelogic::IBlobStore {
public:
  bool put(const char* key, const void* data, size_t len) override {
    ++writes;
    ++writesTo[key];
    if (failWrites) {
      return false;
    }
    records[key] = std::string(static_cast<const char*>(data), len);
    return true;
  }

  size_t get(const char* key, void* out, size_t cap) override {
    auto it = records.find(key);
    if (it == records.end() || it->second.size() > cap) {
      return 0U;
    }
    memcpy(out, it->second.data(), it->second.size());
    return it->second.size();
  }

  void erase(const char* key) override { records.erase(key); }

  std::map<std::string, std::string> records;
  std::map<std::string, uint32_t> writesTo;
  uint32_t writes = 0U;
  bool failWrites = false;
};

class Rtc final : public gatelogic::IWarmClock {
public:
  uint64_t nowUs() override { return us; }

  uint64_t us = 1000000ULL;
};

struct Board {
  fakes::FakeClock clock{1000U};
  RamBlobs blobs;
  Rtc rtc;
  uint8_t warm[sizeof(gatelogic::WarmImage) + 16U] = {};

  /// A power cut: RTC memory is garbage and the RTC counter starts again.
  void powerCut(uint32_t offForMs) {
    for (size_t i = 0U; i < sizeof(warm); ++i) {
      warm[i] = static_cast<uint8_t>(warm[i] * 31U + 7U);
    }
    rtc.us = 1000000ULL;
    clock.advance(offForMs);
  }
};

// --- the parts of one boot ----------------------------------------------------

class Pin final : public gatelogic::IPinOut {
public:
  void write(hal::PinLevel l) override { level = l; }

  void driveOutput() override {}

  hal::PinLevel readBack() const override { return level; }

  hal::PinLevel level = hal::PinLevel::kLow;
};

class Dog final : public gatelogic::IWatchdog {
public:
  void kick() override { ++kicks; }

  uint32_t kicks = 0U;
};

class Link final : public gatelogic::ILink {
public:
  bool up() override { return isUp; }

  bool isUp = true;
};

class Scanner final : public gatelogic::IScannerBytes {
public:
  void feed(const char* text) {
    for (size_t i = 0U; text[i] != '\0'; ++i) {
      bytes.push_back(static_cast<uint8_t>(text[i]));
    }
  }

  void feedByte(uint8_t b) { bytes.push_back(b); }

  bool read(uint8_t& out) override {
    if (head >= bytes.size()) {
      return false;
    }
    out = bytes[head++];
    return true;
  }

  bool takeRxError() override { return false; }

  std::vector<uint8_t> bytes;
  size_t head = 0U;
};

struct Call {
  std::string path;
  std::string body;
  std::string auth;
  std::string base;
  bool ledOn = false;
};

/// The server, per path. `acceptKeys` lists the keys it authenticates; any
/// other header is a 401.
class Server final : public gatelogic::IHttpPort {
public:
  Server(const char* const* auth, const char* const* base, Pin& led) : auth_(auth), base_(base), led_(led) {}

  void on(const char* path, uint16_t status, const std::string& body) { answers[path] = {status, body}; }

  gatelogic::HttpOutcome post(const char* path, const char* body, char* out, size_t outCap) override {
    Call c;
    c.path = path;
    c.body = body;
    c.auth = *auth_ != nullptr ? *auth_ : "";
    c.base = *base_ != nullptr ? *base_ : "";
    c.ledOn = led_.level == hal::PinLevel::kHigh;
    calls.push_back(c);
    if (down) {
      return gatelogic::noCall();
    }
    if (!acceptKeys.empty()) {
      bool ok = false;
      for (const std::string& k : acceptKeys) {
        ok = ok || c.auth == "Bearer " + k;
      }
      if (!ok) {
        return gatelogic::HttpOutcome{401U, 401U};
      }
    }
    if (!acceptBase.empty() && c.base != acceptBase) {
      return gatelogic::noCall();
    }
    auto it = answers.find(path);
    const uint16_t status = it == answers.end() ? 200U : it->second.first;
    std::string reply =
        it == answers.end() ? std::string("{\"accepted_through\":0,\"recorded\":0}") : it->second.second;
    if (it == answers.end() && c.path == gatelogic::kPathEvents) {
      // The real server receipts exactly what it was sent.
      const size_t at = c.body.find("\"seq\":");
      reply = "{\"accepted_through\":" + c.body.substr(at + 6U, c.body.find(',', at) - at - 6U) +
              ",\"recorded\":1}";
    }
    if (out != nullptr && outCap > 0U) {
      if (reply.size() >= outCap) {
        out[0] = '\0';
        return gatelogic::HttpOutcome{0U, status};
      }
      memcpy(out, reply.c_str(), reply.size() + 1U);
    }
    return gatelogic::HttpOutcome{status, status};
  }

  size_t count(const char* path) const {
    size_t n = 0U;
    for (const Call& c : calls) {
      n += c.path == path ? 1U : 0U;
    }
    return n;
  }

  const Call* last(const char* path) const {
    for (size_t i = calls.size(); i > 0U; --i) {
      if (calls[i - 1U].path == path) {
        return &calls[i - 1U];
      }
    }
    return nullptr;
  }

  std::map<std::string, std::pair<uint16_t, std::string>> answers;
  std::vector<Call> calls;
  std::vector<std::string> acceptKeys;
  std::string acceptBase;
  bool down = false;

private:
  const char* const* auth_;
  const char* const* base_;
  Pin& led_;
};

class Radio final : public gatelogic::IRadio {
public:
  void join(const char* ssid, const char* psk) override { joins.push_back(std::string(ssid) + "/" + psk); }

  std::vector<std::string> joins;
};

class Chip final : public gatelogic::ISystem {
public:
  void restart() override { ++restarts; }

  uint32_t restarts = 0U;
};

class Health final : public gatelogic::IDiagSource {
public:
  void read(gatelogic::GateDiag& d) override {
    d.reset = "task_wdt";
    d.heap = 151552U;
    d.heapMin = 139264U;
    d.block = 110592U;
    d.stackMin = 4416U;
    d.sketchFree = 1310720U;
    d.flashMb = 4U;
  }
};

class Button final : public gatelogic::IButton {
public:
  bool pressed() override { return down; }

  bool down = false;
};

class Portal final : public gatelogic::ISetupPortal {
public:
  void open(const char* apName) override {
    name = apName;
    isOpen = true;
  }

  bool service(gatelogic::PortalForm& out) override {
    if (!submitted) {
      return false;
    }
    submitted = false;
    out = form;
    return true;
  }

  void refuse(const char* reason) override { refused = reason; }

  void accept() override { accepted = true; }

  void close() override { isOpen = false; }

  std::string name;
  bool isOpen = false;
  bool submitted = false;
  gatelogic::PortalForm form;
  std::string refused;
  bool accepted = false;
};

class Log final : public gatelogic::IDecisionLog {
public:
  void decided(const gatelogic::ScanDecision& d, const char* token, uint32_t grantedMs,
               uint32_t nowMs) override {
    static_cast<void>(token);
    static_cast<void>(grantedMs);
    static_cast<void>(nowMs);
    reasons.push_back(d.reason);
    queued.push_back(d.queueEvent);
  }

  std::vector<std::string> reasons;
  std::vector<bool> queued;
};

struct Boot {
  Boot(Board& b, bool cold, uint32_t bootId = 0xB0071D01U, uint32_t watchdogRun = 0U)
      : board(b), server(&authHeader, &baseUrl, ledPin), api(server, breaker, b.clock, faults),
        lock(relayPin, true, true), unlock(30000U, 400U, 3000U),
        roster(gatelogic::kGateConfig.rosterMaxAgeMs), counted(&store, faults, b.clock), queue(&counted) {
    gatelogic::GateApp::Ports p;
    p.clock = &b.clock;
    p.scanner = &scanner;
    p.watchdog = &dog;
    p.link = &link;
    p.api = &api;
    p.breaker = &breaker;
    p.lock = &lock;
    p.unlock = &unlock;
    p.led = &led;
    p.ledPin = &ledPin;
    p.assembler = &assembler;
    p.debounce = &debounce;
    p.roster = &roster;
    p.queue = &queue;
    p.faults = &faults;
    p.log = &log;
    p.mac = kMac;
    p.firmwareVersion = "2.0.0";
    p.bootId = bootId;
    p.watchdogResetRun = watchdogRun;
    p.heartbeatBody = body;
    p.heartbeatBodyCap = sizeof(body);
    p.blobs = &b.blobs;
    p.warmBytes = b.warm;
    p.warmBytesCap = sizeof(b.warm);
    p.warmClock = &b.rtc;
    p.coldBoot = cold;
    p.keys = &keys;
    p.net = &net;
    p.compiledKey = kCompiledKey;
    p.compiledSsid = "CRUSADERS";
    p.compiledPsk = "compiled-pass";
    p.compiledBase = kBase;
    p.radio = &radio;
    p.system = &chip;
    p.diag = &health;
    p.setupButton = &button;
    p.portal = &portal;
    app.reset(new gatelogic::GateApp(p));
    authHeader = keys.header();
    baseUrl = net.baseUrl();
    app->beginOutputs();
    app->begin();
  }

  /// One pass, then the loop's own ten milliseconds (and the RTC with them).
  void tick(uint32_t ms = 10U) {
    // A restart is the end of this boot: nothing of it runs again.
    if (chip.restarts == 0U) {
      app->pass();
    }
    board.clock.advance(ms);
    board.rtc.us += static_cast<uint64_t>(ms) * 1000ULL;
  }

  void run(uint32_t ms, uint32_t step = 10U) {
    for (uint32_t t = 0U; t < ms; t += step) {
      tick(step);
    }
  }

  /// Past the heartbeat's floor and cadence, so the next pass beats.
  void beat() {
    run(gatelogic::kMinHeartbeatSpacingMs + 100U, 100U);
    link.isUp = false;
    tick();
    link.isUp = true;
    tick();
  }

  void scan(const char* token) {
    scanner.feed(token);
    scanner.feed("\r");
    tick();
  }

  Board& board;
  const char* authHeader = nullptr;
  const char* baseUrl = nullptr;
  Pin ledPin;
  Pin relayPin;
  Server server;
  devlink::ApiBreaker breaker;
  gatelogic::FaultLog faults;
  gatelogic::GateApi api;
  gatelogic::LockDriver lock;
  gatelogic::UnlockTimer unlock;
  gatelogic::LedPattern led;
  gatelogic::ScanAssembler assembler;
  gatelogic::ScanDebounce debounce;
  gatelogic::GateRoster roster;
  fakes::FakeStore store;
  gatelogic::FaultingStore counted;
  gatelogic::GateQueue queue;
  Dog dog;
  Link link;
  Scanner scanner;
  gatelogic::GateKeys keys;
  gatelogic::GateNet net;
  Radio radio;
  Chip chip;
  Health health;
  Button button;
  Portal portal;
  Log log;
  char body[gatelogic::kGateResponseCap] = {};
  std::unique_ptr<gatelogic::GateApp> app;
};

const char* kRoster =
    "{\"server_time\":\"2026-11-13T18:00:00\",\"kind\":\"gate\",\"gate_key\":\"front-door\",\"heartbeat_"
    "seconds\":60,"
    "\"gate\":{\"unlock_seconds\":5,\"power_restore_trust_minutes\":20,\"net_fallback_minutes\":10,"
    "\"device_fault_reporting\":true,\"device_fault_max_per_hour\":60},"
    "\"roster\":[\"7Q3F9KM2XZ8B|0|-60|7200\"]}";

std::string withKey(const char* base, const std::string& extra) {
  std::string s(base);
  s.insert(s.size() - 1U, "," + extra);
  return s;
}

bool released(Boot& b) {
  return b.lock.released();
}

/// Whether the board has said `text` — still counted in its fault log, or
/// already uploaded in an event.
bool reported(Boot& b, const char* code) {
  if (b.faults.pending(code) > 0U) {
    return true;
  }
  for (const Call& c : b.server.calls) {
    if (c.path == gatelogic::kPathEvents && c.body.find(code) != std::string::npos) {
      return true;
    }
  }
  return false;
}

// =============================================================================
// DG-2 / DG-11 — what survives a reset
// =============================================================================

/// A power cut with the server down: 1.1.2 came back with an empty roster and
/// refused the member (`roster_stale`). 2.0.0 admits the rostered booking from
/// flash inside the trust window, refuses after it, reports `restore: cold` on
/// its first accepted beat, and loses none of the evening's entries.
void test_power_cut_with_the_server_down_admits_inside_the_trust_window_only() {
  Board board;
  {
    Boot b(board, true);
    b.server.on(gatelogic::kPathHeartbeat, 200U, kRoster);
    b.run(200U);
    TEST_ASSERT_EQUAL_UINT8(1U, b.roster.size());
    // Offline, one entry is queued — the evening's record to keep.
    b.server.down = true;
    b.link.isUp = false;
    b.tick();
    b.scan("7Q3F9KM2XZ8B");
    TEST_ASSERT_TRUE(released(b));
    b.run(6000U);
  }
  board.powerCut(5000U);
  {
    Boot b(board, true, 0xB0071D02U);
    b.server.down = true;
    b.run(100U);
    TEST_ASSERT_EQUAL_STRING("cold", b.app->restoreReport());
    TEST_ASSERT_EQUAL_UINT8(1U, b.roster.size());
    b.run(3000U);
    b.scan("7Q3F9KM2XZ8B");
    TEST_ASSERT_TRUE_MESSAGE(released(b), "a rostered booking gets in after a power cut with no server");
    b.run(8000U);
    // Past the 20-minute trust window: the flash roster is no longer believed.
    b.run(20U * 60000U, 1000U);
    b.scan("7Q3F9KM2XZ8B");
    TEST_ASSERT_FALSE_MESSAGE(released(b), "trusted for power_restore_trust_minutes and not one pass longer");
    TEST_ASSERT_TRUE(b.app->carriedEvents() >= 1U);
    // The server comes back: the earlier boot's events go up with THEIR boot id
    // first, and the first accepted beat reports how this boot ran.
    b.server.down = false;
    b.link.isUp = true;
    b.server.on(gatelogic::kPathHeartbeat, 200U, kRoster);
    b.run(180000U, 100U);
    const Call* beat = b.server.last(gatelogic::kPathHeartbeat);
    TEST_ASSERT_NOT_NULL(beat);
    bool sawOldBoot = false;
    for (const Call& c : b.server.calls) {
      sawOldBoot = sawOldBoot || (c.path == gatelogic::kPathEvents &&
                                  c.body.find("\"boot_id\":2953256193") != std::string::npos &&
                                  c.body.find("gate_open") != std::string::npos);
    }
    TEST_ASSERT_TRUE_MESSAGE(sawOldBoot, "the offline entry from before the cut is uploaded as that boot's");
    TEST_ASSERT_EQUAL_UINT16(0U, b.app->carriedEvents());
    bool sawCold = false;
    for (const Call& c : b.server.calls) {
      sawCold = sawCold || (c.path == gatelogic::kPathHeartbeat &&
                            c.body.find("\"restore\":\"cold\"") != std::string::npos);
    }
    TEST_ASSERT_TRUE(sawCold);
    TEST_ASSERT_NULL(b.app->restoreReport());
  }
}

/// A watchdog reset keeps the roster WITH ITS AGE (the RTC kept counting), the
/// member-code keys and the step clock: `restore: warm`.
void test_a_watchdog_reset_keeps_the_roster_with_its_age() {
  Board board;
  uint32_t ageBefore = 0U;
  {
    Boot b(board, true);
    b.server.on(gatelogic::kPathHeartbeat, 200U, kRoster);
    b.run(200U);
    b.server.down = true;
    b.run(40000U, 100U);
    ageBefore = b.roster.ageMs(board.clock.value());
    TEST_ASSERT_TRUE(ageBefore >= 39000U);
  }
  // The reset: millis() starts again from a new base; the RTC carries on.
  board.clock.setNow(77U);
  board.rtc.us += 900000ULL;
  Boot b(board, false, 0xB0071D03U);
  b.server.down = true;
  b.run(10U);
  TEST_ASSERT_EQUAL_STRING("warm", b.app->restoreReport());
  TEST_ASSERT_EQUAL_UINT8(1U, b.roster.size());
  const uint32_t ageAfter = b.roster.ageMs(board.clock.value());
  TEST_ASSERT_UINT32_WITHIN(1000U, ageBefore + 900U, ageAfter);
  b.scan("7Q3F9KM2XZ8B");
  TEST_ASSERT_TRUE(released(b));
}

/// A damaged record reads as absent, never as a roster.
void test_a_damaged_flash_record_reads_as_absent() {
  Board board;
  {
    Boot b(board, true);
    b.server.on(gatelogic::kPathHeartbeat, 200U, kRoster);
    b.run(200U);
  }
  std::string& rec = board.blobs.records[gatelogic::kRecRoster];
  TEST_ASSERT_TRUE(rec.size() > 40U);
  rec[30] = static_cast<char>(rec[30] ^ 0x5A);
  board.powerCut(1000U);
  Boot b(board, true);
  b.server.down = true;
  b.run(50U);
  TEST_ASSERT_EQUAL_STRING("none", b.app->restoreReport());
  TEST_ASSERT_FALSE(b.roster.everLoaded());
}

/// An aged roster re-sent unchanged is not a flash write (only its age is, every
/// ten minutes): the NVS would not last a season otherwise.
void test_an_unchanged_roster_is_not_rewritten_every_beat() {
  Board board;
  Boot b(board, true);
  b.server.on(gatelogic::kPathHeartbeat, 200U, kRoster);
  b.run(200U);
  const uint32_t before = board.blobs.writesTo[gatelogic::kRecRoster];
  // The same booking, fifteen seconds later, exactly as the server would send it.
  b.server.on(gatelogic::kPathHeartbeat, 200U,
              std::string(kRoster).replace(std::string(kRoster).find("-60|7200"), 8, "-75|7185"));
  b.beat();
  b.tick();
  TEST_ASSERT_EQUAL_size_t(2U, b.server.count(gatelogic::kPathHeartbeat));
  TEST_ASSERT_EQUAL_UINT32_MESSAGE(before, board.blobs.writesTo[gatelogic::kRecRoster],
                                   "an aged roster is not new content");
  // A real change is written at once.
  b.server.on(gatelogic::kPathHeartbeat, 200U,
              std::string(kRoster).replace(std::string(kRoster).find("7Q3F9KM2XZ8B"), 12, "K4TQ8N2ZV7BM"));
  b.beat();
  b.tick();
  TEST_ASSERT_EQUAL_UINT32(before + 1U, board.blobs.writesTo[gatelogic::kRecRoster]);
}

// =============================================================================
// DG-1b — key rotation
// =============================================================================

void test_a_key_rotation_is_adopted_persisted_and_survives_a_401() {
  Board board;
  {
    Boot b(board, true);
    b.server.acceptKeys = {kCompiledKey, kNewKey};
    b.server.on(gatelogic::kPathHeartbeat, 200U,
                withKey(kRoster, std::string("\"key_next\":{\"id\":\"k2\",\"key\":\"") + kNewKey + "\"}"));
    b.run(200U);
    b.server.on(gatelogic::kPathHeartbeat, 200U, kRoster);
    b.beat();
    TEST_ASSERT_EQUAL_STRING((std::string("Bearer ") + kNewKey).c_str(),
                             b.server.last(gatelogic::kPathHeartbeat)->auth.c_str());
    // The server is restored from a backup that only knows the compiled key: one
    // 401, one retry with the previous key, and both keys kept.
    b.server.acceptKeys = {kCompiledKey};
    b.beat();
    TEST_ASSERT_EQUAL_STRING((std::string("Bearer ") + kCompiledKey).c_str(),
                             b.server.last(gatelogic::kPathHeartbeat)->auth.c_str());
    TEST_ASSERT_EQUAL_UINT32(1U, b.api.keyRetries());
    TEST_ASSERT_TRUE(b.keys.ring().hasPrevious);
    // The key that worked is tried first next time: no second 401.
    b.beat();
    TEST_ASSERT_EQUAL_UINT32(1U, b.api.keyRetries());
  }
  // And across a power cut, the rotated ring is what the board holds.
  board.powerCut(1000U);
  Boot b(board, true);
  TEST_ASSERT_EQUAL_STRING("k2", b.keys.ring().currentId);
  TEST_ASSERT_EQUAL_STRING("k0", b.keys.ring().previousId);
}

// =============================================================================
// DG-1 / DG-3 — the network
// =============================================================================

void test_a_new_base_url_that_never_answers_is_abandoned_for_the_old_one() {
  Board board;
  Boot b(board, true);
  b.server.on(gatelogic::kPathHeartbeat, 200U,
              withKey(kRoster,
                      "\"net\":{\"ver\":4,\"base\":\"http://10.0.0.99:8088\",\"wifi0_ssid\":\"CRUSADERS\","
                      "\"wifi0_psk\":\"squash-court-4\"}"));
  b.run(200U);
  TEST_ASSERT_EQUAL_STRING("http://10.0.0.99:8088", b.net.baseUrl());
  TEST_ASSERT_EQUAL_UINT32(4U, b.net.version());
  // The typo'd address answers nothing; only the old one does.
  b.server.acceptBase = kBase;
  b.run(10U * 60000U + 5000U, 1000U);
  TEST_ASSERT_EQUAL_STRING(kBase, b.net.baseUrl());
  TEST_ASSERT_TRUE(reported(b, gatelogic::kFaultNetFallback));
  // And the same version is never re-adopted from the server that re-sends it.
  b.beat();
  TEST_ASSERT_EQUAL_STRING(kBase, b.net.baseUrl());
  TEST_ASSERT_NOT_NULL(strstr(b.server.last(gatelogic::kPathHeartbeat)->body.c_str(), "\"net_ver\":0"));
}

/// DG-3: Arduino-ESP32 stops reconnecting after AUTH_FAIL. 30 s down, the
/// supervisor joins the next profile; fifteen minutes down, it restarts the chip
/// — only when idle.
void test_the_link_supervisor_rejoins_and_finally_restarts() {
  Board board;
  Boot b(board, true);
  b.server.on(
      gatelogic::kPathHeartbeat, 200U,
      withKey(kRoster,
              "\"net\":{\"ver\":2,\"wifi0_ssid\":\"CRUSADERS-NEW\",\"wifi0_psk\":\"new-router-pass\"}"));
  b.run(200U);
  const size_t joinsAtStart = b.radio.joins.size();
  b.link.isUp = false;
  b.run(29000U, 500U);
  TEST_ASSERT_EQUAL_size_t(joinsAtStart, b.radio.joins.size());
  b.run(2000U, 500U);
  TEST_ASSERT_EQUAL_size_t(joinsAtStart + 1U, b.radio.joins.size());
  TEST_ASSERT_EQUAL_UINT32(0U, b.chip.restarts);
  b.run(15U * 60000U, 1000U);
  TEST_ASSERT_TRUE(b.radio.joins.size() >= joinsAtStart + 4U);
  TEST_ASSERT_EQUAL_UINT32_MESSAGE(1U, b.chip.restarts, "fifteen minutes down restarts the chip, once");
  // The profiles are tried new first, then the compiled default.
  bool sawCompiled = false;
  for (const std::string& j : b.radio.joins) {
    sawCompiled = sawCompiled || j == "CRUSADERS/compiled-pass";
  }
  TEST_ASSERT_TRUE(sawCompiled);
}

/// The setup portal: the BOOT button held five seconds within a minute of boot
/// opens it; a valid form saves a `local` network and restarts.
void test_the_setup_portal_saves_a_local_network() {
  Board board;
  {
    Boot b(board, true);
    b.run(2000U);
    b.button.down = true;
    b.run(5100U, 100U);
    TEST_ASSERT_TRUE(b.portal.isOpen);
    TEST_ASSERT_EQUAL_STRING("CRUSADERS-SETUP-1B2C", b.portal.name.c_str());
    TEST_ASSERT_TRUE(b.app->setupOpen());
    b.button.down = false;
    // A bad base URL is refused with the corpus reason, and the page stays.
    b.portal.form.ssid = "CLUB-NEW";
    b.portal.form.psk = "a-new-password";
    b.portal.form.base = "https://10.0.0.5";
    b.portal.submitted = true;
    b.tick();
    TEST_ASSERT_EQUAL_STRING("base_https", b.portal.refused.c_str());
    TEST_ASSERT_EQUAL_UINT32(0U, b.chip.restarts);
    b.portal.form.base = "http://10.0.0.5:8088";
    b.portal.submitted = true;
    b.tick();
    TEST_ASSERT_TRUE(b.portal.accepted);
    TEST_ASSERT_EQUAL_UINT32(1U, b.chip.restarts);
  }
  Boot b(board, false);
  TEST_ASSERT_EQUAL_STRING("http://10.0.0.5:8088", b.net.baseUrl());
  TEST_ASSERT_TRUE(b.net.source() == gatelogic::NetSource::Local);
  TEST_ASSERT_EQUAL_STRING("CLUB-NEW/a-new-password", b.radio.joins.front().c_str());
  b.server.on(gatelogic::kPathHeartbeat, 200U, kRoster);
  b.run(100U);
  TEST_ASSERT_NOT_NULL(
      strstr(b.server.last(gatelogic::kPathHeartbeat)->body.c_str(), "\"net_src\":\"local\""));
}

/// A hold that starts after the first minute never opens the portal.
void test_a_late_hold_does_not_open_the_portal() {
  Board board;
  Boot b(board, true);
  b.run(61000U, 1000U);
  b.button.down = true;
  b.run(6000U, 100U);
  TEST_ASSERT_FALSE(b.portal.isOpen);
}

// =============================================================================
// The analysis's door checks
// =============================================================================

/// DG-4: the lamp is lit straight to the pin before the blocking `/gate` call.
void test_the_lamp_says_scan_seen_before_the_server_answers() {
  Board board;
  Boot b(board, true);
  b.server.on(gatelogic::kPathHeartbeat, 200U, kRoster);
  b.run(200U);
  b.scan("UNKNOWNTOKEN2");
  const Call* scan = b.server.last(gatelogic::kPathGate);
  TEST_ASSERT_NOT_NULL(scan);
  TEST_ASSERT_TRUE_MESSAGE(scan->ledOn, "1.1.2 left the lamp dark for the whole call");
}

/// DG-5: a stray byte, then a member's scan, is the member's scan; and a
/// scanner with no CR/LF suffix still works.
void test_a_stray_byte_never_spoils_the_next_scan_and_a_suffixless_line_is_read() {
  Board board;
  Boot b(board, true);
  b.server.on(gatelogic::kPathHeartbeat, 200U, kRoster);
  b.run(200U);
  b.scanner.feedByte(0xFFU);
  b.run(300U);
  b.scan("7Q3F9KM2XZ8B");
  TEST_ASSERT_NOT_NULL(b.server.last(gatelogic::kPathGate));
  TEST_ASSERT_TRUE(b.server.last(gatelogic::kPathGate)->body.find("\"token\":\"7Q3F9KM2XZ8B\"") !=
                   std::string::npos);
  const size_t before = b.server.count(gatelogic::kPathGate);
  b.run(3000U);
  b.scanner.feed("K4TQ8N2ZV7BM");
  b.run(300U);
  TEST_ASSERT_EQUAL_size_t(before + 1U, b.server.count(gatelogic::kPathGate));
  TEST_ASSERT_TRUE(b.server.last(gatelogic::kPathGate)->body.find("K4TQ8N2ZV7BM") != std::string::npos);
}

/// DG-6: a door whose heartbeats are all refused (a rotated key it never got)
/// shows the degraded blip; a healthy one stays dark.
void test_a_refused_heartbeat_shows_the_degraded_blip() {
  Board board;
  Boot b(board, true);
  b.server.on(gatelogic::kPathHeartbeat, 200U, kRoster);
  b.run(200U);
  TEST_ASSERT_FALSE(b.app->degraded());
  b.server.acceptKeys = {"some-other-key"};
  b.beat();
  TEST_ASSERT_TRUE(b.app->degraded());
  bool lit = false;
  for (int i = 0; i < 600; ++i) {
    b.tick();
    lit = lit || b.ledPin.level == hal::PinLevel::kHigh;
  }
  TEST_ASSERT_TRUE_MESSAGE(lit, "the blip shows within one five-second period");
}

/// DG-8: inside the post-watchdog hold-back a scan is decided from the roster,
/// never online, so it cannot reach the dribbling peer that reset the board.
void test_a_scan_inside_the_watchdog_hold_back_stays_offline() {
  Board board;
  {
    Boot b(board, true);
    b.server.on(gatelogic::kPathHeartbeat, 200U, kRoster);
    b.run(200U);
  }
  board.rtc.us += 20000000ULL;
  board.clock.setNow(50U);
  // Reset by its watchdog twice in a row: the first call is held back 2 s.
  Boot b(board, false, 0xB0071D05U, 2U);
  TEST_ASSERT_EQUAL_UINT32(2000U, b.app->firstCallHeldBackMs());
  b.tick();
  b.scan("7Q3F9KM2XZ8B");
  TEST_ASSERT_EQUAL_size_t_MESSAGE(0U, b.server.count(gatelogic::kPathGate), "1.1.2 asked the server here");
  TEST_ASSERT_TRUE_MESSAGE(released(b), "and the warm roster still admits the booking");
}

/// DG-9: a heartbeat answer for a court box adopts nothing and files the fault.
void test_a_court_box_answer_is_refused_as_kind_mismatch() {
  Board board;
  Boot b(board, true);
  std::string body(kRoster);
  body.replace(body.find("\"kind\":\"gate\""), 13, "\"kind\":\"court_box\"");
  b.server.on(gatelogic::kPathHeartbeat, 200U, body);
  b.run(200U);
  TEST_ASSERT_FALSE(b.roster.everLoaded());
  TEST_ASSERT_TRUE(reported(b, gatelogic::kFaultKindMismatch));
}

/// FC-12: `gate.lamp.unlock_seconds` never drives the lock.
void test_a_nested_unlock_seconds_never_drives_the_lock() {
  Board board;
  Boot b(board, true);
  std::string body(kRoster);
  body.replace(body.find("\"gate\":{"), 8, "\"gate\":{\"lamp\":{\"unlock_seconds\":30},");
  b.server.on(gatelogic::kPathHeartbeat, 200U, body);
  b.run(200U);
  TEST_ASSERT_EQUAL_UINT32(5000U, b.app->unlockMs());
}

/// FC-6: a 200-byte scan decision is read, not turned into an outage.
void test_a_long_scan_decision_is_read() {
  Board board;
  Boot b(board, true);
  b.server.on(gatelogic::kPathHeartbeat, 200U, kRoster);
  std::string reply = "{\"opened\":true,\"reason\":\"ok\",\"unlock_seconds\":4,\"note\":\"";
  reply += std::string(200U - reply.size() - 2U, 'x');
  reply += "\"}";
  TEST_ASSERT_EQUAL_size_t(200U, reply.size());
  b.server.on(gatelogic::kPathGate, 200U, reply);
  b.run(200U);
  b.scan("UNKNOWNTOKEN3");
  TEST_ASSERT_TRUE(released(b));
  TEST_ASSERT_FALSE(b.breaker.open(board.clock.value()));
}

/// HW-8: the link is up and nothing has been accepted for six hours: restart
/// when idle.
void test_the_stall_watchdog_restarts_an_idle_board_after_six_hours() {
  Board board;
  Boot b(board, true);
  b.server.on(gatelogic::kPathHeartbeat, 200U, kRoster);
  b.run(200U);
  b.server.on(gatelogic::kPathHeartbeat, 500U, "");
  b.run(6U * 3600000U - 120000U, 60000U);
  TEST_ASSERT_EQUAL_UINT32(0U, b.chip.restarts);
  b.run(240000U, 1000U);
  TEST_ASSERT_EQUAL_UINT32(1U, b.chip.restarts);
}

/// MCV1-10 (the gate's half): a replay refused locally while ONLINE is uploaded
/// as `replayed` with the link state as it was, not as an offline refusal.
void test_an_online_replay_is_uploaded_as_replayed() {
  uint8_t key[memcode::kDayKeyBytes];
  for (uint8_t i = 0U; i < memcode::kDayKeyBytes; ++i) {
    key[i] = static_cast<uint8_t>(0x40U + i);
  }
  char key64[dc::b64url::encodedLen(memcode::kDayKeyBytes) + 1U] = {};
  TEST_ASSERT_TRUE(dc::b64url::encode(key, sizeof(key), key64, sizeof(key64)));
  char body[400] = {};
  snprintf(body, sizeof(body),
           "{\"kind\":\"gate\",\"gate\":{\"unlock_seconds\":3},\"roster\":[\"m000118Y9|0|0|86399\"],"
           "\"code_step\":1000,\"code_step_ms\":0,\"code_days\":[\"900|3900\"],\"code_keys\":[\"18Y90%s\"]}",
           key64);
  Board board;
  Boot b(board, true);
  b.server.on(gatelogic::kPathHeartbeat, 200U, body);
  b.run(200U);
  // Offline: the code opens the door from the roster's REF list.
  b.link.isUp = false;
  b.tick();
  const uint32_t step = b.app->stepClock().stepAt(board.clock.value());
  char token[memcode::kTokenLen + 2U] = {};
  TEST_ASSERT_TRUE(memcode::format(0x0A3C9U, 12345678U, memcode::offCode(key, step), token, sizeof(token)));
  b.scan(token);
  TEST_ASSERT_TRUE(released(b));
  b.run(6000U);
  // The link returns; the same code inside its window is refused HERE, online.
  b.link.isUp = true;
  b.server.down = true;
  b.tick();
  b.scan(token);
  TEST_ASSERT_FALSE(released(b));
  TEST_ASSERT_EQUAL_STRING(gatelogic::kReasonReplayed, b.log.reasons.back().c_str());
  b.server.down = false;
  b.run(180000U, 100U);
  bool tagged = false;
  for (const Call& c : b.server.calls) {
    tagged =
        tagged || (c.path == gatelogic::kPathEvents && c.body.find("\"unknown_scan\"") != std::string::npos &&
                   c.body.find("\"cause\":\"replayed\",\"online\":true}") != std::string::npos &&
                   c.body.find("\"reason\"") == std::string::npos);
  }
  TEST_ASSERT_TRUE_MESSAGE(tagged, "1.1.2 uploaded this as an untagged offline unknown_scan");
}

/// The 2.0.0 request: net, diag and caps on every beat, drift after
/// an answer the board could not fully read.
void test_the_heartbeat_reports_telemetry_and_drift() {
  Board board;
  Boot b(board, true);
  std::string body(kRoster);
  body.replace(body.find("\"unlock_seconds\":5"), 18, "\"unlock_seconds\":5.5");
  b.server.on(gatelogic::kPathHeartbeat, 200U, body);
  b.run(200U);
  b.beat();
  const std::string& sent = b.server.last(gatelogic::kPathHeartbeat)->body;
  TEST_ASSERT_TRUE(sent.find("\"kind\":\"gate\",\"net_ver\":0,\"net_src\":\"compiled\"") !=
                   std::string::npos);
  TEST_ASSERT_TRUE(sent.find("\"diag\":{\"reset\":\"task_wdt\",\"exc\":0,\"epc1\":0,\"heap\":151552") !=
                   std::string::npos);
  TEST_ASSERT_TRUE(sent.find("\"drift\":[\"gate.unlock_seconds\"]") != std::string::npos);
  TEST_ASSERT_TRUE(sent.find("\"caps\":[\"codes:m1\",\"key:1\",\"net:1\"]}") != std::string::npos);
  TEST_ASSERT_TRUE(sent.size() * 5U <= gatelogic::kGateHeartbeatRequestCap * 4U);
}

} // namespace

void setUp() {
}

void tearDown() {
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_power_cut_with_the_server_down_admits_inside_the_trust_window_only);
  RUN_TEST(test_a_watchdog_reset_keeps_the_roster_with_its_age);
  RUN_TEST(test_a_damaged_flash_record_reads_as_absent);
  RUN_TEST(test_an_unchanged_roster_is_not_rewritten_every_beat);
  RUN_TEST(test_a_key_rotation_is_adopted_persisted_and_survives_a_401);
  RUN_TEST(test_a_new_base_url_that_never_answers_is_abandoned_for_the_old_one);
  RUN_TEST(test_the_link_supervisor_rejoins_and_finally_restarts);
  RUN_TEST(test_the_setup_portal_saves_a_local_network);
  RUN_TEST(test_a_late_hold_does_not_open_the_portal);
  RUN_TEST(test_the_lamp_says_scan_seen_before_the_server_answers);
  RUN_TEST(test_a_stray_byte_never_spoils_the_next_scan_and_a_suffixless_line_is_read);
  RUN_TEST(test_a_refused_heartbeat_shows_the_degraded_blip);
  RUN_TEST(test_a_scan_inside_the_watchdog_hold_back_stays_offline);
  RUN_TEST(test_a_court_box_answer_is_refused_as_kind_mismatch);
  RUN_TEST(test_a_nested_unlock_seconds_never_drives_the_lock);
  RUN_TEST(test_a_long_scan_decision_is_read);
  RUN_TEST(test_the_stall_watchdog_restarts_an_idle_board_after_six_hours);
  RUN_TEST(test_an_online_replay_is_uploaded_as_replayed);
  RUN_TEST(test_the_heartbeat_reports_telemetry_and_drift);
  return UNITY_END();
}

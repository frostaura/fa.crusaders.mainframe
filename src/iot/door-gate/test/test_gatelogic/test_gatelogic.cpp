// Unity tests for lib/gatelogic — every decision the door gate makes, with no
// board attached.
//
// WHAT THIS SUITE IS FOR
// ----------------------
// A door is a safety surface in two directions at once. It must not open for
// somebody the club has barred, and it must not fail to open for somebody with
// a booking standing in a car park at night — and the second failure is the one
// nobody will report, because they will simply stop coming. Every branch below
// is one of those two.
//
// Four properties are safety-critical and are mutation-proved rather than
// merely covered — each has a test whose name says so:
//
//   * the lock is asserted LOCKED before its pin is ever an output
//   * a 200 refusal is NEVER second-guessed against the roster
//   * a roster past its maximum age admits nobody
//   * a re-arm never shortens the release window, and no sequence of re-arms
//     can hold the door open past the hard cap
//
// THE CLOCK BASES
// ---------------
// The same matrix the court box's suites use. millis() wraps at 49.7 days and a
// gate in an electrical cupboard is expected to run for months, so the wrap is
// the normal case: every deadline, age and debounce assertion is run at a base
// chosen to put the wrap inside the scenario.

#include <stdint.h>
#include <string.h>
#include <unity.h>

#include "hal/PinLevel.h"

#include "devlink/ApiBreaker.h"
#include "devlink/RosterSync.h"
#include "eventq/Event.h"
#include "fakes/FakeClock.h"
#include "fakes/FakeStore.h"
#include "gatelogic/ApiBaseUrl.h"
#include "gatelogic/GateApi.h"
#include "gatelogic/GateApp.h"
#include "gatelogic/GateConfig.h"
#include "gatelogic/GateFlow.h"
#include "gatelogic/GateHeartbeat.h"
#include "gatelogic/GatePorts.h"
#include "gatelogic/HttpPort.h"
#include "gatelogic/LedPattern.h"
#include "gatelogic/LockDriver.h"
#include "gatelogic/ScanAssembler.h"
#include "gatelogic/ScanDebounce.h"
#include "gatelogic/StaticText.h"
#include "gatelogic/UnlockTimer.h"
#include "roster/Roster.h"

namespace {

constexpr uint32_t kBaseZero = 0U;
constexpr uint32_t kBaseMid = 1234567U;
constexpr uint32_t kBaseWrapSoon = 0xFFFFF000U;
constexpr uint32_t kBaseWrapNow = 0xFFFFFFFFU;

constexpr uint32_t kBases[] = {kBaseZero, kBaseMid, kBaseWrapSoon, kBaseWrapNow};
constexpr size_t kBaseCount = sizeof(kBases) / sizeof(kBases[0]);

constexpr uint32_t kCapMs = gatelogic::kGateConfig.unlockHardCapMs;
constexpr uint32_t kDefaultMs = gatelogic::kGateConfig.unlockDefaultMs;

using Cache = roster::Roster<gatelogic::kGateRosterEntries>;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/// Records what was done to a pin AND IN WHAT ORDER.
///
/// The order is the point. `pinMode(OUTPUT)` before the first `digitalWrite`
/// drives whatever is already in the output register — LOW on a cold boot — so
/// on a board wired the way Carl's is, that ordering is a door that clicks open
/// on every reset. A fake that only remembered the final level would call that
/// correct.
class FakePinOut final : public gatelogic::IPinOut {
public:
  static constexpr size_t kMaxOps = 16U;

  enum class Op : uint8_t { WriteLow = 0U, WriteHigh = 1U, DriveOutput = 2U };

  void write(hal::PinLevel level) override {
    level_ = level;
    record(level == hal::PinLevel::kHigh ? Op::WriteHigh : Op::WriteLow);
  }

  void driveOutput() override {
    driving_ = true;
    record(Op::DriveOutput);
  }

  hal::PinLevel readBack() const override { return level_; }

  size_t opCount() const { return ops_; }

  Op op(size_t i) const { return log_[i]; }

  bool driving() const { return driving_; }

private:
  void record(Op op) {
    if (ops_ < kMaxOps) {
      log_[ops_] = op;
      ++ops_;
    }
  }

  Op log_[kMaxOps] = {};
  size_t ops_ = 0U;
  hal::PinLevel level_ = hal::PinLevel::kLow;
  bool driving_ = false;
};

/// An IHttpPort that answers whatever a test told it to, and remembers what it
/// was asked.
class FakeHttp final : public gatelogic::IHttpPort {
public:
  void answer(uint16_t status, const char* body) {
    status_ = status;
    answer_[0] = '\0';
    if (body != nullptr) {
      strncpy(answer_, body, sizeof(answer_) - 1U);
      answer_[sizeof(answer_) - 1U] = '\0';
    }
  }

  uint16_t post(const char* path, const char* body, char* out, size_t outCap) override {
    ++calls_;
    strncpy(path_, path, sizeof(path_) - 1U);
    path_[sizeof(path_) - 1U] = '\0';
    strncpy(body_, body, sizeof(body_) - 1U);
    body_[sizeof(body_) - 1U] = '\0';
    if (out != nullptr && outCap > 0U) {
      strncpy(out, answer_, outCap - 1U);
      out[outCap - 1U] = '\0';
    }
    return status_;
  }

  const char* lastPath() const { return path_; }

  const char* lastBody() const { return body_; }

  uint16_t calls() const { return calls_; }

private:
  char path_[64] = {};
  char body_[256] = {};
  char answer_[256] = {};
  uint16_t status_ = 0U;
  uint16_t calls_ = 0U;
};

roster::Entry booking(const char* token, uint32_t opensAt, uint32_t closesAt) {
  roster::Entry entry;
  static_cast<void>(roster::detail::copyToken(entry.token, sizeof(entry.token), token));
  // Relay 0 always, on a gate: the contract's roster carries 0 in the relay
  // field for every entry because a door is not on a court.
  entry.court = 0U;
  entry.opensAtMs = opensAt;
  entry.closesAtMs = closesAt;
  entry.durationMs = closesAt - opensAt;
  return entry;
}

void loadRoster(Cache& cache, uint32_t nowMs, const roster::Entry* entries, uint8_t count) {
  cache.beginReplace(nowMs);
  for (uint8_t i = 0U; i < count; ++i) {
    static_cast<void>(cache.add(entries[i]));
  }
  cache.commitReplace();
}

/// Feed a whole line into the assembler and return what the terminator produced.
gatelogic::ScanEvent feedLine(gatelogic::ScanAssembler& assembler, const char* text) {
  gatelogic::ScanEvent last = gatelogic::ScanEvent::None;
  for (size_t i = 0U; text[i] != '\0'; ++i) {
    last = assembler.feed(static_cast<uint8_t>(text[i]));
  }
  return last;
}

// ---------------------------------------------------------------------------
// GateConfig — the wiring table
// ---------------------------------------------------------------------------

/// The defaults in the header are CARL'S WIRING, so a host test and an editor
/// see the door that actually exists rather than zeroes. platformio.ini sets
/// the same values explicitly; this is what makes the two provably the same.
void test_config_defaults_are_carls_wiring() {
  TEST_ASSERT_EQUAL_UINT8(4U, gatelogic::kGateConfig.scannerRxPin);
  TEST_ASSERT_EQUAL_UINT8(17U, gatelogic::kGateConfig.scannerTxPin);
  TEST_ASSERT_EQUAL_UINT32(9600UL, gatelogic::kGateConfig.scannerBaud);
  TEST_ASSERT_EQUAL_UINT8(26U, gatelogic::kGateConfig.relayPin);
  TEST_ASSERT_EQUAL_UINT8(27U, gatelogic::kGateConfig.ledPin);
  TEST_ASSERT_TRUE(gatelogic::kGateConfig.relayActiveHigh);
  TEST_ASSERT_TRUE(gatelogic::kGateConfig.unlockEnergisesRelay);
  TEST_ASSERT_EQUAL_UINT32(3000UL, gatelogic::kGateConfig.unlockDefaultMs);
  TEST_ASSERT_EQUAL_UINT32(30000UL, gatelogic::kGateConfig.unlockHardCapMs);
}

/// The scanner refuses what the roster could never match, and the roster holds
/// what the scanner can produce. The static_assert in GateConfig.h is the real
/// gate; this says the same thing where a reader will see it.
void test_config_token_cap_matches_the_roster() {
  TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(roster::kMaxTokenLen), gatelogic::kGateConfig.maxTokenLen);
  TEST_ASSERT_EQUAL_UINT8(48U, gatelogic::kGateRosterEntries);
}

// ---------------------------------------------------------------------------
// LockDriver — the two polarity questions
// ---------------------------------------------------------------------------

/// All four wiring combinations, both lock states. This table IS the README's
/// truth table; if they ever disagree the README is the one that is wrong.
void test_lock_level_for_all_four_polarity_combinations() {
  struct Row {
    bool activeHigh;
    bool unlockEnergises;
    hal::PinLevel released;
    hal::PinLevel locked;
  };

  constexpr Row rows[] = {
      {true, true, hal::PinLevel::kHigh, hal::PinLevel::kLow},
      {true, false, hal::PinLevel::kLow, hal::PinLevel::kHigh},
      {false, true, hal::PinLevel::kLow, hal::PinLevel::kHigh},
      {false, false, hal::PinLevel::kHigh, hal::PinLevel::kLow},
  };

  for (const Row& row : rows) {
    TEST_ASSERT_TRUE(gatelogic::lockPinLevel(true, row.activeHigh, row.unlockEnergises) == row.released);
    TEST_ASSERT_TRUE(gatelogic::lockPinLevel(false, row.activeHigh, row.unlockEnergises) == row.locked);
    // The two states are never the same level. A composition that collapsed
    // them would be a relay that never moves.
    TEST_ASSERT_TRUE(row.released != row.locked);
  }
}

/// MUTATION-PROVED. Swap the two lines in LockDriver::begin() and this is the
/// test that goes red: the level must be in the output register BEFORE the pin
/// starts driving it, or every boot — including a watchdog reset at 3am —
/// pulses the door open for as long as it takes to reach the next line.
void test_lock_boot_writes_the_locked_level_before_the_pin_drives_anything() {
  for (int a = 0; a < 2; ++a) {
    for (int u = 0; u < 2; ++u) {
      const bool activeHigh = a != 0;
      const bool unlockEnergises = u != 0;

      FakePinOut pin;
      gatelogic::LockDriver lock(pin, activeHigh, unlockEnergises);
      lock.begin();

      TEST_ASSERT_EQUAL_size_t(2U, pin.opCount());
      const FakePinOut::Op first = pin.op(0U);
      TEST_ASSERT_TRUE_MESSAGE(first == FakePinOut::Op::WriteLow || first == FakePinOut::Op::WriteHigh,
                               "the level must be written before the pin is an output");
      TEST_ASSERT_TRUE(pin.op(1U) == FakePinOut::Op::DriveOutput);

      // And the level written first is the LOCKED one for this wiring.
      TEST_ASSERT_TRUE(pin.readBack() == gatelogic::lockPinLevel(false, activeHigh, unlockEnergises));
      TEST_ASSERT_FALSE(lock.released());
    }
  }
}

void test_lock_set_drives_the_level_its_wiring_calls_for() {
  FakePinOut pin;
  // Active-LOW module, lock through the normally-closed contact: the
  // combination where an energised coil HOLDS the door shut.
  gatelogic::LockDriver lock(pin, false, false);
  lock.begin();
  TEST_ASSERT_TRUE(pin.readBack() == hal::PinLevel::kLow);

  lock.set(true);
  TEST_ASSERT_TRUE(lock.released());
  TEST_ASSERT_TRUE(pin.readBack() == hal::PinLevel::kHigh);

  lock.set(false);
  TEST_ASSERT_FALSE(lock.released());
  TEST_ASSERT_TRUE(pin.readBack() == hal::PinLevel::kLow);
}

// ---------------------------------------------------------------------------
// UnlockTimer — the release window and its two bounds
// ---------------------------------------------------------------------------

void test_unlock_opens_once_and_closes_once_at_every_clock_base() {
  for (size_t b = 0U; b < kBaseCount; ++b) {
    const uint32_t base = kBases[b];
    gatelogic::UnlockTimer timer(kCapMs);

    TEST_ASSERT_TRUE_MESSAGE(timer.request(base, 3000U), "the first request is the opening edge");
    TEST_ASSERT_TRUE(timer.released());
    TEST_ASSERT_FALSE(timer.tick(base + 2999U));
    TEST_ASSERT_TRUE(timer.released());

    TEST_ASSERT_TRUE_MESSAGE(timer.tick(base + 3000U), "the deadline is the closing edge");
    TEST_ASSERT_FALSE(timer.released());
    // Exactly once. A second edge would queue a second event and write the
    // relay again for a door that is already shut.
    TEST_ASSERT_FALSE(timer.tick(base + 3001U));
  }
}

/// MUTATION-PROVED. Make request() re-arm unconditionally and this goes red: a
/// second member scanning 2.9 s into a 3 s window would cut the first member's
/// window to 3 s from now — fine — but a member scanning with 100 ms left and a
/// 1 s grant would SHORTEN nothing, while a shorter grant on a longer window
/// would close the door on somebody already walking through it.
void test_unlock_a_re_arm_never_shortens_the_window() {
  for (size_t b = 0U; b < kBaseCount; ++b) {
    const uint32_t base = kBases[b];
    gatelogic::UnlockTimer timer(kCapMs);

    static_cast<void>(timer.request(base, 10000U));
    // A shorter grant, one second in. 9 s are left; a 1 s grant must not win.
    TEST_ASSERT_FALSE_MESSAGE(timer.request(base + 1000U, 1000U), "a re-arm is not an opening edge");
    TEST_ASSERT_EQUAL_UINT32(9000U, timer.remainingMs(base + 1000U));
    TEST_ASSERT_FALSE(timer.tick(base + 9999U));
    TEST_ASSERT_TRUE(timer.tick(base + 10000U));

    // A LONGER grant does extend.
    gatelogic::UnlockTimer other(kCapMs);
    static_cast<void>(other.request(base, 3000U));
    TEST_ASSERT_FALSE(other.request(base + 1000U, 5000U));
    TEST_ASSERT_EQUAL_UINT32(5000U, other.remainingMs(base + 1000U));
  }
}

/// MUTATION-PROVED, and the reason the cap is TWO bounds rather than one.
///
/// Per request: no single answer can ask for more than the cap. And per
/// WINDOW: no sequence of re-arms can hold the door open past the cap measured
/// from the moment it first opened. Delete the second bound and a scanner left
/// pointing at a printed code holds the door open all night, with every single
/// request inside the rules.
void test_unlock_the_hard_cap_bounds_both_one_answer_and_the_whole_window() {
  for (size_t b = 0U; b < kBaseCount; ++b) {
    const uint32_t base = kBases[b];

    gatelogic::UnlockTimer single(kCapMs);
    static_cast<void>(single.request(base, 600000U)); // ten minutes, asked for once
    TEST_ASSERT_EQUAL_UINT32(kCapMs, single.remainingMs(base));
    TEST_ASSERT_TRUE(single.tick(base + kCapMs));

    gatelogic::UnlockTimer repeated(kCapMs);
    static_cast<void>(repeated.request(base, 3000U));
    // Somebody scanning every two seconds, forever.
    for (uint32_t t = 2000U; t <= 120000U; t += 2000U) {
      if (repeated.tick(base + t)) {
        break;
      }
      static_cast<void>(repeated.request(base + t, 3000U));
    }
    TEST_ASSERT_FALSE_MESSAGE(repeated.released(),
                              "no sequence of re-arms may hold the door past the hard cap");
    // And it closed no later than the cap.
    TEST_ASSERT_EQUAL_UINT32(0U, repeated.remainingMs(base + kCapMs));
  }
}

void test_unlock_reports_how_long_it_has_been_released() {
  gatelogic::UnlockTimer timer(kCapMs);
  static_cast<void>(timer.request(kBaseWrapSoon, 3000U));
  TEST_ASSERT_EQUAL_UINT32(0U, timer.releasedForMs(kBaseWrapSoon));
  // Across the wrap: 0xFFFFF000 + 0x2000 has wrapped to 0x1000.
  TEST_ASSERT_EQUAL_UINT32(0x2000U, timer.releasedForMs(kBaseWrapSoon + 0x2000U));
  static_cast<void>(timer.tick(kBaseWrapSoon + 3000U));
  TEST_ASSERT_EQUAL_UINT32(0U, timer.releasedForMs(kBaseWrapSoon + 4000U));
}

// ---------------------------------------------------------------------------
// ScanAssembler — bytes into one token, or into nothing
// ---------------------------------------------------------------------------

void test_scan_assembles_a_line_and_treats_crlf_as_one_terminator() {
  gatelogic::ScanAssembler assembler;
  TEST_ASSERT_TRUE(feedLine(assembler, "7Q3F9KM2XZ8B\r") == gatelogic::ScanEvent::Token);
  TEST_ASSERT_EQUAL_STRING("7Q3F9KM2XZ8B", assembler.token());
  // The \n of a CRLF ends an empty line, which is ignored — not a second scan.
  TEST_ASSERT_TRUE(assembler.feed(static_cast<uint8_t>('\n')) == gatelogic::ScanEvent::None);
}

void test_scan_trims_and_ignores_an_empty_line() {
  gatelogic::ScanAssembler assembler;
  TEST_ASSERT_TRUE(feedLine(assembler, "  K4TQ8N2ZV7BM \t\n") == gatelogic::ScanEvent::Token);
  TEST_ASSERT_EQUAL_STRING("K4TQ8N2ZV7BM", assembler.token());

  TEST_ASSERT_TRUE(feedLine(assembler, "\n") == gatelogic::ScanEvent::None);
  TEST_ASSERT_TRUE(feedLine(assembler, "   \t \r") == gatelogic::ScanEvent::None);
}

/// Twenty characters is the cap and is accepted; twenty-one is REFUSED, not
/// truncated. A token cut to twenty is a different token, and a different token
/// can match a different member — which is a door opening for the wrong person
/// rather than for nobody.
void test_scan_refuses_a_token_one_character_over_the_cap_without_truncating() {
  gatelogic::ScanAssembler assembler;

  char exact[roster::kMaxTokenLen + 2U] = {};
  for (size_t i = 0U; i < roster::kMaxTokenLen; ++i) {
    exact[i] = 'A';
  }
  exact[roster::kMaxTokenLen] = '\n';
  TEST_ASSERT_TRUE(feedLine(assembler, exact) == gatelogic::ScanEvent::Token);
  TEST_ASSERT_EQUAL_size_t(roster::kMaxTokenLen, strlen(assembler.token()));

  char over[roster::kMaxTokenLen + 3U] = {};
  for (size_t i = 0U; i < roster::kMaxTokenLen + 1U; ++i) {
    over[i] = 'B';
  }
  over[roster::kMaxTokenLen + 1U] = '\n';
  TEST_ASSERT_TRUE(feedLine(assembler, over) == gatelogic::ScanEvent::Refused);

  // The rest of the over-long line is discarded with it: the next scan is clean
  // rather than starting mid-way through the one that was refused.
  TEST_ASSERT_TRUE(feedLine(assembler, "GOODTOKEN\n") == gatelogic::ScanEvent::Token);
  TEST_ASSERT_EQUAL_STRING("GOODTOKEN", assembler.token());
}

/// 9600 baud over jumper wire beside a switching relay coil inserts bytes
/// nobody typed. Carrying on with the rest of the line would present the server
/// with a token that is neither what was scanned nor anything it knows.
void test_scan_a_non_printable_byte_discards_the_whole_line() {
  gatelogic::ScanAssembler assembler;

  TEST_ASSERT_TRUE(feedLine(assembler, "GOOD") == gatelogic::ScanEvent::None);
  TEST_ASSERT_TRUE(assembler.feed(0x00U) == gatelogic::ScanEvent::None);
  TEST_ASSERT_TRUE(feedLine(assembler, "TOKEN\n") == gatelogic::ScanEvent::None);

  // And the next line is unaffected.
  TEST_ASSERT_TRUE(feedLine(assembler, "CLEAN1\n") == gatelogic::ScanEvent::Token);
  TEST_ASSERT_EQUAL_STRING("CLEAN1", assembler.token());

  // A high byte from a framing error costs the line too.
  TEST_ASSERT_TRUE(feedLine(assembler, "AB") == gatelogic::ScanEvent::None);
  TEST_ASSERT_TRUE(assembler.feed(0xFEU) == gatelogic::ScanEvent::None);
  TEST_ASSERT_TRUE(feedLine(assembler, "CD\n") == gatelogic::ScanEvent::None);
}

void test_scan_reset_discards_a_partial_line() {
  gatelogic::ScanAssembler assembler;
  TEST_ASSERT_TRUE(feedLine(assembler, "HALF") == gatelogic::ScanEvent::None);
  assembler.reset();
  TEST_ASSERT_TRUE(feedLine(assembler, "WHOLE\n") == gatelogic::ScanEvent::Token);
  TEST_ASSERT_EQUAL_STRING("WHOLE", assembler.token());
}

// ---------------------------------------------------------------------------
// ScanDebounce — the same phone, held at the window
// ---------------------------------------------------------------------------

void test_debounce_suppresses_the_same_token_inside_the_window_and_not_outside_it() {
  for (size_t b = 0U; b < kBaseCount; ++b) {
    const uint32_t base = kBases[b];
    gatelogic::ScanDebounce debounce;

    TEST_ASSERT_FALSE(debounce.suppresses("TOKEN1", base));
    debounce.decided("TOKEN1", base);

    TEST_ASSERT_TRUE(debounce.suppresses("TOKEN1", base));
    TEST_ASSERT_TRUE_MESSAGE(debounce.suppresses("TOKEN1", base + 1999U), "1999 ms is inside the window");
    TEST_ASSERT_FALSE_MESSAGE(debounce.suppresses("TOKEN1", base + 2000U), "2000 ms is the boundary");
    TEST_ASSERT_FALSE(debounce.suppresses("TOKEN1", base + 2001U));
  }
}

/// A different token is never suppressed. Two members arriving together are two
/// decisions, and making the second wait is a door that refuses the person
/// standing behind the person it just let in.
void test_debounce_never_suppresses_a_different_token() {
  gatelogic::ScanDebounce debounce;
  debounce.decided("TOKEN1", kBaseMid);
  TEST_ASSERT_FALSE(debounce.suppresses("TOKEN2", kBaseMid));
  // Including one that is a prefix of the remembered one, which a length-blind
  // comparison would collapse.
  TEST_ASSERT_FALSE(debounce.suppresses("TOKEN", kBaseMid));
  TEST_ASSERT_FALSE(debounce.suppresses("TOKEN12", kBaseMid));
}

/// The window runs from the DECISION, not from the scan. A scan that spent four
/// seconds in a connect timeout has already used two of them.
void test_debounce_measures_from_the_decision_not_from_the_scan() {
  gatelogic::ScanDebounce debounce;
  debounce.decided("TOKEN1", kBaseWrapSoon);
  debounce.decided("TOKEN1", kBaseWrapSoon + 4000U); // a later decision restarts it
  TEST_ASSERT_TRUE(debounce.suppresses("TOKEN1", kBaseWrapSoon + 5000U));
  TEST_ASSERT_FALSE(debounce.suppresses("TOKEN1", kBaseWrapSoon + 6000U));
}

// ---------------------------------------------------------------------------
// GateFlow — online first, roster second
// ---------------------------------------------------------------------------

void test_flow_asks_the_api_only_with_a_link_and_a_closed_breaker() {
  TEST_ASSERT_TRUE(gatelogic::chooseAttempt(true, false) == gatelogic::Attempt::Online);
  TEST_ASSERT_TRUE(gatelogic::chooseAttempt(true, true) == gatelogic::Attempt::RosterOnly);
  TEST_ASSERT_TRUE(gatelogic::chooseAttempt(false, false) == gatelogic::Attempt::RosterOnly);
  TEST_ASSERT_TRUE(gatelogic::chooseAttempt(false, true) == gatelogic::Attempt::RosterOnly);
}

void test_flow_scan_body_is_refused_rather_than_truncated() {
  char body[gatelogic::kScanBodyCap] = {};
  TEST_ASSERT_TRUE(gatelogic::renderScanBody(body, sizeof(body), "5ccf7f0a1b2c", "7Q3F9KM2XZ8B") > 0U);

  char tiny[16] = {};
  TEST_ASSERT_EQUAL_size_t(0U, gatelogic::renderScanBody(tiny, sizeof(tiny), "5ccf7f0a1b2c", "7Q3F9KM2XZ8B"));
  TEST_ASSERT_EQUAL_STRING("", tiny);

  TEST_ASSERT_EQUAL_size_t(0U, gatelogic::renderScanBody(body, sizeof(body), "", "7Q3F9KM2XZ8B"));
  TEST_ASSERT_EQUAL_size_t(0U, gatelogic::renderScanBody(body, sizeof(body), "5ccf7f0a1b2c", ""));
  TEST_ASSERT_EQUAL_size_t(0U, gatelogic::renderScanBody(body, sizeof(body), nullptr, "T"));
  TEST_ASSERT_EQUAL_size_t(0U, gatelogic::renderScanBody(body, sizeof(body), "5ccf7f0a1b2c", nullptr));
}

/// THE WHOLE STATUS TABLE, IN ONE PLACE. Two statuses are ANSWERS and every
/// other one says the board learned NOTHING about this member — including the
/// 4xx classes devapi::react() would call "the box's own fault and safe to
/// drop". For an event upload that is right; for a door it would leave a member
/// with a booking outside because a proxy answered 404.
///
/// MUTATION-PROVED in both directions. Make 403 fall back and the out-of-service
/// row goes red; make any other 4xx authoritative and that row goes red.
void test_flow_the_status_table_says_which_statuses_are_answers() {
  struct Row {
    uint16_t status;
    bool authoritative;
    const char* why;
  };

  const Row rows[] = {
      // The club took this board out of service. NOT an outage: falling back
      // would keep the door admitting rostered members for six hours after an
      // admin pressed the button meant to stop exactly that.
      {403U, true, "403 is the club taking the board out of service"},
      // Everything else. A transport failure, a key the tenant does not know, a
      // proxy's 404, a rate limit, a restarting container.
      {0U, false, "0"},
      {204U, false, "204"},
      {301U, false, "301"},
      {400U, false, "400"},
      {401U, false, "401"},
      {404U, false, "404"},
      {408U, false, "408"},
      {429U, false, "429"},
      {500U, false, "500"},
      {502U, false, "502"},
      {503U, false, "503"},
      {504U, false, "504"},
  };

  // A body that WOULD open the door if the status were read as a 200, so a
  // status accidentally treated as authoritative-and-readable opens a door
  // rather than quietly refusing.
  const char* answer = "{\"opened\":true,\"reason\":\"ok\",\"unlock_seconds\":3}";

  for (const Row& row : rows) {
    const gatelogic::ScanDecision decision =
        gatelogic::onGateResponse(row.status, answer, strlen(answer), kDefaultMs, kCapMs);
    TEST_ASSERT_EQUAL_MESSAGE(!row.authoritative, decision.fallbackToRoster, row.why);
    TEST_ASSERT_FALSE_MESSAGE(decision.released, row.why);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(0U, decision.unlockMs, row.why);
    TEST_ASSERT_FALSE_MESSAGE(decision.queueEvent, row.why);
  }
}

/// A 403 refuses with a reason of its own. The server sends no body a reason
/// could be read out of, and an empty reason at a door is a refusal nobody can
/// explain from the admin console afterwards.
void test_flow_a_403_denies_with_its_own_reason_and_no_roster_fallback() {
  const char* bodies[] = {"", "{}", "Forbidden", "{\"opened\":true,\"unlock_seconds\":30}"};

  for (const char* body : bodies) {
    const gatelogic::ScanDecision decision =
        gatelogic::onGateResponse(403U, body, strlen(body), kDefaultMs, kCapMs);
    TEST_ASSERT_FALSE_MESSAGE(decision.fallbackToRoster, body);
    TEST_ASSERT_FALSE_MESSAGE(decision.released, body);
    TEST_ASSERT_EQUAL_STRING_MESSAGE("out_of_service", decision.reason, body);
    // Nothing queued. The server already knows — it is the one refusing — and
    // an event queued here would itself be 403'd on the way out.
    TEST_ASSERT_FALSE_MESSAGE(decision.queueEvent, body);
  }

  // Including a body that claims an open. A 403 is a refusal whatever arrives
  // with it; a proxy's error page must not be able to open a door.
  const gatelogic::ScanDecision decision = gatelogic::onGateResponse(403U, nullptr, 0U, kDefaultMs, kCapMs);
  TEST_ASSERT_FALSE(decision.released);
  TEST_ASSERT_FALSE(decision.fallbackToRoster);
}

/// MUTATION-PROVED, and the single most important line in this suite. A 200
/// that says `opened:false` is the API's own judgement about a member it knows
/// far more about than this board does — a membership suspended this morning,
/// a code from another club. Falling back to the roster after one would let
/// exactly those people in, through a booking nobody cancelled.
void test_flow_a_200_refusal_is_never_second_guessed_against_the_roster() {
  const char* refusals[] = {
      "{\"opened\":false,\"reason\":\"not_recognised\",\"unlock_seconds\":0}",
      "{\"opened\":false,\"reason\":\"member_not_active\",\"unlock_seconds\":0}",
      "{\"opened\":false,\"reason\":\"no_booking\",\"unlock_seconds\":0}",
      "{\"opened\":false,\"reason\":\"method_not_supported\",\"unlock_seconds\":0}",
      "{\"opened\":false,\"reason\":\"not_a_gate\",\"unlock_seconds\":0}",
  };

  for (const char* body : refusals) {
    const gatelogic::ScanDecision decision =
        gatelogic::onGateResponse(200U, body, strlen(body), kDefaultMs, kCapMs);
    TEST_ASSERT_FALSE_MESSAGE(decision.fallbackToRoster, body);
    TEST_ASSERT_FALSE_MESSAGE(decision.released, body);
    TEST_ASSERT_EQUAL_UINT32(0U, decision.unlockMs);
    // Nothing queued: the API wrote its own audit row when it refused.
    TEST_ASSERT_FALSE(decision.queueEvent);
  }
}

/// A 200 nobody can read is not a refusal — nobody said no — so it is an outage
/// with a 200 on it and the roster gets its turn.
void test_flow_a_malformed_200_falls_back_rather_than_refusing() {
  const char* bodies[] = {
      "",
      "{",
      "{\"reason\":\"ok\"}",                     // no `opened` at all
      "{\"opened\":\"true\",\"reason\":\"ok\"}", // quoted, so not a bare bool
      "{\"opened\":1,\"reason\":\"ok\"}",        // an integer, not a bool
      "{\"opened\":tru",                         // truncated mid-token
  };

  for (const char* body : bodies) {
    const gatelogic::ScanDecision decision =
        gatelogic::onGateResponse(200U, body, strlen(body), kDefaultMs, kCapMs);
    TEST_ASSERT_TRUE_MESSAGE(decision.fallbackToRoster, body);
  }
}

void test_flow_an_open_carries_the_servers_seconds_clamped_at_both_ends() {
  struct Row {
    const char* body;
    uint32_t expectedMs;
  };

  const Row rows[] = {
      {"{\"opened\":true,\"reason\":\"ok\",\"unlock_seconds\":3}", 3000U},
      // Never zero: a zero-second release is a door that clicks and stays shut.
      {"{\"opened\":true,\"reason\":\"ok\",\"unlock_seconds\":0}", 1000U},
      {"{\"opened\":true,\"reason\":\"ok\",\"unlock_seconds\":30}", 30000U},
      // One past the contract's own clamp, and a value whose multiply by 1000
      // would wrap a uint32_t into a plausible small number.
      {"{\"opened\":true,\"reason\":\"ok\",\"unlock_seconds\":31}", 30000U},
      {"{\"opened\":true,\"reason\":\"ok\",\"unlock_seconds\":4000000}", 30000U},
      {"{\"opened\":true,\"reason\":\"ok\",\"unlock_seconds\":4300000}", 30000U},
      // No duration at all: the one the last heartbeat established.
      {"{\"opened\":true,\"reason\":\"ok\"}", kDefaultMs},
  };

  for (const Row& row : rows) {
    const gatelogic::ScanDecision decision =
        gatelogic::onGateResponse(200U, row.body, strlen(row.body), kDefaultMs, kCapMs);
    TEST_ASSERT_FALSE_MESSAGE(decision.fallbackToRoster, row.body);
    TEST_ASSERT_TRUE_MESSAGE(decision.released, row.body);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(row.expectedMs, decision.unlockMs, row.body);
    TEST_ASSERT_EQUAL_STRING("ok", decision.reason);
    TEST_ASSERT_FALSE(decision.queueEvent);
  }
}

/// `reason` is a server-chosen string and it sits BEFORE `unlock_seconds` in
/// every gate scan response. A scanner that matched a quoted string anywhere
/// read the reason's VALUE as the key, found no digits after it, and fell back
/// to the last adopted release time — a door open for the wrong number of
/// seconds, on a 200 that was perfectly well formed.
void test_flow_a_reason_that_names_the_unlock_key_does_not_hide_it() {
  const char* body = "{\"opened\":true,\"reason\":\"unlock_seconds\",\"unlock_seconds\":7}";
  const gatelogic::ScanDecision decision =
      gatelogic::onGateResponse(200U, body, strlen(body), kDefaultMs, kCapMs);

  TEST_ASSERT_FALSE(decision.fallbackToRoster);
  TEST_ASSERT_TRUE(decision.released);
  TEST_ASSERT_EQUAL_UINT32(7000U, decision.unlockMs);
  TEST_ASSERT_EQUAL_STRING("unlock_seconds", decision.reason);
}

void test_flow_a_roster_open_is_queued_and_a_roster_refusal_is_too() {
  roster::Decision allow;
  allow.verdict = roster::Verdict::Allow;
  // What is LEFT of the booking — 25 minutes for a late arrival. The door must
  // not be released for it.
  allow.grantMs = 1500000U;

  const gatelogic::ScanDecision opened = gatelogic::fromRoster(allow, kDefaultMs, kCapMs);
  TEST_ASSERT_TRUE(opened.released);
  TEST_ASSERT_EQUAL_UINT32_MESSAGE(kDefaultMs, opened.unlockMs,
                                   "a door is released for the unlock time, not for the booking");
  TEST_ASSERT_TRUE(opened.queueEvent);
  TEST_ASSERT_TRUE(opened.eventKind == eventq::Kind::GateOpen);
  TEST_ASSERT_EQUAL_STRING("ok", opened.reason);

  const roster::Verdict refusals[] = {roster::Verdict::Unknown, roster::Verdict::TooEarly,
                                      roster::Verdict::TooLate, roster::Verdict::Stale,
                                      roster::Verdict::WrongCourt};
  for (roster::Verdict verdict : refusals) {
    roster::Decision refused;
    refused.verdict = verdict;
    const gatelogic::ScanDecision decision = gatelogic::fromRoster(refused, kDefaultMs, kCapMs);
    TEST_ASSERT_FALSE(decision.released);
    TEST_ASSERT_EQUAL_UINT32(0U, decision.unlockMs);
    TEST_ASSERT_TRUE(decision.queueEvent);
    TEST_ASSERT_TRUE(decision.eventKind == eventq::Kind::UnknownScan);
    TEST_ASSERT_TRUE(decision.reason[0] != '\0');
  }
}

/// MUTATION-PROVED. Remove the staleness check from the fallback path — or move
/// it after the match — and this goes red: a roster older than its maximum age
/// admits NOBODY, however good the match looks. The member goes to the desk,
/// which is annoying and recoverable; the other direction is a door opening for
/// a booking cancelled a week ago and a club that finds out at month end.
void test_flow_a_stale_roster_admits_nobody() {
  for (size_t b = 0U; b < kBaseCount; ++b) {
    const uint32_t base = kBases[b];
    Cache cache(gatelogic::kGateConfig.rosterMaxAgeMs);
    // The booking OUTLASTS the roster's maximum age, deliberately. With a
    // shorter one the entry is TooLate by the time the roster is stale, and a
    // firmware that had lost the staleness check entirely would still refuse —
    // for the wrong reason, and only for this fixture.
    const roster::Entry entries[] = {
        booking("7Q3F9KM2XZ8B", 0U, gatelogic::kGateConfig.rosterMaxAgeMs + 3600000U)};
    loadRoster(cache, base, entries, 1U);

    // Inside its window and inside the roster's age: in.
    const gatelogic::ScanDecision fresh = gatelogic::fromRoster(
        cache.decide("7Q3F9KM2XZ8B", roster::CourtCount(1U), base + 1000U), kDefaultMs, kCapMs);
    TEST_ASSERT_TRUE(fresh.released);

    // One millisecond past the maximum age, with the booking still open: out.
    const uint32_t stale = base + gatelogic::kGateConfig.rosterMaxAgeMs + 1U;
    const gatelogic::ScanDecision refused = gatelogic::fromRoster(
        cache.decide("7Q3F9KM2XZ8B", roster::CourtCount(1U), stale), kDefaultMs, kCapMs);
    TEST_ASSERT_FALSE_MESSAGE(refused.released, "a stale roster admits nobody");
    TEST_ASSERT_TRUE(refused.eventKind == eventq::Kind::UnknownScan);
    TEST_ASSERT_EQUAL_STRING("roster_stale", refused.reason);
  }
}

/// A gate that has never had a heartbeat has never had a roster, and a roster
/// that was never loaded is stale by definition. Offline from boot, nobody gets
/// in — which is the degraded mode the contract states out loud.
void test_flow_a_gate_that_has_never_heard_from_the_api_admits_nobody() {
  Cache cache(gatelogic::kGateConfig.rosterMaxAgeMs);
  TEST_ASSERT_FALSE(cache.everLoaded());
  const gatelogic::ScanDecision decision = gatelogic::fromRoster(
      cache.decide("7Q3F9KM2XZ8B", roster::CourtCount(1U), kBaseMid), kDefaultMs, kCapMs);
  TEST_ASSERT_FALSE(decision.released);
}

void test_flow_an_unreadable_scan_is_refused_and_queued_only_while_offline() {
  const gatelogic::ScanDecision offline = gatelogic::refuseUnreadable(true);
  TEST_ASSERT_FALSE(offline.released);
  TEST_ASSERT_FALSE(offline.fallbackToRoster);
  TEST_ASSERT_TRUE(offline.queueEvent);
  TEST_ASSERT_TRUE(offline.eventKind == eventq::Kind::UnknownScan);
  TEST_ASSERT_EQUAL_STRING("not_recognised", offline.reason);

  const gatelogic::ScanDecision online = gatelogic::refuseUnreadable(false);
  TEST_ASSERT_FALSE(online.released);
  TEST_ASSERT_FALSE(online.queueEvent);
}

// ---------------------------------------------------------------------------
// GateApi — the call, the breaker and the answer
// ---------------------------------------------------------------------------

void test_api_a_scan_posts_the_contract_body_to_the_gate_path() {
  FakeHttp http;
  devlink::ApiBreaker breaker;
  fakes::FakeClock clock(kBaseMid);
  gatelogic::GateApi api(http, breaker, clock);

  http.answer(200U, "{\"opened\":true,\"reason\":\"ok\",\"unlock_seconds\":3}");
  const gatelogic::ScanDecision decision = api.scan("5ccf7f0a1b2c", "7Q3F9KM2XZ8B", kDefaultMs, kCapMs);

  TEST_ASSERT_EQUAL_STRING("/api/v1/device/gate", http.lastPath());
  TEST_ASSERT_EQUAL_STRING("{\"mac\":\"5ccf7f0a1b2c\",\"method\":\"qr\",\"token\":\"7Q3F9KM2XZ8B\"}",
                           http.lastBody());
  TEST_ASSERT_TRUE(decision.released);
  TEST_ASSERT_EQUAL_UINT32(3000U, decision.unlockMs);
}

/// Two consecutive transport failures open the breaker, and an open breaker is
/// what stops every scan standing in a four-second connect timeout with a
/// member in front of it. The roster answers in microseconds instead.
void test_api_two_transport_failures_send_the_next_scan_straight_to_the_roster() {
  FakeHttp http;
  devlink::ApiBreaker breaker;
  fakes::FakeClock clock(kBaseWrapSoon);
  gatelogic::GateApi api(http, breaker, clock);

  http.answer(0U, "");
  TEST_ASSERT_TRUE(api.scan("5ccf7f0a1b2c", "T1", kDefaultMs, kCapMs).fallbackToRoster);
  TEST_ASSERT_FALSE(breaker.open(clock.nowMs()));
  TEST_ASSERT_TRUE(api.scan("5ccf7f0a1b2c", "T2", kDefaultMs, kCapMs).fallbackToRoster);
  TEST_ASSERT_TRUE(breaker.open(clock.nowMs()));

  TEST_ASSERT_TRUE(gatelogic::chooseAttempt(true, breaker.open(clock.nowMs())) ==
                   gatelogic::Attempt::RosterOnly);

  // A 401 is an ANSWER: the host is there and it does not like the compiled-in
  // key. The breaker closes, and the fix is a reflash rather than a backoff.
  http.answer(401U, "");
  static_cast<void>(api.scan("5ccf7f0a1b2c", "T3", kDefaultMs, kCapMs));
  TEST_ASSERT_FALSE(breaker.open(clock.nowMs()));
}

/// A body that could not be rendered never reaches the socket and teaches the
/// breaker nothing — it says nothing about whether the host is there.
void test_api_an_unrenderable_body_is_not_a_transport_failure() {
  FakeHttp http;
  devlink::ApiBreaker breaker;
  fakes::FakeClock clock(kBaseZero);
  gatelogic::GateApi api(http, breaker, clock);

  http.answer(200U, "{\"opened\":true,\"reason\":\"ok\",\"unlock_seconds\":3}");
  const gatelogic::ScanDecision decision = api.scan("", "7Q3F9KM2XZ8B", kDefaultMs, kCapMs);
  TEST_ASSERT_TRUE(decision.fallbackToRoster);
  TEST_ASSERT_EQUAL_UINT16(0U, http.calls());
  TEST_ASSERT_EQUAL_UINT8(0U, breaker.consecutiveFailures());
}

void test_api_the_heartbeat_posts_the_gate_kind_and_hands_back_the_response() {
  FakeHttp http;
  devlink::ApiBreaker breaker;
  fakes::FakeClock clock(kBaseMid);
  gatelogic::GateApi api(http, breaker, clock);

  http.answer(200U, "{\"kind\":\"gate\",\"gate\":{\"unlock_seconds\":5},\"roster\":[]}");
  char response[gatelogic::kGateResponseCap] = {};
  const uint16_t status = api.heartbeat("5ccf7f0a1b2c", "1.0.0", 86400000ULL, response, sizeof(response));

  TEST_ASSERT_EQUAL_UINT16(200U, status);
  TEST_ASSERT_EQUAL_STRING("/api/v1/device/heartbeat", http.lastPath());
  TEST_ASSERT_NOT_NULL(strstr(http.lastBody(), "\"kind\":\"gate\""));
  TEST_ASSERT_NOT_NULL(strstr(response, "\"unlock_seconds\":5"));
}

// ---------------------------------------------------------------------------
// GateHeartbeat — the field it sends and the field it adopts
// ---------------------------------------------------------------------------

void test_heartbeat_body_carries_kind_last_and_refuses_rather_than_truncating() {
  char body[gatelogic::kGateHeartbeatBodyCap] = {};
  TEST_ASSERT_TRUE(
      gatelogic::renderGateHeartbeatBody(body, sizeof(body), "5ccf7f0a1b2c", "1.0.0", 86400000ULL) > 0U);
  TEST_ASSERT_EQUAL_STRING(
      "{\"mac\":\"5ccf7f0a1b2c\",\"firmware_version\":\"1.0.0\",\"uptime_ms\":86400000,\"kind\":\"gate\"}",
      body);

  // 64-bit, past the 49.7-day wrap: 0xFFFFFFFF + 20000.
  TEST_ASSERT_TRUE(
      gatelogic::renderGateHeartbeatBody(body, sizeof(body), "5ccf7f0a1b2c", "1.0.0", 4295187295ULL) > 0U);
  TEST_ASSERT_NOT_NULL(strstr(body, "\"uptime_ms\":4295187295,"));

  char tiny[16] = {};
  TEST_ASSERT_EQUAL_size_t(
      0U, gatelogic::renderGateHeartbeatBody(tiny, sizeof(tiny), "5ccf7f0a1b2c", "1.0.0", 1000ULL));
  TEST_ASSERT_EQUAL_STRING("", tiny);
  TEST_ASSERT_EQUAL_size_t(0U, gatelogic::renderGateHeartbeatBody(body, sizeof(body), "", "1.0.0", 1000ULL));
}

void test_heartbeat_adopts_the_gate_objects_unlock_seconds_and_clamps_it() {
  struct Row {
    const char* body;
    bool adopted;
    uint32_t expectedMs;
  };

  const Row rows[] = {
      {"{\"kind\":\"gate\",\"gate\":{\"unlock_seconds\":3},\"roster\":[]}", true, 3000U},
      {"{\"kind\":\"gate\",\"gate\":{\"unlock_seconds\":0},\"roster\":[]}", true, 1000U},
      {"{\"kind\":\"gate\",\"gate\":{\"unlock_seconds\":31},\"roster\":[]}", true, 30000U},
      {"{\"kind\":\"gate\",\"gate\":{\"unlock_seconds\":4000000},\"roster\":[]}", true, 30000U},
      // No `gate` object: an older API that does not send one must not reset a
      // release time a newer one configured.
      {"{\"kind\":\"gate\",\"roster\":[]}", false, 0U},
      {"{\"kind\":\"gate\",\"gate\":{},\"roster\":[]}", false, 0U},
  };

  for (const Row& row : rows) {
    uint32_t unlockMs = 7777U;
    const bool ok = gatelogic::adoptUnlockMs(row.body, strlen(row.body), unlockMs);
    TEST_ASSERT_EQUAL_MESSAGE(row.adopted, ok, row.body);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(row.adopted ? row.expectedMs : 7777U, unlockMs, row.body);
  }
}

/// The read is BOUNDED TO THE `gate` OBJECT, at both ends. A response that
/// happened to carry an `unlock_seconds` somewhere else — a future field, a
/// nested object, before the gate object or after it — must not be read as this
/// one. `devapi::json::findKey` is a flat scan by design, so bounding is the
/// caller's job and this is where it is proved.
void test_heartbeat_ignores_an_unlock_seconds_outside_the_gate_object() {
  const char* before =
      "{\"kind\":\"gate\",\"legacy\":{\"unlock_seconds\":29},\"gate\":{\"unlock_seconds\":4},\"roster\":[]}";
  uint32_t unlockMs = 0U;
  TEST_ASSERT_TRUE(gatelogic::adoptUnlockMs(before, strlen(before), unlockMs));
  TEST_ASSERT_EQUAL_UINT32(4000U, unlockMs);

  // AFTER the object, which a scan that started at the `gate` key and ran to
  // the end of the body would have adopted.
  const char* after = "{\"kind\":\"gate\",\"gate\":{\"reason\":\"ok\"},\"unlock_seconds\":29,\"roster\":[]}";
  unlockMs = 7777U;
  TEST_ASSERT_FALSE(gatelogic::adoptUnlockMs(after, strlen(after), unlockMs));
  TEST_ASSERT_EQUAL_UINT32(7777U, unlockMs);

  // A nested object INSIDE the gate object is still inside it, and its brace
  // must not close the gate object early.
  const char* nested =
      "{\"kind\":\"gate\",\"gate\":{\"limits\":{\"max\":9},\"unlock_seconds\":6},\"roster\":[]}";
  unlockMs = 0U;
  TEST_ASSERT_TRUE(gatelogic::adoptUnlockMs(nested, strlen(nested), unlockMs));
  TEST_ASSERT_EQUAL_UINT32(6000U, unlockMs);

  // The first `"gate"` in every gate heartbeat is the VALUE of `kind`. This is
  // the decoy the local workaround existed for; it is held by the shared
  // scanner now, and this test is what says so from the gate's side.
  const char* valueDecoy = "{\"kind\":\"gate\",\"gate\":{\"unlock_seconds\":5}}";
  unlockMs = 0U;
  TEST_ASSERT_TRUE(gatelogic::adoptUnlockMs(valueDecoy, strlen(valueDecoy), unlockMs));
  TEST_ASSERT_EQUAL_UINT32(5000U, unlockMs);
}

// ---------------------------------------------------------------------------
// LedPattern — the whole user interface
// ---------------------------------------------------------------------------

/// The lamp's polarity, composed in one named place like the lock's. The
/// composition root writes `ledPinLevel(led.on(now), cfg.ledActiveHigh)` and
/// nothing else, so an active-LOW lamp is a build flag rather than an edit.
void test_led_level_for_both_polarities() {
  TEST_ASSERT_TRUE(gatelogic::ledPinLevel(true, true) == hal::PinLevel::kHigh);
  TEST_ASSERT_TRUE(gatelogic::ledPinLevel(false, true) == hal::PinLevel::kLow);
  TEST_ASSERT_TRUE(gatelogic::ledPinLevel(true, false) == hal::PinLevel::kLow);
  TEST_ASSERT_TRUE(gatelogic::ledPinLevel(false, false) == hal::PinLevel::kHigh);
}

void test_led_is_solid_while_the_lock_is_released_whatever_else_is_happening() {
  for (size_t b = 0U; b < kBaseCount; ++b) {
    const uint32_t base = kBases[b];
    gatelogic::LedPattern led;
    led.setLinkUp(false);
    led.cue(gatelogic::LedCue::Denied, base);
    led.setReleased(true);

    // Every instant across a whole denial pattern and a whole link-blink period.
    for (uint32_t t = 0U; t <= 1200U; t += 37U) {
      TEST_ASSERT_TRUE_MESSAGE(led.on(base + t), "a released door is a solid lamp");
    }
  }
}

void test_led_blinks_three_times_for_a_refusal_and_twice_at_boot() {
  for (size_t b = 0U; b < kBaseCount; ++b) {
    const uint32_t base = kBases[b];

    gatelogic::LedPattern denied;
    denied.setLinkUp(true);
    denied.cue(gatelogic::LedCue::Denied, base);
    // A pattern always STARTS lit: half-period 0 is on, 1 is off, and so on.
    for (uint8_t half = 0U; half < gatelogic::kDeniedBlinks * 2U; ++half) {
      const uint32_t at = base + (half * gatelogic::kDeniedHalfMs) + 10U;
      TEST_ASSERT_EQUAL_MESSAGE((half % 2U) == 0U, denied.on(at), "three blinks, on first");
    }
    // And it is over.
    TEST_ASSERT_FALSE(denied.on(base + (gatelogic::kDeniedBlinks * 2U * gatelogic::kDeniedHalfMs)));

    gatelogic::LedPattern boot;
    boot.setLinkUp(true);
    boot.cue(gatelogic::LedCue::Boot, base);
    for (uint8_t half = 0U; half < gatelogic::kBootBlinks * 2U; ++half) {
      const uint32_t at = base + (half * gatelogic::kBootHalfMs) + 5U;
      TEST_ASSERT_EQUAL_MESSAGE((half % 2U) == 0U, boot.on(at), "two blinks at boot");
    }
    TEST_ASSERT_FALSE(boot.on(base + (gatelogic::kBootBlinks * 2U * gatelogic::kBootHalfMs)));
  }
}

void test_led_blinks_slowly_while_the_radio_is_down_and_is_dark_when_it_is_up() {
  gatelogic::LedPattern led;
  led.setLinkUp(false);

  // 1 Hz: half a second lit, half a second dark. Sampled off the raw clock, so
  // the phase is a property of the instant rather than of when the link failed.
  TEST_ASSERT_TRUE(led.on(2000U));
  TEST_ASSERT_TRUE(led.on(2499U));
  TEST_ASSERT_FALSE(led.on(2500U));
  TEST_ASSERT_FALSE(led.on(2999U));
  TEST_ASSERT_TRUE(led.on(3000U));

  led.setLinkUp(true);
  TEST_ASSERT_FALSE(led.on(2000U));
  TEST_ASSERT_FALSE(led.on(2500U));
}

/// A cue outranks the link blink for as long as it lasts, then the link blink
/// comes back. Otherwise a board with no WiFi would answer a refusal with a
/// pattern indistinguishable from what it was already doing.
void test_led_a_cue_outranks_the_link_blink_and_then_gives_it_back() {
  gatelogic::LedPattern led;
  led.setLinkUp(false);
  // 2500 is a dark half-period of the link blink.
  TEST_ASSERT_FALSE(led.on(2500U));

  led.cue(gatelogic::LedCue::Denied, 2500U);
  TEST_ASSERT_TRUE_MESSAGE(led.on(2500U), "the refusal is visible even in a dark link half-period");

  // Once the cue is over the link blink resumes.
  const uint32_t after = 2500U + (gatelogic::kDeniedBlinks * 2U * gatelogic::kDeniedHalfMs);
  TEST_ASSERT_EQUAL(((after / gatelogic::kLinkDownHalfMs) % 2U) == 0U, led.on(after));
}

// ---------------------------------------------------------------------------
// API_BASE_URL — the four mistakes the compiler now refuses
// ---------------------------------------------------------------------------

/// The grammar itself, at COMPILE time. These are the assertions that actually
/// protect a board: main.cpp carries the same three against the real macro, and
/// a bad secrets.h is a build that does not produce an image.
static_assert(gatelogic::isValidApiBaseUrl("http://192.168.1.10:8088"), "the club's own shape");
static_assert(gatelogic::isValidApiBaseUrl("http://10.0.0.1"), "no port is legal");
static_assert(gatelogic::isValidApiBaseUrl("http://255.255.255.255:65535"), "the longest legal base");
static_assert(!gatelogic::isValidApiBaseUrl("https://192.168.1.10:8088"), "cleartext to :443");
static_assert(!gatelogic::isValidApiBaseUrl("http://mainframe.local:8088"), "an unbounded DNS wait");
static_assert(!gatelogic::isValidApiBaseUrl("http://192.168.1.10:8088/"), "a trailing slash is a 404");
static_assert(gatelogic::apiBaseUrlFits("http://255.255.255.255:65535"), "must fit the URL buffer");

/// The same grammar as a runtime table, so a failure prints which value broke
/// rather than one line number for all of them — and so the cases nobody would
/// write a static_assert for are still covered.
void test_url_accepts_only_cleartext_http_to_an_ipv4_literal() {
  const char* good[] = {
      "http://192.168.1.10:8088", "http://10.0.0.1",  "http://127.0.0.1:80",
      "http://0.0.0.0",           "http://8.8.8.8:1", "http://255.255.255.255:65535",
  };
  for (const char* url : good) {
    TEST_ASSERT_TRUE_MESSAGE(gatelogic::isValidApiBaseUrl(url), url);
    TEST_ASSERT_TRUE_MESSAGE(gatelogic::apiBaseUrlFits(url), url);
  }

  const char* bad[] = {
      "",
      "192.168.1.10:8088",           // no scheme
      "https://192.168.1.10:8088",   // cleartext to :443
      "HTTP://192.168.1.10",         // the scheme is compared byte for byte
      "http://mainframe.local:8088", // the 31-second DNS wait
      "http://localhost:8088",
      "http://192.168.1.10:8088/",    // trailing slash -> //api/v1/...
      "http://192.168.1.10:8088/api", // a path belongs to the endpoint constants
      "http://192.168.1.10:",         // a colon with no port
      "http://192.168.1.10:0",        // port zero is not a port
      "http://192.168.1.10:65536",    // one past the range
      "http://192.168.1.10:08088",    // a leading zero in the port
      "http://192.168.1.256",         // an octet past 255
      "http://192.168.001.10",        // ambiguous: several resolvers read octal
      "http://192.168.1",             // three octets
      "http://192.168.1.10.5",        // five
      "http://192.168.1.",            // a trailing dot
      "http://.168.1.10",             // a leading one
      "http://",
      "http://192.168.1.10 ", // a stray space, which is how a .example is edited
  };
  for (const char* url : bad) {
    TEST_ASSERT_FALSE_MESSAGE(gatelogic::isValidApiBaseUrl(url), url);
  }

  // Long enough to be a valid dotted quad and still not fit.
  TEST_ASSERT_FALSE(gatelogic::apiBaseUrlFits("http://255.255.255.255:65535/xxxxxxxxxxxxxxxxxxxxxxxxxxx"));
}

/// The C++11 text helpers the checks above are built from. One return statement
/// each, because the generated Arduino sketch compiles at gnu++11.
void test_static_text_compares_at_compile_time() {
  static_assert(gatelogic::text::length("") == 0U, "");
  static_assert(gatelogic::text::length("http://") == 7U, "");
  static_assert(gatelogic::text::equals("gate", "gate"), "");
  static_assert(!gatelogic::text::equals("gate", "gates"), "");
  static_assert(!gatelogic::text::equals("gates", "gate"), "");
  static_assert(gatelogic::text::startsWith("http://x", "http://"), "");
  static_assert(!gatelogic::text::startsWith("http:/", "http://"), "");
  static_assert(gatelogic::text::startsWith("anything", ""), "");

  TEST_ASSERT_EQUAL_size_t(0U, gatelogic::text::length(nullptr));
  TEST_ASSERT_FALSE(gatelogic::text::startsWith(nullptr, "http://"));
  TEST_ASSERT_TRUE(gatelogic::text::equals(nullptr, nullptr));
}

// ---------------------------------------------------------------------------
// GateApp — the loop, with a clock that moves while the API is being asked
// ---------------------------------------------------------------------------

/// The watchdog, remembering WHEN each kick happened.
///
/// A counter would prove nothing: the property is not "it was kicked a lot", it
/// is "the countdown never ran longer than one worst-case call without one", and
/// that is a statement about instants.
class FakeWatchdog final : public gatelogic::IWatchdog {
public:
  static constexpr size_t kMaxKicks = 512U;

  explicit FakeWatchdog(fakes::FakeClock& clock) : clock_(clock) {}

  void kick() override {
    if (kicks_ < kMaxKicks) {
      at_[kicks_] = clock_.value();
    }
    ++kicks_;
  }

  /// Forget the boot traffic, so a scenario's assertions are about the
  /// scenario.
  void forget() { kicks_ = 0U; }

  size_t kicks() const { return kicks_; }

  uint32_t at(size_t i) const { return at_[i]; }

  bool kickedAt(uint32_t instant) const {
    for (size_t i = 0U; i < kicks_ && i < kMaxKicks; ++i) {
      if (at_[i] == instant) {
        return true;
      }
    }
    return false;
  }

  /// The longest the countdown ran without a kick. tb::since, not subtraction:
  /// these scenarios are run at clock bases that put the 49.7-day wrap inside
  /// them.
  uint32_t longestGapMs() const {
    uint32_t worst = 0U;
    for (size_t i = 1U; i < kicks_ && i < kMaxKicks; ++i) {
      const uint32_t gap = tb::since(at_[i], at_[i - 1U]);
      if (gap > worst) {
        worst = gap;
      }
    }
    return worst;
  }

private:
  fakes::FakeClock& clock_;
  uint32_t at_[kMaxKicks] = {};
  size_t kicks_ = 0U;
};

class FakeLink final : public gatelogic::ILink {
public:
  void set(bool up) { up_ = up; }

  bool up() override { return up_; }

private:
  bool up_ = false;
};

/// Scanner bytes, and the overrun the real UART signals out of band.
class FakeScannerBytes final : public gatelogic::IScannerBytes {
public:
  void feed(const char* text) {
    for (size_t i = 0U; text[i] != '\0' && count_ < sizeof(buf_); ++i) {
      buf_[count_] = static_cast<uint8_t>(text[i]);
      ++count_;
    }
  }

  /// The driver dropped bytes. Signalled exactly as the core does: out of band,
  /// with nothing missing from what read() returns afterwards.
  void signalRxError() { rxError_ = true; }

  bool read(uint8_t& out) override {
    if (head_ >= count_) {
      return false;
    }
    out = buf_[head_];
    ++head_;
    return true;
  }

  bool takeRxError() override {
    const bool had = rxError_;
    rxError_ = false;
    return had;
  }

private:
  uint8_t buf_[512] = {};
  size_t count_ = 0U;
  size_t head_ = 0U;
  bool rxError_ = false;
};

/// The fake that makes the whole suite possible: an HTTP port that ADVANCES THE
/// CLOCK.
///
/// Every defect in the shipped loop was a stale instant, and a fake that
/// answered instantly could not express one. This one takes a latency, moves
/// the clock by it, and records the window each call occupied so a test can ask
/// whether the watchdog was kicked at both ends of it.
class LatentHttp final : public gatelogic::IHttpPort {
public:
  static constexpr size_t kMaxCalls = 256U;

  explicit LatentHttp(fakes::FakeClock& clock) : clock_(clock) {}

  void setLatency(uint32_t ms) { latency_ = ms; }

  void answer(uint16_t status, const char* body) {
    status_ = status;
    answer_[0] = '\0';
    if (body != nullptr) {
      strncpy(answer_, body, sizeof(answer_) - 1U);
      answer_[sizeof(answer_) - 1U] = '\0';
    }
  }

  uint16_t post(const char* path, const char* body, char* out, size_t outCap) override {
    static_cast<void>(body);
    if (calls_ < kMaxCalls) {
      entered_[calls_] = clock_.value();
    }
    clock_.advance(latency_);
    if (calls_ < kMaxCalls) {
      exited_[calls_] = clock_.value();
    }
    ++calls_;

    strncpy(path_, path, sizeof(path_) - 1U);
    path_[sizeof(path_) - 1U] = '\0';
    if (out != nullptr && outCap > 0U) {
      strncpy(out, answer_, outCap - 1U);
      out[outCap - 1U] = '\0';
    }
    return status_;
  }

  void forget() { calls_ = 0U; }

  uint16_t calls() const { return calls_; }

  const char* lastPath() const { return path_; }

  uint32_t enteredAt(size_t i) const { return entered_[i]; }

  uint32_t exitedAt(size_t i) const { return exited_[i]; }

private:
  fakes::FakeClock& clock_;
  char path_[64] = {};
  char answer_[512] = {};
  uint32_t entered_[kMaxCalls] = {};
  uint32_t exited_[kMaxCalls] = {};
  uint32_t latency_ = 0U;
  uint16_t status_ = 0U;
  uint16_t calls_ = 0U;
};

/// One whole board, wired the way main.cpp wires it.
struct Rig {
  explicit Rig(uint32_t base)
      : clock(base), watchdog(clock), http(clock), api(http, breaker, clock),
        lock(relayPin, gatelogic::kGateConfig.relayActiveHigh, gatelogic::kGateConfig.unlockEnergisesRelay),
        unlock(gatelogic::kGateConfig.unlockHardCapMs), roster(gatelogic::kGateConfig.rosterMaxAgeMs),
        queue(&store), app(wire()) {}

  gatelogic::GateApp::Ports wire() {
    gatelogic::GateApp::Ports ports;
    ports.clock = &clock;
    ports.scanner = &scanner;
    ports.watchdog = &watchdog;
    ports.link = &link;
    ports.api = &api;
    ports.breaker = &breaker;
    ports.lock = &lock;
    ports.unlock = &unlock;
    ports.led = &led;
    ports.ledPin = &ledPin;
    ports.ledActiveHigh = gatelogic::kGateConfig.ledActiveHigh;
    ports.assembler = &assembler;
    ports.debounce = &debounce;
    ports.roster = &roster;
    ports.queue = &queue;
    ports.mac = "5ccf7f0a1b2c";
    ports.firmwareVersion = "1.0.0";
    ports.heartbeatBody = heartbeatBody;
    ports.heartbeatBodyCap = sizeof(heartbeatBody);
    return ports;
  }

  /// Boot with no settling at all — the state a board is genuinely in on its
  /// first pass, with a `boot` event queued and a heartbeat armed for the link
  /// edge. The scenario that panicked the shipped firmware needs exactly this.
  void bootRaw(bool withLink) {
    app.beginOutputs();
    app.begin();
    link.set(withLink);
  }

  /// Boot, associate, drain the boot event and take the first heartbeat, then
  /// forget that it happened.
  ///
  /// Without this every scenario starts with two blocking calls it did not ask
  /// for, and an assertion about "the first heartbeat" is really an assertion
  /// about the third call. `accepted_through` is in the body because
  /// `applyEventReaction` releases on that field and nothing else — a 200 with
  /// no acknowledgement leaves the boot event in the ring forever, uploading
  /// once per pass.
  void boot(bool withLink) {
    bootRaw(true);
    http.setLatency(0U);
    http.answer(200U, "{\"kind\":\"gate\",\"roster\":[],\"accepted_through\":4294967295}");
    for (int i = 0; i < 6; ++i) {
      tick();
    }
    link.set(withLink);
    tick();
    http.forget();
    watchdog.forget();
  }

  /// Drop and re-associate the radio. The link-up edge arms the heartbeat for
  /// "now", which is how a test asks for one without ticking out a whole
  /// thirty-second interval. The heartbeat happens in the SECOND of these two
  /// passes, because pumpLink runs before pumpHeartbeat.
  void forceHeartbeat() {
    link.set(false);
    tick();
    link.set(true);
    tick();
  }

  /// One pass, then the idle delay the real loop takes.
  void tick() {
    app.pass();
    clock.advance(gatelogic::kIdleDelayMs);
  }

  /// Passes until the lock closes, or until `limit` of them. Answers the
  /// instant it closed.
  uint32_t runUntilLocked(uint32_t limit) {
    for (uint32_t i = 0U; i < limit && lock.released(); ++i) {
      tick();
    }
    return clock.value();
  }

  fakes::FakeClock clock;
  FakeWatchdog watchdog;
  FakeLink link;
  FakeScannerBytes scanner;
  LatentHttp http;
  devlink::ApiBreaker breaker;
  gatelogic::GateApi api;
  FakePinOut relayPin;
  FakePinOut ledPin;
  gatelogic::LockDriver lock;
  gatelogic::UnlockTimer unlock;
  gatelogic::LedPattern led;
  gatelogic::ScanAssembler assembler;
  gatelogic::ScanDebounce debounce;
  gatelogic::GateRoster roster;
  fakes::FakeStore store;
  gatelogic::GateQueue queue;
  char heartbeatBody[gatelogic::kGateResponseCap] = {};
  gatelogic::GateApp app;
};

constexpr char kOpenThreeSeconds[] = "{\"opened\":true,\"reason\":\"ok\",\"unlock_seconds\":3}";

/// (a) MUTATION-PROVED. The release window is timed from AFTER the HTTP call.
///
/// The shipped loop read the clock BEFORE `gApi.scan()` and armed the release
/// from that instant, so the call's own round trip came out of the member's
/// window: a 2.9-second round trip on a three-second grant was a 100-millisecond
/// relay pulse. The door did not open. The server logged an entry. Nothing on
/// the board or in the audit trail could tell that apart from a member who
/// walked through.
///
/// Put the clock read back before the call and every latency but 0 goes red.
void test_app_a_release_is_timed_from_after_the_call_that_granted_it() {
  const uint32_t latencies[] = {0U, 500U, 2900U, 4000U, 7999U};

  for (size_t b = 0U; b < kBaseCount; ++b) {
    for (uint32_t latency : latencies) {
      Rig rig(kBases[b]);
      rig.boot(true);
      rig.http.setLatency(latency);
      rig.http.answer(200U, kOpenThreeSeconds);
      rig.scanner.feed("7Q3F9KM2XZ8B\n");

      rig.tick(); // the scan, its call, and the release
      TEST_ASSERT_TRUE_MESSAGE(rig.lock.released(), "a 200 that opens must release the lock");
      const uint32_t opened = rig.clock.value() - gatelogic::kIdleDelayMs;

      const uint32_t closed = rig.runUntilLocked(4000U);
      TEST_ASSERT_FALSE_MESSAGE(rig.lock.released(), "the window has to end");

      const uint32_t held = tb::since(closed, opened);
      TEST_ASSERT_TRUE_MESSAGE(held >= 3000U, "the member was granted three seconds and must get them");
      TEST_ASSERT_TRUE_MESSAGE(held < 3000U + (2U * gatelogic::kIdleDelayMs),
                               "and not materially more than three seconds");
    }
  }
}

/// (b) The debounce window is stamped from AFTER the call too.
///
/// It measures from a DECISION, and the decision is not made until the call
/// returns. Stamped from before it, a scan that spent 2.9 s in an HTTP call has
/// already burnt most of its two-second window, so the scanner's next repeat —
/// a phone still held at the reader — becomes a second POST, a second audit row
/// and a re-armed lock.
void test_app_the_debounce_window_starts_when_the_decision_was_made() {
  Rig rig(kBaseWrapSoon);
  rig.boot(true);
  rig.http.setLatency(2900U);
  rig.http.answer(200U, kOpenThreeSeconds);

  rig.scanner.feed("7Q3F9KM2XZ8B\n");
  rig.tick();
  TEST_ASSERT_EQUAL_UINT16(1U, rig.http.calls());

  // The same phone, still there, 1.5 s after the decision — inside the 2 s
  // window however long the call took.
  rig.clock.advance(1500U);
  rig.scanner.feed("7Q3F9KM2XZ8B\n");
  rig.tick();
  TEST_ASSERT_EQUAL_UINT16_MESSAGE(1U, rig.http.calls(),
                                   "a repeat inside the window is not a second API call");

  // And outside it, it is a decision again.
  rig.clock.advance(2100U);
  rig.scanner.feed("7Q3F9KM2XZ8B\n");
  rig.tick();
  TEST_ASSERT_EQUAL_UINT16(2U, rig.http.calls());
}

/// (c) AT MOST ONE BLOCKING CALL PER PASS. MUTATION-PROVED.
///
/// The shipped loop could make five in one pass — three scans, an event upload
/// and a heartbeat — and kicked the watchdog once, at the top. Each call is
/// bounded by connect PLUS response, so one pass could run for 40 s against an
/// 8 s watchdog.
void test_app_a_pass_makes_at_most_one_blocking_call() {
  Rig rig(kBaseMid);
  rig.boot(true);
  rig.http.setLatency(gatelogic::kWorstBlockingCallMs);
  rig.http.answer(200U, kOpenThreeSeconds);

  // Three complete tokens, all in the buffer before the pass begins.
  rig.scanner.feed("TOKENAAAAAAA\nTOKENBBBBBBB\nTOKENCCCCCCC\n");
  rig.tick();

  TEST_ASSERT_EQUAL_UINT16_MESSAGE(1U, rig.app.blockingCallsLastPass(),
                                   "three scans in one pass are three passes' work");
  TEST_ASSERT_EQUAL_UINT16(1U, rig.http.calls());

  // The other two are not lost: they are still in the buffer and are decided on
  // the passes that follow.
  rig.tick();
  rig.tick();
  TEST_ASSERT_EQUAL_UINT16(3U, rig.http.calls());
}

/// (c) The watchdog is kicked immediately before and immediately after EVERY
/// blocking call, and never runs a whole worst-case call plus a pass unkicked.
void test_app_the_watchdog_is_kicked_around_every_blocking_call() {
  Rig rig(kBaseWrapSoon);
  rig.boot(true);
  rig.http.setLatency(gatelogic::kWorstBlockingCallMs);
  rig.http.answer(200U, kOpenThreeSeconds);
  rig.scanner.feed("TOKENAAAAAAA\n");

  for (int i = 0; i < 6; ++i) {
    rig.tick();
  }

  TEST_ASSERT_TRUE_MESSAGE(rig.http.calls() > 0U, "the scenario has to make calls to prove anything");
  for (size_t i = 0U; i < rig.http.calls(); ++i) {
    TEST_ASSERT_TRUE_MESSAGE(rig.watchdog.kickedAt(rig.http.enteredAt(i)),
                             "no kick immediately before a blocking call");
    TEST_ASSERT_TRUE_MESSAGE(rig.watchdog.kickedAt(rig.http.exitedAt(i)),
                             "no kick immediately after a blocking call");
  }

  TEST_ASSERT_TRUE_MESSAGE(rig.watchdog.longestGapMs() <
                               static_cast<uint32_t>(gatelogic::kGateConfig.watchdogSeconds) * 1000UL,
                           "the countdown ran for a whole watchdog period without a kick");
}

/// (c) THE SCENARIO THE REVIEW FOUND: a board booting against an API host that
/// silently drops packets, with members scanning at the door.
///
/// Every call spends its connect timeout AND its response timeout. The shipped
/// loop queued a `boot` event at setup, so pass one was an event upload plus a
/// heartbeat — 8 s against an 8 s watchdog — and the board panicked, reset,
/// booted, queued another `boot`, and did it again. It never loaded a roster,
/// so it never admitted anybody, forever, and the breaker could not help
/// because it needs two failures and the board never survived the first pass.
void test_app_a_dead_api_host_never_starves_the_watchdog_or_the_lock() {
  Rig rig(kBaseWrapSoon);
  rig.bootRaw(true); // the real first pass: a `boot` event queued, nothing drained
  rig.http.setLatency(gatelogic::kWorstBlockingCallMs);
  rig.http.answer(0U, ""); // no route, no host, no answer at all

  // A member with a rostered booking, so the fallback has something to do.
  const roster::Entry entries[] = {booking("7Q3F9KM2XZ8B", 0U, 3600000U)};
  loadRoster(rig.roster, rig.clock.value(), entries, 1U);

  for (int i = 0; i < 40; ++i) {
    if ((i % 7) == 0) {
      rig.scanner.feed("7Q3F9KM2XZ8B\n");
    }
    rig.tick();
    TEST_ASSERT_TRUE_MESSAGE(rig.app.blockingCallsLastPass() <= 1U, "one blocking call per pass, always");
  }

  TEST_ASSERT_TRUE_MESSAGE(rig.watchdog.longestGapMs() <
                               static_cast<uint32_t>(gatelogic::kGateConfig.watchdogSeconds) * 1000UL,
                           "a dead API host must not be able to trip the watchdog");
  TEST_ASSERT_TRUE_MESSAGE(rig.breaker.open(rig.clock.value()), "two failures open the breaker");
  // And the member still got in, from the roster, while all of that was
  // happening.
  TEST_ASSERT_TRUE_MESSAGE(rig.relayPin.opCount() > 2U, "the roster never moved the relay");
}

/// (d) THE TRUE BOUND ON A PHYSICAL RELEASE, pinned with its number.
///
/// The deadline is bounded by the hard cap and always was. What the deadline
/// does not bound is when the loop next looks at it, and the shipped loop
/// checked it once per pass BEFORE the blocking calls — so the relay stayed
/// closed for a whole pass's worth of them. README.md and GateConfig.h both
/// said the lock "can never" stay released longer than the cap, which was
/// false.
///
/// The true sentence: the release may outlive its deadline by at most ONE
/// worst-case blocking call plus one pass tick, because the deadline is
/// re-checked with a fresh clock immediately after every blocking call.
void test_app_a_release_outlives_its_deadline_by_at_most_one_blocking_call() {
  Rig rig(kBaseMid);
  rig.boot(true);
  rig.http.answer(200U, kOpenThreeSeconds);
  rig.http.setLatency(0U);

  rig.scanner.feed("7Q3F9KM2XZ8B\n");
  rig.tick();
  TEST_ASSERT_TRUE(rig.lock.released());
  const uint32_t opened = rig.clock.value() - gatelogic::kIdleDelayMs;

  // Now the API goes slow, and a heartbeat falls due in the middle of the
  // member's window. Every subsequent call spends its whole worst case.
  rig.http.setLatency(gatelogic::kWorstBlockingCallMs);
  rig.http.answer(0U, "");
  rig.link.set(false);
  rig.tick();
  rig.link.set(true); // the link edge arms the heartbeat for the next pass

  const uint32_t closed = rig.runUntilLocked(4000U);
  TEST_ASSERT_FALSE(rig.lock.released());

  const uint32_t held = tb::since(closed, opened);
  const uint32_t bound = 3000U + gatelogic::kWorstBlockingCallMs + gatelogic::kIdleDelayMs;
  TEST_ASSERT_TRUE_MESSAGE(held >= 3000U, "the window is still the window");
  TEST_ASSERT_TRUE_MESSAGE(held <= bound,
                           "a release may outlive its deadline by ONE blocking call, not by a pass");
}

/// (e) A UART OVERRUN COSTS ITS LINE AND NOTHING ELSE.
///
/// A serial FIFO overrun drops bytes silently: what `read()` hands up afterwards
/// is in order, printable, and has a hole in it. The assembler trims it, finds
/// it inside the token cap and emits a perfectly valid token that nobody
/// scanned — which is either a refusal for a member who is standing there or,
/// far worse, a match on somebody else's booking.
void test_app_an_rx_error_discards_the_line_it_holed_and_only_that_line() {
  Rig rig(kBaseMid);
  rig.boot(true);
  rig.http.answer(200U, kOpenThreeSeconds);

  // Half a line arrives, the driver drops the middle, the rest arrives.
  rig.scanner.feed("7Q3F9K");
  rig.tick();
  rig.scanner.signalRxError();
  rig.scanner.feed("XZ8B\n");
  rig.tick();
  TEST_ASSERT_EQUAL_UINT16_MESSAGE(0U, rig.http.calls(), "a holed line must not become a token");
  TEST_ASSERT_FALSE(rig.lock.released());

  // The NEXT line is clean, and is decided normally.
  rig.scanner.feed("K4TQ8N2ZV7BM\n");
  rig.tick();
  TEST_ASSERT_EQUAL_UINT16(1U, rig.http.calls());
  TEST_ASSERT_TRUE(rig.lock.released());
}

/// (e) And the assembler is empty at boot, as its own header has promised since
/// it was written. A board that reset mid-line came up holding the tail of
/// somebody's scan as the head of the next one.
void test_app_boot_and_a_link_event_throw_away_a_partial_line() {
  Rig rig(kBaseMid);
  rig.app.beginOutputs();
  // Bytes already in the assembler when the board comes up — a reset mid-scan.
  TEST_ASSERT_TRUE(feedLine(rig.assembler, "TAIL") == gatelogic::ScanEvent::None);
  rig.app.begin();
  rig.link.set(true);
  rig.http.answer(200U, kOpenThreeSeconds);
  rig.tick(); // let the link edge land, so the scan below takes the online path

  rig.scanner.feed("K4TQ8N2ZV7BM\n");
  rig.tick();
  TEST_ASSERT_EQUAL_STRING_MESSAGE("K4TQ8N2ZV7BM", rig.assembler.token(), "a partial line survived the boot");

  // A link edge does the same: the bytes in flight when the radio dropped are
  // not the head of the next scan.
  rig.scanner.feed("HALF");
  rig.tick();
  rig.link.set(false);
  rig.tick();
  rig.link.set(true);
  rig.tick();
  rig.scanner.feed("7Q3F9KM2XZ8B\n");
  rig.tick();
  TEST_ASSERT_EQUAL_STRING("7Q3F9KM2XZ8B", rig.assembler.token());
}

/// (g) The heartbeat interval is armed from AFTER the call.
///
/// Armed before it, every call's own duration comes out of the interval: a
/// four-second round trip on a thirty-second cadence is a board heartbeating
/// every twenty-six seconds, and against a dead host — where a call costs its
/// whole worst case — every twenty-two.
void test_app_the_heartbeat_interval_is_armed_after_the_call() {
  Rig rig(kBaseMid);
  rig.boot(true);
  rig.http.setLatency(gatelogic::kWorstBlockingCallMs);
  rig.http.answer(200U, "{\"kind\":\"gate\",\"roster\":[]}");

  rig.forceHeartbeat();
  TEST_ASSERT_EQUAL_UINT16_MESSAGE(1U, rig.http.calls(), "the first heartbeat");
  const uint32_t answeredAt = rig.clock.value() - gatelogic::kIdleDelayMs;

  // One tick short of a full interval AFTER the answer: still only one call.
  while (tb::since(rig.clock.value(), answeredAt) < rig.app.heartbeatIntervalMs() - 100U) {
    rig.tick();
  }
  TEST_ASSERT_EQUAL_UINT16_MESSAGE(1U, rig.http.calls(),
                                   "the interval ran from the request, not from the answer");

  while (tb::since(rig.clock.value(), answeredAt) < rig.app.heartbeatIntervalMs() + 100U) {
    rig.tick();
  }
  TEST_ASSERT_EQUAL_UINT16(2U, rig.http.calls());
}

/// (h) D4 at the heartbeat: a 403 commits an EMPTY roster.
///
/// The club took this board out of service. Leaving the roster in place would
/// keep the door admitting every rostered member for the full six-hour
/// staleness window afterwards — which is exactly what the admin pressed the
/// button to stop.
void test_app_a_403_on_the_heartbeat_commits_an_empty_roster() {
  Rig rig(kBaseMid);
  rig.boot(true);
  const roster::Entry entries[] = {booking("7Q3F9KM2XZ8B", 0U, 3600000U)};
  loadRoster(rig.roster, rig.clock.value(), entries, 1U);
  TEST_ASSERT_TRUE(rig.roster.decide("7Q3F9KM2XZ8B", roster::CourtCount(1U), rig.clock.value()).verdict ==
                   roster::Verdict::Allow);

  rig.http.answer(403U, "");
  rig.forceHeartbeat();
  TEST_ASSERT_EQUAL_UINT16_MESSAGE(1U, rig.http.calls(), "the heartbeat has to have happened");

  TEST_ASSERT_EQUAL_UINT8_MESSAGE(0U, rig.roster.size(), "a 403 empties the roster");
  TEST_ASSERT_TRUE_MESSAGE(rig.roster.everLoaded(), "empty, not never-loaded");
  TEST_ASSERT_TRUE(rig.roster.decide("7Q3F9KM2XZ8B", roster::CourtCount(1U), rig.clock.value()).verdict ==
                   roster::Verdict::Unknown);
}

/// (h) Every other status leaves the roster exactly as it was. An outage is not
/// a cancellation, and a board that blanked its roster on a 503 would refuse
/// every member for as long as a container took to restart.
void test_app_every_status_but_200_and_403_leaves_the_roster_alone() {
  const uint16_t statuses[] = {0U, 401U, 404U, 408U, 429U, 500U, 503U};

  for (uint16_t status : statuses) {
    Rig rig(kBaseMid);
    rig.boot(true);
    const roster::Entry entries[] = {booking("7Q3F9KM2XZ8B", 0U, 3600000U)};
    loadRoster(rig.roster, rig.clock.value(), entries, 1U);

    rig.http.answer(status, "");
    rig.forceHeartbeat();
    // The heartbeat has to have HAPPENED, or this asserts nothing at all: a
    // roster survives a heartbeat that never fired for free.
    TEST_ASSERT_EQUAL_UINT16_MESSAGE(1U, rig.http.calls(), "no heartbeat, no test");
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(1U, rig.roster.size(), "an outage is not a cancellation");
  }
}

/// (i) A heartbeat body the transport cut short never replaces the roster, and
/// never re-stamps its age. Proved at the loop level as well as in devlink,
/// because main.cpp threw the SyncResult away and nothing above could have
/// noticed either half of it.
void test_app_a_truncated_heartbeat_body_never_replaces_the_roster() {
  Rig rig(kBaseMid);
  rig.boot(true);
  const roster::Entry entries[] = {booking("7Q3F9KM2XZ8B", 0U, 3600000U)};
  loadRoster(rig.roster, rig.clock.value(), entries, 1U);
  const uint32_t loadedAt = rig.clock.value();

  rig.http.answer(200U, "{\"kind\":\"gate\",\"roster\":[\"TOKBOB|0|0|3600\",\"TOKCA");
  rig.forceHeartbeat();
  TEST_ASSERT_EQUAL_UINT16(1U, rig.http.calls());

  TEST_ASSERT_FALSE_MESSAGE(rig.app.lastSync().replaced, "a cut body is not a push");
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(1U, rig.roster.size(), "the old roster survives");
  TEST_ASSERT_TRUE(rig.roster.decide("7Q3F9KM2XZ8B", roster::CourtCount(1U), rig.clock.value()).verdict ==
                   roster::Verdict::Allow);
  // ...and its age still runs from the push that actually filled it.
  TEST_ASSERT_EQUAL_UINT32(tb::since(rig.clock.value(), loadedAt), rig.roster.ageMs(rig.clock.value()));
}

/// A queued `gate_open` carries what the lock was ACTUALLY GIVEN, not what was
/// asked for. The two differ whenever the hard cap bites — a second member
/// scanning 29.5 s into a 30 s window extends the door by 500 ms, and an event
/// claiming 30 000 is a club reading an audit trail that says the door stood
/// open for half a minute twice over.
void test_app_a_queued_open_carries_what_the_lock_was_given() {
  Rig rig(kBaseMid);
  // A thirty-second release, which is the hard cap itself, adopted from a
  // heartbeat before the radio drops.
  rig.bootRaw(true);
  rig.http.answer(200U, "{\"kind\":\"gate\",\"gate\":{\"unlock_seconds\":30},\"roster\":[],"
                        "\"accepted_through\":4294967295}");
  for (int i = 0; i < 6; ++i) {
    rig.tick();
  }
  TEST_ASSERT_EQUAL_UINT32(30000U, rig.app.unlockMs());

  // Offline from here: only a decision this board made itself is queued.
  rig.link.set(false);
  rig.tick();
  const roster::Entry entries[] = {booking("TOKENAAAAAAA", 0U, 3600000U),
                                   booking("TOKENBBBBBBB", 0U, 3600000U)};
  loadRoster(rig.roster, rig.clock.value(), entries, 2U);

  rig.scanner.feed("TOKENAAAAAAA\n");
  rig.tick();
  TEST_ASSERT_TRUE(rig.lock.released());

  // A second member, 29.5 s in. The window may not pass the cap measured from
  // the moment the door first opened, so they get 500 ms and not 30 000.
  rig.clock.advance(29500U);
  rig.scanner.feed("TOKENBBBBBBB\n");
  rig.tick();

  eventq::Event event;
  uint32_t lastOpenDuration = 0U;
  while (rig.queue.peek(event)) {
    if (event.kind == eventq::Kind::GateOpen) {
      lastOpenDuration = event.durationMs;
    }
    static_cast<void>(rig.queue.release());
  }
  TEST_ASSERT_TRUE_MESSAGE(lastOpenDuration <= 1000U,
                           "the event claimed a release the hard cap never allowed");
  TEST_ASSERT_TRUE_MESSAGE(lastOpenDuration > 0U, "and it was released for something");
}

/// An unreadable line asks the SAME question a scan does — the radio and the
/// breaker — rather than the radio alone. A board whose breaker has opened
/// cannot reach the API either, so it has to record what it refused.
void test_app_an_unreadable_line_queues_on_the_same_judgement_a_scan_makes() {
  Rig rig(kBaseMid);
  rig.boot(true);
  rig.http.setLatency(gatelogic::kWorstBlockingCallMs);
  rig.http.answer(0U, "");

  // Two transport failures open the breaker. The radio never drops.
  rig.scanner.feed("TOKENAAAAAAA\nTOKENBBBBBBB\n");
  rig.tick();
  rig.tick();
  TEST_ASSERT_TRUE_MESSAGE(rig.breaker.open(rig.clock.value()), "the scenario needs an open breaker");

  // Drain everything queued so far, then send a line over the token cap.
  eventq::Event event;
  while (rig.queue.peek(event)) {
    static_cast<void>(rig.queue.release());
  }
  char over[roster::kMaxTokenLen + 3U] = {};
  for (size_t i = 0U; i < roster::kMaxTokenLen + 1U; ++i) {
    over[i] = 'B';
  }
  over[roster::kMaxTokenLen + 1U] = '\n';
  rig.scanner.feed(over);
  rig.tick();

  TEST_ASSERT_TRUE_MESSAGE(rig.queue.peek(event),
                           "an unreadable line with the API unreachable must be recorded");
  TEST_ASSERT_TRUE(event.kind == eventq::Kind::UnknownScan);
}

} // namespace

void setUp() {
}

void tearDown() {
}

int main(int, char**) {
  UNITY_BEGIN();

  RUN_TEST(test_config_defaults_are_carls_wiring);
  RUN_TEST(test_config_token_cap_matches_the_roster);

  RUN_TEST(test_lock_level_for_all_four_polarity_combinations);
  RUN_TEST(test_lock_boot_writes_the_locked_level_before_the_pin_drives_anything);
  RUN_TEST(test_lock_set_drives_the_level_its_wiring_calls_for);

  RUN_TEST(test_unlock_opens_once_and_closes_once_at_every_clock_base);
  RUN_TEST(test_unlock_a_re_arm_never_shortens_the_window);
  RUN_TEST(test_unlock_the_hard_cap_bounds_both_one_answer_and_the_whole_window);
  RUN_TEST(test_unlock_reports_how_long_it_has_been_released);

  RUN_TEST(test_scan_assembles_a_line_and_treats_crlf_as_one_terminator);
  RUN_TEST(test_scan_trims_and_ignores_an_empty_line);
  RUN_TEST(test_scan_refuses_a_token_one_character_over_the_cap_without_truncating);
  RUN_TEST(test_scan_a_non_printable_byte_discards_the_whole_line);
  RUN_TEST(test_scan_reset_discards_a_partial_line);

  RUN_TEST(test_debounce_suppresses_the_same_token_inside_the_window_and_not_outside_it);
  RUN_TEST(test_debounce_never_suppresses_a_different_token);
  RUN_TEST(test_debounce_measures_from_the_decision_not_from_the_scan);

  RUN_TEST(test_flow_asks_the_api_only_with_a_link_and_a_closed_breaker);
  RUN_TEST(test_flow_scan_body_is_refused_rather_than_truncated);
  RUN_TEST(test_flow_the_status_table_says_which_statuses_are_answers);
  RUN_TEST(test_flow_a_403_denies_with_its_own_reason_and_no_roster_fallback);
  RUN_TEST(test_flow_a_200_refusal_is_never_second_guessed_against_the_roster);
  RUN_TEST(test_flow_a_malformed_200_falls_back_rather_than_refusing);
  RUN_TEST(test_flow_an_open_carries_the_servers_seconds_clamped_at_both_ends);
  RUN_TEST(test_flow_a_reason_that_names_the_unlock_key_does_not_hide_it);
  RUN_TEST(test_flow_a_roster_open_is_queued_and_a_roster_refusal_is_too);
  RUN_TEST(test_flow_a_stale_roster_admits_nobody);
  RUN_TEST(test_flow_a_gate_that_has_never_heard_from_the_api_admits_nobody);
  RUN_TEST(test_flow_an_unreadable_scan_is_refused_and_queued_only_while_offline);

  RUN_TEST(test_api_a_scan_posts_the_contract_body_to_the_gate_path);
  RUN_TEST(test_api_two_transport_failures_send_the_next_scan_straight_to_the_roster);
  RUN_TEST(test_api_an_unrenderable_body_is_not_a_transport_failure);
  RUN_TEST(test_api_the_heartbeat_posts_the_gate_kind_and_hands_back_the_response);

  RUN_TEST(test_heartbeat_body_carries_kind_last_and_refuses_rather_than_truncating);
  RUN_TEST(test_heartbeat_adopts_the_gate_objects_unlock_seconds_and_clamps_it);
  RUN_TEST(test_heartbeat_ignores_an_unlock_seconds_outside_the_gate_object);

  RUN_TEST(test_led_level_for_both_polarities);
  RUN_TEST(test_led_is_solid_while_the_lock_is_released_whatever_else_is_happening);
  RUN_TEST(test_led_blinks_three_times_for_a_refusal_and_twice_at_boot);
  RUN_TEST(test_led_blinks_slowly_while_the_radio_is_down_and_is_dark_when_it_is_up);
  RUN_TEST(test_led_a_cue_outranks_the_link_blink_and_then_gives_it_back);

  RUN_TEST(test_static_text_compares_at_compile_time);
  RUN_TEST(test_url_accepts_only_cleartext_http_to_an_ipv4_literal);

  RUN_TEST(test_app_a_release_is_timed_from_after_the_call_that_granted_it);
  RUN_TEST(test_app_the_debounce_window_starts_when_the_decision_was_made);
  RUN_TEST(test_app_a_pass_makes_at_most_one_blocking_call);
  RUN_TEST(test_app_the_watchdog_is_kicked_around_every_blocking_call);
  RUN_TEST(test_app_a_dead_api_host_never_starves_the_watchdog_or_the_lock);
  RUN_TEST(test_app_a_release_outlives_its_deadline_by_at_most_one_blocking_call);
  RUN_TEST(test_app_an_rx_error_discards_the_line_it_holed_and_only_that_line);
  RUN_TEST(test_app_boot_and_a_link_event_throw_away_a_partial_line);
  RUN_TEST(test_app_the_heartbeat_interval_is_armed_after_the_call);
  RUN_TEST(test_app_a_403_on_the_heartbeat_commits_an_empty_roster);
  RUN_TEST(test_app_every_status_but_200_and_403_leaves_the_roster_alone);
  RUN_TEST(test_app_a_truncated_heartbeat_body_never_replaces_the_roster);
  RUN_TEST(test_app_a_queued_open_carries_what_the_lock_was_given);
  RUN_TEST(test_app_an_unreadable_line_queues_on_the_same_judgement_a_scan_makes);

  return UNITY_END();
}

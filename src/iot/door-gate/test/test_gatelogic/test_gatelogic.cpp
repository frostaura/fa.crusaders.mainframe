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
#include "gatelogic/GateApi.h"
#include "gatelogic/GateConfig.h"
#include "gatelogic/GateFlow.h"
#include "gatelogic/GateHeartbeat.h"
#include "gatelogic/HttpPort.h"
#include "gatelogic/LedPattern.h"
#include "gatelogic/LockDriver.h"
#include "gatelogic/ScanAssembler.h"
#include "gatelogic/ScanDebounce.h"
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

/// Every status that is not 200 says the board learned NOTHING about this
/// member — including the 4xx classes devapi::react() would call "the box's own
/// fault and safe to drop". For an event upload that is right; for a door it
/// would leave a member with a booking outside because a proxy answered 404.
void test_flow_every_status_but_200_falls_back_to_the_roster() {
  constexpr uint16_t statuses[] = {0U, 204U, 301U, 400U, 401U, 403U, 404U, 429U, 500U, 502U, 503U, 504U};
  const char* answer = "{\"opened\":true,\"reason\":\"ok\",\"unlock_seconds\":3}";

  for (uint16_t status : statuses) {
    const gatelogic::ScanDecision decision =
        gatelogic::onGateResponse(status, answer, strlen(answer), kDefaultMs, kCapMs);
    TEST_ASSERT_TRUE_MESSAGE(decision.fallbackToRoster, "only a 200 is an answer");
    TEST_ASSERT_FALSE(decision.released);
    TEST_ASSERT_FALSE(decision.queueEvent);
  }
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

/// The search starts at the `gate` key. A response that happened to carry an
/// `unlock_seconds` somewhere else — a future field, a nested object — must not
/// be read as this one.
void test_heartbeat_ignores_an_unlock_seconds_outside_the_gate_object() {
  const char* body =
      "{\"kind\":\"gate\",\"legacy\":{\"unlock_seconds\":29},\"gate\":{\"unlock_seconds\":4},\"roster\":[]}";
  uint32_t unlockMs = 0U;
  TEST_ASSERT_TRUE(gatelogic::adoptUnlockMs(body, strlen(body), unlockMs));
  TEST_ASSERT_EQUAL_UINT32(4000U, unlockMs);
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
  RUN_TEST(test_flow_every_status_but_200_falls_back_to_the_roster);
  RUN_TEST(test_flow_a_200_refusal_is_never_second_guessed_against_the_roster);
  RUN_TEST(test_flow_a_malformed_200_falls_back_rather_than_refusing);
  RUN_TEST(test_flow_an_open_carries_the_servers_seconds_clamped_at_both_ends);
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

  return UNITY_END();
}

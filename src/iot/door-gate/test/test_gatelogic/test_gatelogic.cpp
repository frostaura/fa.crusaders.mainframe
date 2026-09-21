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
#include <stdio.h>
#include <string.h>
#include <unity.h>

#include <new>

#include "hal/PinLevel.h"

#include "devlink/ApiBreaker.h"
#include "devlink/EventUpload.h"
#include "devlink/RosterSync.h"
#include "eventq/Event.h"
#include "fakes/FakeClock.h"
#include "fakes/FakeStore.h"
#include "gatelogic/ApiBaseUrl.h"
#include "gatelogic/BootRecovery.h"
#include "gatelogic/GateApi.h"
#include "gatelogic/GateApp.h"
#include "gatelogic/GateConfig.h"
#include "gatelogic/GateFlow.h"
#include "gatelogic/GateHeartbeat.h"
#include "gatelogic/GatePorts.h"
#include "gatelogic/HttpPort.h"
#include "gatelogic/LedPattern.h"
#include "gatelogic/LockDriver.h"
#include "gatelogic/ResponseBody.h"
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
constexpr uint32_t kDwellMs = gatelogic::kGateConfig.relockDwellMs;
constexpr uint32_t kMinRelockMs = gatelogic::kGateConfig.minRelockMs;
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

  gatelogic::HttpOutcome post(const char* path, const char* body, char* out, size_t outCap) override {
    ++calls_;
    strncpy(path_, path, sizeof(path_) - 1U);
    path_[sizeof(path_) - 1U] = '\0';
    strncpy(body_, body, sizeof(body_) - 1U);
    body_[sizeof(body_) - 1U] = '\0';
    if (out != nullptr && outCap > 0U) {
      strncpy(out, answer_, outCap - 1U);
      out[outCap - 1U] = '\0';
    }
    // A fake whose body always arrives: `status` and `peerStatus` agree. The
    // case where they do NOT is scripted on LatentHttp, which is where the
    // scenarios that care about it live.
    return gatelogic::HttpOutcome{status_, status_};
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

/// A timer wired the way the board wires it, so a test can never accidentally
/// build one without the dwells that make the hard cap a bound on the DOOR.
gatelogic::UnlockTimer boardTimer() {
  return gatelogic::UnlockTimer(kCapMs, kMinRelockMs, kDwellMs);
}

void test_unlock_opens_once_and_closes_once_at_every_clock_base() {
  for (size_t b = 0U; b < kBaseCount; ++b) {
    const uint32_t base = kBases[b];
    gatelogic::UnlockTimer timer = boardTimer();

    TEST_ASSERT_TRUE_MESSAGE(timer.request(base, 3000U) == gatelogic::UnlockTimer::Grant::Opened,
                             "the first request is the opening edge");
    TEST_ASSERT_TRUE(timer.released());
    TEST_ASSERT_TRUE(timer.tick(base + 2999U) == gatelogic::UnlockTimer::Close::None);
    TEST_ASSERT_TRUE(timer.released());

    TEST_ASSERT_TRUE_MESSAGE(timer.tick(base + 3000U) == gatelogic::UnlockTimer::Close::WindowEnded,
                             "the deadline is the closing edge");
    TEST_ASSERT_FALSE(timer.released());
    // Exactly once. A second edge would queue a second event and write the
    // relay again for a door that is already shut.
    TEST_ASSERT_TRUE(timer.tick(base + 3001U) == gatelogic::UnlockTimer::Close::None);
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
    gatelogic::UnlockTimer timer = boardTimer();

    static_cast<void>(timer.request(base, 10000U));
    // A shorter grant, one second in. 9 s are left; a 1 s grant must not win.
    TEST_ASSERT_TRUE_MESSAGE(timer.request(base + 1000U, 1000U) == gatelogic::UnlockTimer::Grant::Extended,
                             "a re-arm is not an opening edge");
    TEST_ASSERT_EQUAL_UINT32(9000U, timer.remainingMs(base + 1000U));
    TEST_ASSERT_TRUE(timer.tick(base + 9999U) == gatelogic::UnlockTimer::Close::None);
    TEST_ASSERT_TRUE(timer.tick(base + 10000U) == gatelogic::UnlockTimer::Close::WindowEnded);

    // A LONGER grant does extend.
    gatelogic::UnlockTimer other = boardTimer();
    static_cast<void>(other.request(base, 3000U));
    TEST_ASSERT_TRUE(other.request(base + 1000U, 5000U) == gatelogic::UnlockTimer::Grant::Extended);
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

    gatelogic::UnlockTimer single = boardTimer();
    static_cast<void>(single.request(base, 600000U)); // ten minutes, asked for once
    TEST_ASSERT_EQUAL_UINT32(kCapMs, single.remainingMs(base));
    TEST_ASSERT_TRUE(single.tick(base + kCapMs) == gatelogic::UnlockTimer::Close::CapForced);

    gatelogic::UnlockTimer repeated = boardTimer();
    static_cast<void>(repeated.request(base, 3000U));
    // Somebody scanning every two seconds, forever.
    for (uint32_t t = 2000U; t <= 120000U; t += 2000U) {
      if (repeated.tick(base + t) != gatelogic::UnlockTimer::Close::None) {
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

/// G4 / A1, CRITICAL, AND THE TEST ABOVE IS WHY IT SURVIVED THREE ROUNDS.
///
/// That test `break`s at the first close, so all it can ever prove is that ONE
/// window shuts. The cap is a bound on a WINDOW, and the very next accepted scan
/// opens a fresh one — legally. Measured on the real simulator with two
/// alternating tokens every 50 ms: relay OFF at t=31034 ms and ON at t=31034 ms,
/// dark for 0 ms, then +42 ms, then +45 ms, for ever. The door physically never
/// relocked and no single request broke any rule.
///
/// So this one KEEPS SCANNING past the cap, for two minutes of simulated time,
/// at every clock base and at both cadences the finder used — the one-token one
/// that the debounce's phase happened to save, and the two-token one it does
/// not. What it measures is the thing that matters to a lock: DARK TIME.
void test_unlock_a_capped_window_is_followed_by_real_dark_time() {
  struct Row {
    const char* label;
    uint32_t everyMs; ///< how often a decision is offered
  };

  const Row rows[] = {
      {"a decision every pass — two alternating tokens, no debounce", 10U},
      {"a decision every 2010 ms — one token, at the debounce's own cadence", 2010U},
  };

  for (size_t b = 0U; b < kBaseCount; ++b) {
    for (const Row& row : rows) {
      gatelogic::UnlockTimer timer = boardTimer();
      static_cast<void>(timer.request(kBases[b], 3000U));

      uint32_t releasedFor = 0U;     ///< longest continuous released stretch
      uint32_t darkAfterCap = 0U;    ///< dark time following the FIRST capped close
      uint32_t openedAt = kBases[b]; ///< start of the current released stretch
      uint32_t closedAt = 0U;
      bool capped = false;
      bool reopenedAfterCap = false;

      for (uint32_t t = 10U; t <= 120000U; t += 10U) {
        const uint32_t now = kBases[b] + t;
        // THE BOARD'S OWN ORDER: `pass()` pumps the lock — including out of
        // `afterBlocking()`, inside the very call that decided the scan — and
        // then applies the decision. Any other order here would be testing a
        // loop this firmware does not have.
        const gatelogic::UnlockTimer::Close closed = timer.tick(now);
        if (closed != gatelogic::UnlockTimer::Close::None) {
          closedAt = now;
          const uint32_t held = tb::since(now, openedAt);
          if (held > releasedFor) {
            releasedFor = held;
          }
          if (closed == gatelogic::UnlockTimer::Close::CapForced && !capped) {
            capped = true;
          }
        }
        if ((t % row.everyMs) < 10U) {
          const gatelogic::UnlockTimer::Grant grant = timer.request(now, 3000U);
          if (grant == gatelogic::UnlockTimer::Grant::Opened) {
            openedAt = now;
            if (capped && !reopenedAfterCap) {
              reopenedAfterCap = true;
              darkAfterCap = tb::since(now, closedAt);
            }
          }
        }
      }

      char message[224] = {};
      snprintf(message, sizeof(message), "base %lu, %s: longest release %lu ms, dark after the cap %lu ms",
               static_cast<unsigned long>(kBases[b]), row.label, static_cast<unsigned long>(releasedFor),
               static_cast<unsigned long>(darkAfterCap));

      TEST_ASSERT_TRUE_MESSAGE(capped, message);
      // THE BOUND ON THE WINDOW, which held before this round and still does.
      TEST_ASSERT_TRUE_MESSAGE(releasedFor <= kCapMs, message);
      // THE BOUND ON THE DOOR, which did not exist. A relay written OFF and ON
      // at the same millisecond is a lock that was never de-energised: the
      // strike does not drop and the maglock keeps its armature.
      TEST_ASSERT_TRUE_MESSAGE(reopenedAfterCap, message);
      TEST_ASSERT_TRUE_MESSAGE(darkAfterCap >= kDwellMs, message);
    }
  }
}

/// G4 / A1's other half: EVERY close owes dark time, not only a capped one.
///
/// `pass()` calls `pumpLock()` out of `afterBlocking()` and applies the
/// decision that blocking call produced two lines later, so an ordinary
/// three-second window can close in the same pass that an API-approved scan
/// re-opens it. Two back-to-back members would be one continuous opening with
/// two audit rows and a lock that never moved.
void test_unlock_any_close_guarantees_the_lock_actually_relatches() {
  for (size_t b = 0U; b < kBaseCount; ++b) {
    const uint32_t base = kBases[b];
    gatelogic::UnlockTimer timer = boardTimer();

    static_cast<void>(timer.request(base, 3000U));
    TEST_ASSERT_TRUE(timer.tick(base + 3000U) == gatelogic::UnlockTimer::Close::WindowEnded);

    // The same millisecond, which is the measured case.
    TEST_ASSERT_TRUE_MESSAGE(timer.request(base + 3000U, 3000U) == gatelogic::UnlockTimer::Grant::Relocking,
                             "a relay written OFF and ON at one instant was never de-energised");
    TEST_ASSERT_FALSE(timer.released());
    TEST_ASSERT_TRUE(timer.relocking(base + 3000U));
    TEST_ASSERT_EQUAL_UINT32(kMinRelockMs, timer.relockingForMs(base + 3000U));

    // One millisecond short of the floor is still refused...
    TEST_ASSERT_TRUE(timer.request(base + 3000U + kMinRelockMs - 1U, 3000U) ==
                     gatelogic::UnlockTimer::Grant::Relocking);
    // ...and at the floor the member comes in.
    TEST_ASSERT_TRUE(timer.request(base + 3000U + kMinRelockMs, 3000U) ==
                     gatelogic::UnlockTimer::Grant::Opened);
    TEST_ASSERT_TRUE(timer.released());
    TEST_ASSERT_FALSE_MESSAGE(timer.relocking(base + 3000U + kMinRelockMs),
                              "a dwell is about a CLOSED door and must not survive the open");

    // AND THE FLOOR IS NOT THE DWELL. A capped close owes the longer one, so
    // the two constants cannot be collapsed into one by a later edit without
    // this going red.
    gatelogic::UnlockTimer capped = boardTimer();
    static_cast<void>(capped.request(base, kCapMs));
    TEST_ASSERT_TRUE(capped.tick(base + kCapMs) == gatelogic::UnlockTimer::Close::CapForced);
    TEST_ASSERT_EQUAL_UINT32(kDwellMs, capped.relockingForMs(base + kCapMs));
    TEST_ASSERT_TRUE(capped.request(base + kCapMs + kDwellMs - 1U, 3000U) ==
                     gatelogic::UnlockTimer::Grant::Relocking);
    TEST_ASSERT_TRUE(capped.request(base + kCapMs + kDwellMs, 3000U) ==
                     gatelogic::UnlockTimer::Grant::Opened);
  }
}

void test_unlock_reports_how_long_it_has_been_released() {
  gatelogic::UnlockTimer timer = boardTimer();
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

/// Quotes that actually delimit a JSON string: a `"` not preceded by an odd
/// number of backslashes. The one structural fact a forged field has to break.
size_t unescapedQuotes(const char* body) {
  size_t count = 0U;
  size_t slashes = 0U;
  for (size_t i = 0U; body[i] != '\0'; ++i) {
    if (body[i] == '\\') {
      ++slashes;
      continue;
    }
    if (body[i] == '"' && (slashes % 2U) == 0U) {
      ++count;
    }
    slashes = 0U;
  }
  return count;
}

size_t occurrences(const char* haystack, const char* needle) {
  size_t count = 0U;
  const char* at = haystack;
  while ((at = strstr(at, needle)) != nullptr) {
    ++count;
    at += strlen(needle);
  }
  return count;
}

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
  // CORRUPT, NOT NONE (round G4, L1). The line is still discarded — nothing is
  // handed up and no token is offered — but the caller is told, so the member
  // standing there gets the denial blink instead of silence.
  TEST_ASSERT_TRUE(feedLine(assembler, "TOKEN\n") == gatelogic::ScanEvent::Corrupt);

  // And the next line is unaffected.
  TEST_ASSERT_TRUE(feedLine(assembler, "CLEAN1\n") == gatelogic::ScanEvent::Token);
  TEST_ASSERT_EQUAL_STRING("CLEAN1", assembler.token());

  // A high byte from a framing error costs the line too.
  TEST_ASSERT_TRUE(feedLine(assembler, "AB") == gatelogic::ScanEvent::None);
  TEST_ASSERT_TRUE(assembler.feed(0xFEU) == gatelogic::ScanEvent::None);
  TEST_ASSERT_TRUE(feedLine(assembler, "CD\n") == gatelogic::ScanEvent::Corrupt);
}

/// G4 / B1. THE LINE IS HELD TO THE ROSTER'S OWN ALPHABET, not to "printable".
///
/// Printable ASCII includes `"` and `\`, and the token was interpolated into a
/// JSON body with a bare `%s`. A token outside `roster::isTokenChar` can never
/// match anything in the roster and can never be a code the server minted, so
/// admitting one was only ever a refusal taken slowly — by way of a blocking
/// call, or of bytes written into an audit trail that nobody scanned.
void test_scan_refuses_every_byte_outside_the_rosters_token_alphabet() {
  // Exhaustive over the whole byte range, which is the only way to be sure the
  // set the SCANNER admits is the set the ROSTER can hold.
  for (unsigned value = 0U; value < 256U; ++value) {
    const uint8_t byte = static_cast<uint8_t>(value);
    if (gatelogic::isLineTerminator(byte)) {
      continue;
    }
    gatelogic::ScanAssembler assembler;
    static_cast<void>(assembler.feed(static_cast<uint8_t>('A')));
    static_cast<void>(assembler.feed(byte));
    const gatelogic::ScanEvent result = assembler.feed(static_cast<uint8_t>('\n'));

    char message[96] = {};
    snprintf(message, sizeof(message), "byte 0x%02X in a line", value);
    const bool trimmable = byte == static_cast<uint8_t>(' ') || byte == static_cast<uint8_t>('\t');
    if (roster::isTokenChar(static_cast<char>(byte)) || trimmable) {
      TEST_ASSERT_TRUE_MESSAGE(result == gatelogic::ScanEvent::Token, message);
    } else {
      TEST_ASSERT_TRUE_MESSAGE(result == gatelogic::ScanEvent::Corrupt, message);
    }
  }

  // The two that matter most, named so a reader does not have to derive them:
  // these are the bytes B1's forged bodies were made of.
  gatelogic::ScanAssembler assembler;
  TEST_ASSERT_TRUE(feedLine(assembler, "a\",\"method\":\"code\n") == gatelogic::ScanEvent::Corrupt);
  TEST_ASSERT_TRUE(feedLine(assembler, "a\\\n") == gatelogic::ScanEvent::Corrupt);
  // And the roster's own grammar still gets through whole.
  TEST_ASSERT_TRUE(feedLine(assembler, "7Q3F9KM2XZ8B\n") == gatelogic::ScanEvent::Token);
  TEST_ASSERT_EQUAL_STRING("7Q3F9KM2XZ8B", assembler.token());
  TEST_ASSERT_TRUE(feedLine(assembler, "a-b_C9\n") == gatelogic::ScanEvent::Token);
  TEST_ASSERT_EQUAL_STRING("a-b_C9", assembler.token());
}

/// G4 / B1, CRITICAL. A QR CODE COULD FORGE THE FIELDS AROUND IT.
///
/// `renderScanBody` interpolated the scanned bytes with a bare `%s`, and the
/// assembler admitted every printable byte including `"` and `\`. Twenty
/// characters is enough: `a","method":"code` re-writes `method`, and the
/// assembler's own cap is the only thing that ever refused one.
///
/// FUZZED rather than enumerated, because the property is "no byte sequence
/// ever leaves the string" and a list of five is a list of the five somebody
/// thought of. Every line the ASSEMBLER accepts is rendered and the result is
/// checked against the one structural fact that matters: the body has exactly
/// as many unescaped quotes as its own fixed shape.
void test_render_no_scanned_line_can_forge_a_field_in_the_scan_body() {
  // The alphabet a hostile QR can be made of: the JSON metacharacters, a
  // backslash, and enough ordinary bytes that a sequence looks like a token.
  static const char kAlphabet[] = "\"\\\\:,{}[]abAB01-_ \t";
  const size_t alphabetLen = sizeof(kAlphabet) - 1U;

  uint32_t state = 0x13579BDFU;
  for (int iteration = 0; iteration < 20000; ++iteration) {
    char line[roster::kMaxTokenLen + 2U] = {};
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    const size_t length = 1U + (state % roster::kMaxTokenLen);
    for (size_t i = 0U; i < length; ++i) {
      state ^= state << 13;
      state ^= state >> 17;
      state ^= state << 5;
      line[i] = kAlphabet[state % alphabetLen];
    }
    line[length] = '\n';

    // THROUGH THE REAL ASSEMBLER: only what the board would actually hand to
    // `decideScan` is rendered, so this cannot pass by testing a token the
    // firmware would have refused anyway.
    gatelogic::ScanAssembler assembler;
    if (feedLine(assembler, line) != gatelogic::ScanEvent::Token) {
      continue;
    }

    char body[gatelogic::kScanBodyCap] = {};
    const size_t written = gatelogic::renderScanBody(body, sizeof(body), "5ccf7f0a1b2c", assembler.token());
    if (written == 0U) {
      continue; // refused rather than rendered, which is also safe
    }

    char message[256] = {};
    snprintf(message, sizeof(message), "token %s produced %s", assembler.token(), body);
    // The shape is `{"mac":"..","method":"qr","token":".."}` — six keys and
    // values in quotes, so exactly twelve unescaped quotes and no more. A byte
    // that escaped the string adds two.
    TEST_ASSERT_EQUAL_size_t_MESSAGE(12U, unescapedQuotes(body), message);
    // And the one field a forged `method` would change is still `qr`.
    TEST_ASSERT_NOT_NULL_MESSAGE(strstr(body, "\"method\":\"qr\","), message);
    TEST_ASSERT_EQUAL_size_t_MESSAGE(1U, occurrences(body, "\"method\":"), message);
    TEST_ASSERT_EQUAL_size_t_MESSAGE(1U, occurrences(body, "\"mac\":"), message);
    TEST_ASSERT_EQUAL_size_t_MESSAGE(1U, occurrences(body, "\"token\":"), message);
  }
}

/// G4 / B1, the second layer: the SHARED event body, which the court box uses
/// too and which carries an offline refusal's own bytes as `subject`.
///
/// `","seq":99999,"x":"` is nineteen characters. Rendered raw it forged the
/// batch's `seq`, and the server answers `accepted_through` from the seq it
/// PARSED — so one crafted QR scanned while a door was offline discarded the
/// whole evening's backlog on reconnect.
void test_render_no_scanned_subject_can_forge_a_field_in_the_event_body() {
  static const char* kHostile[] = {
      "\",\"seq\":99999,\"x\":\"",
      "\",\"kind\":\"release",
      "\",\"court\":0,\"x\":\"",
      "\",\"duration_ms\":9,\"x\":\"",
      "a\\",
      "a\"b",
      "\\\\\\\\\"",
  };
  for (size_t i = 0U; i < sizeof(kHostile) / sizeof(kHostile[0]); ++i) {
    eventq::Event event;
    event.seq = 7U;
    event.kind = eventq::Kind::UnknownScan;
    event.court = eventq::Event::kNoCourt;
    event.method = eventq::Method::Qr;
    event.uptimeMs = 1000U;
    static_cast<void>(event.setSubject(kHostile[i]));

    char body[devlink::kEventBodyCap] = {};
    const size_t written = devlink::renderEventBody(body, sizeof(body), "5ccf7f0a1b2c", 0U, 2000ULL, event);
    char message[384] = {};
    snprintf(message, sizeof(message), "subject %s produced %s", kHostile[i], body);
    TEST_ASSERT_TRUE_MESSAGE(written > 0U, message);
    // `{"mac":"..","uptime_ms":N,"events":[{"seq":N,"uptime_ms":N,"kind":"..",
    //   "court":N,"method":"..","subject":"..","duration_ms":N}]}` — ten keys
    // and four quoted values, so twenty-eight unescaped quotes exactly. A byte
    // that escaped the string adds two; the raw renderer produced 34 for the
    // first subject below, which is its own six quotes let straight through.
    TEST_ASSERT_EQUAL_size_t_MESSAGE(28U, unescapedQuotes(body), message);
    TEST_ASSERT_EQUAL_size_t_MESSAGE(1U, occurrences(body, "\"seq\":"), message);
    TEST_ASSERT_EQUAL_size_t_MESSAGE(1U, occurrences(body, "\"kind\":"), message);
    TEST_ASSERT_EQUAL_size_t_MESSAGE(1U, occurrences(body, "\"court\":"), message);
    TEST_ASSERT_EQUAL_size_t_MESSAGE(1U, occurrences(body, "\"duration_ms\":"), message);
    TEST_ASSERT_NOT_NULL_MESSAGE(strstr(body, "\"seq\":7,"), message);
  }
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
  const gatelogic::HttpOutcome outcome = api.heartbeat(
      "5ccf7f0a1b2c", "1.0.0", 86400000ULL, gatelogic::quietDiagnostics(), response, sizeof(response));

  TEST_ASSERT_EQUAL_UINT16(200U, outcome.status);
  TEST_ASSERT_EQUAL_UINT16(200U, outcome.peerStatus);
  TEST_ASSERT_EQUAL_STRING("/api/v1/device/heartbeat", http.lastPath());
  TEST_ASSERT_NOT_NULL(strstr(http.lastBody(), "\"kind\":\"gate\""));
  TEST_ASSERT_NOT_NULL(strstr(response, "\"unlock_seconds\":5"));
}

// ---------------------------------------------------------------------------
// GateHeartbeat — the field it sends and the field it adopts
// ---------------------------------------------------------------------------

void test_heartbeat_body_carries_kind_last_and_refuses_rather_than_truncating() {
  char body[gatelogic::kGateHeartbeatBodyCap] = {};
  TEST_ASSERT_TRUE(gatelogic::renderGateHeartbeatBody(body, sizeof(body), "5ccf7f0a1b2c", "1.0.0",
                                                      86400000ULL, gatelogic::quietDiagnostics()) > 0U);
  TEST_ASSERT_EQUAL_STRING(
      "{\"mac\":\"5ccf7f0a1b2c\",\"firmware_version\":\"1.0.0\",\"uptime_ms\":86400000,\"kind\":\"gate\"}",
      body);

  // 64-bit, past the 49.7-day wrap: 0xFFFFFFFF + 20000.
  TEST_ASSERT_TRUE(gatelogic::renderGateHeartbeatBody(body, sizeof(body), "5ccf7f0a1b2c", "1.0.0",
                                                      4295187295ULL, gatelogic::quietDiagnostics()) > 0U);
  TEST_ASSERT_NOT_NULL(strstr(body, "\"uptime_ms\":4295187295,"));

  char tiny[16] = {};
  TEST_ASSERT_EQUAL_size_t(0U, gatelogic::renderGateHeartbeatBody(tiny, sizeof(tiny), "5ccf7f0a1b2c", "1.0.0",
                                                                  1000ULL, gatelogic::quietDiagnostics()));
  TEST_ASSERT_EQUAL_STRING("", tiny);
  TEST_ASSERT_EQUAL_size_t(0U, gatelogic::renderGateHeartbeatBody(body, sizeof(body), "", "1.0.0", 1000ULL,
                                                                  gatelogic::quietDiagnostics()));
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
static_assert(gatelogic::isValidApiBaseUrl("http://255.255.255.254:65535"), "the longest legal base");
static_assert(!gatelogic::isValidApiBaseUrl("https://192.168.1.10:8088"), "cleartext to :443");
static_assert(!gatelogic::isValidApiBaseUrl("http://mainframe.local:8088"), "an unbounded DNS wait");
static_assert(!gatelogic::isValidApiBaseUrl("http://192.168.1.10:8088/"), "a trailing slash is a 404");
/// E5. THE PLACEHOLDER MUST NOT COMPILE. `secrets.h.example` ships
/// `http://0.0.0.0:8088`, so an unedited copy of it is a build error rather
/// than an image on a wall. `255.255.255.255` goes with it: a POST to the
/// limited broadcast address is not a request to the API and never will be.
static_assert(!gatelogic::isValidApiBaseUrl("http://0.0.0.0:8088"), "secrets.h.example's own value");
static_assert(!gatelogic::isValidApiBaseUrl("http://0.0.0.0"), "with or without a port");
static_assert(!gatelogic::isValidApiBaseUrl("http://255.255.255.255:65535"), "limited broadcast");
static_assert(!gatelogic::isValidApiBaseUrl("http://255.255.255.255"), "limited broadcast, no port");
/// And the refusal costs no LEGAL address: the two reserved ones are the same
/// length as their neighbours, so the buffer sizing is untouched.
static_assert(gatelogic::apiBaseUrlFits("http://255.255.255.255:65535"), "must fit the URL buffer");
static_assert(gatelogic::isValidApiBaseUrl("http://1.0.0.0"), "a zero octet is legal elsewhere");
static_assert(gatelogic::isValidApiBaseUrl("http://0.0.0.1"), "and in every position but all four");
static_assert(gatelogic::isValidApiBaseUrl("http://255.255.255.0"), "255s are legal too");

/// The same grammar as a runtime table, so a failure prints which value broke
/// rather than one line number for all of them — and so the cases nobody would
/// write a static_assert for are still covered.
void test_url_accepts_only_cleartext_http_to_an_ipv4_literal() {
  const char* good[] = {
      "http://192.168.1.10:8088", "http://10.0.0.1",      "http://127.0.0.1:80",
      "http://0.0.0.1",           "http://8.8.8.8:1",     "http://255.255.255.254:65535",
      "http://1.0.0.0",           "http://255.255.255.0",
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
      // E5. The two reserved hosts, with and without a port. `0.0.0.0` is
      // secrets.h.example's own value, so an unedited example file is a build
      // error; `255.255.255.255` is the limited broadcast address.
      "http://0.0.0.0",
      "http://0.0.0.0:8088",
      "http://255.255.255.255",
      "http://255.255.255.255:65535",
  };
  for (const char* url : bad) {
    TEST_ASSERT_FALSE_MESSAGE(gatelogic::isValidApiBaseUrl(url), url);
  }

  // Long enough to be a valid dotted quad and still not fit.
  TEST_ASSERT_FALSE(gatelogic::apiBaseUrlFits("http://255.255.255.255:65535/xxxxxxxxxxxxxxxxxxxxxxxxxxx"));
}

/// The C++11 text helpers the checks above are built from. One return statement
/// each, because the generated Arduino sketch compiles at gnu++11 — and NO null
/// branch, because the address-of-an-object comparison one costs stops GCC
/// folding these at all under `-fsanitize=undefined`, which fails every
/// `static_assert` built on them. See StaticText.h.
///
/// Called ONLY with string literals and `constexpr char[]`s, in constant
/// expressions. That is pinned here by the fact that every assertion below is a
/// `static_assert`: a runtime one would be evidence of a runtime caller.
void test_static_text_compares_at_compile_time() {
  static_assert(gatelogic::text::length("") == 0U, "");
  static_assert(gatelogic::text::length("http://") == 7U, "");
  static_assert(gatelogic::text::length(gatelogic::kApiScheme) == 7U,
                "the address of an OBJECT, which is the form GCC refuses to fold under UBSan");
  static_assert(gatelogic::text::length(gatelogic::kPathHeartbeat) == 24U, "the same, on a path");
  static_assert(gatelogic::text::equals("gate", "gate"), "");
  static_assert(!gatelogic::text::equals("gate", "gates"), "");
  static_assert(!gatelogic::text::equals("gates", "gate"), "");
  static_assert(gatelogic::text::startsWith("http://x", "http://"), "");
  static_assert(!gatelogic::text::startsWith("http:/", "http://"), "");
  static_assert(gatelogic::text::startsWith("anything", ""), "");
  static_assert(gatelogic::text::startsWith("http://10.0.0.1", gatelogic::kApiScheme),
                "and a prefix that is an object rather than a literal");
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
///
/// READING A BYTE COSTS A MILLISECOND. That is roughly true at 9600 baud, and it
/// is load-bearing rather than decoration: without it the clock never moves
/// between the kick at the top of a pass and the instant a blocking call
/// starts, the two coincide, and "the watchdog is kicked immediately BEFORE
/// every blocking call" is a property no fixture can distinguish from "the
/// watchdog is kicked at the top of the pass". A mutation removing that kick
/// survived until this fake cost time.
class FakeScannerBytes final : public gatelogic::IScannerBytes {
public:
  explicit FakeScannerBytes(fakes::FakeClock& clock) : clock_(clock) {}

  void feed(const char* text) {
    // COMPACT WHAT HAS BEEN READ. A scenario that feeds sixty-eight tokens with
    // passes between them otherwise runs out of this buffer part-way through
    // and silently feeds half of them — which reads as a loop that dropped
    // scans rather than as a fake that ran dry, and cost a round here.
    if (head_ > 0U && head_ == count_) {
      head_ = 0U;
      count_ = 0U;
    }
    TEST_ASSERT_TRUE_MESSAGE(count_ + strlen(text) <= sizeof(buf_),
                             "this fake's buffer cannot hold what the scenario fed it");
    for (size_t i = 0U; text[i] != '\0' && count_ < sizeof(buf_); ++i) {
      buf_[count_] = static_cast<uint8_t>(text[i]);
      ++count_;
    }
  }

  /// The driver dropped bytes. Signalled exactly as the core does: out of band,
  /// with nothing missing from what read() returns afterwards.
  void signalRxError() { rxError_ = true; }

  /// A scanner that NEVER STOPS TALKING: once the fed bytes run out it
  /// synthesises another distinct token, for ever.
  ///
  /// A jammed reader, a code taped over the window, or simply a very busy door
  /// with eight-second round trips. It has to be generated rather than fed,
  /// because a fixed buffer runs dry after a few dozen tokens — and a scenario
  /// whose scanner runs dry proves that the loop recovers, which is not the
  /// question. The question is whether the heartbeat ever runs while it does
  /// not.
  void streamForever() { streaming_ = true; }

  bool read(uint8_t& out) override {
    if (head_ >= count_ && streaming_) {
      head_ = 0U;
      const int written = snprintf(reinterpret_cast<char*>(buf_), sizeof(buf_), "STREAM%08u\n", streamSeq_);
      ++streamSeq_;
      count_ = written > 0 ? static_cast<size_t>(written) : 0U;
    }
    if (head_ >= count_) {
      return false;
    }
    out = buf_[head_];
    ++head_;
    clock_.advance(1U);
    return true;
  }

  bool takeRxError() override {
    const bool had = rxError_;
    rxError_ = false;
    return had;
  }

  /// Everything fed has been read. A scenario that offers a token on a cadence
  /// asks this first: a pass the UPLOAD took reads no scanner bytes at all, so
  /// feeding regardless slowly fills this fake's buffer and fails the scenario
  /// on a fixture limit rather than on what it is about.
  bool drained() const { return head_ >= count_; }

private:
  fakes::FakeClock& clock_;
  uint8_t buf_[512] = {};
  size_t count_ = 0U;
  size_t head_ = 0U;
  uint32_t streamSeq_ = 0U;
  bool rxError_ = false;
  bool streaming_ = false;
};

/// The fake that makes the whole suite possible: an HTTP port that ADVANCES THE
/// CLOCK, and answers PER PATH and PER CALL.
///
/// Every defect in the shipped loop was a stale instant, and a fake that
/// answered instantly could not express one. This one takes a latency, moves
/// the clock by it, and records the window each call occupied so a test can ask
/// whether the watchdog was kicked at both ends of it.
///
/// AND IT ANSWERS EACH PATH SEPARATELY, WHICH IS THE OTHER HALF.
/// --------------------------------------------------------------
/// The version of this fake that answered ONE status for EVERY path is what
/// hid the worst defect this firmware has had. A board whose `/events` was
/// refusing while `/heartbeat` was perfectly healthy — a rate limiter, a WAF, a
/// proxy rule, or simply a board the club took out of service with an event
/// still queued — re-posted the head event on every single pass, about
/// twenty-five times a second, and the heartbeat NEVER RAN. The roster went
/// stale after six hours and the door then admitted nobody; a board taken out
/// of service never heard the heartbeat's 403 and kept admitting rostered
/// members. Neither is reachable by a fake that cannot make one path refuse
/// while another succeeds, so neither was reachable by a test.
///
/// `answer()` and `setLatency()` set the answer for EVERY path — which is what
/// most scenarios want. `onPath()` overrides one path; `onCall()` overrides the
/// Nth call to one path, so a scenario can make the third heartbeat a 403 and
/// leave the rest alone.
class LatentHttp final : public gatelogic::IHttpPort {
public:
  static constexpr size_t kMaxCalls = 256U;
  /// The three device paths, plus one spare so a fourth endpoint scripted by
  /// mistake fails loudly here rather than silently landing on another's slot.
  static constexpr size_t kMaxPaths = 4U;
  /// Per-call overrides held at once, across all paths.
  static constexpr size_t kMaxScripted = 8U;

  explicit LatentHttp(fakes::FakeClock& clock) : clock_(clock) {}

  void setLatency(uint32_t ms) { latency_ = ms; }

  /// The standing answer for ONE path, overriding the every-path default.
  void onPath(const char* path, uint16_t status, const char* body, uint32_t latencyMs) {
    Reply& reply = pathReply(path);
    reply.set(status, body, latencyMs);
  }

  /// An `/events` endpoint that acknowledges exactly ONE event per call,
  /// counting up from `firstSeq` — which is how the queue numbers them.
  ///
  /// The obvious fixture answers `accepted_through: 4294967295` and empties the
  /// whole ring in a single post, which is a drain that STOPS rather than one
  /// that is busy. A board back from an outage has sixty-four events and posts
  /// them one at a time, and that — not a refusal — is the case where the
  /// drain's position in the pass is the only thing keeping the heartbeat
  /// alive. A per-call override table cannot express it either: it would need
  /// one row per event.
  void acknowledgeOneAtATime(const char* path, uint32_t firstSeq, uint32_t latencyMs) {
    PathState& state = pathState(path);
    state.countingFrom = firstSeq;
    state.counting = true;
    state.standing.set(200U, "", latencyMs);
  }

  /// The server answers `peerStatus` and the BODY does not arrive whole.
  ///
  /// What the port returns for a body that timed out, did not fit, or did not
  /// frame: `status` 0 — every decision on this board treats it as a transport
  /// failure — with `peerStatus` kept behind it, which is the only way to tell
  /// a heartbeat whose roster push failed from a host that never answered.
  void onPathBodyFailure(const char* path, uint16_t peerStatus, uint32_t latencyMs) {
    pathReply(path).setBodyFailure(peerStatus, latencyMs);
  }

  /// The answer for the `nth` call to `path` (0-based), overriding both the
  /// path's standing answer and the every-path default for that one call.
  void onCall(const char* path, uint16_t nth, uint16_t status, const char* body, uint32_t latencyMs) {
    TEST_ASSERT_TRUE_MESSAGE(scripted_ < kMaxScripted, "too many per-call overrides");
    strncpy(script_[scripted_].path, path, sizeof(script_[scripted_].path) - 1U);
    script_[scripted_].path[sizeof(script_[scripted_].path) - 1U] = '\0';
    script_[scripted_].nth = nth;
    script_[scripted_].reply.set(status, body, latencyMs);
    ++scripted_;
  }

  /// Calls made to one path since the last forget(). Unbounded, unlike the
  /// windowed call log: a scenario that runs seven simulated hours makes far
  /// more calls than any log worth keeping.
  uint32_t callsTo(const char* path) const {
    for (size_t i = 0U; i < paths_; ++i) {
      if (strcmp(path_[i].path, path) == 0) {
        return path_[i].calls;
      }
    }
    return 0U;
  }

  /// Bytes that arrive AT THE SCANNER while this call is blocking.
  ///
  /// The real board is deaf for the whole of a call and the UART buffers
  /// whatever turns up, so "a member scanned while the heartbeat was in flight"
  /// is the ordinary case rather than an exotic one — and it is the only way to
  /// build the sequence that makes the deadline re-check on the way OUT of a
  /// call matter: a heartbeat that overruns the window, and a scan waiting to
  /// block the pass that would otherwise have taken the lock back.
  void feedDuringCall(FakeScannerBytes* scanner, const char* text) {
    arrivals_ = scanner;
    strncpy(arrivalText_, text, sizeof(arrivalText_) - 1U);
    arrivalText_[sizeof(arrivalText_) - 1U] = '\0';
  }

  void answer(uint16_t status, const char* body) {
    status_ = status;
    answer_[0] = '\0';
    if (body != nullptr) {
      strncpy(answer_, body, sizeof(answer_) - 1U);
      answer_[sizeof(answer_) - 1U] = '\0';
    }
  }

  gatelogic::HttpOutcome post(const char* path, const char* body, char* out, size_t outCap) override {
    PathState& state = pathState(path);
    const Reply& reply = replyFor(state);

    if (calls_ < kMaxCalls) {
      entered_[calls_] = clock_.value();
    }
    if (arrivals_ != nullptr && arrivalText_[0] != '\0') {
      arrivals_->feed(arrivalText_);
    }
    clock_.advance(reply.set_ ? reply.latency : latency_);
    if (calls_ < kMaxCalls) {
      exited_[calls_] = clock_.value();
    }

    // The counting body is rendered from THIS call's index, before it is
    // counted. A per-call override still wins: a scenario that scripts one call
    // of a counting path is asking for that one to be different.
    char counted[64] = {};
    const bool scripted = scriptedFor(state) != nullptr;
    if (state.counting && !scripted) {
      snprintf(counted, sizeof(counted), "{\"accepted_through\":%u}",
               static_cast<unsigned>(state.countingFrom + state.calls));
    }

    ++calls_;
    ++state.calls;

    strncpy(lastPath_, path, sizeof(lastPath_) - 1U);
    lastPath_[sizeof(lastPath_) - 1U] = '\0';
    strncpy(lastBody_, body, sizeof(lastBody_) - 1U);
    lastBody_[sizeof(lastBody_) - 1U] = '\0';
    if (out != nullptr && outCap > 0U) {
      const char* body = counted[0] != '\0' ? counted : (reply.set_ ? reply.body : answer_);
      strncpy(out, body, outCap - 1U);
      out[outCap - 1U] = '\0';
    }
    return reply.set_ ? gatelogic::HttpOutcome{reply.status, reply.peerStatus}
                      : gatelogic::HttpOutcome{status_, status_};
  }

  /// Forgets the call WINDOW log and every per-path count, so a scenario's
  /// assertions are about the scenario. The scripted answers survive: they are
  /// the scenario's setup, not its history.
  void forget() {
    calls_ = 0U;
    for (size_t i = 0U; i < paths_; ++i) {
      // A counting path is RE-BASED rather than restarted. Forgetting the count
      // is about the scenario's assertions; restarting the acknowledgements
      // would have the server re-acknowledge an event it already took, which is
      // "no progress" and would silently turn a busy drain into a backed-off
      // one.
      path_[i].countingFrom += path_[i].calls;
      path_[i].calls = 0U;
    }
  }

  uint16_t calls() const { return calls_; }

  const char* lastPath() const { return lastPath_; }

  /// The last request body. The only place a scenario can see a field the board
  /// SENDS — `no_push` has no other observer anywhere on this board.
  const char* lastBody() const { return lastBody_; }

  uint32_t enteredAt(size_t i) const { return entered_[i]; }

  uint32_t exitedAt(size_t i) const { return exited_[i]; }

private:
  /// One scripted answer. `set_` is what distinguishes "this path answers 0"
  /// from "nothing was said about this path", which the every-path default has
  /// to win.
  struct Reply {
    void set(uint16_t st, const char* text, uint32_t lat) {
      status = st;
      // A body that arrives: the two statuses agree. `setBodyFailure` is what
      // pulls them apart.
      peerStatus = st;
      latency = lat;
      body[0] = '\0';
      if (text != nullptr) {
        strncpy(body, text, sizeof(body) - 1U);
        body[sizeof(body) - 1U] = '\0';
      }
      set_ = true;
    }

    /// THE SERVER ANSWERED AND THE BODY DID NOT ARRIVE — status 0 with a
    /// peerStatus behind it, which is exactly what `Esp32HttpPort` returns for
    /// a body that timed out, did not fit, or did not frame. It is the ONE
    /// shape `no_push` distinguishes, and no fake could express it before
    /// round G3 because the port returned a single number.
    ///
    /// THROUGH THE REAL RULE, not a hard-coded zero. Both HAL ports return
    /// `statusForBody(peerStatus, <the failed read>)`, and a fake that pinned
    /// the answer that rule used to give could never have shown that it was
    /// wrong for a 4xx — which is G4 / C1's second half.
    void setBodyFailure(uint16_t peer, uint32_t lat) {
      set(gatelogic::statusForBody(peer, gatelogic::BodyResult::TooLarge), "", lat);
      peerStatus = peer;
    }

    char body[5120] = {};
    uint32_t latency = 0U;
    uint16_t status = 0U;
    uint16_t peerStatus = 0U;
    bool set_ = false;
  };

  struct PathState {
    char path[64] = {};
    Reply standing;
    uint32_t calls = 0U;
    uint32_t countingFrom = 0U;
    bool counting = false;
  };

  struct Scripted {
    char path[64] = {};
    Reply reply;
    uint16_t nth = 0U;
  };

  PathState& pathState(const char* path) {
    for (size_t i = 0U; i < paths_; ++i) {
      if (strcmp(path_[i].path, path) == 0) {
        return path_[i];
      }
    }
    TEST_ASSERT_TRUE_MESSAGE(paths_ < kMaxPaths, "more distinct paths than this fake holds");
    strncpy(path_[paths_].path, path, sizeof(path_[paths_].path) - 1U);
    path_[paths_].path[sizeof(path_[paths_].path) - 1U] = '\0';
    ++paths_;
    return path_[paths_ - 1U];
  }

  Reply& pathReply(const char* path) { return pathState(path).standing; }

  const Reply* scriptedFor(const PathState& state) const {
    for (size_t i = 0U; i < scripted_; ++i) {
      if (strcmp(script_[i].path, state.path) == 0 && script_[i].nth == state.calls) {
        return &script_[i].reply;
      }
    }
    return nullptr;
  }

  /// Per-call beats per-path beats every-path. An empty Reply falls through to
  /// the every-path default in post().
  const Reply& replyFor(const PathState& state) const {
    const Reply* scripted = scriptedFor(state);
    return scripted != nullptr ? *scripted : state.standing;
  }

  fakes::FakeClock& clock_;
  FakeScannerBytes* arrivals_ = nullptr;
  char arrivalText_[64] = {};
  char lastPath_[64] = {};
  /// Wider than any body this board renders, so an assertion about the bytes
  /// that went on the wire is about the FIRMWARE's cap and not about this
  /// fake's. devlink::kEventBodyCap is the real bound.
  char lastBody_[640] = {};
  char answer_[512] = {};
  PathState path_[kMaxPaths] = {};
  Scripted script_[kMaxScripted] = {};
  size_t paths_ = 0U;
  size_t scripted_ = 0U;
  uint32_t entered_[kMaxCalls] = {};
  uint32_t exited_[kMaxCalls] = {};
  uint32_t latency_ = 0U;
  uint16_t status_ = 0U;
  uint16_t calls_ = 0U;
};

/// The simulator's console, as a recorder.
///
/// `gatelogic::IDecisionLog` is the only port on this board that is an OUTPUT,
/// and the only one that is genuinely absent on the hardware. A refusal reason
/// reaches no other surface — the relay and the one lamp between them cannot
/// tell six reasons apart — so this is what the native simulator prints and
/// what the end-to-end harness reads to assert that a given server reason
/// produced a refusal rather than that a relay happened not to move.
///
/// A RING, not a bounded array that fails when it fills. Several scenarios here
/// run simulated hours with a scanner that never stops talking, and a recorder
/// that failed the test on its own capacity would be a fixture rule deciding
/// the outcome of a test about the event drain. It keeps the last `kMax` and
/// counts every one.
class RecordingDecisionLog final : public gatelogic::IDecisionLog {
public:
  static constexpr size_t kMax = 32U;

  void decided(const gatelogic::ScanDecision& decision, const char* token, uint32_t grantedMs,
               uint32_t nowMs) override {
    Row& row = rows_[(first_ + count_) % kMax];
    strncpy(row.reason, decision.reason, sizeof(row.reason) - 1U);
    row.reason[sizeof(row.reason) - 1U] = '\0';
    strncpy(row.token, token == nullptr ? "" : token, sizeof(row.token) - 1U);
    row.token[sizeof(row.token) - 1U] = '\0';
    row.released = decision.released;
    row.queued = decision.queueEvent;
    row.outOfService = decision.outOfService;
    row.grantedMs = grantedMs;
    row.atMs = nowMs;
    ++total_;
    if (count_ < kMax) {
      ++count_;
    } else {
      first_ = (first_ + 1U) % kMax;
    }
  }

  struct Row {
    char reason[gatelogic::kMaxReasonLen + 1U] = {};
    char token[roster::kMaxTokenLen + 1U] = {};
    uint32_t grantedMs = 0U;
    uint32_t atMs = 0U;
    bool released = false;
    bool queued = false;
    bool outOfService = false;
  };

  /// Decisions held. Equal to total() until the ring wraps.
  size_t count() const { return count_; }

  /// Decisions ever offered, wrap or no wrap.
  size_t total() const { return total_; }

  /// Oldest retained first.
  const Row& at(size_t i) const {
    TEST_ASSERT_TRUE_MESSAGE(i < count_, "no decision was recorded at that index");
    return rows_[(first_ + i) % kMax];
  }

  const Row& last() const { return at(count_ - 1U); }

  void forget() {
    count_ = 0U;
    total_ = 0U;
    first_ = 0U;
  }

private:
  Row rows_[kMax];
  size_t first_ = 0U;
  size_t count_ = 0U;
  size_t total_ = 0U;
};

/// One whole board, wired the way main.cpp wires it.
struct Rig {
  explicit Rig(uint32_t base, uint32_t boot = 0xC0FFEE01UL)
      : bootId(boot), watchdogResetRun(0U), clock(base), watchdog(clock), scanner(clock), http(clock),
        api(http, breaker, clock),
        lock(relayPin, gatelogic::kGateConfig.relayActiveHigh, gatelogic::kGateConfig.unlockEnergisesRelay),
        unlock(gatelogic::kGateConfig.unlockHardCapMs, gatelogic::kGateConfig.minRelockMs,
               gatelogic::kGateConfig.relockDwellMs),
        roster(gatelogic::kGateConfig.rosterMaxAgeMs), queue(&store), app(wire()) {}

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
    // The board leaves this nullptr. The rig wires it because it is the only
    // way a test — or the simulator — can see WHY a scan was refused.
    ports.log = &log;
    ports.mac = "5ccf7f0a1b2c";
    ports.firmwareVersion = "1.0.0";
    // A LITERAL, and that is the reason it is a port (round G4, C2). The board draws
    // this from `esp_random()` and the simulator from the clock and the pid; a class
    // that reached for either could only be tested against itself, and a boot identity
    // a test cannot pin is a deduplication rule no test can prove.
    ports.bootId = bootId;
    ports.watchdogResetRun = watchdogResetRun;
    ports.heartbeatBody = heartbeatBody;
    ports.heartbeatBodyCap = sizeof(heartbeatBody);
    return ports;
  }

  /// Re-construct the app over the same ports, so a scenario can change a value
  /// the composition root supplies ONCE AT BOOT — `watchdogResetRun` is the
  /// only one — after the rig exists. Placement-new rather than a setter,
  /// because a port that could change mid-run would be a port this class does
  /// not have.
  void rewire() {
    app.~GateApp();
    new (&app) gatelogic::GateApp(wire());
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
    // PAST THE FLOOR FIRST. `kMinHeartbeatSpacingMs` bounds ATTEMPTS, not
    // successes, so a scenario that wants a second heartbeat has to let the
    // floor lapse — which is exactly what a real board does and is the whole
    // point of E2. Before the floor existed, a link edge was a heartbeat on
    // demand at any rate, which is what 179 999 calls in a simulated hour
    // looked like from inside this helper.
    clock.advance(gatelogic::kMinHeartbeatSpacingMs);
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

  /// Passes until `ms` of SIMULATED time have gone by. The scenarios that found
  /// the event-drain defect are hours long, and they are hours long because the
  /// consequence — a roster ageing out at six — is not visible in seconds.
  void runFor(uint32_t ms) {
    const uint32_t start = clock.value();
    while (tb::since(clock.value(), start) < ms) {
      tick();
    }
  }

  uint32_t bootId;
  uint32_t watchdogResetRun;
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
  RecordingDecisionLog log;
  char heartbeatBody[gatelogic::kGateResponseCap] = {};
  gatelogic::GateApp app;
};

constexpr char kOpenThreeSeconds[] = "{\"opened\":true,\"reason\":\"ok\",\"unlock_seconds\":3}";

/// The contract's widest grant. Used where a scenario must not have a window
/// CLOSE inside it — the relock dwell (round G4, A1) is a second rule with its
/// own test, and a scenario about the call budget must not be decided by it.
constexpr char kOpenThirtySeconds[] = "{\"opened\":true,\"reason\":\"ok\",\"unlock_seconds\":30}";

/// What the body above grants, as a number the assertions derive from rather
/// than repeat. A one-field probe that changed the body's seconds and left the
/// assertions alone is what asked for this.
constexpr uint32_t kOpenGrantMs = 3000U;

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
      TEST_ASSERT_TRUE_MESSAGE(held >= kOpenGrantMs,
                               "the member was granted a window and must get all of it");
      TEST_ASSERT_TRUE_MESSAGE(held < kOpenGrantMs + (2U * gatelogic::kIdleDelayMs),
                               "and not materially more than the window");
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
  // THE WIDEST GRANT, so no window CLOSES between two twelve-second calls. With
  // a three-second one the first member's window ends inside the second call,
  // the lock starts relatching, and the third scan is refused without a call —
  // correctly, by A1's dwell, which is a different rule with its own test. A
  // scenario about the call budget must not be decided by it.
  rig.http.answer(200U, kOpenThirtySeconds);

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

  // Now the API goes slow, and a HEARTBEAT falls due inside the member's window
  // — the one blocking call a pass makes after it has already checked the lock.
  // While it is in flight somebody scans, which is the ordinary case: the board
  // is deaf for the whole call and the UART buffers what arrives.
  //
  // THAT SEQUENCE IS WHAT THIS TEST IS FOR. Without the fresh-clock deadline
  // check on the way OUT of a blocking call, the relay is not looked at until
  // the next pass — and the next pass's scanner spends another whole worst case
  // before it gets there. The overrun is two calls, not one, and it has no
  // bound at all for as long as people keep scanning.
  rig.http.setLatency(gatelogic::kWorstBlockingCallMs);
  rig.http.answer(200U, "{\"opened\":false,\"reason\":\"no_booking\",\"unlock_seconds\":0}");
  rig.http.feedDuringCall(&rig.scanner, "TOKENBBBBBBB\n");
  rig.link.set(false);
  rig.tick();
  rig.link.set(true); // the link edge arms the heartbeat for the pass below

  const uint32_t closed = rig.runUntilLocked(4000U);
  TEST_ASSERT_FALSE(rig.lock.released());

  const uint32_t held = tb::since(closed, opened);
  const uint32_t bound = kOpenGrantMs + gatelogic::kWorstBlockingCallMs + gatelogic::kIdleDelayMs;
  TEST_ASSERT_TRUE_MESSAGE(held >= kOpenGrantMs, "the window is still the window");
  TEST_ASSERT_TRUE_MESSAGE(held <= bound,
                           "a release may outlive its deadline by ONE blocking call, not by a pass");
}

/// (e) / E2. AN OVERRUN COSTS EVERYTHING THAT WAS BUFFERED WHEN IT HAPPENED,
/// AND NOTHING AFTER THE NEXT TERMINATOR.
///
/// A serial FIFO overruns when it is FULL. Everything the driver already has it
/// keeps; what it drops is what arrived NEXT. So the bytes `read()` hands up
/// afterwards are the OLD ones — in order, printable, whole lines — followed by
/// the far side of a hole, and the hole is at the TAIL of about a kilobyte of
/// buffered data that the loop drains sixty-four bytes at a time.
///
/// Poisoning only the line in ASSEMBLY therefore poisoned the wrong line: a
/// good buffered line was thrown away and the holed one was handed up several
/// passes later as a perfectly valid token — a refusal for somebody standing
/// there, or a match on another member's booking.
///
/// THE OLD FIXTURE COULD NOT SEE THAT, and that is the lesson. It fed a PARTIAL
/// line before signalling, so the line in assembly and the holed line were the
/// same line and marking one marked the other. Feed WHOLE lines first — the
/// real shape — and the old firmware goes red.
///
/// MUTATION-PROVED: replace the drain with a bare `markCorrupt()` and the first
/// row below fails on `GOODLINETWO2` opening the door.
void test_app_an_rx_error_discards_everything_that_was_buffered_when_it_happened() {
  // THE REAL SHAPE: whole lines already in the ring, the hole at the tail.
  {
    Rig rig(kBaseMid);
    rig.boot(true);
    rig.http.answer(200U, kOpenThreeSeconds);
    rig.http.forget();

    rig.scanner.feed("GOODLINEONE1\nGOODLINETWO2\nHOLEDLINEXX");
    rig.scanner.signalRxError();
    rig.scanner.feed("YZ\n"); // the far side of the hole, already buffered
    for (int i = 0; i < 4; ++i) {
      rig.tick();
    }
    TEST_ASSERT_EQUAL_UINT16_MESSAGE(0U, rig.http.calls(),
                                     "nothing buffered when the driver overran may become a token");
    TEST_ASSERT_FALSE(rig.lock.released());

    // And the next line, which arrived after all of it, is clean.
    rig.scanner.feed("K4TQ8N2ZV7BM\n");
    rig.tick();
    TEST_ASSERT_EQUAL_UINT16_MESSAGE(1U, rig.http.calls(), "the overrun must not cost the next line too");
    TEST_ASSERT_TRUE(rig.lock.released());
  }

  // THE FAR SIDE OF THE HOLE HAS NOT ARRIVED YET, so the discard has to run on
  // past the drain, through the next terminator.
  {
    Rig rig(kBaseMid);
    rig.boot(true);
    rig.http.answer(200U, kOpenThreeSeconds);
    rig.http.forget();

    rig.scanner.feed("GOODLINEONE1\nHOLEDLINEXX");
    rig.scanner.signalRxError();
    rig.tick();
    rig.scanner.feed("YZ\n"); // arrives a pass later
    rig.tick();
    TEST_ASSERT_EQUAL_UINT16_MESSAGE(0U, rig.http.calls(), "the far side of a hole is not a token");

    rig.scanner.feed("K4TQ8N2ZV7BM\n");
    rig.tick();
    TEST_ASSERT_EQUAL_UINT16(1U, rig.http.calls());
    TEST_ASSERT_TRUE(rig.lock.released());
  }

  // THE ORIGINAL SHAPE still holds: half a line in assembly, the rest after.
  {
    Rig rig(kBaseMid);
    rig.boot(true);
    rig.http.answer(200U, kOpenThreeSeconds);
    rig.http.forget();

    rig.scanner.feed("7Q3F9K");
    rig.tick();
    rig.scanner.signalRxError();
    rig.scanner.feed("XZ8B\n");
    rig.tick();
    TEST_ASSERT_EQUAL_UINT16_MESSAGE(0U, rig.http.calls(), "a holed line must not become a token");
    TEST_ASSERT_FALSE(rig.lock.released());

    rig.scanner.feed("K4TQ8N2ZV7BM\n");
    rig.tick();
    TEST_ASSERT_EQUAL_UINT16(1U, rig.http.calls());
    TEST_ASSERT_TRUE(rig.lock.released());
  }
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
  const uint32_t openedAt = rig.clock.value() - gatelogic::kIdleDelayMs;

  // A second member, well into the first one's window. The window may not pass
  // the cap measured from the moment the door FIRST opened, so what they get is
  // whatever is left of it — DERIVED here rather than written out, because a
  // one-field probe that moved this offset and left a hand-written bound behind
  // is a test that pins the offset instead of the rule.
  rig.clock.advance(29500U);
  rig.scanner.feed("TOKENBBBBBBB\n");
  rig.tick();
  const uint32_t secondScanAt = rig.clock.value() - gatelogic::kIdleDelayMs;
  const uint32_t sinceOpen = tb::since(secondScanAt, openedAt);
  const uint32_t expected = sinceOpen >= 30000U ? 0U : 30000U - sinceOpen;

  eventq::Event event;
  uint32_t lastOpenDuration = 0U;
  uint16_t opens = 0U;
  while (rig.queue.peek(event)) {
    if (event.kind == eventq::Kind::GateOpen) {
      lastOpenDuration = event.durationMs;
      ++opens;
    }
    static_cast<void>(rig.queue.release());
  }
  TEST_ASSERT_EQUAL_UINT16_MESSAGE(2U, opens, "both scans opened the door from the roster");
  TEST_ASSERT_EQUAL_UINT32_MESSAGE(expected, lastOpenDuration,
                                   "the event must carry what the lock was given, not what was asked");
  TEST_ASSERT_TRUE_MESSAGE(lastOpenDuration < 30000U,
                           "and the cap has to have bitten, or this proves nothing");
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

// ---------------------------------------------------------------------------
// E1 — the event drain must never starve the heartbeat
// ---------------------------------------------------------------------------

/// Queues `count` offline refusals, which is the cheapest way to fill the ring
/// with events only this board knows about. Leaves the radio DOWN.
void queueOfflineEvents(Rig& rig, uint16_t count) {
  rig.link.set(false);
  rig.tick(); // let pumpLink see the drop before any scan decides
  for (uint16_t i = 0U; i < count; ++i) {
    char token[roster::kMaxTokenLen + 2U] = {};
    snprintf(token, sizeof(token), "QUEUED%06u\n", i);
    rig.scanner.feed(token);
    rig.tick();
    rig.tick();
  }
}

constexpr char kHealthyHeartbeat[] =
    "{\"kind\":\"gate\",\"gate\":{\"unlock_seconds\":3},\"roster\":[\"MEMBERTOKEN1|0|0|86399\"],"
    "\"accepted_through\":0}";

/// E1 CRITICAL, and the scenario the round-G2 finders reproduced against the
/// real GateApp.
///
/// `/events` refusing while `/heartbeat` is perfectly healthy is not exotic: a
/// rate limiter, a WAF rule, a proxy, or a 200 whose `accepted_through` does
/// not cover the head event all produce it, and `begin()` queues a `boot` event
/// on EVERY boot, so a board that meets one of them has something in its ring
/// from its first second.
///
/// The shipped loop drained events BEFORE the heartbeat and both were gated on
/// the same one-blocking-call-per-pass flag, so the refused head was re-posted
/// on every pass — about twenty-five times a second — and the heartbeat never
/// ran again. Three things follow, and all three are worse than the refusal:
/// the roster ages out at six hours and the door then admits NOBODY; a board
/// the club took out of service never hears the heartbeat's 403 and keeps
/// admitting rostered members; and the API is hammered by a device that is
/// supposed to speak twice a minute.
///
/// MUTATION-PROVED: put `pumpEvents()` back before `pumpHeartbeat()`, or delete
/// the backoff, and this goes red on both counts.
void test_app_a_refusing_events_endpoint_never_starves_the_heartbeat() {
  struct Row {
    uint16_t status;
    const char* body;
    const char* why;
  };

  // Every refusal class that KEEPS the head event. A 400 releases it (the board
  // caused it) and makes progress, so it is not this defect's shape; 403 is its
  // own scenario below, because it also empties the roster.
  const Row rows[] = {
      {401U, "", "401 — the compiled-in key is not the tenant's"},
      {408U, "", "408"},
      {429U, "", "429 — a rate limiter is the ordinary cause"},
      {503U, "", "503 — a container restarting"},
      {200U, "{\"ok\":true}", "a 200 that acknowledges nothing"},
      {200U, "{\"accepted_through\":0}", "a 200 whose acknowledgement does not reach the head"},
  };

  // Thirty simulated minutes: sixty heartbeats are due in that time.
  const uint32_t kWindowMs = 1800000UL;
  const uint32_t kDueHeartbeats = kWindowMs / gatelogic::kGateConfig.heartbeatMs;

  for (const Row& row : rows) {
    Rig rig(kBaseMid);
    rig.boot(true);
    queueOfflineEvents(rig, 3U);

    rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, 20U);
    rig.http.onPath(gatelogic::kPathEvents, row.status, row.body, 20U);
    rig.link.set(true);
    rig.tick();
    rig.http.forget();

    rig.runFor(kWindowMs);

    const uint32_t heartbeats = rig.http.callsTo(gatelogic::kPathHeartbeat);
    const uint32_t posts = rig.http.callsTo(gatelogic::kPathEvents);

    // THE CADENCE IS KEPT. Not "some heartbeats happened": most of them.
    TEST_ASSERT_TRUE_MESSAGE(heartbeats >= (kDueHeartbeats - (kDueHeartbeats / 10U)), row.why);

    // AND THE DRAIN IS PACED. The backoff starts at 15 s and doubles to a
    // five-minute cap, so thirty minutes is about nine posts. The bound below
    // is the number of posts that schedule can produce with room to spare — and
    // it is thousands below what a hot loop produces, which is the point.
    TEST_ASSERT_TRUE_MESSAGE(posts >= 1U, row.why);
    TEST_ASSERT_TRUE_MESSAGE(posts <= 20U, row.why);

    // AND THE ROSTER IS FRESH, which is the consequence that shuts the door.
    TEST_ASSERT_TRUE_MESSAGE(rig.roster.ageMs(rig.clock.value()) < 3U * gatelogic::kGateConfig.heartbeatMs,
                             row.why);
    TEST_ASSERT_TRUE_MESSAGE(
        rig.roster.decide("MEMBERTOKEN1", roster::CourtCount(1U), rig.clock.value()).verdict ==
            roster::Verdict::Allow,
        row.why);
  }
}

/// E1(b). The backoff RESETS once the drain makes progress, so a transient
/// refusal does not leave a healthy board posting one event every five minutes
/// for the rest of the evening.
///
/// THE ACKNOWLEDGEMENT IS ONE EVENT AT A TIME, DELIBERATELY. The obvious
/// fixture answers `accepted_through: 4294967295`, which empties the whole ring
/// in a single post — and a single post cannot show whether the NEXT one would
/// have waited out another backoff window. A mutation that never reset the
/// backoff survived that fixture. One event per acknowledgement is what makes
/// the second post's timing the thing under test.
void test_app_the_event_backoff_resets_once_the_drain_moves_again() {
  Rig rig(kBaseMid);
  rig.boot(true);
  queueOfflineEvents(rig, 4U);

  rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, 0U);
  rig.http.onPath(gatelogic::kPathEvents, 429U, "", 0U);
  rig.link.set(true);
  rig.tick();
  rig.http.forget();

  // A minute of refusals arms and doubles the backoff.
  rig.runFor(60000UL);
  const uint32_t refusals = rig.http.callsTo(gatelogic::kPathEvents);
  TEST_ASSERT_TRUE_MESSAGE(refusals >= 1U && refusals <= 8U, "a minute of refusals is a handful of posts");

  // The rate limiter lifts. Each post from here acknowledges exactly its own
  // head — the queue numbers events consecutively — so each one is progress and
  // each one must clear the backoff.
  eventq::Event head;
  TEST_ASSERT_TRUE(rig.queue.peek(head));
  rig.http.forget(); // per-call indices count from here
  for (uint16_t n = 0U; n < 3U; ++n) {
    char ack[64] = {};
    snprintf(ack, sizeof(ack), "{\"accepted_through\":%u}", head.seq + n);
    rig.http.onCall(gatelogic::kPathEvents, n, 200U, ack, 0U);
  }

  // WHEN each event left, not just that it did. The whole property is a gap:
  // three events that leave 15 s, 30 s and 60 s apart have also "drained".
  uint32_t leftAt[3] = {};
  uint16_t seen = 0U;
  uint16_t size = rig.queue.size();
  for (uint32_t i = 0U; i < 200000U && seen < 3U; ++i) {
    rig.tick();
    if (rig.queue.size() < size) {
      size = rig.queue.size();
      leftAt[seen] = rig.clock.value();
      ++seen;
    }
  }
  TEST_ASSERT_EQUAL_UINT16_MESSAGE(3U, seen, "three acknowledged events must leave");

  // The FIRST waits out whatever window the refusals armed — that is the
  // backoff working. The SECOND and THIRD must not: progress cleared it, so
  // they go out on the passes that follow rather than 15 s and 30 s later.
  TEST_ASSERT_TRUE_MESSAGE(tb::since(leftAt[1], leftAt[0]) < gatelogic::kEventRetryStartMs,
                           "the drain stayed on its backoff after making progress");
  TEST_ASSERT_TRUE_MESSAGE(tb::since(leftAt[2], leftAt[1]) < gatelogic::kEventRetryStartMs,
                           "the drain stayed on its backoff after making progress");
}

/// E1(a) ON ITS OWN, WITHOUT THE BACKOFF DOING THE WORK.
///
/// The backoff pins the REFUSING drain. It says nothing about a drain that is
/// succeeding — every post moves the queue, so the backoff never arms — and a
/// board back from an outage has a full ring and every reason to be slow.
/// Sixty-four events at a worst-case round trip apiece is eight and a half
/// minutes in which, with the drain ahead of the heartbeat, the board would not
/// heartbeat once. Its roster would go on ageing throughout, and a link drop in
/// the middle of it is a door deciding from an hours-old cache.
///
/// MUTATION-PROVED, and it is the reason this test exists: swapping
/// `pumpHeartbeat()` and `pumpEvents()` back left every other test in this file
/// green, because the backoff alone was enough for all of them.
void test_app_a_full_ring_draining_slowly_still_lets_the_heartbeat_through() {
  Rig rig(kBaseMid);
  rig.boot(true);
  queueOfflineEvents(rig, 24U);
  TEST_ASSERT_TRUE_MESSAGE(rig.queue.size() >= 20U, "the scenario needs a ring with real work in it");

  // Every post succeeds and takes a worst-case call, so the backoff never arms
  // and the drain is the only thing competing for the pass.
  eventq::Event head;
  TEST_ASSERT_TRUE(rig.queue.peek(head));
  rig.http.acknowledgeOneAtATime(gatelogic::kPathEvents, head.seq, gatelogic::kWorstBlockingCallMs);
  rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, gatelogic::kWorstBlockingCallMs);
  rig.link.set(true);
  rig.tick();
  rig.http.forget();

  // Four minutes, in which eight heartbeats are due.
  rig.runFor(240000UL);

  TEST_ASSERT_TRUE_MESSAGE(rig.http.callsTo(gatelogic::kPathEvents) > 0U,
                           "the drain has to be working for this to prove anything");
  TEST_ASSERT_TRUE_MESSAGE(rig.http.callsTo(gatelogic::kPathHeartbeat) >= 4U,
                           "a busy but healthy event drain took every pass and the heartbeat never ran");
}

/// E1(c). A 403 on `/events` is the SAME authoritative word as a 403 on
/// `/gate` and on the heartbeat: the club took this board out of service.
///
/// This is the sequence that made the critical dangerous rather than merely
/// wasteful. A board with an event in its ring — every board, from its first
/// boot — that the club disables gets 403 everywhere. With the drain ahead of
/// the heartbeat and no backoff, the heartbeat never ran, so the board never
/// heard its own 403, kept its roster, and admitted every rostered member for
/// the next six hours from behind a door the admin believed was shut.
void test_app_a_403_on_events_takes_the_board_out_of_service_too() {
  // THE DRAIN HEARS IT FIRST, which is the half a heartbeat-only rule misses.
  //
  // The club disables a board a second after its last heartbeat, so for the
  // rest of that interval the only path this board speaks on is the event
  // drain. A healthy heartbeat sitting beside a 403 `/events` is not a state
  // the API produces — the device route group's 403 means one thing and means
  // it everywhere — which is precisely what makes it the right probe: it
  // isolates whether the DRAIN acts on the word, or whether the roster survives
  // until the heartbeat happens to ask thirty seconds later.
  {
    Rig rig(kBaseMid);
    rig.boot(true);
    queueOfflineEvents(rig, 2U);

    rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, 0U);
    rig.http.onPath(gatelogic::kPathEvents, 403U, "", 0U);
    // Past the heartbeat's spacing floor first (E2): a link edge arms a
    // heartbeat, it does not exempt one, and this board took its last one
    // during boot().
    rig.clock.advance(gatelogic::kMinHeartbeatSpacingMs);
    rig.link.set(true);
    rig.tick(); // the link edge takes a heartbeat, which fills the roster
    rig.http.forget();
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(1U, rig.roster.size(), "the scenario needs a roster to empty");

    // A tenth of a heartbeat interval: nowhere near the next one.
    rig.runFor(gatelogic::kGateConfig.heartbeatMs / 10U);
    TEST_ASSERT_TRUE_MESSAGE(rig.http.callsTo(gatelogic::kPathEvents) > 0U, "the drain has to have posted");
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(0U, rig.http.callsTo(gatelogic::kPathHeartbeat),
                                     "and the heartbeat must NOT be what heard it");
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(0U, rig.roster.size(),
                                    "a 403 on the event drain is the same word as on the heartbeat");
    TEST_ASSERT_TRUE_MESSAGE(rig.roster.everLoaded(), "empty, not never-loaded");
  }

  // AND THE SCAN PATH, which is often the first one of all: an admin presses
  // the button while a member is at the door. Denying that one scan and keeping
  // the roster would leave the NEXT link drop admitting every rostered member
  // again, which is the window the whole 403 rule exists to close.
  //
  // Found by probing the claim "a 403 on any of the three device paths commits
  // an empty roster" against the code, where it was true of two of them.
  {
    Rig rig(kBaseMid);
    rig.boot(true);
    const roster::Entry entries[] = {booking("MEMBERTOKEN1", 0U, 86399000U)};
    loadRoster(rig.roster, rig.clock.value(), entries, 1U);

    rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, 0U);
    rig.http.onPath(gatelogic::kPathGate, 403U, "", 0U);
    rig.http.forget();

    rig.scanner.feed("MEMBERTOKEN1\n");
    rig.tick();
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(1U, rig.http.callsTo(gatelogic::kPathGate), "the scan has to have gone");
    TEST_ASSERT_FALSE_MESSAGE(rig.lock.released(), "a 403 on the scan path denies");
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(0U, rig.roster.size(),
                                    "and empties the roster, like the same word anywhere else");
    TEST_ASSERT_TRUE(rig.roster.everLoaded());

    // So the link drop that follows finds nothing to admit anybody with.
    rig.link.set(false);
    rig.tick();
    rig.debounce.reset();
    rig.scanner.feed("MEMBERTOKEN1\n");
    rig.tick();
    TEST_ASSERT_FALSE(rig.lock.released());
  }

  // AND THE WHOLE SEQUENCE, which is what made the round-G2 critical dangerous
  // rather than merely wasteful: a board with an event in its ring — every
  // board, after `begin()` — that the club disables, and then a link drop.
  {
    Rig rig(kBaseMid);
    rig.boot(true);
    const roster::Entry entries[] = {booking("MEMBERTOKEN1", 0U, 86399000U)};
    loadRoster(rig.roster, rig.clock.value(), entries, 1U);
    queueOfflineEvents(rig, 2U);

    rig.http.answer(403U, ""); // out of service: every device path
    rig.link.set(true);
    rig.tick();
    rig.http.forget();
    rig.runFor(2U * gatelogic::kGateConfig.heartbeatMs);

    TEST_ASSERT_EQUAL_UINT8_MESSAGE(0U, rig.roster.size(),
                                    "a 403 anywhere on the device API empties the roster");

    // Now the link drops — the residual case D4 names, where the board can no
    // longer be told anything. It must already know.
    rig.link.set(false);
    rig.tick();
    rig.debounce.reset();
    rig.scanner.feed("MEMBERTOKEN1\n");
    rig.tick();
    TEST_ASSERT_FALSE_MESSAGE(rig.lock.released(),
                              "a board taken out of service must refuse a rostered member after a drop");
  }
}

/// E1(b), the normal path for a board nobody has done anything to. `begin()`
/// queues a `boot` event on every boot; a server that answers 200 without an
/// `accepted_through` covering it leaves it at the head forever. That is not a
/// refusal anybody would notice — it is a healthy-looking board posting the
/// same event about twenty-five times a second.
void test_app_a_boot_event_the_server_never_acknowledges_is_not_a_hot_loop() {
  Rig rig(kBaseMid);
  rig.bootRaw(true);
  rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, 0U);
  rig.http.onPath(gatelogic::kPathEvents, 200U, "{\"ok\":true}", 0U);
  rig.tick();
  rig.http.forget();

  const uint32_t kWindowMs = 300000UL; // five minutes
  rig.runFor(kWindowMs);

  TEST_ASSERT_TRUE_MESSAGE(rig.http.callsTo(gatelogic::kPathEvents) <= 8U,
                           "an unacknowledged boot event must not be re-posted on every pass");
  TEST_ASSERT_TRUE_MESSAGE(rig.http.callsTo(gatelogic::kPathHeartbeat) >=
                               (kWindowMs / gatelogic::kGateConfig.heartbeatMs) - 1U,
                           "and the heartbeat must keep its cadence while it is stuck");
}

/// E1(d). A scanner that never stops talking must not starve the heartbeat
/// either. The member at the door wins the pass — but not forever: after
/// `kMaxScanPassesBeforeHeartbeat` consecutive passes in which a scan took the
/// one blocking call with a heartbeat already due, the heartbeat goes first.
///
/// Without the bound, a jammed scanner — or simply a very busy door with
/// eight-second round trips — is a board that never heartbeats, which is a
/// roster that ages out, which is a door that admits nobody.
void test_app_a_permanently_busy_scanner_cannot_starve_the_heartbeat() {
  Rig rig(kBaseMid);
  rig.boot(true);
  rig.http.onPath(gatelogic::kPathGate, 200U, "{\"opened\":false,\"reason\":\"not_recognised\"}",
                  gatelogic::kWorstBlockingCallMs);
  rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, gatelogic::kWorstBlockingCallMs);

  // A distinct token per scan, so the debounce never suppresses one, arriving
  // faster than a pass can decide them and never running out.
  rig.scanner.streamForever();
  rig.http.forget();

  rig.runFor(600000UL); // ten simulated minutes of unbroken scanning

  TEST_ASSERT_TRUE_MESSAGE(rig.http.callsTo(gatelogic::kPathGate) > 0U,
                           "the scenario has to keep the scanner busy to prove anything");
  TEST_ASSERT_TRUE_MESSAGE(rig.http.callsTo(gatelogic::kPathHeartbeat) > 0U,
                           "a busy scanner starved the heartbeat completely");
  // The bound, stated as the thing it protects: the roster never got near its
  // maximum age while the door was busy.
  TEST_ASSERT_TRUE_MESSAGE(rig.roster.ageMs(rig.clock.value()) < gatelogic::kGateConfig.rosterMaxAgeMs,
                           "the roster aged out while the door was busy");
}

/// E3. AND THE EVENT DRAIN IS BOUNDED BY THE SAME COUNTER, which round G2's
/// heartbeat-only bound left starving.
///
/// MEASURED, on the real GateApp, before the fix: a scan offered every 210 ms
/// over a simulated hour produced 16 180 scans, 116 heartbeats — the heartbeat
/// bound working exactly as designed — and **zero** event posts. A door that
/// spent a night offline comes back with a ring full of entries and, on a busy
/// morning, uploads none of them; the ring then overwrites its own oldest rows
/// and `overflowed()` was read by nothing.
///
/// The fixture field that discriminates is the scan RATE. At 250 ms the drain
/// gets a pass on its own and posts; at 210 ms — which is one scan per two
/// eight-second... one scan per rather less than a decided pass — it never
/// does. A test written at the comfortable rate passes against the broken code.
void test_app_a_permanently_busy_scanner_cannot_starve_the_event_drain() {
  Rig rig(kBaseMid);
  rig.boot(true);
  queueOfflineEvents(rig, 3U);

  // The per-path answers go in BEFORE the radio returns: boot()'s every-path
  // default acknowledges through 0xFFFFFFFF, which would empty the whole ring
  // on the first post and leave nothing to starve.
  rig.http.onPath(gatelogic::kPathGate, 200U, "{\"opened\":false,\"reason\":\"not_recognised\"}", 200U);
  rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, 200U);
  // From the seq the ring actually holds, not from 1: the boot event took 1 and
  // was released during boot(), so a server acknowledging 1 acknowledges
  // nothing, arms the backoff, and the drain that is meant to be busy is idle.
  eventq::Event head;
  TEST_ASSERT_TRUE(rig.queue.peek(head));
  rig.http.acknowledgeOneAtATime(gatelogic::kPathEvents, head.seq, 200U);
  rig.link.set(true);
  rig.tick();
  rig.scanner.streamForever();
  rig.http.forget();

  const uint16_t held = rig.queue.size();
  TEST_ASSERT_TRUE_MESSAGE(held > 0U, "the scenario needs a backlog to drain");

  rig.runFor(600000UL); // ten simulated minutes of unbroken scanning

  TEST_ASSERT_TRUE_MESSAGE(rig.http.callsTo(gatelogic::kPathGate) > 0U,
                           "the scenario has to keep the scanner busy to prove anything");
  TEST_ASSERT_TRUE_MESSAGE(rig.http.callsTo(gatelogic::kPathEvents) > 0U,
                           "a busy scanner starved the event drain completely");
  TEST_ASSERT_TRUE_MESSAGE(rig.queue.size() < held, "and the backlog actually moved");
  // The heartbeat is still first when both are waiting, so bounding the drain
  // did not cost the thing the bound was built for.
  TEST_ASSERT_TRUE_MESSAGE(rig.http.callsTo(gatelogic::kPathHeartbeat) > 0U,
                           "bounding the drain must not starve the heartbeat");
}

/// E3. A LINK DROP CLEARS THE DEFERRAL DEBT.
///
/// Four deferred passes spent against an upload that could not have run are not
/// a debt the member on the other side of an outage owes. Without the reset,
/// the first pass after the radio returns takes the blocking call away from
/// somebody standing at the door with a phone in their hand.
void test_app_a_link_drop_clears_the_scan_deferral_debt() {
  Rig rig(kBaseMid);
  rig.boot(true);
  rig.http.onPath(gatelogic::kPathGate, 200U, kOpenThreeSeconds, gatelogic::kWorstBlockingCallMs);
  rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, gatelogic::kWorstBlockingCallMs);

  // Run up a full debt: a heartbeat due and a scanner taking every pass.
  rig.clock.advance(gatelogic::kGateConfig.heartbeatMs);
  rig.scanner.streamForever();
  for (uint8_t i = 0U; i < gatelogic::kMaxScanPassesBeforeUpload; ++i) {
    rig.tick();
  }

  // The radio goes away and comes back.
  rig.link.set(false);
  rig.tick();
  rig.link.set(true);
  rig.http.forget();

  // The FIRST pass after the link returns belongs to the member, not to the
  // heartbeat the link edge just armed.
  rig.tick();
  TEST_ASSERT_EQUAL_UINT32_MESSAGE(1U, rig.http.callsTo(gatelogic::kPathGate),
                                   "the first pass after a link drop belongs to the door");
  TEST_ASSERT_EQUAL_UINT32_MESSAGE(0U, rig.http.callsTo(gatelogic::kPathHeartbeat),
                                   "a deferral debt from before the outage must not be carried over");
}

/// E2 HIGH. A FLAPPING RADIO MUST NOT HAMMER THE API.
///
/// `pumpLink` arms the heartbeat for "now" on every link-UP edge, which is
/// right: the heartbeat is what fills the roster, and until it has, an offline
/// scan is refused. On a door at the edge of the AP's range — which is where
/// doors are, at the end of a corridor in a steel frame — that was one
/// heartbeat PER PASS.
///
/// MEASURED on the real GateApp before the fix, over one simulated hour with
/// the link toggling every pass: **179 999** heartbeats against a cadence that
/// says 120. With 50 ms of latency on each, 51 429. An API the club would read
/// as an attack, and a board that spends its entire life inside a connect.
///
/// The bound is `kMinHeartbeatSpacingMs` between ATTEMPTS: 3 600 000 / 15 000 =
/// 240 an hour, twice the healthy cadence, whatever the radio does.
void test_app_a_flapping_link_cannot_hammer_the_heartbeat() {
  Rig rig(kBaseMid);
  rig.boot(true);
  rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, 50U);
  rig.http.forget();

  const uint32_t kHourMs = 3600000UL;
  const uint32_t started = rig.clock.value();
  bool up = true;
  while (tb::since(rig.clock.value(), started) < kHourMs) {
    up = !up;
    rig.link.set(up);
    rig.tick();
  }

  const uint32_t calls = rig.http.callsTo(gatelogic::kPathHeartbeat);
  TEST_ASSERT_TRUE_MESSAGE(calls <= 240U,
                           "a link flapping every pass must not buy more than one heartbeat per "
                           "kMinHeartbeatSpacingMs");
  // AND IT STILL HEARTBEATS. A floor that silenced the board would be a roster
  // that ages out, which is the failure the arm-on-edge exists to prevent.
  TEST_ASSERT_TRUE_MESSAGE(calls >= kHourMs / (gatelogic::kGateConfig.heartbeatMs * 2U),
                           "the floor must not stop the board heartbeating at all");
}

/// E2. THE FLOOR IS ABOUT ATTEMPTS, NOT SUCCESSES.
///
/// A flapping radio is exactly the case that produces failing calls, so a floor
/// armed only after a successful heartbeat would be no floor at all against the
/// scenario it exists for.
void test_app_the_heartbeat_floor_bounds_failing_calls_too() {
  Rig rig(kBaseMid);
  rig.boot(true);
  // A host that is there and refusing — the breaker never opens on a 503, it
  // counts transport failures, so the drain keeps asking.
  rig.http.onPath(gatelogic::kPathHeartbeat, 503U, "", 0U);
  rig.http.forget();

  const uint32_t kWindowMs = 300000UL; // five minutes
  const uint32_t started = rig.clock.value();
  bool up = true;
  while (tb::since(rig.clock.value(), started) < kWindowMs) {
    up = !up;
    rig.link.set(up);
    rig.tick();
  }

  TEST_ASSERT_TRUE_MESSAGE(rig.http.callsTo(gatelogic::kPathHeartbeat) <=
                               (kWindowMs / gatelogic::kMinHeartbeatSpacingMs) + 1U,
                           "a refusing host must not be retried faster than a healthy one");
}

/// E3. THE RING'S OVERFLOW REACHES SOMEBODY.
///
/// `EventQueue.h` has promised since it was written that "an overflow is
/// reported, never silent", and until round G3 `overflowed()` was read by
/// NOTHING anywhere in this repository. 64 slots against a door doing 720 scans
/// an hour is a counter that moves on the first bad night, and every row it
/// counts is an entry the club never learns about.
void test_app_events_the_ring_discarded_are_reported_in_the_next_heartbeat() {
  Rig rig(kBaseMid);
  rig.boot(true);

  // Offline for long enough to overrun a 64-slot ring. `begin()` already put a
  // boot event in it, so 64 more is a guaranteed overflow.
  // One MORE than the ring holds: exactly `kGateEventSlots` pushes fill it
  // without discarding anything, and a test that fills it exactly proves that
  // the counter stays at zero.
  queueOfflineEvents(rig, static_cast<uint16_t>(gatelogic::kGateEventSlots + 4U));
  TEST_ASSERT_TRUE_MESSAGE(rig.queue.overflowed() > 0U, "the scenario needs the ring to overflow");
  const uint32_t lost = rig.queue.overflowed();

  rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, 0U);
  rig.http.onPath(gatelogic::kPathEvents, 200U, "{\"accepted_through\":4294967295}", 0U);
  rig.forceHeartbeat();

  char expected[48] = {};
  snprintf(expected, sizeof(expected), "\"events_lost\":%lu", static_cast<unsigned long>(lost));
  TEST_ASSERT_NOT_NULL_MESSAGE(strstr(rig.http.lastBody(), expected),
                               "an overflow that nothing reports is an overflow that is silent");
}

/// E1(e). A HEARTBEAT WHOSE BODY NEVER ARRIVED IS A NO-PUSH, and round G2 made
/// it the quietest path in the firmware.
///
/// Before G2 an over-long body was truncated, `applyRoster` refused it, and the
/// counter moved. After G2 it became status 0 — correctly, a transport failure
/// — and `adoptHeartbeat` returned early on a 0, so the one diagnostic that
/// exists to say "this board's roster is not being refreshed" went silent in
/// exactly the case it was built for.
///
/// The fixture field that discriminates is `peerStatus`. With the fake
/// collapsing both to a single status — which is what `IHttpPort` returned
/// before round G3 — a failed body and a dead host are the same event and no
/// test can tell them apart.
void test_app_a_heartbeat_whose_body_never_arrived_counts_as_a_no_push() {
  Rig rig(kBaseMid);
  rig.boot(true);
  TEST_ASSERT_EQUAL_UINT32(0U, rig.app.noPushHeartbeats());

  // The server answered 200 and the body timed out, did not fit, or did not
  // frame. Every decision treats it as a transport failure; the counter still
  // has to move.
  rig.http.onPathBodyFailure(gatelogic::kPathHeartbeat, 200U, 0U);
  rig.forceHeartbeat();
  TEST_ASSERT_EQUAL_UINT32_MESSAGE(1U, rig.app.noPushHeartbeats(),
                                   "a 200 whose roster never arrived is exactly what no_push counts");

  // AND A HOST THAT NEVER ANSWERED IS NOT ONE. Inflating the number an admin
  // reads off the device row with ordinary outages would make it useless.
  rig.http.onPath(gatelogic::kPathHeartbeat, 0U, "", 0U);
  rig.forceHeartbeat();
  TEST_ASSERT_EQUAL_UINT32_MESSAGE(1U, rig.app.noPushHeartbeats(),
                                   "an unreachable host is an outage, not a failed roster push");

  // Nor is a refusal the board could read.
  rig.http.onPath(gatelogic::kPathHeartbeat, 401U, "", 0U);
  rig.forceHeartbeat();
  TEST_ASSERT_EQUAL_UINT32(1U, rig.app.noPushHeartbeats());

  // And it reaches the wire, which is the whole point.
  rig.http.onPathBodyFailure(gatelogic::kPathHeartbeat, 200U, 0U);
  rig.forceHeartbeat();
  TEST_ASSERT_EQUAL_UINT32(2U, rig.app.noPushHeartbeats());
  rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, 0U);
  rig.forceHeartbeat();
  TEST_ASSERT_NOT_NULL_MESSAGE(strstr(rig.http.lastBody(), "\"no_push\":2"),
                               "the count has to reach somewhere a person can see it");
}

/// E3. A DRAINING BACKLOG STILL LETS THE MEMBER AT THE DOOR THROUGH.
///
/// The deferral counter is cleared by whichever upload TAKES the pass. Cleared
/// only by the heartbeat — which is what round G2 wrote — a board with a full
/// ring sits at the bound for ever: every pass has an upload waiting, the
/// counter never falls back, and the forced branch takes the blocking call from
/// the scanner on every single pass until the ring empties. A door back from a
/// night offline has sixty-four events and would spend the first minutes of the
/// morning talking about last night instead of opening.
///
/// The fixture field that discriminates is the BACKLOG SIZE together with the
/// window: a ring that empties inside the window lets the scanner win
/// afterwards, and the test passes against the broken code.
void test_app_a_draining_backlog_still_lets_the_member_at_the_door_through() {
  Rig rig(kBaseMid);
  rig.boot(true);
  queueOfflineEvents(rig, static_cast<uint16_t>(gatelogic::kGateEventSlots));

  rig.http.onPath(gatelogic::kPathGate, 200U, "{\"opened\":false,\"reason\":\"not_recognised\"}", 200U);
  rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, 200U);
  // From the seq the ring actually holds: the boot event took 1 and was
  // released during boot(), so a server acknowledging 1 acknowledges nothing
  // and arms the backoff instead of draining.
  eventq::Event head;
  TEST_ASSERT_TRUE(rig.queue.peek(head));
  rig.http.acknowledgeOneAtATime(gatelogic::kPathEvents, head.seq, 200U);
  rig.link.set(true);
  rig.tick();
  rig.scanner.streamForever();
  rig.http.forget();

  // Ten seconds: far less than the ring takes to drain at one event per post,
  // so there is an upload waiting on every pass throughout.
  rig.runFor(10000UL);
  TEST_ASSERT_FALSE_MESSAGE(rig.queue.empty(),
                            "the ring has to still be draining for this to prove anything");

  TEST_ASSERT_TRUE_MESSAGE(rig.http.callsTo(gatelogic::kPathEvents) > 0U, "the backlog has to be moving");
  TEST_ASSERT_TRUE_MESSAGE(rig.http.callsTo(gatelogic::kPathGate) > 15U,
                           "a draining backlog must not take every pass from the scanner");
}

/// E4. A 404 ON `/events` KEEPS THE EVENT.
///
/// `devapi::react` classes a 404 as `Rejected` — "a 4xx the box caused, drop
/// it" — which is right for the court box and is SHARED, so it is not changed.
/// On this route a 404 has one production meaning: the API did not recognise
/// this MAC, because the device row was deleted in the console. The board
/// re-registers on its next heartbeat and the very same event is then accepted,
/// so dropping it throws away an evening of door entries to save twelve
/// requests an hour.
///
/// Before this, one 404 emptied the whole backlog, silently, one event per
/// pass.
void test_app_a_404_on_events_keeps_the_backlog_and_retries_it() {
  Rig rig(kBaseMid);
  rig.boot(true);
  queueOfflineEvents(rig, 3U);

  // Before the radio returns, for the reason above: the every-path default
  // would acknowledge the whole ring on the first post.
  rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, 0U);
  rig.http.onPath(gatelogic::kPathEvents, 404U, "", 0U);
  rig.link.set(true);
  rig.tick();
  const uint16_t held = rig.queue.size();
  TEST_ASSERT_TRUE(held >= 3U);

  // Long enough that a drop-per-pass would have emptied the ring thousands of
  // times over.
  rig.runFor(120000UL);

  TEST_ASSERT_EQUAL_UINT16_MESSAGE(held, rig.queue.size(),
                                   "a 404 on /events must not discard the audit backlog");
  // AND IT IS NOT A HOT LOOP EITHER: the backoff paces it, exactly as a 429 is
  // paced. Two minutes at 15 s doubling to 5 min is a handful of posts.
  TEST_ASSERT_TRUE_MESSAGE(rig.http.callsTo(gatelogic::kPathEvents) <= 8U,
                           "a refusing endpoint must be paced by the backoff");

  // And when the row comes back, so does the backlog.
  rig.http.onPath(gatelogic::kPathEvents, 200U, "{\"accepted_through\":4294967295}", 0U);
  rig.runFor(600000UL);
  TEST_ASSERT_TRUE_MESSAGE(rig.queue.empty(), "the kept events have to actually get through in the end");
}

/// G4 / B2. `opened` WAS READ BY A FLAT ANY-DEPTH SCAN, so a body that never
/// said the door should open at the top level opened it anyway.
///
/// `devapi::json::findKey` finds a key at ANY depth, deliberately — the court
/// box reads `button_map` out of the heartbeat's nested `config` with no path
/// expression at all — and `onGateResponse` used it for the one field that
/// drives a lock. `{"outer":{"opened":true}}` and `[{"opened":true}]` both
/// released it, and so did `{"opened":false,"detail":{"opened":true}}`, whose
/// TOP-LEVEL answer is a refusal.
///
/// `adoptUnlockMs` had already scoped `unlock_seconds` to the `gate` object and
/// written down why; this is the same rule applied to the field that matters
/// most and to the two beside it.
void test_gate_response_reads_only_the_top_level_object() {
  struct Row {
    const char* label;
    const char* body;
    bool opens;
  };

  const Row rows[] = {
      {"the contract's own open", "{\"opened\":true,\"reason\":\"ok\",\"unlock_seconds\":3}", true},
      {"the contract's own refusal", "{\"opened\":false,\"reason\":\"not_recognised\",\"unlock_seconds\":0}",
       false},
      {"nested in an object", "{\"outer\":{\"opened\":true,\"unlock_seconds\":3}}", false},
      {"a top-level array", "[{\"opened\":true,\"unlock_seconds\":3}]", false},
      {"a top-level refusal with a nested open", "{\"opened\":false,\"detail\":{\"opened\":true}}", false},
      {"a reason first, then a nested open",
       "{\"reason\":\"no\",\"meta\":{\"opened\":true,\"unlock_seconds\":30}}", false},
      {"a nested open BEFORE the real refusal",
       "{\"meta\":{\"opened\":true},\"opened\":false,\"reason\":\"not_recognised\"}", false},
      {"an open behind a decoy string value", "{\"reason\":\"opened\",\"opened\":true,\"unlock_seconds\":3}",
       true},
  };

  for (const Row& row : rows) {
    const gatelogic::ScanDecision decision =
        gatelogic::onGateResponse(200U, row.body, strlen(row.body), kDefaultMs, kCapMs);
    char message[256] = {};
    snprintf(message, sizeof(message), "%s: %s -> released=%d", row.label, row.body,
             decision.released ? 1 : 0);
    TEST_ASSERT_EQUAL_MESSAGE(row.opens, decision.released, message);
    // AND A BODY THAT SAID NOTHING AT THE TOP LEVEL IS AN OUTAGE, not a
    // refusal: nobody said no, so the roster gets its turn. That is the
    // existing rule for a 200 whose body is shaped differently from the
    // contract, and it has to keep holding for these.
    if (!row.opens && strstr(row.body, "\"opened\":false") == nullptr) {
      TEST_ASSERT_TRUE_MESSAGE(decision.fallbackToRoster, message);
    }
  }
}

/// G4 / B2. `unlock_seconds` and `reason` are scoped the same way, so a nested
/// number cannot drive the lock and a nested string cannot explain a decision
/// it had nothing to do with.
void test_gate_response_takes_its_duration_and_reason_from_the_top_level_too() {
  // A nested thirty beside a top-level three: the lock gets three.
  const char* body = "{\"opened\":true,\"reason\":\"ok\",\"unlock_seconds\":3,"
                     "\"debug\":{\"unlock_seconds\":30,\"reason\":\"tampered\"}}";
  gatelogic::ScanDecision decision = gatelogic::onGateResponse(200U, body, strlen(body), kDefaultMs, kCapMs);
  TEST_ASSERT_TRUE(decision.released);
  TEST_ASSERT_EQUAL_UINT32_MESSAGE(3000U, decision.unlockMs, body);
  TEST_ASSERT_EQUAL_STRING_MESSAGE("ok", decision.reason, body);

  // A nested one FIRST, which is the ordering a flat scan actually loses to.
  const char* decoyFirst = "{\"debug\":{\"unlock_seconds\":30,\"reason\":\"tampered\"},"
                           "\"opened\":true,\"reason\":\"ok\",\"unlock_seconds\":3}";
  decision = gatelogic::onGateResponse(200U, decoyFirst, strlen(decoyFirst), kDefaultMs, kCapMs);
  TEST_ASSERT_TRUE(decision.released);
  TEST_ASSERT_EQUAL_UINT32_MESSAGE(3000U, decision.unlockMs, decoyFirst);
  TEST_ASSERT_EQUAL_STRING_MESSAGE("ok", decision.reason, decoyFirst);

  // And a 200 that opens with NO top-level duration still falls back to the
  // adopted one rather than to a nested number.
  const char* noDuration = "{\"opened\":true,\"reason\":\"ok\",\"x\":{\"unlock_seconds\":30}}";
  decision = gatelogic::onGateResponse(200U, noDuration, strlen(noDuration), kDefaultMs, kCapMs);
  TEST_ASSERT_TRUE(decision.released);
  TEST_ASSERT_EQUAL_UINT32_MESSAGE(kDefaultMs, decision.unlockMs, noDuration);
}

// ---------------------------------------------------------------------------
// G4 / A4 — a board that has just been reset by its own watchdog
// ---------------------------------------------------------------------------

/// A4. The arithmetic, at every step: a healthy boot waits for nothing, a run
/// of watchdog resets doubles from one second to a five-minute ceiling, and any
/// boot that was NOT the watchdog's clears the run — somebody or something
/// intervened, and the next honest boot must not wait for a fault it did not
/// have.
void test_boot_recovery_backs_off_only_after_a_watchdog_reset() {
  TEST_ASSERT_EQUAL_UINT32(0U, gatelogic::nextResetRun(false, 0U));
  TEST_ASSERT_EQUAL_UINT32(0U, gatelogic::nextResetRun(false, 9U));
  TEST_ASSERT_EQUAL_UINT32(1U, gatelogic::nextResetRun(true, 0U));
  TEST_ASSERT_EQUAL_UINT32(5U, gatelogic::nextResetRun(true, 4U));
  // The run stops climbing rather than wrapping — it comes out of memory that
  // survived a reset, which is exactly the kind of value that is one day not
  // what anybody expected.
  TEST_ASSERT_EQUAL_UINT32(gatelogic::kMaxResetRun, gatelogic::nextResetRun(true, gatelogic::kMaxResetRun));
  TEST_ASSERT_EQUAL_UINT32(gatelogic::kMaxResetRun, gatelogic::nextResetRun(true, 0xFFFFFFFFUL));

  TEST_ASSERT_EQUAL_UINT32_MESSAGE(0U, gatelogic::firstCallDelayMs(0U),
                                   "a healthy boot must not wait for anything");
  TEST_ASSERT_EQUAL_UINT32(gatelogic::kResetBackoffStartMs, gatelogic::firstCallDelayMs(1U));
  TEST_ASSERT_EQUAL_UINT32(2U * gatelogic::kResetBackoffStartMs, gatelogic::firstCallDelayMs(2U));
  TEST_ASSERT_EQUAL_UINT32(4U * gatelogic::kResetBackoffStartMs, gatelogic::firstCallDelayMs(3U));

  // Monotonic, and capped rather than unbounded — a board that waited an hour
  // would have a club standing at a door whose API came back forty minutes ago.
  uint32_t previous = 0U;
  for (uint32_t run = 0U; run <= gatelogic::kMaxResetRun + 4U; ++run) {
    const uint32_t delay = gatelogic::firstCallDelayMs(run);
    TEST_ASSERT_TRUE(delay >= previous);
    TEST_ASSERT_TRUE(delay <= gatelogic::kResetBackoffMaxMs);
    previous = delay;
  }
  TEST_ASSERT_EQUAL_UINT32(gatelogic::kResetBackoffMaxMs,
                           gatelogic::firstCallDelayMs(gatelogic::kMaxResetRun));
}

/// A4, AND THE SEQUENCE THAT MAKES IT A LOOP RATHER THAN A FAULT.
///
/// `begin()` arms a heartbeat, `pumpLink`'s first up edge re-arms it to NOW,
/// and the heartbeat is the first thing a board does with its radio — so a peer
/// that dribbles headers holds that very call until the watchdog resets the
/// part, which lands back in `begin()` and does it again. For ever, with no
/// roster and a door that admits nobody.
///
/// A board that has just been reset by its watchdog therefore holds its first
/// network call back — and spends the wait in the ordinary loop, alive and
/// kicking its watchdog, rather than in a reset.
void test_app_a_board_the_watchdog_reset_holds_its_first_call_back() {
  for (size_t b = 0U; b < kBaseCount; ++b) {
    // A healthy boot is unaffected: the FIRST assertion, because a backoff that
    // slowed an ordinary board down would be a worse defect than the one it
    // closes.
    Rig healthy(kBases[b]);
    healthy.boot(true);
    healthy.http.forget();
    healthy.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, 0U);
    healthy.forceHeartbeat();
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(0U, healthy.app.firstCallHeldBackMs(),
                                     "a healthy boot must wait for nothing");
    TEST_ASSERT_TRUE_MESSAGE(healthy.http.callsTo(gatelogic::kPathHeartbeat) > 0U,
                             "and must still heartbeat at once");

    // Three watchdog resets deep: four seconds before the first call.
    Rig hurt(kBases[b]);
    hurt.watchdogResetRun = 3U;
    hurt.rewire();
    hurt.bootRaw(true);
    hurt.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, 0U);
    hurt.http.onPath(gatelogic::kPathEvents, 200U, "{\"accepted_through\":4294967295}", 0U);
    TEST_ASSERT_EQUAL_UINT32(gatelogic::firstCallDelayMs(3U), hurt.app.firstCallHeldBackMs());

    hurt.runFor(gatelogic::firstCallDelayMs(3U) - 200U);
    TEST_ASSERT_EQUAL_UINT16_MESSAGE(0U, hurt.http.calls(),
                                     "a board the watchdog just reset must not reach that peer again "
                                     "within a second of associating");
    // AND IT IS ALIVE THROUGHOUT, which is the whole point: the wait is spent
    // in the ordinary loop with the watchdog kicked, not in a reset.
    TEST_ASSERT_TRUE_MESSAGE(
        hurt.watchdog.longestGapMs() < static_cast<uint32_t>(gatelogic::kGateConfig.watchdogSeconds) * 1000UL,
        "the board has to STAY UP through the wait — the whole point is that it spends it in the "
        "loop rather than in a reset");

    // Past the hold, it tries again — a board that gave up would never recover
    // when the proxy came back.
    hurt.runFor(1000U);
    TEST_ASSERT_TRUE_MESSAGE(hurt.http.callsTo(gatelogic::kPathHeartbeat) > 0U,
                             "the backoff must delay the first call, never cancel it");

    // THE EVENT DRAIN IS HELD BACK WITH IT. `begin()` queues a boot event on
    // every boot, so a drain that was not gated would reach the same peer on
    // the same first pass and the hold would have bought nothing.
    Rig drained(kBases[b]);
    drained.watchdogResetRun = 3U;
    drained.rewire();
    drained.bootRaw(true);
    drained.http.onPath(gatelogic::kPathEvents, 200U, "{\"accepted_through\":4294967295}", 0U);
    drained.runFor(gatelogic::firstCallDelayMs(3U) - 200U);
    TEST_ASSERT_EQUAL_UINT16_MESSAGE(0U, drained.http.callsTo(gatelogic::kPathEvents),
                                     "the boot event must not reach the peer inside the hold");
  }
}

// ---------------------------------------------------------------------------
// G4 / A2 — what bounds the rate this board asks the server at
// ---------------------------------------------------------------------------

/// A2. TWO ALTERNATING TOKENS DEFEATED THE DEBOUNCE COMPLETELY, because it held
/// exactly one: every scan differed from the one before, nothing was ever
/// suppressed, and the board made a measured ~18 POSTs a second to `/gate`. A
/// code taped beside a reader plus a member's own phone is enough.
void test_app_alternating_tokens_cannot_hammer_the_gate_endpoint() {
  Rig rig(kBaseMid);
  rig.boot(true);
  rig.http.setLatency(0U);
  rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, 0U);
  rig.http.onPath(gatelogic::kPathGate, 200U, kOpenThreeSeconds, 0U);
  rig.forceHeartbeat();
  rig.http.forget();

  const uint32_t start = rig.clock.value();
  uint32_t alternate = 0U;
  while (tb::since(rig.clock.value(), start) < 10000UL) {
    if (rig.scanner.drained()) {
      rig.scanner.feed((alternate % 2U) == 0U ? "TOKENAAAAAAA\n" : "TOKENBBBBBBB\n");
      ++alternate;
    }
    rig.tick();
  }

  // TEN SECONDS. The floor allows four calls a second, and the debounce should
  // be doing most of the work here — two tokens fit in four slots, so after the
  // first two decisions every scan for the next two seconds is a repeat.
  const uint32_t calls = rig.http.callsTo(gatelogic::kPathGate);
  char message[128] = {};
  snprintf(message, sizeof(message), "%lu calls to /gate in ten simulated seconds",
           static_cast<unsigned long>(calls));
  TEST_ASSERT_TRUE_MESSAGE(calls <= 12U, message);
  // AND IT IS NOT MUTE EITHER: the two members are decided.
  TEST_ASSERT_TRUE_MESSAGE(calls >= 2U, message);
}

/// A2. The debounce is what makes the common case free, and it holds SEVERAL
/// tokens now — so a queue at a door is still several decisions with no wait,
/// and only a stream of tokens nobody has seen before meets the floor.
void test_debounce_remembers_several_tokens_and_still_never_delays_a_new_one() {
  gatelogic::ScanDebounce debounce;
  const char* tokens[] = {"MEMBERAAAAAA", "MEMBERBBBBBB", "MEMBERCCCCCC", "MEMBERDDDDDD"};

  // Four members arriving together: four decisions, none suppressed.
  for (size_t i = 0U; i < 4U; ++i) {
    TEST_ASSERT_FALSE_MESSAGE(debounce.suppresses(tokens[i], kBaseMid + static_cast<uint32_t>(i) * 100U),
                              tokens[i]);
    debounce.decided(tokens[i], kBaseMid + static_cast<uint32_t>(i) * 100U);
  }
  // And every one of them is now a repeat, which one slot could never say.
  for (size_t i = 0U; i < 4U; ++i) {
    TEST_ASSERT_TRUE_MESSAGE(debounce.suppresses(tokens[i], kBaseMid + 500U), tokens[i]);
  }
  // A FIFTH is still decided at once: the ring costs the oldest its slot, which
  // means it is asked about again — the safe direction, since nothing here can
  // deny anybody.
  TEST_ASSERT_FALSE(debounce.suppresses("MEMBEREEEEEE", kBaseMid + 500U));
  debounce.decided("MEMBEREEEEEE", kBaseMid + 500U);
  TEST_ASSERT_FALSE(debounce.suppresses(tokens[0], kBaseMid + 600U));

  // Past the window everything is decided again, at every clock base.
  for (size_t b = 0U; b < kBaseCount; ++b) {
    gatelogic::ScanDebounce fresh;
    fresh.decided("MEMBERAAAAAA", kBases[b]);
    TEST_ASSERT_TRUE(fresh.suppresses("MEMBERAAAAAA", kBases[b] + gatelogic::kScanDebounceMs - 1U));
    TEST_ASSERT_FALSE(fresh.suppresses("MEMBERAAAAAA", kBases[b] + gatelogic::kScanDebounceMs));
  }

  // ONE PHONE HELD AT THE READER MUST NOT WALK ITSELF THROUGH EVERY SLOT. A
  // re-decision of a token already held re-stamps it in place; otherwise a
  // member leaving their phone there for a minute pushes the other four out and
  // the single-slot defect is back with more steps.
  gatelogic::ScanDebounce held;
  held.decided("MEMBERAAAAAA", kBaseMid);
  held.decided("MEMBERBBBBBB", kBaseMid + 10U);
  for (uint32_t t = 20U; t < 200U; t += 10U) {
    held.decided("MEMBERBBBBBB", kBaseMid + t);
  }
  TEST_ASSERT_TRUE_MESSAGE(held.suppresses("MEMBERAAAAAA", kBaseMid + 300U),
                           "a held phone must not evict the members around it");
}

/// A2. A scan the floor refuses is ANSWERED, and it is never answered from the
/// roster — a throttle this board imposed on itself must not open a door the
/// API would have refused.
void test_app_a_rate_limited_scan_is_refused_rather_than_decided_from_the_roster() {
  Rig rig(kBaseMid);
  rig.boot(true);
  rig.http.setLatency(0U);
  rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, 0U);
  // The API would REFUSE this member — a membership barred this morning, which
  // is the case the roster cannot know about. The roster still carries them.
  rig.http.onPath(gatelogic::kPathGate, 200U,
                  "{\"opened\":false,\"reason\":\"member_not_active\",\"unlock_seconds\":0}", 0U);
  rig.forceHeartbeat();
  TEST_ASSERT_EQUAL_UINT8(1U, rig.roster.size());

  // A first scan of some other code, to arm the floor.
  rig.scanner.feed("OTHERTOKEN00\n");
  rig.tick();
  rig.tick();

  // And the barred member, inside the floor.
  rig.scanner.feed("MEMBERTOKEN1\n");
  rig.tick();
  rig.tick();

  TEST_ASSERT_FALSE_MESSAGE(rig.lock.released(),
                            "a rate-limited scan must never be answered from the roster");
  TEST_ASSERT_EQUAL_STRING(gatelogic::kReasonTooFast, rig.log.last().reason);
  TEST_ASSERT_FALSE(rig.log.last().released);

  // Past the floor, the same member is asked about and refused by the API —
  // which is the answer that was always correct.
  rig.runFor(gatelogic::kMinScanCallSpacingMs + gatelogic::kScanDebounceMs);
  rig.scanner.feed("MEMBERTOKEN1\n");
  rig.tick();
  rig.tick();
  TEST_ASSERT_FALSE(rig.lock.released());
  TEST_ASSERT_EQUAL_STRING("member_not_active", rig.log.last().reason);
}

// ---------------------------------------------------------------------------
// G4 / C2 — the boot identity every batch carries
// ---------------------------------------------------------------------------

/// C2. Every uploaded batch names the boot it came from, so a board that
/// renumbered from 1 after a torn sequence mark is a different board-life
/// rather than an evening of duplicates.
void test_app_every_uploaded_batch_carries_this_boots_identity() {
  for (size_t b = 0U; b < kBaseCount; ++b) {
    Rig rig(kBases[b], 0x2BCD1234UL);
    rig.boot(true);
    queueOfflineEvents(rig, 1U);
    rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, 0U);
    rig.http.onPath(gatelogic::kPathEvents, 200U, "{\"accepted_through\":4294967295}", 0U);
    rig.link.set(true);
    rig.runFor(2000UL);

    TEST_ASSERT_EQUAL_STRING(gatelogic::kPathEvents, rig.http.lastPath());
    TEST_ASSERT_NOT_NULL_MESSAGE(strstr(rig.http.lastBody(), "\"boot_id\":734859828,"), rig.http.lastBody());
    // IMMEDIATELY AFTER THE MAC, because the corpus pins the bytes and not the
    // keys: a field in the wrong place is a body the byte-identity test fails.
    TEST_ASSERT_NOT_NULL_MESSAGE(
        strstr(rig.http.lastBody(), "{\"mac\":\"5ccf7f0a1b2c\",\"boot_id\":734859828,\"uptime_ms\":"),
        rig.http.lastBody());
    TEST_ASSERT_EQUAL_UINT32(0x2BCD1234UL, rig.app.bootId());
  }
}

/// C2. Two boots of one board that BOTH renumbered from 1 are distinguishable
/// on the wire — which is the whole property, said as a difference rather than
/// as a field being present.
void test_app_two_boots_that_both_start_at_seq_one_are_told_apart() {
  char first[640] = {};
  char second[640] = {};
  const uint32_t boots[] = {0x1111'1111UL, 0x2222'2222UL};

  for (size_t i = 0U; i < 2U; ++i) {
    Rig rig(kBaseMid, boots[i]);
    rig.boot(true);
    // A FRESH STORE per rig, so the sequence really does restart at 1 — which
    // is the state a torn or erased `evq_seq` mark leaves a board in.
    queueOfflineEvents(rig, 1U);
    rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, 0U);
    rig.http.onPath(gatelogic::kPathEvents, 200U, "{\"accepted_through\":4294967295}", 0U);
    rig.link.set(true);
    rig.runFor(2000UL);
    strncpy(i == 0U ? first : second, rig.http.lastBody(), 639U);
  }

  TEST_ASSERT_NOT_NULL_MESSAGE(strstr(first, "\"seq\":2,"), first);
  TEST_ASSERT_NOT_NULL_MESSAGE(strstr(second, "\"seq\":2,"), second);
  TEST_ASSERT_TRUE_MESSAGE(strcmp(first, second) != 0,
                           "two boots that both renumbered must not send identical batches");
}

// ---------------------------------------------------------------------------
// G4 / L1 — a line the board could not read is answered, and bounded
// ---------------------------------------------------------------------------

/// L1. `pumpScanner`'s comment has promised a member feedback on a holed line
/// since it was written, and the assembler returned `None` for one: no blink,
/// no record, nothing. A member stood at a door that gave them nothing back.
void test_app_a_corrupt_line_gives_the_member_an_answer() {
  for (size_t b = 0U; b < kBaseCount; ++b) {
    Rig rig(kBases[b]);
    rig.boot(true);
    rig.http.setLatency(0U);
    rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, 0U);
    rig.forceHeartbeat();
    rig.log.forget();

    const uint32_t mark = rig.relayPin.opCount();
    // A NUL out of a framing error, in the middle of an otherwise fine line.
    rig.scanner.feed("AB\x01"
                     "CD\n");
    rig.tick();
    rig.tick();

    TEST_ASSERT_EQUAL_size_t_MESSAGE(1U, rig.log.total(),
                                     "a line the board could not read has to be ANSWERED");
    TEST_ASSERT_FALSE_MESSAGE(rig.log.last().released, "and answered as a refusal");
    TEST_ASSERT_EQUAL_STRING(gatelogic::kReasonNotRecognised, rig.log.last().reason);
    // NO TOKEN. The bytes were discarded rather than truncated, and a token cut
    // short is a different member's token.
    TEST_ASSERT_EQUAL_STRING("", rig.log.last().token);
    TEST_ASSERT_EQUAL_size_t_MESSAGE(mark, rig.relayPin.opCount(), "and the lock never moves for one");
  }
}

/// L1's other half, and the reason the feedback is safe to give at all: 9600
/// baud beside a switching relay coil produces holed lines by the HUNDRED.
/// Unlimited, the lamp would strobe and — offline — the event ring would fill
/// with noise and evict the admissions that matter.
void test_app_line_noise_cannot_strobe_the_lamp_or_fill_the_ring() {
  Rig rig(kBaseMid);
  rig.boot(true);
  rig.http.setLatency(0U);
  rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, 0U);
  rig.forceHeartbeat();
  rig.link.set(false);
  rig.tick();
  rig.log.forget();
  const uint16_t queuedBefore = rig.queue.size();

  // Fifty holed lines, faster than any member could present them.
  for (int i = 0; i < 50; ++i) {
    if (rig.scanner.drained()) {
      rig.scanner.feed("A\x01"
                       "B\n");
    }
    rig.tick();
  }

  TEST_ASSERT_EQUAL_size_t_MESSAGE(1U, rig.log.total(), "fifty holed lines inside one window are ONE answer");
  TEST_ASSERT_EQUAL_UINT16_MESSAGE(static_cast<uint16_t>(queuedBefore + 1U), rig.queue.size(),
                                   "and ONE record, or line noise evicts the opens that matter");

  // Past the window, the next one is answered again — rate-limited, not muted.
  rig.runFor(gatelogic::kUnreadableFeedbackMs + gatelogic::kIdleDelayMs);
  rig.log.forget();
  rig.scanner.feed("A\x01"
                   "B\n");
  rig.tick();
  rig.tick();
  TEST_ASSERT_EQUAL_size_t_MESSAGE(1U, rig.log.total(),
                                   "a member who comes back a moment later is still answered");
}

// ---------------------------------------------------------------------------
// G4 / A1 — the hard cap, through the whole loop rather than through the timer
// ---------------------------------------------------------------------------

/// THE SEQUENCE THE FINDER MEASURED ON THE REAL SIMULATOR, in the rig.
///
/// Two alternating tokens defeat the single-slot debounce, so a decision is
/// offered on every pass. `pass()` pumps the lock out of `afterBlocking()` and
/// applies the decision that call produced two lines later, so the close and
/// the re-open land in ONE pass: relay OFF at t=31034 ms and ON at t=31034 ms,
/// measured, then +42 ms, then +45 ms, for ever. The door never relocked.
///
/// Sampling `released()` once per pass is deliberately the WEAKEST observation
/// that can see this, and that is the point: a within-pass OFF/ON is invisible
/// to it, so the shipped firmware reads here as "released, every pass, for two
/// minutes" — which is exactly what it was.
void test_app_two_alternating_tokens_cannot_hold_the_door_open_for_ever() {
  for (size_t b = 0U; b < kBaseCount; ++b) {
    Rig rig(kBases[b]);
    rig.boot(true);
    rig.http.setLatency(0U);
    rig.http.onPath(gatelogic::kPathGate, 200U, kOpenThreeSeconds, 0U);
    rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, 0U);
    rig.http.onPath(gatelogic::kPathEvents, 200U, "{\"accepted_through\":4294967295}", 0U);

    uint32_t releasedRun = 0U;
    uint32_t longestReleased = 0U;
    uint32_t darkRun = 0U;
    uint32_t longestDarkAfterCap = 0U;
    bool everCapped = false;

    const uint32_t start = rig.clock.value();
    uint32_t previous = start;
    uint32_t alternate = 0U;
    // SAMPLED INSIDE THE LOOP, because the decision log is a ring of 32 and
    // this scenario makes several thousand decisions: the dwell's refusals
    // happen right after each cap and are long gone from the ring by the end.
    bool sawRelocking = false;
    while (tb::since(rig.clock.value(), start) < 120000UL) {
      if (rig.scanner.drained()) {
        rig.scanner.feed((alternate % 2U) == 0U ? "TOKENAAAAAAA\n" : "TOKENBBBBBBB\n");
        ++alternate;
      }
      rig.tick();
      if (rig.log.count() > 0U && strcmp(rig.log.last().reason, gatelogic::kReasonRelocking) == 0) {
        sawRelocking = true;
      }
      // MEASURED OFF THE CLOCK, not counted in passes: the scanner fake charges
      // a millisecond a byte, exactly as 9600 baud does, so a pass is not a
      // fixed length and counting them would measure the wrong thing.
      const uint32_t elapsed = tb::since(rig.clock.value(), previous);
      previous = rig.clock.value();
      if (rig.lock.released()) {
        releasedRun += elapsed;
        if (releasedRun > longestReleased) {
          longestReleased = releasedRun;
        }
        darkRun = 0U;
      } else {
        darkRun += elapsed;
        releasedRun = 0U;
        if (rig.app.capForcedCloses() > 0U) {
          everCapped = true;
          if (darkRun > longestDarkAfterCap) {
            longestDarkAfterCap = darkRun;
          }
        }
      }
    }

    char message[224] = {};
    snprintf(message, sizeof(message),
             "base %lu: longest continuous release %lu ms, longest dark after a cap %lu ms, "
             "cap-forced closes %lu",
             static_cast<unsigned long>(kBases[b]), static_cast<unsigned long>(longestReleased),
             static_cast<unsigned long>(longestDarkAfterCap),
             static_cast<unsigned long>(rig.app.capForcedCloses()));

    TEST_ASSERT_TRUE_MESSAGE(everCapped, message);
    // The window bound, which held before this round — stated as the firmware's
    // own documented overrun rather than as a tight number, because the relay
    // write waits for whatever pass the deadline falls inside. See GateApp.h.
    TEST_ASSERT_TRUE_MESSAGE(
        longestReleased <= kCapMs + gatelogic::kWorstBlockingCallMs + gatelogic::kIdleDelayMs, message);
    // The DOOR bound, which did not exist: after the cap overrules them, the
    // lock is genuinely de-energised for long enough to relatch.
    TEST_ASSERT_TRUE_MESSAGE(longestDarkAfterCap >= kDwellMs, message);
    // AND THE MEMBER IS TOLD, rather than the scan vanishing. The dwell's
    // refusals are recorded with their own reason, so a desk reading the trail
    // sees "somebody is holding this door open" rather than nothing at all.
    TEST_ASSERT_TRUE_MESSAGE(sawRelocking, "a scan refused by the dwell must be answered, not lost");
  }
}

/// A1. A scan that meets the dwell is refused WITHOUT asking the API, on the
/// debounce's own precedent — and, offline, the record it queues says a scan
/// was refused rather than that a door opened.
void test_app_a_scan_inside_the_relock_dwell_costs_no_call_and_records_no_opening() {
  Rig rig(kBaseMid);
  rig.boot(true);
  rig.http.setLatency(0U);
  rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, 0U);
  rig.forceHeartbeat();

  // Offline, so the roster decides and the record is queued.
  rig.link.set(false);
  rig.tick();
  const uint16_t queuedBefore = rig.queue.size();

  rig.scanner.feed("MEMBERTOKEN1\n");
  rig.tick();
  rig.tick();
  TEST_ASSERT_TRUE_MESSAGE(rig.lock.released(), "the scenario needs the door to open first");

  // Let the window end, then scan again inside the dwell. A DIFFERENT token, so
  // the debounce is not what refuses it.
  rig.runFor(gatelogic::kGateConfig.unlockDefaultMs + 2U * gatelogic::kIdleDelayMs);
  TEST_ASSERT_FALSE_MESSAGE(rig.lock.released(), "the window has to have closed");

  rig.scanner.feed("MEMBERTOKEN1\n");
  rig.tick();
  rig.tick();

  TEST_ASSERT_FALSE_MESSAGE(rig.lock.released(), "the lock must stay de-energised through the dwell");
  TEST_ASSERT_EQUAL_STRING_MESSAGE(gatelogic::kReasonRelocking, rig.log.last().reason,
                                   "the member is told why, in a word that is about the door");
  TEST_ASSERT_FALSE_MESSAGE(rig.log.last().released, "and the log must not claim a release");

  // The queued record: an `unknown_scan`, never a `gate_open` for a door that
  // did not move. Read off the ring's growth plus the decision's own flag.
  TEST_ASSERT_TRUE_MESSAGE(rig.log.last().queued, "an offline refusal is still evidence");
  TEST_ASSERT_TRUE(rig.queue.size() > queuedBefore);
}

/// A1. ONLINE, the dwell refuses BEFORE the API is asked — the debounce's own
/// precedent. Two things turn on it: a `/gate` call spent on a door that cannot
/// open is the pass spent on nothing, and a 200 answering `opened` would put a
/// door opening in the server's audit trail that did not happen.
void test_app_a_scan_inside_the_relock_dwell_never_reaches_the_api() {
  Rig rig(kBaseMid);
  rig.boot(true);
  rig.http.setLatency(0U);
  rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, 0U);
  rig.http.onPath(gatelogic::kPathGate, 200U, kOpenThreeSeconds, 0U);
  rig.forceHeartbeat();

  rig.scanner.feed("MEMBERTOKEN1\n");
  rig.tick();
  rig.tick();
  TEST_ASSERT_TRUE_MESSAGE(rig.lock.released(), "the scenario needs the door to open first");
  rig.runFor(gatelogic::kGateConfig.unlockDefaultMs + 2U * gatelogic::kIdleDelayMs);
  TEST_ASSERT_FALSE_MESSAGE(rig.lock.released(), "the window has to have closed");

  const uint32_t gateCallsBefore = rig.http.callsTo(gatelogic::kPathGate);
  rig.scanner.feed("MEMBERTOKEN1\n");
  rig.tick();
  rig.tick();

  TEST_ASSERT_EQUAL_UINT32_MESSAGE(gateCallsBefore, rig.http.callsTo(gatelogic::kPathGate),
                                   "a scan the board cannot honour is not a question for the API");
  TEST_ASSERT_FALSE(rig.lock.released());
  TEST_ASSERT_EQUAL_STRING(gatelogic::kReasonRelocking, rig.log.last().reason);
}

/// A1's SECOND HALF, and the exact interleaving the finder measured: the window
/// closes INSIDE the blocking call that decided the next scan.
///
/// `pass()` calls `pumpLock()` from `afterBlocking()` and applies the decision
/// two lines later, so a twelve-second `/gate` call that starts while the door
/// is open returns to find the window over — and the API has said `opened`. The
/// relay would be written OFF and ON at the same millisecond. The pre-check
/// above cannot see this one: at the instant the scan was decided, the door was
/// still released and there was no dwell to meet.
void test_app_a_window_that_closes_inside_the_call_that_granted_the_next_one() {
  for (size_t b = 0U; b < kBaseCount; ++b) {
    Rig rig(kBases[b]);
    rig.boot(true);
    rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, 0U);
    rig.forceHeartbeat();
    // A WHOLE WORST-CASE CALL, which is what makes the window end inside it.
    rig.http.onPath(gatelogic::kPathGate, 200U, kOpenThreeSeconds, gatelogic::kWorstBlockingCallMs);

    rig.scanner.feed("TOKENAAAAAAA\n");
    rig.tick();
    rig.tick();
    TEST_ASSERT_TRUE_MESSAGE(rig.lock.released(), "the first member has to get in");

    // The second member, decided while the door is still open, granted by the
    // API, and applied after the first member's window has ended.
    rig.scanner.feed("TOKENBBBBBBB\n");
    rig.tick();
    rig.tick();

    char message[160] = {};
    snprintf(message, sizeof(message), "base %lu: reason=%s released=%d",
             static_cast<unsigned long>(kBases[b]), rig.log.last().reason, rig.log.last().released ? 1 : 0);

    TEST_ASSERT_FALSE_MESSAGE(rig.lock.released(), message);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(gatelogic::kReasonRelocking, rig.log.last().reason, message);
    // AND THE RECORD SAYS SO. A decision left claiming `released` would have
    // this board report an opening it refused — the one thing an audit trail
    // must never contain.
    TEST_ASSERT_FALSE_MESSAGE(rig.log.last().released, message);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(0U, rig.log.last().grantedMs, message);
  }
}

// ---------------------------------------------------------------------------
// G4 / C1 — the uptime a real board's events actually go up with
// ---------------------------------------------------------------------------

/// The decimal number after the `n`th occurrence of `"<key>":` in `body`.
/// UINT64_MAX when there is no such occurrence, which fails every assertion
/// below rather than passing one by accident.
uint64_t numberAfter(const char* body, const char* key, int occurrence) {
  const char* at = body;
  for (int i = 0; i <= occurrence; ++i) {
    at = strstr(at, key);
    if (at == nullptr) {
      return UINT64_MAX;
    }
    at += strlen(key);
  }
  uint64_t value = 0U;
  if (*at < '0' || *at > '9') {
    return UINT64_MAX;
  }
  while (*at >= '0' && *at <= '9') {
    value = value * 10ULL + static_cast<uint64_t>(*at - '0');
    ++at;
  }
  return value;
}

void test_app_an_offline_record_is_stamped_with_an_uptime_the_server_can_read() {
  // G4 / C1, AND THE REASON NOTHING EVER SAW IT: the simulator's default
  // `--start-ms 0` is the one value of millis()-at-begin() that hides it.
  //
  // `begin()` seeded the accumulator's `last_` from millis() and left its total
  // at ZERO, while every event was stamped with the RAW millis() reading. So on
  // a board whose clock read R when begin() ran — which is EVERY ESP32, because
  // the core's init, Serial.begin, NVS, the UART driver and WiFi.begin all run
  // first — the batch's own uptime was R ms BEHIND every stamp in it, and
  // tb::widen underflowed to about 1.8e19 for anything uploaded less than R ms
  // after it was scanned. The server binds uptime_ms as a signed 64-bit and
  // refuses the body: in production a bare 400, which this drain reads as "a
  // 4xx the board caused" and DROPS — the offline entry is gone.
  //
  // Every base, because the wrap is the normal case on a board that runs for
  // months and the seed is exactly where a wrap-time boot would land.
  for (size_t i = 0U; i < kBaseCount; ++i) {
    Rig rig(kBases[i]);
    rig.boot(true);
    queueOfflineEvents(rig, 2U);

    rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, 0U);
    rig.http.onPath(gatelogic::kPathEvents, 200U, "{\"accepted_through\":4294967295}", 0U);
    rig.link.set(true);
    // Straight back up: the upload happens a few passes after the scan, which
    // is precisely the window the underflow lived in.
    rig.runFor(2000UL);

    TEST_ASSERT_EQUAL_STRING_MESSAGE(gatelogic::kPathEvents, rig.http.lastPath(),
                                     "the offline records have to reach /events at all");

    const uint64_t batch = numberAfter(rig.http.lastBody(), "\"uptime_ms\":", 0);
    const uint64_t stamp = numberAfter(rig.http.lastBody(), "\"uptime_ms\":", 1);
    char message[192] = {};
    snprintf(message, sizeof(message), "base %lu: event uptime %llu is ahead of the batch's %llu — %s",
             static_cast<unsigned long>(kBases[i]), static_cast<unsigned long long>(stamp),
             static_cast<unsigned long long>(batch), rig.http.lastBody());
    TEST_ASSERT_TRUE_MESSAGE(stamp <= batch, message);

    // AND IT IS A NUMBER THE SERVER'S COLUMN HOLDS. `long` is what binds
    // `uptime_ms`, so anything past INT64_MAX is a 400 on the whole batch
    // whatever the arithmetic meant by it.
    TEST_ASSERT_TRUE_MESSAGE(batch <= 0x7FFFFFFFFFFFFFFFULL, message);
    TEST_ASSERT_TRUE_MESSAGE(stamp <= 0x7FFFFFFFFFFFFFFFULL, message);

    // And the event genuinely left: a board that kept it would pass the two
    // assertions above on a body it never got to send.
    TEST_ASSERT_TRUE_MESSAGE(rig.queue.empty(), "the acknowledged records have to leave the ring");
  }
}

// ---------------------------------------------------------------------------
// E3 — the response body, bounded by the caller's buffer and the call's clock
// ---------------------------------------------------------------------------

/// A peer that delivers a body in CHUNKS, with a settable cost per wait.
///
/// The cost is what makes a dribbling peer a fixture. `idle()` advancing the
/// clock is the same trick the HTTP fake plays: without it "waits for ever" is
/// a story rather than a test, and the deadline the whole of E3 is about cannot
/// be reached.
class FakeResponseStream final : public gatelogic::IResponseStream {
public:
  FakeResponseStream(fakes::FakeClock& clock, uint32_t idleCostMs) : clock_(clock), idleCost_(idleCostMs) {}

  /// Bytes the peer will hand over, `perWait` at a time.
  void deliver(const char* text, size_t perWait) {
    strncpy(body_, text, sizeof(body_) - 1U);
    body_[sizeof(body_) - 1U] = '\0';
    len_ = strlen(body_);
    perWait_ = perWait;
    ready_ = perWait_;
  }

  /// The peer hangs up once its bytes are gone. False for a peer that holds the
  /// socket open after the body, which is what a keep-alive connection does and
  /// what makes Content-Length the only end marker.
  void closesWhenDone(bool closes) { closes_ = closes; }

  int available() override { return static_cast<int>(ready_ < len_ - at_ ? ready_ : len_ - at_); }

  int read() override {
    if (at_ >= len_ || ready_ == 0U) {
      return -1;
    }
    --ready_;
    const int value = static_cast<unsigned char>(body_[at_]);
    ++at_;
    return value;
  }

  bool connected() override { return !(closes_ && at_ >= len_); }

  void idle() override {
    clock_.advance(idleCost_);
    ready_ = perWait_;
  }

private:
  fakes::FakeClock& clock_;
  /// Big enough for the REAL captured heartbeat: one chunk of 0x5d1 = 1489
  /// bytes plus its framing. 512 was enough while every fixture was invented.
  char body_[8192] = {};
  size_t len_ = 0U;
  size_t at_ = 0U;
  size_t perWait_ = 0U;
  size_t ready_ = 0U;
  uint32_t idleCost_ = 0U;
  bool closes_ = true;
};

constexpr char kScanOk[] = "{\"opened\":true,\"reason\":\"ok\",\"unlock_seconds\":3}";

// ---------------------------------------------------------------------------
// E1 — THE FRAMING, AND THE BYTES ARE THE ONES A REAL SERVER SENT
// ---------------------------------------------------------------------------
//
// Every fixture in this section that is called a capture IS one, taken off the
// wire against the real API under Kestrel during round G3. They matter because
// nothing in this repository had ever read a real socket, and the round-G2
// reader — which asked only `http.getSize()` and treated -1 as "read until the
// peer closes" — passed every invented fixture and timed out on EVERY call
// against the actual server. No roster, and a door that refused everyone.
//
// What was observed:
//   * HTTP/1.1: `Transfer-Encoding: chunked`, NO Content-Length, and the socket
//     HELD OPEN afterwards (HTTPClient defaults to keep-alive). A 61-byte gate
//     response arrives as `3d\r\n<61 bytes>\r\n0\r\n\r\n`;
//   * a full 48-entry heartbeat is ONE chunk of 0x5d1 = 1489 bytes;
//   * HTTP/1.0: close-delimited, no Content-Length, `Connection: close`.

/// The `/api/v1/device/gate` 200, exactly as Kestrel framed it over HTTP/1.1.
constexpr char kCapturedGatePayload[] =
    "{\"opened\":true,\"reason\":\"ok\",\"unlock_seconds\":3,\"court\":null}";
constexpr char kCapturedGateChunked[] =
    "3d\r\n{\"opened\":true,\"reason\":\"ok\",\"unlock_seconds\":3,\"court\":null}\r\n0\r\n\r\n";

/// `3d` is 61, and the payload had better be 61 bytes or the capture has been
/// edited and stopped being a capture.
static_assert(sizeof(kCapturedGatePayload) - 1U == 0x3dU,
              "the captured chunk-size line and the captured payload disagree");

/// Wraps `payload` as ONE chunk with a correctly-sized hex length line, the way
/// Kestrel frames a whole document it rendered in one go.
size_t wrapAsOneChunk(const char* payload, char* out, size_t cap) {
  const int written =
      snprintf(out, cap, "%lx\r\n%s\r\n0\r\n\r\n", static_cast<unsigned long>(strlen(payload)), payload);
  TEST_ASSERT_TRUE(written > 0 && static_cast<size_t>(written) < cap);
  return static_cast<size_t>(written);
}

/// A heartbeat body of exactly `bytes` characters that is still a document the
/// roster parser would accept: the padding rides in a key nothing reads.
void buildHeartbeatOfSize(char* out, size_t cap, size_t bytes) {
  const char* head = "{\"kind\":\"gate\",\"roster\":[],\"pad\":\"";
  const char* tail = "\"}";
  TEST_ASSERT_TRUE(bytes > strlen(head) + strlen(tail) && bytes < cap);
  const size_t padding = bytes - strlen(head) - strlen(tail);
  strncpy(out, head, cap - 1U);
  for (size_t i = 0U; i < padding; ++i) {
    out[strlen(head) + i] = 'p';
  }
  strncpy(out + strlen(head) + padding, tail, cap - strlen(head) - padding - 1U);
  out[bytes] = '\0';
  TEST_ASSERT_EQUAL_size_t(bytes, strlen(out));
}

/// E1. A body that FITS arrives whole however the TCP SEGMENTS fall.
///
/// RENAMED. This was `..._however_it_is_chunked`, which read as though it
/// covered `Transfer-Encoding: chunked` — the one framing nothing tested and
/// the one the real server uses. It is about segmentation: the same bytes
/// handed over one, three, sixteen or five hundred at a time. The chunked
/// coding is three tests below this one.
void test_body_a_body_that_fits_arrives_whole_however_the_segments_fall() {
  const size_t perWaits[] = {1U, 3U, 16U, 512U};

  for (size_t b = 0U; b < kBaseCount; ++b) {
    for (size_t perWait : perWaits) {
      fakes::FakeClock clock(kBases[b]);
      FakeResponseStream stream(clock, 1U);
      stream.deliver(kScanOk, perWait);

      char out[gatelogic::kScanResponseCap] = {};
      const gatelogic::BodyResult result =
          gatelogic::readBody(stream, clock, clock.nowMs() + gatelogic::kHttpBodyBudgetMs,
                              gatelogic::knownLength(static_cast<int>(strlen(kScanOk))), out, sizeof(out));

      TEST_ASSERT_TRUE(result == gatelogic::BodyResult::Ok);
      TEST_ASSERT_EQUAL_STRING(kScanOk, out);
    }
  }
}

/// E1. A body with NO declared length and a peer that HANGS UP ends when it
/// does — which is what HTTP/1.0 with `Connection: close` produces, and what
/// the port now asks the server for.
void test_body_an_undeclared_length_ends_when_the_peer_closes() {
  fakes::FakeClock clock(kBaseWrapSoon);
  FakeResponseStream stream(clock, 1U);
  stream.deliver(kScanOk, 4U);

  char out[gatelogic::kScanResponseCap] = {};
  const gatelogic::BodyResult result = gatelogic::readBody(
      stream, clock, clock.nowMs() + gatelogic::kHttpBodyBudgetMs, gatelogic::untilClose(), out, sizeof(out));

  TEST_ASSERT_TRUE(result == gatelogic::BodyResult::Ok);
  TEST_ASSERT_EQUAL_STRING(kScanOk, out);
}

/// E1, THE CRITICAL, AS TWO READS OF ONE CAPTURE.
///
/// The SAME bytes the real server sent, read two ways:
///
///   * as round G2 read them — no declared length, so "until the peer closes" —
///     against a peer that does NOT close, because HTTPClient defaults to
///     keep-alive and Kestrel holds the socket. The read spends its whole
///     budget and reports a transport failure. On a real board that happened on
///     EVERY call: the roster never loaded and the door refused everyone;
///   * as the framing says to read them. The document comes out, the framing
///     does not, and the peer staying connected is irrelevant because the
///     zero-size chunk is what ends the body.
///
/// The fixture field that discriminates is `closesWhenDone(false)`. With it
/// true — which is what every invented fixture had — BOTH readings return Ok
/// and this test proves nothing at all.
void test_body_a_chunked_keep_alive_capture_is_read_by_its_framing_or_not_at_all() {
  for (size_t b = 0U; b < kBaseCount; ++b) {
    // The round-G2 reading: no framing, a peer that never hangs up.
    {
      fakes::FakeClock clock(kBases[b]);
      FakeResponseStream stream(clock, 100U);
      stream.deliver(kCapturedGateChunked, 64U);
      stream.closesWhenDone(false);

      char out[gatelogic::kScanResponseCap] = {};
      const gatelogic::BodyResult result =
          gatelogic::readBody(stream, clock, clock.nowMs() + gatelogic::kHttpBodyBudgetMs,
                              gatelogic::untilClose(), out, sizeof(out));

      TEST_ASSERT_TRUE_MESSAGE(result == gatelogic::BodyResult::Timeout,
                               "a keep-alive peer with no declared length has no end marker at all");
      TEST_ASSERT_EQUAL_STRING("", out);
    }

    // The framed reading, same bytes, same peer.
    {
      fakes::FakeClock clock(kBases[b]);
      FakeResponseStream stream(clock, 100U);
      stream.deliver(kCapturedGateChunked, 64U);
      stream.closesWhenDone(false);

      char out[gatelogic::kScanResponseCap] = {};
      const gatelogic::BodyResult result =
          gatelogic::readBody(stream, clock, clock.nowMs() + gatelogic::kHttpBodyBudgetMs,
                              gatelogic::chunkedBody(), out, sizeof(out));

      TEST_ASSERT_TRUE(result == gatelogic::BodyResult::Ok);
      TEST_ASSERT_EQUAL_STRING_MESSAGE(kCapturedGatePayload, out,
                                       "the parser must never see a chunk-size line");
    }
  }
}

/// E1. The chunk framing survives the stream stopping between ANY two bytes.
///
/// A chunk split across reads, a SIZE LINE split across reads, and the trailing
/// `0\r\n\r\n` arriving long after the data — all three are what a 1489-byte
/// chunk on a 1460-byte MTU does in ordinary service, and all three are the
/// same fixture with a different `perWait`. One byte at a time is the hostile
/// end of it and splits the two-character size line as well as the payload.
void test_body_chunk_framing_survives_every_split() {
  const size_t perWaits[] = {1U, 2U, 3U, 7U, 64U, 4096U};

  for (size_t perWait : perWaits) {
    fakes::FakeClock clock(kBaseMid);
    FakeResponseStream stream(clock, 1U);
    stream.deliver(kCapturedGateChunked, perWait);
    stream.closesWhenDone(false);

    char out[gatelogic::kScanResponseCap] = {};
    const gatelogic::BodyResult result =
        gatelogic::readBody(stream, clock, clock.nowMs() + gatelogic::kHttpBodyBudgetMs,
                            gatelogic::chunkedBody(), out, sizeof(out));

    TEST_ASSERT_TRUE(result == gatelogic::BodyResult::Ok);
    TEST_ASSERT_EQUAL_STRING(kCapturedGatePayload, out);
  }
}

/// E1. The capture that matters most: a FULL 48-entry heartbeat is one chunk of
/// 0x5d1 = 1489 bytes, which is the largest thing this board ever reads and the
/// one whose loss empties the roster.
void test_body_a_full_heartbeat_arrives_as_one_1489_byte_chunk() {
  char payload[2048] = {};
  buildHeartbeatOfSize(payload, sizeof(payload), 1489U);

  char framed[2176] = {};
  static_cast<void>(wrapAsOneChunk(payload, framed, sizeof(framed)));
  TEST_ASSERT_EQUAL_STRING_MESSAGE("5d1", strtok(framed, "\r"), "the captured size line is 5d1");
  // strtok wrote a NUL into the buffer; build it again for the read.
  static_cast<void>(wrapAsOneChunk(payload, framed, sizeof(framed)));

  fakes::FakeClock clock(kBaseMid);
  FakeResponseStream stream(clock, 1U);
  // 1460 at a time: one MTU, so the chunk genuinely spans two reads.
  stream.deliver(framed, 1460U);
  stream.closesWhenDone(false);

  char out[gatelogic::kGateResponseCap] = {};
  const gatelogic::BodyResult result =
      gatelogic::readBody(stream, clock, clock.nowMs() + gatelogic::kHttpBodyBudgetMs,
                          gatelogic::chunkedBody(), out, sizeof(out));

  TEST_ASSERT_TRUE(result == gatelogic::BodyResult::Ok);
  TEST_ASSERT_EQUAL_STRING(payload, out);
}

/// E1. A 204 and an empty body. `Content-Length: 0` is a body that is over
/// before it starts, and a zero-size chunk with no data is the same thing said
/// the other way.
void test_body_an_empty_body_is_a_whole_body() {
  {
    fakes::FakeClock clock(kBaseMid);
    FakeResponseStream stream(clock, 1U);
    stream.deliver("", 1U);
    char out[32] = {'x'};
    const gatelogic::BodyResult result =
        gatelogic::readBody(stream, clock, clock.nowMs() + gatelogic::kHttpBodyBudgetMs,
                            gatelogic::knownLength(0), out, sizeof(out));
    TEST_ASSERT_TRUE(result == gatelogic::BodyResult::Ok);
    TEST_ASSERT_EQUAL_STRING("", out);
  }
  {
    fakes::FakeClock clock(kBaseMid);
    FakeResponseStream stream(clock, 1U);
    stream.deliver("0\r\n\r\n", 1U);
    stream.closesWhenDone(false);
    char out[32] = {'x'};
    const gatelogic::BodyResult result =
        gatelogic::readBody(stream, clock, clock.nowMs() + gatelogic::kHttpBodyBudgetMs,
                            gatelogic::chunkedBody(), out, sizeof(out));
    TEST_ASSERT_TRUE(result == gatelogic::BodyResult::Ok);
    TEST_ASSERT_EQUAL_STRING("", out);
  }
}

/// E1. A SIZE LINE THAT IS NOT A SIZE LINE IS A FAILURE, NOT A GUESS.
///
/// Every one of these is a stream that is not what it claims, and for each of
/// them the only honest answer is "this board learned nothing" — which sends a
/// scan to the roster. Salvaging what parsed would hand the roster parser a
/// document assembled out of somebody else's framing.
void test_body_malformed_chunk_framing_is_a_failure_not_garbage() {
  struct Row {
    const char* label;
    const char* bytes;
  };

  const Row rows[] = {
      {"a size line that is not hexadecimal", "zz\r\nabc\r\n0\r\n\r\n"},
      {"a size line with no digits at all", "\r\nabc\r\n0\r\n\r\n"},
      {"a chunk not followed by its CRLF", "3\r\nabcX0\r\n\r\n"},
      {"a chunk followed by CR and then rubbish", "3\r\nabc\rX0\r\n\r\n"},
      // THE ONE THAT DISCRIMINATES A CHECKED CR FROM A CONSUMED BYTE. A
      // decoder that skips a byte where the CR should be, rather than
      // REQUIRING one, parses this into a perfectly plausible "abc" — and
      // every other row here still fails, so without it the check can be
      // deleted and the suite stays green.
      {"a chunk followed by one wrong byte and a LF", "3\r\nabcX\n0\r\n\r\n"},
      {"a size line longer than a uint32", "123456789\r\nabc\r\n0\r\n\r\n"},
      {"a trailer line that never ends", "0\r\nX-Trailer: 1\r\rrubbish"},
  };

  for (const Row& row : rows) {
    fakes::FakeClock clock(kBaseMid);
    FakeResponseStream stream(clock, 1U);
    stream.deliver(row.bytes, 4U);
    stream.closesWhenDone(false);

    char out[gatelogic::kScanResponseCap] = {};
    const gatelogic::BodyResult result =
        gatelogic::readBody(stream, clock, clock.nowMs() + gatelogic::kHttpBodyBudgetMs,
                            gatelogic::chunkedBody(), out, sizeof(out));

    TEST_ASSERT_TRUE_MESSAGE(result == gatelogic::BodyResult::Malformed, row.label);
    TEST_ASSERT_EQUAL_STRING_MESSAGE("", out, row.label);
    TEST_ASSERT_EQUAL_UINT16(0U, gatelogic::statusForBody(200U, result));
  }
}

/// E1. A chunked peer that HANGS UP before its zero-size line sent a body that
/// was CUT, not one that ended. Reported rather than handed up: that is exactly
/// the truncation this whole file exists to refuse, and the reason `{"opened":
/// true,` cut after the comma is a door that opens.
void test_body_a_chunked_peer_that_hangs_up_early_is_not_a_short_body() {
  fakes::FakeClock clock(kBaseMid);
  FakeResponseStream stream(clock, 1U);
  // The captured framing with everything from the closing brace onwards lost.
  stream.deliver("3d\r\n{\"opened\":true,", 4U);
  stream.closesWhenDone(true);

  char out[gatelogic::kScanResponseCap] = {};
  const gatelogic::BodyResult result =
      gatelogic::readBody(stream, clock, clock.nowMs() + gatelogic::kHttpBodyBudgetMs,
                          gatelogic::chunkedBody(), out, sizeof(out));

  TEST_ASSERT_TRUE(result == gatelogic::BodyResult::Malformed);
  TEST_ASSERT_EQUAL_STRING_MESSAGE("", out, "half a de-chunked document is not a document");
}

/// E1. The framing is DERIVED from the two facts the core will report, in one
/// place, so the driver holds no opinion of its own.
void test_body_the_framing_comes_from_content_length_and_transfer_encoding() {
  static_assert(gatelogic::frameFromHeaders(61, false).framing == gatelogic::BodyFraming::KnownLength, "");
  static_assert(gatelogic::frameFromHeaders(61, false).length == 61, "");
  static_assert(gatelogic::frameFromHeaders(0, false).framing == gatelogic::BodyFraming::KnownLength, "");
  // -1 is BOTH chunked and close-delimited, and telling them apart is the whole
  // of E1: the collected `Transfer-Encoding` is the only thing that can.
  static_assert(gatelogic::frameFromHeaders(-1, true).framing == gatelogic::BodyFraming::Chunked, "");
  static_assert(gatelogic::frameFromHeaders(-1, false).framing == gatelogic::BodyFraming::UntilClose, "");
  // A response claiming both: the declared length wins, because stopping at a
  // stated number of bytes is safer than parsing framing that may not be there.
  static_assert(gatelogic::frameFromHeaders(61, true).framing == gatelogic::BodyFraming::KnownLength, "");
  TEST_PASS();
}

/// E1, AND THE REASON IT IS A SAFETY FIX RATHER THAN A HYGIENE ONE.
///
/// The driver used to `getString()` the whole body onto the heap and then
/// `memcpy` the first `outCap - 1` bytes of it into the caller's buffer. An
/// over-long body therefore arrived TRUNCATED, with a 200 on it — and
/// `{"opened":true,` cut after the comma is a door that opens for a body nobody
/// could have read.
///
/// It is refused now, and the refusal is a TRANSPORT failure rather than a
/// short body, so the scan goes to the roster instead of to a parser holding
/// half an object. All three framings, because a chunked body can outgrow the
/// buffer across several chunks that are each small enough.
void test_body_a_body_over_the_cap_is_refused_rather_than_truncated() {
  // A body that would open the door if its first bytes were believed.
  char over[256] = {};
  strncpy(over, kScanOk, sizeof(over) - 1U);
  for (size_t i = strlen(over); i < sizeof(over) - 1U; ++i) {
    over[i] = 'x';
  }

  // Declared, so it is refused before a byte moves...
  {
    fakes::FakeClock clock(kBaseMid);
    FakeResponseStream stream(clock, 8U);
    stream.deliver(over, 8U);
    char out[32] = {};
    const gatelogic::BodyResult result =
        gatelogic::readBody(stream, clock, clock.nowMs() + gatelogic::kHttpBodyBudgetMs,
                            gatelogic::knownLength(static_cast<int>(strlen(over))), out, sizeof(out));
    TEST_ASSERT_TRUE(result == gatelogic::BodyResult::TooLarge);
    TEST_ASSERT_EQUAL_STRING_MESSAGE("", out, "a refused body must be EMPTY, never a plausible prefix");
    TEST_ASSERT_EQUAL_UINT16(0U, gatelogic::statusForBody(200U, result));
  }

  // ...undeclared, so it is refused at the byte that would not fit...
  {
    fakes::FakeClock clock(kBaseMid);
    FakeResponseStream stream(clock, 8U);
    stream.deliver(over, 8U);
    char out[32] = {};
    const gatelogic::BodyResult result =
        gatelogic::readBody(stream, clock, clock.nowMs() + gatelogic::kHttpBodyBudgetMs,
                            gatelogic::untilClose(), out, sizeof(out));
    TEST_ASSERT_TRUE(result == gatelogic::BodyResult::TooLarge);
    TEST_ASSERT_EQUAL_STRING("", out);
  }

  // ...and chunked, where NO single chunk is over the cap and the total is.
  {
    fakes::FakeClock clock(kBaseMid);
    char framed[512] = {};
    // Ten chunks of sixteen bytes: 160 into a 32-byte buffer.
    size_t at = 0U;
    for (int chunk = 0; chunk < 10; ++chunk) {
      at +=
          static_cast<size_t>(snprintf(framed + at, sizeof(framed) - at, "10\r\n%s\r\n", "0123456789abcdef"));
    }
    static_cast<void>(snprintf(framed + at, sizeof(framed) - at, "0\r\n\r\n"));

    FakeResponseStream stream(clock, 8U);
    stream.deliver(framed, 8U);
    stream.closesWhenDone(false);
    char out[32] = {};
    const gatelogic::BodyResult result =
        gatelogic::readBody(stream, clock, clock.nowMs() + gatelogic::kHttpBodyBudgetMs,
                            gatelogic::chunkedBody(), out, sizeof(out));
    TEST_ASSERT_TRUE_MESSAGE(result == gatelogic::BodyResult::TooLarge,
                             "chunks that each fit can still be a body that does not");
    TEST_ASSERT_EQUAL_STRING("", out);
  }

  // Exactly one byte short of the buffer still fits — the terminator needs the
  // last one.
  {
    fakes::FakeClock clock(kBaseMid);
    char exact[32] = {};
    for (size_t i = 0U; i < sizeof(exact) - 1U; ++i) {
      exact[i] = 'y';
    }
    FakeResponseStream stream(clock, 4U);
    stream.deliver(exact, 4U);
    char out[32] = {};
    const gatelogic::BodyResult result =
        gatelogic::readBody(stream, clock, clock.nowMs() + gatelogic::kHttpBodyBudgetMs,
                            gatelogic::knownLength(static_cast<int>(strlen(exact))), out, sizeof(out));
    TEST_ASSERT_TRUE_MESSAGE(result == gatelogic::BodyResult::Ok, "outCap - 1 bytes must fit");
    TEST_ASSERT_EQUAL_size_t(sizeof(out) - 1U, strlen(out));
  }
}

/// E1. A DRIBBLING PEER IS BOUNDED BY THE BODY PHASE'S OWN DEADLINE.
///
/// `HTTPClient::setTimeout` is an INTER-BYTE timeout: a peer sending one byte
/// every three seconds resets it on every byte and keeps a read alive for ever,
/// so no number of four-second timeouts bounds it. The deadline here is
/// absolute and cannot be reset by the peer's generosity.
///
/// AND IT IS THE BODY'S OWN BUDGET, NOT WHAT IS LEFT OF THE CALL'S. Round G2
/// computed it from the instant the whole call started, so a header phase that
/// spent the connect and response timeouts handed the body a deadline already
/// in the past. `kHttpBodyBudgetMs` is what the port samples after `POST()`
/// returns.
void test_body_a_dribbling_peer_is_bounded_by_the_body_budget() {
  for (size_t b = 0U; b < kBaseCount; ++b) {
    fakes::FakeClock clock(kBases[b]);
    // One byte per three seconds, which is the classic slow-loris rate.
    FakeResponseStream stream(clock, 3000U);
    stream.deliver(kScanOk, 1U);

    const uint32_t started = clock.nowMs();
    const uint32_t deadline = started + gatelogic::kHttpBodyBudgetMs;
    char out[gatelogic::kScanResponseCap] = {};
    const gatelogic::BodyResult result = gatelogic::readBody(
        stream, clock, deadline, gatelogic::knownLength(static_cast<int>(strlen(kScanOk))), out, sizeof(out));

    TEST_ASSERT_TRUE_MESSAGE(result == gatelogic::BodyResult::Timeout, "a dribbling peer must be cut off");
    TEST_ASSERT_EQUAL_STRING_MESSAGE("", out, "and what did arrive is not a body");
    TEST_ASSERT_EQUAL_UINT16_MESSAGE(0U, gatelogic::statusForBody(200U, result),
                                     "a body that did not arrive is a transport failure, not a 200");
    // AND IT STOPPED AT THE DEADLINE, not at some multiple of it.
    const uint32_t spent = tb::since(clock.nowMs(), started);
    TEST_ASSERT_TRUE_MESSAGE(spent <= gatelogic::kHttpBodyBudgetMs + 3000U,
                             "the read outlived its deadline by more than one wait");
  }
}

/// E1. THE WORST CALL IS THREE PHASES, AND THE WATCHDOG IS ASSERTED AGAINST IT.
///
/// The arithmetic the release-overrun sentence and the watchdog both rest on,
/// written out here so a change to any one of the three budgets shows up as a
/// failing test with the numbers in it rather than as a comment nobody re-read.
void test_config_the_worst_call_is_connect_plus_headers_plus_body() {
  TEST_ASSERT_EQUAL_UINT32(4000UL, gatelogic::kHttpConnectTimeoutMs);
  TEST_ASSERT_EQUAL_UINT32(4000UL, gatelogic::kHttpResponseTimeoutMs);
  TEST_ASSERT_EQUAL_UINT32(4000UL, gatelogic::kHttpBodyBudgetMs);
  TEST_ASSERT_EQUAL_UINT32_MESSAGE(12000UL, gatelogic::kWorstBlockingCallMs,
                                   "connect + headers + body, and README says 12 010 ms of overrun");
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(15U, gatelogic::kGateConfig.watchdogSeconds,
                                  "a 12 s watchdog against a 12 s worst call is a reset loop");
  // The overrun sentence in GateApp.h and README.md, as a number.
  TEST_ASSERT_EQUAL_UINT32(12010UL, gatelogic::kWorstBlockingCallMs + gatelogic::kIdleDelayMs);
  TEST_ASSERT_EQUAL_UINT32(42010UL, gatelogic::kGateConfig.unlockHardCapMs + gatelogic::kWorstBlockingCallMs +
                                        gatelogic::kIdleDelayMs);
}

/// E1. A call that has already spent its whole budget before the body starts
/// has none left for it, and says so rather than borrowing more.
void test_body_a_deadline_already_passed_is_a_transport_failure() {
  fakes::FakeClock clock(kBaseMid);
  FakeResponseStream stream(clock, 0U);
  stream.deliver(kScanOk, 1U);

  char out[gatelogic::kScanResponseCap] = {};
  // One byte at a time, so the first wait meets the deadline.
  const gatelogic::BodyResult result =
      gatelogic::readBody(stream, clock, clock.nowMs() - 1U,
                          gatelogic::knownLength(static_cast<int>(strlen(kScanOk))), out, sizeof(out));
  TEST_ASSERT_TRUE(result == gatelogic::BodyResult::Timeout);
  TEST_ASSERT_EQUAL_STRING("", out);
}

/// E1, AMENDED BY G4 / C1. Where a status's MEANING lives decides whether a
/// body that did not arrive can take it away.
///
/// A 2xx carries its decision in the body, so a 200 nobody could read is
/// status 0 — "this board learned nothing" — which sends a scan to the roster.
/// A 4xx and a 5xx carry theirs in the STATUS LINE, which is in the first bytes
/// of the response and is known before any body byte is read, so they survive a
/// body that did not.
void test_body_a_failure_status_survives_a_body_that_did_not() {
  static_assert(gatelogic::statusForBody(200U, gatelogic::BodyResult::Ok) == 200U, "");
  static_assert(gatelogic::statusForBody(403U, gatelogic::BodyResult::Ok) == 403U, "");
  static_assert(gatelogic::statusForBody(200U, gatelogic::BodyResult::TooLarge) == 0U, "");
  static_assert(gatelogic::statusForBody(200U, gatelogic::BodyResult::Timeout) == 0U, "");
  static_assert(gatelogic::statusForBody(200U, gatelogic::BodyResult::Malformed) == 0U, "");
  static_assert(gatelogic::statusForBody(204U, gatelogic::BodyResult::TooLarge) == 0U, "");
  static_assert(gatelogic::statusForBody(302U, gatelogic::BodyResult::TooLarge) == 0U, "");

  // THE TWO THIS ROUND CHANGED, AND WHAT EACH ONE COST.
  //
  // A 403 is the club having taken this board out of service. Read as 0 it was
  // an OUTAGE, so the board fell back to its roster and kept admitting every
  // rostered member through the door the admin had just shut — for the whole
  // six-hour staleness window, which is the exact thing the 403 rule exists to
  // stop.
  static_assert(gatelogic::statusForBody(403U, gatelogic::BodyResult::Timeout) == 403U, "");
  static_assert(gatelogic::statusForBody(403U, gatelogic::BodyResult::TooLarge) == 403U, "");
  static_assert(gatelogic::statusForBody(403U, gatelogic::BodyResult::Malformed) == 403U, "");

  // A 400 on `/events` from a server in Development answers a binder refusal
  // with a developer HTML page thousands of bytes long, against a 192-byte
  // response buffer. Read as 0 that was Retry = keep, so the head of the ring
  // was re-posted for ever and every door entry behind it never arrived.
  static_assert(gatelogic::statusForBody(400U, gatelogic::BodyResult::TooLarge) == 400U, "");
  static_assert(gatelogic::statusForBody(404U, gatelogic::BodyResult::TooLarge) == 404U, "");
  static_assert(gatelogic::statusForBody(429U, gatelogic::BodyResult::Timeout) == 429U, "");
  static_assert(gatelogic::statusForBody(503U, gatelogic::BodyResult::Malformed) == 503U, "");

  // AND THE PEER'S STATUS SURVIVES ANYWAY, for the one reader that needs it.
  // `bodyFailed` is about a 2xx now as it always was: on a failure status the
  // two agree, so a 403 whose body was lost is not counted as a no-push.
  static_assert(gatelogic::bodyFailed(gatelogic::HttpOutcome{0U, 200U}), "");
  static_assert(!gatelogic::bodyFailed(gatelogic::HttpOutcome{200U, 200U}), "");
  static_assert(!gatelogic::bodyFailed(gatelogic::noCall()), "");
  TEST_PASS();
}

/// G4 / C1. The same rule where it actually bites: a board taken out of service
/// by an admin, answering a 403 whose body is larger than the buffer.
void test_app_a_403_whose_body_did_not_fit_still_takes_the_board_out_of_service() {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    Rig rig(kBases[i]);
    rig.boot(true);

    // A roster first, so there is something an out-of-service board could
    // wrongly keep admitting from.
    rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, 0U);
    rig.forceHeartbeat();
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(1U, rig.roster.size(), "the scenario needs a live roster to lose");

    // The admin presses the button. The body did not fit, so the READ failed —
    // but the status line arrived, and the status line is the verdict.
    rig.http.onPathBodyFailure(gatelogic::kPathGate, 403U, 0U);
    rig.link.set(false);
    rig.tick();
    rig.link.set(true);
    rig.scanner.feed("MEMBERTOKEN1\n");
    rig.tick();
    rig.tick();

    TEST_ASSERT_FALSE_MESSAGE(rig.lock.released(),
                              "a 403 is a refusal whatever became of the body behind it");
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(0U, rig.roster.size(),
                                    "and the roster goes with it, or the next link drop re-admits "
                                    "every rostered member through a door an admin has shut");

    // The mutant this kills: reading the 403 as status 0 sends the scan to the
    // roster, which still holds the booking, and the door opens.
    rig.link.set(false);
    rig.tick();
    rig.scanner.feed("MEMBERTOKEN1\n");
    rig.tick();
    rig.tick();
    TEST_ASSERT_FALSE_MESSAGE(rig.lock.released(),
                              "an out-of-service board must admit nobody offline either");
  }
}

// ---------------------------------------------------------------------------
// E4 — the two things a board could not say
// ---------------------------------------------------------------------------

/// E3/E4. THE TWO DIAGNOSTIC COUNTERS ARE OMITTED AT ZERO AND SATURATE.
///
/// Omitted because a healthy board is the overwhelming case and the contract
/// corpus's request vector has neither field: a board that sent `"no_push":0`
/// for ever would put a key in every request nothing on the wire has agreed to.
/// `test_every_request_vector_is_rendered_byte_for_byte` is what would notice,
/// and it is asserted here too so the reason is written down beside the rule.
///
/// Saturating because the API binds both as a signed 64-bit value and IGNORES a
/// negative or oversized one rather than answering 400 — so a counter that
/// wrapped past INT32_MAX would report a board that has lost four billion
/// events as a healthy one, silently.
void test_heartbeat_body_carries_its_counters_only_when_there_are_some() {
  char body[gatelogic::kGateHeartbeatBodyCap] = {};

  TEST_ASSERT_TRUE(gatelogic::renderGateHeartbeatBody(body, sizeof(body), "5ccf7f0a1b2c", "1.0.0",
                                                      86400000ULL, gatelogic::quietDiagnostics()) > 0U);
  TEST_ASSERT_EQUAL_STRING_MESSAGE(
      "{\"mac\":\"5ccf7f0a1b2c\",\"firmware_version\":\"1.0.0\",\"uptime_ms\":86400000,\"kind\":\"gate\"}",
      body, "a healthy board's body is the corpus vector, byte for byte");

  TEST_ASSERT_TRUE(gatelogic::renderGateHeartbeatBody(body, sizeof(body), "5ccf7f0a1b2c", "1.0.0",
                                                      86400000ULL, gatelogic::GateDiagnostics{4U, 0U}) > 0U);
  TEST_ASSERT_EQUAL_STRING("{\"mac\":\"5ccf7f0a1b2c\",\"firmware_version\":\"1.0.0\",\"uptime_ms\":86400000,"
                           "\"kind\":\"gate\",\"no_push\":4}",
                           body);

  // `events_lost` alone, and then both, in that order — the order is part of
  // the shape, not an accident of the renderer.
  TEST_ASSERT_TRUE(gatelogic::renderGateHeartbeatBody(body, sizeof(body), "5ccf7f0a1b2c", "1.0.0",
                                                      86400000ULL,
                                                      gatelogic::GateDiagnostics{0U, 720U}) > 0U);
  TEST_ASSERT_EQUAL_STRING("{\"mac\":\"5ccf7f0a1b2c\",\"firmware_version\":\"1.0.0\",\"uptime_ms\":86400000,"
                           "\"kind\":\"gate\",\"events_lost\":720}",
                           body);
  TEST_ASSERT_TRUE(gatelogic::renderGateHeartbeatBody(body, sizeof(body), "5ccf7f0a1b2c", "1.0.0",
                                                      86400000ULL,
                                                      gatelogic::GateDiagnostics{4U, 720U}) > 0U);
  TEST_ASSERT_EQUAL_STRING("{\"mac\":\"5ccf7f0a1b2c\",\"firmware_version\":\"1.0.0\",\"uptime_ms\":86400000,"
                           "\"kind\":\"gate\",\"no_push\":4,\"events_lost\":720}",
                           body);

  // SATURATED, not wrapped: a counter already at the ceiling stays there, and
  // one handed a value past it is rendered at the ceiling.
  TEST_ASSERT_EQUAL_UINT32(gatelogic::kMaxDiagnosticCount,
                           gatelogic::saturatingIncrement(gatelogic::kMaxDiagnosticCount));
  TEST_ASSERT_EQUAL_UINT32(gatelogic::kMaxDiagnosticCount,
                           gatelogic::saturatingIncrement(gatelogic::kMaxDiagnosticCount - 1U));
  TEST_ASSERT_TRUE(
      gatelogic::renderGateHeartbeatBody(body, sizeof(body), "5ccf7f0a1b2c", "1.0.0", 4295187295ULL,
                                         gatelogic::GateDiagnostics{4294967295UL, 4294967295UL}) > 0U);
  TEST_ASSERT_NOT_NULL_MESSAGE(strstr(body, "\"no_push\":2147483647,\"events_lost\":2147483647}"),
                               "a counter over INT32_MAX is what the API silently ignores");

  char tiny[96] = {};
  TEST_ASSERT_EQUAL_size_t(
      0U, gatelogic::renderGateHeartbeatBody(tiny, sizeof(tiny), "5ccf7f0a1b2c", "1.0.0", 4295187295ULL,
                                             gatelogic::GateDiagnostics{4294967295UL, 4294967295UL}));
  TEST_ASSERT_EQUAL_STRING("", tiny);
}

/// E4. A heartbeat the board ACCEPTED that pushed no roster is counted, and the
/// NEXT request says so.
///
/// It is otherwise completely unobservable: the roster silently does not
/// change, its age silently keeps running, and the one feedback surface on this
/// board is a lamp with nothing to say about it. Neither a technician at the
/// door nor anybody reading the admin console can tell that case from a healthy
/// one.
void test_app_a_heartbeat_that_pushed_no_roster_is_counted_and_reported() {
  Rig rig(kBaseMid);
  rig.boot(true);
  TEST_ASSERT_EQUAL_UINT32(0U, rig.app.noPushHeartbeats());

  // A 200 the board accepts whose roster key never arrived — a peer that hung
  // up mid-body, which `isCompleteObject` refuses and `applyRoster` therefore
  // treats exactly like an absent key.
  rig.http.onPath(gatelogic::kPathHeartbeat, 200U, "{\"kind\":\"gate\",\"roster\":[\"TOKBOB|0|0|3600\",\"TOK",
                  0U);
  rig.forceHeartbeat();
  TEST_ASSERT_FALSE_MESSAGE(rig.app.lastSync().replaced,
                            "the scenario needs a heartbeat that pushed nothing");
  TEST_ASSERT_EQUAL_UINT32_MESSAGE(1U, rig.app.noPushHeartbeats(), "a no-push heartbeat must be counted");

  // And the NEXT request carries it, which is the whole point: there is
  // nowhere else on this board it could be read.
  rig.forceHeartbeat();
  TEST_ASSERT_NOT_NULL_MESSAGE(strstr(rig.http.lastBody(), "\"no_push\":1"),
                               "the count has to reach somewhere a person can see it");

  // A healthy push does not count, and does not clear the total either: it is a
  // count since boot, so a rising one is the signal.
  rig.http.onPath(gatelogic::kPathHeartbeat, 200U, kHealthyHeartbeat, 0U);
  rig.forceHeartbeat();
  TEST_ASSERT_TRUE(rig.app.lastSync().replaced);
  TEST_ASSERT_EQUAL_UINT32(2U, rig.app.noPushHeartbeats());
}

/// E4. A watchdog that refused to arm shows on the lamp, at four times the link
/// blink's rate, and outranks it — a board with no watchdog AND no radio is a
/// board to look at for the first reason.
void test_led_a_watchdog_that_would_not_arm_blinks_four_times_as_fast() {
  gatelogic::LedPattern led;
  led.setLinkUp(true);
  led.setFault(true);

  // 4 Hz: an eighth of a second lit, an eighth dark.
  TEST_ASSERT_TRUE(led.on(2000U));
  TEST_ASSERT_TRUE(led.on(2124U));
  TEST_ASSERT_FALSE(led.on(2125U));
  TEST_ASSERT_TRUE(led.on(2250U));

  // It beats the link blink rather than hiding behind it. 2500 is a DARK half
  // of the 1 Hz pattern and a LIT half of the 4 Hz one.
  led.setLinkUp(false);
  TEST_ASSERT_TRUE_MESSAGE(led.on(2500U), "the fault blink must outrank the link blink");

  // But never a member-facing cue. A released door is solid whatever is wrong
  // with the board, and a refusal still blinks three times.
  led.setReleased(true);
  TEST_ASSERT_TRUE(led.on(2125U));
  led.setReleased(false);
  led.cue(gatelogic::LedCue::Denied, 2125U);
  TEST_ASSERT_TRUE(led.on(2125U));
  TEST_ASSERT_FALSE_MESSAGE(led.on(2125U + gatelogic::kDeniedHalfMs), "the refusal pattern, not the fault");

  // And it goes away when the watchdog finally takes.
  gatelogic::LedPattern healthy;
  healthy.setLinkUp(true);
  healthy.setFault(false);
  TEST_ASSERT_FALSE(healthy.on(2000U));
  TEST_ASSERT_FALSE(healthy.on(2125U));
}

/// E4. THE DOOR IS UNAFFECTED BY THE FAULT, in either direction.
///
/// A board that refused to open because its watchdog would not arm would be a
/// door that admits nobody, which is far worse than one running on the core's
/// five seconds instead of fifteen. And the fault must not open one either.
void test_app_a_refused_watchdog_changes_nothing_about_the_door() {
  Rig rig(kBaseMid);
  rig.app.setWatchdogArmed(false);
  rig.boot(true);
  rig.http.answer(200U, kOpenThreeSeconds);
  rig.http.forget();

  // Nothing opened by declaring the fault.
  TEST_ASSERT_FALSE(rig.lock.released());

  // And a member still gets in.
  rig.scanner.feed("7Q3F9KM2XZ8B\n");
  rig.tick();
  TEST_ASSERT_TRUE_MESSAGE(rig.lock.released(), "a board with no watchdog must still open for a member");
  TEST_ASSERT_EQUAL_UINT32(1U, rig.http.callsTo(gatelogic::kPathGate));
}

/// E5. The link is read BEFORE the scanner decides, not after it.
///
/// `linkUp_` was a pass stale: `pumpLink()` ran after `pumpScanner()`, so the
/// first scan after the radio re-associated was decided from the roster — and
/// on a board whose roster is empty or stale, that is a member refused at a
/// door whose network is working.
void test_app_the_link_is_read_before_the_scanner_decides() {
  Rig rig(kBaseMid);
  rig.boot(false); // associated, then dropped
  rig.http.answer(200U, kOpenThreeSeconds);
  rig.http.forget();

  // The radio comes back and a member scans in the SAME pass.
  rig.link.set(true);
  rig.scanner.feed("7Q3F9KM2XZ8B\n");
  rig.tick();

  TEST_ASSERT_EQUAL_UINT32_MESSAGE(1U, rig.http.callsTo(gatelogic::kPathGate),
                                   "the scan was decided against a link state one pass out of date");
  TEST_ASSERT_TRUE(rig.lock.released());
}

/// E6. EVERY decision reaches the log, with the reason the board acted on.
///
/// A refusal reason is computed here and observed nowhere: an open the API
/// granted is in the API's audit trail and is deliberately not queued, and the
/// only two surfaces on the hardware are a relay that moves or does not and a
/// lamp that blinks three times for every refusal there is. So the native
/// simulator — and through it the end-to-end harness — can prove what the LOCK
/// did and nothing about the DECISION behind it, unless the decision is
/// offered somewhere.
///
/// All four shapes, because they are computed on four different paths: a 200
/// that opens, a 200 that refuses with the server's own word, a 403 (the club
/// took this board out of service, decided from a status with no body), and a
/// roster decision taken while the API cannot be reached.
void test_app_every_decision_reaches_the_log_with_the_reason_it_acted_on() {
  Rig rig(kBaseWrapSoon);
  rig.boot(true);
  rig.log.forget();

  // (1) A 200 that opens. The log carries what the LOCK was given, not what the
  // body asked for.
  rig.http.answer(200U, kOpenThreeSeconds);
  rig.scanner.feed("7Q3F9KM2XZ8B\n");
  rig.tick();
  TEST_ASSERT_EQUAL_size_t_MESSAGE(1U, rig.log.count(), "an open is a decision");
  TEST_ASSERT_EQUAL_STRING("ok", rig.log.at(0).reason);
  TEST_ASSERT_EQUAL_STRING("7Q3F9KM2XZ8B", rig.log.at(0).token);
  TEST_ASSERT_TRUE(rig.log.at(0).released);
  TEST_ASSERT_EQUAL_UINT32(kOpenGrantMs, rig.log.at(0).grantedMs);
  TEST_ASSERT_FALSE_MESSAGE(rig.log.at(0).queued,
                            "a decision the API made is already in the API's own trail");

  // (2) A 200 that refuses, carrying a reason NO OTHER SURFACE CAN SHOW. The
  // lamp blinks three times for this and for every other refusal alike.
  rig.clock.advance(gatelogic::kScanDebounceMs + 1U);
  rig.http.answer(200U, "{\"opened\":false,\"reason\":\"member_not_active\",\"unlock_seconds\":0}");
  rig.scanner.feed("MEMBERBARRED\n");
  rig.tick();
  TEST_ASSERT_EQUAL_size_t(2U, rig.log.count());
  TEST_ASSERT_EQUAL_STRING_MESSAGE("member_not_active", rig.log.at(1).reason,
                                   "the server's own word, as the board acted on it");
  TEST_ASSERT_FALSE(rig.log.at(1).released);
  TEST_ASSERT_EQUAL_UINT32_MESSAGE(0U, rig.log.at(1).grantedMs, "a refusal grants nothing");

  // (3) A 403. Decided by the board from a status with no body at all, and the
  // one refusal that also empties the roster.
  rig.clock.advance(gatelogic::kScanDebounceMs + 1U);
  rig.http.answer(403U, "");
  rig.scanner.feed("SHUTD00RC0DE\n");
  rig.tick();
  TEST_ASSERT_EQUAL_size_t(3U, rig.log.count());
  TEST_ASSERT_EQUAL_STRING(gatelogic::kReasonOutOfService, rig.log.at(2).reason);
  TEST_ASSERT_TRUE_MESSAGE(rig.log.at(2).outOfService,
                           "the caller has to act on this, so the log has to carry it");

  // (4) The roster, with the radio gone. The reasons here are the BOARD's
  // vocabulary and exist for nothing but the lamp, the logs and the tests —
  // which is precisely why they need a log to reach.
  rig.link.set(false);
  rig.clock.advance(gatelogic::kScanDebounceMs + 1U);
  rig.scanner.feed("N0TINR0STER1\n");
  rig.tick();
  TEST_ASSERT_EQUAL_size_t(4U, rig.log.count());
  TEST_ASSERT_FALSE(rig.log.at(3).released);
  TEST_ASSERT_TRUE_MESSAGE(rig.log.at(3).queued,
                           "a decision this board took for itself is one the API has to be told about");

  // (5) A line this board refuses without looking at it. It names no token,
  // because the bytes were discarded rather than truncated.
  rig.clock.advance(gatelogic::kScanDebounceMs + 1U);
  rig.scanner.feed("THISLINEISFARTOOLONGFORTHETOKENCAP\n");
  rig.tick();
  TEST_ASSERT_EQUAL_size_t(5U, rig.log.count());
  TEST_ASSERT_EQUAL_STRING_MESSAGE("", rig.log.at(4).token,
                                   "a token cut short is a different member's token");
  TEST_ASSERT_FALSE(rig.log.at(4).released);
}

/// E6b. A DEBOUNCED repeat is not a decision, and must not look like one.
///
/// The same phone still held at the window is the normal case, and a log line
/// per repeat would show a member entering eleven times — which is the audit
/// artefact `ScanDebounce` exists to prevent, reproduced on the one surface
/// built to read it back.
void test_app_a_debounced_repeat_is_not_logged_as_a_decision() {
  Rig rig(kBaseMid);
  rig.boot(true);
  rig.log.forget();
  rig.http.answer(200U, kOpenThreeSeconds);

  rig.scanner.feed("7Q3F9KM2XZ8B\n");
  rig.tick();
  TEST_ASSERT_EQUAL_size_t(1U, rig.log.count());

  rig.clock.advance(gatelogic::kScanDebounceMs / 2U);
  rig.scanner.feed("7Q3F9KM2XZ8B\n");
  rig.tick();
  TEST_ASSERT_EQUAL_size_t_MESSAGE(1U, rig.log.count(),
                                   "a suppressed repeat is not a decision, not a call and not a row");
}

/// E6c. A BOARD HAS NO LOG, AND DECIDES EXACTLY THE SAME.
///
/// `ports.log` is nullptr in `src/gate/main.cpp` — there is no console on an
/// ESP32 door gate — so the null path is the SHIPPED one and is the one that
/// has to be proven. A port that could change a decision would be a door whose
/// behaviour depends on whether a cable is plugged into it.
void test_app_a_board_with_no_decision_log_decides_exactly_the_same() {
  Rig rig(kBaseWrapSoon);
  gatelogic::GateApp::Ports ports = rig.wire();
  ports.log = nullptr;
  gatelogic::GateApp app(ports);

  app.beginOutputs();
  app.begin();
  rig.link.set(true);
  rig.http.answer(200U, kOpenThreeSeconds);

  rig.scanner.feed("7Q3F9KM2XZ8B\n");
  for (int i = 0; i < 4; ++i) {
    app.pass();
    rig.clock.advance(gatelogic::kIdleDelayMs);
  }

  TEST_ASSERT_TRUE_MESSAGE(rig.lock.released(), "the door opens with no console attached");
  TEST_ASSERT_EQUAL_size_t_MESSAGE(0U, rig.log.count(), "nothing may reach a log this board has not got");
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
  RUN_TEST(test_unlock_a_capped_window_is_followed_by_real_dark_time);
  RUN_TEST(test_unlock_any_close_guarantees_the_lock_actually_relatches);
  RUN_TEST(test_unlock_reports_how_long_it_has_been_released);

  RUN_TEST(test_scan_assembles_a_line_and_treats_crlf_as_one_terminator);
  RUN_TEST(test_scan_trims_and_ignores_an_empty_line);
  RUN_TEST(test_scan_refuses_a_token_one_character_over_the_cap_without_truncating);
  RUN_TEST(test_scan_a_non_printable_byte_discards_the_whole_line);
  RUN_TEST(test_scan_refuses_every_byte_outside_the_rosters_token_alphabet);
  RUN_TEST(test_render_no_scanned_line_can_forge_a_field_in_the_scan_body);
  RUN_TEST(test_render_no_scanned_subject_can_forge_a_field_in_the_event_body);
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
  RUN_TEST(test_app_an_rx_error_discards_everything_that_was_buffered_when_it_happened);
  RUN_TEST(test_app_boot_and_a_link_event_throw_away_a_partial_line);
  RUN_TEST(test_app_the_heartbeat_interval_is_armed_after_the_call);
  RUN_TEST(test_app_a_403_on_the_heartbeat_commits_an_empty_roster);
  RUN_TEST(test_app_every_status_but_200_and_403_leaves_the_roster_alone);
  RUN_TEST(test_app_a_truncated_heartbeat_body_never_replaces_the_roster);
  RUN_TEST(test_app_a_queued_open_carries_what_the_lock_was_given);
  RUN_TEST(test_app_an_unreadable_line_queues_on_the_same_judgement_a_scan_makes);

  RUN_TEST(test_app_a_refusing_events_endpoint_never_starves_the_heartbeat);
  RUN_TEST(test_app_the_event_backoff_resets_once_the_drain_moves_again);
  RUN_TEST(test_app_a_full_ring_draining_slowly_still_lets_the_heartbeat_through);
  RUN_TEST(test_app_a_403_on_events_takes_the_board_out_of_service_too);
  RUN_TEST(test_app_a_boot_event_the_server_never_acknowledges_is_not_a_hot_loop);
  RUN_TEST(test_app_a_permanently_busy_scanner_cannot_starve_the_heartbeat);
  RUN_TEST(test_app_a_permanently_busy_scanner_cannot_starve_the_event_drain);
  RUN_TEST(test_app_a_link_drop_clears_the_scan_deferral_debt);
  RUN_TEST(test_app_a_flapping_link_cannot_hammer_the_heartbeat);
  RUN_TEST(test_app_the_heartbeat_floor_bounds_failing_calls_too);
  RUN_TEST(test_app_events_the_ring_discarded_are_reported_in_the_next_heartbeat);
  RUN_TEST(test_app_a_heartbeat_whose_body_never_arrived_counts_as_a_no_push);
  RUN_TEST(test_app_a_draining_backlog_still_lets_the_member_at_the_door_through);
  RUN_TEST(test_app_a_404_on_events_keeps_the_backlog_and_retries_it);
  RUN_TEST(test_gate_response_reads_only_the_top_level_object);
  RUN_TEST(test_gate_response_takes_its_duration_and_reason_from_the_top_level_too);
  RUN_TEST(test_boot_recovery_backs_off_only_after_a_watchdog_reset);
  RUN_TEST(test_app_a_board_the_watchdog_reset_holds_its_first_call_back);
  RUN_TEST(test_app_alternating_tokens_cannot_hammer_the_gate_endpoint);
  RUN_TEST(test_debounce_remembers_several_tokens_and_still_never_delays_a_new_one);
  RUN_TEST(test_app_a_rate_limited_scan_is_refused_rather_than_decided_from_the_roster);
  RUN_TEST(test_app_every_uploaded_batch_carries_this_boots_identity);
  RUN_TEST(test_app_two_boots_that_both_start_at_seq_one_are_told_apart);
  RUN_TEST(test_app_a_corrupt_line_gives_the_member_an_answer);
  RUN_TEST(test_app_line_noise_cannot_strobe_the_lamp_or_fill_the_ring);
  RUN_TEST(test_app_two_alternating_tokens_cannot_hold_the_door_open_for_ever);
  RUN_TEST(test_app_a_scan_inside_the_relock_dwell_costs_no_call_and_records_no_opening);
  RUN_TEST(test_app_a_scan_inside_the_relock_dwell_never_reaches_the_api);
  RUN_TEST(test_app_a_window_that_closes_inside_the_call_that_granted_the_next_one);
  RUN_TEST(test_app_an_offline_record_is_stamped_with_an_uptime_the_server_can_read);
  RUN_TEST(test_body_a_body_that_fits_arrives_whole_however_the_segments_fall);
  RUN_TEST(test_body_an_undeclared_length_ends_when_the_peer_closes);
  RUN_TEST(test_body_a_chunked_keep_alive_capture_is_read_by_its_framing_or_not_at_all);
  RUN_TEST(test_body_chunk_framing_survives_every_split);
  RUN_TEST(test_body_a_full_heartbeat_arrives_as_one_1489_byte_chunk);
  RUN_TEST(test_body_an_empty_body_is_a_whole_body);
  RUN_TEST(test_body_malformed_chunk_framing_is_a_failure_not_garbage);
  RUN_TEST(test_body_a_chunked_peer_that_hangs_up_early_is_not_a_short_body);
  RUN_TEST(test_body_the_framing_comes_from_content_length_and_transfer_encoding);
  RUN_TEST(test_body_a_body_over_the_cap_is_refused_rather_than_truncated);
  RUN_TEST(test_body_a_dribbling_peer_is_bounded_by_the_body_budget);
  RUN_TEST(test_config_the_worst_call_is_connect_plus_headers_plus_body);
  RUN_TEST(test_body_a_deadline_already_passed_is_a_transport_failure);
  RUN_TEST(test_body_a_failure_status_survives_a_body_that_did_not);
  RUN_TEST(test_app_a_403_whose_body_did_not_fit_still_takes_the_board_out_of_service);
  RUN_TEST(test_heartbeat_body_carries_its_counters_only_when_there_are_some);
  RUN_TEST(test_app_a_heartbeat_that_pushed_no_roster_is_counted_and_reported);
  RUN_TEST(test_led_a_watchdog_that_would_not_arm_blinks_four_times_as_fast);
  RUN_TEST(test_app_a_refused_watchdog_changes_nothing_about_the_door);
  RUN_TEST(test_app_the_link_is_read_before_the_scanner_decides);
  RUN_TEST(test_app_every_decision_reaches_the_log_with_the_reason_it_acted_on);
  RUN_TEST(test_app_a_debounced_repeat_is_not_logged_as_a_decision);
  RUN_TEST(test_app_a_board_with_no_decision_log_decides_exactly_the_same);

  return UNITY_END();
}

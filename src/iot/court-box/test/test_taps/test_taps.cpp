// Unity tests for DL-15 / FSF-11: short button taps against a Mega loop that
// spends real time on the I2C glass.
//
// THE MODEL
// ---------
// Every other suite runs the box on a clock that only moves between passes, so
// a pass costs nothing and every tap longer than the 80 ms window is seen. On
// the box a pass costs what its bus traffic costs: a character is two PCF8574
// transactions (~0.25 ms at 400 kHz, ~1 ms at 100 kHz), a cursor move one
// more, the controller re-init ~10 ms (two 4.5 ms waits), a clear 2 ms. The
// TimedDisplay below charges exactly that to a microsecond clock, and derives
// cellsPerPass() from it the way arduino_hal::LcdDisplay does, so the paint
// budget behaves as on the glass. The buttons are a level that is a function
// of that clock: a tap is pressed from t0 to t0 + D, whatever the loop is doing.
//
// The driver's idle hook is modelled too (at most once per 500 us of bus time
// and inside every wait), and is the switch between the two measurements:
// without it this is Mega 3.0.0 as it was (DL-15's "before"); with it, the
// shipped wiring, main.cpp's sampleButtonsWhilePainting.
//
// The load is a busy landing: four mapped courts, two lit and counting down,
// the compact marquee scrolling, a clock, a re-init every 30 s, and the hint
// each unanswered press paints — the screen that missed taps on the wall.

#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unity.h>

#include "courtlogic/ButtonPanel.h"
#include "courtlogic/CourtBox.h"
#include "fakes/FakeClock.h"
#include "fakes/FakeRelay.h"
#include "fakes/FakeScanner.h"
#include "fakes/FakeTransport.h"
#include "protocol/Codec.h"

namespace {

/// Bus time, microseconds per character, at the two clocks the driver runs.
constexpr uint32_t kCharMicros400k = 250U;
constexpr uint32_t kCharMicros100k = 1000U;
/// Everything a pass does that is not the glass: drains, deadlines, the queue.
constexpr uint32_t kPassMicros = 400U;
/// The driver's re-init (initController) and clear, in bus time.
constexpr uint32_t kReinitMicros = 10500U;
constexpr uint32_t kClearMicros = 2100U;
/// The real driver's budget and idle-hook pace (arduino_hal/LcdDisplay.h).
constexpr uint32_t kPaintBudgetMicros = 8000U;
constexpr uint32_t kIdleEveryMicros = 500U;

struct Bench;

/// A level that is a function of the bench's microsecond clock.
class TimedButtons final : public hal::IButtonPort {
public:
  explicit TimedButtons(const uint64_t& us) : us_(us) {}

  hal::PinLevel read(uint8_t channel) override {
    const bool down = channel == channel_ && us_ >= from_ && us_ < to_;
    return down ? hal::kButtonPressedLevel : hal::kButtonReleasedLevel;
  }

  void tap(uint8_t channel, uint64_t from, uint64_t to) {
    channel_ = channel;
    from_ = from;
    to_ = to;
  }

private:
  const uint64_t& us_;
  uint8_t channel_ = 0U;
  uint64_t from_ = 0U;
  uint64_t to_ = 0U;
};

/// hal::IDisplayPort that charges bus time to the bench clock.
class TimedDisplay final : public hal::IDisplayPort {
public:
  explicit TimedDisplay(Bench& bench) : bench_(bench) {}

  void clear() override;
  void print(uint8_t row, uint8_t col, const char* text) override;
  void reinit() override;

  uint8_t cellsPerPass() const override { return cells_; }

  void setCharMicros(uint32_t us) {
    charMicros_ = us;
    const uint32_t cells = kPaintBudgetMicros / us;
    cells_ = static_cast<uint8_t>(cells < 2U ? 2U : (cells > 80U ? 80U : cells));
  }

  uint32_t charMicros_ = kCharMicros400k;

private:
  Bench& bench_;
  uint8_t cells_ = 32U;
};

struct Bench {
  uint64_t us;
  fakes::FakeClock clock;
  TimedButtons buttons;
  TimedDisplay display;
  fakes::FakeRelay relay;
  fakes::FakeScanner scanner;
  fakes::FakeTransport bridge;
  courtlogic::CourtBox box;
  bool hook;
  uint64_t hookAtUs;
  uint32_t longestGapUs;
  uint64_t lastSampleUs;

  Bench(uint32_t charMicros, bool idleHook)
      : us(1000000ULL), clock(1000U), buttons(us), display(*this), relay(hal::RelayPolarity::kActiveHigh),
        scanner(), bridge(), box(courtlogic::CourtPorts{relay, display, scanner, buttons, bridge, clock}),
        hook(idleHook), hookAtUs(0U), longestGapUs(0U), lastSampleUs(us) {
    display.setCharMicros(charMicros);
    box.boot(0x01U);
    bridge.drainTx();
  }

  void sync() { clock.setNow(static_cast<uint32_t>(us / 1000ULL)); }

  void noteSample() {
    const uint64_t gap = us - lastSampleUs;
    if (gap > longestGapUs) {
      longestGapUs = static_cast<uint32_t>(gap);
    }
    lastSampleUs = us;
  }

  /// The driver's idle() at this instant: the hook, if wired and due.
  void idle() {
    if (!hook || us - hookAtUs < kIdleEveryMicros) {
      return;
    }
    hookAtUs = us;
    sync();
    box.sampleButtons();
    noteSample();
  }

  /// Bus time passing inside a driver call, the hook offered as it would be.
  void spend(uint32_t micros) {
    for (uint32_t left = micros; left > 0U;) {
      const uint32_t step = left < 100U ? left : 100U;
      us += step;
      left -= step;
      idle();
    }
  }

  /// One pass of loop(): the clock is read once at its start, as on the box.
  void pass() {
    sync();
    noteSample(); // poll() samples the panel first thing
    box.poll();
    us += kPassMicros;
    bridge.drainTx();
  }

  void runUntil(uint64_t endUs) {
    while (us < endUs) {
      pass();
    }
  }

  void send(const proto::Frame& f) {
    char buf[proto::kMaxFrameLen];
    const size_t len = proto::encode(f, buf, sizeof(buf));
    for (size_t i = 0U; i < len; ++i) {
      bridge.feedByte(static_cast<uint8_t>(buf[i]));
    }
    pass();
  }

  uint16_t btnLines() const {
    uint16_t n = 0U;
    for (uint8_t i = 0U; i < bridge.lineCount(); ++i) {
      if (strncmp(bridge.line(i), "!BTN", 4U) == 0) {
        ++n;
      }
    }
    return n;
  }

  /// The busy landing the taps are measured against.
  void busyLanding() {
    send(proto::Frame::cfg(1U, "REINIT", 30U));
    const int16_t map[4] = {1, 2, 3, 4};
    send(proto::Frame::map(map));
    send(proto::Frame::idle(0x07U, "1805"));
    send(proto::Frame::on(proto::Court::A, 5400U, 2U));
    send(proto::Frame::on(proto::Court::C, 2700U, 3U));
    runUntil(us + 3000000ULL);
  }
};

void TimedDisplay::clear() {
  bench_.spend(kClearMicros);
}

void TimedDisplay::print(uint8_t row, uint8_t col, const char* text) {
  static_cast<void>(row);
  static_cast<void>(col);
  bench_.spend(charMicros_); // the cursor move
  for (size_t i = 0U; text != nullptr && text[i] != '\0'; ++i) {
    bench_.spend(charMicros_);
  }
}

void TimedDisplay::reinit() {
  bench_.spend(kReinitMicros);
}

/// A tiny deterministic generator: the same taps on every run and platform.
struct Lcg {
  uint32_t state;

  uint32_t next() {
    state = state * 1664525U + 1013904223U;
    return state >> 8U;
  }
};

struct Result {
  uint32_t taps;
  uint32_t missed;
  uint32_t longestGapUs;
};

/// `taps` taps of court A, durations uniform in [minMs, maxMs] at a
/// microsecond-random phase, 400-700 ms apart; a tap is seen when it produced
/// exactly one `!BTN`.
Result measure(uint32_t charMicros, bool hook, uint32_t minMs, uint32_t maxMs, uint32_t taps, uint32_t seed) {
  Bench b(charMicros, hook);
  b.busyLanding();
  Lcg rng{seed};
  Result r{taps, 0U, 0U};
  b.longestGapUs = 0U;
  for (uint32_t i = 0U; i < taps; ++i) {
    if (i % 50U == 0U) {
      // A live bridge says so every beat; without it the box would go
      // OUT OF SERVICE after 330 s and change the load being measured.
      b.send(proto::Frame::idle(0x07U, "1805"));
      b.bridge.clearLines();
    }
    const uint64_t from = b.us + 1000ULL + (rng.next() % 300000U);
    const uint64_t held =
        static_cast<uint64_t>(minMs) * 1000ULL + rng.next() % ((maxMs - minMs) * 1000U + 1U);
    b.buttons.tap(0U, from, from + held);
    b.runUntil(from + held + 400000ULL);
    if (b.btnLines() != 1U) {
      ++r.missed;
    }
    b.bridge.clearLines();
  }
  r.longestGapUs = b.longestGapUs;
  return r;
}

void report(const char* label, const Result& r) {
  char line[160];
  snprintf(line, sizeof(line), "%s: %lu of %lu taps missed (%.2f%%), longest gap between samples %lu us",
           label, static_cast<unsigned long>(r.missed), static_cast<unsigned long>(r.taps),
           100.0 * static_cast<double>(r.missed) / static_cast<double>(r.taps),
           static_cast<unsigned long>(r.longestGapUs));
  TEST_MESSAGE(line);
}

constexpr uint32_t kTaps = 1000U;

} // namespace

void setUp(void) {
}

void tearDown(void) {
}

// --- the panel rule itself ----------------------------------------------------

namespace {

class LevelButtons final : public hal::IButtonPort {
public:
  hal::PinLevel read(uint8_t channel) override {
    return channel == 0U && down ? hal::kButtonPressedLevel : hal::kButtonReleasedLevel;
  }

  bool down = false;
};

} // namespace

void test_a_press_completed_by_a_sample_between_passes_is_handed_over_once(void) {
  LevelButtons pins;
  courtlogic::ButtonPanel panel(pins);
  pins.down = true;
  TEST_ASSERT_EQUAL_UINT8(0U, panel.poll(1000U));
  panel.sample(1081U); // the window completes inside a paint
  pins.down = false;
  panel.sample(1082U); // and the finger is gone before the next pass
  TEST_ASSERT_EQUAL_UINT8(courtlogic::buttonBit(0U), panel.poll(1090U));
  TEST_ASSERT_EQUAL_UINT8(0U, panel.poll(1200U));
  TEST_ASSERT_EQUAL_UINT8(0U, panel.poll(1400U));
}

void test_samples_between_passes_keep_the_eighty_millisecond_rule(void) {
  // The extra samples are the same rule, not a shorter one: 79 ms held is
  // still chatter however often it is looked at.
  LevelButtons pins;
  courtlogic::ButtonPanel panel(pins);
  pins.down = true;
  panel.sample(1000U);
  for (uint32_t t = 1000U; t < 1079U; ++t) {
    panel.sample(t);
  }
  pins.down = false;
  for (uint32_t t = 1079U; t < 1300U; ++t) {
    panel.sample(t);
  }
  TEST_ASSERT_EQUAL_UINT8(0U, panel.poll(1300U));
}

// --- DL-15, measured ---------------------------------------------------------

void test_short_taps_were_missed_when_nothing_sampled_during_the_paint(void) {
  // The "before": Mega 3.0.0 as built. The model must bite, or the "after"
  // below proves nothing.
  const Result fast = measure(kCharMicros400k, false, 80U, 160U, kTaps, 0x15U);
  const Result slow = measure(kCharMicros100k, false, 80U, 160U, kTaps, 0x15U);
  report("before, 400 kHz, taps 80-160 ms", fast);
  report("before, 100 kHz, taps 80-160 ms", slow);
  TEST_ASSERT_TRUE(fast.missed > 0U);
  TEST_ASSERT_TRUE(slow.missed > 0U);
}

void test_no_tap_past_the_window_is_missed_with_the_idle_hook(void) {
  // The guarantee: every tap held 83 ms or longer — the 80 ms window, the
  // millisecond clock and one gap between samples — is one `!BTN`, at either
  // bus clock, on the busiest landing.
  const Result fast = measure(kCharMicros400k, true, 83U, 160U, kTaps, 0x15U);
  const Result slow = measure(kCharMicros100k, true, 83U, 160U, kTaps, 0x15U);
  report("after, 400 kHz, taps 83-160 ms", fast);
  report("after, 100 kHz, taps 83-160 ms", slow);
  TEST_ASSERT_EQUAL_UINT32(0U, fast.missed);
  TEST_ASSERT_EQUAL_UINT32(0U, slow.missed);
  TEST_ASSERT_TRUE(fast.longestGapUs <= 2000U);
  TEST_ASSERT_TRUE(slow.longestGapUs <= 2000U);
}

void test_the_same_taps_as_before_with_the_idle_hook(void) {
  // Like for like with the "before": 80-160 ms. The only taps that may still
  // be lost are within ~3 ms of the window itself.
  const Result fast = measure(kCharMicros400k, true, 80U, 160U, kTaps, 0x15U);
  const Result slow = measure(kCharMicros100k, true, 80U, 160U, kTaps, 0x15U);
  report("after, 400 kHz, taps 80-160 ms", fast);
  report("after, 100 kHz, taps 80-160 ms", slow);
  TEST_ASSERT_TRUE(fast.missed * 100U <= kTaps * 5U);
  TEST_ASSERT_TRUE(slow.missed * 100U <= kTaps * 5U);
}

void test_the_near_window_taps_before_and_after(void) {
  // The taps DL-15 is about: 80-100 ms, a quick jab.
  const Result before = measure(kCharMicros100k, false, 83U, 100U, kTaps, 0x2BU);
  const Result after = measure(kCharMicros100k, true, 83U, 100U, kTaps, 0x2BU);
  report("before, 100 kHz, taps 83-100 ms", before);
  report("after, 100 kHz, taps 83-100 ms", after);
  TEST_ASSERT_TRUE(before.missed > 0U);
  TEST_ASSERT_EQUAL_UINT32(0U, after.missed);
}

int main(int argc, char** argv) {
  static_cast<void>(argc);
  static_cast<void>(argv);
  UNITY_BEGIN();
  RUN_TEST(test_a_press_completed_by_a_sample_between_passes_is_handed_over_once);
  RUN_TEST(test_samples_between_passes_keep_the_eighty_millisecond_rule);
  RUN_TEST(test_short_taps_were_missed_when_nothing_sampled_during_the_paint);
  RUN_TEST(test_no_tap_past_the_window_is_missed_with_the_idle_hook);
  RUN_TEST(test_the_same_taps_as_before_with_the_idle_hook);
  RUN_TEST(test_the_near_window_taps_before_and_after);
  return UNITY_END();
}

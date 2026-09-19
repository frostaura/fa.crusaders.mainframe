// Unity tests for tb::reached / tb::Deadline / tb::Uptime64.
//
// The whole point of this suite is the rollover. Each behavioural test is run
// at several clock bases, including bases chosen so the uint32 wrap lands in
// the middle of the scenario. A regression that reintroduces `now >= deadline`
// fails many of these, not one.

#include <stdint.h>
#include <unity.h>

#include "timebase/TimeBase.h"

namespace {

// Clock bases exercised by the matrix. WRAP_SOON puts the wrap ~4 seconds in,
// so any timer longer than that straddles it.
constexpr uint32_t kBaseZero = 0U;
constexpr uint32_t kBaseMid = 1234567U;
constexpr uint32_t kBaseWrapSoon = 0xFFFFF000U; // wraps 4096 ms in
constexpr uint32_t kBaseWrapNow = 0xFFFFFFFFU;  // wraps on the very next ms

constexpr uint32_t kBases[] = {kBaseZero, kBaseMid, kBaseWrapSoon, kBaseWrapNow};
constexpr size_t kBaseCount = sizeof(kBases) / sizeof(kBases[0]);

} // namespace

// --- reached() -------------------------------------------------------------

void test_reached_is_false_before_and_true_at_and_after(void) {
  for (size_t i = 0; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    const uint32_t deadline = base + 1000U;

    TEST_ASSERT_FALSE(tb::reached(base, deadline));
    TEST_ASSERT_FALSE(tb::reached(base + 999U, deadline));
    TEST_ASSERT_TRUE(tb::reached(deadline, deadline));
    TEST_ASSERT_TRUE(tb::reached(base + 1001U, deadline));
  }
}

// The regression test for the deleted sketch's bug.
//
// A naive `now >= deadline` fails in BOTH directions across the wrap, and the
// two failures look nothing alike:
//
//   (a) deadline computed just before the wrap, checked just after it
//       -> naive says "not yet" for another ~49.7 days. The relay is NEVER
//          released and a court burns for seven weeks. This is the severe one.
//
//   (b) deadline wrapped past zero, checked before the wrap
//       -> naive says "already passed" immediately. The relay is released
//          early and the lights cut out mid-game.
//
// Both are asserted here so neither can be reintroduced.
void test_reached_survives_the_wrap(void) {
  // --- direction (b): deadline wraps past zero, now is still pre-wrap --------
  const uint32_t wrappedDeadline = kBaseWrapSoon + 8000U; // == 0x00000F40
  TEST_ASSERT_EQUAL_UINT32(0x00000F40U, wrappedDeadline);

  TEST_ASSERT_FALSE(tb::reached(kBaseWrapSoon, wrappedDeadline));
  TEST_ASSERT_FALSE(tb::reached(0xFFFFFFFFU, wrappedDeadline));
  TEST_ASSERT_TRUE(tb::reached(wrappedDeadline, wrappedDeadline));
  TEST_ASSERT_TRUE(tb::reached(wrappedDeadline + 1U, wrappedDeadline));

  // The naive comparison fires ~8 seconds early here.
  TEST_ASSERT_TRUE(kBaseWrapSoon >= wrappedDeadline);
  TEST_ASSERT_FALSE(tb::reached(kBaseWrapSoon, wrappedDeadline));

  // --- direction (a): the severe one, "lights on for 49.7 days" -------------
  const uint32_t preWrapDeadline = 0xFFFFF800U;
  const uint32_t nowAfterWrap = 0x00000100U; // 2.8 s later in real time

  // Correct: the deadline passed, so the relay must be released.
  TEST_ASSERT_TRUE(tb::reached(nowAfterWrap, preWrapDeadline));

  // Naive: says "not yet", and keeps saying it for another ~49.7 days.
  TEST_ASSERT_FALSE(nowAfterWrap >= preWrapDeadline);
}

void test_since_is_wrap_correct(void) {
  TEST_ASSERT_EQUAL_UINT32(500U, tb::since(1500U, 1000U));
  // 100 ms before the wrap to 50 ms after it is 150 ms elapsed.
  TEST_ASSERT_EQUAL_UINT32(150U, tb::since(49U, 0xFFFFFF9BU));
}

// --- Deadline --------------------------------------------------------------

void test_deadline_starts_disarmed_and_never_expires(void) {
  tb::Deadline d;
  TEST_ASSERT_FALSE(d.isArmed());
  TEST_ASSERT_FALSE(d.expired(0U));
  TEST_ASSERT_FALSE(d.expired(0xFFFFFFFFU));
  TEST_ASSERT_EQUAL_UINT32(0U, d.remaining(12345U));
}

void test_deadline_arms_expires_and_disarms_at_every_base(void) {
  for (size_t i = 0; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    tb::Deadline d;

    d.arm(base, 30U * 60U * 1000U); // 30 minutes
    TEST_ASSERT_TRUE(d.isArmed());
    TEST_ASSERT_FALSE(d.expired(base));
    TEST_ASSERT_FALSE(d.expired(base + (29U * 60U * 1000U)));
    TEST_ASSERT_TRUE(d.expired(base + (30U * 60U * 1000U)));
    TEST_ASSERT_TRUE(d.expired(base + (31U * 60U * 1000U)));

    d.disarm();
    TEST_ASSERT_FALSE(d.isArmed());
    TEST_ASSERT_FALSE(d.expired(base + (60U * 60U * 1000U)));
  }
}

// Zero is a legal millis() value. A Deadline armed exactly at the moment the
// clock reads 0 must behave like any other — this is the sentinel bug.
void test_deadline_at_clock_zero_is_not_treated_as_disarmed(void) {
  tb::Deadline d;
  d.arm(0xFFFFFC18U, 1000U); // arms such that the deadline lands exactly on 0

  // Asserted through the contract rather than the stored field. `at` is private
  // precisely so `now >= d.at` cannot be written, and a test that reaches around
  // that would be asserting the representation instead of the behaviour.
  TEST_ASSERT_TRUE(d.isArmed());
  TEST_ASSERT_EQUAL_UINT32(1000U, d.remaining(0xFFFFFC18U));
  TEST_ASSERT_FALSE(d.expired(0xFFFFFC18U));
  TEST_ASSERT_TRUE(d.expired(0U));
}

void test_deadline_remaining_saturates_and_is_wrap_correct(void) {
  for (size_t i = 0; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    tb::Deadline d;
    d.arm(base, 5000U);

    TEST_ASSERT_EQUAL_UINT32(5000U, d.remaining(base));
    TEST_ASSERT_EQUAL_UINT32(2500U, d.remaining(base + 2500U));
    TEST_ASSERT_EQUAL_UINT32(0U, d.remaining(base + 5000U));
    TEST_ASSERT_EQUAL_UINT32(0U, d.remaining(base + 9999U));
  }
}

// Re-arming an already-armed deadline extends it from `now`, which is what
// back-to-back court bookings need.
void test_deadline_rearm_extends_from_now(void) {
  tb::Deadline d;
  d.arm(1000U, 5000U);
  TEST_ASSERT_EQUAL_UINT32(5000U, d.remaining(1000U));
  TEST_ASSERT_TRUE(d.expired(6000U));

  d.arm(4000U, 5000U);
  TEST_ASSERT_EQUAL_UINT32(5000U, d.remaining(4000U));
  TEST_ASSERT_FALSE(d.expired(8999U));
  TEST_ASSERT_TRUE(d.expired(9000U));
}

// --- Uptime64 --------------------------------------------------------------

void test_uptime64_accumulates_across_the_wrap(void) {
  tb::Uptime64 up;
  up.seed(0xFFFFF000U);

  TEST_ASSERT_EQUAL_UINT64(0U, up.value());
  TEST_ASSERT_EQUAL_UINT64(0x800U, up.tick(0xFFFFF800U));

  // Cross the wrap: 0xFFFFF800 -> 0x00000800 is 0x1000 ms.
  TEST_ASSERT_EQUAL_UINT64(0x1800U, up.tick(0x00000800U));

  // A full 49.7-day lap adds 2^32 ms and stays monotonic.
  const uint64_t before = up.value();
  up.tick(0x80000800U);
  up.tick(0x00000800U);
  TEST_ASSERT_TRUE(up.value() > before);
  TEST_ASSERT_EQUAL_UINT64(before + 0x100000000ULL, up.value());
}

void test_uptime64_is_monotonic_over_many_laps(void) {
  tb::Uptime64 up;
  up.seed(0U);
  uint64_t previous = 0U;
  uint32_t raw = 0U;

  for (int lap = 0; lap < 8; ++lap) {
    for (int step = 0; step < 4; ++step) {
      raw += 0x40000000U; // quarter of the range, well under the 2^31 contract
      const uint64_t now = up.tick(raw);
      TEST_ASSERT_TRUE(now > previous);
      previous = now;
    }
  }
  TEST_ASSERT_EQUAL_UINT64(8ULL * 0x100000000ULL, up.value());
}

void test_widen_puts_a_32_bit_stamp_back_on_the_right_side_of_the_wrap() {
  // REVIEW 3, FINDING 25. An event is stamped with a 32-bit millis() reading
  // and may sit in the queue for days. Sent as 32 bits, a stamp taken before
  // the 49.7-day wrap and uploaded after it reads as a moment 49.7 days AHEAD
  // of the batch's own 64-bit uptime, and the server — which dates an event by
  // subtracting its uptime from the batch's — dates it at upload time.
  const uint64_t wrap = 0x100000000ULL;

  // The ordinary case: no wrap between stamp and upload.
  TEST_ASSERT_EQUAL_UINT64(90000ULL, tb::widen(120000ULL, 90000UL));
  TEST_ASSERT_EQUAL_UINT64(120000ULL, tb::widen(120000ULL, 120000UL));

  // Four seconds before the wrap, uploaded twenty seconds after it.
  TEST_ASSERT_EQUAL_UINT64(wrap - 4096ULL, tb::widen(wrap + 20000ULL, 0xFFFFF000UL));

  // The instant of the wrap itself, from either side.
  TEST_ASSERT_EQUAL_UINT64(wrap, tb::widen(wrap, 0U));
  TEST_ASSERT_EQUAL_UINT64(wrap, tb::widen(wrap + 1ULL, 0U));

  // Eight laps in: the answer is on THIS lap, not the first one.
  const uint64_t deep = (8ULL * wrap) + 5000ULL;
  TEST_ASSERT_EQUAL_UINT64((8ULL * wrap) + 1000ULL, tb::widen(deep, 1000UL));
  TEST_ASSERT_EQUAL_UINT64((7ULL * wrap) + 0xFFFFF000ULL, tb::widen(deep, 0xFFFFF000UL));

  // Never later than now: a stamp cannot be from the future.
  for (uint32_t offset = 0U; offset < 5U; ++offset) {
    const uint32_t stamp = 5000UL + offset;
    TEST_ASSERT_TRUE(tb::widen(deep, stamp) <= deep);
  }
}

void test_format_u64_renders_every_digit_or_refuses() {
  char out[24] = {};
  TEST_ASSERT_EQUAL_size_t(1U, tb::formatU64(0ULL, out, sizeof(out)));
  TEST_ASSERT_EQUAL_STRING("0", out);
  TEST_ASSERT_EQUAL_size_t(6U, tb::formatU64(120000ULL, out, sizeof(out)));
  TEST_ASSERT_EQUAL_STRING("120000", out);
  // Past 2^32, which is the whole point: `%lu` on a 32-bit long silently
  // truncates exactly here.
  TEST_ASSERT_EQUAL_size_t(10U, tb::formatU64(4294987296ULL, out, sizeof(out)));
  TEST_ASSERT_EQUAL_STRING("4294987296", out);
  TEST_ASSERT_EQUAL_size_t(20U, tb::formatU64(UINT64_MAX, out, sizeof(out)));
  TEST_ASSERT_EQUAL_STRING("18446744073709551615", out);
  // Refused, not truncated: half a number is a different number.
  char tiny[4] = {'x', 'x', 'x', 'x'};
  TEST_ASSERT_EQUAL_size_t(0U, tb::formatU64(120000ULL, tiny, sizeof(tiny)));
  TEST_ASSERT_EQUAL_STRING("", tiny);
  TEST_ASSERT_EQUAL_size_t(0U, tb::formatU64(1ULL, out, 0U));
  TEST_ASSERT_EQUAL_size_t(0U, tb::formatU64(1ULL, nullptr, sizeof(out)));
  // Exactly fits.
  char exact[2] = {};
  TEST_ASSERT_EQUAL_size_t(1U, tb::formatU64(7ULL, exact, sizeof(exact)));
  TEST_ASSERT_EQUAL_STRING("7", exact);
}

// --- runner ----------------------------------------------------------------

void setUp(void) {
}

void tearDown(void) {
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_reached_is_false_before_and_true_at_and_after);
  RUN_TEST(test_reached_survives_the_wrap);
  RUN_TEST(test_since_is_wrap_correct);
  RUN_TEST(test_deadline_starts_disarmed_and_never_expires);
  RUN_TEST(test_deadline_arms_expires_and_disarms_at_every_base);
  RUN_TEST(test_deadline_at_clock_zero_is_not_treated_as_disarmed);
  RUN_TEST(test_deadline_remaining_saturates_and_is_wrap_correct);
  RUN_TEST(test_deadline_rearm_extends_from_now);
  RUN_TEST(test_uptime64_accumulates_across_the_wrap);
  RUN_TEST(test_uptime64_is_monotonic_over_many_laps);
  RUN_TEST(test_widen_puts_a_32_bit_stamp_back_on_the_right_side_of_the_wrap);
  RUN_TEST(test_format_u64_renders_every_digit_or_refuses);
  return UNITY_END();
}

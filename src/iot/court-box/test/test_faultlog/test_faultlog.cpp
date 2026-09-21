// Unity tests for bridgelogic::FaultLog — what a court box may tell the club
// about itself going wrong, and how loudly.
//
// A SUITE OF ITS OWN, not a section of test_bridgelogic, because the property
// under test is a RATE and every assertion in here is about a clock. Deadline
// behaviour is run at the four bases the firmware suites share, including two
// chosen so the 49.7-day millis() wrap lands in the middle of a window — a box
// in a cupboard is up long enough to see it, and a wrap that re-armed every
// window would turn a rate limit into a flood at exactly the wrong moment.

#include <stdint.h>
#include <string.h>
#include <unity.h>

#include "bridgelogic/FaultLog.h"
#include "eventq/Event.h"

namespace {

using bridgelogic::Fault;
using bridgelogic::FaultLog;

constexpr uint32_t kBaseZero = 0U;
constexpr uint32_t kBaseMid = 1234567U;
constexpr uint32_t kBaseWrapSoon = 0xFFFFF000U;
constexpr uint32_t kBaseWrapNow = 0xFFFFFFFFU;

constexpr uint32_t kBases[] = {kBaseZero, kBaseMid, kBaseWrapSoon, kBaseWrapNow};
constexpr size_t kBaseCount = sizeof(kBases) / sizeof(kBases[0]);

/// Twenty an hour is the default, so one window is three minutes.
constexpr uint32_t kWindowMs = 180000UL;

bool subjectIs(const eventq::Event& e, const char* text) {
  return e.subjectLen == strlen(text) && strncmp(e.subject, text, e.subjectLen) == 0;
}

void test_a_flood_costs_one_event_carrying_the_count(void) {
  for (size_t b = 0; b < kBaseCount; ++b) {
    const uint32_t base = kBases[b];
    FaultLog log;
    TEST_ASSERT_EQUAL_UINT32(kWindowMs, log.windowMs());

    // Four hundred CRC errors inside one window — the failure this type exists
    // for. Four hundred events would race the scan frames on the same 9600 baud
    // line at exactly the moment the line is already in trouble.
    for (uint32_t i = 0U; i < 400U; ++i) {
      log.note(Fault::SerialBadCrc, base + i);
    }

    eventq::Event event;
    TEST_ASSERT_FALSE_MESSAGE(log.next(base + kWindowMs - 1U, event),
                              "a code reported before its window closed");

    TEST_ASSERT_TRUE(log.next(base + kWindowMs, event));
    TEST_ASSERT_EQUAL(eventq::Kind::Fault, event.kind);
    TEST_ASSERT_TRUE(subjectIs(event, "serial_badcrc"));
    TEST_ASSERT_EQUAL_UINT32(400U, event.durationMs);
    TEST_ASSERT_EQUAL_UINT8(eventq::Event::kNoCourt, event.court);
    TEST_ASSERT_EQUAL_UINT32(0U, event.seq);

    // And exactly one: the slot is free again, so a quiet link says nothing.
    TEST_ASSERT_FALSE(log.next(base + kWindowMs + 1U, event));
    TEST_ASSERT_FALSE(log.next(base + (2U * kWindowMs), event));
  }
}

void test_a_second_burst_opens_a_second_window(void) {
  FaultLog log;
  eventq::Event event;

  log.note(Fault::HttpTimeout, kBaseMid);
  TEST_ASSERT_TRUE(log.next(kBaseMid + kWindowMs, event));
  TEST_ASSERT_EQUAL_UINT32(1U, event.durationMs);

  // The window is per burst, not a fixed schedule: a fault that starts again an
  // hour later is reported a window after it started, not an hour later.
  const uint32_t later = kBaseMid + 3600000UL;
  log.note(Fault::HttpTimeout, later);
  log.note(Fault::HttpTimeout, later + 10U);
  TEST_ASSERT_FALSE(log.next(later + kWindowMs - 1U, event));
  TEST_ASSERT_TRUE(log.next(later + kWindowMs, event));
  TEST_ASSERT_EQUAL_UINT32(2U, event.durationMs);
}

void test_eight_codes_are_tracked_and_the_ninth_is_named_overflow(void) {
  FaultLog log;
  const Fault eight[] = {Fault::SerialBadCrc,  Fault::SerialBadFrame, Fault::SerialOverrunRx,
                         Fault::SerialBadVerb, Fault::OnNotAcked,     Fault::ExtRefused,
                         Fault::ScanOversize,  Fault::LcdResync};
  for (size_t i = 0; i < 8U; ++i) {
    log.note(eight[i], kBaseMid);
  }
  TEST_ASSERT_EQUAL_UINT32(0U, log.overflowed());

  // A ninth does NOT evict an eighth. Losing the ninth code's identity is the
  // right trade; losing the knowledge that something unnamed is happening is
  // not.
  log.note(Fault::Http5xx, kBaseMid + 1U);
  log.note(Fault::HeartbeatRejected, kBaseMid + 2U);
  TEST_ASSERT_EQUAL_UINT32(2U, log.overflowed());

  eventq::Event event;
  uint8_t drained = 0U;
  bool sawOverflow = false;
  while (log.next(kBaseMid + kWindowMs + 100U, event)) {
    ++drained;
    if (subjectIs(event, "fault_overflow")) {
      sawOverflow = true;
      TEST_ASSERT_EQUAL_UINT32(2U, event.durationMs);
    }
    TEST_ASSERT_TRUE_MESSAGE(drained <= 9U, "next() yielded more than the slots hold");
  }
  TEST_ASSERT_EQUAL_UINT8(9U, drained);
  TEST_ASSERT_TRUE(sawOverflow);
}

void test_one_event_per_call_so_a_pass_is_never_spent_draining(void) {
  FaultLog log;
  log.note(Fault::SerialBadCrc, kBaseMid);
  log.note(Fault::HttpTimeout, kBaseMid);
  log.note(Fault::LcdI2cTimeout, kBaseMid);

  eventq::Event event;
  const uint32_t due = kBaseMid + kWindowMs;
  TEST_ASSERT_TRUE(log.next(due, event));
  TEST_ASSERT_TRUE(log.next(due, event));
  TEST_ASSERT_TRUE(log.next(due, event));
  TEST_ASSERT_FALSE(log.next(due, event));
}

void test_a_court_specific_fault_carries_its_relay_and_a_mixed_one_does_not(void) {
  FaultLog log;
  eventq::Event event;

  log.note(Fault::RelayCmdDropped, 2U, kBaseMid);
  log.note(Fault::RelayCmdDropped, 2U, kBaseMid + 5U);
  TEST_ASSERT_TRUE(log.next(kBaseMid + kWindowMs, event));
  TEST_ASSERT_EQUAL_UINT8(2U, event.court);
  TEST_ASSERT_EQUAL_UINT32(2U, event.durationMs);

  // Two courts, one code. The code is the fact worth keeping; picking whichever
  // relay happened to be last would be a guess with a court number on it.
  const uint32_t at = kBaseMid + (2U * kWindowMs);
  log.note(Fault::RelayCmdDropped, 0U, at);
  log.note(Fault::RelayCmdDropped, 3U, at + 1U);
  TEST_ASSERT_TRUE(log.next(at + kWindowMs, event));
  TEST_ASSERT_EQUAL_UINT8(eventq::Event::kNoCourt, event.court);
}

void test_the_rate_is_the_tenants_and_is_clamped_at_both_ends(void) {
  FaultLog log;

  log.setMaxPerHour(60U);
  TEST_ASSERT_EQUAL_UINT32(60000UL, log.windowMs());

  // Clamped, never refused: an out-of-range setting must not leave the box
  // reporting at whatever the previous admin chose without saying so.
  log.setMaxPerHour(0U);
  TEST_ASSERT_EQUAL_UINT32(3600000UL, log.windowMs());
  log.setMaxPerHour(9999U);
  TEST_ASSERT_EQUAL_UINT32(30000UL, log.windowMs());

  // A window already armed keeps its length. Shortening it under a code that is
  // mid-window would report a partial count as a whole one.
  log.setMaxPerHour(20U);
  log.note(Fault::WdtReset, kBaseMid);
  log.setMaxPerHour(120U);
  eventq::Event event;
  TEST_ASSERT_FALSE(log.next(kBaseMid + 30000U, event));
  TEST_ASSERT_TRUE(log.next(kBaseMid + kWindowMs, event));
}

void test_a_club_that_turns_reporting_off_gets_silence_not_a_backlog(void) {
  FaultLog log;
  log.setEnabled(false);
  for (uint32_t i = 0U; i < 50U; ++i) {
    log.note(Fault::SerialBadCrc, kBaseMid + i);
  }
  eventq::Event event;
  TEST_ASSERT_FALSE(log.next(kBaseMid + (10U * kWindowMs), event));

  // And turning it back on does not release a queue that was never filled.
  log.setEnabled(true);
  TEST_ASSERT_FALSE(log.next(kBaseMid + (11U * kWindowMs), event));
}

void test_a_counter_diff_of_zero_never_opens_a_window(void) {
  // What a per-heartbeat diff of the Mega's !PONG counters produces on a quiet
  // link. A window opened by a zero would report "0" every three minutes for
  // ever, which is a monitoring table nobody reads.
  FaultLog log;
  log.noteMany(Fault::ButtonUnauthorised, 0U, eventq::Event::kNoCourt, kBaseMid);
  eventq::Event event;
  TEST_ASSERT_FALSE(log.next(kBaseMid + (2U * kWindowMs), event));

  log.noteMany(Fault::ButtonUnauthorised, 7U, eventq::Event::kNoCourt, kBaseMid);
  TEST_ASSERT_TRUE(log.next(kBaseMid + kWindowMs, event));
  TEST_ASSERT_EQUAL_UINT32(7U, event.durationMs);
}

void test_the_count_saturates_rather_than_wrapping(void) {
  // A wrapped count is a plausible small number, and a plausible small number
  // is acted on rather than questioned.
  FaultLog log;
  log.noteMany(Fault::SerialBadCrc, UINT32_MAX, eventq::Event::kNoCourt, kBaseMid);
  log.noteMany(Fault::SerialBadCrc, 1000U, eventq::Event::kNoCourt, kBaseMid + 1U);
  eventq::Event event;
  TEST_ASSERT_TRUE(log.next(kBaseMid + kWindowMs, event));
  TEST_ASSERT_EQUAL_UINT32(UINT32_MAX, event.durationMs);
}

void test_every_code_has_a_name_the_backend_can_store(void) {
  // The backend normalises and caps `kind` at 32 characters. A code longer than
  // the event's subject would be truncated into a DIFFERENT code, and a
  // monitoring table cannot tell the two apart.
  for (uint8_t i = 0U; i < bridgelogic::kFaultCount; ++i) {
    const char* name = bridgelogic::faultName(static_cast<Fault>(i));
    TEST_ASSERT_NOT_NULL(name);
    const size_t len = strlen(name);
    TEST_ASSERT_TRUE_MESSAGE(len > 0U, "a fault code has no name");
    TEST_ASSERT_TRUE_MESSAGE(len <= 32U, name);
    for (size_t c = 0; c < len; ++c) {
      const char ch = name[c];
      const bool ok = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_';
      TEST_ASSERT_TRUE_MESSAGE(ok, name);
    }
    // And every one is distinct: two codes with one name is one row in the
    // monitoring table where there should be two.
    for (uint8_t j = 0U; j < i; ++j) {
      TEST_ASSERT_TRUE_MESSAGE(strcmp(name, bridgelogic::faultName(static_cast<Fault>(j))) != 0, name);
    }
  }
}

void test_a_window_that_straddles_the_wrap_still_closes_once(void) {
  // The case a naive comparison gets wrong in the worst direction: a box up for
  // forty-nine days would either report instantly and repeatedly, or never.
  for (size_t b = 0; b < kBaseCount; ++b) {
    const uint32_t base = kBases[b];
    FaultLog log;
    log.note(Fault::ApiBreakerOpen, base);
    for (uint32_t step = 1000U; step < kWindowMs; step += 1000U) {
      log.note(Fault::ApiBreakerOpen, base + step);
      eventq::Event ignored;
      TEST_ASSERT_FALSE(log.next(base + step, ignored));
    }
    eventq::Event event;
    TEST_ASSERT_TRUE(log.next(base + kWindowMs, event));
    TEST_ASSERT_EQUAL_UINT32(180U, event.durationMs);
    TEST_ASSERT_FALSE(log.next(base + kWindowMs + 1U, event));
  }
}

} // namespace

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_a_flood_costs_one_event_carrying_the_count);
  RUN_TEST(test_a_second_burst_opens_a_second_window);
  RUN_TEST(test_eight_codes_are_tracked_and_the_ninth_is_named_overflow);
  RUN_TEST(test_one_event_per_call_so_a_pass_is_never_spent_draining);
  RUN_TEST(test_a_court_specific_fault_carries_its_relay_and_a_mixed_one_does_not);
  RUN_TEST(test_the_rate_is_the_tenants_and_is_clamped_at_both_ends);
  RUN_TEST(test_a_club_that_turns_reporting_off_gets_silence_not_a_backlog);
  RUN_TEST(test_a_counter_diff_of_zero_never_opens_a_window);
  RUN_TEST(test_the_count_saturates_rather_than_wrapping);
  RUN_TEST(test_every_code_has_a_name_the_backend_can_store);
  RUN_TEST(test_a_window_that_straddles_the_wrap_still_closes_once);
  return UNITY_END();
}

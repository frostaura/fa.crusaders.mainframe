// Unity tests for bridgelogic::pumpEventDrain — the court box's event upload.
//
// Its own suite, because the defects it pins are about TIME rather than about
// one answer: review round 16 found a box that re-posted its head event on
// every pass while `/events` refused it (D16-2), and one that threw an
// evening's attendance away when the console deleted its row (D16-3). The
// first is only visible across thousands of passes on a moving clock, so the
// scenarios below run the drain the way main.cpp's loop does — one step per
// pass, a fake server that costs real milliseconds per call — and count posts.
//
// Every scenario runs at a base that puts the millis() wrap inside it as well
// as at zero: a court box in a cupboard runs for months.

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unity.h>

#include "bridgelogic/EventDrain.h"
#include "eventq/EventQueue.h"
#include "fakes/FakeClock.h"
#include "fakes/FakeStore.h"

namespace {

constexpr uint32_t kBases[] = {0U, 1234567U, 0xFFFFF000U, 0xFFFFFFFFU};
constexpr size_t kBaseCount = sizeof(kBases) / sizeof(kBases[0]);

constexpr uint32_t kPassMs = 10U; // the idle tick between loop passes
constexpr uint32_t kCallMs = 5U;  // a refusal from a server on the LAN
constexpr uint32_t kHourMs = 3600000UL;
constexpr uint32_t kOutageStepMs = 60000UL;
constexpr uint32_t kDayMs = 86400000UL;

using Queue = eventq::EventQueue<8U>;

/// A server whose answer the test scripts, that charges the clock for each
/// call the way a real round trip does, and acknowledges the seq it was sent
/// when it says 200.
class FakeEventsApi {
public:
  explicit FakeEventsApi(fakes::FakeClock& clock) : clock_(clock) {}

  uint16_t status = 200U;
  /// A 200 that names nothing — the head stays where a refusal leaves it.
  bool acknowledge = true;

  uint32_t posts = 0U;
  uint32_t lastPostAt = 0U;
  uint32_t shortestGapMs = UINT32_MAX;

  uint16_t operator()(const char* body, char* response, size_t cap) {
    const uint32_t now = clock_.value();
    if (posts > 0U) {
      const uint32_t gap = now - lastPostAt;
      shortestGapMs = gap < shortestGapMs ? gap : shortestGapMs;
    }
    lastPostAt = now;
    ++posts;
    clock_.advance(kCallMs);

    if (status == 200U && acknowledge) {
      const char* seq = strstr(body, "\"seq\":");
      TEST_ASSERT_NOT_NULL(seq);
      snprintf(response, cap, "{\"accepted_through\":%lu}", strtoul(seq + 6, nullptr, 10));
    } else {
      snprintf(response, cap, "{}");
    }
    return status;
  }

private:
  fakes::FakeClock& clock_;
};

struct Rig {
  explicit Rig(uint32_t base) : clock(base), api(clock), queue(&store) { queue.begin(); }

  void queueBoots(uint8_t count) {
    for (uint8_t i = 0U; i < count; ++i) {
      eventq::Event event;
      event.kind = eventq::Kind::Boot;
      event.court = eventq::Event::kNoCourt;
      event.uptimeMs = clock.value();
      TEST_ASSERT_TRUE(queue.push(event) == eventq::PushResult::Ok);
    }
  }

  /// One loop pass: the drain's step, then the idle tick. `online` is
  /// main.cpp's verdict — the radio is up AND the breaker is closed.
  bool pass(bool online = true) {
    bridgelogic::DrainSource source;
    source.mac = "5ccf7f0a1b2c";
    source.uptimeMs = 1000ULL + clock.value();
    const bool posted = bridgelogic::pumpEventDrain(queue, pace, source, online, clock, api);
    clock.advance(kPassMs);
    return posted;
  }

  /// An outage of `ms`: the loop keeps passing, the drain is offered every
  /// pass, and every pass is offline. Stepped a minute at a time rather than
  /// at kPassMs, because 2^31 ms of ten-millisecond passes is two hundred
  /// million of them; what matters is that the passes HAPPEN, as they do on
  /// the board, whose loop never stops for a dead radio.
  void outage(uint32_t ms) {
    const uint32_t start = clock.value();
    while (clock.value() - start < ms) {
      TEST_ASSERT_FALSE(pass(false));
      const uint32_t gone = clock.value() - start;
      if (gone < ms) {
        clock.advance(ms - gone < kOutageStepMs ? ms - gone : kOutageStepMs);
      }
    }
  }

  /// Passes until `ms` of clock have gone by.
  void runFor(uint32_t ms) {
    const uint32_t start = clock.value();
    while (clock.value() - start < ms) {
      static_cast<void>(pass());
    }
  }

  fakes::FakeClock clock;
  FakeEventsApi api;
  fakes::FakeStore store;
  Queue queue;
  bridgelogic::DrainPace pace;
};

/// Posts the backoff allows in `windowMs` from the first refusal: one at 0,
/// then one per window of 15, 30, 60, 120, 240 s and 300 s after that.
uint32_t backoffPostBound(uint32_t windowMs) {
  uint32_t posts = 1U;
  uint32_t at = 0U;
  uint32_t step = bridgelogic::kEventRetryStartMs;
  while (true) {
    at += step;
    if (at > windowMs) {
      return posts;
    }
    ++posts;
    step = step >= bridgelogic::kEventRetryMaxMs / 2U ? bridgelogic::kEventRetryMaxMs : step * 2U;
  }
}

void persistentRefusalIsPaced(uint16_t status, uint8_t queued) {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    Rig rig(kBases[i]);
    rig.queueBoots(queued);
    rig.api.status = status;

    rig.runFor(kHourMs);

    // About seventeen in an hour, against ~240 000 when every pass re-posted.
    // The bound has one call's slack per window: each window is armed from the
    // clock read AFTER the call.
    TEST_ASSERT_GREATER_OR_EQUAL_UINT32(2U, rig.api.posts);
    TEST_ASSERT_LESS_OR_EQUAL_UINT32(backoffPostBound(kHourMs), rig.api.posts);
    TEST_ASSERT_GREATER_OR_EQUAL_UINT32(bridgelogic::kEventRetryStartMs, rig.api.shortestGapMs);
    // Every event was KEPT: a refusal about the box is not a reason to throw
    // its attendance away.
    TEST_ASSERT_EQUAL_UINT16(queued, rig.queue.size());
    TEST_ASSERT_EQUAL_UINT32(bridgelogic::kEventRetryMaxMs, rig.pace.backoffMs());
  }
}

void test_a_disabled_box_answered_403_posts_a_paced_handful_not_every_pass(void) {
  persistentRefusalIsPaced(403U, 1U);
  persistentRefusalIsPaced(403U, 5U);
}

void test_a_rate_limited_box_answered_429_backs_off_rather_than_feeding_the_limit(void) {
  persistentRefusalIsPaced(429U, 1U);
  persistentRefusalIsPaced(429U, 5U);
}

void test_a_wrong_key_401_and_a_timeout_408_are_paced_the_same_way(void) {
  persistentRefusalIsPaced(401U, 2U);
  persistentRefusalIsPaced(408U, 2U);
}

void test_a_200_that_acknowledges_nothing_is_paced_like_a_refusal(void) {
  // The healthy-looking hot loop: the status says fine, the head never moves.
  for (size_t i = 0U; i < kBaseCount; ++i) {
    Rig rig(kBases[i]);
    rig.queueBoots(3U);
    rig.api.acknowledge = false;
    rig.runFor(kHourMs);
    TEST_ASSERT_LESS_OR_EQUAL_UINT32(backoffPostBound(kHourMs), rig.api.posts);
    TEST_ASSERT_EQUAL_UINT16(3U, rig.queue.size());
  }
}

void test_the_drain_resumes_within_one_window_of_a_200_and_then_runs_at_loop_pace(void) {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    for (uint8_t queued = 1U; queued <= 4U; queued = static_cast<uint8_t>(queued + 3U)) {
      Rig rig(kBases[i]);
      rig.queueBoots(queued);
      rig.api.status = 429U;
      rig.runFor(kHourMs); // the backoff is at its cap now

      rig.api.status = 200U;
      const uint32_t liftedAt = rig.clock.value();
      while (rig.queue.size() == queued && rig.clock.value() - liftedAt <= bridgelogic::kEventRetryMaxMs) {
        static_cast<void>(rig.pass());
      }
      // Noticed inside the window that was already running, never later.
      TEST_ASSERT_EQUAL_UINT16(queued - 1U, rig.queue.size());
      TEST_ASSERT_EQUAL_UINT32(0U, rig.pace.backoffMs());

      // And the rest go one per pass — progress clears the backoff entirely.
      const uint32_t posts = rig.api.posts;
      for (uint8_t left = static_cast<uint8_t>(queued - 1U); left > 0U; --left) {
        TEST_ASSERT_TRUE(rig.pass());
      }
      TEST_ASSERT_TRUE(rig.queue.empty());
      TEST_ASSERT_EQUAL_UINT32(posts + queued - 1U, rig.api.posts);
      TEST_ASSERT_FALSE(rig.pass()); // nothing left, nothing posted
    }
  }
}

void test_a_healthy_box_drains_one_event_per_pass_with_no_backoff(void) {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    Rig rig(kBases[i]);
    rig.queueBoots(6U);
    for (uint8_t n = 0U; n < 6U; ++n) {
      TEST_ASSERT_TRUE(rig.pass());
    }
    TEST_ASSERT_TRUE(rig.queue.empty());
    TEST_ASSERT_EQUAL_UINT32(6U, rig.api.posts);
    TEST_ASSERT_EQUAL_UINT32(0U, rig.pace.backoffMs());
  }
}

void test_a_400_drops_the_head_and_the_next_event_goes_on_the_next_pass(void) {
  // A 4xx this box caused still moves the queue — no backoff, or one bad event
  // would cost the rest of the ring fifteen seconds each.
  for (size_t i = 0U; i < kBaseCount; ++i) {
    Rig rig(kBases[i]);
    rig.queueBoots(3U);
    rig.api.status = 400U;
    TEST_ASSERT_TRUE(rig.pass());
    TEST_ASSERT_EQUAL_UINT16(2U, rig.queue.size());
    TEST_ASSERT_EQUAL_UINT32(0U, rig.pace.backoffMs());
    TEST_ASSERT_TRUE(rig.pass());
    TEST_ASSERT_EQUAL_UINT16(1U, rig.queue.size());
  }
}

void test_a_404_from_a_deleted_row_keeps_the_event_until_the_box_is_known_again(void) {
  // D16-3. The console deleted this box; its next heartbeat registers it again
  // and the very same event is then accepted. Dropping it on the 404 threw the
  // evening's attendance away to save twelve requests an hour.
  for (size_t i = 0U; i < kBaseCount; ++i) {
    for (uint8_t queued = 1U; queued <= 3U; queued = static_cast<uint8_t>(queued + 2U)) {
      Rig rig(kBases[i]);
      rig.queueBoots(queued);
      rig.api.status = 404U;
      rig.runFor(10U * 60U * 1000U);
      TEST_ASSERT_EQUAL_UINT16(queued, rig.queue.size());
      TEST_ASSERT_LESS_OR_EQUAL_UINT32(backoffPostBound(10U * 60U * 1000U), rig.api.posts);

      rig.api.status = 200U; // re-registered by the heartbeat
      rig.runFor(bridgelogic::kEventRetryMaxMs + 1000U);
      TEST_ASSERT_TRUE(rig.queue.empty());
    }
  }
}

void test_the_outcome_table_status_by_status(void) {
  using bridgelogic::EventOutcome;
  TEST_ASSERT_TRUE(bridgelogic::eventOutcome(200U) == EventOutcome::Release);
  TEST_ASSERT_TRUE(bridgelogic::eventOutcome(204U) == EventOutcome::Release);
  TEST_ASSERT_TRUE(bridgelogic::eventOutcome(400U) == EventOutcome::Drop);
  TEST_ASSERT_TRUE(bridgelogic::eventOutcome(413U) == EventOutcome::Drop);
  TEST_ASSERT_TRUE(bridgelogic::eventOutcome(422U) == EventOutcome::Drop);
  const uint16_t kept[] = {0U, 401U, 403U, 404U, 408U, 429U, 500U, 503U};
  for (const uint16_t status : kept) {
    TEST_ASSERT_TRUE_MESSAGE(bridgelogic::eventOutcome(status) == EventOutcome::Keep, "kept status");
  }
}

/// R17 D17-2. A window armed by a refusal just before the radio went away, or
/// before the breaker opened, must not outlive the outage. main.cpp used to
/// return before pumpEventDrain while offline, so DrainPace::ready() — the
/// only thing that disarms an elapsed window — never ran; after more than
/// 2^31 ms the stale deadline read as PENDING again and the drain stalled for
/// up to another 24.8 days with the link back and a healthy server.
///
/// The outages straddle the half-range: a day and just under 2^31 ms are the
/// controls that passed before the fix; 2^31 ms plus a day and 0xF0000000 ms
/// are the two that stalled.
void test_a_window_armed_before_a_long_outage_is_spent_when_the_link_returns(void) {
  const uint32_t outages[] = {kDayMs, 0x7FFFFFFFUL - 1000UL, 0x80000000UL + kDayMs, 0xF0000000UL};
  for (size_t i = 0U; i < kBaseCount; ++i) {
    for (const uint32_t outage : outages) {
      for (uint8_t queued = 1U; queued <= 3U; queued = static_cast<uint8_t>(queued + 2U)) {
        Rig rig(kBases[i]);
        rig.queueBoots(queued);
        rig.api.status = 429U;
        TEST_ASSERT_TRUE(rig.pass()); // refused: the 15 s window is armed
        TEST_ASSERT_EQUAL_UINT32(bridgelogic::kEventRetryStartMs, rig.pace.backoffMs());

        rig.outage(outage);

        // Back online to a healthy server: the window ended long ago, so the
        // very first pass posts — never a pass 24 days later.
        rig.api.status = 200U;
        const uint32_t posts = rig.api.posts;
        TEST_ASSERT_TRUE_MESSAGE(rig.pass(), "the drain stalled after a long outage");
        TEST_ASSERT_EQUAL_UINT32(posts + 1U, rig.api.posts);
        TEST_ASSERT_EQUAL_UINT16(queued - 1U, rig.queue.size());
        TEST_ASSERT_EQUAL_UINT32(0U, rig.pace.backoffMs());
      }
    }
  }
}

/// The other half of the same rule: an outage must not SHORTEN a window that
/// is still running. Offline passes observe the pace; they do not spend it.
void test_a_short_outage_inside_the_window_still_waits_the_window_out(void) {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    Rig rig(kBases[i]);
    rig.queueBoots(2U);
    rig.api.status = 429U;
    TEST_ASSERT_TRUE(rig.pass());
    const uint32_t refusedAt = rig.api.lastPostAt;
    for (uint8_t n = 0U; n < 100U; ++n) {
      TEST_ASSERT_FALSE(rig.pass(false)); // a second of offline passes
    }
    rig.api.status = 200U;
    while (!rig.pass()) {
    }
    TEST_ASSERT_GREATER_OR_EQUAL_UINT32(bridgelogic::kEventRetryStartMs, rig.api.lastPostAt - refusedAt);
    TEST_ASSERT_EQUAL_UINT16(1U, rig.queue.size());
  }
}

/// Offline means NO call, whatever the pace says: the breaker exists so that a
/// dead host does not cost a 4 s connect timeout in front of every scan.
void test_an_offline_pass_never_posts(void) {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    Rig rig(kBases[i]);
    rig.queueBoots(3U);
    for (uint16_t n = 0U; n < 1000U; ++n) {
      TEST_ASSERT_FALSE(rig.pass(false));
    }
    TEST_ASSERT_EQUAL_UINT32(0U, rig.api.posts);
    TEST_ASSERT_EQUAL_UINT16(3U, rig.queue.size());
  }
}

} // namespace

void setUp(void) {
}

void tearDown(void) {
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_a_disabled_box_answered_403_posts_a_paced_handful_not_every_pass);
  RUN_TEST(test_a_rate_limited_box_answered_429_backs_off_rather_than_feeding_the_limit);
  RUN_TEST(test_a_wrong_key_401_and_a_timeout_408_are_paced_the_same_way);
  RUN_TEST(test_a_200_that_acknowledges_nothing_is_paced_like_a_refusal);
  RUN_TEST(test_the_drain_resumes_within_one_window_of_a_200_and_then_runs_at_loop_pace);
  RUN_TEST(test_a_healthy_box_drains_one_event_per_pass_with_no_backoff);
  RUN_TEST(test_a_400_drops_the_head_and_the_next_event_goes_on_the_next_pass);
  RUN_TEST(test_a_404_from_a_deleted_row_keeps_the_event_until_the_box_is_known_again);
  RUN_TEST(test_the_outcome_table_status_by_status);
  RUN_TEST(test_a_window_armed_before_a_long_outage_is_spent_when_the_link_returns);
  RUN_TEST(test_a_short_outage_inside_the_window_still_waits_the_window_out);
  RUN_TEST(test_an_offline_pass_never_posts);
  return UNITY_END();
}

// Unity tests for bridgelogic::planRestore — what a box does about the courts
// a power dip took out.
//
// Its own suite, and the reason is the same one that gave the fault log its
// own: this is the code path that RE-ENERGISES RELAYS UNATTENDED after a power
// event, on a box nobody is standing next to. Everything it refuses to do is
// as load-bearing as everything it does, and both deserve to be read in one
// file rather than found between two hundred other assertions.

#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unity.h>

#include "bridgelogic/RestorePlan.h"
#include "devlink/RelayRestore.h"

namespace {

devlink::RelayRestore entry(uint8_t relay, uint32_t seconds, const char* ref) {
  devlink::RelayRestore e;
  e.relay = relay;
  e.remainingSeconds = seconds;
  snprintf(e.bookingRef, sizeof(e.bookingRef), "%s", ref);
  return e;
}

void test_two_lit_courts_come_back_with_the_time_they_had_left(void) {
  const devlink::RelayRestore in[] = {entry(0U, 1834U, "3fa85f64"), entry(2U, 600U, "9c1d0e22")};
  const bridgelogic::RestorePlan plan = bridgelogic::planRestore(in, 2U, 4U);

  TEST_ASSERT_EQUAL_UINT8(2U, plan.count);
  TEST_ASSERT_EQUAL_UINT8(0U, plan.rejected);

  TEST_ASSERT_EQUAL_UINT8(0U, plan.action[0].court);
  TEST_ASSERT_EQUAL_UINT16(1834U, plan.action[0].seconds);
  TEST_ASSERT_EQUAL_UINT32(1834000UL, plan.action[0].bookingRemainingMs);

  TEST_ASSERT_EQUAL_UINT8(2U, plan.action[1].court);
  TEST_ASSERT_EQUAL_UINT16(600U, plan.action[1].seconds);
}

void test_an_empty_list_switches_nothing_off(void) {
  // It is information that nothing SHOULD be on, which matters only at boot,
  // when nothing IS on. Making it an off-command would hand the API a way to
  // darken a court mid-game, which it must not have — so the plan is empty
  // rather than four releases.
  const bridgelogic::RestorePlan plan = bridgelogic::planRestore(nullptr, 0U, 4U);
  TEST_ASSERT_EQUAL_UINT8(0U, plan.count);
  TEST_ASSERT_EQUAL_UINT8(0U, plan.rejected);

  devlink::RelayRestore none[1];
  const bridgelogic::RestorePlan empty = bridgelogic::planRestore(none, 0U, 4U);
  TEST_ASSERT_EQUAL_UINT8(0U, empty.count);
  TEST_ASSERT_EQUAL_UINT8(0U, empty.rejected);
}

void test_a_relay_this_box_does_not_drive_is_refused_and_counted(void) {
  // A box that has been told about two courts must not light relay 3 because
  // the server thinks it owns four. Counted rather than ignored: the server
  // believing this box owns a court it does not is a configuration fault
  // somebody has to see.
  const devlink::RelayRestore in[] = {entry(0U, 900U, "a"), entry(3U, 900U, "b"), entry(1U, 900U, "c")};
  const bridgelogic::RestorePlan plan = bridgelogic::planRestore(in, 3U, 2U);

  TEST_ASSERT_EQUAL_UINT8(2U, plan.count);
  TEST_ASSERT_EQUAL_UINT8(1U, plan.rejected);
  TEST_ASSERT_EQUAL_UINT8(0U, plan.action[0].court);
  TEST_ASSERT_EQUAL_UINT8(1U, plan.action[1].court);
}

void test_a_box_with_no_court_numbers_yet_lights_nothing(void) {
  // It refuses every walk-up locally rather than selling court zero; it must
  // not light a relay on the same reasoning. This is the state a box is in
  // between boot and its first accepted heartbeat — which is exactly when a
  // restore arrives.
  const devlink::RelayRestore in[] = {entry(0U, 900U, "a")};
  const bridgelogic::RestorePlan plan = bridgelogic::planRestore(in, 1U, 0U);
  TEST_ASSERT_EQUAL_UINT8(0U, plan.count);
  TEST_ASSERT_EQUAL_UINT8(1U, plan.rejected);
}

void test_a_booking_that_ends_now_is_left_dark(void) {
  // Skipped rather than clamped up to the relay minimum: a one-second flash of
  // the lights is a worse answer than leaving them off, and it would queue a
  // release a second later for a session nobody had.
  const devlink::RelayRestore in[] = {entry(1U, 0U, "a"), entry(2U, 30U, "b")};
  const bridgelogic::RestorePlan plan = bridgelogic::planRestore(in, 2U, 4U);
  TEST_ASSERT_EQUAL_UINT8(1U, plan.count);
  TEST_ASSERT_EQUAL_UINT8(2U, plan.action[0].court);
  TEST_ASSERT_EQUAL_UINT8(0U, plan.rejected);
}

void test_the_command_is_capped_and_the_extension_is_not(void) {
  // The two numbers are different on purpose. One `!ON` can buy at most ninety
  // minutes, so that is what the frame carries; the EXTENSION has to know the
  // booking really has two hours left, or the court goes dark at minute ninety
  // with the bridge convinced it had nothing to do.
  const devlink::RelayRestore in[] = {entry(0U, 7200U, "a")};
  const bridgelogic::RestorePlan plan = bridgelogic::planRestore(in, 1U, 4U);

  TEST_ASSERT_EQUAL_UINT8(1U, plan.count);
  TEST_ASSERT_EQUAL_UINT16(proto::kRelayHardCapSeconds, plan.action[0].seconds);
  TEST_ASSERT_EQUAL_UINT32(7200000UL, plan.action[0].bookingRemainingMs);
}

void test_an_absurd_remainder_saturates_rather_than_truncating(void) {
  // Sixteen bits of four billion seconds is a small plausible number, and a
  // small plausible number is acted on rather than questioned.
  const devlink::RelayRestore in[] = {entry(0U, 0xFFFFFFFFUL, "a")};
  const bridgelogic::RestorePlan plan = bridgelogic::planRestore(in, 1U, 4U);
  TEST_ASSERT_EQUAL_UINT16(proto::kRelayHardCapSeconds, plan.action[0].seconds);
  TEST_ASSERT_EQUAL_UINT32(UINT32_MAX, plan.action[0].bookingRemainingMs);
}

void test_more_entries_than_this_box_has_relays_are_counted_not_dropped_silently(void) {
  const devlink::RelayRestore in[] = {entry(0U, 60U, "a"), entry(1U, 60U, "b"), entry(2U, 60U, "c"),
                                      entry(3U, 60U, "d"), entry(0U, 60U, "e")};
  const bridgelogic::RestorePlan plan = bridgelogic::planRestore(in, 5U, 4U);
  TEST_ASSERT_EQUAL_UINT8(4U, plan.count);
  TEST_ASSERT_EQUAL_UINT8(1U, plan.rejected);
}

void test_the_whole_contract_vector_end_to_end(void) {
  // The mixed-malformed shape the wire contract pins: two bad elements and one
  // good one. The parser skips and counts the bad; the plan acts on the good.
  // One bad booking must not blank the evening's other fifteen.
  const char* body = "{\"relays\":[\"9|100|x\",\"0|abc|y\",\"1|500|z\"]}";
  devlink::RelayRestore parsed[4];
  uint8_t count = 0U;
  uint8_t rejected = 0U;
  TEST_ASSERT_TRUE(devlink::parseRelayRestore(body, strlen(body), parsed, 4U, count, &rejected));
  TEST_ASSERT_EQUAL_UINT8(1U, count);
  TEST_ASSERT_EQUAL_UINT8(2U, rejected);

  const bridgelogic::RestorePlan plan = bridgelogic::planRestore(parsed, count, 4U);
  TEST_ASSERT_EQUAL_UINT8(1U, plan.count);
  TEST_ASSERT_EQUAL_UINT8(1U, plan.action[0].court);
  TEST_ASSERT_EQUAL_UINT16(500U, plan.action[0].seconds);
}

} // namespace

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_two_lit_courts_come_back_with_the_time_they_had_left);
  RUN_TEST(test_an_empty_list_switches_nothing_off);
  RUN_TEST(test_a_relay_this_box_does_not_drive_is_refused_and_counted);
  RUN_TEST(test_a_box_with_no_court_numbers_yet_lights_nothing);
  RUN_TEST(test_a_booking_that_ends_now_is_left_dark);
  RUN_TEST(test_the_command_is_capped_and_the_extension_is_not);
  RUN_TEST(test_an_absurd_remainder_saturates_rather_than_truncating);
  RUN_TEST(test_more_entries_than_this_box_has_relays_are_counted_not_dropped_silently);
  RUN_TEST(test_the_whole_contract_vector_end_to_end);
  return UNITY_END();
}

// Unity tests for lib/bridgelogic: the decisions that used to live in the ESP's
// composition root, where `pio test` could not reach them.
//
// WHY THIS SUITE EXISTS
// ---------------------
// Every one of these was a review finding against main.cpp — a roster nothing
// filled (C2), a scan path with no online branch (C3), a court that was always
// the caller's guess (C4), a walk-up that named no court (C5), a `!STATE` read
// "for diagnostics only" (A2-6). None of them had a test because none of the
// logic was in lib/. It is now, and this is the suite that keeps it there.
//
// The bodies below are INLINE fixtures shaped by the wire contract. Binding
// them to the shared corpus is a follow-up; the shapes here are the contract's.
//
// The clock bases are the same matrix the other suites use: millis() wraps at
// 49.7 days and a court box in a cupboard runs for months, so every age and
// duration assertion is run at a base that puts the wrap inside the scenario.

#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unity.h>

#include "bridgelogic/RosterSync.h"
#include "bridgelogic/ScanFlow.h"
#include "bridgelogic/StateReconcile.h"
#include "bridgelogic/WalkUp.h"
#include "court/Session.h"
#include "devapi/DeviceClient.h"
#include "eventq/EventQueue.h"
#include "fakes/FakeStore.h"
#include "roster/Roster.h"

namespace {

constexpr uint32_t kBaseZero = 0U;
constexpr uint32_t kBaseMid = 1234567U;
constexpr uint32_t kBaseWrapSoon = 0xFFFFF000U;
constexpr uint32_t kBaseWrapNow = 0xFFFFFFFFU;

constexpr uint32_t kBases[] = {kBaseZero, kBaseMid, kBaseWrapSoon, kBaseWrapNow};
constexpr size_t kBaseCount = sizeof(kBases) / sizeof(kBases[0]);

constexpr uint32_t kSixHoursMs = 21600000UL;
constexpr uint32_t kHourMs = 3600000UL;

using Cache = roster::Roster<bridgelogic::kMaxRosterEntries>;
using Queue = eventq::EventQueue<4U>;
using Play = court::Session<Cache, Queue>;

/// This box drives club courts 7, 8, 9 and 10 on relays A, B, C and D.
const int16_t kCourts[bridgelogic::kMaxCourts] = {7, 8, 9, 10};
constexpr uint8_t kCourtCount = 4U;

size_t len(const char* s) {
  return strlen(s);
}

roster::Entry booking(const char* token, uint8_t court, uint32_t opensAt, uint32_t closesAt) {
  roster::Entry entry;
  static_cast<void>(roster::detail::copyToken(entry.token, sizeof(entry.token), token));
  entry.court = court;
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

/// Deterministic bytes, so a nonce can be asserted byte for byte.
class ScriptedEntropy final : public devapi::IEntropySource {
public:
  explicit ScriptedEntropy(uint8_t seed = 0U) : next_(seed) {}

  uint8_t nextByte() override { return next_++; }

private:
  uint8_t next_;
};

// ---------------------------------------------------------------------------
// RosterSync — one element
// ---------------------------------------------------------------------------

void test_roster_element_parses_the_four_fields() {
  roster::Entry e;
  TEST_ASSERT_TRUE(bridgelogic::parseRosterElement("4T8Y2K9QW3ZM|2|600|3300", e));
  TEST_ASSERT_EQUAL_STRING("4T8Y2K9QW3ZM", e.token);
  TEST_ASSERT_EQUAL_UINT8(2U, e.court);
  TEST_ASSERT_EQUAL_UINT32(600000UL, e.opensAtMs);
  TEST_ASSERT_EQUAL_UINT32(3300000UL, e.closesAtMs);
  TEST_ASSERT_EQUAL_UINT32(2700000UL, e.durationMs);
  TEST_ASSERT_TRUE(e.valid);
}

void test_roster_element_refuses_a_token_longer_than_the_cap() {
  // Exactly the cap fits; one more is refused, never truncated — a truncated
  // token matches a different member.
  roster::Entry e;
  TEST_ASSERT_TRUE(bridgelogic::parseRosterElement("ABCDEFGHJKMNPQRSTVWX|0|0|60", e));
  TEST_ASSERT_EQUAL_UINT8(20U, static_cast<uint8_t>(strlen(e.token)));

  roster::Entry untouched;
  TEST_ASSERT_FALSE(bridgelogic::parseRosterElement("ABCDEFGHJKMNPQRSTVWXY|0|0|60", untouched));
  TEST_ASSERT_EQUAL_STRING("", untouched.token);
  TEST_ASSERT_FALSE(untouched.valid);
}

void test_roster_element_refuses_a_token_outside_the_alphabet() {
  roster::Entry e;
  TEST_ASSERT_FALSE(bridgelogic::parseRosterElement("4T8Y 2K9Q|0|0|60", e));
  TEST_ASSERT_FALSE(bridgelogic::parseRosterElement("4T8Y\"2K9Q|0|0|60", e));
  TEST_ASSERT_FALSE(bridgelogic::parseRosterElement("4T8Y,2K9Q|0|0|60", e));
  TEST_ASSERT_FALSE(bridgelogic::parseRosterElement("|0|0|60", e)); // empty
  // The tolerated extras: lowercase, dash, underscore.
  TEST_ASSERT_TRUE(bridgelogic::parseRosterElement("tok-alice_1|0|0|60", e));
}

void test_roster_element_refuses_a_relay_this_box_does_not_have() {
  roster::Entry e;
  TEST_ASSERT_FALSE(bridgelogic::parseRosterElement("TOKEN|4|0|60", e));
  TEST_ASSERT_FALSE(bridgelogic::parseRosterElement("TOKEN|A|0|60", e));
  TEST_ASSERT_FALSE(bridgelogic::parseRosterElement("TOKEN||0|60", e));
  TEST_ASSERT_FALSE(bridgelogic::parseRosterElement("TOKEN|03|0|60", e));
  TEST_ASSERT_TRUE(bridgelogic::parseRosterElement("TOKEN|3|0|60", e));
  TEST_ASSERT_EQUAL_UINT8(3U, e.court);
}

void test_roster_element_refuses_a_missing_or_extra_field() {
  roster::Entry e;
  TEST_ASSERT_FALSE(bridgelogic::parseRosterElement("TOKEN|1|0", e));
  TEST_ASSERT_FALSE(bridgelogic::parseRosterElement("TOKEN|1|0|60|x", e));
  TEST_ASSERT_FALSE(bridgelogic::parseRosterElement("TOKEN|1|0|", e)); // empty closes_in
  TEST_ASSERT_FALSE(bridgelogic::parseRosterElement("", e));
  TEST_ASSERT_FALSE(bridgelogic::parseRosterElement(nullptr, e));
}

void test_roster_element_refuses_seconds_whose_milliseconds_would_not_fit() {
  roster::Entry e;
  // 4294967 s is the last value whose ms fits a uint32_t; 4294968 wraps.
  TEST_ASSERT_TRUE(bridgelogic::parseRosterElement("TOKEN|1|0|4294967", e));
  TEST_ASSERT_FALSE(bridgelogic::parseRosterElement("TOKEN|1|0|4294968", e));
  TEST_ASSERT_FALSE(bridgelogic::parseRosterElement("TOKEN|1|4294968|4294968", e));
  TEST_ASSERT_FALSE(bridgelogic::parseRosterElement("TOKEN|1|0|99999999999999999999", e));
  // Not digits at all.
  TEST_ASSERT_FALSE(bridgelogic::parseRosterElement("TOKEN|1|0|6e2", e));
  TEST_ASSERT_FALSE(bridgelogic::parseRosterElement("TOKEN|1|0| 60", e));
  // Ends before it starts.
  TEST_ASSERT_FALSE(bridgelogic::parseRosterElement("TOKEN|1|600|300", e));
}

void test_roster_element_clamps_an_already_open_window_to_now() {
  roster::Entry e;
  TEST_ASSERT_TRUE(bridgelogic::parseRosterElement("TOKEN|1|-420|2280", e));
  TEST_ASSERT_EQUAL_UINT32(0U, e.opensAtMs);
  TEST_ASSERT_EQUAL_UINT32(2280000UL, e.closesAtMs);
  TEST_ASSERT_EQUAL_UINT32(2280000UL, e.durationMs);
  // A sign with nothing behind it is malformed, not "very open".
  TEST_ASSERT_FALSE(bridgelogic::parseRosterElement("TOKEN|1|-|60", e));
  TEST_ASSERT_FALSE(bridgelogic::parseRosterElement("TOKEN|1|-x|60", e));
}

// ---------------------------------------------------------------------------
// RosterSync — the whole heartbeat
// ---------------------------------------------------------------------------

void test_apply_roster_an_absent_key_leaves_the_roster_untouched_and_serving() {
  Cache cache(kSixHoursMs);
  const roster::Entry entries[] = {booking("TOKALICE", 1U, 0U, kHourMs)};
  loadRoster(cache, kBaseMid, entries, 1U);

  // An older API, or a heartbeat that carries only the button map.
  const char body[] = "{\"server_unix\":1750000000,\"court_numbers\":[7,8],\"config\":{\"button_map\":[]}}";
  const bridgelogic::SyncResult r = bridgelogic::applyRoster(body, len(body), cache, kBaseMid + 30000U);

  TEST_ASSERT_FALSE(r.replaced);
  TEST_ASSERT_EQUAL_UINT8(1U, cache.size());
  TEST_ASSERT_TRUE(cache.decide("TOKALICE", 1U, kBaseMid + 60000U).verdict == roster::Verdict::Allow);
  // ...and its age is still measured from the load, not the non-push.
  TEST_ASSERT_EQUAL_UINT32(60000U, cache.ageMs(kBaseMid + 60000U));
}

void test_apply_roster_an_empty_array_commits_an_empty_roster() {
  Cache cache(kSixHoursMs);
  const roster::Entry entries[] = {booking("TOKALICE", 1U, 0U, kHourMs)};
  loadRoster(cache, kBaseMid, entries, 1U);

  // Everything was cancelled. Absence is how a cancellation is expressed, so
  // "no bookings" must replace the cache, not be mistaken for "no push".
  const char body[] = "{\"roster\":[]}";
  const bridgelogic::SyncResult r = bridgelogic::applyRoster(body, len(body), cache, kBaseMid + 30000U);

  TEST_ASSERT_TRUE(r.replaced);
  TEST_ASSERT_EQUAL_UINT8(0U, cache.size());
  TEST_ASSERT_TRUE(cache.everLoaded());
  TEST_ASSERT_TRUE(cache.decide("TOKALICE", 1U, kBaseMid + 60000U).verdict == roster::Verdict::Unknown);
}

void test_apply_roster_fills_the_cache_from_the_wire_shape() {
  Cache cache(kSixHoursMs);
  const char body[] = "{\"server_unix\":1750000000,\"heartbeat_seconds\":30,"
                      "\"court_numbers\":[7,8,9,10],"
                      "\"roster\":[\"TOKALICE|1|-60|2640\",\"TOKBOB|3|900|3600\"],"
                      "\"config\":{\"button_map\":[\"court:A\"]}}";
  const bridgelogic::SyncResult r = bridgelogic::applyRoster(body, len(body), cache, kBaseMid);

  TEST_ASSERT_TRUE(r.replaced);
  TEST_ASSERT_EQUAL_UINT8(2U, r.accepted);
  TEST_ASSERT_EQUAL_UINT8(0U, r.rejected);
  TEST_ASSERT_EQUAL_UINT8(2U, cache.size());

  const roster::Decision alice = cache.decide("TOKALICE", 1U, kBaseMid + 1000U);
  TEST_ASSERT_TRUE(alice.verdict == roster::Verdict::Allow);
  TEST_ASSERT_TRUE(cache.decide("TOKBOB", 3U, kBaseMid + 1000U).verdict == roster::Verdict::TooEarly);
  TEST_ASSERT_TRUE(cache.decide("TOKBOB", 3U, kBaseMid + 1000000U).verdict == roster::Verdict::Allow);
}

void test_apply_roster_keeps_the_contracts_sixteen_and_reports_the_rest() {
  Cache cache(kSixHoursMs); // capacity 16, the contract cap
  char body[1024] = "{\"roster\":[";
  size_t at = strlen(body);
  for (int i = 0; i < 17; ++i) {
    at += static_cast<size_t>(
        snprintf(body + at, sizeof(body) - at, "%s\"TOK%02d|0|0|3600\"", i == 0 ? "" : ",", i));
  }
  snprintf(body + at, sizeof(body) - at, "]}");

  const bridgelogic::SyncResult r = bridgelogic::applyRoster(body, len(body), cache, kBaseMid);
  TEST_ASSERT_TRUE(r.replaced);
  TEST_ASSERT_EQUAL_UINT8(16U, r.accepted);
  TEST_ASSERT_EQUAL_UINT8(16U, cache.size());
  // Silently dropping the seventeenth would refuse a real member with no
  // explanation; the count is how an admin learns the contract was exceeded.
  TEST_ASSERT_EQUAL_UINT8(1U, r.dropped);
  TEST_ASSERT_EQUAL_UINT8(1U, cache.dropped());
}

void test_apply_roster_one_bad_element_does_not_cost_the_good_ones() {
  Cache cache(kSixHoursMs);
  const char body[] = "{\"roster\":[\"TOKALICE|1|0|3600\",\"BROKEN|9|0|3600\",\"TOKBOB|2|0|3600\","
                      "\"a token with spaces|0|0|60\",\"TOKCARA|3|0|3600\"]}";
  const bridgelogic::SyncResult r = bridgelogic::applyRoster(body, len(body), cache, kBaseMid);

  TEST_ASSERT_TRUE(r.replaced);
  TEST_ASSERT_EQUAL_UINT8(3U, r.accepted);
  TEST_ASSERT_EQUAL_UINT8(2U, r.rejected);
  TEST_ASSERT_TRUE(cache.decide("TOKALICE", 1U, kBaseMid + 1U).verdict == roster::Verdict::Allow);
  TEST_ASSERT_TRUE(cache.decide("TOKBOB", 2U, kBaseMid + 1U).verdict == roster::Verdict::Allow);
  TEST_ASSERT_TRUE(cache.decide("TOKCARA", 3U, kBaseMid + 1U).verdict == roster::Verdict::Allow);
  TEST_ASSERT_TRUE(cache.decide("BROKEN", 0U, kBaseMid + 1U).verdict == roster::Verdict::Unknown);
}

void test_apply_roster_every_accepted_heartbeat_resets_staleness_across_the_wrap() {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    Cache cache(kSixHoursMs);
    const roster::Entry entries[] = {booking("TOKALICE", 1U, 0U, 86400000UL)};
    loadRoster(cache, base, entries, 1U);

    // Five hours in — an hour from stale — a heartbeat re-pushes the same entry.
    const uint32_t refreshAt = base + 5U * kHourMs;
    const char body[] = "{\"roster\":[\"TOKALICE|1|0|68400\"]}";
    TEST_ASSERT_TRUE(bridgelogic::applyRoster(body, len(body), cache, refreshAt).replaced);

    // Two hours after THAT — seven after the original load, which would have
    // been stale — the roster is two hours old and still serves. Only an offline
    // box ever reaches ROSTER_MAX_AGE_MS.
    const uint32_t later = refreshAt + 2U * kHourMs;
    TEST_ASSERT_FALSE(cache.stale(later));
    TEST_ASSERT_EQUAL_UINT32(2U * kHourMs, cache.ageMs(later));
    TEST_ASSERT_TRUE(cache.decide("TOKALICE", 1U, later).verdict == roster::Verdict::Allow);
  }
}

void test_a_late_arrival_is_granted_what_is_left_not_what_was_booked() {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    Cache cache(kSixHoursMs);
    fakes::FakeStore store;
    Queue queue(&store);
    queue.begin();
    Play play(cache, queue);

    // A 45-minute slot, open now.
    const char body[] = "{\"roster\":[\"TOKALICE|2|0|2700\"]}";
    TEST_ASSERT_TRUE(bridgelogic::applyRoster(body, len(body), cache, base).replaced);

    // Twenty minutes late. The lights come on for the 25 that remain: the next
    // booking's start does not move because this member was late.
    const uint32_t scanAt = base + 1200000UL;
    const roster::Decision d = cache.decide("TOKALICE", roster::CourtCount(kCourtCount), scanAt);
    TEST_ASSERT_TRUE(d.verdict == roster::Verdict::Allow);
    TEST_ASSERT_EQUAL_UINT32(1500000UL, d.grantMs);
    TEST_ASSERT_EQUAL_UINT32(2700000UL, d.entry.durationMs); // the booking itself is unchanged

    const court::Outcome out =
        play.onScan("TOKALICE", roster::CourtCount(kCourtCount), eventq::Method::Qr, scanAt);
    TEST_ASSERT_TRUE(out.action == court::Action::TurnOn);
    TEST_ASSERT_EQUAL_UINT32(1500000UL, out.durationMs);
    TEST_ASSERT_EQUAL_STRING("COURT C", out.line1);
    TEST_ASSERT_EQUAL_STRING("25 MIN", out.line2);

    eventq::Event queued;
    TEST_ASSERT_TRUE(queue.peek(queued));
    TEST_ASSERT_EQUAL_UINT32(1500000UL, queued.durationMs);
  }
}

void test_a_grant_never_exceeds_the_relay_cap() {
  Cache cache(kSixHoursMs);
  fakes::FakeStore store;
  Queue queue(&store);
  queue.begin();
  Play play(cache, queue);

  // A three-hour booking. The Mega will release at ninety minutes whatever the
  // wire says, so the screen and the event must say ninety too (review M1).
  const char body[] = "{\"roster\":[\"TOKALICE|0|0|10800\"]}";
  TEST_ASSERT_TRUE(bridgelogic::applyRoster(body, len(body), cache, kBaseMid).replaced);

  const court::Outcome out =
      play.onScan("TOKALICE", roster::CourtCount(kCourtCount), eventq::Method::Qr, kBaseMid + 1U);
  TEST_ASSERT_TRUE(out.action == court::Action::TurnOn);
  TEST_ASSERT_EQUAL_UINT32(court::kMaxGrantMs, out.durationMs);
  TEST_ASSERT_EQUAL_STRING("90 MIN", out.line2);
}

void test_court_numbers_are_read_by_relay_position() {
  int16_t courts[bridgelogic::kMaxCourts] = {-1, -1, -1, -1};
  uint8_t count = 99U;

  const char three[] = "{\"court_numbers\":[7, 8,9],\"roster\":[]}";
  TEST_ASSERT_TRUE(bridgelogic::parseCourtNumbers(three, len(three), courts, count));
  TEST_ASSERT_EQUAL_UINT8(3U, count);
  TEST_ASSERT_EQUAL_INT16(7, courts[0]);
  TEST_ASSERT_EQUAL_INT16(8, courts[1]);
  TEST_ASSERT_EQUAL_INT16(9, courts[2]);
  TEST_ASSERT_EQUAL_INT16(0, courts[3]);

  const char none[] = "{\"court_numbers\":[]}";
  TEST_ASSERT_TRUE(bridgelogic::parseCourtNumbers(none, len(none), courts, count));
  TEST_ASSERT_EQUAL_UINT8(0U, count);
}

void test_court_numbers_that_cannot_be_a_court_set_leave_the_previous_one_alone() {
  int16_t courts[bridgelogic::kMaxCourts] = {7, 8, 9, 10};
  uint8_t count = 4U;

  const char absent[] = "{\"roster\":[]}";
  TEST_ASSERT_FALSE(bridgelogic::parseCourtNumbers(absent, len(absent), courts, count));

  // Five courts for four relays: which four? Nobody should guess.
  const char five[] = "{\"court_numbers\":[1,2,3,4,5]}";
  TEST_ASSERT_FALSE(bridgelogic::parseCourtNumbers(five, len(five), courts, count));

  const char notNumbers[] = "{\"court_numbers\":[\"A\",\"B\"]}";
  TEST_ASSERT_FALSE(bridgelogic::parseCourtNumbers(notNumbers, len(notNumbers), courts, count));

  const char notArray[] = "{\"court_numbers\":7}";
  TEST_ASSERT_FALSE(bridgelogic::parseCourtNumbers(notArray, len(notArray), courts, count));

  const char huge[] = "{\"court_numbers\":[70000]}";
  TEST_ASSERT_FALSE(bridgelogic::parseCourtNumbers(huge, len(huge), courts, count));

  TEST_ASSERT_EQUAL_UINT8(4U, count);
  TEST_ASSERT_EQUAL_INT16(10, courts[3]);
}

// ---------------------------------------------------------------------------
// Roster — the shared-scanner decide, and the C4 pin on Session
// ---------------------------------------------------------------------------

void test_roster_decides_for_a_shared_scanner_by_court_count() {
  Cache cache(kSixHoursMs);
  const roster::Entry entries[] = {booking("TOKALICE", 2U, 0U, kHourMs)};
  loadRoster(cache, kBaseMid, entries, 1U);

  // Relay C exists on a three-court box...
  const roster::Decision three = cache.decide("TOKALICE", roster::CourtCount(3U), kBaseMid + 1U);
  TEST_ASSERT_TRUE(three.verdict == roster::Verdict::Allow);
  TEST_ASSERT_EQUAL_UINT8(2U, three.entry.court);

  // ...and not on a two-court one. The booking is real; this box cannot serve it.
  const roster::Decision two = cache.decide("TOKALICE", roster::CourtCount(2U), kBaseMid + 1U);
  TEST_ASSERT_TRUE(two.verdict == roster::Verdict::WrongCourt);
  TEST_ASSERT_EQUAL_UINT8(2U, two.entry.court);
}

void test_session_lights_the_court_the_booking_names_not_the_one_it_was_handed() {
  // THE C4 PIN. Session used to overwrite outcome.court with the caller's court
  // after every decision, so on a one-scanner box every activation went to
  // whichever relay the caller guessed — structurally at most one of four.
  Cache cache(kSixHoursMs);
  fakes::FakeStore store;
  Queue queue(&store);
  queue.begin();
  Play play(cache, queue);

  const roster::Entry entries[] = {booking("TOKALICE", 2U, 0U, kHourMs)};
  loadRoster(cache, kBaseMid, entries, 1U);

  const court::Outcome out =
      play.onScan("TOKALICE", roster::CourtCount(kCourtCount), eventq::Method::Qr, kBaseMid + 1U);
  TEST_ASSERT_TRUE(out.action == court::Action::TurnOn);
  TEST_ASSERT_EQUAL_UINT8(2U, out.court);
  TEST_ASSERT_EQUAL_STRING("COURT C", out.line1);

  // The event the club sees names the same court.
  eventq::Event queued;
  TEST_ASSERT_TRUE(queue.peek(queued));
  TEST_ASSERT_EQUAL_UINT8(2U, queued.court);
}

void test_session_a_refusal_that_matched_a_booking_carries_that_bookings_court() {
  Cache cache(kSixHoursMs);
  fakes::FakeStore store;
  Queue queue(&store);
  queue.begin();
  Play play(cache, queue);

  const roster::Entry entries[] = {booking("TOKALICE", 1U, 600000UL, kHourMs)};
  loadRoster(cache, kBaseMid, entries, 1U);

  // Per-court overload, scanning at D for a booking on B: the outcome names B,
  // where the member should go, not D, where they are.
  const court::Outcome wrong = play.onScan("TOKALICE", 3U, eventq::Method::Qr, kBaseMid + 700000UL);
  TEST_ASSERT_TRUE(wrong.action == court::Action::Refuse);
  TEST_ASSERT_EQUAL_UINT8(1U, wrong.court);

  // Shared scanner, too early: still B.
  const court::Outcome early =
      play.onScan("TOKALICE", roster::CourtCount(kCourtCount), eventq::Method::Qr, kBaseMid + 1U);
  TEST_ASSERT_EQUAL_STRING("TOO EARLY", early.line1);
  TEST_ASSERT_EQUAL_UINT8(1U, early.court);

  // Nothing matched on a shared scanner: no court to attribute it to.
  const court::Outcome unknown =
      play.onScan("NOBODY", roster::CourtCount(kCourtCount), eventq::Method::Qr, kBaseMid + 1U);
  TEST_ASSERT_EQUAL_UINT8(eventq::Event::kNoCourt, unknown.court);
}

// ---------------------------------------------------------------------------
// ScanFlow — which path, and what the API's answer means
// ---------------------------------------------------------------------------

bridgelogic::LinkState link(bool provisioned, bool wifiUp, bool clockKnown) {
  bridgelogic::LinkState l;
  l.provisioned = provisioned;
  l.wifiUp = wifiUp;
  l.clockKnown = clockKnown;
  return l;
}

void test_scan_flow_asks_the_api_only_when_a_signed_call_can_succeed() {
  const bridgelogic::ScanFlow flow;
  TEST_ASSERT_TRUE(flow.onScan(link(true, true, true)) == bridgelogic::Attempt::Online);
  // Offline: the roster's scan, in microseconds, as before.
  TEST_ASSERT_TRUE(flow.onScan(link(true, false, true)) == bridgelogic::Attempt::RosterOnly);
  // No clock: sign() would refuse, and a probe's 401 is not a decision.
  TEST_ASSERT_TRUE(flow.onScan(link(true, true, false)) == bridgelogic::Attempt::RosterOnly);
  // Not provisioned: nothing to sign with.
  TEST_ASSERT_TRUE(flow.onScan(link(false, true, true)) == bridgelogic::Attempt::RosterOnly);
}

void test_scan_flow_a_grant_lights_the_relay_the_court_number_maps_to() {
  const bridgelogic::ScanFlow flow;
  const char body[] = "{\"activated\":true,\"reason\":\"ok\",\"court_number\":9,\"booking_id\":\"b1\","
                      "\"granted_seconds\":2700,\"server_unix\":1750000000}";
  const bridgelogic::ActivationResult r =
      flow.onActivateResponse(200U, body, len(body), kCourts, kCourtCount);

  TEST_ASSERT_FALSE(r.fallbackToRoster);
  TEST_ASSERT_TRUE(r.disarmAuth);
  TEST_ASSERT_TRUE(r.outcome.action == court::Action::TurnOn);
  TEST_ASSERT_EQUAL_UINT8(2U, r.outcome.court); // court 9 is relay C
  TEST_ASSERT_EQUAL_UINT32(2700000UL, r.outcome.durationMs);
  TEST_ASSERT_EQUAL_STRING("COURT C", r.outcome.line1);
  TEST_ASSERT_EQUAL_STRING("45 MIN", r.outcome.line2);
  // Nothing queued: the API recorded this itself.
  TEST_ASSERT_EQUAL_UINT32(0U, r.outcome.eventSeq);
}

void test_scan_flow_display_clamps_a_grant_past_the_relay_cap() {
  const bridgelogic::ScanFlow flow;
  const char body[] = "{\"activated\":true,\"reason\":\"ok\",\"court_number\":7,\"granted_seconds\":14400}";
  const bridgelogic::ActivationResult r =
      flow.onActivateResponse(200U, body, len(body), kCourts, kCourtCount);

  TEST_ASSERT_TRUE(r.outcome.action == court::Action::TurnOn);
  TEST_ASSERT_EQUAL_UINT32(5400000UL, r.outcome.durationMs);
  TEST_ASSERT_EQUAL_STRING("90 MIN", r.outcome.line2);
}

void test_scan_flow_a_grant_with_no_seconds_in_it_is_no_decision() {
  const bridgelogic::ScanFlow flow;
  const char body[] = "{\"activated\":true,\"reason\":\"ok\",\"court_number\":7}";
  TEST_ASSERT_TRUE(flow.onActivateResponse(200U, body, len(body), kCourts, kCourtCount).fallbackToRoster);

  const char noFlag[] = "{\"reason\":\"ok\",\"court_number\":7,\"granted_seconds\":600}";
  TEST_ASSERT_TRUE(flow.onActivateResponse(200U, noFlag, len(noFlag), kCourts, kCourtCount).fallbackToRoster);

  const char quoted[] = "{\"activated\":\"true\",\"court_number\":7,\"granted_seconds\":600}";
  TEST_ASSERT_TRUE(flow.onActivateResponse(200U, quoted, len(quoted), kCourts, kCourtCount).fallbackToRoster);
}

void test_scan_flow_a_grant_on_a_court_this_box_does_not_drive_is_refused_not_retried() {
  const bridgelogic::ScanFlow flow;
  const char body[] = "{\"activated\":true,\"reason\":\"ok\",\"court_number\":42,\"granted_seconds\":2700}";
  const bridgelogic::ActivationResult r =
      flow.onActivateResponse(200U, body, len(body), kCourts, kCourtCount);

  // The API already recorded an activation. Asking the roster to light a second
  // court would be two activations for one scan; the desk untangles this one.
  TEST_ASSERT_FALSE(r.fallbackToRoster);
  TEST_ASSERT_FALSE(r.disarmAuth);
  TEST_ASSERT_TRUE(r.outcome.action == court::Action::Refuse);
  TEST_ASSERT_EQUAL_STRING("SEE THE DESK", r.outcome.line1);

  const char noCourt[] = "{\"activated\":true,\"reason\":\"ok\",\"granted_seconds\":2700}";
  const bridgelogic::ActivationResult r2 =
      flow.onActivateResponse(200U, noCourt, len(noCourt), kCourts, kCourtCount);
  TEST_ASSERT_FALSE(r2.fallbackToRoster);
  TEST_ASSERT_TRUE(r2.outcome.action == court::Action::Refuse);
}

void test_scan_flow_a_refusal_is_a_decision_the_roster_does_not_second_guess() {
  // The no-second-guess test. A refused member who then got the lights from a
  // stale cache is exactly the cancelled-booking-still-lights-a-court failure
  // the whole online path exists to prevent.
  const bridgelogic::ScanFlow flow;

  struct Case {
    const char* body;
    const char* line1;
    const char* line2;
  };

  const Case cases[] = {
      {"{\"activated\":false,\"reason\":\"no_booking\"}", "NO BOOKING", "SEE THE DESK"},
      {"{\"activated\":false,\"reason\":\"insufficient_balance\"}", "TOO FEW CREDITS", "TOP UP & RETRY"},
      {"{\"activated\":false,\"reason\":\"wrong_court\",\"court_number\":42}", "WRONG COURT", "SEE THE DESK"},
      {"{\"activated\":false,\"reason\":\"not_recognised\"}", "NOT RECOGNISED", "SEE THE DESK"},
      {"{\"activated\":false,\"reason\":\"not_chargeable\"}", "SEE THE DESK", ""},
      {"{\"activated\":false,\"reason\":\"too_early\",\"starts_in_seconds\":900}", "TOO EARLY",
       "WAIT 15 MIN"},
      {"{\"activated\":false,\"reason\":\"too_early\"}", "TOO EARLY", "SEE THE DESK"},
      {"{\"activated\":false,\"reason\":\"something_newer\"}", "SEE THE DESK", ""},
      {"{\"activated\":false}", "SEE THE DESK", ""},
  };
  for (const Case& c : cases) {
    const bridgelogic::ActivationResult r =
        flow.onActivateResponse(200U, c.body, len(c.body), kCourts, kCourtCount);
    TEST_ASSERT_FALSE_MESSAGE(r.fallbackToRoster, c.body);
    TEST_ASSERT_FALSE_MESSAGE(r.disarmAuth, c.body);
    TEST_ASSERT_TRUE_MESSAGE(r.outcome.action == court::Action::Refuse, c.body);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.line1, r.outcome.line1, c.body);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.line2, r.outcome.line2, c.body);
    TEST_ASSERT_TRUE(strlen(r.outcome.line1) <= court::kLineLen);
    TEST_ASSERT_TRUE(strlen(r.outcome.line2) <= court::kLineLen);
  }
}

void test_scan_flow_no_answer_is_the_rosters_scan() {
  const bridgelogic::ScanFlow flow;
  const char body[] = "{\"error\":\"whatever\"}";
  const uint16_t statuses[] = {0U, 401U, 429U, 500U, 502U, 503U, 400U, 404U};
  for (const uint16_t status : statuses) {
    const bridgelogic::ActivationResult r =
        flow.onActivateResponse(status, body, len(body), kCourts, kCourtCount);
    TEST_ASSERT_TRUE_MESSAGE(r.fallbackToRoster, "only a 200 carries a decision");
    TEST_ASSERT_FALSE(r.disarmAuth);
  }
  TEST_ASSERT_TRUE(flow.onActivateResponse(200U, nullptr, 0U, kCourts, kCourtCount).fallbackToRoster);
}

void test_scan_flow_renders_the_activate_body() {
  char body[96] = {};
  TEST_ASSERT_TRUE(bridgelogic::renderActivateBody(body, sizeof(body), "4T8Y2K9QW3ZM") > 0U);
  TEST_ASSERT_EQUAL_STRING("{\"method\":\"qr\",\"token\":\"4T8Y2K9QW3ZM\"}", body);

  char tiny[16] = {};
  TEST_ASSERT_EQUAL_size_t(0U, bridgelogic::renderActivateBody(tiny, sizeof(tiny), "4T8Y2K9QW3ZM"));
  TEST_ASSERT_EQUAL_STRING("", tiny);
}

void test_display_minutes_never_promise_more_than_the_relay_gives() {
  TEST_ASSERT_EQUAL_UINT32(15U, bridgelogic::displayMinutes(15U));
  TEST_ASSERT_EQUAL_UINT32(90U, bridgelogic::displayMinutes(90U));
  TEST_ASSERT_EQUAL_UINT32(90U, bridgelogic::displayMinutes(91U));
  TEST_ASSERT_EQUAL_UINT32(90U, bridgelogic::displayMinutes(240U));
  TEST_ASSERT_EQUAL_UINT32(0U, bridgelogic::displayMinutes(0U));
}

// ---------------------------------------------------------------------------
// WalkUp — the request on the wire, the nonce, and the answer
// ---------------------------------------------------------------------------

void test_walkup_body_names_the_court_and_carries_the_nonce() {
  court::WalkUpIntent intent;
  intent.court = 1U; // relay B
  intent.minutes = 45U;

  char body[320] = {};
  TEST_ASSERT_TRUE(bridgelogic::renderWalkUpBody(body, sizeof(body), intent, kCourts[intent.court],
                                                 "4T8Y2K9QW3ZM", "0001020304050607") > 0U);
  TEST_ASSERT_EQUAL_STRING("{\"minutes\":45,\"method\":\"qr\",\"token\":\"4T8Y2K9QW3ZM\",\"court\":8,"
                           "\"nonce\":\"0001020304050607\"}",
                           body);

  // Never truncated: half a body is a request for something else.
  char tiny[40] = {};
  TEST_ASSERT_EQUAL_size_t(
      0U, bridgelogic::renderWalkUpBody(tiny, sizeof(tiny), intent, 8, "TOK", "0001020304050607"));
}

void test_walkup_nonce_is_reused_only_for_the_same_undecided_purchase() {
  ScriptedEntropy entropy;
  bridgelogic::WalkUpNonce nonce;
  court::WalkUpIntent intent;
  intent.court = 2U;
  intent.minutes = 30U;

  char first[bridgelogic::kWalkUpNonceHexLen + 1U] = {};
  snprintf(first, sizeof(first), "%s", nonce.forPurchase(intent, "TOKALICE", entropy));
  TEST_ASSERT_EQUAL_STRING("0001020304050607", first);
  TEST_ASSERT_TRUE(nonce.pending());

  // The response was lost. The same member pressing the same two buttons is
  // the same purchase, and the API must be able to recognise it as such.
  TEST_ASSERT_EQUAL_STRING(first, nonce.forPurchase(intent, "TOKALICE", entropy));

  // A different member, court or duration is a different purchase.
  TEST_ASSERT_TRUE(strcmp(first, nonce.forPurchase(intent, "TOKBOB", entropy)) != 0);
  char bob[bridgelogic::kWalkUpNonceHexLen + 1U] = {};
  snprintf(bob, sizeof(bob), "%s", nonce.forPurchase(intent, "TOKBOB", entropy));
  intent.minutes = 45U;
  TEST_ASSERT_TRUE(strcmp(bob, nonce.forPurchase(intent, "TOKBOB", entropy)) != 0);

  // Once decided, even an identical purchase is a new one.
  char decided[bridgelogic::kWalkUpNonceHexLen + 1U] = {};
  snprintf(decided, sizeof(decided), "%s", nonce.forPurchase(intent, "TOKBOB", entropy));
  nonce.decided();
  TEST_ASSERT_FALSE(nonce.pending());
  TEST_ASSERT_TRUE(strcmp(decided, nonce.forPurchase(intent, "TOKBOB", entropy)) != 0);
}

void test_walkup_a_grant_and_a_replayed_grant_light_the_court_identically() {
  const char fresh[] = "{\"server_unix\":1750000000,\"booking_id\":\"b1\",\"granted_minutes\":20,"
                       "\"amount_credits\":4,\"balance_after_credits\":36}";
  const char replayed[] = "{\"server_unix\":1750000005,\"booking_id\":\"b1\",\"granted_minutes\":20,"
                          "\"amount_credits\":4,\"balance_after_credits\":36,\"replayed\":true}";

  const bridgelogic::WalkUpResult a = bridgelogic::onWalkUpResponse(200U, fresh, len(fresh), 1U, 45U);
  const bridgelogic::WalkUpResult b = bridgelogic::onWalkUpResponse(200U, replayed, len(replayed), 1U, 45U);

  const bridgelogic::WalkUpResult* both[] = {&a, &b};
  for (const bridgelogic::WalkUpResult* r : both) {
    TEST_ASSERT_TRUE(r->decided);
    TEST_ASSERT_TRUE(r->outcome.action == court::Action::TurnOn);
    TEST_ASSERT_EQUAL_UINT8(1U, r->outcome.court);
    // What was sold, not what was asked for.
    TEST_ASSERT_EQUAL_UINT32(1200000UL, r->outcome.durationMs);
    TEST_ASSERT_EQUAL_STRING("COURT B", r->outcome.line1);
    TEST_ASSERT_EQUAL_STRING("20 MIN", r->outcome.line2);
  }

  // A grant with no minutes in it falls back to what was asked, display-clamped.
  const char bare[] = "{\"server_unix\":1750000000}";
  const bridgelogic::WalkUpResult c = bridgelogic::onWalkUpResponse(200U, bare, len(bare), 3U, 240U);
  TEST_ASSERT_EQUAL_STRING("90 MIN", c.outcome.line2);
  TEST_ASSERT_EQUAL_UINT32(5400000UL, c.outcome.durationMs);
}

void test_walkup_every_refusal_reads_differently_and_says_whether_it_was_decided() {
  struct Case {
    uint16_t status;
    const char* body;
    const char* line1;
    bool decided;
  };

  const Case cases[] = {
      {402U, "{\"error\":\"insufficient_balance\"}", "TOO FEW CREDITS", true},
      {409U, "{\"error\":\"court_in_use\"}", "COURT NOT FREE", true},
      {409U, "{\"error\":\"no_time_available\"}", "NO TIME BEFORE", true},
      {400U, "{\"error\":\"not_recognised\"}", "SEE THE DESK", true},
      {0U, "", "NO CONNECTION", false},
      {503U, "", "SEE THE DESK", false},
      {429U, "", "SEE THE DESK", false},
  };
  for (const Case& c : cases) {
    const bridgelogic::WalkUpResult r = bridgelogic::onWalkUpResponse(c.status, c.body, len(c.body), 0U, 30U);
    TEST_ASSERT_TRUE_MESSAGE(r.outcome.action == court::Action::Refuse, c.line1);
    TEST_ASSERT_EQUAL_STRING(c.line1, r.outcome.line1);
    TEST_ASSERT_EQUAL_MESSAGE(c.decided, r.decided, c.line1);
    TEST_ASSERT_TRUE(strlen(r.outcome.line1) <= court::kLineLen);
    TEST_ASSERT_TRUE(strlen(r.outcome.line2) <= court::kLineLen);
  }
}

// ---------------------------------------------------------------------------
// StateReconcile — catching up with the Mega when the event was lost
// ---------------------------------------------------------------------------

bridgelogic::HeldState heldSince(uint32_t sinceMs) {
  bridgelogic::HeldState s;
  s.sinceMs = sinceMs;
  s.held = true;
  return s;
}

bridgelogic::HeldState darkSince(uint32_t sinceMs) {
  bridgelogic::HeldState s;
  s.sinceMs = sinceMs;
  s.held = false;
  return s;
}

void test_state_mask_parses_decimal_and_refuses_everything_else() {
  uint8_t mask = 0xFFU;
  TEST_ASSERT_TRUE(bridgelogic::parseStateMask("0", mask));
  TEST_ASSERT_EQUAL_UINT8(0U, mask);
  TEST_ASSERT_TRUE(bridgelogic::parseStateMask("15", mask));
  TEST_ASSERT_EQUAL_UINT8(15U, mask);
  TEST_ASSERT_TRUE(bridgelogic::parseStateMask("5", mask));
  TEST_ASSERT_EQUAL_UINT8(5U, mask);

  mask = 0xAAU;
  TEST_ASSERT_FALSE(bridgelogic::parseStateMask("16", mask));
  TEST_ASSERT_FALSE(bridgelogic::parseStateMask("", mask));
  TEST_ASSERT_FALSE(bridgelogic::parseStateMask(nullptr, mask));
  TEST_ASSERT_FALSE(bridgelogic::parseStateMask("1a", mask));
  TEST_ASSERT_FALSE(bridgelogic::parseStateMask("-1", mask));
  TEST_ASSERT_FALSE(bridgelogic::parseStateMask(" 3", mask));
  TEST_ASSERT_FALSE(bridgelogic::parseStateMask("999999999999", mask));
  TEST_ASSERT_EQUAL_UINT8(0xAAU, mask); // untouched on refusal
}

void test_reconcile_a_cleared_bit_on_a_held_court_is_the_lost_release() {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    // Court B lit at `base`; forty-five minutes later the AUTOOFF event was
    // dropped from the Mega's TX ring and only the `!STATE` got through. For
    // the wrap bases the session straddles the 49.7-day boundary.
    const uint32_t now = base + 2700000UL;
    const bridgelogic::HeldState held[4] = {darkSince(base), heldSince(base), darkSince(base),
                                            darkSince(base)};

    const bridgelogic::Reconciliation r = bridgelogic::reconcile(0x0U, held, now);
    TEST_ASSERT_TRUE(r.action[1] == bridgelogic::CourtAction::SynthesizeRelease);
    TEST_ASSERT_EQUAL_UINT32(2700000UL, r.heldMs[1]);
    TEST_ASSERT_TRUE(r.action[0] == bridgelogic::CourtAction::None);
    TEST_ASSERT_TRUE(r.action[2] == bridgelogic::CourtAction::None);
    TEST_ASSERT_TRUE(r.action[3] == bridgelogic::CourtAction::None);
  }
}

void test_reconcile_after_the_event_arrived_the_state_has_nothing_to_add() {
  // EVT then STATE: the event handler cleared the court, so the mask that
  // follows agrees with the bridge and no second Release is synthesised. The
  // other order is the test above plus the event handler's held guard.
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    const uint32_t releasedAt = base + 2700000UL;
    const bridgelogic::HeldState held[4] = {darkSince(base), darkSince(releasedAt), darkSince(base),
                                            darkSince(base)};

    // The `!STATE` that follows the `!EVT` by a few milliseconds...
    TEST_ASSERT_TRUE(bridgelogic::reconcile(0x0U, held, releasedAt + 5U).action[1] ==
                     bridgelogic::CourtAction::None);
    // ...and the periodic one ten seconds on.
    TEST_ASSERT_TRUE(bridgelogic::reconcile(0x0U, held, releasedAt + 10000U).action[1] ==
                     bridgelogic::CourtAction::None);
  }
}

void test_reconcile_a_set_bit_on_a_dark_court_is_adopted() {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    // The ESP rebooted mid-session; the Mega is still holding court D.
    const bridgelogic::HeldState held[4] = {darkSince(base), darkSince(base), darkSince(base),
                                            darkSince(base)};
    const bridgelogic::Reconciliation r = bridgelogic::reconcile(0x8U, held, base + 10000U);
    TEST_ASSERT_TRUE(r.action[3] == bridgelogic::CourtAction::AdoptHeld);
    TEST_ASSERT_TRUE(r.action[0] == bridgelogic::CourtAction::None);
  }
}

void test_reconcile_handles_all_four_courts_in_one_frame() {
  // Four simultaneous expiries: the case that guarantees a dropped event.
  const bridgelogic::HeldState held[4] = {heldSince(kBaseMid), heldSince(kBaseMid + 1000U),
                                          heldSince(kBaseMid + 2000U), heldSince(kBaseMid + 3000U)};
  const bridgelogic::Reconciliation r = bridgelogic::reconcile(0x0U, held, kBaseMid + 3600000UL);
  for (uint8_t c = 0U; c < 4U; ++c) {
    TEST_ASSERT_TRUE(r.action[c] == bridgelogic::CourtAction::SynthesizeRelease);
    TEST_ASSERT_EQUAL_UINT32(3600000UL - c * 1000U, r.heldMs[c]);
  }

  // And the mixed case: A released, B still on, C adopted, D agrees dark.
  const bridgelogic::HeldState mixed[4] = {heldSince(kBaseMid), heldSince(kBaseMid), darkSince(kBaseMid),
                                           darkSince(kBaseMid)};
  const bridgelogic::Reconciliation m = bridgelogic::reconcile(0x6U, mixed, kBaseMid + 60000U);
  TEST_ASSERT_TRUE(m.action[0] == bridgelogic::CourtAction::SynthesizeRelease);
  TEST_ASSERT_TRUE(m.action[1] == bridgelogic::CourtAction::None);
  TEST_ASSERT_TRUE(m.action[2] == bridgelogic::CourtAction::AdoptHeld);
  TEST_ASSERT_TRUE(m.action[3] == bridgelogic::CourtAction::None);
}

void test_reconcile_waits_out_a_frame_that_was_already_in_flight() {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    // `!ON` just went out; the periodic `!STATE` sent a moment earlier shows
    // the court dark. That is not a lost release — it is a stale frame.
    const bridgelogic::HeldState held[4] = {heldSince(base), darkSince(base), darkSince(base),
                                            darkSince(base)};
    TEST_ASSERT_TRUE(bridgelogic::reconcile(0x0U, held, base + 40U).action[0] ==
                     bridgelogic::CourtAction::None);
    TEST_ASSERT_TRUE(
        bridgelogic::reconcile(0x0U, held, base + bridgelogic::kReconcileGraceMs - 1U).action[0] ==
        bridgelogic::CourtAction::None);
    // Past the grace, the same disagreement is real.
    TEST_ASSERT_TRUE(bridgelogic::reconcile(0x0U, held, base + bridgelogic::kReconcileGraceMs).action[0] ==
                     bridgelogic::CourtAction::SynthesizeRelease);

    // The mirror image: `!OFF` just went out and a stale mask still shows the
    // court lit. Adopting it would re-hold a court that was just released.
    const bridgelogic::HeldState released[4] = {darkSince(base), darkSince(base), darkSince(base),
                                                darkSince(base)};
    TEST_ASSERT_TRUE(bridgelogic::reconcile(0x1U, released, base + 40U).action[0] ==
                     bridgelogic::CourtAction::None);
    TEST_ASSERT_TRUE(
        bridgelogic::reconcile(0x1U, released, base + bridgelogic::kReconcileGraceMs).action[0] ==
        bridgelogic::CourtAction::AdoptHeld);
  }
}

} // namespace

void setUp() {
}

void tearDown() {
}

int main(int, char**) {
  UNITY_BEGIN();

  RUN_TEST(test_roster_element_parses_the_four_fields);
  RUN_TEST(test_roster_element_refuses_a_token_longer_than_the_cap);
  RUN_TEST(test_roster_element_refuses_a_token_outside_the_alphabet);
  RUN_TEST(test_roster_element_refuses_a_relay_this_box_does_not_have);
  RUN_TEST(test_roster_element_refuses_a_missing_or_extra_field);
  RUN_TEST(test_roster_element_refuses_seconds_whose_milliseconds_would_not_fit);
  RUN_TEST(test_roster_element_clamps_an_already_open_window_to_now);

  RUN_TEST(test_apply_roster_an_absent_key_leaves_the_roster_untouched_and_serving);
  RUN_TEST(test_apply_roster_an_empty_array_commits_an_empty_roster);
  RUN_TEST(test_apply_roster_fills_the_cache_from_the_wire_shape);
  RUN_TEST(test_apply_roster_keeps_the_contracts_sixteen_and_reports_the_rest);
  RUN_TEST(test_apply_roster_one_bad_element_does_not_cost_the_good_ones);
  RUN_TEST(test_apply_roster_every_accepted_heartbeat_resets_staleness_across_the_wrap);
  RUN_TEST(test_a_late_arrival_is_granted_what_is_left_not_what_was_booked);
  RUN_TEST(test_a_grant_never_exceeds_the_relay_cap);
  RUN_TEST(test_court_numbers_are_read_by_relay_position);
  RUN_TEST(test_court_numbers_that_cannot_be_a_court_set_leave_the_previous_one_alone);

  RUN_TEST(test_roster_decides_for_a_shared_scanner_by_court_count);
  RUN_TEST(test_session_lights_the_court_the_booking_names_not_the_one_it_was_handed);
  RUN_TEST(test_session_a_refusal_that_matched_a_booking_carries_that_bookings_court);

  RUN_TEST(test_scan_flow_asks_the_api_only_when_a_signed_call_can_succeed);
  RUN_TEST(test_scan_flow_a_grant_lights_the_relay_the_court_number_maps_to);
  RUN_TEST(test_scan_flow_display_clamps_a_grant_past_the_relay_cap);
  RUN_TEST(test_scan_flow_a_grant_with_no_seconds_in_it_is_no_decision);
  RUN_TEST(test_scan_flow_a_grant_on_a_court_this_box_does_not_drive_is_refused_not_retried);
  RUN_TEST(test_scan_flow_a_refusal_is_a_decision_the_roster_does_not_second_guess);
  RUN_TEST(test_scan_flow_no_answer_is_the_rosters_scan);
  RUN_TEST(test_scan_flow_renders_the_activate_body);
  RUN_TEST(test_display_minutes_never_promise_more_than_the_relay_gives);

  RUN_TEST(test_walkup_body_names_the_court_and_carries_the_nonce);
  RUN_TEST(test_walkup_nonce_is_reused_only_for_the_same_undecided_purchase);
  RUN_TEST(test_walkup_a_grant_and_a_replayed_grant_light_the_court_identically);
  RUN_TEST(test_walkup_every_refusal_reads_differently_and_says_whether_it_was_decided);

  RUN_TEST(test_state_mask_parses_decimal_and_refuses_everything_else);
  RUN_TEST(test_reconcile_a_cleared_bit_on_a_held_court_is_the_lost_release);
  RUN_TEST(test_reconcile_after_the_event_arrived_the_state_has_nothing_to_add);
  RUN_TEST(test_reconcile_a_set_bit_on_a_dark_court_is_adopted);
  RUN_TEST(test_reconcile_handles_all_four_courts_in_one_frame);
  RUN_TEST(test_reconcile_waits_out_a_frame_that_was_already_in_flight);

  return UNITY_END();
}

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
// Most bodies below are INLINE fixtures shaped by the wire contract, so each
// branch can be driven without a corpus entry for it. The bytes the two sides
// must AGREE on — the activate and walk-up request bodies the signature
// covers, and the response bodies the server actually produces — are bound to
// the shared corpus at the end of the file, by vector id, never by index.
// devcrypto owns the executed-count gate on those sections; this suite reads
// named vectors and fails loudly when one is missing.
//
// The clock bases are the same matrix the other suites use: millis() wraps at
// 49.7 days and a court box in a cupboard runs for months, so every age and
// duration assertion is run at a base that puts the wrap inside the scenario.

#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unity.h>

#include "bridgelogic/ApiBreaker.h"
#include "bridgelogic/AuthPolicy.h"
#include "bridgelogic/Cadence.h"
#include "bridgelogic/CredentialStore.h"
#include "bridgelogic/EventUpload.h"
#include "bridgelogic/MegaLink.h"
#include "bridgelogic/OnRetry.h"
#include "bridgelogic/Relight.h"
#include "bridgelogic/RosterSync.h"
#include "bridgelogic/ScanFlow.h"
#include "bridgelogic/StateReconcile.h"
#include "bridgelogic/WalkUp.h"
#include "court/Session.h"
#include "devapi/DeviceClient.h"
#include "eventq/EventQueue.h"
#include "fakes/FakeStore.h"
#include "protocol/Codec.h"
#include "protocol/Protocol.h"
#include "roster/Roster.h"
#include "support/CorpusJson.h"

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
  l.courtCount = kCourtCount;
  l.apiDown = false;
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

void test_any_grant_spends_the_scan_whichever_path_lit_the_court() {
  // THE H1 PIN. The online grant closed the button window and the roster grant
  // did not, so a box with no link lit the court and left thirty seconds of
  // buttons armed on the member's token for whoever walked up next. One rule,
  // both paths: a lit court spends the scan; a refusal leaves it live.
  Cache cache(kSixHoursMs);
  fakes::FakeStore store;
  Queue queue(&store);
  queue.begin();
  Play play(cache, queue);
  const roster::Entry entries[] = {booking("TOKALICE", 2U, 0U, kHourMs),
                                   booking("TOKBOB", 1U, 600000UL, kHourMs)};
  loadRoster(cache, kBaseMid, entries, 2U);

  // Roster grant: spent.
  const court::Outcome offlineGrant =
      play.onScan("TOKALICE", roster::CourtCount(kCourtCount), eventq::Method::Qr, kBaseMid + 1U);
  TEST_ASSERT_TRUE(offlineGrant.action == court::Action::TurnOn);
  TEST_ASSERT_TRUE(bridgelogic::spendsScan(offlineGrant));

  // Roster refusals — too early, unknown — leave the scan live so the member
  // can still buy time with the buttons.
  const court::Outcome tooEarly =
      play.onScan("TOKBOB", roster::CourtCount(kCourtCount), eventq::Method::Qr, kBaseMid + 1U);
  TEST_ASSERT_TRUE(tooEarly.action == court::Action::Refuse);
  TEST_ASSERT_FALSE(bridgelogic::spendsScan(tooEarly));
  const court::Outcome unknown =
      play.onScan("NOBODY", roster::CourtCount(kCourtCount), eventq::Method::Qr, kBaseMid + 1U);
  TEST_ASSERT_FALSE(bridgelogic::spendsScan(unknown));

  // Online grant and refusal: the bit the composition root reads is the SAME
  // rule, not a second one that can drift from it.
  const bridgelogic::ScanFlow flow;
  const char granted[] = "{\"activated\":true,\"reason\":\"ok\",\"court_number\":9,\"granted_seconds\":2700}";
  const bridgelogic::ActivationResult online =
      flow.onActivateResponse(200U, granted, len(granted), kCourts, kCourtCount);
  TEST_ASSERT_TRUE(online.disarmAuth);
  TEST_ASSERT_EQUAL(bridgelogic::spendsScan(online.outcome), online.disarmAuth);

  const char refused[] = "{\"activated\":false,\"reason\":\"no_booking\"}";
  const bridgelogic::ActivationResult onlineRefusal =
      flow.onActivateResponse(200U, refused, len(refused), kCourts, kCourtCount);
  TEST_ASSERT_FALSE(onlineRefusal.disarmAuth);
  TEST_ASSERT_EQUAL(bridgelogic::spendsScan(onlineRefusal.outcome), onlineRefusal.disarmAuth);

  // A walk-up grant spends it too; a walk-up refusal does not.
  const char sold[] = "{\"granted_minutes\":30}";
  TEST_ASSERT_TRUE(
      bridgelogic::spendsScan(bridgelogic::onWalkUpResponse(200U, sold, len(sold), 0U, 30U).outcome));
  TEST_ASSERT_FALSE(bridgelogic::spendsScan(bridgelogic::onWalkUpResponse(402U, "", 0U, 0U, 30U).outcome));
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
    bool recognised;
  };

  const Case cases[] = {
      {402U, "{\"error\":\"insufficient_balance\"}", "TOO FEW CREDITS", true, true},
      {409U, "{\"error\":\"court_in_use\"}", "COURT NOT FREE", true, true},
      {409U, "{\"error\":\"no_time_available\"}", "NO TIME BEFORE", true, true},
      {409U, "{\"error\":\"purchase_ended\"}", "PURCHASE ENDED", true, true},
      {400U, "{\"error\":\"not_recognised\"}", "SEE THE DESK", true, false},
      {400U, "{\"error\":\"court_not_on_device\"}", "SEE THE DESK", true, false},
      {400U, "{\"error\":\"minutes_out_of_range\"}", "SEE THE DESK", true, false},
      {0U, "", "NO CONNECTION", false, false},
      {503U, "", "SEE THE DESK", false, false},
      {429U, "", "SEE THE DESK", false, false},
  };
  for (const Case& c : cases) {
    const bridgelogic::WalkUpResult r = bridgelogic::onWalkUpResponse(c.status, c.body, len(c.body), 0U, 30U);
    TEST_ASSERT_TRUE_MESSAGE(r.outcome.action == court::Action::Refuse, c.line1);
    TEST_ASSERT_EQUAL_STRING(c.line1, r.outcome.line1);
    TEST_ASSERT_EQUAL_MESSAGE(c.decided, r.decided, c.line1);
    TEST_ASSERT_EQUAL_MESSAGE(c.recognised, r.outcome.recognised, c.body);
    TEST_ASSERT_TRUE(strlen(r.outcome.line1) <= court::kLineLen);
    TEST_ASSERT_TRUE(strlen(r.outcome.line2) <= court::kLineLen);
  }
  // The one refusal with a second line a member acts on differently.
  const char ended[] = "{\"error\":\"purchase_ended\",\"booking_id\":\"b1\"}";
  TEST_ASSERT_EQUAL_STRING("SCAN TO START",
                           bridgelogic::onWalkUpResponse(409U, ended, len(ended), 0U, 30U).outcome.line2);
}

void test_walkup_recognised_comes_from_the_body_never_from_the_status() {
  // The bit that arms the button window. It was set on every 402 and 409 by
  // status alone, so a 409 with no error in it — or one carrying
  // not_recognised — armed thirty seconds of buttons for a token the API
  // never identified. Only an error that is a verdict about a KNOWN member
  // recognises; the status still decides what the screen says.
  struct Case {
    uint16_t status;
    const char* body;
    bool recognised;
  };

  const Case cases[] = {
      {402U, "{\"error\":\"insufficient_balance\",\"current_credits\":2.0}", true},
      {409U, "{\"error\":\"court_in_use\"}", true},
      {409U, "{\"error\":\"no_time_available\"}", true},
      {409U, "{\"error\":\"purchase_ended\"}", true},
      {402U, "", false},
      {409U, "", false},
      {409U, "{}", false},
      {409U, "{\"error\":\"not_recognised\"}", false},
      {402U, "{\"error\":\"not_recognised\"}", false},
      {400U, "{\"error\":\"not_recognised\"}", false},
      {409U, "{\"error\":\"court_not_on_device\"}", false},
      {409U, "{\"error\":\"something_newer\"}", false},
      {409U, "{\"error\":\"court_in_use_x\"}", false},
      {0U, "", false},
      {503U, "{\"error\":\"court_in_use\"}", false},
  };
  for (const Case& c : cases) {
    const bridgelogic::WalkUpResult r = bridgelogic::onWalkUpResponse(c.status, c.body, len(c.body), 1U, 30U);
    TEST_ASSERT_TRUE(r.outcome.action == court::Action::Refuse);
    TEST_ASSERT_EQUAL_MESSAGE(c.recognised, r.outcome.recognised, c.body);
  }
  // A bare status keeps its screen and loses only the window.
  TEST_ASSERT_EQUAL_STRING("TOO FEW CREDITS",
                           bridgelogic::onWalkUpResponse(402U, "", 0U, 1U, 30U).outcome.line1);
  TEST_ASSERT_EQUAL_STRING("COURT NOT FREE",
                           bridgelogic::onWalkUpResponse(409U, "", 0U, 1U, 30U).outcome.line1);
  // What that bit does: an unrecognised refusal cannot arm, a recognised one can.
  bridgelogic::AuthPolicy auth(30000UL);
  TEST_ASSERT_TRUE(auth.afterScan(bridgelogic::onWalkUpResponse(409U, "", 0U, 1U, 30U).outcome, kBaseMid) ==
                   bridgelogic::AuthCommand::Disarm);
  const char priced[] = "{\"error\":\"insufficient_balance\"}";
  TEST_ASSERT_TRUE(auth.afterScan(bridgelogic::onWalkUpResponse(402U, priced, len(priced), 1U, 30U).outcome,
                                  kBaseMid) == bridgelogic::AuthCommand::Arm);
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

void test_after_on_attempt_marks_held_only_when_the_frame_left() {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    const bridgelogic::HeldState dark = darkSince(base);

    // The `!ON` went: held from now.
    const bridgelogic::HeldState lit = bridgelogic::afterOnAttempt(dark, true, base + 5000U);
    TEST_ASSERT_TRUE(lit.held);
    TEST_ASSERT_EQUAL_UINT32(base + 5000U, lit.sinceMs);

    // The `!ON` did not go — full TX ring, dead cable. The books are untouched,
    // so the next periodic `!STATE` showing the court dark agrees with them and
    // no Release is synthesised for a session that never started.
    const bridgelogic::HeldState stillDark = bridgelogic::afterOnAttempt(dark, false, base + 5000U);
    TEST_ASSERT_FALSE(stillDark.held);
    TEST_ASSERT_EQUAL_UINT32(base, stillDark.sinceMs);
    const bridgelogic::HeldState held[4] = {stillDark, dark, dark, dark};
    TEST_ASSERT_TRUE(bridgelogic::reconcile(0x0U, held, base + 15000U).action[0] ==
                     bridgelogic::CourtAction::None);

    // And a court that was already held keeps its original instant when a
    // re-light fails: the session it is in did not restart.
    const bridgelogic::HeldState wasHeld = heldSince(base);
    const bridgelogic::HeldState unchanged = bridgelogic::afterOnAttempt(wasHeld, false, base + 5000U);
    TEST_ASSERT_TRUE(unchanged.held);
    TEST_ASSERT_EQUAL_UINT32(base, unchanged.sinceMs);
  }

  // What replaces the promise on the screen fits the display.
  TEST_ASSERT_EQUAL_STRING("TRY AGAIN", bridgelogic::kOnNotSentLine1);
  TEST_ASSERT_TRUE(strlen(bridgelogic::kOnNotSentLine1) <= court::kLineLen);
  TEST_ASSERT_TRUE(strlen(bridgelogic::kOnNotSentLine2) <= court::kLineLen);
}

// ---------------------------------------------------------------------------
// The shared corpus — the bytes the server and this box must agree on
// ---------------------------------------------------------------------------
//
// Located BY ID (responses) or by path and pinned nonce (requests), never by
// index: a reordered or extended corpus must not silently detach a test from
// its vector. A vector that has gone missing is a failure, not a skip — this
// suite binds to ids that are committed, and losing one is a contract change.
// The executed-count gate on these sections is devcrypto's; none is repeated
// here.

/// Static, not stack: 64 KB of corpus in a Unity test frame is a stack
/// overflow on some hosts.
corpus::File g_httpCases;

/// This box drives club courts 1-4 on relays A-D — the court set the corpus's
/// activate vectors assume, where `court_number` 3 is relay C.
const int16_t kCorpusCourts[bridgelogic::kMaxCourts] = {1, 2, 3, 4};

void loadHttpCorpus() {
  TEST_ASSERT_TRUE_MESSAGE(g_httpCases.load("http", "cases.json"),
                           "http corpus not found — a skipped corpus proves nothing");
}

/// The `responses` vector whose `id` is `id`. Fails the test when absent.
const char* responseVector(const char* id) {
  const char* responses = corpus::member(g_httpCases.root(), "responses");
  TEST_ASSERT_NOT_NULL_MESSAGE(responses, "http corpus has no responses section");

  corpus::ArrayIter it(responses);
  const char* element = nullptr;
  char found[64] = {};
  while (it.next(&element)) {
    const char* idValue = corpus::member(element, "id");
    if (idValue != nullptr && corpus::stringValue(idValue, found, sizeof(found), nullptr) &&
        strcmp(found, id) == 0) {
      return element;
    }
  }
  TEST_FAIL_MESSAGE(id);
  return nullptr;
}

/// The `requests` vector for `path` carrying `nonce`. Two keys, because a
/// path may gain a second vector with a different body; the nonce is what
/// pins THIS one, exactly as the probe test pins its own.
const char* requestVector(const char* path, const char* nonce) {
  const char* requests = corpus::member(g_httpCases.root(), "requests");
  TEST_ASSERT_NOT_NULL_MESSAGE(requests, "http corpus has no requests section");

  corpus::ArrayIter it(requests);
  const char* element = nullptr;
  char foundPath[128] = {};
  char foundNonce[64] = {};
  while (it.next(&element)) {
    const char* pathValue = corpus::member(element, "path_and_query");
    const char* nonceValue = corpus::member(element, "nonce");
    if (pathValue != nullptr && nonceValue != nullptr &&
        corpus::stringValue(pathValue, foundPath, sizeof(foundPath), nullptr) &&
        corpus::stringValue(nonceValue, foundNonce, sizeof(foundNonce), nullptr) &&
        strcmp(foundPath, path) == 0 && strcmp(foundNonce, nonce) == 0) {
      return element;
    }
  }
  TEST_FAIL_MESSAGE(path);
  return nullptr;
}

/// Decodes a vector's `body_hex` into `out` as a NUL-terminated string,
/// returning its byte length.
size_t bodyOf(const char* vector, char* out, size_t cap) {
  uint8_t bytes[512] = {};
  size_t n = 0U;
  TEST_ASSERT_TRUE_MESSAGE(corpus::hexField(vector, "body_hex", bytes, sizeof(bytes), &n), "body_hex");
  TEST_ASSERT_TRUE(n < cap);
  memcpy(out, bytes, n);
  out[n] = '\0';
  return n;
}

void test_corpus_activate_ok_lights_the_relay_court_3_maps_to() {
  loadHttpCorpus();
  char body[512] = {};
  const size_t n = bodyOf(responseVector("activate-response-ok"), body, sizeof(body));

  const bridgelogic::ScanFlow flow;
  const bridgelogic::ActivationResult r =
      flow.onActivateResponse(200U, body, n, kCorpusCourts, bridgelogic::kMaxCourts);

  TEST_ASSERT_FALSE(r.fallbackToRoster);
  TEST_ASSERT_TRUE(r.disarmAuth);
  TEST_ASSERT_TRUE(r.outcome.action == court::Action::TurnOn);
  TEST_ASSERT_EQUAL_UINT8(2U, r.outcome.court); // court_number 3 of [1,2,3,4]
  TEST_ASSERT_EQUAL_UINT32(2700U * 1000U, r.outcome.durationMs);
  TEST_ASSERT_EQUAL_STRING("COURT C", r.outcome.line1);
  TEST_ASSERT_EQUAL_STRING("45 MIN", r.outcome.line2);
}

void test_corpus_activate_too_early_refuses_with_the_wait_line_and_no_fallback() {
  loadHttpCorpus();
  char body[512] = {};
  const size_t n = bodyOf(responseVector("activate-response-too-early"), body, sizeof(body));

  const bridgelogic::ScanFlow flow;
  const bridgelogic::ActivationResult r =
      flow.onActivateResponse(200U, body, n, kCorpusCourts, bridgelogic::kMaxCourts);

  // A decision: the roster does not get a second opinion, and the scan stays
  // live. starts_in_seconds is 540 in the vector — nine minutes.
  TEST_ASSERT_FALSE(r.fallbackToRoster);
  TEST_ASSERT_FALSE(r.disarmAuth);
  TEST_ASSERT_TRUE(r.outcome.action == court::Action::Refuse);
  TEST_ASSERT_EQUAL_STRING("TOO EARLY", r.outcome.line1);
  TEST_ASSERT_EQUAL_STRING("WAIT 9 MIN", r.outcome.line2);
}

void test_corpus_walkup_replayed_is_a_sixty_minute_grant() {
  loadHttpCorpus();
  char body[512] = {};
  const size_t n = bodyOf(responseVector("walkup-response-replayed"), body, sizeof(body));

  // Relay C, sixty minutes asked; the replayed answer is the first purchase
  // seen again and lights the court exactly as a fresh grant would.
  const bridgelogic::WalkUpResult r = bridgelogic::onWalkUpResponse(200U, body, n, 2U, 60U);
  TEST_ASSERT_TRUE(r.decided);
  TEST_ASSERT_TRUE(r.outcome.action == court::Action::TurnOn);
  TEST_ASSERT_EQUAL_UINT8(2U, r.outcome.court);
  TEST_ASSERT_EQUAL_UINT32(60U * 60000U, r.outcome.durationMs);
  TEST_ASSERT_EQUAL_STRING("COURT C", r.outcome.line1);
  TEST_ASSERT_EQUAL_STRING("60 MIN", r.outcome.line2);
}

void test_corpus_activate_ended_is_a_refusal_the_roster_does_not_second_guess() {
  loadHttpCorpus();
  char body[512] = {};
  const size_t n = bodyOf(responseVector("activate-response-ended"), body, sizeof(body));

  const bridgelogic::ScanFlow flow;
  const bridgelogic::ActivationResult r =
      flow.onActivateResponse(200U, body, n, kCorpusCourts, bridgelogic::kMaxCourts);

  // A scan inside the grace window after the slot ended: stamped as attendance
  // server-side, nothing left to light. A DECISION — a fallback here would
  // hand the roster a booking it still holds, and light the court the API
  // just said was over. The member is known, so the scan stays live and the
  // window may arm; nothing was lit, so nothing is spent.
  TEST_ASSERT_FALSE(r.fallbackToRoster);
  TEST_ASSERT_FALSE(r.disarmAuth);
  TEST_ASSERT_TRUE(r.outcome.action == court::Action::Refuse);
  TEST_ASSERT_EQUAL_UINT8(eventq::Event::kNoCourt, r.outcome.court);
  TEST_ASSERT_EQUAL_UINT32(0U, r.outcome.durationMs);
  TEST_ASSERT_EQUAL_STRING("SLOT ENDED", r.outcome.line1);
  TEST_ASSERT_EQUAL_STRING("SEE THE DESK", r.outcome.line2);
  TEST_ASSERT_TRUE(r.outcome.recognised);
}

void test_corpus_walkup_replayed_remainder_is_what_is_left_not_what_was_bought() {
  loadHttpCorpus();
  const char* vector = responseVector("walkup-response-replayed-remainder");
  char body[512] = {};
  const size_t n = bodyOf(vector, body, sizeof(body));

  // Sixty minutes bought on relay C, the same nonce forty minutes after the
  // grant was lost: the API answers with what is LEFT — twenty-five in the
  // vector — and that is what the court is lit for and what the screen says.
  // Sixty here would hold the court over whoever booked the next slot.
  const uint64_t remainder =
      corpus::unsignedValue(corpus::member(corpus::member(vector, "expect"), "granted_minutes"));
  TEST_ASSERT_EQUAL_UINT64(25ULL, remainder);

  const bridgelogic::WalkUpResult r = bridgelogic::onWalkUpResponse(200U, body, n, 2U, 60U);
  TEST_ASSERT_TRUE(r.decided);
  TEST_ASSERT_TRUE(r.outcome.action == court::Action::TurnOn);
  TEST_ASSERT_EQUAL_UINT8(2U, r.outcome.court);
  TEST_ASSERT_EQUAL_UINT32(25U * 60000U, r.outcome.durationMs);
  TEST_ASSERT_EQUAL_UINT32(25U * 60000U, r.outcome.bookingRemainingMs);
  TEST_ASSERT_EQUAL_STRING("COURT C", r.outcome.line1);
  TEST_ASSERT_EQUAL_STRING("25 MIN", r.outcome.line2);
  TEST_ASSERT_TRUE(r.outcome.recognised);
}

void test_corpus_heartbeat_cadence_is_the_vectors_heartbeat_seconds() {
  loadHttpCorpus();
  // Every heartbeat vector that DECLARES a cadence in `expect` is adopted as
  // exactly that, bounded. The expectation is the vector's own, so the
  // backend can move the tenant default without this suite carrying a number
  // that must agree with it. A vector that declares none is skipped, which
  // is why the executed count is gated: a corpus with no such vector would
  // otherwise pass by checking nothing.
  const char* responses = corpus::member(g_httpCases.root(), "responses");
  TEST_ASSERT_NOT_NULL(responses);

  // Static: the roster-full heartbeat is allowed the box's whole 2048-byte
  // response buffer, and that is too much for a Unity test frame on some hosts.
  static uint8_t bytes[2048];
  static char body[sizeof(bytes) + 1U];

  corpus::ArrayIter it(responses);
  const char* element = nullptr;
  size_t executed = 0U;
  while (it.next(&element)) {
    char kind[16] = {};
    const char* kindValue = corpus::member(element, "kind");
    if (kindValue == nullptr || !corpus::stringValue(kindValue, kind, sizeof(kind), nullptr) ||
        strcmp(kind, "heartbeat") != 0) {
      continue;
    }
    const char* expect = corpus::member(element, "expect");
    const char* declared = expect == nullptr ? nullptr : corpus::member(expect, "heartbeat_seconds");
    if (declared == nullptr) {
      continue;
    }
    char id[64] = {};
    TEST_ASSERT_TRUE(corpus::stringValue(corpus::member(element, "id"), id, sizeof(id), nullptr));

    size_t n = 0U;
    TEST_ASSERT_TRUE_MESSAGE(corpus::hexField(element, "body_hex", bytes, sizeof(bytes), &n), id);
    memcpy(body, bytes, n);
    body[n] = '\0';

    const uint64_t seconds = corpus::unsignedValue(declared);
    const uint32_t wanted = static_cast<uint32_t>(seconds * 1000ULL);
    const uint32_t bounded =
        wanted > bridgelogic::kMaxHeartbeatMs
            ? bridgelogic::kMaxHeartbeatMs
            : (wanted < bridgelogic::kMinHeartbeatMs ? bridgelogic::kMinHeartbeatMs : wanted);
    uint32_t ms = 0U;
    TEST_ASSERT_TRUE_MESSAGE(bridgelogic::parseHeartbeatInterval(body, n, ms), id);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(bounded, ms, id);
    ++executed;
  }
  TEST_ASSERT_TRUE_MESSAGE(executed >= 1U,
                           "no heartbeat vector declares heartbeat_seconds — nothing was checked");
}

void test_corpus_every_bound_response_carries_the_clock_the_reader_finds() {
  loadHttpCorpus();
  // Every response body the box reads is also a clock source. The expectation
  // is the vector's own, so this hardcodes nothing the two sides must agree on.
  const char* const ids[] = {
      "provision-response-server-unix",    "device-401-body",         "activate-response-ok",
      "activate-response-too-early",       "activate-response-ended", "walkup-response-replayed",
      "walkup-response-replayed-remainder"};
  for (const char* id : ids) {
    const char* vector = responseVector(id);
    char body[512] = {};
    const size_t n = bodyOf(vector, body, sizeof(body));

    const char* expect = corpus::member(vector, "expect");
    TEST_ASSERT_NOT_NULL_MESSAGE(expect, id);
    const uint64_t expected = corpus::unsignedValue(corpus::member(expect, "server_unix"));
    TEST_ASSERT_NOT_EQUAL_MESSAGE(0U, expected, id);
    TEST_ASSERT_EQUAL_UINT64_MESSAGE(expected, devapi::findServerUnix(body, n), id);
  }
}

void test_corpus_activate_body_is_byte_identical_to_the_signed_request() {
  loadHttpCorpus();
  // The signature covers these exact bytes. A field reordered or a space
  // added on this side is a 401 with no diagnostic on the other.
  char expected[512] = {};
  const size_t n = bodyOf(requestVector("/api/v1/device/activate", "c0ffee00c0ffee00c0ffee00c0ffee00"),
                          expected, sizeof(expected));

  char rendered[96] = {};
  const size_t renderedLen = bridgelogic::renderActivateBody(rendered, sizeof(rendered), "7Q3F9KM2XZ8B");
  TEST_ASSERT_EQUAL_size_t(n, renderedLen);
  TEST_ASSERT_EQUAL_STRING(expected, rendered);
  TEST_ASSERT_EQUAL_MEMORY(expected, rendered, n);
}

void test_corpus_walkup_body_is_byte_identical_to_the_signed_request() {
  loadHttpCorpus();
  char expected[512] = {};
  const size_t n = bodyOf(requestVector("/api/v1/device/walkup", "0a1b2c3d4e5f60718293a4b5c6d7e8f9"),
                          expected, sizeof(expected));

  // Sixty minutes on relay C, which this box maps to club court 3.
  court::WalkUpIntent intent;
  intent.court = 2U;
  intent.minutes = 60U;
  char rendered[320] = {};
  const size_t renderedLen = bridgelogic::renderWalkUpBody(
      rendered, sizeof(rendered), intent, kCorpusCourts[intent.court], "7Q3F9KM2XZ8B", "9f2a4c6e8b0d1f3a");
  TEST_ASSERT_EQUAL_size_t(n, renderedLen);
  TEST_ASSERT_EQUAL_STRING(expected, rendered);
  TEST_ASSERT_EQUAL_MEMORY(expected, rendered, n);
}

// ---------------------------------------------------------------------------
// Hardening wave (closing re-review 2026-09-04)
// ---------------------------------------------------------------------------

void test_scan_flow_a_box_with_no_court_list_is_not_online() {
  // THE BOOT-GAP PIN (review #12). For ~30 s after every ESP reboot the clock
  // is known (a signed OFFER seeds it within seconds) and the court list is
  // empty until the first heartbeat. Asking the API then records attendance
  // server-side and refuses the member at the box, because the granted court
  // number maps to nothing. Not ready is not online.
  const bridgelogic::ScanFlow flow;
  bridgelogic::LinkState l = link(true, true, true);
  TEST_ASSERT_TRUE(flow.onScan(l) == bridgelogic::Attempt::Online);
  l.courtCount = 0U;
  TEST_ASSERT_TRUE(flow.onScan(l) == bridgelogic::Attempt::RosterOnly);
  l.courtCount = 1U;
  TEST_ASSERT_TRUE(flow.onScan(l) == bridgelogic::Attempt::Online);
}

void test_scan_flow_an_open_breaker_is_the_rosters_scan() {
  const bridgelogic::ScanFlow flow;
  bridgelogic::LinkState l = link(true, true, true);
  l.apiDown = true;
  TEST_ASSERT_TRUE(flow.onScan(l) == bridgelogic::Attempt::RosterOnly);
}

void test_scan_flow_a_zero_second_grant_is_a_refusal_not_a_pulse() {
  // A rescan inside the post-slot grace window answers activated:true with
  // granted_seconds:0. The wire's one-second floor turned that into a relay
  // pulse, a "1 MIN" screen and a spent scan.
  const bridgelogic::ScanFlow flow;
  const char body[] = "{\"activated\":true,\"reason\":\"ok\",\"court_number\":7,\"granted_seconds\":0}";
  const bridgelogic::ActivationResult r =
      flow.onActivateResponse(200U, body, len(body), kCourts, kCourtCount);
  TEST_ASSERT_FALSE(r.fallbackToRoster);
  TEST_ASSERT_FALSE(r.disarmAuth);
  TEST_ASSERT_TRUE(r.outcome.action == court::Action::Refuse);
  TEST_ASSERT_EQUAL_STRING("SLOT ENDED", r.outcome.line1);
  TEST_ASSERT_EQUAL_STRING("SEE THE DESK", r.outcome.line2);
  TEST_ASSERT_TRUE(r.outcome.recognised);
}

void test_scan_flow_recognised_is_every_verdict_about_a_known_member() {
  const bridgelogic::ScanFlow flow;

  struct Case {
    const char* body;
    bool recognised;
  };

  const Case cases[] = {
      {"{\"activated\":true,\"reason\":\"ok\",\"court_number\":7,\"granted_seconds\":600}", true},
      {"{\"activated\":false,\"reason\":\"no_booking\"}", true},
      {"{\"activated\":false,\"reason\":\"insufficient_balance\"}", true},
      {"{\"activated\":false,\"reason\":\"wrong_court\"}", true},
      {"{\"activated\":false,\"reason\":\"too_early\",\"starts_in_seconds\":900}", true},
      {"{\"activated\":false,\"reason\":\"not_chargeable\"}", true},
      {"{\"activated\":false,\"reason\":\"something_newer\"}", true},
      {"{\"activated\":false,\"reason\":\"not_recognised\"}", false},
      {"{\"activated\":false}", false},
  };
  for (const Case& c : cases) {
    const bridgelogic::ActivationResult r =
        flow.onActivateResponse(200U, c.body, len(c.body), kCourts, kCourtCount);
    TEST_ASSERT_EQUAL_MESSAGE(c.recognised, r.outcome.recognised, c.body);
  }
}

void test_scan_flow_a_grant_carries_the_uncapped_booking_remainder() {
  const bridgelogic::ScanFlow flow;
  const char body[] = "{\"activated\":true,\"reason\":\"ok\",\"court_number\":7,\"granted_seconds\":7200}";
  const bridgelogic::ActivationResult r =
      flow.onActivateResponse(200U, body, len(body), kCourts, kCourtCount);
  TEST_ASSERT_EQUAL_UINT32(5400000UL, r.outcome.durationMs);
  TEST_ASSERT_EQUAL_UINT32(7200000UL, r.outcome.bookingRemainingMs);
}

court::Outcome outcomeOf(court::Action action, uint8_t court, bool recognised) {
  court::Outcome o;
  o.action = action;
  o.court = court;
  o.recognised = recognised;
  o.durationMs = action == court::Action::TurnOn ? 2700000UL : 0U;
  o.bookingRemainingMs = o.durationMs;
  return o;
}

void test_auth_policy_a_refused_scan_cannot_release_any_court() {
  // THE #4/#14 PIN, half one. NOT RECOGNISED, then COURT B, then OFF used to
  // darken court B mid-match, repeatable every thirty seconds by anyone with
  // any barcode. An unrecognised scan arms nothing and closes what was open.
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    bridgelogic::AuthPolicy auth(30000UL);
    TEST_ASSERT_TRUE(auth.afterScan(outcomeOf(court::Action::Refuse, eventq::Event::kNoCourt, false), base) ==
                     bridgelogic::AuthCommand::Disarm);
    TEST_ASSERT_FALSE(auth.armed(base + 1U));
    for (uint8_t court = 0U; court < 4U; ++court) {
      TEST_ASSERT_FALSE(auth.allowsRelease(court, base + 1U));
    }
    // A stale roster is not a recognition either.
    TEST_ASSERT_TRUE(auth.afterScan(outcomeOf(court::Action::Refuse, eventq::Event::kNoCourt, false), base) ==
                     bridgelogic::AuthCommand::Disarm);
  }
}

void test_auth_policy_a_recognised_refusal_arms_for_a_walk_up_but_releases_nothing() {
  // A known member with no booking is exactly who buys a walk-up: the window
  // opens. But nothing was lit for them, so OFF releases nobody's court.
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    bridgelogic::AuthPolicy auth(30000UL);
    TEST_ASSERT_TRUE(auth.afterScan(outcomeOf(court::Action::Refuse, eventq::Event::kNoCourt, true), base) ==
                     bridgelogic::AuthCommand::Arm);
    TEST_ASSERT_TRUE(auth.armed(base + 29999UL));
    TEST_ASSERT_EQUAL_UINT8(bridgelogic::AuthPolicy::kUnbound, auth.boundCourt());
    for (uint8_t court = 0U; court < 4U; ++court) {
      TEST_ASSERT_FALSE(auth.allowsRelease(court, base + 1U));
    }
  }
}

void test_auth_policy_the_member_whose_scan_lit_b_can_release_b_and_only_b() {
  // THE #4/#14 PIN, half two. Every grant used to send `!AUTH,0`, and a
  // rescan by the owner is another grant, so the paying member could never
  // press OFF. A grant keeps the window and binds it to the court it lit.
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    bridgelogic::AuthPolicy auth(30000UL);
    TEST_ASSERT_TRUE(auth.afterScan(outcomeOf(court::Action::TurnOn, 1U, true), base) ==
                     bridgelogic::AuthCommand::Arm);
    TEST_ASSERT_TRUE(auth.allowsRelease(1U, base + 29999UL));
    TEST_ASSERT_FALSE(auth.allowsRelease(0U, base + 1U));
    TEST_ASSERT_FALSE(auth.allowsRelease(2U, base + 1U));
    TEST_ASSERT_FALSE(auth.allowsRelease(3U, base + 1U));

    // The window lapses, once, and then releases nothing.
    TEST_ASSERT_FALSE(auth.lapsed(base + 29999UL));
    TEST_ASSERT_TRUE(auth.lapsed(base + 30000UL));
    TEST_ASSERT_FALSE(auth.lapsed(base + 30001UL));
    TEST_ASSERT_FALSE(auth.allowsRelease(1U, base + 30001UL));

    // A rescan by the owner (the API answers AlreadyActive as a grant) binds
    // again — and a walk-up purchase binds to the court it bought.
    TEST_ASSERT_TRUE(auth.afterScan(outcomeOf(court::Action::TurnOn, 1U, true), base + 40000UL) ==
                     bridgelogic::AuthCommand::Arm);
    TEST_ASSERT_TRUE(auth.allowsRelease(1U, base + 40001UL));
    TEST_ASSERT_TRUE(auth.afterWalkUp(outcomeOf(court::Action::TurnOn, 3U, true), base + 40002UL) ==
                     bridgelogic::AuthCommand::Arm);
    TEST_ASSERT_TRUE(auth.allowsRelease(3U, base + 40003UL));
    TEST_ASSERT_FALSE(auth.allowsRelease(1U, base + 40003UL));
    // A walk-up refusal changes nothing.
    TEST_ASSERT_TRUE(auth.afterWalkUp(outcomeOf(court::Action::Refuse, 2U, true), base + 40004UL) ==
                     bridgelogic::AuthCommand::None);
    TEST_ASSERT_TRUE(auth.allowsRelease(3U, base + 40005UL));
    // An explicit disarm — the scan lapsed unspent — closes it.
    TEST_ASSERT_TRUE(auth.disarm() == bridgelogic::AuthCommand::Disarm);
    TEST_ASSERT_FALSE(auth.allowsRelease(3U, base + 40006UL));
  }
}

void test_session_and_walkup_say_whether_the_scan_was_recognised() {
  // The bit AuthPolicy reads, produced by the roster path: a match of any
  // verdict is a recognition; an unknown token and a stale roster are not.
  Cache cache(kSixHoursMs);
  fakes::FakeStore store;
  Queue queue(&store);
  queue.begin();
  Play play(cache, queue);

  // Never loaded: stale, nobody recognised.
  TEST_ASSERT_FALSE(
      play.onScan("TOKALICE", roster::CourtCount(kCourtCount), eventq::Method::Qr, kBaseMid).recognised);

  const roster::Entry entries[] = {booking("TOKALICE", 2U, 0U, 7200000UL),
                                   booking("TOKBOB", 1U, 600000UL, kHourMs)};
  loadRoster(cache, kBaseMid, entries, 2U);
  const court::Outcome grant =
      play.onScan("TOKALICE", roster::CourtCount(kCourtCount), eventq::Method::Qr, kBaseMid + 1U);
  TEST_ASSERT_TRUE(grant.recognised);
  TEST_ASSERT_EQUAL_UINT32(5400000UL, grant.durationMs);
  TEST_ASSERT_EQUAL_UINT32(7199999UL, grant.bookingRemainingMs); // uncapped, for the !EXT
  TEST_ASSERT_TRUE(play.onScan("TOKBOB", roster::CourtCount(kCourtCount), eventq::Method::Qr, kBaseMid + 1U)
                       .recognised); // too early, but known
  TEST_ASSERT_FALSE(
      play.onScan("NOBODY", roster::CourtCount(kCourtCount), eventq::Method::Qr, kBaseMid + 1U).recognised);

  // Walk-up: a grant and a priced refusal are about a known member; no
  // connection is about nobody.
  const char sold[] = "{\"granted_minutes\":120}";
  const bridgelogic::WalkUpResult granted = bridgelogic::onWalkUpResponse(200U, sold, len(sold), 2U, 120U);
  TEST_ASSERT_TRUE(granted.outcome.recognised);
  TEST_ASSERT_EQUAL_UINT32(5400000UL, granted.outcome.durationMs);
  TEST_ASSERT_EQUAL_UINT32(7200000UL, granted.outcome.bookingRemainingMs);
  const char priced[] = "{\"error\":\"insufficient_balance\"}";
  const char busy[] = "{\"error\":\"court_in_use\"}";
  TEST_ASSERT_TRUE(bridgelogic::onWalkUpResponse(402U, priced, len(priced), 2U, 30U).outcome.recognised);
  TEST_ASSERT_TRUE(bridgelogic::onWalkUpResponse(409U, busy, len(busy), 2U, 30U).outcome.recognised);
  // The status alone says nothing about who scanned.
  TEST_ASSERT_FALSE(bridgelogic::onWalkUpResponse(402U, "", 0U, 2U, 30U).outcome.recognised);
  TEST_ASSERT_FALSE(bridgelogic::onWalkUpResponse(409U, "", 0U, 2U, 30U).outcome.recognised);
  TEST_ASSERT_FALSE(bridgelogic::onWalkUpResponse(0U, "", 0U, 2U, 30U).outcome.recognised);
  TEST_ASSERT_FALSE(bridgelogic::onWalkUpResponse(503U, "", 0U, 2U, 30U).outcome.recognised);
}

void test_breaker_opens_after_two_transport_failures_and_backs_off_doubling() {
  // THE #13 PIN. One failure is a blip; two in a row is a host that is not
  // there, and every scan then costs two connect timeouts unless something
  // remembers. The window doubles 15 → 30 → 60 → 120 and stops there.
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    bridgelogic::ApiBreaker breaker;
    TEST_ASSERT_FALSE(breaker.open(base));
    breaker.onResult(0U, base);
    TEST_ASSERT_FALSE(breaker.open(base + 1U));
    breaker.onResult(503U, base + 1U);
    TEST_ASSERT_TRUE(breaker.open(base + 2U));
    TEST_ASSERT_TRUE(breaker.open(base + 1U + 14999UL));
    TEST_ASSERT_FALSE(breaker.open(base + 1U + 15000UL)); // the probe's turn
    TEST_ASSERT_EQUAL_UINT16(1U, breaker.trips());

    // The probe fails: open again, for twice as long.
    breaker.onResult(0U, base + 16000UL);
    TEST_ASSERT_TRUE(breaker.open(base + 16000UL + 29999UL));
    TEST_ASSERT_FALSE(breaker.open(base + 16000UL + 30000UL));
    breaker.onResult(0U, base + 47000UL);
    TEST_ASSERT_FALSE(breaker.open(base + 47000UL + 60000UL));
    breaker.onResult(0U, base + 108000UL);
    TEST_ASSERT_TRUE(breaker.open(base + 108000UL + 119999UL));
    TEST_ASSERT_FALSE(breaker.open(base + 108000UL + 120000UL));
    breaker.onResult(0U, base + 230000UL);
    TEST_ASSERT_EQUAL_UINT32(bridgelogic::kMaxBackoffMs, breaker.backoffMs()); // capped
    TEST_ASSERT_FALSE(breaker.open(base + 230000UL + 120000UL));
  }
}

void test_breaker_any_answer_closes_it_and_resets_the_window() {
  // A 401, a 4xx and a 429 all say the API is THERE. Only "never completed"
  // and 5xx are transport failures.
  TEST_ASSERT_TRUE(bridgelogic::isTransportFailure(0U));
  TEST_ASSERT_TRUE(bridgelogic::isTransportFailure(500U));
  TEST_ASSERT_TRUE(bridgelogic::isTransportFailure(503U));
  TEST_ASSERT_FALSE(bridgelogic::isTransportFailure(200U));
  TEST_ASSERT_FALSE(bridgelogic::isTransportFailure(401U));
  TEST_ASSERT_FALSE(bridgelogic::isTransportFailure(404U));
  TEST_ASSERT_FALSE(bridgelogic::isTransportFailure(429U));

  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    bridgelogic::ApiBreaker breaker;
    breaker.onResult(0U, base);
    breaker.onResult(0U, base + 1U);
    breaker.onResult(0U, base + 16000UL); // reopened at 30 s
    TEST_ASSERT_TRUE(breaker.open(base + 16001UL));
    breaker.onResult(401U, base + 16002UL);
    TEST_ASSERT_FALSE(breaker.open(base + 16003UL));
    TEST_ASSERT_EQUAL_UINT8(0U, breaker.consecutiveFailures());
    TEST_ASSERT_EQUAL_UINT32(bridgelogic::kInitialBackoffMs, breaker.backoffMs());
    // And one failure after a success is a blip again, not a trip.
    breaker.onResult(0U, base + 16004UL);
    TEST_ASSERT_FALSE(breaker.open(base + 16005UL));
  }
}

void test_heartbeat_interval_is_adopted_and_bounded() {
  uint32_t ms = 30000UL;
  const char sixty[] = "{\"court_numbers\":[7],\"heartbeat_seconds\":60}";
  TEST_ASSERT_TRUE(bridgelogic::parseHeartbeatInterval(sixty, len(sixty), ms));
  TEST_ASSERT_EQUAL_UINT32(60000UL, ms);
  const char tooFast[] = "{\"heartbeat_seconds\":1}";
  TEST_ASSERT_TRUE(bridgelogic::parseHeartbeatInterval(tooFast, len(tooFast), ms));
  TEST_ASSERT_EQUAL_UINT32(bridgelogic::kMinHeartbeatMs, ms);
  const char tooSlow[] = "{\"heartbeat_seconds\":86400}";
  TEST_ASSERT_TRUE(bridgelogic::parseHeartbeatInterval(tooSlow, len(tooSlow), ms));
  TEST_ASSERT_EQUAL_UINT32(bridgelogic::kMaxHeartbeatMs, ms);
  const char absent[] = "{\"court_numbers\":[7]}";
  TEST_ASSERT_FALSE(bridgelogic::parseHeartbeatInterval(absent, len(absent), ms));
  TEST_ASSERT_EQUAL_UINT32(bridgelogic::kMaxHeartbeatMs, ms); // untouched
  const char quoted[] = "{\"heartbeat_seconds\":\"60\"}";
  TEST_ASSERT_FALSE(bridgelogic::parseHeartbeatInterval(quoted, len(quoted), ms));
}

void test_relight_extends_a_booking_longer_than_the_cap_before_the_cap_runs_out() {
  // A two-hour booking: one !ON buys ninety minutes. At 89 minutes the bridge
  // sends !EXT for the thirty that are left; at every base, including the
  // ones that put the millis() wrap inside the booking.
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    bridgelogic::Relight relight;
    court::Outcome grant = outcomeOf(court::Action::TurnOn, 1U, true);
    grant.durationMs = 5400000UL;
    grant.bookingRemainingMs = 7200000UL;
    relight.onGrant(grant, base);
    TEST_ASSERT_TRUE(relight.tracking(1U));
    TEST_ASSERT_FALSE(relight.tracking(0U));

    TEST_ASSERT_FALSE(relight.check(1U, base + 5400000UL - 60001UL).due);
    const bridgelogic::Extension ext = relight.check(1U, base + 5400000UL - 60000UL);
    TEST_ASSERT_TRUE(ext.due);
    // Booking left: 7200000 - 5340000 = 1860000 ms = 1860 s.
    TEST_ASSERT_EQUAL_UINT32(1860U, ext.seconds);
    // Not sent yet: still due on the next pass.
    TEST_ASSERT_TRUE(relight.check(1U, base + 5400000UL - 59000UL).due);
    relight.extended(1U, ext.seconds, base + 5400000UL - 60000UL);
    // Now the relay covers the rest of the booking: nothing more to do, ever.
    TEST_ASSERT_FALSE(relight.check(1U, base + 5400000UL - 59000UL).due);
    TEST_ASSERT_FALSE(relight.check(1U, base + 7200000UL - 60000UL).due);
    TEST_ASSERT_FALSE(relight.check(1U, base + 7200000UL + 60000UL).due);
  }
}

void test_relight_a_three_hour_booking_needs_two_extensions_each_capped() {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    bridgelogic::Relight relight;
    court::Outcome grant = outcomeOf(court::Action::TurnOn, 2U, true);
    grant.durationMs = 5400000UL;
    grant.bookingRemainingMs = 10800000UL;
    relight.onGrant(grant, base);

    uint32_t now = base + 5400000UL - 60000UL;
    bridgelogic::Extension ext = relight.check(2U, now);
    TEST_ASSERT_TRUE(ext.due);
    TEST_ASSERT_EQUAL_UINT32(5400U, ext.seconds); // capped: 91 min left, 90 granted
    relight.extended(2U, ext.seconds, now);
    // Second cap expiry at now + 90 min; the booking has one minute past it.
    now += 5400000UL - 60000UL;
    ext = relight.check(2U, now);
    TEST_ASSERT_TRUE(ext.due);
    TEST_ASSERT_EQUAL_UINT32(120U, ext.seconds);
    relight.extended(2U, ext.seconds, now);
    TEST_ASSERT_FALSE(relight.check(2U, now + 119000UL).due);
  }
}

void test_relight_forgets_a_court_on_release_and_a_grant_inside_the_cap() {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    bridgelogic::Relight relight;
    court::Outcome grant = outcomeOf(court::Action::TurnOn, 0U, true);
    grant.durationMs = 5400000UL;
    grant.bookingRemainingMs = 7200000UL;
    relight.onGrant(grant, base);
    relight.onRelease(0U);
    TEST_ASSERT_FALSE(relight.tracking(0U));
    TEST_ASSERT_FALSE(relight.check(0U, base + 5400000UL - 60000UL).due);

    // A fresh 45-minute grant on the same court replaces the record: nothing
    // from the earlier booking may extend this one.
    relight.onGrant(grant, base);
    relight.onGrant(outcomeOf(court::Action::TurnOn, 0U, true), base + 1000UL);
    TEST_ASSERT_FALSE(relight.tracking(0U));
    // A refusal is not a grant.
    relight.onGrant(outcomeOf(court::Action::Refuse, 0U, true), base);
    TEST_ASSERT_FALSE(relight.tracking(0U));
    // A court this box does not have is ignored, not written past the array.
    court::Outcome bad = grant;
    bad.court = 9U;
    relight.onGrant(bad, base);
    TEST_ASSERT_FALSE(relight.tracking(9U));
  }
}

void test_on_retry_resends_the_last_on_once_and_only_inside_the_window() {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    bridgelogic::OnRetry retry;
    proto::Frame out;
    // Nothing remembered: nothing to resend.
    TEST_ASSERT_FALSE(retry.shouldResend(base, out));

    const proto::Frame on = proto::Frame::on(proto::Court::B, 2700U);
    retry.sent(on, base);
    TEST_ASSERT_TRUE(retry.pending());
    TEST_ASSERT_TRUE(retry.shouldResend(base + 20U, out));
    TEST_ASSERT_TRUE(out == on);
    // Once. A second error is a cable.
    TEST_ASSERT_FALSE(retry.shouldResend(base + 40U, out));
    TEST_ASSERT_EQUAL_UINT16(1U, retry.retries());

    // Outside the window an error cannot be about this frame.
    retry.sent(on, base + 1000UL);
    TEST_ASSERT_FALSE(retry.shouldResend(base + 1000UL + bridgelogic::kRetryWindowMs, out));
    TEST_ASSERT_FALSE(retry.pending());

    // Only a relay-affecting frame is kept; a repaint clears the memory.
    retry.sent(proto::Frame::lcd("A", "B"), base + 3000UL);
    TEST_ASSERT_FALSE(retry.pending());
    retry.sent(on, base + 3000UL);
    retry.clear();
    TEST_ASSERT_FALSE(retry.shouldResend(base + 3001UL, out));
  }
  // Which uplink reports count.
  TEST_ASSERT_TRUE(bridgelogic::isReceiveError(proto::Verb::Err, "BADCRC", ""));
  TEST_ASSERT_TRUE(bridgelogic::isReceiveError(proto::Verb::Evt, "OVERRUN", "RX"));
  // BADFRAME is the commonest loss of all: the production Mega refuses the
  // legacy dialect and classifies a line by its first byte, so a glitch byte
  // ahead of an idle-line `!ON` is BADFRAME, not BADCRC (review 3, finding 13).
  // This assertion used to read FALSE.
  TEST_ASSERT_TRUE(bridgelogic::isReceiveError(proto::Verb::Evt, "BADFRAME", "RX"));
  // The Mega dropping a frame on its way OUT says nothing about what it heard.
  TEST_ASSERT_FALSE(bridgelogic::isReceiveError(proto::Verb::Evt, "OVERRUN", "TX"));
  TEST_ASSERT_FALSE(bridgelogic::isReceiveError(proto::Verb::Evt, "BADFRAME", "TX"));
  TEST_ASSERT_FALSE(bridgelogic::isReceiveError(proto::Verb::Err, "BADARG", ""));
  TEST_ASSERT_FALSE(bridgelogic::isReceiveError(proto::Verb::Evt, "AUTOOFF", "B"));
  TEST_ASSERT_FALSE(bridgelogic::isReceiveError(proto::Verb::State, "BADCRC", ""));

  // BADARG is not a lost frame at all: after an `!EXT` it is the Mega saying
  // the relay is already open.
  TEST_ASSERT_TRUE(bridgelogic::isExtRefusal(proto::Verb::Err, "BADARG"));
  TEST_ASSERT_FALSE(bridgelogic::isExtRefusal(proto::Verb::Err, "BADCRC"));
  TEST_ASSERT_FALSE(bridgelogic::isExtRefusal(proto::Verb::Evt, "BADARG"));
}

void test_on_retry_keeps_an_ext_too_and_a_lost_one_is_sent_again() {
  // REVIEW 3, FINDING 7. A two-hour booking is held past the ninety-minute cap
  // by one `!EXT`. Losing that one frame darkened the court mid-game, and
  // OnRetry remembered only `!ON`, so nothing re-sent it.
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    bridgelogic::OnRetry retry;
    proto::Frame out;

    const proto::Frame ext = proto::Frame::ext(proto::Court::B, 1800U);
    retry.sent(ext, base);
    TEST_ASSERT_TRUE(retry.pending());
    TEST_ASSERT_TRUE(retry.verb() == proto::Verb::Ext);
    TEST_ASSERT_EQUAL_UINT8(1U, retry.court());

    // `!ERR,BADCRC` in reply, inside the window: the same frame goes once more.
    TEST_ASSERT_TRUE(bridgelogic::isReceiveError(proto::Verb::Err, "BADCRC", ""));
    TEST_ASSERT_TRUE(retry.shouldResend(base + 30U, out));
    TEST_ASSERT_TRUE(out == ext);
    // Once. A second failure is a cable.
    TEST_ASSERT_FALSE(retry.shouldResend(base + 60U, out));
    TEST_ASSERT_TRUE(retry.verb() == proto::Verb::Unknown);
  }
}

void test_on_retry_a_release_on_another_court_keeps_this_courts_retry() {
  // REVIEW 3, FINDING 24. Four courts expire at 19:00 while a member scans for
  // a 19:00 booking on B: releaseCourt(A) used to clear() unconditionally and
  // drop the retry B's grant was waiting on.
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    bridgelogic::OnRetry retry;
    proto::Frame out;

    retry.sent(proto::Frame::on(proto::Court::B, 2700U), base);
    retry.clearIfCourt(0U); // court A released
    TEST_ASSERT_TRUE(retry.pending());
    TEST_ASSERT_TRUE(retry.shouldResend(base + 40U, out));
    TEST_ASSERT_EQUAL_STRING("B", out.arg(0));

    // The court it IS about still clears it: that grant is over.
    retry.sent(proto::Frame::on(proto::Court::B, 2700U), base);
    retry.clearIfCourt(1U);
    TEST_ASSERT_FALSE(retry.pending());
    TEST_ASSERT_FALSE(retry.shouldResend(base + 40U, out));
    TEST_ASSERT_EQUAL_UINT8(bridgelogic::kNoRetryCourt, retry.court());
  }
}

void test_relight_adopts_the_megas_remaining_seconds_so_a_lost_ext_is_re_sent() {
  // REVIEW 3, FINDING 7. `Relight::extended` stamps the new relay deadline the
  // instant the frame leaves the TX ring — a BELIEF. When the frame is
  // corrupted on the wire the belief is ~29 minutes wrong, check() stays silent
  // for that whole time, and the court goes dark mid-game with the bridge
  // convinced it had extended it. The Mega publishes what its relay ACTUALLY
  // has left in every `!STATE`; adopting it puts the deadline back.
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    bridgelogic::Relight relight;

    // A two-hour booking on court B: 90 minutes on the relay, 120 in the slot.
    court::Outcome grant = outcomeOf(court::Action::TurnOn, 1U, true);
    grant.bookingRemainingMs = 2UL * kHourMs;
    relight.onGrant(grant, base);
    TEST_ASSERT_TRUE(relight.tracking(1U));

    // At 89 minutes the extension is due, and is "sent".
    const uint32_t due = base + (89UL * 60UL * 1000UL);
    bridgelogic::Extension ext = relight.check(1U, due);
    TEST_ASSERT_TRUE(ext.due);
    relight.extended(1U, ext.seconds, due);
    // Believed extended: nothing more is due.
    TEST_ASSERT_FALSE(relight.check(1U, due + 1000UL).due);

    // But the frame never arrived. Ten seconds later the Mega's own `!STATE`
    // says the relay has 50 seconds left, not half an hour.
    const uint32_t stateAt = due + 10000UL;
    relight.observeRelayRemaining(1U, 50U, stateAt);
    const bridgelogic::Extension again = relight.check(1U, stateAt);
    TEST_ASSERT_TRUE(again.due);
    TEST_ASSERT_TRUE(again.seconds > 0U);

    // A court that is not being tracked is not written to.
    relight.observeRelayRemaining(0U, 1200U, stateAt);
    TEST_ASSERT_FALSE(relight.check(0U, stateAt).due);
    // Nor is one past the end of the array.
    relight.observeRelayRemaining(9U, 1200U, stateAt);
  }
}

void test_state_seconds_parse_decimal_and_refuse_everything_else() {
  uint16_t seconds = 0U;
  TEST_ASSERT_TRUE(bridgelogic::parseStateSeconds("0", seconds));
  TEST_ASSERT_EQUAL_UINT16(0U, seconds);
  TEST_ASSERT_TRUE(bridgelogic::parseStateSeconds("5400", seconds));
  TEST_ASSERT_EQUAL_UINT16(5400U, seconds);
  TEST_ASSERT_TRUE(bridgelogic::parseStateSeconds("65535", seconds));
  TEST_ASSERT_EQUAL_UINT16(65535U, seconds);
  // An older Mega that sends the mask alone yields an empty argument, which is
  // "no reading" and must not be read as zero.
  TEST_ASSERT_FALSE(bridgelogic::parseStateSeconds("", seconds));
  TEST_ASSERT_FALSE(bridgelogic::parseStateSeconds(nullptr, seconds));
  TEST_ASSERT_FALSE(bridgelogic::parseStateSeconds("65536", seconds));
  TEST_ASSERT_FALSE(bridgelogic::parseStateSeconds("-1", seconds));
  TEST_ASSERT_FALSE(bridgelogic::parseStateSeconds(" 12", seconds));
  TEST_ASSERT_FALSE(bridgelogic::parseStateSeconds("12x", seconds));
}

void test_a_rescan_on_a_court_this_box_already_lit_is_not_a_second_grant() {
  // THE CLOSING-#10 RESIDUAL. The roster holds bookings, not lights: a booking
  // is "allowed" for its whole window, so a member who scans again mid-game was
  // re-granted — a second `!ON` re-arming the relay from the rescan, and a
  // second Activation event for one booking.
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    bridgelogic::HeldState held[bridgelogic::kStateCourts];
    for (uint8_t c = 0U; c < bridgelogic::kStateCourts; ++c) {
      held[c] = bridgelogic::HeldState{base, false};
    }

    roster::Decision allow;
    allow.verdict = roster::Verdict::Allow;
    allow.entry.court = 1U;
    allow.entry.valid = true;
    allow.grantMs = 1500000UL;

    court::Outcome out;
    // Court B dark: an ordinary grant, and this guard says nothing.
    TEST_ASSERT_FALSE(bridgelogic::regrantsHeldCourt(allow, held, out));

    // Court B lit: refused, and the member is told the truth.
    held[1] = bridgelogic::HeldState{base, true};
    TEST_ASSERT_TRUE(bridgelogic::regrantsHeldCourt(allow, held, out));
    TEST_ASSERT_TRUE(out.action == court::Action::Refuse);
    TEST_ASSERT_EQUAL_STRING("COURT B IS ON", out.line1);
    TEST_ASSERT_EQUAL_STRING("ALREADY LIT", out.line2);
    TEST_ASSERT_TRUE(out.recognised);
    TEST_ASSERT_EQUAL_UINT8(1U, out.court);

    // A refusal is not a re-grant, whatever the mask says.
    roster::Decision tooEarly = allow;
    tooEarly.verdict = roster::Verdict::TooEarly;
    TEST_ASSERT_FALSE(bridgelogic::regrantsHeldCourt(tooEarly, held, out));
    roster::Decision stale;
    stale.verdict = roster::Verdict::Stale;
    TEST_ASSERT_FALSE(bridgelogic::regrantsHeldCourt(stale, held, out));
    // A court past the end of the array is never dereferenced.
    roster::Decision bogus = allow;
    bogus.entry.court = 9U;
    TEST_ASSERT_FALSE(bridgelogic::regrantsHeldCourt(bogus, held, out));

    // And the window binds to the lit court, so THEIR off press still works.
    bridgelogic::AuthPolicy auth(30000UL);
    TEST_ASSERT_TRUE(auth.afterHeldCourtRescan(1U, base) == bridgelogic::AuthCommand::Arm);
    TEST_ASSERT_TRUE(auth.allowsRelease(1U, base + 1U));
    TEST_ASSERT_FALSE(auth.allowsRelease(0U, base + 1U));
  }
}

void test_the_identity_screen_is_repainted_on_the_first_pong_and_after_a_mega_reset() {
  // REVIEW 3, FINDING 9. `seconds < gMegaUptime` alone can never be true for
  // the first pong of a boot, because gMegaUptime starts at 0 — so the screen
  // that tells a technician what the box IS (CLAIM CODE <hex>, or CONNECTED /
  // SCAN TO START) was painted by no reachable path after a USB flash, where
  // the Mega was not on the other end of the UART to hear setup()'s frame.
  TEST_ASSERT_TRUE(bridgelogic::shouldRepaintIdentity(false, 0U, 0U));
  TEST_ASSERT_TRUE(bridgelogic::shouldRepaintIdentity(false, 0U, 4213U));
  // A running Mega: nothing to repaint.
  TEST_ASSERT_FALSE(bridgelogic::shouldRepaintIdentity(true, 10U, 40U));
  // Two pongs inside one second are ordinary, not a reset.
  TEST_ASSERT_FALSE(bridgelogic::shouldRepaintIdentity(true, 40U, 40U));
  // Backwards is a reset: the Mega is back on its idle text.
  TEST_ASSERT_TRUE(bridgelogic::shouldRepaintIdentity(true, 4000U, 3U));
}

void test_the_event_body_carries_a_64_bit_uptime_across_the_millis_wrap() {
  // REVIEW 3, FINDING 25. Both `uptime_ms` fields went out as 32 bits while the
  // accumulator behind them was 64-bit, so an activation queued before the
  // 49.7-day wrap and uploaded after it was stamped 49.7 days AHEAD of the
  // batch — the server dated it at upload time and filed a "counter cannot be
  // believed" audit row against a healthy box.
  eventq::Event event;
  event.seq = 41U;
  event.kind = eventq::Kind::Activation;
  event.court = 1U;
  event.method = eventq::Method::Qr;
  event.durationMs = 2700000UL;
  TEST_ASSERT_TRUE(event.setSubject("TOKEN-B"));

  // Stamped four seconds before the wrap; uploaded twenty seconds after it.
  event.uptimeMs = 0xFFFFF000UL;
  const uint64_t wrap = 0x100000000ULL;
  const uint64_t now = wrap + 20000ULL;

  char body[bridgelogic::kEventBodyCap] = {};
  const size_t len = bridgelogic::renderEventBody(body, sizeof(body), now, event);
  TEST_ASSERT_TRUE(len > 0U);
  TEST_ASSERT_EQUAL_size_t(strlen(body), len);
  TEST_ASSERT_NOT_NULL(strstr(body, "{\"uptime_ms\":4294987296,"));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"uptime_ms\":4294963200,"));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"kind\":\"activation\""));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"court\":1"));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"method\":\"qr\""));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"subject\":\"TOKEN-B\""));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"duration_ms\":2700000"));

  // The ordinary case is unchanged: no wrap, no widening.
  event.uptimeMs = 90000UL;
  TEST_ASSERT_TRUE(bridgelogic::renderEventBody(body, sizeof(body), 120000ULL, event) > 0U);
  TEST_ASSERT_NOT_NULL(strstr(body, "{\"uptime_ms\":120000,"));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"uptime_ms\":90000,"));

  // A release carries no identification method, and says so as a null rather
  // than as the string "none".
  eventq::Event release;
  release.seq = 42U;
  release.kind = eventq::Kind::Release;
  release.court = eventq::Event::kNoCourt;
  release.uptimeMs = 1000UL;
  TEST_ASSERT_TRUE(bridgelogic::renderEventBody(body, sizeof(body), 2000ULL, release) > 0U);
  TEST_ASSERT_NOT_NULL(strstr(body, "\"method\":null"));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"court\":-1"));

  // Refused rather than truncated: a half-rendered body comes back 4xx and the
  // drain path drops the event as one the box caused.
  char tiny[24] = {};
  TEST_ASSERT_EQUAL_size_t(0U, bridgelogic::renderEventBody(tiny, sizeof(tiny), 2000ULL, release));
  TEST_ASSERT_EQUAL_STRING("", tiny);
}

void test_credential_store_checked_text_survives_the_store_and_a_torn_write_reads_as_absent() {
  fakes::FakeStore store;
  char out[64] = {};
  TEST_ASSERT_TRUE(bridgelogic::putCheckedText(store, "k", "hello"));
  TEST_ASSERT_TRUE(bridgelogic::getCheckedText(store, "k", out, sizeof(out)));
  TEST_ASSERT_EQUAL_STRING("hello", out);
  // An empty text is a record (an open network's passphrase).
  TEST_ASSERT_TRUE(bridgelogic::putCheckedText(store, "e", ""));
  TEST_ASSERT_TRUE(bridgelogic::getCheckedText(store, "e", out, sizeof(out)));
  TEST_ASSERT_EQUAL_STRING("", out);
  // Absent.
  TEST_ASSERT_FALSE(bridgelogic::getCheckedText(store, "none", out, sizeof(out)));
  TEST_ASSERT_EQUAL_STRING("", out);
  // Torn: the store hands back a mongrel with kOk; the trailer refuses it.
  store.tearNextWriteAfter(2U);
  TEST_ASSERT_FALSE(bridgelogic::putCheckedText(store, "k", "world"));
  TEST_ASSERT_FALSE(bridgelogic::getCheckedText(store, "k", out, sizeof(out)));
  // Too long for the caller's buffer: refused, not truncated.
  TEST_ASSERT_TRUE(bridgelogic::putCheckedText(store, "l", "0123456789"));
  char tiny[8] = {};
  TEST_ASSERT_FALSE(bridgelogic::getCheckedText(store, "l", tiny, sizeof(tiny)));
  // Too long for the record: refused, not truncated.
  char huge[hal::kStoreMaxValueLen + 1U];
  memset(huge, 'x', sizeof(huge) - 1U);
  huge[sizeof(huge) - 1U] = '\0';
  TEST_ASSERT_FALSE(bridgelogic::putCheckedText(store, "h", huge));
}

void test_api_url_survives_a_reboot_and_refuses_a_longer_one_loudly() {
  fakes::FakeStore store;
  char out[bridgelogic::kMaxApiUrlLen + 1U] = {};
  // The 32-character cap was silent: this is 53 characters, a DNS-named
  // advertised base, and it must survive a reboot intact.
  const char named[] = "http://mainframe.crusaders-squash.example.co.za:8088";
  TEST_ASSERT_TRUE(bridgelogic::storeApiUrl(store, named));
  TEST_ASSERT_TRUE(bridgelogic::loadApiUrl(store, out, sizeof(out)));
  TEST_ASSERT_EQUAL_STRING(named, out);

  char exact[bridgelogic::kMaxApiUrlLen + 1U];
  memset(exact, 'u', bridgelogic::kMaxApiUrlLen);
  exact[bridgelogic::kMaxApiUrlLen] = '\0';
  TEST_ASSERT_TRUE(bridgelogic::storeApiUrl(store, exact));
  char over[bridgelogic::kMaxApiUrlLen + 2U];
  memset(over, 'u', bridgelogic::kMaxApiUrlLen + 1U);
  over[bridgelogic::kMaxApiUrlLen + 1U] = '\0';
  TEST_ASSERT_FALSE(bridgelogic::storeApiUrl(store, over));
  TEST_ASSERT_FALSE(bridgelogic::storeApiUrl(store, ""));
  TEST_ASSERT_TRUE(bridgelogic::loadApiUrl(store, out, sizeof(out)));
  TEST_ASSERT_EQUAL_STRING(exact, out); // the refused one changed nothing

  // A box provisioned before the checked record: the legacy key still boots
  // it, and the first new store retires the legacy record.
  fakes::FakeStore old;
  const char legacy[] = "http://192.168.68.10:8088";
  TEST_ASSERT_TRUE(old.put(bridgelogic::kKeyApiUrlLegacy, reinterpret_cast<const uint8_t*>(legacy),
                           static_cast<uint8_t>(strlen(legacy))) == hal::StoreResult::kOk);
  TEST_ASSERT_TRUE(bridgelogic::loadApiUrl(old, out, sizeof(out)));
  TEST_ASSERT_EQUAL_STRING(legacy, out);
  TEST_ASSERT_TRUE(bridgelogic::storeApiUrl(old, named));
  TEST_ASSERT_FALSE(old.exists(bridgelogic::kKeyApiUrlLegacy));
  TEST_ASSERT_TRUE(bridgelogic::loadApiUrl(old, out, sizeof(out)));
  TEST_ASSERT_EQUAL_STRING(named, out);

  fakes::FakeStore none;
  TEST_ASSERT_FALSE(bridgelogic::loadApiUrl(none, out, sizeof(out)));
  TEST_ASSERT_EQUAL_STRING("", out);
}

void test_a_heartbeat_response_ignores_every_key_this_build_does_not_read() {
  // The firmware no longer takes over-the-air updates, but the shared corpus
  // and a deployed API may still carry the keys that drove them — and a later
  // contract will add keys nobody has thought of yet. Every reader here looks
  // up the one key it wants and steps over the rest, so an unknown key is not
  // a parse failure, not a dropped roster, and not a court list left empty.
  // This is the property the corpus rests on; without it, retiring a field on
  // one side of the wire is a fleet-wide outage on the other.
  Cache cache(kSixHoursMs);
  const char body[] = "{\"server_unix\":1750000000,\"heartbeat_seconds\":45,"
                      "\"ota\":{\"version\":\"9.9.9\",\"url\":\"http://x/f.bin\",\"size_bytes\":400000},"
                      "\"court_numbers\":[7,8,9,10],"
                      "\"something_from_2027\":{\"nested\":[1,2,3]},"
                      "\"roster\":[\"TOKALICE|1|-60|2640\"],"
                      "\"config\":{\"button_map\":[\"court:A\",\"minutes:30\"]}}";

  const bridgelogic::SyncResult r = bridgelogic::applyRoster(body, len(body), cache, kBaseMid);
  TEST_ASSERT_TRUE(r.replaced);
  TEST_ASSERT_EQUAL_UINT8(1U, r.accepted);
  TEST_ASSERT_EQUAL_UINT8(0U, r.rejected);
  TEST_ASSERT_TRUE(cache.decide("TOKALICE", 1U, kBaseMid + 1000U).verdict == roster::Verdict::Allow);

  int16_t courts[bridgelogic::kMaxCourts] = {-1, -1, -1, -1};
  uint8_t count = 0U;
  TEST_ASSERT_TRUE(bridgelogic::parseCourtNumbers(body, len(body), courts, count));
  TEST_ASSERT_EQUAL_UINT8(4U, count);
  TEST_ASSERT_EQUAL_INT16(7, courts[0]);
  TEST_ASSERT_EQUAL_INT16(10, courts[3]);

  uint32_t ms = 30000UL;
  TEST_ASSERT_TRUE(bridgelogic::parseHeartbeatInterval(body, len(body), ms));
  TEST_ASSERT_EQUAL_UINT32(45000UL, ms);
}

/// Appends `frame` to `stream` as the Mega sends it, checksum and terminator
/// included — from the real encoder, so the bytes are the wire's.
void appendFrame(const proto::Frame& frame, char* stream, size_t cap, size_t& at) {
  const size_t n = proto::encode(frame, stream + at, cap - at);
  TEST_ASSERT_TRUE(n > 0U);
  at += n;
}

void appendRaw(const char* text, char* stream, size_t cap, size_t& at) {
  const size_t n = strlen(text);
  TEST_ASSERT_TRUE(at + n < cap);
  memcpy(stream + at, text, n);
  at += n;
}

void test_the_uplink_decoder_keeps_every_mega_frame_around_the_noise() {
  // The Mega link carries frames and, occasionally, bytes that are not one: an
  // ESP boot banner at 74880 baud, a line a technician typed, a frame whose
  // checksum died on the wire. The decoder must resynchronise on the next
  // terminator every time and lose nothing on either side of the noise — every
  // uplink verb the Mega can send is in this stream, with rubbish between them.
  proto::Decoder uplink(proto::Link::Uplink);

  char stream[512] = {};
  size_t at = 0U;
  appendFrame(proto::Frame::scan("4T8Y2K9QW3ZM"), stream, sizeof(stream), at);
  appendFrame(proto::Frame::btn(proto::Key::CourtB), stream, sizeof(stream), at);
  appendRaw("ets Jan  8 2013,rst cause:2\r\n", stream, sizeof(stream), at);
  appendFrame(proto::Frame::evt("AUTOOFF", "B"), stream, sizeof(stream), at);
  // A frame prefix INSIDE a line: dropped on its checksum, and it takes
  // nothing after the terminator with it.
  appendRaw("!SCAN,AB!SCAN,x,y*00\r\n", stream, sizeof(stream), at);
  appendFrame(proto::Frame::pong("1.2.0", 42U), stream, sizeof(stream), at);
  const uint16_t remaining[4] = {0U, 600U, 0U, 0U};
  appendFrame(proto::Frame::state(2U, remaining), stream, sizeof(stream), at);
  appendFrame(proto::Frame::err(proto::DecodeError::BadCrc), stream, sizeof(stream), at);
  appendFrame(proto::Frame::scan("7Q3F9KM2XZ8B"), stream, sizeof(stream), at);

  uint8_t frames = 0U;
  uint8_t byVerb[proto::kVerbCount] = {};
  for (size_t i = 0U; i < at; ++i) {
    if (!uplink.feed(stream[i])) {
      continue;
    }
    proto::Decoder::Result result;
    while (uplink.pop(result)) {
      if (!result.isFrame()) {
        // The banner and the mid-line garbage: counted by the decoder, never a
        // frame. Whatever they were, they were not a Mega verb.
        continue;
      }
      ++frames;
      ++byVerb[static_cast<size_t>(result.frame.verb())];
    }
  }
  TEST_ASSERT_EQUAL_UINT8(7U, frames);
  TEST_ASSERT_EQUAL_UINT8(2U, byVerb[static_cast<size_t>(proto::Verb::Scan)]);
  TEST_ASSERT_EQUAL_UINT8(1U, byVerb[static_cast<size_t>(proto::Verb::Btn)]);
  TEST_ASSERT_EQUAL_UINT8(1U, byVerb[static_cast<size_t>(proto::Verb::Evt)]);
  TEST_ASSERT_EQUAL_UINT8(1U, byVerb[static_cast<size_t>(proto::Verb::Pong)]);
  TEST_ASSERT_EQUAL_UINT8(1U, byVerb[static_cast<size_t>(proto::Verb::State)]);
  TEST_ASSERT_EQUAL_UINT8(1U, byVerb[static_cast<size_t>(proto::Verb::Err)]);
  TEST_ASSERT_EQUAL_UINT8(0U, byVerb[static_cast<size_t>(proto::Verb::Unknown)]);
  TEST_ASSERT_EQUAL_UINT16(0U, uplink.droppedResults());
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
  RUN_TEST(test_any_grant_spends_the_scan_whichever_path_lit_the_court);

  RUN_TEST(test_walkup_body_names_the_court_and_carries_the_nonce);
  RUN_TEST(test_walkup_nonce_is_reused_only_for_the_same_undecided_purchase);
  RUN_TEST(test_walkup_a_grant_and_a_replayed_grant_light_the_court_identically);
  RUN_TEST(test_walkup_every_refusal_reads_differently_and_says_whether_it_was_decided);
  RUN_TEST(test_walkup_recognised_comes_from_the_body_never_from_the_status);

  RUN_TEST(test_state_mask_parses_decimal_and_refuses_everything_else);
  RUN_TEST(test_reconcile_a_cleared_bit_on_a_held_court_is_the_lost_release);
  RUN_TEST(test_reconcile_after_the_event_arrived_the_state_has_nothing_to_add);
  RUN_TEST(test_reconcile_a_set_bit_on_a_dark_court_is_adopted);
  RUN_TEST(test_reconcile_handles_all_four_courts_in_one_frame);
  RUN_TEST(test_reconcile_waits_out_a_frame_that_was_already_in_flight);
  RUN_TEST(test_after_on_attempt_marks_held_only_when_the_frame_left);

  RUN_TEST(test_corpus_activate_ok_lights_the_relay_court_3_maps_to);
  RUN_TEST(test_corpus_activate_too_early_refuses_with_the_wait_line_and_no_fallback);
  RUN_TEST(test_corpus_walkup_replayed_is_a_sixty_minute_grant);
  RUN_TEST(test_corpus_activate_ended_is_a_refusal_the_roster_does_not_second_guess);
  RUN_TEST(test_corpus_walkup_replayed_remainder_is_what_is_left_not_what_was_bought);
  RUN_TEST(test_corpus_heartbeat_cadence_is_the_vectors_heartbeat_seconds);
  RUN_TEST(test_corpus_every_bound_response_carries_the_clock_the_reader_finds);
  RUN_TEST(test_corpus_activate_body_is_byte_identical_to_the_signed_request);
  RUN_TEST(test_corpus_walkup_body_is_byte_identical_to_the_signed_request);

  RUN_TEST(test_scan_flow_a_box_with_no_court_list_is_not_online);
  RUN_TEST(test_scan_flow_an_open_breaker_is_the_rosters_scan);
  RUN_TEST(test_scan_flow_a_zero_second_grant_is_a_refusal_not_a_pulse);
  RUN_TEST(test_scan_flow_recognised_is_every_verdict_about_a_known_member);
  RUN_TEST(test_scan_flow_a_grant_carries_the_uncapped_booking_remainder);
  RUN_TEST(test_auth_policy_a_refused_scan_cannot_release_any_court);
  RUN_TEST(test_auth_policy_a_recognised_refusal_arms_for_a_walk_up_but_releases_nothing);
  RUN_TEST(test_auth_policy_the_member_whose_scan_lit_b_can_release_b_and_only_b);
  RUN_TEST(test_session_and_walkup_say_whether_the_scan_was_recognised);
  RUN_TEST(test_breaker_opens_after_two_transport_failures_and_backs_off_doubling);
  RUN_TEST(test_breaker_any_answer_closes_it_and_resets_the_window);
  RUN_TEST(test_heartbeat_interval_is_adopted_and_bounded);
  RUN_TEST(test_relight_extends_a_booking_longer_than_the_cap_before_the_cap_runs_out);
  RUN_TEST(test_relight_a_three_hour_booking_needs_two_extensions_each_capped);
  RUN_TEST(test_relight_forgets_a_court_on_release_and_a_grant_inside_the_cap);
  RUN_TEST(test_on_retry_resends_the_last_on_once_and_only_inside_the_window);
  RUN_TEST(test_on_retry_keeps_an_ext_too_and_a_lost_one_is_sent_again);
  RUN_TEST(test_on_retry_a_release_on_another_court_keeps_this_courts_retry);
  RUN_TEST(test_relight_adopts_the_megas_remaining_seconds_so_a_lost_ext_is_re_sent);
  RUN_TEST(test_state_seconds_parse_decimal_and_refuse_everything_else);
  RUN_TEST(test_a_rescan_on_a_court_this_box_already_lit_is_not_a_second_grant);
  RUN_TEST(test_the_identity_screen_is_repainted_on_the_first_pong_and_after_a_mega_reset);
  RUN_TEST(test_the_event_body_carries_a_64_bit_uptime_across_the_millis_wrap);
  RUN_TEST(test_credential_store_checked_text_survives_the_store_and_a_torn_write_reads_as_absent);
  RUN_TEST(test_api_url_survives_a_reboot_and_refuses_a_longer_one_loudly);
  RUN_TEST(test_a_heartbeat_response_ignores_every_key_this_build_does_not_read);
  RUN_TEST(test_the_uplink_decoder_keeps_every_mega_frame_around_the_noise);

  return UNITY_END();
}

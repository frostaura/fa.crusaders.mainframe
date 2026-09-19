// Unity tests for lib/devlink: the device-agnostic half of talking to the API.
//
// WHY THIS SUITE IS HERE AND NOT WITH THE COURT BOX
// -------------------------------------------------
// These four units — the heartbeat body and the interval it adopts, one queued
// event as an upload body, the roster push parsed out of a heartbeat response,
// and the circuit breaker in front of every call — say nothing about relays,
// DIP switches or a Mega<->ESP serial dialect. A second Crusaders device needs
// every one of them and needs none of that, so they live in ../shared/lib and
// are proven here, against nothing but the shared libraries.
//
// They were all in the court box's `bridgelogic` suite and every one of them
// was a review finding first: a roster cache nothing filled (C2), two
// `uptime_ms` fields printed 32-bit from a 64-bit accumulator (review 3,
// finding 25), a tenant `heartbeat_seconds` served on every heartbeat and read
// by nothing, and every scan paying two 4 s connect timeouts to a host that was
// not there (review #13). What proves them has not changed; only where it
// lives has.
//
// WHAT STAYED BEHIND
// ------------------
// Anything that mixes these units with the court box's own — the scan flow, the
// walk-up, `!STATE` reconciliation — is still in
// ../../court-box/test/test_bridgelogic, and so are the corpus-bound byte-for-byte
// checks, which need that project's `support/CorpusJson.h`. This file
// deliberately reaches for no corpus and no test support: a shared library's
// suite that needed a particular firmware's fixtures would not be shared.
//
// The clock bases are the same matrix the other suites use: millis() wraps at
// 49.7 days and a device in a cupboard runs for months, so every age and
// duration assertion is run at a base that puts the wrap inside the scenario.

#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unity.h>

#include "devlink/ApiBreaker.h"
#include "devlink/Cadence.h"
#include "devlink/EventUpload.h"
#include "devlink/RosterSync.h"
#include "eventq/Event.h"
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

using Cache = roster::Roster<devlink::kMaxRosterEntries>;

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

// -------------------------------------------------------------------------
// RosterSync — one element
// -------------------------------------------------------------------------

void test_roster_element_parses_the_four_fields() {
  roster::Entry e;
  TEST_ASSERT_TRUE(devlink::parseRosterElement("4T8Y2K9QW3ZM|2|600|3300", e));
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
  TEST_ASSERT_TRUE(devlink::parseRosterElement("ABCDEFGHJKMNPQRSTVWX|0|0|60", e));
  TEST_ASSERT_EQUAL_UINT8(20U, static_cast<uint8_t>(strlen(e.token)));

  roster::Entry untouched;
  TEST_ASSERT_FALSE(devlink::parseRosterElement("ABCDEFGHJKMNPQRSTVWXY|0|0|60", untouched));
  TEST_ASSERT_EQUAL_STRING("", untouched.token);
  TEST_ASSERT_FALSE(untouched.valid);
}

void test_roster_element_refuses_a_token_outside_the_alphabet() {
  roster::Entry e;
  TEST_ASSERT_FALSE(devlink::parseRosterElement("4T8Y 2K9Q|0|0|60", e));
  TEST_ASSERT_FALSE(devlink::parseRosterElement("4T8Y\"2K9Q|0|0|60", e));
  TEST_ASSERT_FALSE(devlink::parseRosterElement("4T8Y,2K9Q|0|0|60", e));
  TEST_ASSERT_FALSE(devlink::parseRosterElement("|0|0|60", e)); // empty
  // The tolerated extras: lowercase, dash, underscore.
  TEST_ASSERT_TRUE(devlink::parseRosterElement("tok-alice_1|0|0|60", e));
}

void test_roster_element_refuses_a_relay_this_box_does_not_have() {
  roster::Entry e;
  TEST_ASSERT_FALSE(devlink::parseRosterElement("TOKEN|4|0|60", e));
  TEST_ASSERT_FALSE(devlink::parseRosterElement("TOKEN|A|0|60", e));
  TEST_ASSERT_FALSE(devlink::parseRosterElement("TOKEN||0|60", e));
  TEST_ASSERT_FALSE(devlink::parseRosterElement("TOKEN|03|0|60", e));
  TEST_ASSERT_TRUE(devlink::parseRosterElement("TOKEN|3|0|60", e));
  TEST_ASSERT_EQUAL_UINT8(3U, e.court);
}

void test_roster_element_refuses_a_missing_or_extra_field() {
  roster::Entry e;
  TEST_ASSERT_FALSE(devlink::parseRosterElement("TOKEN|1|0", e));
  TEST_ASSERT_FALSE(devlink::parseRosterElement("TOKEN|1|0|60|x", e));
  TEST_ASSERT_FALSE(devlink::parseRosterElement("TOKEN|1|0|", e)); // empty closes_in
  TEST_ASSERT_FALSE(devlink::parseRosterElement("", e));
  TEST_ASSERT_FALSE(devlink::parseRosterElement(nullptr, e));
}

void test_roster_element_refuses_seconds_whose_milliseconds_would_not_fit() {
  roster::Entry e;
  // 4294967 s is the last value whose ms fits a uint32_t; 4294968 wraps.
  TEST_ASSERT_TRUE(devlink::parseRosterElement("TOKEN|1|0|4294967", e));
  TEST_ASSERT_FALSE(devlink::parseRosterElement("TOKEN|1|0|4294968", e));
  TEST_ASSERT_FALSE(devlink::parseRosterElement("TOKEN|1|4294968|4294968", e));
  TEST_ASSERT_FALSE(devlink::parseRosterElement("TOKEN|1|0|99999999999999999999", e));
  // Not digits at all.
  TEST_ASSERT_FALSE(devlink::parseRosterElement("TOKEN|1|0|6e2", e));
  TEST_ASSERT_FALSE(devlink::parseRosterElement("TOKEN|1|0| 60", e));
  // Ends before it starts.
  TEST_ASSERT_FALSE(devlink::parseRosterElement("TOKEN|1|600|300", e));
}

void test_roster_element_clamps_an_already_open_window_to_now() {
  roster::Entry e;
  TEST_ASSERT_TRUE(devlink::parseRosterElement("TOKEN|1|-420|2280", e));
  TEST_ASSERT_EQUAL_UINT32(0U, e.opensAtMs);
  TEST_ASSERT_EQUAL_UINT32(2280000UL, e.closesAtMs);
  TEST_ASSERT_EQUAL_UINT32(2280000UL, e.durationMs);
  // A sign with nothing behind it is malformed, not "very open".
  TEST_ASSERT_FALSE(devlink::parseRosterElement("TOKEN|1|-|60", e));
  TEST_ASSERT_FALSE(devlink::parseRosterElement("TOKEN|1|-x|60", e));
}

// -------------------------------------------------------------------------
// RosterSync — the whole heartbeat
// -------------------------------------------------------------------------

void test_apply_roster_an_absent_key_leaves_the_roster_untouched_and_serving() {
  Cache cache(kSixHoursMs);
  const roster::Entry entries[] = {booking("TOKALICE", 1U, 0U, kHourMs)};
  loadRoster(cache, kBaseMid, entries, 1U);

  // An older API, or a heartbeat that carries only the button map.
  const char body[] = "{\"server_unix\":1750000000,\"court_numbers\":[7,8],\"config\":{\"button_map\":[]}}";
  const devlink::SyncResult r = devlink::applyRoster(body, len(body), cache, kBaseMid + 30000U);

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
  const devlink::SyncResult r = devlink::applyRoster(body, len(body), cache, kBaseMid + 30000U);

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
  const devlink::SyncResult r = devlink::applyRoster(body, len(body), cache, kBaseMid);

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

  const devlink::SyncResult r = devlink::applyRoster(body, len(body), cache, kBaseMid);
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
  const devlink::SyncResult r = devlink::applyRoster(body, len(body), cache, kBaseMid);

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
    TEST_ASSERT_TRUE(devlink::applyRoster(body, len(body), cache, refreshAt).replaced);

    // Two hours after THAT — seven after the original load, which would have
    // been stale — the roster is two hours old and still serves. Only an offline
    // box ever reaches ROSTER_MAX_AGE_MS.
    const uint32_t later = refreshAt + 2U * kHourMs;
    TEST_ASSERT_FALSE(cache.stale(later));
    TEST_ASSERT_EQUAL_UINT32(2U * kHourMs, cache.ageMs(later));
    TEST_ASSERT_TRUE(cache.decide("TOKALICE", 1U, later).verdict == roster::Verdict::Allow);
  }
}

// -------------------------------------------------------------------------
// RosterSync — court_numbers, by relay position
// -------------------------------------------------------------------------

void test_court_numbers_are_read_by_relay_position() {
  int16_t courts[devlink::kMaxCourts] = {-1, -1, -1, -1};
  uint8_t count = 99U;

  const char three[] = "{\"court_numbers\":[7, 8,9],\"roster\":[]}";
  TEST_ASSERT_TRUE(devlink::parseCourtNumbers(three, len(three), courts, count));
  TEST_ASSERT_EQUAL_UINT8(3U, count);
  TEST_ASSERT_EQUAL_INT16(7, courts[0]);
  TEST_ASSERT_EQUAL_INT16(8, courts[1]);
  TEST_ASSERT_EQUAL_INT16(9, courts[2]);
  TEST_ASSERT_EQUAL_INT16(0, courts[3]);

  const char none[] = "{\"court_numbers\":[]}";
  TEST_ASSERT_TRUE(devlink::parseCourtNumbers(none, len(none), courts, count));
  TEST_ASSERT_EQUAL_UINT8(0U, count);
}

void test_court_numbers_that_cannot_be_a_court_set_leave_the_previous_one_alone() {
  int16_t courts[devlink::kMaxCourts] = {7, 8, 9, 10};
  uint8_t count = 4U;

  const char absent[] = "{\"roster\":[]}";
  TEST_ASSERT_FALSE(devlink::parseCourtNumbers(absent, len(absent), courts, count));

  // Five courts for four relays: which four? Nobody should guess.
  const char five[] = "{\"court_numbers\":[1,2,3,4,5]}";
  TEST_ASSERT_FALSE(devlink::parseCourtNumbers(five, len(five), courts, count));

  const char notNumbers[] = "{\"court_numbers\":[\"A\",\"B\"]}";
  TEST_ASSERT_FALSE(devlink::parseCourtNumbers(notNumbers, len(notNumbers), courts, count));

  const char notArray[] = "{\"court_numbers\":7}";
  TEST_ASSERT_FALSE(devlink::parseCourtNumbers(notArray, len(notArray), courts, count));

  const char huge[] = "{\"court_numbers\":[70000]}";
  TEST_ASSERT_FALSE(devlink::parseCourtNumbers(huge, len(huge), courts, count));

  TEST_ASSERT_EQUAL_UINT8(4U, count);
  TEST_ASSERT_EQUAL_INT16(10, courts[3]);
}

// -------------------------------------------------------------------------
// ApiBreaker — the host that is not there
// -------------------------------------------------------------------------

void test_breaker_opens_after_two_transport_failures_and_backs_off_doubling() {
  // THE #13 PIN. One failure is a blip; two in a row is a host that is not
  // there, and every scan then costs two connect timeouts unless something
  // remembers. The window doubles 15 → 30 → 60 → 120 and stops there.
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    devlink::ApiBreaker breaker;
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
    TEST_ASSERT_EQUAL_UINT32(devlink::kMaxBackoffMs, breaker.backoffMs()); // capped
    TEST_ASSERT_FALSE(breaker.open(base + 230000UL + 120000UL));
  }
}

void test_breaker_any_answer_closes_it_and_resets_the_window() {
  // A 401, a 4xx and a 429 all say the API is THERE. Only "never completed"
  // and 5xx are transport failures.
  TEST_ASSERT_TRUE(devlink::isTransportFailure(0U));
  TEST_ASSERT_TRUE(devlink::isTransportFailure(500U));
  TEST_ASSERT_TRUE(devlink::isTransportFailure(503U));
  TEST_ASSERT_FALSE(devlink::isTransportFailure(200U));
  TEST_ASSERT_FALSE(devlink::isTransportFailure(401U));
  TEST_ASSERT_FALSE(devlink::isTransportFailure(404U));
  TEST_ASSERT_FALSE(devlink::isTransportFailure(429U));

  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    devlink::ApiBreaker breaker;
    breaker.onResult(0U, base);
    breaker.onResult(0U, base + 1U);
    breaker.onResult(0U, base + 16000UL); // reopened at 30 s
    TEST_ASSERT_TRUE(breaker.open(base + 16001UL));
    breaker.onResult(401U, base + 16002UL);
    TEST_ASSERT_FALSE(breaker.open(base + 16003UL));
    TEST_ASSERT_EQUAL_UINT8(0U, breaker.consecutiveFailures());
    TEST_ASSERT_EQUAL_UINT32(devlink::kInitialBackoffMs, breaker.backoffMs());
    // And one failure after a success is a blip again, not a trip.
    breaker.onResult(0U, base + 16004UL);
    TEST_ASSERT_FALSE(breaker.open(base + 16005UL));
  }
}

// -------------------------------------------------------------------------
// Cadence — the interval the tenant asks for
// -------------------------------------------------------------------------

void test_heartbeat_interval_is_adopted_and_bounded() {
  uint32_t ms = 30000UL;
  const char sixty[] = "{\"court_numbers\":[7],\"heartbeat_seconds\":60}";
  TEST_ASSERT_TRUE(devlink::parseHeartbeatInterval(sixty, len(sixty), ms));
  TEST_ASSERT_EQUAL_UINT32(60000UL, ms);
  const char tooFast[] = "{\"heartbeat_seconds\":1}";
  TEST_ASSERT_TRUE(devlink::parseHeartbeatInterval(tooFast, len(tooFast), ms));
  TEST_ASSERT_EQUAL_UINT32(devlink::kMinHeartbeatMs, ms);
  const char tooSlow[] = "{\"heartbeat_seconds\":86400}";
  TEST_ASSERT_TRUE(devlink::parseHeartbeatInterval(tooSlow, len(tooSlow), ms));
  TEST_ASSERT_EQUAL_UINT32(devlink::kMaxHeartbeatMs, ms);
  const char absent[] = "{\"court_numbers\":[7]}";
  TEST_ASSERT_FALSE(devlink::parseHeartbeatInterval(absent, len(absent), ms));
  TEST_ASSERT_EQUAL_UINT32(devlink::kMaxHeartbeatMs, ms); // untouched
  const char quoted[] = "{\"heartbeat_seconds\":\"60\"}";
  TEST_ASSERT_FALSE(devlink::parseHeartbeatInterval(quoted, len(quoted), ms));
}

/// THE CLUB'S OWN SLUG IS A DECOY. `tenant_slug` and `device_code` are strings
/// the server chooses and are sent BEFORE everything these three functions
/// read, so a club slugged after one of the keys used to make that key
/// unreadable — silently, because every one of these reports absence and every
/// caller treats absence as "leave what you had". A box on its compiled-in
/// cadence forever, a roster that ages out and then admits nobody, a relay bank
/// mapped to the wrong courts. Held by devapi::json::findKey; pinned here
/// because this is where it would actually bite.
void test_a_tenant_slug_that_names_a_key_hides_nothing() {
  const char cadence[] = "{\"server_time\":\"2023-11-14T22:13:20+00:00\","
                         "\"tenant_slug\":\"heartbeat_seconds\",\"device_code\":\"court-box-1\","
                         "\"heartbeat_seconds\":60,\"roster\":[]}";
  uint32_t ms = 30000UL;
  TEST_ASSERT_TRUE(devlink::parseHeartbeatInterval(cadence, len(cadence), ms));
  TEST_ASSERT_EQUAL_UINT32(60000UL, ms);

  const char courtsBody[] = "{\"tenant_slug\":\"court_numbers\",\"device_code\":\"court-box-1\","
                            "\"court_numbers\":[7,8],\"roster\":[]}";
  int16_t courts[devlink::kMaxCourts] = {-1, -1, -1, -1};
  uint8_t count = 99U;
  TEST_ASSERT_TRUE(devlink::parseCourtNumbers(courtsBody, len(courtsBody), courts, count));
  TEST_ASSERT_EQUAL_UINT8(2U, count);
  TEST_ASSERT_EQUAL_INT16(7, courts[0]);
  TEST_ASSERT_EQUAL_INT16(8, courts[1]);

  const char rosterBody[] = "{\"tenant_slug\":\"roster\",\"device_code\":\"court-box-1\","
                            "\"court_numbers\":[7,8],\"roster\":[\"7Q3F9KM2XZ8B|0|-120|2580\"]}";
  Cache cache(kSixHoursMs);
  const devlink::SyncResult result = devlink::applyRoster(rosterBody, len(rosterBody), cache, kBaseMid);
  TEST_ASSERT_TRUE(result.replaced);
  TEST_ASSERT_EQUAL_UINT8(1U, result.accepted);
  TEST_ASSERT_EQUAL_UINT8(0U, result.rejected);
}

/// The same, one level worse: the club's slug names the key AND a button-map
/// element does too. `button_map` is eight strings an admin types by hand, and
/// they sit between `tenant_slug` and `roster` on every court-box heartbeat.
void test_a_button_map_element_that_names_a_key_hides_nothing() {
  const char body[] = "{\"tenant_slug\":\"crusaders\",\"heartbeat_seconds\":60,"
                      "\"config\":{\"button_map\":[\"roster\",\"court:B\"]},"
                      "\"roster\":[\"7Q3F9KM2XZ8B|0|-120|2580\"]}";
  Cache cache(kSixHoursMs);
  const devlink::SyncResult result = devlink::applyRoster(body, len(body), cache, kBaseMid);
  TEST_ASSERT_TRUE(result.replaced);
  TEST_ASSERT_EQUAL_UINT8(1U, result.accepted);
  TEST_ASSERT_EQUAL_UINT8(0U, result.rejected);
}

// -------------------------------------------------------------------------
// EventUpload and Cadence — the bodies, across the millis() wrap
// -------------------------------------------------------------------------

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

  char body[devlink::kEventBodyCap] = {};
  const size_t len = devlink::renderEventBody(body, sizeof(body), "5ccf7f0a1b2c", now, event);
  TEST_ASSERT_TRUE(len > 0U);
  TEST_ASSERT_EQUAL_size_t(strlen(body), len);
  TEST_ASSERT_NOT_NULL(strstr(body, "{\"mac\":\"5ccf7f0a1b2c\","));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"uptime_ms\":4294987296,"));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"uptime_ms\":4294963200,"));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"kind\":\"activation\""));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"court\":1"));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"method\":\"qr\""));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"subject\":\"TOKEN-B\""));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"duration_ms\":2700000"));

  // The ordinary case is unchanged: no wrap, no widening.
  event.uptimeMs = 90000UL;
  TEST_ASSERT_TRUE(devlink::renderEventBody(body, sizeof(body), "5ccf7f0a1b2c", 120000ULL, event) > 0U);
  TEST_ASSERT_NOT_NULL(strstr(body, "\"uptime_ms\":120000,"));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"uptime_ms\":90000,"));

  // A release carries no identification method, and says so as a null rather
  // than as the string "none".
  eventq::Event release;
  release.seq = 42U;
  release.kind = eventq::Kind::Release;
  release.court = eventq::Event::kNoCourt;
  release.uptimeMs = 1000UL;
  TEST_ASSERT_TRUE(devlink::renderEventBody(body, sizeof(body), "5ccf7f0a1b2c", 2000ULL, release) > 0U);
  TEST_ASSERT_NOT_NULL(strstr(body, "\"method\":null"));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"court\":-1"));

  // Refused rather than truncated: a half-rendered body comes back 4xx and the
  // drain path drops the event as one the box caused.
  char tiny[24] = {};
  TEST_ASSERT_EQUAL_size_t(0U,
                           devlink::renderEventBody(tiny, sizeof(tiny), "5ccf7f0a1b2c", 2000ULL, release));
  TEST_ASSERT_EQUAL_STRING("", tiny);

  // And never without a MAC: an events batch that names no device is one the
  // server cannot file against a box.
  TEST_ASSERT_EQUAL_size_t(0U, devlink::renderEventBody(body, sizeof(body), "", 2000ULL, release));
}

void test_heartbeat_body_names_the_box_and_survives_the_millis_wrap() {
  // The one field an auto-registering backend keys everything off. It was a
  // snprintf in the composition root, which `pio test` cannot see — so this is
  // the first version of it any test has been able to reach.
  char body[devlink::kHeartbeatBodyCap] = {};
  const size_t len = devlink::renderHeartbeatBody(body, sizeof(body), "5ccf7f0a1b2c", "2.0.0", 86400000ULL);
  TEST_ASSERT_TRUE(len > 0U);
  TEST_ASSERT_EQUAL_size_t(strlen(body), len);
  TEST_ASSERT_EQUAL_STRING("{\"mac\":\"5ccf7f0a1b2c\",\"firmware_version\":\"2.0.0\",\"uptime_ms\":86400000}",
                           body);

  // Past 2^32: a 32-bit conversion here would report a box that had been up for
  // two months as one that had been up for ten days.
  TEST_ASSERT_TRUE(devlink::renderHeartbeatBody(body, sizeof(body), "5ccf7f0a1b2c", "2.0.0",
                                                0x100000000ULL + 20000ULL) > 0U);
  TEST_ASSERT_NOT_NULL(strstr(body, "\"uptime_ms\":4294987296}"));

  // Refused rather than truncated, and never without a MAC.
  char tiny[16] = {};
  TEST_ASSERT_EQUAL_size_t(
      0U, devlink::renderHeartbeatBody(tiny, sizeof(tiny), "5ccf7f0a1b2c", "2.0.0", 1000ULL));
  TEST_ASSERT_EQUAL_STRING("", tiny);
  TEST_ASSERT_EQUAL_size_t(0U, devlink::renderHeartbeatBody(body, sizeof(body), "", "2.0.0", 1000ULL));
  TEST_ASSERT_EQUAL_size_t(0U, devlink::renderHeartbeatBody(body, sizeof(body), nullptr, "2.0.0", 1000ULL));
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

  RUN_TEST(test_court_numbers_are_read_by_relay_position);
  RUN_TEST(test_court_numbers_that_cannot_be_a_court_set_leave_the_previous_one_alone);

  RUN_TEST(test_breaker_opens_after_two_transport_failures_and_backs_off_doubling);
  RUN_TEST(test_breaker_any_answer_closes_it_and_resets_the_window);

  RUN_TEST(test_heartbeat_interval_is_adopted_and_bounded);
  RUN_TEST(test_a_tenant_slug_that_names_a_key_hides_nothing);
  RUN_TEST(test_a_button_map_element_that_names_a_key_hides_nothing);

  RUN_TEST(test_the_event_body_carries_a_64_bit_uptime_across_the_millis_wrap);
  RUN_TEST(test_heartbeat_body_names_the_box_and_survives_the_millis_wrap);

  return UNITY_END();
}

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
#include "devlink/LcdSettings.h"
#include "devlink/RelayRestore.h"
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

/// MUTATION-PROVED. A response body that does not END in a complete JSON
/// document is a TRUNCATED push, not a shorter roster — the transport cut it,
/// the server did not cancel anything. Committing what arrived replaces a
/// sixteen-entry roster with the eleven that fit AND re-stamps it fresh, so the
/// five members whose bytes were lost are refused for a full six hours with
/// nothing anywhere saying why. Delete the completeness check and this goes red.
void test_apply_roster_a_truncated_body_never_replaces_the_roster() {
  const char* truncated[] = {
      // Cut mid-element: the walk ends on an unterminated string.
      "{\"roster\":[\"TOKALICE|1|0|3600\",\"TOKBOB|2|0|3600\",\"TOKCA",
      // Cut after a complete element, before the closing bracket.
      "{\"roster\":[\"TOKALICE|1|0|3600\",\"TOKBOB|2|0|3600\"",
      // Cut after the bracket, before the closing brace.
      "{\"roster\":[\"TOKALICE|1|0|3600\"]",
  };

  for (const char* body : truncated) {
    Cache cache(kSixHoursMs);
    const roster::Entry entries[] = {booking("TOKZARA", 1U, 0U, kHourMs)};
    loadRoster(cache, kBaseMid, entries, 1U);

    const devlink::SyncResult r = devlink::applyRoster(body, strlen(body), cache, kBaseMid + 30000U);

    TEST_ASSERT_FALSE_MESSAGE(r.replaced, body);
    // The OLD roster is still there, still serving, and still ageing from the
    // load that filled it — a truncated push is not a heartbeat.
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(1U, cache.size(), body);
    TEST_ASSERT_TRUE(cache.decide("TOKZARA", 1U, kBaseMid + 60000U).verdict == roster::Verdict::Allow);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(60000U, cache.ageMs(kBaseMid + 60000U), body);
  }
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

/// R15 D15-1. The server answers a body it cannot parse with 400
/// `malformed_body` (it answered 500, which the breaker counted). A 400 is the
/// API THERE and saying no: it must never count toward a trip, and it must
/// reset the run of failures before it, so a box whose drain keeps meeting one
/// unparseable event between two blips is not judged down.
void test_breaker_a_400_malformed_body_is_not_a_transport_failure() {
  TEST_ASSERT_FALSE(devlink::isTransportFailure(400U));
  TEST_ASSERT_FALSE(devlink::isTransportFailure(413U));
  TEST_ASSERT_FALSE(devlink::isTransportFailure(422U));

  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    devlink::ApiBreaker breaker;
    for (uint32_t pass = 0U; pass < 10U; ++pass) {
      breaker.onResult(400U, base + pass);
      TEST_ASSERT_FALSE(breaker.open(base + pass));
      TEST_ASSERT_EQUAL_UINT8(0U, breaker.consecutiveFailures());
    }
    breaker.onResult(500U, base + 20U);
    breaker.onResult(400U, base + 21U);
    breaker.onResult(500U, base + 22U);
    TEST_ASSERT_FALSE(breaker.open(base + 23U));
    TEST_ASSERT_EQUAL_UINT16(0U, breaker.trips());
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
  const size_t len = devlink::renderEventBody(body, sizeof(body), "5ccf7f0a1b2c", 0U, now, event);
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
  TEST_ASSERT_TRUE(devlink::renderEventBody(body, sizeof(body), "5ccf7f0a1b2c", 0U, 120000ULL, event) > 0U);
  TEST_ASSERT_NOT_NULL(strstr(body, "\"uptime_ms\":120000,"));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"uptime_ms\":90000,"));

  // A release carries no identification method, and says so as a null rather
  // than as the string "none".
  eventq::Event release;
  release.seq = 42U;
  release.kind = eventq::Kind::Release;
  release.court = eventq::Event::kNoCourt;
  release.uptimeMs = 1000UL;
  TEST_ASSERT_TRUE(devlink::renderEventBody(body, sizeof(body), "5ccf7f0a1b2c", 0U, 2000ULL, release) > 0U);
  TEST_ASSERT_NOT_NULL(strstr(body, "\"method\":null"));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"court\":-1"));

  // Refused rather than truncated: a half-rendered body comes back 4xx and the
  // drain path drops the event as one the box caused.
  char tiny[24] = {};
  TEST_ASSERT_EQUAL_size_t(
      0U, devlink::renderEventBody(tiny, sizeof(tiny), "5ccf7f0a1b2c", 0U, 2000ULL, release));
  TEST_ASSERT_EQUAL_STRING("", tiny);

  // And never without a MAC: an events batch that names no device is one the
  // server cannot file against a box.
  TEST_ASSERT_EQUAL_size_t(0U, devlink::renderEventBody(body, sizeof(body), "", 0U, 2000ULL, release));

  // NOR WITH ONE THAT IS NOT A MAC (round G4, B1). It is the only other `%s` in
  // this body, and both composition roots render it from dc::hex::encodeLower,
  // so anything else is a board that has got its own identity wrong. REFUSED
  // rather than escaped: escaping would hide that, and there is nothing useful
  // a server can do with a device name nobody minted.
  static const char* kNotAMac[] = {
      "5ccf7f0a1b2",                 // eleven
      "5ccf7f0a1b2cd",               // thirteen
      "5CCF7F0A1B2C",                // uppercase, which encodeLower never emits
      "5ccf7f0a1b2g",                // not hex
      "\",\"uptime_ms\":1,\"x\":\"", // the B1 shape, from the other field
  };
  for (size_t i = 0U; i < sizeof(kNotAMac) / sizeof(kNotAMac[0]); ++i) {
    TEST_ASSERT_EQUAL_size_t_MESSAGE(
        0U, devlink::renderEventBody(body, sizeof(body), kNotAMac[i], 0U, 2000ULL, release), kNotAMac[i]);
    TEST_ASSERT_EQUAL_STRING_MESSAGE("", body, kNotAMac[i]);
  }
}

/// G4 / B1. The shared renderer is safe on ITS OWN, whatever fed the subject —
/// the court box's serial link as much as the gate's scanner. Fuzzed over the
/// metacharacters, against the one structural fact a forged field has to break.
void test_the_event_body_escapes_a_subject_whatever_bytes_are_in_it() {
  // And the bytes the Mega passes through from the scanner above 0x7f (R15
  // D15-1): a lone 0xE9 is invalid UTF-8, and the server refused the body.
  static const char kAlphabet[] = "\"\\:,{}[]abAB01-_ \t\n\r\x01\x1f\x7f\x80\xc3\xa9\xe9\xff";
  const size_t alphabetLen = sizeof(kAlphabet) - 1U;

  uint32_t state = 0x2468ACE1U;
  for (int iteration = 0; iteration < 20000; ++iteration) {
    eventq::Event event;
    event.seq = 11U;
    event.kind = eventq::Kind::UnknownScan;
    event.court = eventq::Event::kNoCourt;
    event.method = eventq::Method::Qr;
    event.uptimeMs = 500U;

    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    const uint8_t length = static_cast<uint8_t>(state % (eventq::kMaxSubjectLen + 1U));
    for (uint8_t i = 0U; i < length; ++i) {
      state ^= state << 13;
      state ^= state >> 17;
      state ^= state << 5;
      event.subject[i] = kAlphabet[state % alphabetLen];
    }
    event.subjectLen = length;

    char body[devlink::kEventBodyCap] = {};
    const size_t written = devlink::renderEventBody(body, sizeof(body), "5ccf7f0a1b2c", 0U, 2000ULL, event);
    TEST_ASSERT_TRUE_MESSAGE(written > 0U, "a subject inside the cap must always render");

    // Ten keys and four quoted values: twenty-eight quotes that are not
    // preceded by an odd number of backslashes, and no more. A byte that
    // escaped the string adds two.
    size_t quotes = 0U;
    size_t slashes = 0U;
    for (size_t i = 0U; body[i] != '\0'; ++i) {
      if (body[i] == '\\') {
        ++slashes;
        continue;
      }
      if (body[i] == '"' && (slashes % 2U) == 0U) {
        ++quotes;
      }
      slashes = 0U;
    }
    TEST_ASSERT_EQUAL_size_t_MESSAGE(28U, quotes, body);
    TEST_ASSERT_NOT_NULL_MESSAGE(strstr(body, "\"seq\":11,"), body);
    TEST_ASSERT_NOT_NULL_MESSAGE(strstr(body, "\"kind\":\"unknown_scan\""), body);
    // AND NO RAW CONTROL BYTE, which is not legal JSON at all, and NO BYTE
    // ABOVE 0x7F, which is not valid UTF-8 on its own: a body the server
    // cannot parse is one it answered 500, which pinned the queue (D15-1).
    for (size_t i = 0U; body[i] != '\0'; ++i) {
      TEST_ASSERT_TRUE_MESSAGE(static_cast<unsigned char>(body[i]) >= 0x20U, body);
      TEST_ASSERT_TRUE_MESSAGE(static_cast<unsigned char>(body[i]) < 0x80U, body);
    }
  }
}

// -------------------------------------------------------------------------
// LcdSettings — the nine operator settings inside the heartbeat's `config`
// -------------------------------------------------------------------------
//
// THE HOUSE RULE, nine times over: the server may NARROW, the box CLAMPS, and
// an ABSENT key changes nothing. Every one of these is a number an admin types
// into a web form, and none of them may be able to blank what an earlier
// heartbeat configured or to refuse the eight beside it.

/// All nine at once, at values that are not the defaults and are inside every
/// bound, out of the NESTED `config` object — which is where the court box
/// already reads `slice_minutes` and `walk_up_max_minutes` from.
void test_lcd_settings_adopts_all_nine_from_the_nested_config() {
  const char body[] = "{\"server_time\":\"2023-11-14T22:13:20+00:00\",\"tenant_slug\":\"crusaders\","
                      "\"heartbeat_seconds\":60,"
                      "\"config\":{\"slice_minutes\":15,\"walk_up_max_minutes\":60,"
                      "\"lcd_revert_seconds\":25,\"lcd_choice_seconds\":45,\"lcd_card_seconds\":6,"
                      "\"lcd_hint_seconds\":7,\"scan_memory_seconds\":200,"
                      "\"clock_trust_minutes\":240,\"relay_restore_enabled\":false,"
                      "\"device_fault_reporting\":false,\"device_fault_max_per_hour\":75},"
                      "\"roster\":[]}";

  devlink::LcdSettings s;
  TEST_ASSERT_TRUE(devlink::parseLcdSettings(body, len(body), s));
  TEST_ASSERT_EQUAL_UINT32(25000UL, s.revertMs);
  TEST_ASSERT_EQUAL_UINT32(45000UL, s.choiceMs);
  TEST_ASSERT_EQUAL_UINT32(6000UL, s.cardMs);
  TEST_ASSERT_EQUAL_UINT32(7000UL, s.hintMs);
  TEST_ASSERT_EQUAL_UINT32(200000UL, s.scanMemoryMs);
  TEST_ASSERT_EQUAL_UINT32(240UL * 60000UL, s.clockTrustMs);
  TEST_ASSERT_FALSE(s.relayRestoreEnabled);
  TEST_ASSERT_FALSE(s.faultReporting);
  TEST_ASSERT_EQUAL_UINT16(75U, s.faultMaxPerHour);
}

/// Every key at BOTH bounds and one past each. A value out of range is CLAMPED
/// and never refuses the eight beside it — a club that typed 600 into one box
/// must not thereby lose its button map, its card dwell and its fault rate.
void test_lcd_settings_clamps_each_key_at_both_bounds_and_past_them() {
  const char low[] = "{\"config\":{\"lcd_revert_seconds\":3,\"lcd_choice_seconds\":5,"
                     "\"lcd_card_seconds\":1,\"lcd_hint_seconds\":1,\"scan_memory_seconds\":5,"
                     "\"clock_trust_minutes\":5,\"device_fault_max_per_hour\":1}}";
  devlink::LcdSettings s;
  TEST_ASSERT_TRUE(devlink::parseLcdSettings(low, len(low), s));
  TEST_ASSERT_EQUAL_UINT32(3000UL, s.revertMs);
  TEST_ASSERT_EQUAL_UINT32(5000UL, s.choiceMs);
  TEST_ASSERT_EQUAL_UINT32(1000UL, s.cardMs);
  TEST_ASSERT_EQUAL_UINT32(1000UL, s.hintMs);
  TEST_ASSERT_EQUAL_UINT32(5000UL, s.scanMemoryMs);
  TEST_ASSERT_EQUAL_UINT32(5UL * 60000UL, s.clockTrustMs);
  TEST_ASSERT_EQUAL_UINT16(1U, s.faultMaxPerHour);

  const char high[] = "{\"config\":{\"lcd_revert_seconds\":60,\"lcd_choice_seconds\":60,"
                      "\"lcd_card_seconds\":10,\"lcd_hint_seconds\":10,\"scan_memory_seconds\":300,"
                      "\"clock_trust_minutes\":1440,\"device_fault_max_per_hour\":120}}";
  TEST_ASSERT_TRUE(devlink::parseLcdSettings(high, len(high), s));
  TEST_ASSERT_EQUAL_UINT32(60000UL, s.revertMs);
  TEST_ASSERT_EQUAL_UINT32(60000UL, s.choiceMs);
  TEST_ASSERT_EQUAL_UINT32(10000UL, s.cardMs);
  TEST_ASSERT_EQUAL_UINT32(10000UL, s.hintMs);
  TEST_ASSERT_EQUAL_UINT32(300000UL, s.scanMemoryMs);
  TEST_ASSERT_EQUAL_UINT32(1440UL * 60000UL, s.clockTrustMs);
  TEST_ASSERT_EQUAL_UINT16(120U, s.faultMaxPerHour);

  // One BELOW every floor: clamped up, not refused, not left alone.
  const char under[] = "{\"config\":{\"lcd_revert_seconds\":2,\"lcd_choice_seconds\":4,"
                       "\"lcd_card_seconds\":0,\"lcd_hint_seconds\":0,\"scan_memory_seconds\":0,"
                       "\"clock_trust_minutes\":4,\"device_fault_max_per_hour\":0}}";
  TEST_ASSERT_TRUE(devlink::parseLcdSettings(under, len(under), s));
  TEST_ASSERT_EQUAL_UINT32(3000UL, s.revertMs);
  TEST_ASSERT_EQUAL_UINT32(5000UL, s.choiceMs);
  TEST_ASSERT_EQUAL_UINT32(1000UL, s.cardMs);
  TEST_ASSERT_EQUAL_UINT32(1000UL, s.hintMs);
  TEST_ASSERT_EQUAL_UINT32(5000UL, s.scanMemoryMs); // the choice floor, via the invariant
  TEST_ASSERT_EQUAL_UINT32(5UL * 60000UL, s.clockTrustMs);
  TEST_ASSERT_EQUAL_UINT16(1U, s.faultMaxPerHour);

  // One ABOVE every ceiling, and a value whose milliseconds would wrap a
  // uint32_t if it were multiplied before it was bounded — the Cadence rule:
  // clamp in seconds FIRST or 4,300,000 becomes a plausible small number.
  const char over[] = "{\"config\":{\"lcd_revert_seconds\":61,\"lcd_choice_seconds\":4300000,"
                      "\"lcd_card_seconds\":11,\"lcd_hint_seconds\":11,\"scan_memory_seconds\":4300000,"
                      "\"clock_trust_minutes\":4300000,\"device_fault_max_per_hour\":121}}";
  TEST_ASSERT_TRUE(devlink::parseLcdSettings(over, len(over), s));
  TEST_ASSERT_EQUAL_UINT32(60000UL, s.revertMs);
  TEST_ASSERT_EQUAL_UINT32(60000UL, s.choiceMs);
  TEST_ASSERT_EQUAL_UINT32(10000UL, s.cardMs);
  TEST_ASSERT_EQUAL_UINT32(10000UL, s.hintMs);
  TEST_ASSERT_EQUAL_UINT32(300000UL, s.scanMemoryMs);
  TEST_ASSERT_EQUAL_UINT32(1440UL * 60000UL, s.clockTrustMs);
  TEST_ASSERT_EQUAL_UINT16(120U, s.faultMaxPerHour);
}

/// An absent key leaves that setting exactly where it was. This is what stops
/// an older API blanking what a newer one configured — and it is per KEY, not
/// per response: a `config` carrying one of the nine adopts one and leaves
/// eight alone.
void test_lcd_settings_an_absent_key_leaves_that_setting_alone() {
  devlink::LcdSettings s;
  const char one[] = "{\"config\":{\"lcd_card_seconds\":9}}";
  TEST_ASSERT_TRUE(devlink::parseLcdSettings(one, len(one), s));
  TEST_ASSERT_EQUAL_UINT32(9000UL, s.cardMs);
  TEST_ASSERT_EQUAL_UINT32(devlink::kLcdRevertDefaultMs, s.revertMs);
  TEST_ASSERT_EQUAL_UINT32(devlink::kLcdChoiceDefaultMs, s.choiceMs);
  TEST_ASSERT_EQUAL_UINT32(devlink::kLcdHintDefaultMs, s.hintMs);
  TEST_ASSERT_EQUAL_UINT32(devlink::kScanMemoryDefaultMs, s.scanMemoryMs);
  TEST_ASSERT_EQUAL_UINT32(devlink::kClockTrustDefaultMs, s.clockTrustMs);
  TEST_ASSERT_TRUE(s.relayRestoreEnabled);
  TEST_ASSERT_TRUE(s.faultReporting);
  TEST_ASSERT_EQUAL_UINT16(devlink::kFaultMaxPerHourDefault, s.faultMaxPerHour);

  // A `config` with none of the nine, a `config` that is not an object, and no
  // `config` at all: false, and every adopted value survives untouched.
  const char none[] = "{\"config\":{\"slice_minutes\":15,\"button_map\":[\"court:A\"]},\"roster\":[]}";
  TEST_ASSERT_FALSE(devlink::parseLcdSettings(none, len(none), s));
  TEST_ASSERT_EQUAL_UINT32(9000UL, s.cardMs);

  const char notObject[] = "{\"config\":42,\"lcd_card_seconds\":1}";
  TEST_ASSERT_FALSE(devlink::parseLcdSettings(notObject, len(notObject), s));
  TEST_ASSERT_EQUAL_UINT32(9000UL, s.cardMs);

  const char absent[] = "{\"heartbeat_seconds\":60,\"roster\":[]}";
  TEST_ASSERT_FALSE(devlink::parseLcdSettings(absent, len(absent), s));
  TEST_ASSERT_EQUAL_UINT32(9000UL, s.cardMs);

  TEST_ASSERT_FALSE(devlink::parseLcdSettings(nullptr, 32U, s));
}

/// THE CROSS-KEY INVARIANT, and it is load-bearing. `scan_memory_seconds` is
/// how long the bridge remembers who scanned; `lcd_choice_seconds` is how long
/// the pad keeps their selection on screen. If the pad outlives the memory, a
/// member who scans, wanders off and comes back finds their selection still
/// showing while the bridge has forgotten who they are — and the NEXT person's
/// presses buy on that member's token.
///
/// RAISED, NEVER LOWERED. Lowering `lcd_choice_seconds` to fit would shorten a
/// window somebody may be standing in front of mid-purchase.
void test_lcd_settings_raise_scan_memory_and_never_lower_the_choice_window() {
  devlink::LcdSettings s;

  // The pad is told to hold for a minute while the memory is told 10 s.
  const char inverted[] = "{\"config\":{\"lcd_choice_seconds\":60,\"scan_memory_seconds\":10}}";
  TEST_ASSERT_TRUE(devlink::parseLcdSettings(inverted, len(inverted), s));
  TEST_ASSERT_EQUAL_UINT32(60000UL, s.choiceMs); // untouched
  TEST_ASSERT_EQUAL_UINT32(60000UL, s.scanMemoryMs);
  TEST_ASSERT_TRUE(s.scanMemoryMs >= s.choiceMs);

  // And ACROSS heartbeats, which is the case a per-response check would miss:
  // a later response raises only the choice window, and the memory it was
  // already carrying has to come up with it.
  devlink::LcdSettings later;
  const char memoryFirst[] = "{\"config\":{\"scan_memory_seconds\":20}}";
  TEST_ASSERT_TRUE(devlink::parseLcdSettings(memoryFirst, len(memoryFirst), later));
  TEST_ASSERT_EQUAL_UINT32(20000UL, later.scanMemoryMs);
  const char choiceOnly[] = "{\"config\":{\"lcd_choice_seconds\":50}}";
  TEST_ASSERT_TRUE(devlink::parseLcdSettings(choiceOnly, len(choiceOnly), later));
  TEST_ASSERT_EQUAL_UINT32(50000UL, later.choiceMs);
  TEST_ASSERT_EQUAL_UINT32(50000UL, later.scanMemoryMs);

  // The compile-time pair holds too, which is what the static_assert in the
  // header pins; asserted here as well so a reader of the suite can see it.
  TEST_ASSERT_TRUE(devlink::kScanMemoryDefaultMs >= devlink::kLcdChoiceDefaultMs);
}

/// A DECOY AT A DEEPER LEVEL, before AND after the real key. `devapi::json`'s
/// flat scan is depended upon elsewhere and takes the FIRST match in document
/// order, so a `config` read flatly would take a number out of the roster, the
/// button map or any object a later contract nests — which is round G4's B2
/// with a screen timeout instead of a lock. These are read one level deep,
/// from the TOP-LEVEL `config` and nowhere else.
void test_lcd_settings_a_decoy_at_a_deeper_level_is_not_adopted() {
  devlink::LcdSettings s;

  // Before: a nested object inside `config` naming every key.
  const char before[] = "{\"config\":{\"vendor\":{\"lcd_revert_seconds\":59,\"lcd_card_seconds\":9,"
                        "\"device_fault_max_per_hour\":119,\"relay_restore_enabled\":false},"
                        "\"lcd_revert_seconds\":30,\"lcd_card_seconds\":4,"
                        "\"device_fault_max_per_hour\":30}}";
  TEST_ASSERT_TRUE(devlink::parseLcdSettings(before, len(before), s));
  TEST_ASSERT_EQUAL_UINT32(30000UL, s.revertMs);
  TEST_ASSERT_EQUAL_UINT32(4000UL, s.cardMs);
  TEST_ASSERT_EQUAL_UINT16(30U, s.faultMaxPerHour);
  TEST_ASSERT_TRUE(s.relayRestoreEnabled); // the decoy's false never reached it

  // After: the real key first, the decoy behind it — the case a scan bounded
  // at the START of the object but not at its END would still get wrong.
  devlink::LcdSettings after;
  const char afterBody[] = "{\"config\":{\"lcd_hint_seconds\":5,"
                           "\"vendor\":{\"lcd_hint_seconds\":9}},"
                           "\"lcd_hint_seconds\":8,\"diagnostics\":{\"lcd_hint_seconds\":2}}";
  TEST_ASSERT_TRUE(devlink::parseLcdSettings(afterBody, len(afterBody), after));
  TEST_ASSERT_EQUAL_UINT32(5000UL, after.hintMs);

  // A TOP-LEVEL key of the same name is not a config key either: these are
  // `config` members, and a club that grows a top-level `lcd_card_seconds`
  // must not silently start driving the screen from it.
  devlink::LcdSettings topLevel;
  const char outside[] = "{\"lcd_card_seconds\":9,\"config\":{\"slice_minutes\":15}}";
  TEST_ASSERT_FALSE(devlink::parseLcdSettings(outside, len(outside), topLevel));
  TEST_ASSERT_EQUAL_UINT32(devlink::kLcdCardDefaultMs, topLevel.cardMs);

  // AND A CONFIG OBJECT NESTED SOMEWHERE ELSE IS NOT THE CONFIG OBJECT. A
  // `config` inside the roster or a vendor block, placed before the real one,
  // is what the flat scan would have read.
  devlink::LcdSettings nested;
  const char nestedConfig[] = "{\"vendor\":{\"config\":{\"lcd_card_seconds\":9}},"
                              "\"config\":{\"lcd_card_seconds\":4}}";
  TEST_ASSERT_TRUE(devlink::parseLcdSettings(nestedConfig, len(nestedConfig), nested));
  TEST_ASSERT_EQUAL_UINT32(4000UL, nested.cardMs);
}

/// The wrong JSON type, a quoted integer, and a body cut off inside `config`.
/// Every one is reported as ABSENCE — "learned nothing" — and never as a
/// default, because a default here would blank a setting an admin chose.
void test_lcd_settings_a_wrong_type_or_a_cut_body_adopts_nothing() {
  devlink::LcdSettings s;
  const char seeded[] = "{\"config\":{\"lcd_revert_seconds\":25,\"relay_restore_enabled\":false,"
                        "\"device_fault_max_per_hour\":75}}";
  TEST_ASSERT_TRUE(devlink::parseLcdSettings(seeded, len(seeded), s));

  static const char* kUnreadable[] = {
      "{\"config\":{\"lcd_revert_seconds\":\"30\"}}",        // quoted integer
      "{\"config\":{\"lcd_revert_seconds\":null}}",          // null
      "{\"config\":{\"lcd_revert_seconds\":[30]}}",          // an array
      "{\"config\":{\"lcd_revert_seconds\":{\"v\":30}}}",    // an object
      "{\"config\":{\"lcd_revert_seconds\":-30}}",           // signed
      "{\"config\":{\"relay_restore_enabled\":\"true\"}}",   // a quoted boolean
      "{\"config\":{\"relay_restore_enabled\":1}}",          // 1 is not `true`
      "{\"config\":{\"device_fault_reporting\":\"false\"}}", // the same, the other flag
  };
  for (size_t i = 0U; i < sizeof(kUnreadable) / sizeof(kUnreadable[0]); ++i) {
    devlink::LcdSettings probe = s;
    TEST_ASSERT_FALSE_MESSAGE(devlink::parseLcdSettings(kUnreadable[i], strlen(kUnreadable[i]), probe),
                              kUnreadable[i]);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(25000UL, probe.revertMs, kUnreadable[i]);
    TEST_ASSERT_FALSE_MESSAGE(probe.relayRestoreEnabled, kUnreadable[i]);
    TEST_ASSERT_EQUAL_UINT16_MESSAGE(75U, probe.faultMaxPerHour, kUnreadable[i]);
  }

  // A FRACTION IS READ AS ITS INTEGER PART, and that is devapi's behaviour
  // rather than this parser's: `readUnsigned` stops at the `.` and reports the
  // digits it took, so `30.5` adopts 30. `devapi::json::unsignedField`'s own
  // doc comment says it is false when "the value is not a bare integer", and
  // 30.5 is not one — every caller of it in this tree inherits the same
  // narrowing, `heartbeat_seconds` and `granted_seconds` included. Pinned here
  // as what actually happens rather than left to look like a passing case;
  // fixing it is devapi's, not devlink's.
  {
    devlink::LcdSettings fraction = s;
    const char body[] = "{\"config\":{\"lcd_revert_seconds\":30.5}}";
    TEST_ASSERT_TRUE(devlink::parseLcdSettings(body, len(body), fraction));
    TEST_ASSERT_EQUAL_UINT32(30000UL, fraction.revertMs);
  }

  // Cut inside the config object, and cut inside one of its strings. The
  // object never balances, so there is no `config` to read — which is the
  // right answer: half a settings block is not a settings block.
  static const char* kCut[] = {
      "{\"config\":{\"lcd_revert_seconds\":30",
      "{\"config\":{\"lcd_revert_seconds\":30,\"device_code\":\"court-bo",
      "{\"config\":{",
  };
  for (size_t i = 0U; i < sizeof(kCut) / sizeof(kCut[0]); ++i) {
    devlink::LcdSettings probe = s;
    TEST_ASSERT_FALSE_MESSAGE(devlink::parseLcdSettings(kCut[i], strlen(kCut[i]), probe), kCut[i]);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(25000UL, probe.revertMs, kCut[i]);
  }
}

// -------------------------------------------------------------------------
// RelayRestore — what should be on after a power dip (GOAL 17)
// -------------------------------------------------------------------------
//
// Today a power dip loses every lit court and there is no restore path
// anywhere: the Mega's begin() opens every relay — correct, and what makes a
// watchdog reset safe — the bridge sets every court dark as of now, and the
// heartbeat response carries no relay state at all. The member's booking is
// still live, they are still charged, and the roster will not re-grant them.
//
// The wire is an array of PIPE-DELIMITED STRINGS rather than objects, for the
// same reason the roster's is: this end has a heapless JSON SCANNER, not a
// parser, and `devapi::json` offers no object-array walker. Adding one is a new
// failure surface for no gain.

/// `cap` for these fixtures. Four is the widest relay bank in the tree today,
/// but it is the CALLER's number rather than devlink's — this library takes a
/// plain array and a capacity and knows nothing about a court. The assertion
/// that four is THIS box's number lives on the device side, the way
/// `bridgelogic/RosterTokenFits.h` does.
constexpr uint8_t kRestoreCap = 4U;

const char* kRestoreTwo = "{\"server_time\":\"2023-11-14T22:13:20+00:00\","
                          "\"relays\":[\"0|1834|3fa85f64\",\"2|600|9c1d0e22\"],\"roster\":[]}";

void test_relay_restore_reads_two_relays_and_their_true_remainder() {
  devlink::RelayRestore out[kRestoreCap];
  uint8_t count = 99U;
  uint8_t rejected = 99U;
  TEST_ASSERT_TRUE(
      devlink::parseRelayRestore(kRestoreTwo, len(kRestoreTwo), out, kRestoreCap, count, &rejected));
  TEST_ASSERT_EQUAL_UINT8(2U, count);
  TEST_ASSERT_EQUAL_UINT8(0U, rejected);

  TEST_ASSERT_EQUAL_UINT8(0U, out[0].relay);
  TEST_ASSERT_EQUAL_UINT32(1834UL, out[0].remainingSeconds);
  TEST_ASSERT_EQUAL_STRING("3fa85f64", out[0].bookingRef);
  TEST_ASSERT_EQUAL_UINT8(2U, out[1].relay);
  TEST_ASSERT_EQUAL_UINT32(600UL, out[1].remainingSeconds);
  TEST_ASSERT_EQUAL_STRING("9c1d0e22", out[1].bookingRef);

  // NO CLOCK IS READ, and that is the property that makes the restore safe on a
  // box whose clock is unknown: `remaining_seconds` is relative to the instant
  // the response was produced, exactly like the roster's opens_in/closes_in.
  // Run at every base the suites use — the answer cannot move, because there is
  // no `millis()` anywhere in the path.
  for (size_t i = 0U; i < kBaseCount; ++i) {
    devlink::RelayRestore again[kRestoreCap];
    uint8_t n = 0U;
    TEST_ASSERT_TRUE(devlink::parseRelayRestore(kRestoreTwo, len(kRestoreTwo), again, kRestoreCap, n));
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(2U, n, "the restore must not depend on a clock");
    TEST_ASSERT_EQUAL_UINT32(1834UL, again[0].remainingSeconds);
    static_cast<void>(kBases[i]);
  }
}

/// THE THREE ABSENCES, and they mean three different things.
///
///   * key ABSENT — this API does not do restore. Nothing is switched, and a
///     box must not wait for one.
///   * EMPTY ARRAY — nothing should be on. Still switches NOTHING OFF: making
///     an empty array an off-command would hand the API a way to darken a court
///     mid-game, which it must not have.
///   * NOT AN ARRAY — read as absent, so a contract drift cannot be acted on.
void test_relay_restore_absent_and_empty_are_not_an_off_command() {
  devlink::RelayRestore out[kRestoreCap];
  uint8_t count = 0U;
  uint8_t rejected = 0U;

  // Seed the array so an "untouched" claim means something.
  TEST_ASSERT_TRUE(
      devlink::parseRelayRestore(kRestoreTwo, len(kRestoreTwo), out, kRestoreCap, count, &rejected));

  const char absent[] = "{\"heartbeat_seconds\":60,\"roster\":[]}";
  uint8_t after = 99U;
  uint8_t afterRejected = 99U;
  TEST_ASSERT_FALSE(devlink::parseRelayRestore(absent, len(absent), out, kRestoreCap, after, &afterRejected));
  TEST_ASSERT_EQUAL_UINT8(99U, after);         // untouched
  TEST_ASSERT_EQUAL_UINT8(99U, afterRejected); // untouched
  TEST_ASSERT_EQUAL_UINT32(1834UL, out[0].remainingSeconds);

  const char notArray[] = "{\"relays\":\"0|1834|3fa85f64\"}";
  TEST_ASSERT_FALSE(devlink::parseRelayRestore(notArray, len(notArray), out, kRestoreCap, after));
  TEST_ASSERT_EQUAL_UINT8(99U, after);

  const char notArrayObject[] = "{\"relays\":{\"0\":1834}}";
  TEST_ASSERT_FALSE(devlink::parseRelayRestore(notArrayObject, len(notArrayObject), out, kRestoreCap, after));

  TEST_ASSERT_FALSE(devlink::parseRelayRestore(nullptr, 32U, out, kRestoreCap, after));

  // The empty array: a restore push that restores nothing, which is DIFFERENT
  // from no push at all — the caller learns "the server has an opinion and the
  // opinion is none" and still switches nothing off.
  const char empty[] = "{\"relays\":[],\"roster\":[]}";
  uint8_t none = 99U;
  uint8_t noneRejected = 99U;
  TEST_ASSERT_TRUE(devlink::parseRelayRestore(empty, len(empty), out, kRestoreCap, none, &noneRejected));
  TEST_ASSERT_EQUAL_UINT8(0U, none);
  TEST_ASSERT_EQUAL_UINT8(0U, noneRejected);
  // And the array the caller passed is untouched: nothing was written over it,
  // so nothing in it can be mistaken for a court to darken.
  TEST_ASSERT_EQUAL_UINT32(1834UL, out[0].remainingSeconds);
}

/// MUTATION-PROVED, and the mutant is the one the roster already refuses: a
/// TWO-DIGIT relay. `parseRelay`'s rule, verbatim — "a relay number is an
/// index, not a quantity, and a second digit means somebody is sending
/// something else". Accept `01` as relay 1 and this goes red.
void test_relay_restore_refuses_every_malformed_element_shape() {
  static const char* kMalformed[] = {
      "{\"relays\":[\"9|100|3fa85f64\"]}",      // a relay this box does not have
      "{\"relays\":[\"4|100|3fa85f64\"]}",      // one past the last
      "{\"relays\":[\"01|100|3fa85f64\"]}",     // TWO DIGITS — the mutant
      "{\"relays\":[\"00|100|3fa85f64\"]}",     // and a leading zero is not relay 0
      "{\"relays\":[\"A|100|3fa85f64\"]}",      // not a digit
      "{\"relays\":[\"|100|3fa85f64\"]}",       // no relay at all
      "{\"relays\":[\"0|abc|3fa85f64\"]}",      // non-numeric seconds
      "{\"relays\":[\"0|-100|3fa85f64\"]}",     // signed seconds
      "{\"relays\":[\"0|1e3|3fa85f64\"]}",      // exponent
      "{\"relays\":[\"0| 100|3fa85f64\"]}",     // leading space
      "{\"relays\":[\"0||3fa85f64\"]}",         // empty seconds
      "{\"relays\":[\"0|100|3fa85f64|x\"]}",    // a FOURTH field
      "{\"relays\":[\"0|100|3fa85f64|x|y\"]}",  // a FIFTH field
      "{\"relays\":[\"0|100\"]}",               // a MISSING field
      "{\"relays\":[\"0|100|\"]}",              // an empty booking ref
      "{\"relays\":[\"0|100|3fa85f64a\"]}",     // a ref past the eight-character cap
      "{\"relays\":[\"0|100|3fa85f6 \"]}",      // a ref outside the alphabet
      "{\"relays\":[\"0|100|3fa,5f64\"]}",      // the same, with a JSON metacharacter
      "{\"relays\":[\"\"]}",                    // an empty element
      "{\"relays\":[\"0|4294967296|3fa85f6\"]}" // past what a uint32_t holds
  };

  for (size_t i = 0U; i < sizeof(kMalformed) / sizeof(kMalformed[0]); ++i) {
    devlink::RelayRestore out[kRestoreCap];
    uint8_t count = 99U;
    uint8_t rejected = 99U;
    TEST_ASSERT_TRUE_MESSAGE(
        devlink::parseRelayRestore(kMalformed[i], strlen(kMalformed[i]), out, kRestoreCap, count, &rejected),
        kMalformed[i]);
    // The PUSH is still a push — the key was there, the server had an opinion.
    // The ELEMENT is refused and counted, and nothing is energised from it.
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(0U, count, kMalformed[i]);
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(1U, rejected, kMalformed[i]);
  }

  // Exactly at the bounds, all of which must be ACCEPTED, or the refusals above
  // prove nothing but that the parser refuses everything.
  static const char* kWellFormed[] = {
      "{\"relays\":[\"0|0|3fa85f64\"]}",          // relay 0, nothing remaining
      "{\"relays\":[\"3|4294967295|3fa85f64\"]}", // the last relay, the largest uint32_t
      "{\"relays\":[\"1|500|z\"]}",               // a one-character reference
      "{\"relays\":[\"2|500|ABCDEF01\"]}",        // exactly eight, upper case
  };
  for (size_t i = 0U; i < sizeof(kWellFormed) / sizeof(kWellFormed[0]); ++i) {
    devlink::RelayRestore out[kRestoreCap];
    uint8_t count = 99U;
    uint8_t rejected = 99U;
    TEST_ASSERT_TRUE_MESSAGE(devlink::parseRelayRestore(kWellFormed[i], strlen(kWellFormed[i]), out,
                                                        kRestoreCap, count, &rejected),
                             kWellFormed[i]);
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(1U, count, kWellFormed[i]);
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(0U, rejected, kWellFormed[i]);
  }
}

/// `remaining_seconds` IS THE UNCAPPED TRUE REMAINDER and the clamp is the
/// caller's. The box clamps the `!ON` to ninety minutes itself — twice, once in
/// the codec and once on the Mega — and arms its extension logic from the
/// UNCAPPED value. Capping here would hide from the bridge that the booking
/// outlives the relay deadline, which is exactly what `!EXT` exists for: the
/// court would go dark ninety minutes in with half the booking left.
void test_relay_restore_remaining_comes_through_uncapped() {
  devlink::RelayRestore out[kRestoreCap];
  uint8_t count = 0U;

  // 9999 s is nearly three hours, well past the 5400 s relay hard cap.
  const char overCap[] = "{\"relays\":[\"1|9999|3fa85f64\"]}";
  TEST_ASSERT_TRUE(devlink::parseRelayRestore(overCap, len(overCap), out, kRestoreCap, count));
  TEST_ASSERT_EQUAL_UINT8(1U, count);
  TEST_ASSERT_EQUAL_UINT32(9999UL, out[0].remainingSeconds);
  TEST_ASSERT_TRUE(out[0].remainingSeconds > 5400UL);

  // And the ms value a naive caller would compute does NOT wrap at the value
  // this parser admits — which is why the bound here is UINT32_MAX seconds and
  // the roster's is UINT32_MAX/1000: the roster multiplies, this does not.
  const char largest[] = "{\"relays\":[\"0|4294967295|ref\"]}";
  TEST_ASSERT_TRUE(devlink::parseRelayRestore(largest, len(largest), out, kRestoreCap, count));
  TEST_ASSERT_EQUAL_UINT32(4294967295UL, out[0].remainingSeconds);
}

/// ONE BAD ELEMENT MUST NOT COST THE WELL-FORMED ONES — `RosterSync.h`'s
/// sentence about one bad booking and the evening's other fifteen, applied to a
/// court that is dark and should not be. The contract's own vector.
void test_relay_restore_one_bad_element_does_not_cost_the_good_ones() {
  devlink::RelayRestore out[kRestoreCap];
  uint8_t count = 0U;
  uint8_t rejected = 0U;

  const char mixed[] = "{\"relays\":[\"9|100|x\",\"0|abc|y\",\"1|500|z\"]}";
  TEST_ASSERT_TRUE(devlink::parseRelayRestore(mixed, len(mixed), out, kRestoreCap, count, &rejected));
  TEST_ASSERT_EQUAL_UINT8(1U, count);
  TEST_ASSERT_EQUAL_UINT8(2U, rejected);
  TEST_ASSERT_EQUAL_UINT8(1U, out[0].relay);
  TEST_ASSERT_EQUAL_UINT32(500UL, out[0].remainingSeconds);
  TEST_ASSERT_EQUAL_STRING("z", out[0].bookingRef);

  // More elements than the caller's capacity. Counted rather than silently
  // dropped: a server telling this box to light five relays is a configuration
  // nobody should discover from a dark court.
  const char five[] = "{\"relays\":[\"0|10|a\",\"1|20|b\",\"2|30|c\",\"3|40|d\",\"0|50|e\"]}";
  uint8_t full = 0U;
  uint8_t overflow = 0U;
  TEST_ASSERT_TRUE(devlink::parseRelayRestore(five, len(five), out, kRestoreCap, full, &overflow));
  TEST_ASSERT_EQUAL_UINT8(4U, full);
  TEST_ASSERT_EQUAL_UINT8(1U, overflow);
  TEST_ASSERT_EQUAL_UINT32(40UL, out[3].remainingSeconds);

  // `rejected` is optional; a caller that does not want the diagnosis passes
  // nothing and must still get the same accepted set.
  uint8_t plain = 0U;
  TEST_ASSERT_TRUE(devlink::parseRelayRestore(mixed, len(mixed), out, kRestoreCap, plain));
  TEST_ASSERT_EQUAL_UINT8(1U, plain);

  // A capacity of zero accepts nothing and counts everything — a degenerate
  // caller, but not one that may write past the end of an array.
  uint8_t zero = 99U;
  uint8_t zeroRejected = 0U;
  TEST_ASSERT_TRUE(devlink::parseRelayRestore(mixed, len(mixed), out, 0U, zero, &zeroRejected));
  TEST_ASSERT_EQUAL_UINT8(0U, zero);
  TEST_ASSERT_EQUAL_UINT8(3U, zeroRejected);
  TEST_ASSERT_FALSE(devlink::parseRelayRestore(mixed, len(mixed), nullptr, kRestoreCap, zero));
}

/// A TRUNCATED BODY RESTORES NOTHING. Every element of this array CLOSES A
/// RELAY — it physically energises a court — and half a JSON document is not a
/// sentence the server finished saying. The restore is additive and the server
/// re-serves it on every heartbeat while those courts should be on, so waiting
/// one interval costs seconds; acting on a cut body costs a court lit from
/// bytes nobody sent. Same rule, same reasoning, as `applyRoster`'s.
void test_relay_restore_a_truncated_body_restores_nothing() {
  static const char* kTruncated[] = {
      "{\"relays\":[\"0|1834|3fa85f64\",\"2|600|9c1d0e",     // cut mid-element
      "{\"relays\":[\"0|1834|3fa85f64\",\"2|600|9c1d0e22\"", // cut before the bracket
      "{\"relays\":[\"0|1834|3fa85f64\"]",                   // cut before the brace
      "{\"relays\":[",                                       // cut at the opening bracket
  };

  for (size_t i = 0U; i < sizeof(kTruncated) / sizeof(kTruncated[0]); ++i) {
    devlink::RelayRestore out[kRestoreCap];
    uint8_t count = 99U;
    uint8_t rejected = 99U;
    TEST_ASSERT_FALSE_MESSAGE(
        devlink::parseRelayRestore(kTruncated[i], strlen(kTruncated[i]), out, kRestoreCap, count, &rejected),
        kTruncated[i]);
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(99U, count, kTruncated[i]);
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(99U, rejected, kTruncated[i]);
  }
}

/// A DECOY `relays` IS NOT THE RESTORE. The roster narrowed to the TOP-LEVEL
/// array for exactly this reason (round G4, B2) and this array drives relays
/// directly, so it is narrowed the same way: a nested `relays` placed before
/// the real one is the list this board would otherwise have energised. The
/// club's own slug and a button-map element are the decoys that actually
/// arrive.
void test_relay_restore_a_decoy_relays_array_is_not_the_restore() {
  devlink::RelayRestore out[kRestoreCap];
  uint8_t count = 0U;
  uint8_t rejected = 0U;

  const char nested[] =
      "{\"tenant_slug\":\"relays\",\"device_code\":\"court-box-1\","
      "\"config\":{\"button_map\":[\"relays\"],\"vendor\":{\"relays\":[\"3|9999|ffffffff\"]}},"
      "\"relays\":[\"1|500|3fa85f64\"],\"roster\":[]}";
  TEST_ASSERT_TRUE(devlink::parseRelayRestore(nested, len(nested), out, kRestoreCap, count, &rejected));
  TEST_ASSERT_EQUAL_UINT8(1U, count);
  TEST_ASSERT_EQUAL_UINT8(0U, rejected);
  TEST_ASSERT_EQUAL_UINT8(1U, out[0].relay);
  TEST_ASSERT_EQUAL_UINT32(500UL, out[0].remainingSeconds);
  TEST_ASSERT_EQUAL_STRING("3fa85f64", out[0].bookingRef);
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

/// THE COMPATIBILITY HINGE. A box with nothing to report renders the body it
/// has always rendered, BYTE FOR BYTE — which is what keeps the contract
/// corpus's `heartbeat-request` vector true and keeps every image already in
/// the field valid. Both new fields are omitted at their nothing value, exactly
/// as `boot_id`, `no_push` and `events_lost` are.
void test_heartbeat_body_with_nothing_to_report_is_byte_identical() {
  char body[devlink::kHeartbeatBodyCap] = {};
  const char* kAlways = "{\"mac\":\"5ccf7f0a1b2c\",\"firmware_version\":\"2.0.0\",\"uptime_ms\":86400000}";

  // The five-argument call every composition root makes today.
  TEST_ASSERT_TRUE(devlink::renderHeartbeatBody(body, sizeof(body), "5ccf7f0a1b2c", "2.0.0", 86400000ULL) >
                   0U);
  TEST_ASSERT_EQUAL_STRING(kAlways, body);

  // And an explicitly empty report: zero restored, no relay-state array at all.
  const devlink::HeartbeatReport quiet;
  TEST_ASSERT_EQUAL_UINT8(0U, quiet.restoredRelays);
  TEST_ASSERT_TRUE(
      devlink::renderHeartbeatBody(body, sizeof(body), "5ccf7f0a1b2c", "2.0.0", 86400000ULL, quiet) > 0U);
  TEST_ASSERT_EQUAL_STRING(kAlways, body);
}

/// `restored_relays` — how many relays this box re-energised from the last
/// restore. It is how the server learns the restore LANDED: a served restore
/// followed by a zero is the row an admin must see, because it means a court is
/// dark that should not be.
///
/// OMITTED AT ZERO, which the server reads as zero, so the two say the same
/// thing and the quiet body stays byte-identical to what the field already
/// sends.
void test_heartbeat_body_reports_how_many_relays_it_restored() {
  char body[devlink::kHeartbeatBodyCap] = {};
  devlink::HeartbeatReport report;
  report.restoredRelays = 2U;

  TEST_ASSERT_TRUE(
      devlink::renderHeartbeatBody(body, sizeof(body), "5ccf7f0a1b2c", "2.0.0", 90000ULL, report) > 0U);
  TEST_ASSERT_EQUAL_STRING("{\"mac\":\"5ccf7f0a1b2c\",\"firmware_version\":\"2.0.0\",\"uptime_ms\":90000,"
                           "\"restored_relays\":2}",
                           body);

  // Position is part of the shape: after `uptime_ms`, before `relay_state`.
  report.restoredRelays = 0U;
  TEST_ASSERT_TRUE(
      devlink::renderHeartbeatBody(body, sizeof(body), "5ccf7f0a1b2c", "2.0.0", 90000ULL, report) > 0U);
  TEST_ASSERT_NULL(strstr(body, "restored_relays"));
}

/// `relay_state` — what the box BELIEVES is closed, so the server can stop
/// guessing. The Mega publishes `!STATE,<mask>,<remA>..<remD>` on every change
/// and every ten seconds, and until now it reached nobody outside the box: the
/// admin console could only ever say what it BELIEVED it had granted.
///
/// The same pipe-delimited string array as the restore, for the same heapless
/// reason, and rendered from a plain array the caller passes — devlink must not
/// know what a court is.
void test_heartbeat_body_carries_the_relays_the_box_believes_are_closed() {
  char body[devlink::kHeartbeatBodyCap] = {};
  devlink::RelayState state[devlink::kMaxRelayStateElements];
  state[0].relay = 0U;
  state[0].remainingSeconds = 1834U;
  state[1].relay = 2U;
  state[1].remainingSeconds = 600U;

  devlink::HeartbeatReport report;
  report.relayState = state;
  report.relayStateCount = 2U;

  TEST_ASSERT_TRUE(
      devlink::renderHeartbeatBody(body, sizeof(body), "5ccf7f0a1b2c", "2.0.0", 90000ULL, report) > 0U);
  TEST_ASSERT_EQUAL_STRING("{\"mac\":\"5ccf7f0a1b2c\",\"firmware_version\":\"2.0.0\",\"uptime_ms\":90000,"
                           "\"relay_state\":[\"0|1834\",\"2|600\"]}",
                           body);

  // Both fields together, in their pinned order.
  report.restoredRelays = 2U;
  TEST_ASSERT_TRUE(
      devlink::renderHeartbeatBody(body, sizeof(body), "5ccf7f0a1b2c", "2.0.0", 90000ULL, report) > 0U);
  TEST_ASSERT_EQUAL_STRING("{\"mac\":\"5ccf7f0a1b2c\",\"firmware_version\":\"2.0.0\",\"uptime_ms\":90000,"
                           "\"restored_relays\":2,\"relay_state\":[\"0|1834\",\"2|600\"]}",
                           body);

  // THREE STATES, NOT TWO. An absent key is "this firmware does not report
  // relay state"; an EMPTY ARRAY is "this box believes nothing is closed". A
  // control board that could not tell those apart would show a dark court as
  // unknown and an unknown court as dark.
  devlink::HeartbeatReport nothingOn;
  nothingOn.relayState = state;
  nothingOn.relayStateCount = 0U;
  TEST_ASSERT_TRUE(
      devlink::renderHeartbeatBody(body, sizeof(body), "5ccf7f0a1b2c", "2.0.0", 90000ULL, nothingOn) > 0U);
  TEST_ASSERT_NOT_NULL(strstr(body, "\"relay_state\":[]}"));

  devlink::HeartbeatReport doesNotReport;
  TEST_ASSERT_TRUE(devlink::renderHeartbeatBody(body, sizeof(body), "5ccf7f0a1b2c", "2.0.0", 90000ULL,
                                                doesNotReport) > 0U);
  TEST_ASSERT_NULL(strstr(body, "relay_state"));

  // The remainder is the box's own, from `!STATE`, and goes up UNCAPPED for the
  // same reason the restore's comes down uncapped: the server is being told
  // what this board believes, not what a relay cap allows.
  devlink::RelayState wide[devlink::kMaxRelayStateElements];
  wide[0].relay = 3U;
  wide[0].remainingSeconds = 4294967295UL;
  devlink::HeartbeatReport widest;
  widest.relayState = wide;
  widest.relayStateCount = 1U;
  TEST_ASSERT_TRUE(
      devlink::renderHeartbeatBody(body, sizeof(body), "5ccf7f0a1b2c", "2.0.0", 90000ULL, widest) > 0U);
  TEST_ASSERT_NOT_NULL(strstr(body, "\"relay_state\":[\"3|4294967295\"]}"));
}

/// A DIAGNOSTIC MUST NEVER BE ABLE TO STOP A HEARTBEAT, and that is the exact
/// mirror of the server-side rule that made `no_push` a `long?` rather than an
/// `int?`: a counter out of range must not answer 400 for the whole heartbeat
/// and take the roster down with it. On this side the same sentence means a
/// caller that hands the renderer a relay index the grammar cannot express, or
/// more elements than the buffer is sized for, still gets a heartbeat — because
/// a box that cannot heartbeat has no court list and refuses every scan.
void test_heartbeat_body_never_lets_a_diagnostic_cost_the_heartbeat() {
  char body[devlink::kHeartbeatBodyCap] = {};
  devlink::RelayState state[devlink::kMaxRelayStateElements];
  state[0].relay = 9U; // no such relay
  state[0].remainingSeconds = 100U;
  state[1].relay = 1U;
  state[1].remainingSeconds = 500U;

  devlink::HeartbeatReport report;
  report.relayState = state;
  report.relayStateCount = 2U;
  TEST_ASSERT_TRUE(
      devlink::renderHeartbeatBody(body, sizeof(body), "5ccf7f0a1b2c", "2.0.0", 90000ULL, report) > 0U);
  TEST_ASSERT_NOT_NULL(strstr(body, "\"relay_state\":[\"1|500\"]}"));
  TEST_ASSERT_NULL(strstr(body, "9|100"));

  // More elements than the cap the buffer is sized for: the extras are dropped
  // and the heartbeat still goes.
  devlink::HeartbeatReport tooMany;
  tooMany.relayState = state;
  tooMany.relayStateCount = 200U;
  const size_t written =
      devlink::renderHeartbeatBody(body, sizeof(body), "5ccf7f0a1b2c", "2.0.0", 90000ULL, tooMany);
  TEST_ASSERT_TRUE(written > 0U);
  TEST_ASSERT_EQUAL_size_t(strlen(body), written);

  // A count with a null pointer is a caller bug that must also not cost the
  // heartbeat: the key is simply absent.
  devlink::HeartbeatReport lying;
  lying.relayStateCount = 3U;
  TEST_ASSERT_TRUE(
      devlink::renderHeartbeatBody(body, sizeof(body), "5ccf7f0a1b2c", "2.0.0", 90000ULL, lying) > 0U);
  TEST_ASSERT_NULL(strstr(body, "relay_state"));
}

/// The worst case fits kHeartbeatBodyCap, and a buffer that cannot hold the
/// body gets NOTHING rather than half of one — the renderer's existing
/// contract, extended over the two new fields. A half-rendered object is a 400
/// the box cannot read, and a box that cannot heartbeat has no court list.
void test_heartbeat_body_worst_case_fits_and_a_short_buffer_gets_nothing() {
  devlink::RelayState state[devlink::kMaxRelayStateElements];
  for (uint8_t i = 0U; i < devlink::kMaxRelayStateElements; ++i) {
    state[i].relay = i;
    state[i].remainingSeconds = 4294967295UL;
  }
  devlink::HeartbeatReport worst;
  worst.restoredRelays = 255U;
  worst.relayState = state;
  worst.relayStateCount = devlink::kMaxRelayStateElements;

  char body[devlink::kHeartbeatBodyCap] = {};
  // A sixteen-character version, which is the budget the cap is computed
  // against, and a uptime past 2^32 so both 64-bit paths are in the worst case.
  const size_t written = devlink::renderHeartbeatBody(body, sizeof(body), "5ccf7f0a1b2c", "255.255.255-rc99",
                                                      0xFFFFFFFFFFFFFFFFULL, worst);
  TEST_ASSERT_TRUE_MESSAGE(written > 0U, "the worst case must fit kHeartbeatBodyCap");
  TEST_ASSERT_EQUAL_size_t(strlen(body), written);
  TEST_ASSERT_NOT_NULL(strstr(body, "\"uptime_ms\":18446744073709551615,"));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"restored_relays\":255,"));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"relay_state\":[\"0|4294967295\",\"1|4294967295\","
                                    "\"2|4294967295\",\"3|4294967295\"]}"));

  // One byte short of that body: refused, and `out` emptied.
  char tight[256] = {};
  TEST_ASSERT_EQUAL_size_t(0U,
                           devlink::renderHeartbeatBody(tight, written, "5ccf7f0a1b2c", "255.255.255-rc99",
                                                        0xFFFFFFFFFFFFFFFFULL, worst));
  TEST_ASSERT_EQUAL_STRING("", tight);

  // And the same at every clock base the suites use, so nothing in the new
  // fields can have smuggled a 32-bit conversion in beside the uptime.
  for (size_t i = 0U; i < kBaseCount; ++i) {
    char each[devlink::kHeartbeatBodyCap] = {};
    const uint64_t uptime = 0x100000000ULL + kBases[i];
    TEST_ASSERT_TRUE(
        devlink::renderHeartbeatBody(each, sizeof(each), "5ccf7f0a1b2c", "2.0.0", uptime, worst) > 0U);
    char expected[32] = {};
    snprintf(expected, sizeof(expected), "\"uptime_ms\":%llu,", static_cast<unsigned long long>(uptime));
    TEST_ASSERT_NOT_NULL_MESSAGE(strstr(each, expected), each);
  }
}

} // namespace

void setUp() {
}

void tearDown() {
}

// --- the flat scan, where it is the wrong reader ---------------------------
//
// Round G4's B2 in the court box's own fields. `devapi::json::findKey` and
// `findArray` match at ANY DEPTH and return the FIRST match in document order,
// which is depended upon for the heartbeat's nested `config` object and is
// exactly wrong for anything a caller ACTS ON: a decoy placed before the real
// field wins, and the reader cannot tell the difference.
//
// `roster` was narrowed when B2 was found. These two were not, and both decide
// something: `court_numbers` is which club court each relay IS — what a walk-up
// is sold as, and what the power-dip restore gates on — and `heartbeat_seconds`
// is how often the box speaks at all.

void test_court_numbers_come_from_the_top_level_only(void) {
  int16_t courts[devlink::kMaxCourts] = {};
  uint8_t count = 0U;

  // A decoy BEFORE the real field, which is the shape that wins under a flat
  // scan. A box that adopted it would map relay 0 to court 7 and sell a member
  // a court the club never booked.
  const char* decoyFirst = "{\"vendor\":{\"court_numbers\":[7,8,9,9]},\"court_numbers\":[1,2,3,4]}";
  TEST_ASSERT_TRUE(devlink::parseCourtNumbers(decoyFirst, strlen(decoyFirst), courts, count));
  TEST_ASSERT_EQUAL_UINT8(4U, count);
  TEST_ASSERT_EQUAL_INT16(1, courts[0]);
  TEST_ASSERT_EQUAL_INT16(4, courts[3]);

  // And after it, which a flat scan happens to get right — asserted so the fix
  // is not merely reordering the document's luck.
  const char* decoyLast = "{\"court_numbers\":[1,2,3,4],\"vendor\":{\"court_numbers\":[7,8,9,9]}}";
  TEST_ASSERT_TRUE(devlink::parseCourtNumbers(decoyLast, strlen(decoyLast), courts, count));
  TEST_ASSERT_EQUAL_INT16(1, courts[0]);

  // A nested one ALONE is not a court map at all. Leaving the previous one
  // alone is the documented behaviour for an absent key, and a box that has
  // never been told its courts refuses every walk-up rather than selling court
  // zero.
  const char* nestedOnly = "{\"config\":{\"court_numbers\":[7,8,9,9]}}";
  count = 0U;
  TEST_ASSERT_FALSE(devlink::parseCourtNumbers(nestedOnly, strlen(nestedOnly), courts, count));
  TEST_ASSERT_EQUAL_UINT8(0U, count);
}

void test_the_heartbeat_interval_comes_from_the_top_level_only(void) {
  uint32_t intervalMs = 30000UL;

  const char* decoyFirst = "{\"config\":{\"heartbeat_seconds\":300},\"heartbeat_seconds\":60}";
  TEST_ASSERT_TRUE(devlink::parseHeartbeatInterval(decoyFirst, strlen(decoyFirst), intervalMs));
  TEST_ASSERT_EQUAL_UINT32(60000UL, intervalMs);

  // Nested alone: absent, so the working value is LEFT ALONE. An older API must
  // not be able to change a cadence a newer one set, and neither must a field
  // that merely shares a name with one.
  intervalMs = 60000UL;
  const char* nestedOnly = "{\"config\":{\"heartbeat_seconds\":300}}";
  TEST_ASSERT_FALSE(devlink::parseHeartbeatInterval(nestedOnly, strlen(nestedOnly), intervalMs));
  TEST_ASSERT_EQUAL_UINT32(60000UL, intervalMs);
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_court_numbers_come_from_the_top_level_only);
  RUN_TEST(test_the_heartbeat_interval_comes_from_the_top_level_only);

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
  RUN_TEST(test_apply_roster_a_truncated_body_never_replaces_the_roster);
  RUN_TEST(test_apply_roster_every_accepted_heartbeat_resets_staleness_across_the_wrap);

  RUN_TEST(test_court_numbers_are_read_by_relay_position);
  RUN_TEST(test_court_numbers_that_cannot_be_a_court_set_leave_the_previous_one_alone);

  RUN_TEST(test_breaker_opens_after_two_transport_failures_and_backs_off_doubling);
  RUN_TEST(test_breaker_any_answer_closes_it_and_resets_the_window);
  RUN_TEST(test_breaker_a_400_malformed_body_is_not_a_transport_failure);

  RUN_TEST(test_heartbeat_interval_is_adopted_and_bounded);
  RUN_TEST(test_a_tenant_slug_that_names_a_key_hides_nothing);
  RUN_TEST(test_a_button_map_element_that_names_a_key_hides_nothing);

  RUN_TEST(test_lcd_settings_adopts_all_nine_from_the_nested_config);
  RUN_TEST(test_lcd_settings_clamps_each_key_at_both_bounds_and_past_them);
  RUN_TEST(test_lcd_settings_an_absent_key_leaves_that_setting_alone);
  RUN_TEST(test_lcd_settings_raise_scan_memory_and_never_lower_the_choice_window);
  RUN_TEST(test_lcd_settings_a_decoy_at_a_deeper_level_is_not_adopted);
  RUN_TEST(test_lcd_settings_a_wrong_type_or_a_cut_body_adopts_nothing);

  RUN_TEST(test_relay_restore_reads_two_relays_and_their_true_remainder);
  RUN_TEST(test_relay_restore_absent_and_empty_are_not_an_off_command);
  RUN_TEST(test_relay_restore_refuses_every_malformed_element_shape);
  RUN_TEST(test_relay_restore_remaining_comes_through_uncapped);
  RUN_TEST(test_relay_restore_one_bad_element_does_not_cost_the_good_ones);
  RUN_TEST(test_relay_restore_a_truncated_body_restores_nothing);
  RUN_TEST(test_relay_restore_a_decoy_relays_array_is_not_the_restore);

  RUN_TEST(test_the_event_body_carries_a_64_bit_uptime_across_the_millis_wrap);
  RUN_TEST(test_the_event_body_escapes_a_subject_whatever_bytes_are_in_it);
  RUN_TEST(test_heartbeat_body_names_the_box_and_survives_the_millis_wrap);
  RUN_TEST(test_heartbeat_body_with_nothing_to_report_is_byte_identical);
  RUN_TEST(test_heartbeat_body_reports_how_many_relays_it_restored);
  RUN_TEST(test_heartbeat_body_carries_the_relays_the_box_believes_are_closed);
  RUN_TEST(test_heartbeat_body_never_lets_a_diagnostic_cost_the_heartbeat);
  RUN_TEST(test_heartbeat_body_worst_case_fits_and_a_short_buffer_gets_nothing);

  return UNITY_END();
}

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
#include <stdlib.h>
#include <string.h>
#include <unity.h>

#include "bridgelogic/AuthPolicy.h"
#include "bridgelogic/BootId.h"
#include "bridgelogic/Extend.h"
#include "bridgelogic/MegaLink.h"
#include "bridgelogic/OnRetry.h"
#include "bridgelogic/PayFor.h"
#include "bridgelogic/Relight.h"
#include "bridgelogic/RosterTokenFits.h"
#include "bridgelogic/ScanFlow.h"
#include "bridgelogic/ScanMemory.h"
#include "bridgelogic/ScreenScript.h"
#include "bridgelogic/StateReconcile.h"
#include "bridgelogic/V3Heartbeat.h"
#include "bridgelogic/WalkUp.h"
#include "bridgelogic/WallClock.h"
#include "court/Session.h"
#include "devapi/DeviceClient.h"
#include "devapi/Json.h"
#include "devlink/Cadence.h"
#include "devlink/EventUpload.h"
#include "devlink/LcdSettings.h"
#include "devlink/RelayRestore.h"
#include "devlink/RosterSync.h"
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
constexpr uint32_t kSecondsPerDayLocal = 86400UL;
constexpr uint32_t kHourMs = 3600000UL;

using Cache = roster::Roster<devlink::kMaxRosterEntries>;
using Queue = eventq::EventQueue<4U>;
using Play = court::Session<Cache, Queue>;

/// This box drives club courts 7, 8, 9 and 10 on relays A, B, C and D.
const int16_t kCourts[devlink::kMaxCourts] = {7, 8, 9, 10};
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
    TEST_ASSERT_TRUE(devlink::applyRoster(body, len(body), cache, base).replaced);

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
  TEST_ASSERT_TRUE(devlink::applyRoster(body, len(body), cache, kBaseMid).replaced);

  const court::Outcome out =
      play.onScan("TOKALICE", roster::CourtCount(kCourtCount), eventq::Method::Qr, kBaseMid + 1U);
  TEST_ASSERT_TRUE(out.action == court::Action::TurnOn);
  TEST_ASSERT_EQUAL_UINT32(court::kMaxGrantMs, out.durationMs);
  TEST_ASSERT_EQUAL_STRING("90 MIN", out.line2);
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

bridgelogic::LinkState link(bool wifiUp) {
  bridgelogic::LinkState l;
  l.wifiUp = wifiUp;
  l.courtCount = kCourtCount;
  l.apiDown = false;
  return l;
}

void test_scan_flow_asks_the_api_only_when_the_answer_can_be_acted_on() {
  const bridgelogic::ScanFlow flow;
  TEST_ASSERT_TRUE(flow.onScan(link(true)) == bridgelogic::Attempt::Online);
  // Offline: the roster's scan, in microseconds, as before.
  TEST_ASSERT_TRUE(flow.onScan(link(false)) == bridgelogic::Attempt::RosterOnly);
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

/// A `reason` whose text happens to be the name of a key read LATER in the same
/// response. `reason` is server-chosen and sits before `court_number` and
/// `granted_seconds` in every activate response, so a scanner that matched a
/// quoted string anywhere read the reason's VALUE as the key and then found no
/// number after it — a member with a valid booking sent to the desk, or the
/// roster asked to light a court the API had already activated. Held by
/// devapi::json::findKey now; this is the court box's own pin on it.
void test_scan_flow_a_reason_that_names_a_later_key_does_not_hide_it() {
  const bridgelogic::ScanFlow flow;

  const char courtDecoy[] = "{\"activated\":true,\"reason\":\"court_number\",\"court_number\":9,"
                            "\"granted_seconds\":2700}";
  const bridgelogic::ActivationResult r =
      flow.onActivateResponse(200U, courtDecoy, len(courtDecoy), kCourts, kCourtCount);
  TEST_ASSERT_FALSE(r.fallbackToRoster);
  TEST_ASSERT_TRUE(r.outcome.action == court::Action::TurnOn);
  TEST_ASSERT_EQUAL_UINT8(2U, r.outcome.court); // court 9 is relay C
  TEST_ASSERT_EQUAL_UINT32(2700000UL, r.outcome.durationMs);

  const char grantDecoy[] = "{\"activated\":true,\"reason\":\"granted_seconds\",\"court_number\":9,"
                            "\"granted_seconds\":1800}";
  const bridgelogic::ActivationResult r2 =
      flow.onActivateResponse(200U, grantDecoy, len(grantDecoy), kCourts, kCourtCount);
  TEST_ASSERT_FALSE(r2.fallbackToRoster);
  TEST_ASSERT_TRUE(r2.outcome.action == court::Action::TurnOn);
  TEST_ASSERT_EQUAL_UINT32(1800000UL, r2.outcome.durationMs);

  // And on the refusal path, where `reason` names the number the refusal
  // itself needs: "TOO EARLY" without its minutes reads as a broken box.
  const char earlyDecoy[] = "{\"activated\":false,\"reason\":\"too_early\","
                            "\"starts_in_seconds\":540}";
  const bridgelogic::ActivationResult r3 =
      flow.onActivateResponse(200U, earlyDecoy, len(earlyDecoy), kCourts, kCourtCount);
  TEST_ASSERT_EQUAL_STRING("TOO EARLY", r3.outcome.line1);
  TEST_ASSERT_EQUAL_STRING("WAIT 9 MIN", r3.outcome.line2);
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
      {"{\"activated\":false,\"reason\":\"insufficient_balance\"}", "TOO FEW MINUTES", "BUY & RETRY"},
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
  char body[128] = {};
  TEST_ASSERT_TRUE(bridgelogic::renderActivateBody(body, sizeof(body), "5ccf7f0a1b2c", "4T8Y2K9QW3ZM") > 0U);
  TEST_ASSERT_EQUAL_STRING("{\"mac\":\"5ccf7f0a1b2c\",\"method\":\"qr\",\"token\":\"4T8Y2K9QW3ZM\"}", body);

  char tiny[16] = {};
  TEST_ASSERT_EQUAL_size_t(
      0U, bridgelogic::renderActivateBody(tiny, sizeof(tiny), "5ccf7f0a1b2c", "4T8Y2K9QW3ZM"));
  TEST_ASSERT_EQUAL_STRING("", tiny);

  // A body with no MAC names no device, and an auto-registering backend keys
  // everything off that field — so it is refused here rather than sent.
  TEST_ASSERT_EQUAL_size_t(0U, bridgelogic::renderActivateBody(body, sizeof(body), "", "4T8Y2K9QW3ZM"));
  TEST_ASSERT_EQUAL_size_t(0U, bridgelogic::renderActivateBody(body, sizeof(body), nullptr, "4T8Y2K9QW3ZM"));
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

  bridgelogic::WalkUpRequest request;
  request.mac = "5ccf7f0a1b2c";
  request.intent = intent;
  request.courtNumber = kCourts[intent.court];
  request.token = "4T8Y2K9QW3ZM";
  request.nonce = "0001020304050607";

  char body[320] = {};
  TEST_ASSERT_TRUE(bridgelogic::renderWalkUpBody(body, sizeof(body), request) > 0U);
  TEST_ASSERT_EQUAL_STRING("{\"mac\":\"5ccf7f0a1b2c\",\"minutes\":45,\"method\":\"qr\","
                           "\"token\":\"4T8Y2K9QW3ZM\",\"court\":8,\"nonce\":\"0001020304050607\"}",
                           body);

  // Never truncated: half a body is a request for something else.
  char tiny[40] = {};
  TEST_ASSERT_EQUAL_size_t(0U, bridgelogic::renderWalkUpBody(tiny, sizeof(tiny), request));

  // And never without a MAC.
  request.mac = "";
  TEST_ASSERT_EQUAL_size_t(0U, bridgelogic::renderWalkUpBody(body, sizeof(body), request));
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
                       "\"amount_minutes\":4,\"balance_after_minutes\":36}";
  const char replayed[] = "{\"server_unix\":1750000005,\"booking_id\":\"b1\",\"granted_minutes\":20,"
                          "\"amount_minutes\":4,\"balance_after_minutes\":36,\"replayed\":true}";

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
      {402U, "{\"error\":\"insufficient_balance\"}", "TOO FEW MINUTES", true, true},
      {409U, "{\"error\":\"court_in_use\"}", "COURT NOT FREE", true, true},
      {409U, "{\"error\":\"no_time_available\"}", "NO TIME BEFORE", true, true},
      {409U, "{\"error\":\"purchase_ended\"}", "PURCHASE ENDED", true, true},
      {400U, "{\"error\":\"not_recognised\"}", "SEE THE DESK", true, false},
      {400U, "{\"error\":\"court_not_on_device\"}", "SEE THE DESK", true, false},
      // Both of these read SEE THE DESK until 2026-09-07, and both were wrong in a
      // way that stranded the member. The club lowered its walk-up maximum below
      // what this button grants, so a SHORTER button works and the desk is not the
      // problem (M-F1); recognised stays false because RefuseFields runs before the
      // API has resolved the token, exactly as for court_not_on_device.
      {400U, "{\"error\":\"minutes_out_of_range\",\"max_minutes\":20}", "TOO LONG", true, false},
      // And the club is shut, at a locked door, with nobody at the desk to see
      // (M-F5). Recognised: club_closed is produced past the token resolution.
      {400U, "{\"error\":\"club_closed\",\"opens_at\":\"06:00\",\"closes_at\":\"22:00\"}", "CLUB CLOSED",
       true, true},
      // The sale was made, could not be opened, and was UNDONE before this answer
      // was written, so the court is free. It read COURT NOT FREE until 2026-09-07.
      // Recognised: the API had resolved the token and committed a booking for this
      // member before it refused.
      {409U, "{\"error\":\"activation_refused\"}", "COULD NOT START", true, true},
      {0U, "", "NO CONNECTION", false, false},
      // R17 D17-4. A 429 or a 5xx decided nothing, and the nonce is kept, so the
      // same press is answered with the first purchase or makes it now. It read
      // SEE THE DESK, which sent a member away from a retry that works.
      {503U, "", "BUSY", false, false},
      {503U, "{\"error\":\"conflict_retry\"}", "BUSY", false, false},
      {500U, "", "BUSY", false, false},
      {502U, "<html>bad gateway</html>", "BUSY", false, false},
      {429U, "", "BUSY", false, false},
      {429U, "{\"error\":\"rate_limited\"}", "BUSY", false, false},
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

  // A busy server's second line is the instruction: the same press retries the
  // same purchase, with the same nonce. A 429 or a 5xx never forgets the scan.
  const uint16_t busy[] = {429U, 500U, 502U, 503U};
  for (const uint16_t status : busy) {
    const bridgelogic::WalkUpResult r = bridgelogic::onWalkUpResponse(status, "", 0U, 1U, 45U);
    TEST_ASSERT_EQUAL_STRING("PRESS AGAIN", r.outcome.line2);
    TEST_ASSERT_FALSE(r.forgetsScan);
    TEST_ASSERT_FALSE(r.decided);
  }
  // A decided status this build has no words for is still the desk's.
  TEST_ASSERT_EQUAL_STRING("SEE THE DESK",
                           bridgelogic::onWalkUpResponse(418U, "", 0U, 0U, 30U).outcome.line1);

  // The second lines of the two 400s, which are the half that tells the member what
  // to do instead of standing there.
  const char tooLong[] = "{\"error\":\"minutes_out_of_range\",\"max_minutes\":20}";
  TEST_ASSERT_EQUAL_STRING("TRY LESS TIME",
                           bridgelogic::onWalkUpResponse(400U, tooLong, len(tooLong), 0U, 60U).outcome.line2);
}

void test_walkup_a_closed_club_puts_its_opening_time_on_the_glass() {
  // The finding, in one assertion: `club_closed` used to fall through byStatus(400)
  // and paint SEE THE DESK — at a locked club, after hours, when there is no desk.
  // The API has been sending the club's own opening time since the refusal was given
  // its own code; nothing read it.
  const char shut[] = "{\"error\":\"club_closed\",\"opens_at\":\"06:00\",\"closes_at\":\"22:00\"}";
  const bridgelogic::WalkUpResult r = bridgelogic::onWalkUpResponse(400U, shut, len(shut), 1U, 30U);
  TEST_ASSERT_TRUE(r.outcome.action == court::Action::Refuse);
  TEST_ASSERT_TRUE(r.decided);
  TEST_ASSERT_EQUAL_STRING("CLUB CLOSED", r.outcome.line1);
  TEST_ASSERT_EQUAL_STRING("OPENS 06:00", r.outcome.line2);

  // A club that opens at a two-digit hour is the ordinary case, and the line is
  // sixteen characters wide, so this cannot be allowed to clip into "OPENS 1".
  const char later[] = "{\"error\":\"club_closed\",\"opens_at\":\"14:30\",\"closes_at\":\"23:00\"}";
  TEST_ASSERT_EQUAL_STRING("OPENS 14:30",
                           bridgelogic::onWalkUpResponse(400U, later, len(later), 1U, 30U).outcome.line2);

  // An API that sends the code without the time — an older build, or a club whose
  // hours could not be resolved. The first line is the half that explains why
  // nothing happened, and it still lands; the second falls back rather than
  // reading "OPENS " with nothing after it.
  const char bare[] = "{\"error\":\"club_closed\"}";
  const bridgelogic::WalkUpResult b = bridgelogic::onWalkUpResponse(400U, bare, len(bare), 1U, 30U);
  TEST_ASSERT_EQUAL_STRING("CLUB CLOSED", b.outcome.line1);
  TEST_ASSERT_EQUAL_STRING("TRY LATER", b.outcome.line2);

  // Whatever the club sends, it has to fit the glass.
  const char silly[] = "{\"error\":\"club_closed\",\"opens_at\":\"06:00 tomorrow morning\"}";
  const bridgelogic::WalkUpResult s = bridgelogic::onWalkUpResponse(400U, silly, len(silly), 1U, 30U);
  TEST_ASSERT_TRUE(strlen(s.outcome.line1) <= court::kLineLen);
  TEST_ASSERT_TRUE(strlen(s.outcome.line2) <= court::kLineLen);
}

void test_walkup_a_refused_activation_does_not_say_the_court_is_busy() {
  // The glass was made to lie by a fix behind it. `activation_refused` is the answer
  // the API gives when it sold the court, could not open it, and undid the sale — the
  // charge reversed and the slot released in the same request. With no row of its own
  // it fell through byStatus(409) to COURT NOT FREE / SCAN TO START, which was true
  // while the abandoned booking still held the court and false the instant the undo
  // started landing. The member is told the court is busy, standing at a court that is
  // free, holding a mail that says "Try again at the box".
  const char refused[] = "{\"error\":\"activation_refused\"}";
  const bridgelogic::WalkUpResult r = bridgelogic::onWalkUpResponse(409U, refused, len(refused), 2U, 30U);
  TEST_ASSERT_TRUE(r.outcome.action == court::Action::Refuse);
  TEST_ASSERT_TRUE(r.decided);
  TEST_ASSERT_EQUAL_STRING("COULD NOT START", r.outcome.line1);
  TEST_ASSERT_EQUAL_STRING("SCAN TO RETRY", r.outcome.line2);
  // Named rather than implied: the specific sentence this row exists to stop.
  TEST_ASSERT_TRUE(strcmp(r.outcome.line1, "COURT NOT FREE") != 0);
  // A verdict about a member the API identified and had already booked.
  TEST_ASSERT_TRUE(r.outcome.recognised);
  TEST_ASSERT_TRUE(strlen(r.outcome.line1) <= court::kLineLen);
  TEST_ASSERT_TRUE(strlen(r.outcome.line2) <= court::kLineLen);

  // The fallthrough is still there for a 409 this build has no row for, so the change
  // is one error code and not a rewrite of what a bare conflict says.
  TEST_ASSERT_EQUAL_STRING("COURT NOT FREE",
                           bridgelogic::onWalkUpResponse(409U, "{}", 2U, 2U, 30U).outcome.line1);
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
      {402U, "{\"error\":\"insufficient_balance\",\"current_minutes\":2}", true},
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
  TEST_ASSERT_EQUAL_STRING("TOO FEW MINUTES",
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

void test_walkup_forgets_the_scan_only_for_a_used_or_unknown_code() {
  // D9-1. Bridge 2.2.3 forgot the scan after every decided refusal that did
  // not RECOGNISE the member — and `recognised` is false for every refusal
  // made before the API resolves the token. TOO LONG / TRY LESS TIME told the
  // member to press a shorter button, the box sent !AUTH,0, the Mega dropped
  // that press (a ButtonUnauthorised fault) and the member had to rescan. Only
  // a refusal of the CODE itself — the same two pay-for forgets on — forgets.
  struct Case {
    uint16_t status;
    const char* body;
    bool forgets;
  };

  const Case cases[] = {
      // The member can fix these by choosing again: the scan stays.
      {400U, "{\"error\":\"minutes_out_of_range\",\"max_minutes\":45}", false},
      {409U, "{\"error\":\"court_not_on_device\"}", false},
      {400U, "{\"error\":\"court_not_on_device\"}", false},
      {402U, "", false},
      {409U, "", false},
      {409U, "{}", false},
      {409U, "{\"error\":\"something_newer\"}", false},
      {400U, "{\"error\":\"club_closed\",\"opens_at\":\"06:00\"}", false},
      {402U, "{\"error\":\"insufficient_balance\"}", false},
      {409U, "{\"error\":\"court_in_use\"}", false},
      {409U, "{\"error\":\"no_time_available\"}", false},
      {409U, "{\"error\":\"purchase_ended\"}", false},
      {409U, "{\"error\":\"activation_refused\"}", false},
      {404U, "", false},
      // Undecided: the nonce and the scan stay for the same purchase.
      {0U, "", false},
      {429U, "{\"error\":\"code_used\"}", false},
      {503U, "{\"error\":\"not_recognised\"}", false},
      // A refusal of the code: it buys nothing more, so it is forgotten.
      {409U, "{\"error\":\"code_used\"}", true},
      {409U, "{\"error\":\"not_recognised\"}", true},
      {400U, "{\"error\":\"not_recognised\"}", true},
      {402U, "{\"error\":\"not_recognised\"}", true},
  };
  for (const Case& c : cases) {
    const bridgelogic::WalkUpResult r = bridgelogic::onWalkUpResponse(c.status, c.body, len(c.body), 1U, 60U);
    TEST_ASSERT_EQUAL_MESSAGE(c.forgets, r.forgetsScan, c.body[0] != '\0' ? c.body : "(empty body)");
  }
  // A grant spends the scan (spendsScan) — it is never "forgotten" as a refusal.
  const char sold[] = "{\"granted_minutes\":60}";
  TEST_ASSERT_FALSE(bridgelogic::onWalkUpResponse(200U, sold, len(sold), 1U, 60U).forgetsScan);
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
// Located BY ID, never by index: a reordered or extended corpus must not
// silently detach a test from its vector. A vector that has gone missing is a
// failure, not a skip — this suite binds to ids that are committed, and losing
// one is a contract change. The executed-count gate on the whole corpus is
// asserted at the end of this section.

/// Static, not stack: 64 KB of corpus in a Unity test frame is a stack
/// overflow on some hosts.
corpus::File g_httpCases;

/// This box drives club courts 1-4 on relays A-D — the court set the corpus's
/// activate vectors assume, where `court_number` 3 is relay C.
const int16_t kCorpusCourts[devlink::kMaxCourts] = {1, 2, 3, 4};

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

/// The `requests` vector whose `id` is `id`. Fails the test when absent — this
/// suite binds to ids that are committed, and losing one is a contract change.
const char* requestVector(const char* id) {
  const char* requests = corpus::member(g_httpCases.root(), "requests");
  TEST_ASSERT_NOT_NULL_MESSAGE(requests, "http corpus has no requests section");

  corpus::ArrayIter it(requests);
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

/// The MAC every request vector names this box by.
const char* corpusMac() {
  static char mac[devapi::kMacHexLen + 1U] = {};
  TEST_ASSERT_TRUE_MESSAGE(
      corpus::stringValue(corpus::member(g_httpCases.root(), "device_mac"), mac, sizeof(mac), nullptr),
      "http corpus has no device_mac");
  return mac;
}

/// Decodes a vector's `body_hex` into `out` as a NUL-terminated string,
/// returning its byte length.
size_t bodyOf(const char* vector, char* out, size_t cap) {
  // Static, and 1280 rather than 512: the settings vectors carry all nine
  // operator keys beside the button map and the roster, and a decode buffer
  // that is quietly too small reports "body_hex" and reads as a corpus fault.
  // Sized from the v3 contract: a hb:3 body is read into 5120 (the widest
  // vector is 4087 bytes), plus the NUL.
  static uint8_t bytes[bridgelogic::kHeartbeatResponseCap + 1U] = {};
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
      flow.onActivateResponse(200U, body, n, kCorpusCourts, devlink::kMaxCourts);

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
      flow.onActivateResponse(200U, body, n, kCorpusCourts, devlink::kMaxCourts);

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
      flow.onActivateResponse(200U, body, n, kCorpusCourts, devlink::kMaxCourts);

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
    const uint32_t bounded = wanted > devlink::kMaxHeartbeatMs
                                 ? devlink::kMaxHeartbeatMs
                                 : (wanted < devlink::kMinHeartbeatMs ? devlink::kMinHeartbeatMs : wanted);
    uint32_t ms = 0U;
    TEST_ASSERT_TRUE_MESSAGE(devlink::parseHeartbeatInterval(body, n, ms), id);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(bounded, ms, id);
    ++executed;
  }
  TEST_ASSERT_TRUE_MESSAGE(executed >= 1U,
                           "no heartbeat vector declares heartbeat_seconds — nothing was checked");
}

void test_corpus_activate_body_is_byte_identical_to_the_contract() {
  loadHttpCorpus();
  // A field reordered, renamed or spaced differently on this side is a request
  // the server reads differently, with no diagnostic on either end.
  char expected[512] = {};
  const size_t n = bodyOf(requestVector("activate-request"), expected, sizeof(expected));

  char rendered[128] = {};
  const size_t renderedLen =
      bridgelogic::renderActivateBody(rendered, sizeof(rendered), corpusMac(), "7Q3F9KM2XZ8B");
  TEST_ASSERT_EQUAL_size_t(n, renderedLen);
  TEST_ASSERT_EQUAL_STRING(expected, rendered);
  TEST_ASSERT_EQUAL_MEMORY(expected, rendered, n);
}

void test_corpus_heartbeat_body_is_byte_identical_to_the_contract() {
  loadHttpCorpus();
  // The vector's firmware version is a literal, not fw::kFirmwareVersion: this
  // pins the SHAPE, and a corpus that moved every time the patch number did
  // would be a corpus nobody could bump.
  char expected[512] = {};
  const size_t n = bodyOf(requestVector("heartbeat-request"), expected, sizeof(expected));

  char rendered[devlink::kHeartbeatBodyCap] = {};
  const size_t renderedLen =
      devlink::renderHeartbeatBody(rendered, sizeof(rendered), corpusMac(), "2.0.0", 86400000ULL);
  TEST_ASSERT_EQUAL_size_t(n, renderedLen);
  TEST_ASSERT_EQUAL_STRING(expected, rendered);
  TEST_ASSERT_EQUAL_MEMORY(expected, rendered, n);
}

void test_corpus_the_bearer_header_is_the_one_the_contract_declares() {
  loadHttpCorpus();
  // The key and the whole header value are both in the corpus, so the header
  // NAME and the `Bearer ` prefix are pinned from both sides. A correct key
  // under the wrong name is a 401 nobody can explain.
  char key[devapi::kMaxApiKeyLen + 1U] = {};
  TEST_ASSERT_TRUE(
      corpus::stringValue(corpus::member(g_httpCases.root(), "device_api_key"), key, sizeof(key), nullptr));

  char expected[devapi::kAuthorizationBufSize] = {};
  TEST_ASSERT_TRUE(corpus::stringValue(corpus::member(requestVector("heartbeat-request"), "authorization"),
                                       expected, sizeof(expected), nullptr));

  char rendered[devapi::kAuthorizationBufSize] = {};
  TEST_ASSERT_TRUE(devapi::renderAuthorization(rendered, sizeof(rendered), key) > 0U);
  TEST_ASSERT_EQUAL_STRING(expected, rendered);
  TEST_ASSERT_EQUAL_STRING("Authorization", devapi::kHeaderAuthorization);
}

void test_corpus_events_body_is_byte_identical_to_the_contract() {
  loadHttpCorpus();
  // The wrap vector doubles as the events body's shape: `mac` at the top level
  // beside the batch uptime, and both uptimes past 2^32.
  char expected[512] = {};
  const size_t n = bodyOf(requestVector("events-request-across-the-millis-wrap"), expected, sizeof(expected));

  eventq::Event event;
  event.seq = 41U;
  event.kind = eventq::Kind::Activation;
  event.court = 1U;
  event.method = eventq::Method::Qr;
  event.durationMs = 2700000UL;
  event.uptimeMs = 0xFFFFF000UL;
  TEST_ASSERT_TRUE(event.setSubject("TOKEN-B"));

  char rendered[devlink::kEventBodyCap] = {};
  const size_t renderedLen =
      devlink::renderEventBody(rendered, sizeof(rendered), corpusMac(), 0U, 0x100000000ULL + 20000ULL, event);
  TEST_ASSERT_EQUAL_size_t(n, renderedLen);
  TEST_ASSERT_EQUAL_STRING(expected, rendered);
  TEST_ASSERT_EQUAL_MEMORY(expected, rendered, n);
}

void test_corpus_roster_pushes_load_exactly_as_the_contract_declares_them() {
  loadHttpCorpus();
  // The three roster vectors, driven through the reader that actually consumes
  // them. Each declares its own expected roster in `expect`, so this hardcodes
  // nothing the two sides have to agree on separately.
  const char* const ids[] = {"heartbeat-response-court-numbers", "heartbeat-response-roster-single",
                             "heartbeat-response-roster-full", "heartbeat-response-roster-negative-opens"};

  // Static: the roster-full body is allowed the box's whole 2048-byte response
  // buffer, which is too much for a Unity test frame on some hosts.
  static uint8_t bytes[2048];
  static char body[sizeof(bytes) + 1U];

  for (const char* id : ids) {
    const char* vector = responseVector(id);
    size_t n = 0U;
    TEST_ASSERT_TRUE_MESSAGE(corpus::hexField(vector, "body_hex", bytes, sizeof(bytes), &n), id);
    memcpy(body, bytes, n);
    body[n] = '\0';

    // The declared roster length, counted from the vector rather than typed here.
    const char* expect = corpus::member(vector, "expect");
    TEST_ASSERT_NOT_NULL_MESSAGE(expect, id);
    size_t declared = 0U;
    const char* element = nullptr;
    corpus::ArrayIter entries(corpus::member(expect, "roster"));
    while (entries.next(&element)) {
      ++declared;
    }

    Cache cache(kSixHoursMs);
    const devlink::SyncResult r = devlink::applyRoster(body, n, cache, kBaseMid);
    TEST_ASSERT_TRUE_MESSAGE(r.replaced, id);
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(0U, r.rejected, id);
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(0U, r.dropped, id);
    TEST_ASSERT_EQUAL_size_t_MESSAGE(declared, static_cast<size_t>(r.accepted), id);
    TEST_ASSERT_EQUAL_size_t_MESSAGE(declared, static_cast<size_t>(cache.size()), id);

    // And the court list, which is what a granted court number is resolved
    // through. Every vector declares [1,2,3,4].
    int16_t courts[devlink::kMaxCourts] = {};
    uint8_t count = 0U;
    TEST_ASSERT_TRUE_MESSAGE(devlink::parseCourtNumbers(body, n, courts, count), id);
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(4U, count, id);
    TEST_ASSERT_EQUAL_INT16_MESSAGE(1, courts[0], id);
    TEST_ASSERT_EQUAL_INT16_MESSAGE(4, courts[3], id);
  }

  // The negative-opens vector is the one with a rule of its own: a booking that
  // started thirty minutes ago clamps to "open now" rather than wrapping into a
  // window half a century away.
  size_t n = 0U;
  TEST_ASSERT_TRUE(corpus::hexField(responseVector("heartbeat-response-roster-negative-opens"), "body_hex",
                                    bytes, sizeof(bytes), &n));
  memcpy(body, bytes, n);
  body[n] = '\0';
  Cache cache(kSixHoursMs);
  TEST_ASSERT_TRUE(devlink::applyRoster(body, n, cache, kBaseMid).replaced);
  TEST_ASSERT_TRUE(cache.decide("K4TQ8N2ZV7BM", 0U, kBaseMid).verdict == roster::Verdict::Allow);
}

/// B5 — the three `member_display` vectors the contracts lane pinned.
///
/// THE BACKEND DOES NOT EMIT THIS FIELD YET. The corpus declares the contract
/// the server must then satisfy, which is the direction this corpus is allowed
/// to run in — so the firmware half reads it TOLERANTLY: absent is the ordinary
/// case today and stays the ordinary case for a club that never fills the field
/// in, and an unnamed member must still get their court.
void test_corpus_member_display_names_the_member_or_greets_them_anyway() {
  loadHttpCorpus();
  const bridgelogic::ScanFlow flow;
  char body[512] = {};
  bridgelogic::ScreenFacts facts;

  // Present. The greeting is the member's only confirmation that the box knows
  // who they are, and it never changes what they are granted.
  size_t n = bodyOf(responseVector("activate-response-ok-named"), body, sizeof(body));
  bridgelogic::ActivationResult r =
      flow.onActivateResponse(200U, body, n, kCorpusCourts, devlink::kMaxCourts);
  TEST_ASSERT_TRUE(r.outcome.action == court::Action::TurnOn);
  TEST_ASSERT_EQUAL_UINT8(2U, r.outcome.court); // court_number 3 of [1,2,3,4]
  bridgelogic::readMemberDisplay(body, n, facts);
  TEST_ASSERT_EQUAL_STRING("DEAN M", facts.name);
  TEST_ASSERT_EQUAL_STRING("HI DEAN M",
                           bridgelogic::screenFor(bridgelogic::ScreenId::CardBooked, facts).rows[0]);

  // Absent: HI THERE, and the court still comes on. Absence changes the
  // greeting and nothing else.
  n = bodyOf(responseVector("activate-response-unnamed"), body, sizeof(body));
  r = flow.onActivateResponse(200U, body, n, kCorpusCourts, devlink::kMaxCourts);
  TEST_ASSERT_TRUE(r.outcome.action == court::Action::TurnOn);
  TEST_ASSERT_EQUAL_UINT8(1U, r.outcome.court);
  TEST_ASSERT_EQUAL_UINT32(1800U * 1000U, r.outcome.durationMs);
  bridgelogic::readMemberDisplay(body, n, facts);
  TEST_ASSERT_EQUAL_STRING("", facts.name);
  TEST_ASSERT_EQUAL_STRING("HI THERE",
                           bridgelogic::screenFor(bridgelogic::ScreenId::CardBooked, facts).rows[0]);

  // Forty characters. devapi::json REFUSES rather than truncates — half a name
  // is a different member's — so the box greets and NEVER shows a cut name.
  n = bodyOf(responseVector("activate-response-name-too-long"), body, sizeof(body));
  r = flow.onActivateResponse(200U, body, n, kCorpusCourts, devlink::kMaxCourts);
  TEST_ASSERT_TRUE(r.outcome.action == court::Action::TurnOn);
  TEST_ASSERT_EQUAL_UINT8(0U, r.outcome.court);
  bridgelogic::readMemberDisplay(body, n, facts);
  TEST_ASSERT_EQUAL_STRING("", facts.name);
  const bridgelogic::Screen card = bridgelogic::screenFor(bridgelogic::ScreenId::CardBooked, facts);
  TEST_ASSERT_EQUAL_STRING("HI THERE", card.rows[0]);
  TEST_ASSERT_NULL(strstr(card.rows[0], "BARTHOLOMEW"));
}

/// B8 — the court box's events, now carrying a real boot id.
///
/// The vector is the same event as the millis-wrap one with a non-zero
/// `boot_id` in it, which is the whole of the change: `boot_id` sits second,
/// between `mac` and the batch `uptime_ms`, and is OMITTED when it is zero —
/// the compatibility hinge that let this box render the old body byte for byte
/// while it still passed 0.
void test_corpus_the_event_body_carries_this_boots_id() {
  loadHttpCorpus();
  char expected[512] = {};
  const size_t n = bodyOf(requestVector("event-request-boot-id"), expected, sizeof(expected));

  eventq::Event event;
  event.seq = 41U;
  event.kind = eventq::Kind::Activation;
  event.court = 1U;
  event.method = eventq::Method::Qr;
  event.durationMs = 2700000UL;
  event.uptimeMs = 0xFFFFF000UL;
  TEST_ASSERT_TRUE(event.setSubject("TOKEN-B"));

  char rendered[devlink::kEventBodyCap] = {};
  const size_t renderedLen =
      devlink::renderEventBody(rendered, sizeof(rendered), corpusMac(), bridgelogic::bootIdFrom(2596069104UL),
                               0x100000000ULL + 20000ULL, event);
  TEST_ASSERT_EQUAL_size_t(n, renderedLen);
  TEST_ASSERT_EQUAL_STRING(expected, rendered);
  TEST_ASSERT_EQUAL_MEMORY(expected, rendered, n);
}

/// B9 — the power-dip restore's five response vectors, through the parser that
/// actually consumes them.
///
/// The court box is the half that ACTS on these, so this suite is where they
/// are bound: a vector nobody executes is a contract the two sides only think
/// they agree on.
void test_corpus_the_relay_restore_vectors_parse_exactly_as_declared() {
  loadHttpCorpus();
  char body[1024] = {};
  devlink::RelayRestore restored[bridgelogic::kStateCourts] = {};
  uint8_t count = 0U;
  uint8_t rejected = 0U;

  // Two relays to restore, with their booking references.
  size_t n = bodyOf(responseVector("heartbeat-response-relays-restore"), body, sizeof(body));
  TEST_ASSERT_TRUE(
      devlink::parseRelayRestore(body, n, restored, bridgelogic::kStateCourts, count, &rejected));
  TEST_ASSERT_EQUAL_UINT8(2U, count);
  TEST_ASSERT_EQUAL_UINT8(0U, rejected);
  TEST_ASSERT_EQUAL_UINT8(0U, restored[0].relay);
  TEST_ASSERT_EQUAL_UINT32(1834U, restored[0].remainingSeconds);
  TEST_ASSERT_EQUAL_STRING("3fa85f64", restored[0].bookingRef);
  TEST_ASSERT_EQUAL_UINT8(2U, restored[1].relay);
  TEST_ASSERT_EQUAL_UINT32(600U, restored[1].remainingSeconds);

  // AN EMPTY ARRAY SWITCHES NOTHING OFF. It is information that nothing SHOULD
  // be on, which matters only at boot when nothing IS on — making it an
  // off-command would hand the API a way to darken a court, which it must not
  // have. The key is PRESENT, so it is a served restore of zero relays.
  count = 0xFFU;
  rejected = 0xFFU;
  n = bodyOf(responseVector("heartbeat-response-relays-empty"), body, sizeof(body));
  TEST_ASSERT_TRUE(
      devlink::parseRelayRestore(body, n, restored, bridgelogic::kStateCourts, count, &rejected));
  TEST_ASSERT_EQUAL_UINT8(0U, count);
  TEST_ASSERT_EQUAL_UINT8(0U, rejected);

  // Absent is a THIRD state: the server said nothing about relays at all.
  n = bodyOf(responseVector("heartbeat-response-relays-absent"), body, sizeof(body));
  TEST_ASSERT_FALSE(
      devlink::parseRelayRestore(body, n, restored, bridgelogic::kStateCourts, count, &rejected));

  // Mixed malformed: two are skipped and COUNTED, the third is applied. A
  // diagnostic that silently drops what it could not read is a contract drift
  // nobody hears about.
  n = bodyOf(responseVector("heartbeat-response-relays-malformed"), body, sizeof(body));
  TEST_ASSERT_TRUE(
      devlink::parseRelayRestore(body, n, restored, bridgelogic::kStateCourts, count, &rejected));
  TEST_ASSERT_EQUAL_UINT8(1U, count);
  TEST_ASSERT_EQUAL_UINT8(2U, rejected);
  TEST_ASSERT_EQUAL_UINT8(1U, restored[0].relay);
  TEST_ASSERT_EQUAL_UINT32(500U, restored[0].remainingSeconds);

  // Past the relay cap, UNCAPPED on the wire: the wire carries what the server
  // believes and the clamp is the device's, applied once at the point of use.
  // Narrowing it here would make the two halves of a disagreement invisible.
  n = bodyOf(responseVector("heartbeat-response-relays-over-cap"), body, sizeof(body));
  TEST_ASSERT_TRUE(
      devlink::parseRelayRestore(body, n, restored, bridgelogic::kStateCourts, count, &rejected));
  TEST_ASSERT_EQUAL_UINT8(1U, count);
  TEST_ASSERT_EQUAL_UINT32(9999U, restored[0].remainingSeconds);
  TEST_ASSERT_TRUE(restored[0].remainingSeconds > proto::kRelayHardCapSeconds);
}

/// B9 — the nine operator settings, in range and out of it.
///
/// They are read ONE LEVEL DEEP from the top-level `config` and nowhere else:
/// devapi's flat scan takes the FIRST match in document order, so a vendor or
/// diagnostics block nesting the same names would otherwise drive the screen.
void test_corpus_the_lcd_settings_are_adopted_and_clamped() {
  loadHttpCorpus();
  char body[1024] = {};

  devlink::LcdSettings settings;
  size_t n = bodyOf(responseVector("heartbeat-response-lcd-settings"), body, sizeof(body));
  TEST_ASSERT_TRUE(devlink::parseLcdSettings(body, n, settings));
  TEST_ASSERT_EQUAL_UINT32(25000UL, settings.revertMs);
  TEST_ASSERT_EQUAL_UINT32(45000UL, settings.choiceMs);
  TEST_ASSERT_EQUAL_UINT32(6000UL, settings.cardMs);
  TEST_ASSERT_EQUAL_UINT32(7000UL, settings.hintMs);
  TEST_ASSERT_EQUAL_UINT32(200000UL, settings.scanMemoryMs);
  TEST_ASSERT_EQUAL_UINT32(240UL * 60000UL, settings.clockTrustMs);
  TEST_ASSERT_FALSE(settings.relayRestoreEnabled);
  TEST_ASSERT_FALSE(settings.faultReporting);
  TEST_ASSERT_EQUAL_UINT16(75U, settings.faultMaxPerHour);
  // The cross-key invariant: the box must not forget who scanned while their
  // selection is still live on the pad, or the next person's presses buy on
  // their token.
  TEST_ASSERT_TRUE(settings.scanMemoryMs >= settings.choiceMs);

  // Every numeric setting past a bound, in BOTH directions across the set.
  // Each is CLAMPED and none refuses the eight beside it: a club that typed
  // 3600 into one field must not thereby lose its button map.
  devlink::LcdSettings clamped;
  n = bodyOf(responseVector("heartbeat-response-lcd-settings-out-of-range"), body, sizeof(body));
  TEST_ASSERT_TRUE(devlink::parseLcdSettings(body, n, clamped));
  TEST_ASSERT_EQUAL_UINT32(devlink::kLcdRevertMaxSeconds * 1000UL, clamped.revertMs);
  TEST_ASSERT_EQUAL_UINT32(devlink::kLcdChoiceMinSeconds * 1000UL, clamped.choiceMs);
  TEST_ASSERT_EQUAL_UINT32(devlink::kLcdCardMaxSeconds * 1000UL, clamped.cardMs);
  TEST_ASSERT_EQUAL_UINT32(devlink::kLcdHintMinSeconds * 1000UL, clamped.hintMs);
  TEST_ASSERT_EQUAL_UINT32(devlink::kClockTrustMaxMinutes * 60000UL, clamped.clockTrustMs);
  TEST_ASSERT_EQUAL_UINT16(devlink::kMaxFaultMaxPerHour, clamped.faultMaxPerHour);
  TEST_ASSERT_TRUE(clamped.faultReporting);
  // The invariant is held by RAISING the memory, never by lowering the choice
  // window: shortening a window somebody is mid-decision in is the one timeout
  // on this box that can lose a half-made purchase.
  TEST_ASSERT_TRUE(clamped.scanMemoryMs >= clamped.choiceMs);
  TEST_ASSERT_EQUAL_UINT32(clamped.choiceMs, clamped.scanMemoryMs);

  // The button map beside them is untouched by any of it.
  const size_t at = devapi::json::findArray(body, n, "button_map");
  TEST_ASSERT_NOT_EQUAL(devapi::json::kNotFound, at);
}

/// B9 — the two heartbeat REQUEST vectors the box's own diagnostics produce,
/// byte for byte. Every field is omitted at its nothing value, so a box with
/// nothing to report renders the body it has always rendered.
void test_corpus_the_heartbeat_report_fields_are_byte_identical_to_the_contract() {
  loadHttpCorpus();
  char expected[512] = {};

  devlink::HeartbeatReport report;
  report.restoredRelays = 2U;

  size_t n = bodyOf(requestVector("heartbeat-request-restored"), expected, sizeof(expected));
  char rendered[devlink::kHeartbeatBodyCap] = {};
  size_t renderedLen =
      devlink::renderHeartbeatBody(rendered, sizeof(rendered), corpusMac(), "2.0.0", 86400000ULL, report);
  TEST_ASSERT_EQUAL_size_t(n, renderedLen);
  TEST_ASSERT_EQUAL_STRING(expected, rendered);

  // `relay_state` is THREE states, not two: a null pointer omits the key, and a
  // non-null pointer with a count of zero renders `[]`. A board that could not
  // tell those apart would show a dark court as unknown and an unknown court as
  // dark.
  const devlink::RelayState state[2] = {{0U, 1834U}, {2U, 600U}};
  report.relayState = state;
  report.relayStateCount = 2U;
  n = bodyOf(requestVector("heartbeat-request-relay-state"), expected, sizeof(expected));
  renderedLen =
      devlink::renderHeartbeatBody(rendered, sizeof(rendered), corpusMac(), "2.0.0", 86400000ULL, report);
  TEST_ASSERT_EQUAL_size_t(n, renderedLen);
  TEST_ASSERT_EQUAL_STRING(expected, rendered);
  TEST_ASSERT_EQUAL_MEMORY(expected, rendered, n);
}

/// Every http vector this suite binds to, by id. The executed-count gate below
/// compares this against the corpus and the manifest in both directions.
const char* const kBoundHttpVectors[] = {
    "heartbeat-request",
    "activate-request",
    "walkup-request",
    "events-request-across-the-millis-wrap",
    "activate-request-escaped-scan",
    "walkup-request-escaped-scan",
    "events-request-escaped-subject",
    "activate-response-ok",
    "activate-response-too-early",
    "activate-response-ended",
    "walkup-response-replayed",
    "walkup-response-replayed-remainder",
    "heartbeat-response-court-numbers",
    "heartbeat-response-roster-single",
    "heartbeat-response-roster-full",
    "heartbeat-response-roster-negative-opens",
    "activate-response-ok-named",
    "activate-response-unnamed",
    "activate-response-name-too-long",
    "event-request-boot-id",
    "heartbeat-request-restored",
    "heartbeat-request-relay-state",
    "heartbeat-response-relays-restore",
    "heartbeat-response-relays-empty",
    "heartbeat-response-relays-absent",
    "heartbeat-response-relays-malformed",
    "heartbeat-response-relays-over-cap",
    "heartbeat-response-lcd-settings",
    "heartbeat-response-lcd-settings-out-of-range",
    "extend-request",
    "extend-response-ok",
    "extend-response-truncated",
    "extend-response-court-not-lit",
    "extend-response-no-time",
    "extend-response-insufficient",
    "activate-response-greeting",
    // v3 (device-api.md §2-§9, §12).
    "v3-heartbeat-request",
    "v3-heartbeat-request-first-beat",
    "v3-heartbeat-request-rolled-back",
    "v3-heartbeat-request-relight",
    "v3-events-request-release-cause",
    "v3-heartbeat-request-telemetry",
    "v3-heartbeat-request-widest",
    "v3-heartbeat-response-snapshot",
    "v3-heartbeat-response-unacknowledged",
    "v3-heartbeat-response-display-expanded",
    "v3-heartbeat-response-display-out-of-range",
    "v3-heartbeat-response-ota-offer",
    "v3-heartbeat-response-key-next",
    "v3-heartbeat-response-net",
    "v3-heartbeat-response-widest",
    "v3-activate-response-play-remaining",
    "v3-heartbeat-response-hardware",
    "v3-heartbeat-response-lifeline-only",
};

bool isBound(const char* id) {
  for (const char* bound : kBoundHttpVectors) {
    if (strcmp(bound, id) == 0) {
      return true;
    }
  }
  return false;
}

void test_corpus_every_http_section_is_declared_and_every_vector_is_bound() {
  loadHttpCorpus();
  // The anti-drift assertion, moved here when the crypto suite it used to live
  // in lost its reason to read this corpus. It has teeth in three directions:
  // a section in cases.json the manifest does not declare, a section the
  // manifest declares that cases.json does not hold, and — the one a checksum
  // over the file would miss — a vector nobody in this suite actually executes.
  corpus::File manifest;
  TEST_ASSERT_TRUE_MESSAGE(manifest.load("http", "manifest.json"), "http manifest not found");
  const char* counts = corpus::member(manifest.root(), "case_count");
  TEST_ASSERT_NOT_NULL(counts);

  char name[corpus::kMaxNameLen] = {};
  const char* value = nullptr;
  size_t sectionsSeen = 0U;
  size_t bound = 0U;

  corpus::ObjectIter sections(g_httpCases.root());
  while (sections.next(name, sizeof(name), &value)) {
    if (!corpus::isArray(value)) {
      continue; // device_api_key and device_mac are inputs, not case lists.
    }
    ++sectionsSeen;

    const char* declared = corpus::member(counts, name);
    TEST_ASSERT_NOT_NULL_MESSAGE(declared, "corpus section is not declared in the manifest");

    size_t inSection = 0U;
    const char* element = nullptr;
    corpus::ArrayIter it(value);
    while (it.next(&element)) {
      ++inSection;
      char id[64] = {};
      TEST_ASSERT_TRUE_MESSAGE(corpus::stringValue(corpus::member(element, "id"), id, sizeof(id), nullptr),
                               "every http vector needs an id — this suite binds by id, never by index");
      TEST_ASSERT_TRUE_MESSAGE(isBound(id), "corpus vector is executed by no test in this suite");
      ++bound;
    }
    TEST_ASSERT_EQUAL_size_t_MESSAGE(corpus::unsignedValue(declared), inSection, name);
  }

  size_t declaredSections = 0U;
  const char* countValue = nullptr;
  corpus::ObjectIter declaredIt(counts);
  while (declaredIt.next(name, sizeof(name), &countValue)) {
    ++declaredSections;
    TEST_ASSERT_NOT_NULL_MESSAGE(corpus::member(g_httpCases.root(), name),
                                 "manifest declares a section cases.json does not contain");
  }

  TEST_ASSERT_EQUAL_size_t(declaredSections, sectionsSeen);
  TEST_ASSERT_EQUAL_size_t(sizeof(kBoundHttpVectors) / sizeof(kBoundHttpVectors[0]), bound);
}

void test_corpus_walkup_body_is_byte_identical_to_the_contract() {
  loadHttpCorpus();
  char expected[512] = {};
  const size_t n = bodyOf(requestVector("walkup-request"), expected, sizeof(expected));

  // Sixty minutes on relay C, which this box maps to club court 3.
  bridgelogic::WalkUpRequest request;
  request.mac = corpusMac();
  request.intent.court = 2U;
  request.intent.minutes = 60U;
  request.courtNumber = kCorpusCourts[request.intent.court];
  request.token = "7Q3F9KM2XZ8B";
  request.nonce = "9f2a4c6e8b0d1f3a";

  char rendered[320] = {};
  const size_t renderedLen = bridgelogic::renderWalkUpBody(rendered, sizeof(rendered), request);
  TEST_ASSERT_EQUAL_size_t(n, renderedLen);
  TEST_ASSERT_EQUAL_STRING(expected, rendered);
  TEST_ASSERT_EQUAL_MEMORY(expected, rendered, n);
}

// ---------------------------------------------------------------------------
// R15 D15-1 — a scanned byte the Mega passed through
// ---------------------------------------------------------------------------
//
// The Mega's assembler admits quotes, backslashes and every byte above 0x7F,
// and the three scan bodies interpolated the token with a bare `%s`: a quote
// ended the string early, a lone 0xE9 was invalid UTF-8, and the server
// answered both 500. Each vector's `token_hex` is the scan as it came off the
// serial link; its `body_hex` is the escaped body, byte for byte.

/// The scan a vector declares in `field`, NUL-terminated into `out`.
void scanOf(const char* vector, const char* field, char* out, size_t cap) {
  uint8_t bytes[proto::kMaxArgLen] = {};
  size_t n = 0U;
  TEST_ASSERT_TRUE_MESSAGE(corpus::hexField(vector, field, bytes, sizeof(bytes), &n), field);
  TEST_ASSERT_TRUE(n < cap);
  memcpy(out, bytes, n);
  out[n] = '\0';
}

/// True when every byte is printable ASCII: no raw high byte, no control byte.
bool asciiOnly(const char* s) {
  for (size_t i = 0U; s[i] != '\0'; ++i) {
    const unsigned char c = static_cast<unsigned char>(s[i]);
    if (c < 0x20U || c > 0x7EU) {
      return false;
    }
  }
  return true;
}

void test_corpus_activate_escapes_a_scan_the_mega_passed_through() {
  loadHttpCorpus();
  const char* vector = requestVector("activate-request-escaped-scan");
  char expected[512] = {};
  const size_t n = bodyOf(vector, expected, sizeof(expected));
  char token[proto::kMaxArgLen + 1U] = {};
  scanOf(vector, "token_hex", token, sizeof(token));

  char rendered[bridgelogic::kActivateBodyCap] = {};
  const size_t renderedLen = bridgelogic::renderActivateBody(rendered, sizeof(rendered), corpusMac(), token);
  TEST_ASSERT_EQUAL_STRING(expected, rendered);
  TEST_ASSERT_EQUAL_size_t(n, renderedLen);
  TEST_ASSERT_TRUE(asciiOnly(rendered));
}

void test_corpus_walkup_escapes_a_scan_the_mega_passed_through() {
  loadHttpCorpus();
  const char* vector = requestVector("walkup-request-escaped-scan");
  char expected[512] = {};
  const size_t n = bodyOf(vector, expected, sizeof(expected));
  char token[proto::kMaxArgLen + 1U] = {};
  scanOf(vector, "token_hex", token, sizeof(token));

  bridgelogic::WalkUpRequest request;
  request.mac = corpusMac();
  request.intent.court = 2U;
  request.intent.minutes = 60U;
  request.courtNumber = kCorpusCourts[request.intent.court];
  request.token = token;
  request.nonce = "9f2a4c6e8b0d1f3a";

  char rendered[bridgelogic::kWalkUpBodyCap] = {};
  const size_t renderedLen = bridgelogic::renderWalkUpBody(rendered, sizeof(rendered), request);
  TEST_ASSERT_EQUAL_STRING(expected, rendered);
  TEST_ASSERT_EQUAL_size_t(n, renderedLen);
  TEST_ASSERT_TRUE(asciiOnly(rendered));
}

/// The event half: the subject was escaped for `"` and `\` already (G4 B1),
/// but carried 0xE9 raw, and that body is the one that pinned the queue.
void test_corpus_event_escapes_a_subject_the_mega_passed_through() {
  loadHttpCorpus();
  const char* vector = requestVector("events-request-escaped-subject");
  char expected[512] = {};
  const size_t n = bodyOf(vector, expected, sizeof(expected));
  char subject[proto::kMaxArgLen + 1U] = {};
  scanOf(vector, "subject_hex", subject, sizeof(subject));

  eventq::Event event;
  event.seq = 7U;
  event.kind = eventq::Kind::UnknownScan;
  event.court = eventq::Event::kNoCourt;
  event.method = eventq::Method::Qr;
  event.uptimeMs = 86390000UL;
  TEST_ASSERT_TRUE(event.setSubject(subject));

  char rendered[devlink::kEventBodyCap] = {};
  const size_t renderedLen =
      devlink::renderEventBody(rendered, sizeof(rendered), corpusMac(), 0U, 86400000ULL, event);
  TEST_ASSERT_EQUAL_STRING(expected, rendered);
  TEST_ASSERT_EQUAL_size_t(n, renderedLen);
  TEST_ASSERT_TRUE(asciiOnly(rendered));
}

/// THE BUFFERS THE BRIDGE ACTUALLY RENDERS INTO hold the worst scan there is:
/// a full-length one of bytes the escaper writes six for one, beside the
/// longest value of every other field. A body that does not fit is not sent —
/// the box falls back to the roster or the desk — and that fallback must be a
/// choice about the token, never an accident of a buffer sized for ASCII.
void test_the_scan_bodies_fit_the_worst_scan_in_the_bridges_own_buffers() {
  char token[proto::kMaxArgLen + 1U] = {};
  for (size_t i = 0U; i < proto::kMaxArgLen; ++i) {
    token[i] = static_cast<char>(0xFF);
  }

  char activate[bridgelogic::kActivateBodyCap] = {};
  TEST_ASSERT_TRUE(bridgelogic::renderActivateBody(activate, sizeof(activate), corpusMac(), token) > 0U);
  TEST_ASSERT_TRUE(asciiOnly(activate));

  bridgelogic::WalkUpRequest walkUp;
  walkUp.mac = corpusMac();
  walkUp.intent.court = 3U;
  walkUp.intent.minutes = UINT16_MAX;
  walkUp.courtNumber = INT16_MIN;
  walkUp.token = token;
  walkUp.nonce = "9f2a4c6e8b0d1f3a";
  char walkUpBody[bridgelogic::kWalkUpBodyCap] = {};
  TEST_ASSERT_TRUE(bridgelogic::renderWalkUpBody(walkUpBody, sizeof(walkUpBody), walkUp) > 0U);
  TEST_ASSERT_TRUE(asciiOnly(walkUpBody));

  bridgelogic::PayForRequest payFor;
  payFor.mac = corpusMac();
  payFor.token = token;
  payFor.courtNumber = INT16_MIN;
  payFor.nonce = "9f2a4c6e8b0d1f3a";
  payFor.confirm = true;
  payFor.amountLabel = "9999";
  char payForBody[bridgelogic::kPayForBodyCap] = {};
  TEST_ASSERT_TRUE(bridgelogic::renderPayForBody(payForBody, sizeof(payForBody), payFor) > 0U);
  TEST_ASSERT_TRUE(asciiOnly(payForBody));
}

/// Fuzzed: whatever the Mega hands over, the token cannot end its string or
/// add a field. Every body keeps exactly its own quotes, and its `mac` and
/// `method` survive — the two fields a crafted scan used to be able to reach.
void test_the_scan_bodies_hold_their_shape_whatever_was_scanned() {
  static const char kAlphabet[] = "\"\\:,{}[]aZ09 \t\x01\x7f\x80\xc3\xa9\xe9\xff";
  const size_t alphabetLen = sizeof(kAlphabet) - 1U;
  uint32_t state = 0x1D15F00DU;
  for (int iteration = 0; iteration < 5000; ++iteration) {
    char token[proto::kMaxArgLen + 1U] = {};
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    const size_t length = 1U + state % proto::kMaxArgLen;
    for (size_t i = 0U; i < length; ++i) {
      state ^= state << 13;
      state ^= state >> 17;
      state ^= state << 5;
      token[i] = kAlphabet[state % alphabetLen];
    }

    char body[bridgelogic::kActivateBodyCap] = {};
    TEST_ASSERT_TRUE_MESSAGE(bridgelogic::renderActivateBody(body, sizeof(body), corpusMac(), token) > 0U,
                             "a scan within the arg cap must always render");
    TEST_ASSERT_TRUE_MESSAGE(asciiOnly(body), body);
    TEST_ASSERT_TRUE_MESSAGE(devapi::json::isCompleteObject(body, strlen(body)), body);
    char text[16] = {};
    TEST_ASSERT_TRUE_MESSAGE(
        devapi::json::topLevelStringField(body, strlen(body), "method", text, sizeof(text)), body);
    TEST_ASSERT_EQUAL_STRING_MESSAGE("qr", text, body);
    TEST_ASSERT_TRUE_MESSAGE(devapi::json::topLevelStringField(body, strlen(body), "mac", text, sizeof(text)),
                             body);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(corpusMac(), text, body);
  }
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
  bridgelogic::LinkState l = link(true);
  TEST_ASSERT_TRUE(flow.onScan(l) == bridgelogic::Attempt::Online);
  l.courtCount = 0U;
  TEST_ASSERT_TRUE(flow.onScan(l) == bridgelogic::Attempt::RosterOnly);
  l.courtCount = 1U;
  TEST_ASSERT_TRUE(flow.onScan(l) == bridgelogic::Attempt::Online);
}

void test_scan_flow_an_open_breaker_is_the_rosters_scan() {
  const bridgelogic::ScanFlow flow;
  bridgelogic::LinkState l = link(true);
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
      {"{\"activated\":false,\"reason\":\"ended\"}", true},
      // Review round 8 (D8-1): a code the server already acted on is not a
      // member at the panel — it may be a photo of the code that just lit
      // somebody's court — and a reason this build cannot name is not one it
      // can vouch for. Neither arms a single button.
      {"{\"activated\":false,\"reason\":\"code_used\"}", false},
      {"{\"activated\":false,\"reason\":\"something_newer\"}", false},
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

void test_a_used_code_answered_online_arms_nothing_and_cannot_buy() {
  // D8-1. A photo of the code that just lit court B, scanned here: the server
  // answers code_used. It used to be "recognised" — the window armed unbound,
  // the scan stayed remembered, and the next court press sent it as the buyer
  // of a walk-up or a pay-for on the victim's minutes.
  const bridgelogic::ScanFlow flow;
  const char used[] =
      "{\"activated\":false,\"reason\":\"code_used\",\"court_number\":2,\"granted_seconds\":0}";
  const bridgelogic::ActivationResult r =
      flow.onActivateResponse(200U, used, len(used), kCourts, kCourtCount);
  TEST_ASSERT_FALSE(r.fallbackToRoster);
  TEST_ASSERT_EQUAL_STRING("CODE USED", r.outcome.line1);
  bridgelogic::AuthPolicy auth(30000UL);
  TEST_ASSERT_TRUE(auth.afterScan(r.outcome, 1000U) == bridgelogic::AuthCommand::Disarm);
  TEST_ASSERT_FALSE(auth.armed(1001U));
  TEST_ASSERT_FALSE(bridgelogic::scanStaysBuyable(r.outcome));

  // A known member with no booking here is who buys time: armed, and the scan
  // stays theirs for the buttons.
  const char none[] = "{\"activated\":false,\"reason\":\"no_booking\",\"granted_seconds\":0}";
  const bridgelogic::ActivationResult n =
      flow.onActivateResponse(200U, none, len(none), kCourts, kCourtCount);
  TEST_ASSERT_TRUE(auth.afterScan(n.outcome, 2000U) == bridgelogic::AuthCommand::Arm);
  TEST_ASSERT_TRUE(bridgelogic::scanStaysBuyable(n.outcome));

  // A grant spends it (H1); an unknown token never had it.
  const char lit[] = "{\"activated\":true,\"reason\":\"ok\",\"court_number\":7,\"granted_seconds\":600}";
  TEST_ASSERT_FALSE(bridgelogic::scanStaysBuyable(
      flow.onActivateResponse(200U, lit, len(lit), kCourts, kCourtCount).outcome));
  const char nobody[] = "{\"activated\":false,\"reason\":\"not_recognised\"}";
  TEST_ASSERT_FALSE(bridgelogic::scanStaysBuyable(
      flow.onActivateResponse(200U, nobody, len(nobody), kCourts, kCourtCount).outcome));
}

void test_an_activation_waits_on_its_own_words_never_buying_your_time() {
  // D8-2. Every online activation painted OneMoment, whose row 1 is the
  // walk-up's "Buying your time" — a booked member read that while their
  // booking activated. The walk-up keeps it; the activation has its own.
  bridgelogic::ScreenFacts facts;
  const bridgelogic::Screen wait = bridgelogic::screenFor(bridgelogic::kActivateWaitScreen, facts);
  TEST_ASSERT_EQUAL_STRING("ONE MOMENT", wait.rows[0]);
  TEST_ASSERT_EQUAL_STRING("Checking code", wait.rows[1]);
  TEST_ASSERT_EQUAL_STRING("PLEASE WAIT", wait.rows[3]);
  TEST_ASSERT_EQUAL_UINT16(bridgelogic::kWaitSeconds, wait.holdSeconds);
  TEST_ASSERT_TRUE(strstr(wait.rows[1], "Buying") == nullptr);
  const bridgelogic::Screen walkUp = bridgelogic::screenFor(bridgelogic::ScreenId::OneMoment, facts);
  TEST_ASSERT_EQUAL_STRING("Buying your time", walkUp.rows[1]);
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

/// R18 D18-4. BUSY / PRESS AGAIN is shown for the CHOICE window, and the press
/// it asks for only reaches the bridge if the Mega's button window is still
/// armed and the scan still remembered. A walk-up or pay-for that got no
/// decision used to leave both where the SCAN left them, so a member who
/// pressed again a few seconds before the countdown ended pressed into
/// nothing. An undecided answer re-arms the window for a full TTL — never
/// changing which court an OFF press may release — and holds the scan for at
/// least the choice window, never shortening it.
void test_auth_policy_an_undecided_answer_keeps_press_again_working_for_the_whole_choice_window() {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    const uint32_t ttl = 30000UL;
    const uint32_t choice = 20000UL;

    // Unbound: a recognised refusal armed it, 28 s pass, the walk-up is BUSY.
    bridgelogic::AuthPolicy auth(ttl);
    TEST_ASSERT_TRUE(auth.afterScan(outcomeOf(court::Action::Refuse, eventq::Event::kNoCourt, true), base) ==
                     bridgelogic::AuthCommand::Arm);
    const uint32_t busyAt = base + 28000UL;
    TEST_ASSERT_TRUE_MESSAGE(auth.afterUndecided(busyAt) == bridgelogic::AuthCommand::Arm,
                             "an undecided answer left the Mega's window to lapse under PRESS AGAIN");
    TEST_ASSERT_TRUE(auth.armed(busyAt + choice));
    TEST_ASSERT_FALSE(auth.lapsed(busyAt + ttl - 1U));
    TEST_ASSERT_EQUAL_UINT8(bridgelogic::AuthPolicy::kUnbound, auth.boundCourt());

    // Bound: the member's own court stays theirs to switch off, and only theirs.
    bridgelogic::AuthPolicy bound(ttl);
    static_cast<void>(bound.afterHeldCourtRescan(2U, base));
    TEST_ASSERT_TRUE(bound.afterUndecided(busyAt) == bridgelogic::AuthCommand::Arm);
    TEST_ASSERT_TRUE(bound.allowsRelease(2U, busyAt + choice));
    TEST_ASSERT_FALSE(bound.allowsRelease(1U, busyAt + choice));

    // A window that had already lapsed is opened again, unbound.
    bridgelogic::AuthPolicy lapsed(ttl);
    static_cast<void>(lapsed.afterHeldCourtRescan(1U, base));
    TEST_ASSERT_TRUE(lapsed.lapsed(base + ttl));
    TEST_ASSERT_TRUE(lapsed.afterUndecided(base + ttl + 5U) == bridgelogic::AuthCommand::Arm);
    TEST_ASSERT_TRUE(lapsed.armed(base + ttl + 5U + choice));
    TEST_ASSERT_FALSE(lapsed.allowsRelease(1U, base + ttl + 5U));

    // The scan: 2 s left at the BUSY answer becomes the whole choice window...
    bridgelogic::ScanMemory scan(ttl, choice);
    scan.remember(base);
    TEST_ASSERT_TRUE(scan.holdForPressAgain(busyAt));
    TEST_ASSERT_FALSE_MESSAGE(scan.expired(busyAt + choice - 1U), "the scan lapsed under PRESS AGAIN");
    TEST_ASSERT_TRUE(scan.expired(busyAt + choice));
    // ...and 25 s left is never cut to 20.
    scan.remember(base);
    TEST_ASSERT_TRUE(scan.holdForPressAgain(base + 5000UL));
    TEST_ASSERT_FALSE(scan.expired(base + ttl - 1U));
    TEST_ASSERT_TRUE(scan.expired(base + ttl));
  }
}

/// The server's own §4.2 bound (MemberCodeSettings.MaxScanAgeMs), written out
/// here rather than read from ScanMemory so the box's ceiling is checked
/// against the server's rule and not against itself.
uint32_t serverMaxScanAgeMs(uint32_t scanMemoryMs, uint32_t choiceMs) {
  return scanMemoryMs + choiceMs + 30000UL;
}

struct ScanSettings {
  uint32_t scanMemoryMs;
  uint32_t choiceMs;
};

/// Defaults, both ends of each range, and the parser's raised floor.
const ScanSettings kScanSettings[] = {
    {30000UL, 20000UL}, {20000UL, 20000UL},  {120000UL, 20000UL},
    {5000UL, 5000UL},   {300000UL, 60000UL}, {60000UL, 60000UL},
};
constexpr size_t kScanSettingsCount = sizeof(kScanSettings) / sizeof(kScanSettings[0]);

/// R19 D19-3. The scan armed with the COMPILE-TIME scan memory, so a club's
/// `scan_memory_seconds` reached the Mega's window and the server's bound but
/// never the bridge's own memory of who scanned: 120 s forgot the member at
/// 30, and 20 s kept them for 30 — ten seconds of somebody else's identity.
void test_scan_memory_remembers_a_scan_for_the_tenant_scan_memory() {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    const uint32_t memories[] = {20000UL, 120000UL, 30000UL};
    for (const uint32_t memory : memories) {
      bridgelogic::ScanMemory scan(30000UL, 20000UL);
      scan.setLimits(memory, 20000UL, base);
      scan.remember(base);
      TEST_ASSERT_TRUE(scan.remembered());
      TEST_ASSERT_FALSE_MESSAGE(scan.expired(base + memory - 1U),
                                "the scan lapsed before the club's scan memory");
      TEST_ASSERT_TRUE_MESSAGE(scan.expired(base + memory), "the scan outlived the club's scan memory");
      TEST_ASSERT_EQUAL_UINT32(memory - 1U, scan.ageMs(base + memory - 1U));
    }
  }
}

/// R19 D19-1. A quote re-armed the scan to "scan memory plus one choice window
/// from the SCAN". After a BUSY / PRESS AGAIN hold had carried the scan past
/// that, the quote SHORTENED it: PAY 50 MIN? counted down to 67.5 s while the
/// scan was forgotten at 50 s and `!AUTH,0` closed the Mega's window, so the
/// confirm press went nowhere. The scan and the Mega's window now outlive the
/// quote's whole countdown, every time.
void test_scan_memory_a_quote_after_a_busy_hold_keeps_the_scan_for_its_whole_countdown() {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    for (size_t s = 0U; s < kScanSettingsCount; ++s) {
      const uint32_t memory = kScanSettings[s].scanMemoryMs;
      const uint32_t choice = kScanSettings[s].choiceMs;
      bridgelogic::ScanMemory scan(memory, choice);
      bridgelogic::AuthPolicy auth(memory);
      scan.remember(base);
      static_cast<void>(
          auth.afterScan(outcomeOf(court::Action::Refuse, eventq::Event::kNoCourt, true), base));

      // A walk-up answered 429 a moment before the scan lapsed: PRESS AGAIN.
      const uint32_t busyAt = base + memory - 1500U;
      TEST_ASSERT_TRUE(scan.holdForPressAgain(busyAt));
      static_cast<void>(auth.afterUndecided(busyAt));

      // The member presses a booked court near the end of that countdown and
      // is quoted: PAY 50 MIN? for a whole choice window from now.
      const uint32_t quoteAt = busyAt + choice - 1000U;
      TEST_ASSERT_FALSE(scan.expired(quoteAt));
      if (scan.ageMs(quoteAt) + choice > scan.ceilingMs()) {
        // A 60 s countdown no longer fits inside the server's bound: the
        // question is not asked at all (SCAN AGAIN), never asked short.
        TEST_ASSERT_FALSE_MESSAGE(scan.holdForQuote(quoteAt),
                                  "a quote was asked that its scan cannot outlive");
        continue;
      }
      bridgelogic::PayForFlow payFor;
      payFor.arm(0U, 2, "50", choice, quoteAt);
      TEST_ASSERT_TRUE_MESSAGE(scan.holdForQuote(quoteAt), "a quote inside the server's bound was refused");
      static_cast<void>(auth.afterPayForQuote(quoteAt));

      const uint32_t lastPress = quoteAt + choice - 1U;
      TEST_ASSERT_TRUE(payFor.quoted(0U, lastPress));
      TEST_ASSERT_FALSE_MESSAGE(
          scan.expired(lastPress),
          "the quote is still counting down but the scan was forgotten: the confirm goes nowhere");
      TEST_ASSERT_TRUE_MESSAGE(auth.armed(lastPress), "the Mega's window closed under the quote's countdown");
      TEST_ASSERT_TRUE(scan.ageMs(lastPress) <= serverMaxScanAgeMs(memory, choice));
    }
  }
}

/// D19-1, the plain cases: a quote never shortens what the scan already had,
/// and one asked with a second of scan memory left gets its whole countdown.
void test_scan_memory_a_quote_never_shortens_the_scan() {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    bridgelogic::ScanMemory scan(120000UL, 20000UL);
    scan.remember(base);
    TEST_ASSERT_TRUE(scan.holdForQuote(base + 5000UL));
    TEST_ASSERT_FALSE_MESSAGE(scan.expired(base + 120000UL - 1U),
                              "115 s of scan memory was cut to the 20 s quote");
    TEST_ASSERT_TRUE(scan.expired(base + 120000UL));

    scan.remember(base);
    TEST_ASSERT_TRUE(scan.holdForQuote(base + 119000UL));
    TEST_ASSERT_FALSE(scan.expired(base + 139000UL - 1U));
    TEST_ASSERT_TRUE(scan.expired(base + 139000UL));
  }
}

/// The answer comes back after a blocking call of up to several seconds, and
/// the scan may have lapsed DURING it; the member pressed while it was alive,
/// so PRESS AGAIN still holds it — the age bound is what limits it, not the
/// deadline the call happened to cross. A forgotten scan holds nothing.
void test_scan_memory_a_scan_that_lapsed_during_the_call_is_still_held() {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    bridgelogic::ScanMemory scan(30000UL, 20000UL);
    scan.remember(base);
    const uint32_t answeredAt = base + 30000UL + 4000UL;
    TEST_ASSERT_TRUE(scan.expired(answeredAt));
    TEST_ASSERT_TRUE_MESSAGE(scan.holdForPressAgain(answeredAt),
                             "a BUSY answer to a live press read SCAN AGAIN");
    TEST_ASSERT_FALSE(scan.expired(answeredAt + 20000UL - 1U));

    scan.forget();
    TEST_ASSERT_FALSE(scan.remembered());
    TEST_ASSERT_FALSE(scan.holdForPressAgain(answeredAt));
    TEST_ASSERT_FALSE(scan.holdForQuote(answeredAt));
  }
}

/// R19 D19-2. Every BUSY / PRESS AGAIN held the scan a whole choice window
/// more, without limit; the fourth busy answer in a row sent `scan_age_ms`
/// 86 600 against the server's 80 000 and the member read CODE NOT KNOWN about
/// their own code. A hold now never carries the scan past the server's bound
/// less the margin, and when a whole countdown no longer fits, it answers
/// false — the glass says SCAN AGAIN instead of inviting a press.
void test_scan_memory_repeated_holds_never_pass_the_server_bound() {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    for (size_t s = 0U; s < kScanSettingsCount; ++s) {
      const uint32_t memory = kScanSettings[s].scanMemoryMs;
      const uint32_t choice = kScanSettings[s].choiceMs;
      const uint32_t server = serverMaxScanAgeMs(memory, choice);
      bridgelogic::ScanMemory scan(memory, choice);
      TEST_ASSERT_EQUAL_UINT32(server - bridgelogic::ScanMemory::kServerMarginMs, scan.ceilingMs());
      scan.remember(base);

      // Quote, then BUSY after BUSY, each press a second before the lapse.
      uint32_t now = base + memory - 1000U;
      bool held = scan.holdForQuote(now);
      int holds = 0;
      while (held && holds < 64) {
        ++holds;
        const uint32_t end = scan.ageMs(now) + scan.remainingMs(now);
        TEST_ASSERT_TRUE_MESSAGE(end <= scan.ceilingMs(), "a hold carried the scan past the server's bound");
        TEST_ASSERT_TRUE_MESSAGE(scan.remainingMs(now) >= choice,
                                 "a hold gave less than the countdown it shows");
        now += scan.remainingMs(now) - 1000U;
        TEST_ASSERT_FALSE(scan.expired(now));
        TEST_ASSERT_TRUE_MESSAGE(scan.ageMs(now) <= server, "the box sends a scan_age_ms the server refuses");
        held = scan.holdForPressAgain(now);
      }
      TEST_ASSERT_FALSE_MESSAGE(held, "the holds never stopped: the scan is remembered forever");
      // Refused because the whole countdown no longer fits, not before.
      TEST_ASSERT_TRUE(scan.ageMs(now) + choice > scan.ceilingMs());
    }
  }
}

/// D19-2, the other way to get there: the club SHORTENS its settings while a
/// scan is held. The next heartbeat brings the live deadline inside the new
/// bound, and a scan already older than it is spent on the next pass.
void test_scan_memory_shorter_settings_bring_a_held_scan_inside_the_new_bound() {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    bridgelogic::ScanMemory scan(300000UL, 60000UL);
    scan.remember(base);
    scan.setLimits(30000UL, 20000UL, base + 10000UL);
    TEST_ASSERT_FALSE_MESSAGE(scan.expired(base + 10000UL), "a young scan was dropped by a settings change");
    TEST_ASSERT_TRUE(scan.ageMs(base + 10000UL) + scan.remainingMs(base + 10000UL) <= scan.ceilingMs());
    // Lengthening never extends what is held: the scan was read under 300 s.
    scan.setLimits(300000UL, 60000UL, base + 20000UL);
    TEST_ASSERT_TRUE(scan.ageMs(base + 20000UL) + scan.remainingMs(base + 20000UL) <= 75000UL);

    scan.setLimits(300000UL, 60000UL, base);
    scan.remember(base);
    scan.setLimits(30000UL, 20000UL, base + 200000UL);
    TEST_ASSERT_TRUE_MESSAGE(scan.expired(base + 200000UL),
                             "a scan older than the new bound stayed remembered");
    TEST_ASSERT_FALSE(scan.holdForPressAgain(base + 200000UL));
  }
}

/// SCAN AGAIN: the screen a hold that answered false paints. Its words name
/// what the member does, never a press the box can no longer honour.
void test_scan_again_names_a_rescan_never_a_press() {
  bridgelogic::ScreenFacts facts;
  const bridgelogic::Screen screen = bridgelogic::screenFor(bridgelogic::ScreenId::ScanAgain, facts);
  TEST_ASSERT_EQUAL_STRING("SCAN AGAIN", screen.rows[0]);
  TEST_ASSERT_EQUAL_STRING("Waited too long", screen.rows[1]);
  TEST_ASSERT_EQUAL_STRING("SCAN WHEN READY", screen.rows[3]);
  for (const char* row : screen.rows) {
    TEST_ASSERT_NULL_MESSAGE(strstr(row, "PRESS AGAIN"), "SCAN AGAIN invites the press it just refused");
  }
  TEST_ASSERT_EQUAL_UINT16(bridgelogic::kRevertSeconds, screen.holdSeconds);
}

/// R19 (follow-up to D19-1/2). TOO LONG / TRY LESS TIME asks the member for
/// another press on the SAME scan, but nothing held the scan for it: a refusal
/// late in the scan's memory invited a press the bridge had forgotten by the
/// time it came. The walk-up answer now says which refusals invite a press, so
/// the caller holds the scan for it (or says SCAN AGAIN). Only that one does —
/// a refusal that asks for a scan, the app or the desk holds nothing.
void test_walk_up_only_too_long_invites_another_press() {
  const char tooLong[] = "{\"error\":\"minutes_out_of_range\",\"max_minutes\":20}";
  const bridgelogic::WalkUpResult r = bridgelogic::onWalkUpResponse(400U, tooLong, len(tooLong), 1U, 60U);
  TEST_ASSERT_TRUE(r.decided);
  TEST_ASSERT_FALSE(r.forgetsScan);
  TEST_ASSERT_TRUE_MESSAGE(r.invitesPress, "TRY LESS TIME invited a press nothing held the scan for");

  struct Case {
    uint16_t status;
    const char* body;
  };

  const Case others[] = {
      {200U, "{\"granted_minutes\":30}"},
      {402U, "{\"error\":\"insufficient_balance\"}"},
      {409U, "{\"error\":\"court_in_use\"}"},
      {409U, "{\"error\":\"no_time_available\"}"},
      {409U, "{\"error\":\"club_closed\",\"opens_at\":\"06:00\"}"},
      {409U, "{\"error\":\"code_used\"}"},
      {400U, "{\"error\":\"not_recognised\"}"},
      {503U, "{\"error\":\"minutes_out_of_range\"}"},
      {429U, "{}"},
      {0U, ""},
  };
  for (const Case& c : others) {
    const bridgelogic::WalkUpResult o =
        bridgelogic::onWalkUpResponse(c.status, c.body, strlen(c.body), 1U, 60U);
    TEST_ASSERT_FALSE_MESSAGE(o.invitesPress, c.body);
  }
}

/// The same for pay-for: PRICE CHANGED / Press court again is the one refusal
/// that asks for another press, and its countdown is the CHOICE window — the
/// window the scan is held for — not the revert window, which a club may set
/// longer than the scan can honestly be held.
void test_pay_for_only_price_changed_invites_another_press() {
  const char changed[] = "{\"paid\":false,\"reason\":\"price_changed\"}";
  const bridgelogic::PayForAnswer a = bridgelogic::onPayForConfirm(200U, changed, len(changed), "50");
  TEST_ASSERT_TRUE(a.kind == bridgelogic::PayForKind::Refused);
  TEST_ASSERT_TRUE(a.screen == bridgelogic::ScreenId::PayForPriceChanged);
  TEST_ASSERT_TRUE_MESSAGE(a.invitesPress, "Press court again invited a press nothing held the scan for");
  TEST_ASSERT_TRUE_MESSAGE(bridgelogic::holdClassOf(bridgelogic::ScreenId::PayForPriceChanged) ==
                               bridgelogic::HoldClass::Choice,
                           "PRICE CHANGED counts down a window the scan is not held for");

  const char* const others[] = {
      "{\"paid\":false,\"reason\":\"split_booking\"}", "{\"paid\":false,\"reason\":\"own_booking\"}",
      "{\"paid\":false,\"reason\":\"code_used\"}",     "{\"paid\":false,\"reason\":\"insufficient_balance\"}",
      "{\"paid\":false,\"reason\":\"ended\"}",         "{\"paid\":false,\"reason\":\"something_new\"}",
  };
  for (const char* body : others) {
    TEST_ASSERT_FALSE_MESSAGE(bridgelogic::onPayForConfirm(200U, body, strlen(body), "50").invitesPress,
                              body);
  }
  // A QUOTE refused for a changed price (no server sends one today) reads the
  // same, so the rule is one rule whichever press asked.
  const char quoted[] = "{\"payable\":false,\"reason\":\"price_changed\"}";
  TEST_ASSERT_TRUE(bridgelogic::onPayForQuote(200U, quoted, len(quoted), 2).invitesPress);
  const char split[] = "{\"payable\":false,\"reason\":\"split_booking\"}";
  TEST_ASSERT_FALSE(bridgelogic::onPayForQuote(200U, split, len(split), 2).invitesPress);
}

/// R19. A screen with court cells asks for a court press, and a court press
/// buys nothing once the scan behind it lapses. With `lcd_revert_seconds`
/// (60) longer than `scan_memory_seconds` (20), NO BOOKING / SLOT ENDED / COURT
/// IN USE / NO TIME / PURCHASE ENDED counted the court cells down for 60 s on a
/// scan that had 12 s left. The invitation now ends no later than the scan.
void test_a_court_press_invitation_never_outlives_the_scan() {
  court::ButtonMap map;
  bridgelogic::ScreenFacts facts;
  facts.buttons = &map;
  devlink::LcdSettings settings;
  settings.revertMs = 60000UL;
  settings.choiceMs = 20000UL;
  settings.scanMemoryMs = 20000UL;

  const bridgelogic::ScreenId inviting[] = {
      bridgelogic::ScreenId::NoBooking,     bridgelogic::ScreenId::SlotEnded,
      bridgelogic::ScreenId::CourtInUse,    bridgelogic::ScreenId::NoTimeAvailable,
      bridgelogic::ScreenId::PurchaseEnded, bridgelogic::ScreenId::PayForPriceChanged,
      bridgelogic::ScreenId::PayForQuote,   bridgelogic::ScreenId::Busy,
      bridgelogic::ScreenId::CardNoBooking,
  };
  for (const bridgelogic::ScreenId id : inviting) {
    TEST_ASSERT_TRUE(bridgelogic::invitesCourtPress(id));
    const bridgelogic::Screen full = bridgelogic::screenFor(id, facts, settings);
    // 12.9 s of scan left: the countdown is at most twelve whole seconds.
    const bridgelogic::Screen capped = bridgelogic::screenFor(id, facts, settings, 12900UL);
    char label[48] = {};
    snprintf(label, sizeof(label), "screen %u: %s", static_cast<unsigned>(id), full.rows[0]);
    TEST_ASSERT_TRUE_MESSAGE(capped.holdSeconds <= 12U, label);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(full.rows[0], capped.rows[0], label);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(full.rows[3], capped.rows[3], label);
    // Plenty left: nothing changes.
    const bridgelogic::Screen roomy = bridgelogic::screenFor(id, facts, settings, 300000UL);
    TEST_ASSERT_EQUAL_UINT16_MESSAGE(full.holdSeconds, roomy.holdSeconds, label);
    // Under a second left, or no scan at all: the verdict reads, the court
    // cells give way to the one instruction that works.
    const bridgelogic::Screen spent = bridgelogic::screenFor(id, facts, settings, 400UL);
    TEST_ASSERT_EQUAL_UINT16_MESSAGE(proto::kShowHoldMinSeconds, spent.holdSeconds, label);
    TEST_ASSERT_EQUAL_STRING_MESSAGE("SCAN WHEN READY", spent.rows[3], label);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(full.rows[0], spent.rows[0], label);
  }

  // A screen that invites no court press keeps its whole hold.
  const bridgelogic::ScreenId reading[] = {bridgelogic::ScreenId::CodeUsed, bridgelogic::ScreenId::SeeTheDesk,
                                           bridgelogic::ScreenId::ScanAgain,
                                           bridgelogic::ScreenId::ChooseTime};
  for (const bridgelogic::ScreenId id : reading) {
    TEST_ASSERT_FALSE(bridgelogic::invitesCourtPress(id));
    TEST_ASSERT_EQUAL_UINT16(bridgelogic::screenFor(id, facts, settings).holdSeconds,
                             bridgelogic::screenFor(id, facts, settings, 400UL).holdSeconds);
  }
}

/// R19. The Mega commits every STAGED row on `!SHOW`, and a row nobody
/// restaged keeps the last screen's words (test_courtlogic pins that). The
/// bridge skipped empty rows, so ONE MOMENT / Buying your time stood over
/// CHOOSE TIME's "Press a black button". Every row goes out, empty ones too.
void test_a_screen_stages_every_row_including_the_empty_ones() {
  bridgelogic::ScreenFacts facts;
  const bridgelogic::ScreenId withBlanks[] = {
      bridgelogic::ScreenId::OneMoment, bridgelogic::ScreenId::PayForWorking,
      bridgelogic::ScreenId::CheckingCode, bridgelogic::ScreenId::PayForNothingToPay};
  for (const bridgelogic::ScreenId id : withBlanks) {
    const bridgelogic::Screen screen = bridgelogic::screenFor(id, facts);
    TEST_ASSERT_EQUAL_size_t(proto::kMaxRows + 1U, bridgelogic::kScreenFrameCount);
    for (uint8_t row = 0U; row < proto::kMaxRows; ++row) {
      const proto::Frame frame = bridgelogic::screenFrame(screen, row);
      TEST_ASSERT_TRUE_MESSAGE(frame.verb() == proto::Verb::Row, screen.rows[0]);
      TEST_ASSERT_EQUAL_UINT32(row, static_cast<uint32_t>(atoi(frame.arg(0))));
      TEST_ASSERT_EQUAL_STRING(screen.rows[row], frame.arg(1));
    }
    TEST_ASSERT_TRUE(bridgelogic::screenFrame(screen, proto::kMaxRows).verb() == proto::Verb::Show);
  }
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

  const devlink::SyncResult r = devlink::applyRoster(body, len(body), cache, kBaseMid);
  TEST_ASSERT_TRUE(r.replaced);
  TEST_ASSERT_EQUAL_UINT8(1U, r.accepted);
  TEST_ASSERT_EQUAL_UINT8(0U, r.rejected);
  TEST_ASSERT_TRUE(cache.decide("TOKALICE", 1U, kBaseMid + 1000U).verdict == roster::Verdict::Allow);

  int16_t courts[devlink::kMaxCourts] = {-1, -1, -1, -1};
  uint8_t count = 0U;
  TEST_ASSERT_TRUE(devlink::parseCourtNumbers(body, len(body), courts, count));
  TEST_ASSERT_EQUAL_UINT8(4U, count);
  TEST_ASSERT_EQUAL_INT16(7, courts[0]);
  TEST_ASSERT_EQUAL_INT16(10, courts[3]);

  uint32_t ms = 30000UL;
  TEST_ASSERT_TRUE(devlink::parseHeartbeatInterval(body, len(body), ms));
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

// ---------------------------------------------------------------------------
// OnRetry — D1-3: the replay that lit the wrong court
// ---------------------------------------------------------------------------
//
// THE LIVE DEFECT CARL AND DEAN HIT. `!ERR,BADCRC` says only "the last line I
// received did not decode" — it does not say WHICH line. The bridge sends
// several frames in quick succession, and `OnRetry::sent` returned EARLY for
// any non-relay verb WITHOUT clearing, contradicting its own header ("Anything
// else clears the memory rather than replacing it"). So a CRC failure on the
// `!AUTH,<n>` that follows every grant by under a millisecond replayed the
// `!ON` before it; and when the corrupted frame was the `!OFF,B` a release
// press sends, the replay lit A for a fresh FULL duration while B was never
// released. That is "it added time to the wrong court".

void test_on_retry_a_non_relay_frame_clears_the_memory_rather_than_skipping_it() {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    bridgelogic::OnRetry retry;
    proto::Frame out;

    // settleScan's order, to the millisecond: applyOutcome writes `!LCD` then
    // `!ON`, and applyAuth writes `!AUTH,30` under a millisecond later.
    retry.sent(proto::Frame::lcd("COURT A", "45 MIN"), base);
    retry.sent(proto::Frame::on(proto::Court::A, 2700U), base);
    retry.sent(proto::Frame::auth(30U), base + 1U);

    // The `!AUTH` is the line that died on the wire. It is not relay-affecting,
    // so there is nothing to replay — and nothing to attribute to court A.
    TEST_ASSERT_TRUE(bridgelogic::isReceiveError(proto::Verb::Err, "BADCRC", ""));
    TEST_ASSERT_FALSE(retry.pending());
    TEST_ASSERT_FALSE(retry.shouldResend(base + 2U, out));
    TEST_ASSERT_EQUAL_UINT8(bridgelogic::kNoRetryCourt, retry.court());
    TEST_ASSERT_TRUE(retry.verb() == proto::Verb::Unknown);
    TEST_ASSERT_EQUAL_UINT16(0U, retry.retries());
  }
}

void test_on_retry_an_off_for_b_after_an_on_for_a_replays_neither() {
  // handleButton's release path writes `!OFF,B`. `!OFF` is not one of the two
  // frames this type replays — re-sending an OFF is harmless but pointless, and
  // the Mega's own timer is the authority — so it CLEARS. Before the fix it
  // skipped, and the BADCRC that followed lit court A all over again.
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    bridgelogic::OnRetry retry;
    proto::Frame out;

    retry.sent(proto::Frame::on(proto::Court::A, 2700U), base);
    retry.sent(proto::Frame::off(proto::Court::B), base + 1U);

    TEST_ASSERT_FALSE(retry.shouldResend(base + 2U, out));
    TEST_ASSERT_EQUAL_UINT8(bridgelogic::kNoRetryCourt, retry.court());
    // Nothing was re-sent, so nothing can have named a court at all.
    TEST_ASSERT_TRUE(out.empty());
  }
}

void test_on_retry_a_badcrc_after_a_non_relay_frame_never_moves_a_relay_deadline() {
  // The MEASURED effect, pinned rather than argued: a replayed `!ON` re-arms
  // the Mega's relay from the moment of the replay, which is what "it added
  // time to the wrong court" looks like from the glass. The bridge's own model
  // of that deadline is Relight's, so the property is that it never jumps
  // forward across a BADCRC that followed a non-relay frame.
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    bridgelogic::OnRetry retry;
    bridgelogic::Relight relight;
    proto::Frame out;

    // Court A, two-hour booking, ninety minutes on the relay.
    court::Outcome grant = outcomeOf(court::Action::TurnOn, 0U, true);
    grant.durationMs = 5400000UL;
    grant.bookingRemainingMs = 7200000UL;
    relight.onGrant(grant, base);
    retry.sent(proto::Frame::on(proto::Court::A, 5400U), base);

    // When the extension falls due, before anything else happens.
    const uint32_t dueAt = base + 5400000UL - 60000UL;
    TEST_ASSERT_FALSE(relight.check(0U, dueAt - 1U).due);
    TEST_ASSERT_TRUE(relight.check(0U, dueAt).due);

    // The grant's `!AUTH` dies on the wire. Nothing is replayed, so nothing
    // re-arms the relay — the deadline is exactly where it was.
    retry.sent(proto::Frame::auth(30U), base + 1U);
    TEST_ASSERT_FALSE(retry.shouldResend(base + 2U, out));
    TEST_ASSERT_FALSE(relight.check(0U, dueAt - 1U).due);
    TEST_ASSERT_TRUE(relight.check(0U, dueAt).due);
  }
}

// ---------------------------------------------------------------------------
// OnRetry — D1-6: the `!EXT` retry that was never wired up
// ---------------------------------------------------------------------------
//
// `pumpRelight` sent `!EXT` and stamped `Relight::extended`, but nothing
// registered the frame with OnRetry and nothing else did either. Three things
// followed, all of them verified: the header's "WHY `!EXT` IS KEPT AS WELL AS
// `!ON`" described behaviour the composition root did not have;
// `handleReceiveError`'s first branch required `verb() == Ext` and was
// therefore UNREACHABLE, because verb() could only ever be `On` or `Unknown`;
// and so `!ERR,BADARG` — the Mega refusing to extend a relay that is already
// open — fell to the second branch, where "BADARG" is compared against
// "BADCRC" and nothing at all happens. gRelight went on believing it held a
// court the Mega had released.

void test_a_refused_ext_releases_the_court_instead_of_reading_as_a_lost_frame() {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    bridgelogic::Relight relight;
    bridgelogic::OnRetry retry;

    // Court B, two-hour booking: ninety minutes on the relay, thirty to come.
    court::Outcome grant = outcomeOf(court::Action::TurnOn, 1U, true);
    grant.durationMs = 5400000UL;
    grant.bookingRemainingMs = 7200000UL;
    relight.onGrant(grant, base);

    const uint32_t due = base + 5400000UL - 60000UL;
    const bridgelogic::Extension ext = relight.check(1U, due);
    TEST_ASSERT_TRUE(ext.due);

    // The frame is written. sendToMega registers EVERY frame it writes, so the
    // `!EXT` is what the retry memory now holds — which is the whole of what
    // made the branch below reachable.
    retry.sent(proto::Frame::ext(proto::Court::B, ext.seconds), due);
    relight.extended(1U, ext.seconds, due);
    TEST_ASSERT_TRUE(retry.verb() == proto::Verb::Ext);
    TEST_ASSERT_EQUAL_UINT8(1U, retry.court());

    // The Mega answers `!ERR,BADARG`: the relay is already open, the court is
    // dark, there is nothing to extend. Not a lost frame — a verdict.
    const bridgelogic::ReceiveErrorAction action =
        bridgelogic::classifyReceiveError(proto::Verb::Err, "BADARG", "", retry.verb());
    TEST_ASSERT_TRUE(action == bridgelogic::ReceiveErrorAction::ExtRefused);

    const uint8_t court = retry.court();
    retry.clear();
    relight.onRelease(court);

    TEST_ASSERT_FALSE(relight.tracking(1U));
    TEST_ASSERT_FALSE(relight.check(1U, due + 1U).due);
    TEST_ASSERT_FALSE(relight.check(1U, due + 60000UL).due);
  }
}

void test_a_refused_ext_on_a_dark_court_is_sent_exactly_once() {
  // THE FLOOD. `Relight::check` goes on saying "due" for as long as the bridge
  // believes the court is held and the Mega keeps reporting nothing left on the
  // relay — `relayLeft` is 0, so neither `relayLeft > kExtLeadMs` nor
  // `bookingLeft <= relayLeft` holds. Without the refusal branch that is an
  // `!EXT` every time a `!STATE` re-zeroes the reading, on a 9600 link, in
  // exactly the window a scan or an `!EVT,AUTOOFF` has to share it. The refusal
  // is what ends it in one frame instead of waiting for handleState's reconcile.
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    bridgelogic::Relight relight;
    bridgelogic::OnRetry retry;

    court::Outcome grant = outcomeOf(court::Action::TurnOn, 2U, true);
    grant.durationMs = 5400000UL;
    grant.bookingRemainingMs = 7200000UL;
    relight.onGrant(grant, base);

    const uint32_t start = base + 5400000UL - 60000UL;
    uint16_t sends = 0U;
    bool refusalDelivered = false;

    // Two seconds of loop passes at 10 ms, with the Mega's own `!STATE` — every
    // change and every ten seconds — reporting a dark relay twice a second.
    for (uint32_t dt = 0U; dt <= 2000U; dt += 10U) {
      const uint32_t now = start + dt;
      if (dt % 500U == 0U) {
        relight.observeRelayRemaining(2U, 0U, now);
      }
      const bridgelogic::Extension ext = relight.check(2U, now);
      if (!ext.due) {
        continue;
      }
      ++sends;
      retry.sent(proto::Frame::ext(proto::Court::C, ext.seconds), now);
      relight.extended(2U, ext.seconds, now);
      if (refusalDelivered) {
        continue;
      }
      refusalDelivered = true;
      if (bridgelogic::classifyReceiveError(proto::Verb::Err, "BADARG", "", retry.verb()) ==
          bridgelogic::ReceiveErrorAction::ExtRefused) {
        const uint8_t court = retry.court();
        retry.clear();
        relight.onRelease(court);
      }
    }

    TEST_ASSERT_EQUAL_UINT16(1U, sends);
  }
}

void test_a_badarg_with_no_ext_remembered_is_not_a_release() {
  // The branch is about an `!EXT` and nothing else. A BADARG answering an `!ON`
  // — or answering nothing this half remembers — must not release a court that
  // was only just lit.
  TEST_ASSERT_TRUE(bridgelogic::classifyReceiveError(proto::Verb::Err, "BADARG", "", proto::Verb::On) ==
                   bridgelogic::ReceiveErrorAction::None);
  TEST_ASSERT_TRUE(bridgelogic::classifyReceiveError(proto::Verb::Err, "BADARG", "", proto::Verb::Unknown) ==
                   bridgelogic::ReceiveErrorAction::None);
  // And a genuine "did not decode" is still a resend, whatever is remembered.
  TEST_ASSERT_TRUE(bridgelogic::classifyReceiveError(proto::Verb::Err, "BADCRC", "", proto::Verb::Ext) ==
                   bridgelogic::ReceiveErrorAction::Resend);
  TEST_ASSERT_TRUE(bridgelogic::classifyReceiveError(proto::Verb::Evt, "BADFRAME", "RX", proto::Verb::On) ==
                   bridgelogic::ReceiveErrorAction::Resend);
  TEST_ASSERT_TRUE(bridgelogic::classifyReceiveError(proto::Verb::Evt, "OVERRUN", "TX", proto::Verb::On) ==
                   bridgelogic::ReceiveErrorAction::None);
  TEST_ASSERT_TRUE(bridgelogic::classifyReceiveError(proto::Verb::Evt, "AUTOOFF", "B", proto::Verb::Ext) ==
                   bridgelogic::ReceiveErrorAction::None);
}

// ---------------------------------------------------------------------------
// B7 — the JSON-read audit the court box had never had
// ---------------------------------------------------------------------------
//
// Round G4's B2 found `onGateResponse` reading `opened` — the one field that
// drives a lock — with the FLAT any-depth scanner, so `{"outer":{"opened":true}}`
// released the lock, and so did `{"opened":false,"detail":{"opened":true}}`:
// `findKey` returns the FIRST match in document order, and a decoy placed
// before the real field wins outright.
//
// The court box's activate and walk-up readers had the same shape and had never
// been audited. Every field below is ACTED ON — it lights a relay, decides how
// long for, decides which relay, or decides whether an unknown barcode gets
// thirty seconds of button control — so every one is scoped to the outermost
// object. What is deliberately NOT narrowed is stated at the end.
//
// The bodies are the server's, so this is not a hypothetical: `reason` is a
// free-form string the API chooses, a roster token is a member's own barcode,
// and a nested object is one field away at any time.

void test_activate_reads_every_field_it_acts_on_from_the_top_level() {
  const bridgelogic::ScanFlow flow;

  // `activated` — the field that lights a court. A decoy BEFORE the real one
  // is the case findKey loses outright.
  const char decoyFirst[] = "{\"detail\":{\"activated\":true},\"activated\":false,\"reason\":\"no_booking\"}";
  bridgelogic::ActivationResult r =
      flow.onActivateResponse(200U, decoyFirst, len(decoyFirst), kCourts, kCourtCount);
  TEST_ASSERT_FALSE(r.fallbackToRoster);
  TEST_ASSERT_TRUE(r.outcome.action == court::Action::Refuse);

  const char decoyAfter[] = "{\"activated\":false,\"reason\":\"no_booking\",\"detail\":{\"activated\":true}}";
  r = flow.onActivateResponse(200U, decoyAfter, len(decoyAfter), kCourts, kCourtCount);
  TEST_ASSERT_TRUE(r.outcome.action == court::Action::Refuse);

  // An ARRAY is not an object with members, so nothing in it is a top-level
  // field. `[{"activated":true}]` used to light a court.
  const char array[] = "[{\"activated\":true,\"granted_seconds\":2700,\"court_number\":7}]";
  r = flow.onActivateResponse(200U, array, len(array), kCourts, kCourtCount);
  TEST_ASSERT_TRUE(r.fallbackToRoster);

  // `granted_seconds` — HOW LONG the court is lit, and the money the club is
  // paid for. A nested 5400 in front of a real 0 is ninety minutes given away.
  const char seconds[] = "{\"activated\":true,\"court_number\":7,"
                         "\"detail\":{\"granted_seconds\":5400},\"granted_seconds\":0}";
  r = flow.onActivateResponse(200U, seconds, len(seconds), kCourts, kCourtCount);
  TEST_ASSERT_TRUE(r.outcome.action == court::Action::Refuse);
  TEST_ASSERT_EQUAL_UINT32(0U, r.outcome.durationMs);
  TEST_ASSERT_FALSE(r.fallbackToRoster);

  // `court_number` — WHICH relay. A nested 7 in front of a real 99 lights court
  // A for a booking on a court this box does not drive.
  const char number[] = "{\"activated\":true,\"granted_seconds\":600,"
                        "\"detail\":{\"court_number\":7},\"court_number\":99}";
  r = flow.onActivateResponse(200U, number, len(number), kCourts, kCourtCount);
  TEST_ASSERT_TRUE(r.outcome.action == court::Action::Refuse);
  TEST_ASSERT_FALSE(r.fallbackToRoster);

  // `reason` — which decides `recognised`, which is the only thing that arms
  // the Mega's button window. A nested "insufficient_balance" in front of a
  // real "not_recognised" is thirty seconds of relay control for a barcode the
  // API said it did not know.
  const char reason[] = "{\"activated\":false,\"detail\":{\"reason\":\"insufficient_balance\"},"
                        "\"reason\":\"not_recognised\"}";
  r = flow.onActivateResponse(200U, reason, len(reason), kCourts, kCourtCount);
  TEST_ASSERT_FALSE(r.outcome.recognised);

  // A truncated body yields no top-level field at all, which is a fallback
  // rather than a guess.
  const char cut[] = "{\"activated\":true,\"granted_seconds\":27";
  TEST_ASSERT_TRUE(flow.onActivateResponse(200U, cut, len(cut), kCourts, kCourtCount).fallbackToRoster);

  // A field of the wrong JSON type is absent, not coerced.
  const char quoted[] = "{\"activated\":\"true\"}";
  TEST_ASSERT_TRUE(flow.onActivateResponse(200U, quoted, len(quoted), kCourts, kCourtCount).fallbackToRoster);
}

void test_walkup_reads_every_field_it_acts_on_from_the_top_level() {
  // `granted_minutes` — how long the member is lit for, on the one path that
  // charges money at the moment of the request.
  const char minutes[] = "{\"granted_minutes\":15,\"detail\":{\"granted_minutes\":90}}";
  bridgelogic::WalkUpResult r = bridgelogic::onWalkUpResponse(200U, minutes, len(minutes), 1U, 30U);
  TEST_ASSERT_TRUE(r.outcome.action == court::Action::TurnOn);
  TEST_ASSERT_EQUAL_UINT32(15UL * 60000UL, r.outcome.durationMs);

  const char minutesFirst[] = "{\"detail\":{\"granted_minutes\":90},\"granted_minutes\":15}";
  r = bridgelogic::onWalkUpResponse(200U, minutesFirst, len(minutesFirst), 1U, 30U);
  TEST_ASSERT_EQUAL_UINT32(15UL * 60000UL, r.outcome.durationMs);

  // `error` — which decides `recognised`, which arms the button window. A
  // nested verdict about a known member in front of a real `not_recognised`
  // hands the panel to a stranger's barcode.
  const char error[] = "{\"detail\":{\"error\":\"insufficient_balance\"},\"error\":\"not_recognised\"}";
  r = bridgelogic::onWalkUpResponse(402U, error, len(error), 1U, 30U);
  TEST_ASSERT_FALSE(r.outcome.recognised);

  // `opens_at` — what the member is told to come back for.
  const char opens[] =
      "{\"error\":\"club_closed\",\"detail\":{\"opens_at\":\"23:59\"},\"opens_at\":\"06:00\"}";
  r = bridgelogic::onWalkUpResponse(400U, opens, len(opens), 1U, 30U);
  TEST_ASSERT_NOT_NULL(strstr(r.outcome.line2, "06:00"));
  TEST_ASSERT_NULL(strstr(r.outcome.line2, "23:59"));
}

void test_the_flat_scan_is_kept_where_it_is_genuinely_wanted() {
  // NOT narrowed, and this is a decision rather than an omission. The court box
  // reads `button_map`, `slice_minutes` and `walk_up_max_minutes` out of the
  // heartbeat's NESTED `config` object with no path expression at all, and
  // `devapi::json::findKey`'s own header says that is depended upon. Narrowing
  // findKey itself is a breaking change for every reader of that object.
  //
  // The distinction that decides it: nothing in `config` is a verdict about a
  // member or a court. A decoy there costs a wrong panel label until the next
  // heartbeat; a decoy in `activated` costs a lit court.
  const char body[] = "{\"config\":{\"slice_minutes\":15,\"button_map\":[\"court:A\",\"minutes:30\"]}}";
  TEST_ASSERT_NOT_EQUAL(devapi::json::kNotFound, devapi::json::findArray(body, len(body), "button_map"));
  TEST_ASSERT_EQUAL(devapi::json::kNotFound, devapi::json::findTopLevelArray(body, len(body), "button_map"));

  // `accepted_through` IS narrowed, at its call site in the composition root's
  // drainEvents: it decides which queued attendance events are dropped, and
  // under charge-at-booking a dropped activation is a member refunded and
  // penalised for a game they played. Pinned here because main.cpp is filtered
  // out of this build.
  const char ack[] = "{\"detail\":{\"accepted_through\":9999},\"accepted_through\":4}";
  uint32_t through = 0U;
  TEST_ASSERT_TRUE(devapi::json::topLevelUnsignedField(ack, len(ack), "accepted_through", through));
  TEST_ASSERT_EQUAL_UINT32(4U, through);
}

// ---------------------------------------------------------------------------
// B8 — a real per-boot id on this box's events
// ---------------------------------------------------------------------------

void test_this_boot_has_an_identity_and_it_is_never_the_wires_absent_value() {
  // Zero is the wire's "this board has no boot identity": renderEventBody omits
  // the field and the server falls back to (device, seq), which is the defect
  // round G4's C2 describes. A one-in-four-billion draw must not put one boot of
  // one board back on it.
  TEST_ASSERT_EQUAL_UINT32(bridgelogic::kBootIdForZeroDraw, bridgelogic::bootIdFrom(0U));
  TEST_ASSERT_NOT_EQUAL(0U, bridgelogic::bootIdFrom(0U));

  // Everything else is carried through unchanged: the value is a de-duplication
  // tag, and folding draws together would make collisions MORE likely.
  TEST_ASSERT_EQUAL_UINT32(1U, bridgelogic::bootIdFrom(1U));
  TEST_ASSERT_EQUAL_UINT32(0xFFFFFFFFUL, bridgelogic::bootIdFrom(0xFFFFFFFFUL));
  TEST_ASSERT_EQUAL_UINT32(0x5A5A5A5AUL, bridgelogic::bootIdFrom(0x5A5A5A5AUL));

  // And it reaches the wire. The same event, the same seq, two boots: the
  // bodies must differ, or a renumbered board's whole evening is receipted as
  // duplicates of the previous one's.
  eventq::Event event;
  event.kind = eventq::Kind::Activation;
  event.court = 1U;
  event.method = eventq::Method::Qr;
  event.durationMs = 2700000UL;
  event.uptimeMs = 1000U;
  event.seq = 7U;
  static_cast<void>(event.setSubject("TOKALICE"));

  char first[devlink::kEventBodyCap] = {};
  char second[devlink::kEventBodyCap] = {};
  TEST_ASSERT_TRUE(devlink::renderEventBody(first, sizeof(first), "aabbccddeeff",
                                            bridgelogic::bootIdFrom(0x11223344UL), 2000U, event) > 0U);
  TEST_ASSERT_TRUE(devlink::renderEventBody(second, sizeof(second), "aabbccddeeff",
                                            bridgelogic::bootIdFrom(0x55667788UL), 2000U, event) > 0U);
  TEST_ASSERT_NOT_NULL(strstr(first, "boot_id"));
  TEST_ASSERT_TRUE(strcmp(first, second) != 0);

  // Zero is what the box used to send, and it omits the field entirely — which
  // is the compatibility hinge, and is why passing 0 fixed nothing.
  char legacy[devlink::kEventBodyCap] = {};
  TEST_ASSERT_TRUE(devlink::renderEventBody(legacy, sizeof(legacy), "aabbccddeeff", 0U, 2000U, event) > 0U);
  TEST_ASSERT_NULL(strstr(legacy, "boot_id"));
}

// ---------------------------------------------------------------------------
// B6 — the wall clock the box borrows, and the blank when it cannot
// ---------------------------------------------------------------------------

void test_server_time_is_read_as_club_local_wall_time_or_refused() {
  uint32_t second = 0U;
  TEST_ASSERT_TRUE(bridgelogic::secondOfDayFrom("2026-09-21T18:45:07+02:00", second));
  TEST_ASSERT_EQUAL_UINT32(18UL * 3600UL + 45UL * 60UL + 7UL, second);
  // A `Z`, a fractional part, a space separator: the same nineteen characters.
  TEST_ASSERT_TRUE(bridgelogic::secondOfDayFrom("2026-09-21T06:00:00Z", second));
  TEST_ASSERT_EQUAL_UINT32(6UL * 3600UL, second);
  TEST_ASSERT_TRUE(bridgelogic::secondOfDayFrom("2026-09-21T23:59:59.9999999+02:00", second));
  TEST_ASSERT_EQUAL_UINT32(kSecondsPerDayLocal - 1UL, second);
  TEST_ASSERT_TRUE(bridgelogic::secondOfDayFrom("2026-01-01 00:00:00", second));
  TEST_ASSERT_EQUAL_UINT32(0U, second);

  // Refused, every one, with the caller's value untouched: printing whatever
  // two bytes sat at offset 11 is exactly the failure this shape check exists
  // to stop.
  second = 12345U;
  TEST_ASSERT_FALSE(bridgelogic::secondOfDayFrom(nullptr, second));
  TEST_ASSERT_FALSE(bridgelogic::secondOfDayFrom("", second));
  TEST_ASSERT_FALSE(bridgelogic::secondOfDayFrom("2026-09-21T18:45", second));    // truncated
  TEST_ASSERT_FALSE(bridgelogic::secondOfDayFrom("2026/09/21T18:45:07", second)); // wrong separators
  TEST_ASSERT_FALSE(bridgelogic::secondOfDayFrom("2026-09-21X18:45:07", second)); // wrong date/time mark
  TEST_ASSERT_FALSE(bridgelogic::secondOfDayFrom("2026-09-21Tab:45:07", second)); // not a digit
  TEST_ASSERT_FALSE(bridgelogic::secondOfDayFrom("20x6-09-21T18:45:07", second)); // nor in the date
  TEST_ASSERT_FALSE(bridgelogic::secondOfDayFrom("2026-09-21T24:00:00", second)); // out of range
  TEST_ASSERT_FALSE(bridgelogic::secondOfDayFrom("2026-09-21T18:60:07", second));
  TEST_ASSERT_FALSE(bridgelogic::secondOfDayFrom("2026-09-21T18:45:60", second)); // leap second
  TEST_ASSERT_FALSE(bridgelogic::secondOfDayFrom("2026-09-21T-8:45:07", second));
  TEST_ASSERT_EQUAL_UINT32(12345U, second);
}

void test_the_clock_advances_between_heartbeats_and_wraps_at_midnight() {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    bridgelogic::WallClock clock;

    // Nothing adopted: the box does not know the time and says so, rather than
    // reporting midnight.
    TEST_ASSERT_FALSE(clock.trusted(base));
    char wire[bridgelogic::kWireTimeLen] = {};
    clock.wireTime(base, wire, sizeof(wire));
    TEST_ASSERT_EQUAL_STRING(proto::kNoClock, wire);
    char shown[bridgelogic::kDisplayTimeLen] = {};
    clock.displayTime(base, shown, sizeof(shown));
    TEST_ASSERT_EQUAL_STRING("", shown);

    TEST_ASSERT_TRUE(clock.adopt("2026-09-21T23:58:30+02:00", base));
    TEST_ASSERT_TRUE(clock.trusted(base));
    clock.displayTime(base, shown, sizeof(shown));
    TEST_ASSERT_EQUAL_STRING("23:58", shown);
    clock.wireTime(base, wire, sizeof(wire));
    TEST_ASSERT_EQUAL_STRING("2358", wire);

    // Advanced on millis(), across the wrap of BOTH clocks: the club's midnight
    // and the 49.7-day millis() rollover the bases put inside this scenario.
    clock.displayTime(base + 60000UL, shown, sizeof(shown));
    TEST_ASSERT_EQUAL_STRING("23:59", shown);
    clock.displayTime(base + 120000UL, shown, sizeof(shown));
    TEST_ASSERT_EQUAL_STRING("00:00", shown);
    clock.wireTime(base + 120000UL, wire, sizeof(wire));
    TEST_ASSERT_EQUAL_STRING("0000", wire);
    clock.displayTime(base + 3600000UL, shown, sizeof(shown));
    TEST_ASSERT_EQUAL_STRING("00:58", shown);

    // A time that is not NOW: what "Ends 18:45" is built from.
    TEST_ASSERT_TRUE(clock.adopt("2026-09-21T18:00:00+02:00", base));
    clock.displayTimeAt(base, clock.secondOfDayIn(base, 2700U), shown, sizeof(shown));
    TEST_ASSERT_EQUAL_STRING("18:45", shown);
    // ...and past midnight, which a late booking really does reach.
    clock.displayTimeAt(base, clock.secondOfDayIn(base, 8UL * 3600UL), shown, sizeof(shown));
    TEST_ASSERT_EQUAL_STRING("02:00", shown);
  }
}

/// THE WALL CLOCK, UNCONFIRMED FOR 49.7 DAYS (R18 D18-2). Its age is a 32-bit
/// difference, so a clock adopted 2^32 ms + 1 s ago read one second old: the
/// box sent the Mega a time about 17 hours wrong and every screen planned
/// around it. Observed every pass (hourly here), a clock past the longest trust
/// window there is stays blank until the next adoption — whatever the tenant's
/// window, so lengthening it cannot revive a clock from seven weeks ago.
void test_a_clock_adopted_before_the_millis_wrap_never_reads_trusted_again() {
  const uint64_t ages[] = {0x100000000ULL + 1000ULL, 0x100000000ULL + 86400000ULL};
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    for (const uint64_t age : ages) {
      bridgelogic::WallClock clock;
      clock.setTrustMinutes(60U);
      TEST_ASSERT_TRUE(clock.adopt("2026-10-06T18:00:00", base));
      for (uint64_t t = 0U; t < age; t += 3600000ULL) {
        const uint32_t now = static_cast<uint32_t>(base + t);
        clock.observe(now);
        TEST_ASSERT_EQUAL(t <= 3600000ULL, clock.trusted(now));
      }
      const uint32_t back = static_cast<uint32_t>(base + age);
      clock.observe(back);
      TEST_ASSERT_FALSE_MESSAGE(clock.trusted(back), "a clock adopted 49.7 days ago read trusted again");
      char wire[bridgelogic::kWireTimeLen] = {};
      char shown[bridgelogic::kDisplayTimeLen] = {};
      clock.wireTime(back, wire, sizeof(wire));
      clock.displayTime(back, shown, sizeof(shown));
      TEST_ASSERT_EQUAL_STRING(proto::kNoClock, wire);
      TEST_ASSERT_EQUAL_STRING("", shown);
      clock.setTrustMinutes(bridgelogic::kMaxClockTrustMinutes);
      TEST_ASSERT_FALSE(clock.trusted(back));

      // An adoption is the one thing that clears it.
      TEST_ASSERT_TRUE(clock.adopt("2026-11-25T11:03:00", back));
      TEST_ASSERT_TRUE(clock.trusted(back));
      clock.wireTime(back, wire, sizeof(wire));
      TEST_ASSERT_EQUAL_STRING("1103", wire);
    }
  }
}

/// Lengthening the window still works on a clock that is merely past the OLD
/// one: only an age past the longest window there is latches.
void test_a_lengthened_trust_window_still_restores_a_recently_adopted_clock() {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    bridgelogic::WallClock clock;
    clock.setTrustMinutes(60U);
    TEST_ASSERT_TRUE(clock.adopt("2026-10-06T18:00:00", base));
    for (uint32_t t = 0U; t <= 2U * 3600000UL; t += 60000UL) {
      clock.observe(base + t);
    }
    TEST_ASSERT_FALSE(clock.trusted(base + 2U * 3600000UL));
    clock.setTrustMinutes(180U);
    TEST_ASSERT_TRUE(clock.trusted(base + 2U * 3600000UL));
  }
}

void test_a_clock_nobody_has_confirmed_for_too_long_blanks_rather_than_lies() {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    bridgelogic::WallClock clock;
    TEST_ASSERT_EQUAL_UINT32(bridgelogic::kDefaultClockTrustMinutes, clock.trustMinutes());
    TEST_ASSERT_TRUE(clock.adopt("2026-09-21T18:00:00+02:00", base));

    const uint32_t window = bridgelogic::kDefaultClockTrustMinutes * 60000UL;
    TEST_ASSERT_TRUE(clock.trusted(base + window));
    TEST_ASSERT_FALSE(clock.trusted(base + window + 1U));

    char wire[bridgelogic::kWireTimeLen] = {};
    char shown[bridgelogic::kDisplayTimeLen] = {};
    clock.wireTime(base + window + 1U, wire, sizeof(wire));
    clock.displayTime(base + window + 1U, shown, sizeof(shown));
    // A stale clock reads exactly like a live one, which is why it is worse
    // than none: "19:30" on a box that has been offline since lunchtime is a
    // number the member will plan around.
    TEST_ASSERT_EQUAL_STRING(proto::kNoClock, wire);
    TEST_ASSERT_EQUAL_STRING("", shown);
    // And every row that names a FUTURE time blanks with it, not just "now".
    clock.displayTimeAt(base + window + 1U, 12345U, shown, sizeof(shown));
    TEST_ASSERT_EQUAL_STRING("", shown);

    // A fresh heartbeat restores it whole.
    TEST_ASSERT_TRUE(clock.adopt("2026-09-21T19:31:00+02:00", base + window + 1U));
    TEST_ASSERT_TRUE(clock.trusted(base + window + 1U));
    clock.displayTime(base + window + 1U, shown, sizeof(shown));
    TEST_ASSERT_EQUAL_STRING("19:31", shown);

    // A malformed `server_time` is not evidence that the last good one has gone
    // stale — the box keeps the clock it has and lets it age out normally.
    TEST_ASSERT_FALSE(clock.adopt("not a time", base + window + 2U));
    TEST_ASSERT_TRUE(clock.trusted(base + window + 2U));
    clock.displayTime(base + window + 2U, shown, sizeof(shown));
    TEST_ASSERT_EQUAL_STRING("19:31", shown);

    // The tenant's setting, clamped, and immediate: an admin who shortens this
    // wants the stale clock gone now, and there is nobody mid-interaction.
    clock.setTrustMinutes(0U);
    TEST_ASSERT_EQUAL_UINT32(bridgelogic::kMinClockTrustMinutes, clock.trustMinutes());
    clock.setTrustMinutes(999999UL);
    TEST_ASSERT_EQUAL_UINT32(bridgelogic::kMaxClockTrustMinutes, clock.trustMinutes());
    // Measured from the last ADOPTION, which was at base + window + 1.
    clock.setTrustMinutes(5U);
    TEST_ASSERT_TRUE(clock.trusted(base + window + 1U + (5UL * 60000UL)));
    TEST_ASSERT_FALSE(clock.trusted(base + window + 1U + (5UL * 60000UL) + 1U));
  }
}

// ---------------------------------------------------------------------------
// B4 — the layout contract, over EVERY screen at once
// ---------------------------------------------------------------------------
//
// THIS TABLE IS THE DELIVERABLE, not a nicety. Before ScreenScript there was no
// place any test could stand and look at every screen the box can paint, so a
// screen that read as half a sentence on the panel that is actually fitted was
// only ever found by somebody standing in front of one. It found `WRONG COURT`
// / `Your booking is on` while the table was being written: that clips at
// column 16 to "Your booking is", a sentence that stops one word before the
// only word that matters.

struct ScreenContract {
  bridgelogic::ScreenId id;
  /// The word rows 0-1 must still carry when a 1602 clips them at column 16.
  const char* keyNoun;
  /// Row 3 is generated from the live button map rather than being fixed text.
  bool actionRowFromMap;
  /// The greeting carve-out: row 0 is `HI <NAME>`, and a clipped name is a
  /// shortened name rather than a broken sentence.
  bool greeting;
};

const ScreenContract kContract[] = {
    {bridgelogic::ScreenId::Grant, "COURT", false, false},
    {bridgelogic::ScreenId::AlreadyOn, "COURT", false, false},
    {bridgelogic::ScreenId::NoBooking, "BOOKING", true, false},
    {bridgelogic::ScreenId::InsufficientBalance, "MINUTES", false, false},
    {bridgelogic::ScreenId::WrongCourt, "COURT", false, false},
    {bridgelogic::ScreenId::TooEarly, "EARLY", false, false},
    {bridgelogic::ScreenId::NotRecognised, "CODE", false, false},
    {bridgelogic::ScreenId::SlotEnded, "ENDED", true, false},
    {bridgelogic::ScreenId::CourtInUse, "COURT", true, false},
    {bridgelogic::ScreenId::NoTimeAvailable, "TIME", true, false},
    {bridgelogic::ScreenId::MinutesOutOfRange, "LONG", true, false},
    {bridgelogic::ScreenId::ClubClosed, "CLOSED", false, false},
    {bridgelogic::ScreenId::PurchaseEnded, "ENDED", true, false},
    {bridgelogic::ScreenId::ActivationRefused, "START", false, false},
    {bridgelogic::ScreenId::NoConnection, "CONNECTION", false, false},
    {bridgelogic::ScreenId::SeeTheDesk, "DESK", false, false},
    {bridgelogic::ScreenId::OnNotSent, "AGAIN", false, false},
    {bridgelogic::ScreenId::NotYourCourt, "COURT", false, false},
    {bridgelogic::ScreenId::ScanFirst, "SCAN", false, false},
    {bridgelogic::ScreenId::ChooseTime, "COURT", true, false},
    {bridgelogic::ScreenId::OneMoment, "MOMENT", false, false},
    {bridgelogic::ScreenId::CardBooked, "COURT", false, true},
    {bridgelogic::ScreenId::CardNoBooking, "BOOKING", true, true},
    {bridgelogic::ScreenId::CardBookedOffline, "BOOKING", false, false},
    // D10. The quote's key noun is BOOKED and its question PAY survives the
    // clip; the instruction is row 2, which is the reason it is three rows.
    {bridgelogic::ScreenId::PayForQuote, "BOOKED", true, false},
    {bridgelogic::ScreenId::PayForPaid, "PAID", false, false},
    {bridgelogic::ScreenId::PayForSplit, "PAY IN APP", false, false},
    {bridgelogic::ScreenId::PayForNothingToPay, "NOTHING TO PAY", false, false},
    {bridgelogic::ScreenId::PayForPriceChanged, "PRICE", true, false},
    {bridgelogic::ScreenId::PayForWorking, "MOMENT", false, false},
    {bridgelogic::ScreenId::CheckingCode, "MOMENT", false, false},
    {bridgelogic::ScreenId::CodeUsed, "USED", false, false},
    // R17 D17-4. A busy server on the pay-for confirm: the court cells, because
    // pressing the court again is the retry.
    {bridgelogic::ScreenId::Busy, "BUSY", true, false},
    // R19 D19-2. No court cells: no court press is honoured until a rescan.
    {bridgelogic::ScreenId::ScanAgain, "SCAN", false, false},
    // Bridge 2.3.0. The greeting is the carve-out (a cut name is still a whole
    // greeting); its second row is the whole fact and must fit untouched.
    {bridgelogic::ScreenId::Greeting, "BALANCE", false, true},
    {bridgelogic::ScreenId::GreetingNoBalance, "WELCOME", false, true},
    // A known member with nothing booked: the court cells are the invitation.
    {bridgelogic::ScreenId::PickCourt, "COURT", true, false},
    // An unscanned press on a lit court: how long, and how to add to it.
    {bridgelogic::ScreenId::MinutesLeft, "EXTEND", false, false},
    // After a scan, on a lit court: the durations are the choice.
    {bridgelogic::ScreenId::ExtendPrompt, "EXTEND", true, false},
    {bridgelogic::ScreenId::Extended, "BALANCE", false, false},
    {bridgelogic::ScreenId::ExtendedNoBalance, "COURT", false, false},
};

constexpr size_t kContractCount = sizeof(kContract) / sizeof(kContract[0]);

/// Facts every screen can be built from, all of them present, so the contract
/// is checked against the WIDEST rendering of each row rather than a convenient
/// one. The court number is four digits and the minutes two, which is the most
/// either can be on this panel.
bridgelogic::ScreenFacts fullFacts(const court::ButtonMap* map) {
  bridgelogic::ScreenFacts facts;
  facts.court = 3U; // D, the widest letter position
  facts.courtNumber = 9999;
  facts.minutes = 90U;
  snprintf(facts.endsAt, sizeof(facts.endsAt), "%s", "18:45");
  snprintf(facts.atTime, sizeof(facts.atTime), "%s", "06:00");
  snprintf(facts.fromTime, sizeof(facts.fromTime), "%s", "18:00");
  snprintf(facts.toTime, sizeof(facts.toTime), "%s", "18:45");
  snprintf(facts.name, sizeof(facts.name), "%s", "Dean");
  // The widest label the glass accepts: four digits of whole minutes (P13 §8).
  snprintf(facts.amount, sizeof(facts.amount), "%s", "9999");
  // The widest balance the glass states (kMaxBalanceOnGlass): BALANCE 9999 MIN
  // is the safe subset exactly.
  facts.balance = bridgelogic::kMaxBalanceOnGlass;
  facts.buttons = map;
  return facts;
}

bool endsMidWord(const char* row, size_t cutAt) {
  // A row that survives the cut whole cannot end mid-word.
  if (strlen(row) <= cutAt) {
    return false;
  }
  // Cut inside the text: the character at the cut, and the one before it, must
  // not both be part of one word.
  return row[cutAt] != ' ' && row[cutAt - 1U] != ' ';
}

void test_every_screen_holds_the_layout_contract() {
  // Every screen is in the table, and the table is every screen: a screen added
  // without a contract row is a screen nothing checks.
  TEST_ASSERT_EQUAL_size_t(bridgelogic::kScreenCount, kContractCount);

  court::ButtonMap map;
  const bridgelogic::ScreenFacts facts = fullFacts(&map);

  for (size_t i = 0U; i < kContractCount; ++i) {
    const ScreenContract& contract = kContract[i];
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(static_cast<uint8_t>(i), static_cast<uint8_t>(contract.id),
                                    "the contract table must be indexed by ScreenId");
    const bridgelogic::Screen screen = bridgelogic::screenFor(contract.id, facts);

    char label[64] = {};
    snprintf(label, sizeof(label), "screen %u: %s", static_cast<unsigned>(i), screen.rows[0]);

    // --- rule 1: rows 0-1 are a whole message at sixteen columns -----------
    TEST_ASSERT_TRUE_MESSAGE(screen.rows[0][0] != '\0', label);
    TEST_ASSERT_TRUE_MESSAGE(screen.rows[1][0] != '\0', label);
    for (size_t row = 0U; row < 2U; ++row) {
      TEST_ASSERT_TRUE_MESSAGE(strlen(screen.rows[row]) <= court::kSafeSubsetCols, label);
      // The carve-out is row 0's NAME only: a greeting's second row is a whole
      // fact (a balance, WELCOME) and may not be cut either.
      if (!contract.greeting || row == 1U) {
        TEST_ASSERT_FALSE_MESSAGE(endsMidWord(screen.rows[row], court::kSafeSubsetCols), label);
      }
    }
    // The key noun survives the clip, in the pair.
    char pair[(court::kSafeSubsetCols * 2U) + 2U] = {};
    snprintf(pair, sizeof(pair), "%s %s", screen.rows[0], screen.rows[1]);
    if (!contract.greeting) {
      TEST_ASSERT_NOT_NULL_MESSAGE(strstr(pair, contract.keyNoun), label);
    } else {
      TEST_ASSERT_NOT_NULL_MESSAGE(strstr(screen.rows[1], contract.keyNoun), label);
    }

    // --- rule 2: row 3 leaves columns 16-19 to the countdown ---------------
    TEST_ASSERT_TRUE_MESSAGE(strlen(screen.rows[3]) <= court::kSafeSubsetCols, label);

    // --- every row fits the panel that is actually fitted ------------------
    for (size_t row = 0U; row < proto::kMaxRows; ++row) {
      TEST_ASSERT_TRUE_MESSAGE(strlen(screen.rows[row]) <= court::kLineLen, label);
    }

    // --- rule 4: no code, no id, no number the member did not choose -------
    // A relay index never reaches the glass — courts are letters — and the only
    // numbers here are a club court number, a duration and a clock.
    TEST_ASSERT_NULL_MESSAGE(strstr(pair, "relay"), label);
    TEST_ASSERT_NULL_MESSAGE(strstr(pair, "booking_id"), label);

    // --- the hold is bounded, always ---------------------------------------
    TEST_ASSERT_TRUE_MESSAGE(screen.holdSeconds >= proto::kShowHoldMinSeconds, label);
    TEST_ASSERT_TRUE_MESSAGE(screen.holdSeconds <= proto::kShowHoldMaxSeconds, label);
    // Unallocated flag bits stay zero: a bit this build sets and the Mega does
    // not know is a screen nobody designed.
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(0U, screen.flags & static_cast<uint8_t>(~bridgelogic::kShowFlagCountdown),
                                    label);

    // --- rule 3: the action row is generated where the table says it is ----
    if (contract.actionRowFromMap) {
      TEST_ASSERT_TRUE_MESSAGE(screen.rows[3][0] != '\0', label);
    }
  }
}

void test_a_sixteen_character_name_still_fits_the_panel() {
  // `member_display` is server-truncated to sixteen characters, so `HI ` plus a
  // name is nineteen — inside the 2004A's twenty and past the 1602's sixteen.
  // That is the ONE carve-out from rule 1, and it is a shortened name rather
  // than a broken sentence: the message is still complete and still correct.
  court::ButtonMap map;
  bridgelogic::ScreenFacts facts = fullFacts(&map);
  snprintf(facts.name, sizeof(facts.name), "%s", "Bartholomew Jone");
  TEST_ASSERT_EQUAL_size_t(bridgelogic::kMaxMemberNameLen, strlen(facts.name));

  const bridgelogic::Screen card = bridgelogic::screenFor(bridgelogic::ScreenId::CardBooked, facts);
  TEST_ASSERT_EQUAL_STRING("HI Bartholomew Jone", card.rows[0]);
  TEST_ASSERT_TRUE(strlen(card.rows[0]) <= court::kLineLen);

  // A one-character name, and none at all.
  snprintf(facts.name, sizeof(facts.name), "%s", "X");
  TEST_ASSERT_EQUAL_STRING("HI X", bridgelogic::screenFor(bridgelogic::ScreenId::CardBooked, facts).rows[0]);
  facts.name[0] = '\0';
  TEST_ASSERT_EQUAL_STRING("HI THERE",
                           bridgelogic::screenFor(bridgelogic::ScreenId::CardBooked, facts).rows[0]);
}

void test_the_screens_say_what_the_table_says_they_say() {
  // The wording itself, for the screens whose exact words are the point.
  court::ButtonMap map;
  bridgelogic::ScreenFacts facts = fullFacts(&map);
  facts.court = 1U;
  facts.courtNumber = 9;
  facts.minutes = 45U;

  bridgelogic::Screen s = bridgelogic::screenFor(bridgelogic::ScreenId::Grant, facts);
  TEST_ASSERT_EQUAL_STRING("COURT B IS ON", s.rows[0]);
  TEST_ASSERT_EQUAL_STRING("45 MINUTES", s.rows[1]);
  TEST_ASSERT_EQUAL_STRING("Ends 18:45", s.rows[2]);
  TEST_ASSERT_EQUAL_STRING("ENJOY YOUR GAME", s.rows[3]);
  TEST_ASSERT_EQUAL_UINT16(bridgelogic::kRevertSeconds, s.holdSeconds);
  TEST_ASSERT_EQUAL_UINT8(bridgelogic::kShowFlagCountdown, s.flags);

  s = bridgelogic::screenFor(bridgelogic::ScreenId::AlreadyOn, facts);
  TEST_ASSERT_EQUAL_STRING("45 MINUTES LEFT", s.rows[1]);

  // The screen the contract caught: the court NUMBER on row 1, where sixteen
  // columns can hold it.
  s = bridgelogic::screenFor(bridgelogic::ScreenId::WrongCourt, facts);
  TEST_ASSERT_EQUAL_STRING("WRONG COURT", s.rows[0]);
  TEST_ASSERT_EQUAL_STRING("GO TO COURT 9", s.rows[1]);

  s = bridgelogic::screenFor(bridgelogic::ScreenId::ChooseTime, facts);
  TEST_ASSERT_EQUAL_STRING("COURT B", s.rows[0]);
  TEST_ASSERT_EQUAL_STRING("HOW LONG?", s.rows[1]);
  TEST_ASSERT_EQUAL_UINT16(bridgelogic::kChoiceSeconds, s.holdSeconds);
  TEST_ASSERT_EQUAL_UINT8(bridgelogic::kShowFlagCountdown, s.flags);

  // Never indefinite, and never longer than the blocking call plus slack.
  s = bridgelogic::screenFor(bridgelogic::ScreenId::OneMoment, facts);
  TEST_ASSERT_EQUAL_UINT16(bridgelogic::kWaitSeconds, s.holdSeconds);
  TEST_ASSERT_EQUAL_STRING("", s.rows[2]);

  s = bridgelogic::screenFor(bridgelogic::ScreenId::CardBooked, facts);
  TEST_ASSERT_EQUAL_STRING("Booked 18:00-18:45", s.rows[2]);
  TEST_ASSERT_EQUAL_UINT16(bridgelogic::kCardSeconds, s.holdSeconds);

  // The offline roster path has no name and does not pretend to.
  s = bridgelogic::screenFor(bridgelogic::ScreenId::CardBookedOffline, facts);
  TEST_ASSERT_EQUAL_STRING("BOOKING FOUND", s.rows[0]);
}

void test_a_row_that_would_name_a_time_blanks_when_the_clock_is_not_trusted() {
  // B6's rule, seen from the glass: a stale clock reads exactly like a live
  // one, so a row whose only content is a blanked time renders BLANK rather
  // than "Ends " — a prefix with its answer missing reads as a screen that is
  // still loading.
  court::ButtonMap map;
  bridgelogic::ScreenFacts facts = fullFacts(&map);
  facts.endsAt[0] = '\0';
  facts.atTime[0] = '\0';
  facts.toTime[0] = '\0';

  TEST_ASSERT_EQUAL_STRING("", bridgelogic::screenFor(bridgelogic::ScreenId::Grant, facts).rows[2]);
  TEST_ASSERT_EQUAL_STRING("", bridgelogic::screenFor(bridgelogic::ScreenId::TooEarly, facts).rows[2]);
  TEST_ASSERT_EQUAL_STRING("", bridgelogic::screenFor(bridgelogic::ScreenId::ClubClosed, facts).rows[1]);
  TEST_ASSERT_EQUAL_STRING("", bridgelogic::screenFor(bridgelogic::ScreenId::CardBooked, facts).rows[2]);

  // And the rows that do NOT name a time are untouched: a blank clock must not
  // blank the screen.
  const bridgelogic::Screen grant = bridgelogic::screenFor(bridgelogic::ScreenId::Grant, facts);
  TEST_ASSERT_EQUAL_STRING("COURT D IS ON", grant.rows[0]);
  TEST_ASSERT_EQUAL_STRING("ENJOY YOUR GAME", grant.rows[3]);
}

void test_the_action_row_is_the_live_panel_and_never_a_hardcoded_one() {
  court::ButtonMap map;
  bridgelogic::ScreenFacts facts = fullFacts(&map);

  // The default panel: courts A-D on the green row, 15/30/45/60 on the black.
  char row[court::kLineLen + 1U] = {};
  bridgelogic::renderActionRow(map, bridgelogic::kCourtCellsFrom, row, sizeof(row));
  TEST_ASSERT_EQUAL_STRING("A   B   C   D", row);
  bridgelogic::renderActionRow(map, bridgelogic::kDurationCellsFrom, row, sizeof(row));
  TEST_ASSERT_EQUAL_STRING("15  30  45  60", row);
  TEST_ASSERT_TRUE(strlen(row) <= court::kSafeSubsetCols);

  // A club that maps `minutes:20` must see 20. Hardcoding the row is how a
  // screen tells a member to press a button that buys something else.
  TEST_ASSERT_TRUE(map.setFromWire(4U, "minutes:20"));
  TEST_ASSERT_TRUE(map.setFromWire(5U, "off"));
  TEST_ASSERT_TRUE(map.setFromWire(6U, "none"));
  bridgelogic::renderActionRow(map, bridgelogic::kDurationCellsFrom, row, sizeof(row));
  // `off` and `none` render BLANK: a button that does nothing must not
  // advertise a duration somebody would press.
  TEST_ASSERT_EQUAL_STRING("20          60", row);

  facts.buttons = &map;
  TEST_ASSERT_EQUAL_STRING("20          60",
                           bridgelogic::screenFor(bridgelogic::ScreenId::ChooseTime, facts).rows[3]);

  // No map at all falls back to the original wiring, which is what a box that
  // has never had a heartbeat actually has.
  facts.buttons = nullptr;
  TEST_ASSERT_EQUAL_STRING("15  30  45  60",
                           bridgelogic::screenFor(bridgelogic::ScreenId::ChooseTime, facts).rows[3]);
}

void test_member_display_is_read_tolerantly_and_never_truncated() {
  bridgelogic::ScreenFacts facts;

  // The ordinary case today: the backend does not send the field yet.
  const char none[] = "{\"activated\":true,\"granted_seconds\":2700,\"court_number\":7}";
  bridgelogic::readMemberDisplay(none, len(none), facts);
  TEST_ASSERT_EQUAL_STRING("", facts.name);

  const char one[] = "{\"member_display\":\"X\"}";
  bridgelogic::readMemberDisplay(one, len(one), facts);
  TEST_ASSERT_EQUAL_STRING("X", facts.name);

  const char sixteen[] = "{\"member_display\":\"Bartholomew Jone\"}";
  bridgelogic::readMemberDisplay(sixteen, len(sixteen), facts);
  TEST_ASSERT_EQUAL_STRING("Bartholomew Jone", facts.name);

  // The frame's escape set. These are the bytes that would re-write the fields
  // around a name if it were ever interpolated into a body — it is not, it only
  // ever reaches the glass — and the scanner must still find the string's end.
  const char escapes[] = "{\"member_display\":\"A,B*C%D\"}";
  bridgelogic::readMemberDisplay(escapes, len(escapes), facts);
  TEST_ASSERT_EQUAL_STRING("A,B*C%D", facts.name);

  // Forty characters: REFUSED by devapi::json rather than truncated, because
  // half a name is a different member's. It degrades to the greeting, never to
  // a missing screen.
  const char long40[] = "{\"member_display\":\"0123456789012345678901234567890123456789\"}";
  bridgelogic::readMemberDisplay(long40, len(long40), facts);
  TEST_ASSERT_EQUAL_STRING("", facts.name);
  court::ButtonMap map;
  facts.buttons = &map;
  TEST_ASSERT_EQUAL_STRING("HI THERE",
                           bridgelogic::screenFor(bridgelogic::ScreenId::CardBooked, facts).rows[0]);

  // A decoy at a deeper level, before and after. The greeting is the member's
  // only confirmation that the box knows who they are.
  const char decoyFirst[] = "{\"detail\":{\"member_display\":\"Mallory\"},\"member_display\":\"Dean\"}";
  bridgelogic::readMemberDisplay(decoyFirst, len(decoyFirst), facts);
  TEST_ASSERT_EQUAL_STRING("Dean", facts.name);
  const char decoyOnly[] = "{\"detail\":{\"member_display\":\"Mallory\"}}";
  bridgelogic::readMemberDisplay(decoyOnly, len(decoyOnly), facts);
  TEST_ASSERT_EQUAL_STRING("", facts.name);

  // Wrong type, and a truncated body.
  const char wrongType[] = "{\"member_display\":42}";
  bridgelogic::readMemberDisplay(wrongType, len(wrongType), facts);
  TEST_ASSERT_EQUAL_STRING("", facts.name);
  const char cut[] = "{\"member_display\":\"Dea";
  bridgelogic::readMemberDisplay(cut, len(cut), facts);
  TEST_ASSERT_EQUAL_STRING("", facts.name);
}

// ---------------------------------------------------------------------------
// Bridge 2.3.0 — the greeting, minutes left, and extending a lit court
// ---------------------------------------------------------------------------

void test_the_bridge_2_3_screens_say_what_the_spec_says() {
  court::ButtonMap map;
  bridgelogic::ScreenFacts facts = fullFacts(&map);
  facts.court = 0U;
  facts.minutes = 45U;
  facts.balance = 120U;
  snprintf(facts.name, sizeof(facts.name), "%s", "DEAN");

  bridgelogic::Screen s = bridgelogic::screenFor(bridgelogic::ScreenId::Greeting, facts);
  TEST_ASSERT_EQUAL_STRING("HI DEAN", s.rows[0]);
  TEST_ASSERT_EQUAL_STRING("BALANCE 120 MIN", s.rows[1]);
  TEST_ASSERT_EQUAL_STRING("", s.rows[2]);
  TEST_ASSERT_EQUAL_STRING("", s.rows[3]);
  // An acknowledgement: the card hold, no countdown.
  TEST_ASSERT_EQUAL_UINT16(bridgelogic::kCardSeconds, s.holdSeconds);
  TEST_ASSERT_EQUAL_UINT8(0U, s.flags);
  TEST_ASSERT_TRUE(bridgelogic::holdClassOf(bridgelogic::ScreenId::Greeting) == bridgelogic::HoldClass::Card);

  s = bridgelogic::screenFor(bridgelogic::ScreenId::GreetingNoBalance, facts);
  TEST_ASSERT_EQUAL_STRING("HI DEAN", s.rows[0]);
  TEST_ASSERT_EQUAL_STRING("WELCOME", s.rows[1]);

  // No name at all: `HI` alone — never `HI ` with a dangling space, and never
  // the member_display card's `HI THERE`.
  facts.name[0] = '\0';
  TEST_ASSERT_EQUAL_STRING("HI", bridgelogic::screenFor(bridgelogic::ScreenId::Greeting, facts).rows[0]);
  TEST_ASSERT_EQUAL_STRING("HI",
                           bridgelogic::screenFor(bridgelogic::ScreenId::GreetingNoBalance, facts).rows[0]);

  s = bridgelogic::screenFor(bridgelogic::ScreenId::PickCourt, facts);
  TEST_ASSERT_EQUAL_STRING("PICK A COURT", s.rows[0]);
  TEST_ASSERT_EQUAL_STRING("THEN A TIME", s.rows[1]);
  TEST_ASSERT_EQUAL_STRING("A   B   C   D", s.rows[3]);
  TEST_ASSERT_EQUAL_UINT16(bridgelogic::kChoiceSeconds, s.holdSeconds);
  TEST_ASSERT_EQUAL_UINT8(bridgelogic::kShowFlagCountdown, s.flags);
  // Court cells on row 3, so the scan-left clamp applies to it.
  TEST_ASSERT_TRUE(bridgelogic::invitesCourtPress(bridgelogic::ScreenId::PickCourt));

  s = bridgelogic::screenFor(bridgelogic::ScreenId::MinutesLeft, facts);
  TEST_ASSERT_EQUAL_STRING("COURT A 45 MIN", s.rows[0]);
  TEST_ASSERT_EQUAL_STRING("SCAN TO EXTEND", s.rows[1]);
  TEST_ASSERT_EQUAL_STRING("SCAN WHEN READY", s.rows[3]);
  TEST_ASSERT_EQUAL_UINT16(bridgelogic::kRevertSeconds, s.holdSeconds);
  TEST_ASSERT_FALSE(bridgelogic::invitesCourtPress(bridgelogic::ScreenId::MinutesLeft));

  s = bridgelogic::screenFor(bridgelogic::ScreenId::ExtendPrompt, facts);
  TEST_ASSERT_EQUAL_STRING("COURT A 45 MIN", s.rows[0]);
  TEST_ASSERT_EQUAL_STRING("EXTEND:PICK TIME", s.rows[1]);
  TEST_ASSERT_EQUAL_size_t(court::kSafeSubsetCols, strlen(s.rows[1]));
  TEST_ASSERT_EQUAL_STRING("15  30  45  60", s.rows[3]);
  TEST_ASSERT_EQUAL_UINT16(bridgelogic::kChoiceSeconds, s.holdSeconds);
  TEST_ASSERT_EQUAL_UINT8(bridgelogic::kShowFlagCountdown, s.flags);
  TEST_ASSERT_FALSE(bridgelogic::invitesCourtPress(bridgelogic::ScreenId::ExtendPrompt));

  facts.minutes = 30U;
  facts.balance = 90U;
  s = bridgelogic::screenFor(bridgelogic::ScreenId::Extended, facts);
  TEST_ASSERT_EQUAL_STRING("COURT A +30 MIN", s.rows[0]);
  TEST_ASSERT_EQUAL_STRING("BALANCE 90 MIN", s.rows[1]);
  TEST_ASSERT_EQUAL_STRING("ENJOY YOUR GAME", s.rows[3]);
  s = bridgelogic::screenFor(bridgelogic::ScreenId::ExtendedNoBalance, facts);
  TEST_ASSERT_EQUAL_STRING("COURT A +30 MIN", s.rows[0]);
  TEST_ASSERT_EQUAL_STRING("ENJOY YOUR GAME", s.rows[1]);

  // The unscanned press on a DARK court reads the existing ScanFirst words.
  s = bridgelogic::screenFor(bridgelogic::ScreenId::ScanFirst, facts);
  TEST_ASSERT_EQUAL_STRING("SCAN YOUR CODE", s.rows[0]);
  TEST_ASSERT_EQUAL_STRING("Then a court", s.rows[1]);

  // The renderer's last line of defence: a balance past what fits is never
  // printed wide, whatever picked the screen.
  facts.balance = 123456U;
  TEST_ASSERT_TRUE(strlen(bridgelogic::screenFor(bridgelogic::ScreenId::Extended, facts).rows[1]) <=
                   court::kSafeSubsetCols);
}

void test_read_greeting_is_tolerant_of_absence_and_shapes_the_name_for_the_glass() {
  bridgelogic::Greeting g;

  // Both fields: name upper-cased, balance read.
  const char both[] = "{\"activated\":true,\"greeting_name\":\"Dean\",\"balance_minutes\":120}";
  bridgelogic::readGreeting(both, len(both), g);
  TEST_ASSERT_EQUAL_STRING("DEAN", g.name);
  TEST_ASSERT_TRUE(g.hasBalance);
  TEST_ASSERT_EQUAL_UINT32(120U, g.balanceMinutes);

  // Neither — an older backend, or a refusal: HI / WELCOME, never a failure.
  const char neither[] = "{\"activated\":false,\"reason\":\"no_booking\"}";
  bridgelogic::readGreeting(neither, len(neither), g);
  TEST_ASSERT_EQUAL_STRING("", g.name);
  TEST_ASSERT_FALSE(g.hasBalance);
  TEST_ASSERT_EQUAL_UINT32(0U, g.balanceMinutes);

  // One without the other, each way round.
  const char nameOnly[] = "{\"greeting_name\":\"Ann\"}";
  bridgelogic::readGreeting(nameOnly, len(nameOnly), g);
  TEST_ASSERT_EQUAL_STRING("ANN", g.name);
  TEST_ASSERT_FALSE(g.hasBalance);
  const char balanceOnly[] = "{\"balance_minutes\":0}";
  bridgelogic::readGreeting(balanceOnly, len(balanceOnly), g);
  TEST_ASSERT_EQUAL_STRING("", g.name);
  TEST_ASSERT_TRUE(g.hasBalance); // zero is a balance, not an absence
  TEST_ASSERT_EQUAL_UINT32(0U, g.balanceMinutes);

  // Cut to thirteen columns (HI plus thirteen is the 1602's sixteen), and a
  // cut that ends on a space is trimmed rather than left dangling.
  const char longName[] = "{\"greeting_name\":\"Bartholomew Jones-Smith\"}";
  bridgelogic::readGreeting(longName, len(longName), g);
  TEST_ASSERT_EQUAL_size_t(bridgelogic::kGreetingNameCols, strlen(g.name));
  TEST_ASSERT_EQUAL_STRING("BARTHOLOMEW J", g.name);
  const char cutAtSpace[] = "{\"greeting_name\":\"Mary Kate Ann Olsen\"}";
  bridgelogic::readGreeting(cutAtSpace, len(cutAtSpace), g);
  TEST_ASSERT_EQUAL_STRING("MARY KATE ANN", g.name);
  const char cutBeforeSpace[] = "{\"greeting_name\":\"Abcdefghijkl  Z\"}";
  bridgelogic::readGreeting(cutBeforeSpace, len(cutBeforeSpace), g);
  TEST_ASSERT_EQUAL_STRING("ABCDEFGHIJKL", g.name);

  // Nothing the HD44780 cannot draw: an escaped control byte and a high byte
  // are dropped, not shown as garbage.
  const char odd[] = "{\"greeting_name\":\"Zo\\u0001\\u00e9e\"}";
  bridgelogic::readGreeting(odd, len(odd), g);
  TEST_ASSERT_EQUAL_STRING("ZOE", g.name);
  // The field arrives as raw JSON text. A real escape is DECODED, never
  // painted as `\U00E9`: an ASCII one becomes its letter, a quote and a
  // backslash are themselves, and the rest — \n, \t, a lone or truncated
  // escape — draw nothing.
  const char escaped[] = "{\"greeting_name\":\"\\u0041nn \\\"Jo\\\" O\\\\B\\n\\u12\"}";
  bridgelogic::readGreeting(escaped, len(escaped), g);
  TEST_ASSERT_EQUAL_STRING("ANN \"JO\" O\\B", g.name);
  // A raw UTF-8 byte the server never sends is still not drawn.
  const char rawHigh[] = "{\"greeting_name\":\"Zo\xc3\xab"
                         "e\"}";
  bridgelogic::readGreeting(rawHigh, len(rawHigh), g);
  TEST_ASSERT_EQUAL_STRING("ZOE", g.name);

  // TOP LEVEL only: a decoy in a nested object is somebody else's greeting.
  const char decoy[] =
      "{\"detail\":{\"greeting_name\":\"Mallory\",\"balance_minutes\":9},\"activated\":true}";
  bridgelogic::readGreeting(decoy, len(decoy), g);
  TEST_ASSERT_EQUAL_STRING("", g.name);
  TEST_ASSERT_FALSE(g.hasBalance);

  // Wrong types read as absent; a name too long for the read buffer is refused
  // whole (an empty name) rather than half-read.
  const char wrongTypes[] = "{\"greeting_name\":42,\"balance_minutes\":\"120\"}";
  bridgelogic::readGreeting(wrongTypes, len(wrongTypes), g);
  TEST_ASSERT_EQUAL_STRING("", g.name);
  TEST_ASSERT_FALSE(g.hasBalance);
  const char huge[] = "{\"greeting_name\":\"0123456789012345678901234567890123456789012345678901234567\"}";
  bridgelogic::readGreeting(huge, len(huge), g);
  TEST_ASSERT_EQUAL_STRING("", g.name);

  // Nothing at all.
  bridgelogic::readGreeting(nullptr, 0U, g);
  TEST_ASSERT_EQUAL_STRING("", g.name);
  TEST_ASSERT_FALSE(g.hasBalance);
}

void test_corpus_activate_greeting_greets_by_name_and_balance() {
  loadHttpCorpus();
  char body[512] = {};
  const size_t n = bodyOf(responseVector("activate-response-greeting"), body, sizeof(body));

  bridgelogic::Greeting g;
  bridgelogic::readGreeting(body, n, g);
  court::ButtonMap map;
  bridgelogic::ScreenFacts facts = fullFacts(&map);
  const bridgelogic::ScreenId id = bridgelogic::greetingScreen(g, facts);
  TEST_ASSERT_TRUE(id == bridgelogic::ScreenId::Greeting);
  const bridgelogic::Screen s = bridgelogic::screenFor(id, facts);
  TEST_ASSERT_EQUAL_STRING("HI DEAN", s.rows[0]);
  TEST_ASSERT_EQUAL_STRING("BALANCE 120 MIN", s.rows[1]);

  // The greeting is additive: the same body still lights relay C as before.
  const bridgelogic::ScanFlow flow;
  const bridgelogic::ActivationResult r =
      flow.onActivateResponse(200U, body, n, kCorpusCourts, devlink::kMaxCourts);
  TEST_ASSERT_TRUE(r.outcome.action == court::Action::TurnOn);
  TEST_ASSERT_EQUAL_UINT8(2U, r.outcome.court);
  TEST_ASSERT_TRUE(r.outcome.recognised);

  // And the vectors without the fields greet without them.
  const size_t m = bodyOf(responseVector("activate-response-ok"), body, sizeof(body));
  bridgelogic::readGreeting(body, m, g);
  TEST_ASSERT_TRUE(bridgelogic::greetingScreen(g, facts) == bridgelogic::ScreenId::GreetingNoBalance);
  TEST_ASSERT_EQUAL_STRING("HI",
                           bridgelogic::screenFor(bridgelogic::ScreenId::GreetingNoBalance, facts).rows[0]);
}

void test_a_balance_the_glass_cannot_hold_is_not_stated_at_all() {
  bridgelogic::ScreenFacts facts;
  bridgelogic::Greeting g;
  g.hasBalance = true;
  g.balanceMinutes = bridgelogic::kMaxBalanceOnGlass;
  TEST_ASSERT_TRUE(bridgelogic::greetingScreen(g, facts) == bridgelogic::ScreenId::Greeting);
  TEST_ASSERT_EQUAL_UINT32(bridgelogic::kMaxBalanceOnGlass, facts.balance);
  // One more and BALANCE 10000 MIN would clip to `BALANCE 10000 MI`: a number
  // with no unit. The greeting names no balance instead — never a wrong one.
  g.balanceMinutes = bridgelogic::kMaxBalanceOnGlass + 1U;
  TEST_ASSERT_TRUE(bridgelogic::greetingScreen(g, facts) == bridgelogic::ScreenId::GreetingNoBalance);
  g.hasBalance = false;
  g.balanceMinutes = 5U;
  TEST_ASSERT_TRUE(bridgelogic::greetingScreen(g, facts) == bridgelogic::ScreenId::GreetingNoBalance);

  bridgelogic::ExtendResult r;
  r.extended = true;
  r.extendedMinutes = 30U;
  r.hasBalance = true;
  r.balanceAfterMinutes = 150U;
  TEST_ASSERT_TRUE(bridgelogic::extendedScreen(r, 3U, facts) == bridgelogic::ScreenId::Extended);
  TEST_ASSERT_EQUAL_UINT8(3U, facts.court);
  TEST_ASSERT_EQUAL_UINT32(30U, facts.minutes);
  TEST_ASSERT_EQUAL_UINT32(150U, facts.balance);
  r.balanceAfterMinutes = bridgelogic::kMaxBalanceOnGlass + 1U;
  TEST_ASSERT_TRUE(bridgelogic::extendedScreen(r, 3U, facts) == bridgelogic::ScreenId::ExtendedNoBalance);
  r.hasBalance = false;
  r.balanceAfterMinutes = 0U;
  TEST_ASSERT_TRUE(bridgelogic::extendedScreen(r, 0U, facts) == bridgelogic::ScreenId::ExtendedNoBalance);
}

void test_corpus_extend_body_is_byte_identical_to_the_contract() {
  loadHttpCorpus();
  char expected[512] = {};
  const size_t n = bodyOf(requestVector("extend-request"), expected, sizeof(expected));

  // Thirty minutes on relay C, which this box maps to club court 3.
  bridgelogic::ExtendRequest request;
  request.mac = corpusMac();
  request.courtNumber = 3;
  request.minutes = 30U;
  request.token = "7Q3F9KM2XZ8B";
  request.nonce = "9f2a4c6e8b0d1f3a";
  request.scanAgeMs = 4321U; // not a member code: never rendered
  char rendered[bridgelogic::kExtendBodyCap] = {};
  const size_t renderedLen = bridgelogic::renderExtendBody(rendered, sizeof(rendered), request);
  TEST_ASSERT_EQUAL_size_t(n, renderedLen);
  TEST_ASSERT_EQUAL_STRING(expected, rendered);
  TEST_ASSERT_EQUAL_STRING("/api/v1/device/extend", bridgelogic::kPathExtend);
}

void test_extend_body_ages_a_member_code_escapes_a_scan_and_refuses_what_does_not_fit() {
  char out[bridgelogic::kExtendBodyCap] = {};
  bridgelogic::ExtendRequest request;
  request.mac = "5ccf7f0a1b2c";
  request.courtNumber = 2;
  request.minutes = 15U;
  request.nonce = "0001020304050607";
  request.scanAgeMs = 1500U;

  // A v1 member code (nineteen characters, '1' first) carries its age, as the
  // walk-up's does, so the server can bound how old a code it is charging is.
  request.token = "1ABCDEFGHJKMNPQRST";
  TEST_ASSERT_EQUAL_size_t(18U, strlen(request.token));
  request.token = "1ABCDEFGHJKMNPQRSTU";
  TEST_ASSERT_TRUE(bridgelogic::renderExtendBody(out, sizeof(out), request) > 0U);
  TEST_ASSERT_EQUAL_STRING(
      "{\"mac\":\"5ccf7f0a1b2c\",\"method\":\"qr\",\"token\":\"1ABCDEFGHJKMNPQRSTU\",\"court\":2,"
      "\"minutes\":15,\"nonce\":\"0001020304050607\",\"scan_age_ms\":1500}",
      out);

  // A scan the Mega passed through with a quote and a backslash in it is
  // escaped, never interpolated raw.
  request.token = "Q\"\\X";
  TEST_ASSERT_TRUE(bridgelogic::renderExtendBody(out, sizeof(out), request) > 0U);
  TEST_ASSERT_NOT_NULL(strstr(out, "\"token\":\"Q\\\"\\\\X\""));

  // Too small a buffer: 0 and an empty string, never a truncated body.
  request.token = "7Q3F9KM2XZ8B";
  char tiny[40] = {};
  TEST_ASSERT_EQUAL_size_t(0U, bridgelogic::renderExtendBody(tiny, sizeof(tiny), request));
  TEST_ASSERT_EQUAL_STRING("", tiny);

  // Anything missing renders nothing.
  bridgelogic::ExtendRequest missing = request;
  missing.nonce = nullptr;
  TEST_ASSERT_EQUAL_size_t(0U, bridgelogic::renderExtendBody(out, sizeof(out), missing));
  missing = request;
  missing.token = nullptr;
  TEST_ASSERT_EQUAL_size_t(0U, bridgelogic::renderExtendBody(out, sizeof(out), missing));
  missing = request;
  missing.mac = "";
  TEST_ASSERT_EQUAL_size_t(0U, bridgelogic::renderExtendBody(out, sizeof(out), missing));
  TEST_ASSERT_EQUAL_size_t(0U, bridgelogic::renderExtendBody(nullptr, sizeof(out), request));
}

/// Reads one `extend` response vector the way the box does, with the status
/// the vector declares.
bridgelogic::ExtendResult extendVector(const char* id) {
  static char body[512] = {};
  const char* vector = responseVector(id);
  const size_t n = bodyOf(vector, body, sizeof(body));
  const uint16_t status = static_cast<uint16_t>(corpus::unsignedValue(corpus::member(vector, "status")));
  return bridgelogic::onExtendResponse(status, body, n);
}

void test_corpus_extend_answers_mean_what_the_contract_says() {
  loadHttpCorpus();

  bridgelogic::ExtendResult r = extendVector("extend-response-ok");
  TEST_ASSERT_TRUE(r.decided);
  TEST_ASSERT_TRUE(r.extended);
  TEST_ASSERT_EQUAL_UINT32(30U, r.extendedMinutes);
  TEST_ASSERT_TRUE(r.hasBalance);
  TEST_ASSERT_EQUAL_UINT32(150U, r.balanceAfterMinutes);
  TEST_ASSERT_FALSE(r.forgetsScan);

  // What was SOLD, never what was asked: twenty, and no balance to state.
  r = extendVector("extend-response-truncated");
  TEST_ASSERT_TRUE(r.extended);
  TEST_ASSERT_EQUAL_UINT32(20U, r.extendedMinutes);
  TEST_ASSERT_FALSE(r.hasBalance);

  struct Refusal {
    const char* id;
    const char* line1;
    const char* line2;
  };

  const Refusal refusals[] = {
      {"extend-response-court-not-lit", "COURT NOT ON", "PICK ANOTHER"},
      {"extend-response-no-time", "NO TIME BEFORE", "NEXT BOOKING"},
      {"extend-response-insufficient", "TOO FEW MINUTES", "BUY & RETRY"},
  };
  for (const Refusal& row : refusals) {
    r = extendVector(row.id);
    TEST_ASSERT_TRUE_MESSAGE(r.decided, row.id);
    TEST_ASSERT_FALSE_MESSAGE(r.extended, row.id);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(row.line1, r.refusal.line1, row.id);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(row.line2, r.refusal.line2, row.id);
    TEST_ASSERT_TRUE_MESSAGE(r.refusal.action == court::Action::Refuse, row.id);
    // A refusal about the court or the money, not about the code: the scan
    // stays for another try.
    TEST_ASSERT_FALSE_MESSAGE(r.forgetsScan, row.id);
    TEST_ASSERT_FALSE_MESSAGE(r.invitesPress, row.id);
    TEST_ASSERT_TRUE(strlen(r.refusal.line1) <= court::kSafeSubsetCols);
    TEST_ASSERT_TRUE(strlen(r.refusal.line2) <= court::kSafeSubsetCols);
  }
}

void test_extend_never_happens_offline_and_an_unreadable_grant_is_undecided() {
  // No link at all: extending moves money, so it is never done offline.
  bridgelogic::ExtendResult r = bridgelogic::onExtendResponse(0U, nullptr, 0U);
  TEST_ASSERT_FALSE(r.decided);
  TEST_ASSERT_FALSE(r.extended);
  TEST_ASSERT_EQUAL_STRING("NO CONNECTION", r.refusal.line1);
  TEST_ASSERT_EQUAL_STRING("EXTEND NEEDS NET", r.refusal.line2);

  // A rate limiter or a server fault decided nothing either: the nonce is kept
  // and PRESS AGAIN asks the server whether THIS purchase happened.
  const char busy[] = "{\"error\":\"conflict_retry\"}";
  r = bridgelogic::onExtendResponse(503U, busy, len(busy));
  TEST_ASSERT_FALSE(r.decided);
  TEST_ASSERT_EQUAL_STRING("BUSY", r.refusal.line1);
  r = bridgelogic::onExtendResponse(429U, nullptr, 0U);
  TEST_ASSERT_FALSE(r.decided);

  // THE BUG THIS PINS. A 200 the box could not read whole — a body cut by the
  // transport, or one naming no extended_minutes — used to read NO TIME BEFORE
  // and spend the nonce, while the server had very likely charged the member:
  // the retry was then a SECOND purchase. Undecided, the retry carries the
  // same nonce and the server answers with the first (`replayed:true`).
  const char cut[] = "{\"booking_id\":\"3fa8\",\"extended_minutes\":30,\"balance_af";
  r = bridgelogic::onExtendResponse(200U, cut, len(cut));
  TEST_ASSERT_FALSE(r.decided);
  TEST_ASSERT_FALSE(r.extended);
  TEST_ASSERT_EQUAL_STRING("BUSY", r.refusal.line1);
  TEST_ASSERT_EQUAL_STRING("PRESS AGAIN", r.refusal.line2);
  const char noField[] = "{\"booking_id\":\"3fa8\",\"replayed\":false}";
  r = bridgelogic::onExtendResponse(200U, noField, len(noField));
  TEST_ASSERT_FALSE(r.decided);
  r = bridgelogic::onExtendResponse(200U, nullptr, 0U);
  TEST_ASSERT_FALSE(r.decided);
  // A nested decoy is not the answer either.
  const char nested[] = "{\"detail\":{\"extended_minutes\":30}}";
  r = bridgelogic::onExtendResponse(200U, nested, len(nested));
  TEST_ASSERT_FALSE(r.decided);

  // Only a WHOLE body that says it added nothing is the decided "nothing".
  const char zero[] = "{\"extended_minutes\":0,\"balance_after_minutes\":40}";
  r = bridgelogic::onExtendResponse(200U, zero, len(zero));
  TEST_ASSERT_TRUE(r.decided);
  TEST_ASSERT_FALSE(r.extended);
  TEST_ASSERT_EQUAL_STRING("NO TIME BEFORE", r.refusal.line1);
}

void test_extend_borrows_the_walk_ups_words_and_its_scan_rules() {
  // A used code and an unknown one are refusals of the CODE: the scan is
  // forgotten (D8-1), exactly as the walk-up forgets it.
  const char used[] = "{\"error\":\"code_used\"}";
  bridgelogic::ExtendResult r = bridgelogic::onExtendResponse(409U, used, len(used));
  TEST_ASSERT_TRUE(r.decided);
  TEST_ASSERT_TRUE(r.forgetsScan);
  TEST_ASSERT_EQUAL_STRING("CODE USED", r.refusal.line1);
  TEST_ASSERT_TRUE(r.refusal.action == court::Action::Refuse);
  const char unknown[] = "{\"error\":\"not_recognised\"}";
  r = bridgelogic::onExtendResponse(400U, unknown, len(unknown));
  TEST_ASSERT_TRUE(r.forgetsScan);

  // TOO LONG asks for another press on THIS scan.
  const char tooLong[] = "{\"error\":\"minutes_out_of_range\",\"max_minutes\":90}";
  r = bridgelogic::onExtendResponse(400U, tooLong, len(tooLong));
  TEST_ASSERT_TRUE(r.decided);
  TEST_ASSERT_TRUE(r.invitesPress);
  TEST_ASSERT_FALSE(r.forgetsScan);
  TEST_ASSERT_EQUAL_STRING("TOO LONG", r.refusal.line1);

  // An extend-specific error at a 5xx is not read: a server fault is no verdict.
  const char notLit[] = "{\"error\":\"court_not_lit\"}";
  r = bridgelogic::onExtendResponse(500U, notLit, len(notLit));
  TEST_ASSERT_FALSE(r.decided);
  TEST_ASSERT_EQUAL_STRING("BUSY", r.refusal.line1);

  // A refusal never lights anything, whatever the walk-up would have done.
  const char odd[] = "{\"error\":\"something_new\"}";
  r = bridgelogic::onExtendResponse(400U, odd, len(odd));
  TEST_ASSERT_TRUE(r.refusal.action == court::Action::Refuse);
  TEST_ASSERT_FALSE(r.extended);
}

void test_plan_extension_caps_the_relay_and_holds_the_rest_for_relight() {
  // Forty-five minutes left plus thirty bought: seventy-five, inside the cap.
  bridgelogic::ExtendPlan plan = bridgelogic::planExtension(2700U, 30U);
  TEST_ASSERT_EQUAL_UINT32(4500U, plan.sessionSeconds);
  TEST_ASSERT_EQUAL_UINT32(4500U, plan.relaySeconds);

  // Exactly at the cap.
  plan = bridgelogic::planExtension(3600U, 30U);
  TEST_ASSERT_EQUAL_UINT32(5400U, plan.sessionSeconds);
  TEST_ASSERT_EQUAL_UINT32(5400U, plan.relaySeconds);

  // Past it: the relay gets ninety minutes and the WHOLE session is what
  // Relight holds the court to, so it is re-lit before the cap runs out.
  plan = bridgelogic::planExtension(3600U, 60U);
  TEST_ASSERT_EQUAL_UINT32(7200U, plan.sessionSeconds);
  TEST_ASSERT_EQUAL_UINT32(static_cast<uint32_t>(proto::kRelayHardCapSeconds), plan.relaySeconds);

  // A court whose relay this half believes dark (the `!STATE` has not caught
  // up): the extension alone.
  plan = bridgelogic::planExtension(0U, 15U);
  TEST_ASSERT_EQUAL_UINT32(900U, plan.sessionSeconds);
  TEST_ASSERT_EQUAL_UINT32(900U, plan.relaySeconds);

  // Never a zero-second `!EXT`: the wire's floor is one second.
  plan = bridgelogic::planExtension(0U, 0U);
  TEST_ASSERT_EQUAL_UINT32(0U, plan.sessionSeconds);
  TEST_ASSERT_EQUAL_UINT32(1U, plan.relaySeconds);

  // Saturates rather than wrapping, at both multiplications.
  plan = bridgelogic::planExtension(UINT32_MAX - 10U, 90U);
  TEST_ASSERT_EQUAL_UINT32(UINT32_MAX, plan.sessionSeconds);
  TEST_ASSERT_EQUAL_UINT32(5400U, plan.relaySeconds);
  plan = bridgelogic::planExtension(100U, UINT32_MAX / 10U);
  TEST_ASSERT_EQUAL_UINT32(UINT32_MAX, plan.sessionSeconds);
  TEST_ASSERT_EQUAL_UINT32(5400U, plan.relaySeconds);

  // And Relight, armed the way the bridge arms it for an extension past the
  // cap, re-lights for what is left once the relay deadline comes due.
  bridgelogic::Relight relight;
  court::Outcome session;
  session.action = court::Action::TurnOn;
  session.court = 1U;
  session.recognised = true;
  session.durationMs = 3600U * 1000U; // what the relay had before
  plan = bridgelogic::planExtension(3600U, 60U);
  session.bookingRemainingMs = plan.sessionSeconds * 1000U;
  relight.onGrant(session, kBaseMid);
  relight.extended(1U, plan.relaySeconds, kBaseMid);
  TEST_ASSERT_TRUE(relight.tracking(1U));
  TEST_ASSERT_EQUAL_UINT32(7200U * 1000U, relight.bookingRemainingMs(1U, kBaseMid));
  TEST_ASSERT_FALSE(relight.check(1U, kBaseMid + 1000U).due);
  const uint32_t due = kBaseMid + (5400U * 1000U) - bridgelogic::kExtLeadMs;
  const bridgelogic::Extension ext = relight.check(1U, due);
  TEST_ASSERT_TRUE(ext.due);
  TEST_ASSERT_EQUAL_UINT32(1800U + (bridgelogic::kExtLeadMs / 1000U), ext.seconds);
  // A court not tracked has no booking past its relay.
  TEST_ASSERT_EQUAL_UINT32(0U, relight.bookingRemainingMs(0U, kBaseMid));
  TEST_ASSERT_EQUAL_UINT32(0U, relight.bookingRemainingMs(9U, kBaseMid));
}

void test_a_known_member_with_nothing_booked_is_invited_to_walk_up() {
  // no_booking and ended: a recognised member with nothing to light. The glass
  // follows the greeting with PICK A COURT / THEN A TIME rather than sending
  // them to the desk.
  const bridgelogic::ScanFlow flow;
  const char noBooking[] = "{\"activated\":false,\"reason\":\"no_booking\",\"granted_seconds\":0}";
  bridgelogic::ActivationResult r =
      flow.onActivateResponse(200U, noBooking, len(noBooking), kCourts, kCourtCount);
  TEST_ASSERT_TRUE(r.invitesWalkUp);
  TEST_ASSERT_TRUE(r.outcome.recognised);

  loadHttpCorpus();
  char body[512] = {};
  const size_t n = bodyOf(responseVector("activate-response-ended"), body, sizeof(body));
  r = flow.onActivateResponse(200U, body, n, kCorpusCourts, devlink::kMaxCourts);
  TEST_ASSERT_TRUE(r.invitesWalkUp);

  // Not for a refusal with something to say — TOO EARLY names the wait — and
  // not for a grant.
  const size_t early = bodyOf(responseVector("activate-response-too-early"), body, sizeof(body));
  r = flow.onActivateResponse(200U, body, early, kCorpusCourts, devlink::kMaxCourts);
  TEST_ASSERT_FALSE(r.invitesWalkUp);
  const size_t ok = bodyOf(responseVector("activate-response-ok"), body, sizeof(body));
  r = flow.onActivateResponse(200U, body, ok, kCorpusCourts, devlink::kMaxCourts);
  TEST_ASSERT_FALSE(r.invitesWalkUp);
  // A reason nested in a decoy object is not the answer.
  const char decoy[] =
      "{\"activated\":false,\"detail\":{\"reason\":\"no_booking\"},\"reason\":\"code_used\"}";
  r = flow.onActivateResponse(200U, decoy, len(decoy), kCourts, kCourtCount);
  TEST_ASSERT_FALSE(r.invitesWalkUp);
}

// --- v3 (device-api.md §2-§9, §12): every v3 http vector, by id --------------

devlink::HeartbeatV3 v3Base() {
  devlink::HeartbeatV3 v;
  v.caps = devlink::kCapCodes | devlink::kCapHb3 | devlink::kCapOta | devlink::kCapKey | devlink::kCapNet |
           devlink::kCapLcd2;
  return v;
}

void expectHeartbeat(const char* id, const char* version, uint64_t uptime, const devlink::RelayState* state,
                     uint8_t stateCount, bool stateKnown, const devlink::HeartbeatV3& v3) {
  char expected[devlink::kHeartbeatBodyCap] = {};
  const size_t n = bodyOf(requestVector(id), expected, sizeof(expected));
  devlink::HeartbeatReport report;
  report.relayState = stateKnown ? state : nullptr;
  report.relayStateCount = stateCount;
  report.v3 = &v3;
  static char rendered[devlink::kHeartbeatBodyCap] = {};
  const size_t len =
      devlink::renderHeartbeatBody(rendered, sizeof(rendered), corpusMac(), version, uptime, report);
  TEST_ASSERT_EQUAL_STRING_MESSAGE(expected, rendered, id);
  TEST_ASSERT_EQUAL_size_t_MESSAGE(n, len, id);
}

void test_corpus_v3_heartbeat_requests_render_byte_for_byte() {
  loadHttpCorpus();
  const devlink::RelayState two[2] = {{0U, 1834U}, {2U, 600U}};
  {
    devlink::HeartbeatV3 v = v3Base();
    v.megaVersion = "3.0.0";
    v.fwState = "committed";
    v.netReported = true;
    v.netVer = 4U;
    v.netSrc = "server";
    v.lcdLayout = "compact";
    expectHeartbeat("v3-heartbeat-request", "3.0.0", 86400000ULL, two, 2U, true, v);
  }
  {
    // First beat: no !STATE yet this Mega boot, so relay_state is ABSENT,
    // never [] (BR-12); no Mega heard, so no mega_version and no lcd_layout.
    devlink::HeartbeatV3 v = v3Base();
    v.fwState = "probation";
    v.netReported = true;
    v.netVer = 4U;
    v.netSrc = "server";
    v.restore = "warm";
    expectHeartbeat("v3-heartbeat-request-first-beat", "3.0.0", 86400000ULL, nullptr, 0U, false, v);
  }
  {
    devlink::HeartbeatV3 v = v3Base();
    v.megaVersion = "3.0.0";
    v.fwState = "rolled_back";
    v.fwFailed = "3.0.1";
    v.fwError = "probation";
    v.netReported = true;
    v.netVer = 4U;
    v.netSrc = "server";
    v.lcdLayout = "compact";
    expectHeartbeat("v3-heartbeat-request-rolled-back", "3.0.0", 86400000ULL, two, 0U, true, v);
  }
  {
    const devlink::RelayState one[1] = {{0U, 2640U}};
    devlink::RelightEntry relight[1];
    relight[0].relay = 0U;
    strcpy(relight[0].ref, "3fa85f64");
    devlink::HeartbeatV3 v = v3Base();
    v.megaVersion = "3.0.0";
    v.fwState = "committed";
    v.netReported = true;
    v.netVer = 0U;
    v.netSrc = "local";
    v.lcdLayout = "expanded";
    v.relight = relight;
    v.relightCount = 1U;
    expectHeartbeat("v3-heartbeat-request-relight", "3.0.0", 86400000ULL, one, 1U, true, v);
  }
  {
    devlink::MegaReport mega;
    mega.reset = 0x08U;
    mega.lcd = 0x27U;
    mega.relayLow = false;
    mega.scanBaud = 9600U;
    mega.scanCrlf = false;
    mega.keys = 0x0FU;
    const uint16_t counters[5] = {3U, 1U, 0U, 2U, 0U};
    memcpy(mega.counters, counters, sizeof(counters));
    devlink::DiagReport diag;
    diag.reset = "soft_wdt";
    diag.heap = 21504U;
    diag.heapMin = 17800U;
    diag.block = 11200U;
    diag.stackMin = 712U;
    diag.sketchFree = 1019904U;
    diag.flashMb = 4U;
    devlink::HeartbeatV3 v = v3Base();
    v.megaVersion = "3.0.0";
    v.fwState = "committed";
    v.netReported = true;
    v.netVer = 4U;
    v.netSrc = "server";
    v.lcdLayout = "compact";
    v.mega = &mega;
    v.diag = &diag;
    expectHeartbeat("v3-heartbeat-request-telemetry", "3.0.0", 86400000ULL, two, 2U, true, v);
  }
  {
    const devlink::RelayState four[4] = {{0U, 5400U}, {1U, 5400U}, {2U, 5400U}, {3U, 5400U}};
    devlink::RelightEntry relight[4];
    for (uint8_t i = 0U; i < 4U; ++i) {
      relight[i].relay = i;
      strcpy(relight[i].ref, "ffffffff");
    }
    devlink::MegaReport mega;
    mega.reset = 0xFFU;
    mega.lcd = 0x3FU;
    mega.scanBaud = 115200U;
    mega.scanCrlf = true;
    mega.keys = 0xFFU;
    for (uint8_t i = 0U; i < 5U; ++i) {
      mega.counters[i] = 65535U;
    }
    devlink::DiagReport diag;
    diag.reset = "exception";
    diag.exc = 4294967295UL;
    diag.epc1 = 4294967295UL;
    diag.heap = 81920U;
    diag.heapMin = 81920U;
    diag.block = 81920U;
    diag.stackMin = 65535U;
    diag.sketchFree = 16777216UL;
    diag.flashMb = 16U;
    const char* const drift[8] = {"config.hw_scanner_line_end",
                                  "config.relay_reconcile_min_seconds",
                                  "config.lcd_after_lights_on_seconds",
                                  "config.device_power_restore_trust_minutes",
                                  "config.device_net_fallback_minutes",
                                  "config.device_ota_probation_minutes",
                                  "config.relay_authorisation_cap_minutes",
                                  "code_days"};
    devlink::HeartbeatV3 v = v3Base();
    v.megaVersion = "999.999.999";
    v.fwState = "rolled_back";
    v.fwFailed = "999.999.999";
    v.fwError = "probation";
    v.netReported = true;
    v.netVer = 2147483647UL;
    v.netSrc = "compiled";
    v.lcdLayout = "expanded";
    v.restore = "warm";
    v.relight = relight;
    v.relightCount = 4U;
    v.mega = &mega;
    v.diag = &diag;
    v.drift = drift;
    v.driftCount = 8U;
    expectHeartbeat("v3-heartbeat-request-widest", "999.999.999", 4294967295ULL, four, 4U, true, v);
  }
}

void test_corpus_v3_a_release_says_why_the_relay_opened() {
  loadHttpCorpus();
  char expected[512] = {};
  const size_t n = bodyOf(requestVector("v3-events-request-release-cause"), expected, sizeof(expected));
  eventq::Event e;
  e.seq = 42U;
  e.uptimeMs = 86490000UL;
  e.kind = eventq::Kind::Release;
  e.court = 1U;
  e.durationMs = 1260000UL;
  e.cause = eventq::Cause::MegaReset;
  char rendered[devlink::kEventBodyCap] = {};
  const size_t len =
      devlink::renderEventBody(rendered, sizeof(rendered), corpusMac(), 2596069104UL, 86500000ULL, e);
  TEST_ASSERT_EQUAL_STRING(expected, rendered);
  TEST_ASSERT_EQUAL_size_t(n, len);
  // A 2.x-shaped release (no cause) is byte-for-byte what it was.
  e.cause = eventq::Cause::None;
  TEST_ASSERT_NULL(strstr(rendered + 0, "\"cause\":\"member\""));
  const size_t plain =
      devlink::renderEventBody(rendered, sizeof(rendered), corpusMac(), 2596069104UL, 86500000ULL, e);
  TEST_ASSERT_NULL(strstr(rendered, "cause"));
  TEST_ASSERT_TRUE(plain < len);
}

static char g_v3Body[bridgelogic::kHeartbeatResponseCap + 1U] = {};

size_t v3Response(const char* id) {
  return bodyOf(responseVector(id), g_v3Body, sizeof(g_v3Body));
}

void expectSnapshotOfTheFourCourts(const bridgelogic::Snapshot& snap) {
  TEST_ASSERT_TRUE(snap.valid);
  TEST_ASSERT_EQUAL_UINT8(4U, snap.count);
  TEST_ASSERT_TRUE(snap.courts[0].lit);
  TEST_ASSERT_EQUAL_UINT32(2700U, snap.courts[0].seconds);
  TEST_ASSERT_EQUAL_CHAR('b', snap.courts[0].kind);
  TEST_ASSERT_EQUAL_STRING("3fa85f64", snap.courts[0].ref);
  TEST_ASSERT_FALSE(snap.courts[1].lit);
  TEST_ASSERT_EQUAL_STRING("", snap.courts[1].ref);
  TEST_ASSERT_EQUAL_UINT32(7140U, snap.courts[2].seconds); // uncapped: past the 90-minute relay cap
  TEST_ASSERT_EQUAL_CHAR('e', snap.courts[2].kind);
  TEST_ASSERT_EQUAL_UINT8(3U, snap.courts[3].relay);
}

void expectCfg(const bridgelogic::MegaConfig& cfg, const char* key, uint16_t value) {
  TEST_ASSERT_EQUAL_UINT16_MESSAGE(value, bridgelogic::cfgValue(cfg, key, 0xFFFFU), key);
}

void test_corpus_v3_the_snapshot_and_its_settings_are_read_from_config_only() {
  loadHttpCorpus();
  size_t n = v3Response("v3-heartbeat-response-snapshot");
  TEST_ASSERT_TRUE(devapi::json::isCompleteObject(g_v3Body, n));
  bridgelogic::Snapshot snap;
  TEST_ASSERT_TRUE(bridgelogic::readSnapshot(g_v3Body, n, snap, 1000U) == bridgelogic::ReadResult::Adopted);
  expectSnapshotOfTheFourCourts(snap);
  bridgelogic::Drift drift;
  bridgelogic::MegaConfig cfg;
  bridgelogic::readMegaConfig(g_v3Body, n, bridgelogic::defaultMegaConfig(), cfg, drift);
  expectCfg(cfg, "LAYOUT", 0U);
  expectCfg(cfg, "MARQ", 1U);
  expectCfg(cfg, "STEP", 400U);
  expectCfg(cfg, "CEIL", 60U);
  expectCfg(cfg, "CAP", 240U);
  expectCfg(cfg, "SCANH", 10U);
  TEST_ASSERT_EQUAL_UINT8(0U, drift.count);
  // The hardware keys come first: in force before any relay frame (HW-1).
  TEST_ASSERT_EQUAL_STRING("RPOL", cfg.items[0].key);

  // An unacknowledged box gets no `courts` key: no opinion, nothing changes.
  n = v3Response("v3-heartbeat-response-unacknowledged");
  bridgelogic::Snapshot kept = snap;
  TEST_ASSERT_TRUE(bridgelogic::readSnapshot(g_v3Body, n, kept, 2000U) == bridgelogic::ReadResult::Absent);
  TEST_ASSERT_EQUAL_UINT32(1000U, kept.atMs);
}

void test_corpus_v3_display_and_hardware_settings_clamp_independently() {
  loadHttpCorpus();
  size_t n = v3Response("v3-heartbeat-response-display-expanded");
  bridgelogic::Drift drift;
  bridgelogic::MegaConfig cfg;
  bridgelogic::readMegaConfig(g_v3Body, n, bridgelogic::defaultMegaConfig(), cfg, drift);
  expectCfg(cfg, "LAYOUT", 1U);
  TEST_ASSERT_TRUE(cfg.expanded);
  expectCfg(cfg, "MARQ", 0U);
  expectCfg(cfg, "STEP", 250U);
  expectCfg(cfg, "PAGE", 15U);
  expectCfg(cfg, "CEIL", 15U);
  expectCfg(cfg, "DWELL", 10U);
  expectCfg(cfg, "AFTON", 5U);
  expectCfg(cfg, "REINIT", 600U);
  expectCfg(cfg, "CAP", 720U);
  expectCfg(cfg, "RPOL", 1U);
  expectCfg(cfg, "LCDA", 63U);
  expectCfg(cfg, "SBAUD", 5U);
  expectCfg(cfg, "SSUF", 1U);
  expectCfg(cfg, "SGAP", 90U);

  n = v3Response("v3-heartbeat-response-display-out-of-range");
  bridgelogic::MegaConfig before = cfg;
  drift.clear();
  bridgelogic::readMegaConfig(g_v3Body, n, before, cfg, drift);
  expectCfg(cfg, "LAYOUT", 0U); // unknown is compact
  expectCfg(cfg, "STEP", 250U);
  expectCfg(cfg, "PAGE", 15U);
  expectCfg(cfg, "CEIL", 120U);
  expectCfg(cfg, "DWELL", 10U);
  expectCfg(cfg, "AFTON", 5U);
  expectCfg(cfg, "REINIT", 30U);
  expectCfg(cfg, "CAP", 90U);
  // Unknown hardware values keep the current ones.
  expectCfg(cfg, "RPOL", 1U);
  expectCfg(cfg, "LCDA", 63U);
  expectCfg(cfg, "SBAUD", 5U);
  expectCfg(cfg, "SSUF", 1U);
  expectCfg(cfg, "SGAP", 50U);
  TEST_ASSERT_TRUE(drift.count >= 5U);

  n = v3Response("v3-heartbeat-response-hardware");
  drift.clear();
  bridgelogic::readMegaConfig(g_v3Body, n, bridgelogic::defaultMegaConfig(), cfg, drift);
  expectCfg(cfg, "RPOL", 1U);
  expectCfg(cfg, "LCDA", 63U);
  expectCfg(cfg, "SBAUD", 1U);
  expectCfg(cfg, "SSUF", 1U);
  expectCfg(cfg, "SGAP", 100U);
  TEST_ASSERT_EQUAL_UINT8(0U, drift.count);
}

void test_corpus_v3_lifeline_answers_still_carry_the_snapshot() {
  loadHttpCorpus();
  const char* const ids[3] = {"v3-heartbeat-response-ota-offer", "v3-heartbeat-response-key-next",
                              "v3-heartbeat-response-net"};
  const char* const objects[3] = {"ota", "key_next", "net"};
  for (uint8_t i = 0U; i < 3U; ++i) {
    const size_t n = v3Response(ids[i]);
    bridgelogic::Snapshot snap;
    TEST_ASSERT_TRUE_MESSAGE(
        bridgelogic::readSnapshot(g_v3Body, n, snap, 0U) == bridgelogic::ReadResult::Adopted, ids[i]);
    expectSnapshotOfTheFourCourts(snap);
    size_t objLen = 0U;
    TEST_ASSERT_TRUE_MESSAGE(
        devapi::json::findTopLevelObject(g_v3Body, n, objects[i], objLen) != devapi::json::kNotFound, ids[i]);
  }
  // A lifeline-only body is "no opinion" on the snapshot and the roster.
  const size_t n = v3Response("v3-heartbeat-response-lifeline-only");
  bridgelogic::Snapshot snap;
  snap.valid = true;
  snap.atMs = 77U;
  TEST_ASSERT_TRUE(bridgelogic::readSnapshot(g_v3Body, n, snap, 0U) == bridgelogic::ReadResult::Absent);
  TEST_ASSERT_EQUAL_UINT32(77U, snap.atMs);
  TEST_ASSERT_EQUAL(devapi::json::kNotFound, devapi::json::findTopLevelArray(g_v3Body, n, "roster"));
}

void test_corpus_v3_the_widest_answer_fits_the_buffer_and_is_read_whole() {
  loadHttpCorpus();
  const size_t n = v3Response("v3-heartbeat-response-widest");
  TEST_ASSERT_TRUE(n <= 4096U);
  TEST_ASSERT_TRUE(n < bridgelogic::kHeartbeatResponseCap);
  TEST_ASSERT_TRUE(devapi::json::isCompleteObject(g_v3Body, n));
  int16_t numbers[devlink::kMaxCourts] = {};
  uint8_t count = 0U;
  TEST_ASSERT_TRUE(devlink::parseCourtNumbers(g_v3Body, n, numbers, count));
  TEST_ASSERT_EQUAL_UINT8(4U, count);
}

void test_corpus_v3_activate_arms_relighting_from_the_uncapped_remainder() {
  // FSF-05: a 105-minute booking activated online went dark at minute 90.
  loadHttpCorpus();
  char body[512] = {};
  const size_t n = bodyOf(responseVector("v3-activate-response-play-remaining"), body, sizeof(body));
  const int16_t numbers[devlink::kMaxCourts] = {1, 2, 3, 4};
  bridgelogic::ScanFlow flow;
  const bridgelogic::ActivationResult r = flow.onActivateResponse(200U, body, n, numbers, 4U);
  TEST_ASSERT_FALSE(r.fallbackToRoster);
  TEST_ASSERT_EQUAL_UINT32(6300U, r.playRemainingSeconds);
  // FC-4: a 201 is a decision too.
  const bridgelogic::ActivationResult r201 = flow.onActivateResponse(201U, body, n, numbers, 4U);
  TEST_ASSERT_FALSE(r201.fallbackToRoster);
}

void test_v3_keys_mask_follows_the_button_map() {
  court::ButtonMap map;
  TEST_ASSERT_EQUAL_UINT8(0x0FU, bridgelogic::keysFromButtonMap(map));
  const char* const wires[8] = {"court:A",    "court:B", "minutes:15", "court:D",
                                "minutes:15", "off",     "minutes:45", "court:C"};
  for (uint8_t i = 0U; i < 8U; ++i) {
    TEST_ASSERT_TRUE(map.setFromWire(i, wires[i]));
  }
  TEST_ASSERT_EQUAL_UINT8(0xABU, bridgelogic::keysFromButtonMap(map));
}

} // namespace

void setUp() {
}

void tearDown() {
}

// FC-11 (box half): a fraction or an exponent in a Mega setting is drift, and
// the setting keeps its value. 3.0.0 read `60.5` as 60 and said nothing — the
// replay check's fraction mutation found it.
void test_a_fraction_or_exponent_in_a_mega_setting_is_drift_and_keeps_the_value() {
  static const char* const kBodies[] = {
      "{\"config\":{\"lcd_reinit_seconds\":120.5,\"lcd_landing_page_seconds\":9}}",
      "{\"config\":{\"lcd_reinit_seconds\":1.2e2,\"lcd_landing_page_seconds\":9}}",
      "{\"config\":{\"lcd_reinit_seconds\":\"120\",\"lcd_landing_page_seconds\":9}}",
  };
  for (const char* body : kBodies) {
    bridgelogic::Drift drift;
    bridgelogic::MegaConfig cfg;
    bridgelogic::readMegaConfig(body, strlen(body), bridgelogic::defaultMegaConfig(), cfg, drift);
    expectCfg(cfg, "REINIT", 60U); // the boot default, kept
    expectCfg(cfg, "PAGE", 9U);    // its neighbour adopted
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(1U, drift.count, body);
    TEST_ASSERT_EQUAL_STRING_MESSAGE("config.lcd_reinit_seconds", drift.names[0], body);
  }
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_corpus_v3_heartbeat_requests_render_byte_for_byte);
  RUN_TEST(test_corpus_v3_a_release_says_why_the_relay_opened);
  RUN_TEST(test_corpus_v3_the_snapshot_and_its_settings_are_read_from_config_only);
  RUN_TEST(test_corpus_v3_display_and_hardware_settings_clamp_independently);
  RUN_TEST(test_a_fraction_or_exponent_in_a_mega_setting_is_drift_and_keeps_the_value);
  RUN_TEST(test_corpus_v3_lifeline_answers_still_carry_the_snapshot);
  RUN_TEST(test_corpus_v3_the_widest_answer_fits_the_buffer_and_is_read_whole);
  RUN_TEST(test_corpus_v3_activate_arms_relighting_from_the_uncapped_remainder);
  RUN_TEST(test_v3_keys_mask_follows_the_button_map);

  RUN_TEST(test_a_late_arrival_is_granted_what_is_left_not_what_was_booked);
  RUN_TEST(test_a_grant_never_exceeds_the_relay_cap);

  RUN_TEST(test_roster_decides_for_a_shared_scanner_by_court_count);
  RUN_TEST(test_session_lights_the_court_the_booking_names_not_the_one_it_was_handed);
  RUN_TEST(test_session_a_refusal_that_matched_a_booking_carries_that_bookings_court);

  RUN_TEST(test_scan_flow_asks_the_api_only_when_the_answer_can_be_acted_on);
  RUN_TEST(test_scan_flow_a_grant_lights_the_relay_the_court_number_maps_to);
  RUN_TEST(test_scan_flow_display_clamps_a_grant_past_the_relay_cap);
  RUN_TEST(test_scan_flow_a_grant_with_no_seconds_in_it_is_no_decision);
  RUN_TEST(test_scan_flow_a_grant_on_a_court_this_box_does_not_drive_is_refused_not_retried);
  RUN_TEST(test_scan_flow_a_reason_that_names_a_later_key_does_not_hide_it);
  RUN_TEST(test_scan_flow_a_refusal_is_a_decision_the_roster_does_not_second_guess);
  RUN_TEST(test_scan_flow_no_answer_is_the_rosters_scan);
  RUN_TEST(test_scan_flow_renders_the_activate_body);
  RUN_TEST(test_display_minutes_never_promise_more_than_the_relay_gives);
  RUN_TEST(test_any_grant_spends_the_scan_whichever_path_lit_the_court);

  RUN_TEST(test_walkup_body_names_the_court_and_carries_the_nonce);
  RUN_TEST(test_walkup_nonce_is_reused_only_for_the_same_undecided_purchase);
  RUN_TEST(test_walkup_a_grant_and_a_replayed_grant_light_the_court_identically);
  RUN_TEST(test_walkup_every_refusal_reads_differently_and_says_whether_it_was_decided);
  RUN_TEST(test_walkup_a_closed_club_puts_its_opening_time_on_the_glass);
  RUN_TEST(test_walkup_a_refused_activation_does_not_say_the_court_is_busy);
  RUN_TEST(test_walkup_recognised_comes_from_the_body_never_from_the_status);
  RUN_TEST(test_walkup_forgets_the_scan_only_for_a_used_or_unknown_code);

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
  RUN_TEST(test_corpus_activate_body_is_byte_identical_to_the_contract);
  RUN_TEST(test_corpus_heartbeat_body_is_byte_identical_to_the_contract);
  RUN_TEST(test_corpus_the_bearer_header_is_the_one_the_contract_declares);
  RUN_TEST(test_corpus_walkup_body_is_byte_identical_to_the_contract);
  RUN_TEST(test_corpus_events_body_is_byte_identical_to_the_contract);
  RUN_TEST(test_corpus_roster_pushes_load_exactly_as_the_contract_declares_them);
  RUN_TEST(test_corpus_the_relay_restore_vectors_parse_exactly_as_declared);
  RUN_TEST(test_corpus_the_lcd_settings_are_adopted_and_clamped);
  RUN_TEST(test_corpus_the_heartbeat_report_fields_are_byte_identical_to_the_contract);
  RUN_TEST(test_corpus_member_display_names_the_member_or_greets_them_anyway);
  RUN_TEST(test_corpus_the_event_body_carries_this_boots_id);
  RUN_TEST(test_corpus_every_http_section_is_declared_and_every_vector_is_bound);
  RUN_TEST(test_corpus_activate_escapes_a_scan_the_mega_passed_through);
  RUN_TEST(test_corpus_walkup_escapes_a_scan_the_mega_passed_through);
  RUN_TEST(test_corpus_event_escapes_a_subject_the_mega_passed_through);
  RUN_TEST(test_the_scan_bodies_fit_the_worst_scan_in_the_bridges_own_buffers);
  RUN_TEST(test_the_scan_bodies_hold_their_shape_whatever_was_scanned);

  RUN_TEST(test_scan_flow_a_box_with_no_court_list_is_not_online);
  RUN_TEST(test_scan_flow_an_open_breaker_is_the_rosters_scan);
  RUN_TEST(test_scan_flow_a_zero_second_grant_is_a_refusal_not_a_pulse);
  RUN_TEST(test_scan_flow_recognised_is_every_verdict_about_a_known_member);
  RUN_TEST(test_a_used_code_answered_online_arms_nothing_and_cannot_buy);
  RUN_TEST(test_an_activation_waits_on_its_own_words_never_buying_your_time);
  RUN_TEST(test_scan_flow_a_grant_carries_the_uncapped_booking_remainder);
  RUN_TEST(test_auth_policy_a_refused_scan_cannot_release_any_court);
  RUN_TEST(test_auth_policy_an_undecided_answer_keeps_press_again_working_for_the_whole_choice_window);
  RUN_TEST(test_scan_memory_remembers_a_scan_for_the_tenant_scan_memory);
  RUN_TEST(test_scan_memory_a_quote_after_a_busy_hold_keeps_the_scan_for_its_whole_countdown);
  RUN_TEST(test_scan_memory_a_quote_never_shortens_the_scan);
  RUN_TEST(test_scan_memory_a_scan_that_lapsed_during_the_call_is_still_held);
  RUN_TEST(test_scan_memory_repeated_holds_never_pass_the_server_bound);
  RUN_TEST(test_scan_memory_shorter_settings_bring_a_held_scan_inside_the_new_bound);
  RUN_TEST(test_scan_again_names_a_rescan_never_a_press);
  RUN_TEST(test_walk_up_only_too_long_invites_another_press);
  RUN_TEST(test_pay_for_only_price_changed_invites_another_press);
  RUN_TEST(test_a_court_press_invitation_never_outlives_the_scan);
  RUN_TEST(test_a_screen_stages_every_row_including_the_empty_ones);
  RUN_TEST(test_auth_policy_a_recognised_refusal_arms_for_a_walk_up_but_releases_nothing);
  RUN_TEST(test_auth_policy_the_member_whose_scan_lit_b_can_release_b_and_only_b);
  RUN_TEST(test_session_and_walkup_say_whether_the_scan_was_recognised);
  RUN_TEST(test_relight_extends_a_booking_longer_than_the_cap_before_the_cap_runs_out);
  RUN_TEST(test_relight_a_three_hour_booking_needs_two_extensions_each_capped);
  RUN_TEST(test_relight_forgets_a_court_on_release_and_a_grant_inside_the_cap);
  RUN_TEST(test_on_retry_resends_the_last_on_once_and_only_inside_the_window);
  RUN_TEST(test_on_retry_keeps_an_ext_too_and_a_lost_one_is_sent_again);
  RUN_TEST(test_on_retry_a_release_on_another_court_keeps_this_courts_retry);
  RUN_TEST(test_on_retry_a_non_relay_frame_clears_the_memory_rather_than_skipping_it);
  RUN_TEST(test_on_retry_an_off_for_b_after_an_on_for_a_replays_neither);
  RUN_TEST(test_on_retry_a_badcrc_after_a_non_relay_frame_never_moves_a_relay_deadline);
  RUN_TEST(test_a_refused_ext_releases_the_court_instead_of_reading_as_a_lost_frame);
  RUN_TEST(test_a_refused_ext_on_a_dark_court_is_sent_exactly_once);
  RUN_TEST(test_a_badarg_with_no_ext_remembered_is_not_a_release);
  RUN_TEST(test_activate_reads_every_field_it_acts_on_from_the_top_level);
  RUN_TEST(test_walkup_reads_every_field_it_acts_on_from_the_top_level);
  RUN_TEST(test_the_flat_scan_is_kept_where_it_is_genuinely_wanted);
  RUN_TEST(test_this_boot_has_an_identity_and_it_is_never_the_wires_absent_value);
  RUN_TEST(test_server_time_is_read_as_club_local_wall_time_or_refused);
  RUN_TEST(test_the_clock_advances_between_heartbeats_and_wraps_at_midnight);
  RUN_TEST(test_a_clock_adopted_before_the_millis_wrap_never_reads_trusted_again);
  RUN_TEST(test_a_lengthened_trust_window_still_restores_a_recently_adopted_clock);
  RUN_TEST(test_a_clock_nobody_has_confirmed_for_too_long_blanks_rather_than_lies);
  RUN_TEST(test_every_screen_holds_the_layout_contract);
  RUN_TEST(test_a_sixteen_character_name_still_fits_the_panel);
  RUN_TEST(test_the_screens_say_what_the_table_says_they_say);
  RUN_TEST(test_a_row_that_would_name_a_time_blanks_when_the_clock_is_not_trusted);
  RUN_TEST(test_the_action_row_is_the_live_panel_and_never_a_hardcoded_one);
  RUN_TEST(test_member_display_is_read_tolerantly_and_never_truncated);
  RUN_TEST(test_relight_adopts_the_megas_remaining_seconds_so_a_lost_ext_is_re_sent);
  RUN_TEST(test_state_seconds_parse_decimal_and_refuse_everything_else);
  RUN_TEST(test_a_rescan_on_a_court_this_box_already_lit_is_not_a_second_grant);
  RUN_TEST(test_the_identity_screen_is_repainted_on_the_first_pong_and_after_a_mega_reset);
  RUN_TEST(test_a_heartbeat_response_ignores_every_key_this_build_does_not_read);
  RUN_TEST(test_the_uplink_decoder_keeps_every_mega_frame_around_the_noise);
  RUN_TEST(test_the_bridge_2_3_screens_say_what_the_spec_says);
  RUN_TEST(test_read_greeting_is_tolerant_of_absence_and_shapes_the_name_for_the_glass);
  RUN_TEST(test_corpus_activate_greeting_greets_by_name_and_balance);
  RUN_TEST(test_a_balance_the_glass_cannot_hold_is_not_stated_at_all);
  RUN_TEST(test_corpus_extend_body_is_byte_identical_to_the_contract);
  RUN_TEST(test_extend_body_ages_a_member_code_escapes_a_scan_and_refuses_what_does_not_fit);
  RUN_TEST(test_corpus_extend_answers_mean_what_the_contract_says);
  RUN_TEST(test_extend_never_happens_offline_and_an_unreadable_grant_is_undecided);
  RUN_TEST(test_extend_borrows_the_walk_ups_words_and_its_scan_rules);
  RUN_TEST(test_plan_extension_caps_the_relay_and_holds_the_rest_for_relight);
  RUN_TEST(test_a_known_member_with_nothing_booked_is_invited_to_walk_up);

  return UNITY_END();
}

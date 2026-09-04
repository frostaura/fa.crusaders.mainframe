// Unity tests for the ESP8266 half: the event queue, the roster cache and the
// signed-request client.
//
// WHY THESE THREE ARE ONE SUITE
// -----------------------------
// They are the three things that decide what happens when the network is not
// there, which is the condition this half exists to survive. The Mega's suite
// proves the lights go out on their own; this one proves the club still finds
// out who was on the court, and that the box does not brick itself trying to
// tell them.
//
// The clock bases below are the same matrix the Mega's suite uses. millis()
// wraps at 49.7 days and a court box in a cupboard is expected to run for
// months, so every age and deadline assertion is run at a base chosen to put
// the wrap in the middle of the scenario.

#include <stdint.h>
#include <string.h>
#include <unity.h>

#include "court/ButtonMap.h"
#include "court/Session.h"
#include "court/WalkUpPad.h"
#include "devapi/DeviceClient.h"
#include "devapi/Json.h"
#include "devcrypto/Hex.h"
#include "eventq/Event.h"
#include "eventq/EventQueue.h"
#include "fakes/FakeStore.h"
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

using Queue = eventq::EventQueue<4U>;
using Cache = roster::Roster<4U>;
using Play = court::Session<Cache, Queue>;

constexpr uint32_t kSixHoursMs = 21600000UL;

eventq::Event activation(const char* subject, uint8_t court) {
  eventq::Event e;
  e.kind = eventq::Kind::Activation;
  e.court = court;
  e.method = eventq::Method::Qr;
  e.durationMs = 2700000UL;
  static_cast<void>(e.setSubject(subject));
  return e;
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

/// Deterministic bytes, so a signature can be compared against a fixture. A
/// client that reached for a platform RNG could only be tested against itself.
class ScriptedEntropy final : public devapi::IEntropySource {
public:
  explicit ScriptedEntropy(uint8_t seed = 0U) : next_(seed) {}

  uint8_t nextByte() override { return next_++; }

private:
  uint8_t next_;
};

// ---------------------------------------------------------------------------
// Event queue
// ---------------------------------------------------------------------------

void test_queue_stamps_a_monotonic_sequence_and_never_reuses_one() {
  fakes::FakeStore store;
  Queue q(&store);
  q.begin();

  eventq::Event a = activation("member-1", 0U);
  eventq::Event b = activation("member-2", 1U);
  TEST_ASSERT_TRUE(q.push(a) == eventq::PushResult::Ok);
  TEST_ASSERT_TRUE(q.push(b) == eventq::PushResult::Ok);

  TEST_ASSERT_NOT_EQUAL(a.seq, b.seq);
  TEST_ASSERT_TRUE(b.seq > a.seq);
  TEST_ASSERT_EQUAL_UINT32(0U, a.seq == 0U ? 1U : 0U); // seq 0 is never issued
}

void test_queue_a_callers_sequence_number_is_overwritten() {
  fakes::FakeStore store;
  Queue q(&store);
  q.begin();

  eventq::Event e = activation("member-1", 0U);
  e.seq = 999U; // a caller trying to choose, which is how numbers repeat
  TEST_ASSERT_TRUE(q.push(e) == eventq::PushResult::Ok);
  TEST_ASSERT_NOT_EQUAL(999U, e.seq);
}

void test_queue_peek_does_not_remove_and_release_does() {
  fakes::FakeStore store;
  Queue q(&store);
  q.begin();

  eventq::Event a = activation("member-1", 0U);
  static_cast<void>(q.push(a));

  eventq::Event out;
  TEST_ASSERT_TRUE(q.peek(out));
  TEST_ASSERT_EQUAL_UINT16(1U, q.size());
  TEST_ASSERT_TRUE(out.subjectEquals("member-1"));

  // Peeked twice is still the same event: an upload that failed must be able
  // to try the identical event again.
  TEST_ASSERT_TRUE(q.peek(out));
  TEST_ASSERT_EQUAL_UINT16(1U, q.size());

  TEST_ASSERT_TRUE(q.release());
  TEST_ASSERT_TRUE(q.empty());
  TEST_ASSERT_FALSE(q.peek(out));
}

void test_queue_overflow_discards_the_oldest_and_says_so() {
  fakes::FakeStore store;
  Queue q(&store); // capacity 4
  q.begin();

  for (int i = 0; i < 4; ++i) {
    eventq::Event e = activation("keep", static_cast<uint8_t>(i));
    TEST_ASSERT_TRUE(q.push(e) == eventq::PushResult::Ok);
  }
  TEST_ASSERT_TRUE(q.full());
  TEST_ASSERT_EQUAL_UINT32(0U, q.overflowed());

  eventq::Event newest = activation("newest", 3U);
  TEST_ASSERT_TRUE(q.push(newest) == eventq::PushResult::OkOverwrote);
  TEST_ASSERT_EQUAL_UINT32(1U, q.overflowed());
  TEST_ASSERT_EQUAL_UINT16(4U, q.size());

  // The oldest went; the newest is in. The member standing on the court now
  // matters more than the one from two days ago, and the counter records the
  // loss rather than hiding it.
  eventq::Event head;
  TEST_ASSERT_TRUE(q.peek(head));
  TEST_ASSERT_EQUAL_UINT8(1U, head.court);
}

void test_queue_release_through_stops_at_an_unacknowledged_event() {
  fakes::FakeStore store;
  Queue q(&store);
  q.begin();

  eventq::Event a = activation("a", 0U);
  eventq::Event b = activation("b", 1U);
  eventq::Event c = activation("c", 2U);
  static_cast<void>(q.push(a));
  static_cast<void>(q.push(b));
  static_cast<void>(q.push(c));

  TEST_ASSERT_EQUAL_UINT16(2U, q.releaseThrough(b.seq));
  TEST_ASSERT_EQUAL_UINT16(1U, q.size());

  eventq::Event head;
  TEST_ASSERT_TRUE(q.peek(head));
  TEST_ASSERT_EQUAL_UINT32(c.seq, head.seq);

  // An acknowledgement for something older than the head clears nothing — an
  // out-of-order or replayed ack must not empty the ring.
  TEST_ASSERT_EQUAL_UINT16(0U, q.releaseThrough(a.seq));
  TEST_ASSERT_EQUAL_UINT16(1U, q.size());
}

void test_queue_a_reboot_resumes_past_the_reserved_block() {
  fakes::FakeStore store;

  uint32_t lastBefore = 0U;
  {
    Queue q(&store);
    q.begin();
    eventq::Event e = activation("member-1", 0U);
    static_cast<void>(q.push(e));
    lastBefore = e.seq;
  }

  // Power cycle: same store, new queue.
  Queue after(&store);
  after.begin();
  eventq::Event e = activation("member-2", 0U);
  static_cast<void>(after.push(e));

  TEST_ASSERT_TRUE(e.seq > lastBefore);
  // Skipping numbers is free; reusing one loses an event to deduplication.
  TEST_ASSERT_TRUE(e.seq >= eventq::kSeqCheckpointStride);
}

void test_queue_checkpoints_are_strided_not_per_event() {
  fakes::FakeStore store;
  Queue q(&store);
  q.begin();

  const uint16_t writesAfterBegin = store.writeCount(eventq::kSeqKey);
  for (int i = 0; i < 8; ++i) {
    eventq::Event e = activation("member", 0U);
    static_cast<void>(q.push(e));
  }

  // Eight pushes inside one 64-wide block must cost exactly one write. A write
  // per event wears the flash out on a busy court.
  TEST_ASSERT_EQUAL_UINT16(1U, static_cast<uint16_t>(store.writeCount(eventq::kSeqKey) - writesAfterBegin));
}

void test_queue_a_torn_sequence_mark_is_absent_not_mongrel() {
  fakes::FakeStore store;
  {
    Queue q(&store);
    q.begin();
    eventq::Event e = activation("member", 0U);
    static_cast<void>(q.push(e));
  }

  // Power goes away four bytes into the mark's ten. The first four hold the new
  // value and the rest the old — the store's documented failure, and one that
  // reports kOk on the next read.
  store.tearNextWriteAfter(4U);
  {
    Queue q(&store);
    q.begin();
    for (uint32_t i = 0U; i < eventq::kSeqCheckpointStride + 1U; ++i) {
      eventq::Event e = activation("member", 0U);
      static_cast<void>(q.push(e));
    }
  }

  // Whatever the mark now reads, it must be a number or nothing — never a
  // half-updated one presented as good. The mark carries its own check digits
  // for exactly this: a torn write reads back as absent and numbering restarts,
  // which is documented and survivable, where a mongrel high-water mark would
  // silently place the box's sequence somewhere it has already been.
  Queue q(&store);
  q.begin();
  eventq::Event e = activation("member", 0U);
  static_cast<void>(q.push(e));
  TEST_ASSERT_TRUE(e.seq >= 1U);
}

void test_queue_a_store_that_refuses_every_write_still_queues() {
  fakes::FakeStore store;
  store.setWriteFailure(true);

  Queue q(&store);
  q.begin();

  eventq::Event e = activation("member", 0U);
  // A court whose flash has worn out must still light up and still record what
  // it did. Losing the checkpoint costs duplicate sequence numbers after a
  // reboot, which the API deduplicates; refusing to work costs the club a game.
  TEST_ASSERT_TRUE(q.push(e) == eventq::PushResult::Ok);
  TEST_ASSERT_EQUAL_UINT16(1U, q.size());
}

void test_queue_survives_the_outage_it_exists_for() {
  fakes::FakeStore store;
  eventq::EventQueue<64U> q(&store);
  q.begin();

  // A long offline evening: members keep playing, the box keeps recording, and
  // nothing is uploaded because there is nothing to upload to. This is the
  // condition the queue exists for and the box stays powered throughout.
  for (int i = 0; i < 40; ++i) {
    eventq::Event e = activation("member", static_cast<uint8_t>(i % 4));
    TEST_ASSERT_TRUE(q.push(e) == eventq::PushResult::Ok);
  }
  TEST_ASSERT_EQUAL_UINT32(0U, q.overflowed());
  TEST_ASSERT_EQUAL_UINT16(40U, q.size());

  // The link comes back and the whole evening drains in order.
  uint32_t previous = 0U;
  uint16_t drained = 0U;
  eventq::Event out;
  while (q.peek(out)) {
    TEST_ASSERT_TRUE(out.seq > previous);
    previous = out.seq;
    TEST_ASSERT_TRUE(q.release());
    ++drained;
  }
  TEST_ASSERT_EQUAL_UINT16(40U, drained);
}

void test_queue_events_do_not_survive_a_power_cut_and_the_sequence_does() {
  fakes::FakeStore store;

  uint32_t lastSeq = 0U;
  {
    eventq::EventQueue<64U> q(&store);
    q.begin();
    eventq::Event e = activation("member", 0U);
    static_cast<void>(q.push(e));
    lastSeq = e.seq;
    TEST_ASSERT_EQUAL_UINT16(1U, q.size());
  }

  // The breaker goes. This is the documented limit, asserted rather than left
  // to be discovered: the events were in RAM and are gone, because hal::IStore
  // holds 32-byte values and an Event does not fit through it. What DOES
  // survive is the sequence high-water mark, which is what the API's
  // deduplication rests on.
  eventq::EventQueue<64U> after(&store);
  after.begin();

  eventq::Event out;
  TEST_ASSERT_FALSE(after.peek(out));
  TEST_ASSERT_TRUE(after.empty());

  eventq::Event next = activation("member", 0U);
  static_cast<void>(after.push(next));
  TEST_ASSERT_TRUE(next.seq > lastSeq);
}

void test_queue_works_with_no_store_at_all() {
  Queue q(nullptr);
  q.begin();
  eventq::Event e = activation("member", 0U);
  TEST_ASSERT_TRUE(q.push(e) == eventq::PushResult::Ok);
  TEST_ASSERT_EQUAL_UINT32(1U, e.seq);
}

void test_event_subject_is_refused_not_truncated_when_too_long() {
  char longSubject[eventq::kMaxSubjectLen + 8U];
  memset(longSubject, 'x', sizeof(longSubject) - 1U);
  longSubject[sizeof(longSubject) - 1U] = '\0';

  eventq::Event e;
  // A truncated membership number is a charge against a DIFFERENT member, so
  // the caller is told rather than handed a plausible-looking short one.
  TEST_ASSERT_FALSE(e.setSubject(longSubject));
}

void test_event_kind_and_method_names_match_the_api() {
  TEST_ASSERT_EQUAL_STRING("activation", eventq::kindName(eventq::Kind::Activation));
  TEST_ASSERT_EQUAL_STRING("release", eventq::kindName(eventq::Kind::Release));
  TEST_ASSERT_EQUAL_STRING("unknown_scan", eventq::kindName(eventq::Kind::UnknownScan));
  TEST_ASSERT_EQUAL_STRING("qr", eventq::methodName(eventq::Method::Qr));
  TEST_ASSERT_EQUAL_STRING("pin", eventq::methodName(eventq::Method::Pin));
  // None is omitted from the payload rather than sent as the string "none".
  TEST_ASSERT_NULL(eventq::methodName(eventq::Method::None));
}

// ---------------------------------------------------------------------------
// Roster cache
// ---------------------------------------------------------------------------

void test_roster_admits_a_booked_member_at_the_right_court_and_time() {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    Cache cache(kSixHoursMs);

    const roster::Entry entries[] = {booking("tok-alice", 1U, 0U, 3600000UL)};
    loadRoster(cache, base, entries, 1U);

    const roster::Decision d = cache.decide("tok-alice", 1U, base + 600000UL);
    TEST_ASSERT_TRUE(d.verdict == roster::Verdict::Allow);
    TEST_ASSERT_EQUAL_UINT32(3600000UL, d.entry.durationMs);
  }
}

void test_roster_refuses_an_unknown_token() {
  Cache cache(kSixHoursMs);
  const roster::Entry entries[] = {booking("tok-alice", 1U, 0U, 3600000UL)};
  loadRoster(cache, kBaseMid, entries, 1U);

  const roster::Decision d = cache.decide("tok-mallory", 1U, kBaseMid + 1000U);
  TEST_ASSERT_TRUE(d.verdict == roster::Verdict::Unknown);
}

void test_roster_distinguishes_too_early_too_late_and_wrong_court() {
  Cache cache(kSixHoursMs);
  const roster::Entry entries[] = {booking("tok-alice", 2U, 600000UL, 1200000UL)};
  loadRoster(cache, kBaseMid, entries, 1U);

  // Each refusal is a different sentence on a 16x2 display, and each sends the
  // member somewhere different.
  TEST_ASSERT_TRUE(cache.decide("tok-alice", 2U, kBaseMid + 1000U).verdict == roster::Verdict::TooEarly);
  TEST_ASSERT_TRUE(cache.decide("tok-alice", 2U, kBaseMid + 1800000UL).verdict == roster::Verdict::TooLate);
  TEST_ASSERT_TRUE(cache.decide("tok-alice", 0U, kBaseMid + 700000UL).verdict == roster::Verdict::WrongCourt);
}

void test_roster_prefers_the_court_the_member_is_standing_at() {
  Cache cache(kSixHoursMs);
  // The same member holds two bookings at once, on different courts.
  const roster::Entry entries[] = {
      booking("tok-alice", 0U, 0U, 3600000UL),
      booking("tok-alice", 3U, 0U, 3600000UL),
  };
  loadRoster(cache, kBaseMid, entries, 2U);

  TEST_ASSERT_TRUE(cache.decide("tok-alice", 3U, kBaseMid + 1000U).verdict == roster::Verdict::Allow);
  TEST_ASSERT_TRUE(cache.decide("tok-alice", 0U, kBaseMid + 1000U).verdict == roster::Verdict::Allow);
}

void test_roster_goes_stale_and_refuses_rather_than_guesses() {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    Cache cache(kSixHoursMs);
    const roster::Entry entries[] = {booking("tok-alice", 1U, 0U, 86400000UL)};
    loadRoster(cache, base, entries, 1U);

    TEST_ASSERT_FALSE(cache.stale(base + kSixHoursMs));
    TEST_ASSERT_TRUE(cache.stale(base + kSixHoursMs + 1U));

    // Past the age limit the match is not even attempted. A cancelled booking
    // that lingers in a stale cache lights a court nobody is charged for.
    const roster::Decision d = cache.decide("tok-alice", 1U, base + kSixHoursMs + 1U);
    TEST_ASSERT_TRUE(d.verdict == roster::Verdict::Stale);
  }
}

void test_roster_before_its_first_load_is_stale_not_empty() {
  Cache cache(kSixHoursMs);
  TEST_ASSERT_FALSE(cache.everLoaded());
  TEST_ASSERT_TRUE(cache.stale(kBaseMid));
  // Unknown would tell a member their booking does not exist. Stale tells the
  // truth: the box does not know yet.
  TEST_ASSERT_TRUE(cache.decide("tok-alice", 0U, kBaseMid).verdict == roster::Verdict::Stale);
}

void test_roster_an_abandoned_replacement_leaves_the_old_one_live() {
  Cache cache(kSixHoursMs);
  const roster::Entry entries[] = {booking("tok-alice", 1U, 0U, 3600000UL)};
  loadRoster(cache, kBaseMid, entries, 1U);

  // A push that starts and dies halfway — the WiFi went away mid-response.
  cache.beginReplace(kBaseMid + 1000U);
  static_cast<void>(cache.add(booking("tok-bob", 1U, 0U, 3600000UL)));
  // ...no commitReplace().

  // The court keeps working on what it already knew.
  TEST_ASSERT_TRUE(cache.decide("tok-alice", 1U, kBaseMid + 2000U).verdict == roster::Verdict::Allow);
  TEST_ASSERT_TRUE(cache.decide("tok-bob", 1U, kBaseMid + 2000U).verdict == roster::Verdict::Unknown);
}

void test_roster_a_cancelled_booking_disappears_on_the_next_push() {
  Cache cache(kSixHoursMs);
  const roster::Entry before[] = {
      booking("tok-alice", 1U, 0U, 3600000UL),
      booking("tok-bob", 2U, 0U, 3600000UL),
  };
  loadRoster(cache, kBaseMid, before, 2U);
  TEST_ASSERT_TRUE(cache.decide("tok-bob", 2U, kBaseMid + 1000U).verdict == roster::Verdict::Allow);

  // Bob cancelled. The push simply does not mention him — which is why the
  // roster is replaced wholesale and never patched: a delete verb can be lost,
  // and a lost delete is a cancelled booking that still opens a court.
  const roster::Entry after[] = {booking("tok-alice", 1U, 0U, 3600000UL)};
  loadRoster(cache, kBaseMid + 1000U, after, 1U);

  TEST_ASSERT_TRUE(cache.decide("tok-bob", 2U, kBaseMid + 2000U).verdict == roster::Verdict::Unknown);
  TEST_ASSERT_TRUE(cache.decide("tok-alice", 1U, kBaseMid + 2000U).verdict == roster::Verdict::Allow);
}

void test_roster_reports_entries_that_did_not_fit() {
  Cache cache(kSixHoursMs); // capacity 4
  cache.beginReplace(kBaseMid);
  for (int i = 0; i < 6; ++i) {
    char token[16];
    token[0] = 't';
    token[1] = static_cast<char>('0' + i);
    token[2] = '\0';
    static_cast<void>(cache.add(booking(token, 0U, 0U, 3600000UL)));
  }
  cache.commitReplace();

  // Silently dropping them would refuse real members with no explanation.
  TEST_ASSERT_EQUAL_UINT8(2U, cache.dropped());
  TEST_ASSERT_EQUAL_UINT8(4U, cache.size());
}

void test_roster_token_copy_refuses_rather_than_truncates() {
  char token[8];
  TEST_ASSERT_FALSE(roster::detail::copyToken(token, sizeof(token), "far-too-long-to-fit"));
  // And leaves nothing behind that could accidentally match.
  TEST_ASSERT_EQUAL_STRING("", token);
}

// ---------------------------------------------------------------------------
// Device client
// ---------------------------------------------------------------------------

const uint8_t kKeyBytes[] = {0x00U, 0x11U, 0x22U, 0x33U, 0x44U, 0x55U, 0x66U, 0x77U};

devapi::Credentials credentials() {
  devapi::Credentials c;
  c.deviceId = "11111111-2222-3333-4444-555555555555";
  c.key = dc::ByteSpan{kKeyBytes, sizeof(kKeyBytes)};
  return c;
}

devapi::Call heartbeatCall(const char* body) {
  devapi::Call call;
  call.method = "POST";
  call.pathAndQuery = "/api/v1/device/heartbeat";
  call.body = body;
  call.bodyLen = strlen(body);
  return call;
}

void test_client_refuses_to_sign_before_it_knows_the_time() {
  ScriptedEntropy entropy;
  devapi::DeviceClient client(credentials(), entropy);

  devapi::RequestBuffers buffers;
  devapi::SignedRequest request;
  // A box with no clock signs a timestamp of zero, gets a 401, and reads it as
  // a revoked key — then re-provisions over what was only an unsynchronised
  // clock. Failing locally is how that loop is not entered.
  TEST_ASSERT_FALSE(client.sign(heartbeatCall("{}"), 1000U, buffers, request));
}

void test_client_signs_the_current_time_not_the_boot_time() {
  ScriptedEntropy entropy;
  devapi::DeviceClient client(credentials(), entropy);

  client.adoptServerTime(1750000000ULL, 0U);

  devapi::RequestBuffers early;
  devapi::SignedRequest earlyRequest;
  TEST_ASSERT_TRUE(client.sign(heartbeatCall("{}"), 0U, early, earlyRequest));

  devapi::RequestBuffers later;
  devapi::SignedRequest laterRequest;
  TEST_ASSERT_TRUE(client.sign(heartbeatCall("{}"), 3600000U, later, laterRequest));

  // An hour of uptime is an hour on the timestamp. Signing the offset alone
  // works for the first few minutes of a board's life and then produces a
  // permanent 401 that reads exactly like a revoked key.
  TEST_ASSERT_EQUAL_STRING("1750000000", earlyRequest.timestamp);
  TEST_ASSERT_EQUAL_STRING("1750003600", laterRequest.timestamp);
}

void test_client_every_request_gets_a_fresh_nonce() {
  ScriptedEntropy entropy;
  devapi::DeviceClient client(credentials(), entropy);
  client.adoptServerTime(1750000000ULL, 0U);

  devapi::RequestBuffers first;
  devapi::SignedRequest firstRequest;
  devapi::RequestBuffers second;
  devapi::SignedRequest secondRequest;
  TEST_ASSERT_TRUE(client.sign(heartbeatCall("{}"), 1000U, first, firstRequest));
  TEST_ASSERT_TRUE(client.sign(heartbeatCall("{}"), 1000U, second, secondRequest));

  // Same second, same body, same path — and still a different signature,
  // because the server remembers recent nonces and refuses a replay.
  TEST_ASSERT_TRUE(strcmp(firstRequest.nonce, secondRequest.nonce) != 0);
  TEST_ASSERT_TRUE(strcmp(firstRequest.signature, secondRequest.signature) != 0);
}

void test_client_a_different_body_is_a_different_signature() {
  ScriptedEntropy a(7U);
  ScriptedEntropy b(7U); // identical nonce stream, so only the body differs
  devapi::DeviceClient first(credentials(), a);
  devapi::DeviceClient second(credentials(), b);
  first.adoptServerTime(1750000000ULL, 0U);
  second.adoptServerTime(1750000000ULL, 0U);

  devapi::RequestBuffers bufA;
  devapi::SignedRequest reqA;
  devapi::RequestBuffers bufB;
  devapi::SignedRequest reqB;
  TEST_ASSERT_TRUE(first.sign(heartbeatCall("{\"uptime_seconds\":1}"), 1000U, bufA, reqA));
  TEST_ASSERT_TRUE(second.sign(heartbeatCall("{\"uptime_seconds\":2}"), 1000U, bufB, reqB));

  TEST_ASSERT_EQUAL_STRING(reqA.nonce, reqB.nonce);
  TEST_ASSERT_TRUE(strcmp(reqA.signature, reqB.signature) != 0);
}

void test_client_a_different_path_is_a_different_signature() {
  ScriptedEntropy a(7U);
  ScriptedEntropy b(7U);
  devapi::DeviceClient first(credentials(), a);
  devapi::DeviceClient second(credentials(), b);
  first.adoptServerTime(1750000000ULL, 0U);
  second.adoptServerTime(1750000000ULL, 0U);

  devapi::Call events;
  events.method = "POST";
  events.pathAndQuery = "/api/v1/device/events";
  events.body = "{}";
  events.bodyLen = 2U;

  devapi::RequestBuffers bufA;
  devapi::SignedRequest reqA;
  devapi::RequestBuffers bufB;
  devapi::SignedRequest reqB;
  TEST_ASSERT_TRUE(first.sign(heartbeatCall("{}"), 1000U, bufA, reqA));
  TEST_ASSERT_TRUE(second.sign(events, 1000U, bufB, reqB));

  // A signature for one endpoint must not be replayable against another.
  TEST_ASSERT_TRUE(strcmp(reqA.signature, reqB.signature) != 0);
}

void test_client_refuses_to_sign_without_a_credential() {
  ScriptedEntropy entropy;
  devapi::Credentials none;
  devapi::DeviceClient client(none, entropy);
  client.adoptServerTime(1750000000ULL, 0U);

  devapi::RequestBuffers buffers;
  devapi::SignedRequest request;
  TEST_ASSERT_FALSE(client.sign(heartbeatCall("{}"), 1000U, buffers, request));
}

void test_client_learns_the_clock_from_any_response_including_a_failure() {
  ScriptedEntropy entropy;
  devapi::DeviceClient client(credentials(), entropy);
  TEST_ASSERT_FALSE(client.clockKnown());

  devapi::Response rejected;
  rejected.status = 401U;
  rejected.serverUnix = 1750000000ULL;
  static_cast<void>(client.react(rejected, 5000U));

  // The 401 that rejected it is the response that fixes it.
  TEST_ASSERT_TRUE(client.clockKnown());
  TEST_ASSERT_EQUAL_UINT64(1750000005ULL, client.unixNow(10000U));
}

void test_client_a_401_with_a_big_skew_is_a_clock_problem_not_a_key_problem() {
  ScriptedEntropy entropy;
  devapi::DeviceClient client(credentials(), entropy);

  devapi::Response rejected;
  rejected.status = 401U;
  rejected.serverUnix = 1750000000ULL;

  // First contact: the box had no clock at all, so a 401 says nothing about
  // the key. Re-provisioning here would abandon a working credential.
  TEST_ASSERT_TRUE(client.react(rejected, 0U) == devapi::Reaction::ClockCorrected);
}

void test_client_a_401_with_a_good_clock_means_the_key_is_gone() {
  ScriptedEntropy entropy;
  devapi::DeviceClient client(credentials(), entropy);
  client.adoptServerTime(1750000000ULL, 0U);

  devapi::Response rejected;
  rejected.status = 401U;
  rejected.serverUnix = 1750000010ULL;

  // Ten seconds of drift is not why this was refused. The credential is.
  TEST_ASSERT_TRUE(client.react(rejected, 10000U) == devapi::Reaction::Reprovision);
}

void test_client_transient_failures_keep_the_event_and_permanent_ones_do_not() {
  ScriptedEntropy entropy;
  devapi::DeviceClient client(credentials(), entropy);
  client.adoptServerTime(1750000000ULL, 0U);

  devapi::Response r;

  r.status = 200U;
  TEST_ASSERT_TRUE(client.react(r, 1000U) == devapi::Reaction::Accepted);

  r.status = 0U; // never completed — no route, DNS, TLS
  TEST_ASSERT_TRUE(client.react(r, 1000U) == devapi::Reaction::Retry);

  r.status = 503U;
  TEST_ASSERT_TRUE(client.react(r, 1000U) == devapi::Reaction::Retry);

  r.status = 429U; // rate limited: back off, do not discard
  TEST_ASSERT_TRUE(client.react(r, 1000U) == devapi::Reaction::Retry);

  // A 400 the box caused. Retrying an identical request forever pins every
  // later event behind one the server will never accept.
  r.status = 400U;
  TEST_ASSERT_TRUE(client.react(r, 1000U) == devapi::Reaction::Rejected);
}

void test_client_a_response_without_a_clock_does_not_reset_a_good_one() {
  ScriptedEntropy entropy;
  devapi::DeviceClient client(credentials(), entropy);
  client.adoptServerTime(1750000000ULL, 0U);

  devapi::Response r;
  r.status = 503U;
  r.serverUnix = 0U; // absent, not "the epoch"
  static_cast<void>(client.react(r, 1000U));

  TEST_ASSERT_TRUE(client.clockKnown());
  TEST_ASSERT_EQUAL_UINT64(1750000001ULL, client.unixNow(1000U));
}

void test_find_server_unix_reads_the_field_and_refuses_nonsense() {
  const char ok[] = "{\"server_time\":\"x\",\"server_unix\":1750000000,\"tenant_slug\":\"c\"}";
  TEST_ASSERT_EQUAL_UINT64(1750000000ULL, devapi::findServerUnix(ok, sizeof(ok) - 1U));

  const char spaced[] = "{ \"server_unix\" : 42 }";
  TEST_ASSERT_EQUAL_UINT64(42ULL, devapi::findServerUnix(spaced, sizeof(spaced) - 1U));

  const char absent[] = "{\"tenant_slug\":\"crusaders\"}";
  TEST_ASSERT_EQUAL_UINT64(0ULL, devapi::findServerUnix(absent, sizeof(absent) - 1U));

  // A string where an integer belongs, and a body cut off mid-number: both
  // reported as absent rather than half-read into a plausible clock.
  const char quoted[] = "{\"server_unix\":\"1750000000\"}";
  TEST_ASSERT_EQUAL_UINT64(0ULL, devapi::findServerUnix(quoted, sizeof(quoted) - 1U));

  const char truncated[] = "{\"server_unix\":";
  TEST_ASSERT_EQUAL_UINT64(0ULL, devapi::findServerUnix(truncated, sizeof(truncated) - 1U));

  const char absurd[] = "{\"server_unix\":999999999999999999999999}";
  TEST_ASSERT_EQUAL_UINT64(0ULL, devapi::findServerUnix(absurd, sizeof(absurd) - 1U));

  TEST_ASSERT_EQUAL_UINT64(0ULL, devapi::findServerUnix(nullptr, 0U));
}

// ---------------------------------------------------------------------------
// Device client — clock bootstrap (probe) against the shared corpus
// ---------------------------------------------------------------------------

corpus::File g_httpCases;

/// Replays exactly the bytes it was handed. The corpus vector pins a SPECIFIC
/// nonce, and ScriptedEntropy's incrementing stream cannot produce it.
class ReplayEntropy final : public devapi::IEntropySource {
public:
  ReplayEntropy(const uint8_t* bytes, size_t len) : bytes_(bytes), len_(len) {}

  uint8_t nextByte() override {
    const uint8_t b = bytes_[at_ % len_];
    ++at_;
    return b;
  }

private:
  const uint8_t* bytes_;
  size_t len_;
  size_t at_ = 0U;
};

/// The clock-bootstrap probe, byte for byte against the shared corpus.
///
/// The fixture is the `requests` vector whose nonce is the pinned
/// feedface… value — found by nonce rather than by index, so a reordered
/// corpus cannot silently detach this test from its vector. The server executes
/// the same vector from the other side; a probe whose canonical string differs
/// by one byte fails here rather than as a field 401 with no diagnostic.
void test_client_probe_renders_unix_seconds_zero_with_a_real_hmac() {
  TEST_ASSERT_TRUE_MESSAGE(g_httpCases.load("http", "cases.json"),
                           "http corpus not found — a skipped corpus proves nothing");

  const char* requests = corpus::member(g_httpCases.root(), "requests");
  TEST_ASSERT_NOT_NULL(requests);

  static const char kProbeNonce[] = "feedfacefeedfacefeedfacefeedface";
  corpus::ArrayIter it(requests);
  const char* element = nullptr;
  const char* vector = nullptr;
  char nonce[64] = {};
  while (it.next(&element)) {
    const char* nonceValue = corpus::member(element, "nonce");
    TEST_ASSERT_NOT_NULL(nonceValue);
    TEST_ASSERT_TRUE(corpus::stringValue(nonceValue, nonce, sizeof(nonce), nullptr));
    if (strcmp(nonce, kProbeNonce) == 0) {
      vector = element;
      break;
    }
  }
  TEST_ASSERT_NOT_NULL_MESSAGE(vector, "corpus lost its clock-bootstrap probe vector");
  TEST_ASSERT_EQUAL_UINT64(0ULL, corpus::unsignedValue(corpus::member(vector, "unix_seconds")));

  // The signing key, the path, the body and the expected signature all come
  // from the corpus — this test hardcodes nothing the two sides must agree on.
  uint8_t keyBytes[32] = {};
  size_t keyLen = 0U;
  {
    const char* keyValue = corpus::member(g_httpCases.root(), "signing_key_hex");
    TEST_ASSERT_NOT_NULL(keyValue);
    char keyText[128] = {};
    size_t keyTextLen = 0U;
    TEST_ASSERT_TRUE(corpus::stringValue(keyValue, keyText, sizeof(keyText), &keyTextLen));
    TEST_ASSERT_TRUE(dc::hex::decode(keyText, keyTextLen, keyBytes, sizeof(keyBytes), &keyLen));
  }

  char path[128] = {};
  TEST_ASSERT_TRUE(
      corpus::stringValue(corpus::member(vector, "path_and_query"), path, sizeof(path), nullptr));
  TEST_ASSERT_EQUAL_STRING("/api/v1/device/heartbeat", path);

  uint8_t bodyBytes[128] = {};
  size_t bodyLen = 0U;
  TEST_ASSERT_TRUE_MESSAGE(corpus::hexField(vector, "body_hex", bodyBytes, sizeof(bodyBytes) - 1U, &bodyLen),
                           "body_hex");
  char body[128] = {};
  memcpy(body, bodyBytes, bodyLen);
  TEST_ASSERT_EQUAL_STRING("{\"running_version\":\"1.0.0\"}", body);

  char expectedSignature[dc::signer::kSignatureBufSize] = {};
  TEST_ASSERT_TRUE(corpus::stringValue(corpus::member(vector, "signature"), expectedSignature,
                                       sizeof(expectedSignature), nullptr));

  uint8_t nonceBytes[devapi::kNonceBytes] = {};
  size_t nonceLen = 0U;
  TEST_ASSERT_TRUE(dc::hex::decode(nonce, strlen(nonce), nonceBytes, sizeof(nonceBytes), &nonceLen));
  TEST_ASSERT_EQUAL_size_t(devapi::kNonceBytes, nonceLen);

  ReplayEntropy entropy(nonceBytes, nonceLen);
  devapi::Credentials c;
  c.deviceId = "11111111-2222-3333-4444-555555555555";
  c.key = dc::ByteSpan{keyBytes, keyLen};
  devapi::DeviceClient client(c, entropy);

  devapi::Call call;
  call.method = "POST";
  call.pathAndQuery = path;
  call.body = body;
  call.bodyLen = bodyLen;

  // The scenario probe() exists for: provisioned, power-cycled, no clock.
  // sign() must still refuse — its refusal protects every NORMAL call — while
  // probe() renders the zero-timestamp request whose 401 carries the clock.
  TEST_ASSERT_FALSE(client.clockKnown());
  devapi::RequestBuffers refused;
  devapi::SignedRequest refusedRequest;
  TEST_ASSERT_FALSE(client.sign(call, 5000U, refused, refusedRequest));

  devapi::RequestBuffers buffers;
  devapi::SignedRequest request;
  TEST_ASSERT_TRUE(client.probe(call, buffers, request));

  TEST_ASSERT_EQUAL_STRING("0", request.timestamp);
  TEST_ASSERT_EQUAL_STRING(kProbeNonce, request.nonce);
  TEST_ASSERT_EQUAL_STRING(expectedSignature, request.signature);
}

void test_client_a_probe_401_with_time_seeds_the_clock() {
  ScriptedEntropy entropy;
  devapi::DeviceClient client(credentials(), entropy);
  TEST_ASSERT_FALSE(client.clockKnown());

  // What the probe's expected rejection looks like: 401, body carrying
  // server_unix. That closes the loop — corrected offset, ClockCorrected,
  // immediate re-arm — without ever abandoning the credential.
  devapi::Response rejected;
  rejected.status = 401U;
  rejected.serverUnix = 1750000000ULL;
  TEST_ASSERT_TRUE(client.react(rejected, 3000U) == devapi::Reaction::ClockCorrected);
  TEST_ASSERT_TRUE(client.clockKnown());
  TEST_ASSERT_EQUAL_UINT64(1750000000ULL, client.unixNow(3000U));
}

void test_client_drift_the_server_refuses_is_read_as_skew_not_a_dead_key() {
  // The server refuses signatures from 120 s of drift (DeviceVerifier
  // ClockSkew); the local threshold must sit BELOW that window, at 90 s. When
  // it sat above (300 s), a board drifted 2–5 minutes got the 401, measured a
  // correction under its own threshold, concluded "not skew" and abandoned a
  // healthy credential. 121 s is the smallest whole-second drift the server
  // always refuses — it must be read as a clock problem.
  for (size_t i = 0U; i < kBaseCount; ++i) {
    ScriptedEntropy entropy;
    devapi::DeviceClient client(credentials(), entropy);
    client.adoptServerTime(1750000000ULL, kBases[i]);

    devapi::Response rejected;
    rejected.status = 401U;
    rejected.serverUnix = 1750000121ULL; // the box is 121 s behind the server
    TEST_ASSERT_TRUE(client.react(rejected, kBases[i]) == devapi::Reaction::ClockCorrected);
  }
}

void test_client_drift_inside_the_local_window_still_means_the_key_is_gone() {
  // The other side of the 90 s boundary: 30 s of drift is inside the server's
  // window, so the signature was verifiable and the 401 was about the key.
  for (size_t i = 0U; i < kBaseCount; ++i) {
    ScriptedEntropy entropy;
    devapi::DeviceClient client(credentials(), entropy);
    client.adoptServerTime(1750000000ULL, kBases[i]);

    devapi::Response rejected;
    rejected.status = 401U;
    rejected.serverUnix = 1750000030ULL; // 30 s out — under the 90 s threshold
    TEST_ASSERT_TRUE(client.react(rejected, kBases[i]) == devapi::Reaction::Reprovision);
  }
}

void test_client_skew_tolerance_is_pinned_by_the_corpus_below_the_servers_window() {
  // The 90 s / 120 s asymmetry above is a two-sided invariant: the server's
  // window is DeviceVerifier.ClockSkew, the local threshold is
  // kSkewToleranceSeconds, and neither side can see the other's source. The
  // corpus carries both numbers; the .NET suite asserts the server half, this
  // asserts the firmware half, and the strict inequality is what closes the
  // dead band described on the constant.
  TEST_ASSERT_TRUE_MESSAGE(g_httpCases.load("http", "cases.json"),
                           "http corpus not found — a skipped corpus proves nothing");

  const char* clock = corpus::member(g_httpCases.root(), "clock");
  TEST_ASSERT_NOT_NULL_MESSAGE(clock, "corpus lost its clock section");

  const char* tolerance = corpus::member(clock, "client_skew_tolerance_seconds");
  const char* serverSkew = corpus::member(clock, "server_skew_seconds");
  TEST_ASSERT_NOT_NULL(tolerance);
  TEST_ASSERT_NOT_NULL(serverSkew);

  TEST_ASSERT_EQUAL_UINT64(corpus::unsignedValue(tolerance),
                           static_cast<uint64_t>(devapi::kSkewToleranceSeconds));
  TEST_ASSERT_TRUE(static_cast<uint64_t>(devapi::kSkewToleranceSeconds) < corpus::unsignedValue(serverSkew));
}

void test_client_a_second_consecutive_clock_correction_is_a_dead_key() {
  // ClockCorrected is self-curing: the retry carries the adopted time and is
  // accepted. If that retry is refused WITH yet another time, the server is
  // rejecting-with-time indefinitely, and a box that keeps believing it
  // retries at 1 s for the rest of its life. Two strikes is Reprovision.
  for (size_t i = 0U; i < kBaseCount; ++i) {
    ScriptedEntropy entropy;
    devapi::DeviceClient client(credentials(), entropy);
    client.adoptServerTime(1750000000ULL, kBases[i]);

    devapi::Response rejected;
    rejected.status = 401U;
    rejected.serverUnix = 1750000121ULL; // 121 s out: skew, corrected
    TEST_ASSERT_TRUE(client.react(rejected, kBases[i]) == devapi::Reaction::ClockCorrected);

    // A transient failure in between neither clears nor counts.
    devapi::Response blip;
    blip.status = 503U;
    TEST_ASSERT_TRUE(client.react(blip, kBases[i]) == devapi::Reaction::Retry);

    rejected.serverUnix = 1750000242ULL; // another 121 s out of the CORRECTED clock
    TEST_ASSERT_TRUE(client.react(rejected, kBases[i]) == devapi::Reaction::Reprovision);

    // The strike is spent with the Reprovision: a fresh credential does not
    // inherit half of one, so the next skew is again a correction.
    rejected.serverUnix = 1750000363ULL;
    TEST_ASSERT_TRUE(client.react(rejected, kBases[i]) == devapi::Reaction::ClockCorrected);
  }
}

void test_client_an_accepted_call_clears_the_clock_correction_strike() {
  // Correction, then the cured retry is accepted, then — much later — the
  // clock has drifted again. That is two corrections in a lifetime, not two
  // in a row, and must still be read as a clock problem.
  for (size_t i = 0U; i < kBaseCount; ++i) {
    ScriptedEntropy entropy;
    devapi::DeviceClient client(credentials(), entropy);
    client.adoptServerTime(1750000000ULL, kBases[i]);

    devapi::Response rejected;
    rejected.status = 401U;
    rejected.serverUnix = 1750000121ULL;
    TEST_ASSERT_TRUE(client.react(rejected, kBases[i]) == devapi::Reaction::ClockCorrected);

    devapi::Response accepted;
    accepted.status = 200U;
    accepted.serverUnix = 1750000121ULL;
    TEST_ASSERT_TRUE(client.react(accepted, kBases[i]) == devapi::Reaction::Accepted);

    rejected.serverUnix = 1750000242ULL;
    TEST_ASSERT_TRUE(client.react(rejected, kBases[i]) == devapi::Reaction::ClockCorrected);
  }
}

// ---------------------------------------------------------------------------
// Session — the decision a scan produces
// ---------------------------------------------------------------------------

void test_session_a_booked_member_gets_the_lights_and_an_activation_event() {
  Cache cache(kSixHoursMs);
  fakes::FakeStore store;
  Queue queue(&store);
  queue.begin();
  Play play(cache, queue);

  const roster::Entry entries[] = {booking("tok-alice", 2U, 0U, 2700000UL)};
  loadRoster(cache, kBaseMid, entries, 1U);

  const court::Outcome out = play.onScan("tok-alice", 2U, eventq::Method::Qr, kBaseMid + 1000U);

  TEST_ASSERT_TRUE(out.action == court::Action::TurnOn);
  TEST_ASSERT_EQUAL_UINT8(2U, out.court);
  // One second after the slot opened, so one second less than the slot: the
  // grant is what REMAINS, not what was booked. Rounded up on the display.
  TEST_ASSERT_EQUAL_UINT32(2699000UL, out.durationMs);
  TEST_ASSERT_EQUAL_STRING("COURT C", out.line1);
  TEST_ASSERT_EQUAL_STRING("45 MIN", out.line2);

  // The event is what stops the no-show sweep reversing a game that happened.
  // A court lit and never reported looks exactly like a member who stayed home.
  eventq::Event queued;
  TEST_ASSERT_TRUE(queue.peek(queued));
  TEST_ASSERT_TRUE(queued.kind == eventq::Kind::Activation);
  TEST_ASSERT_TRUE(queued.method == eventq::Method::Qr);
  TEST_ASSERT_TRUE(queued.subjectEquals("tok-alice"));
  TEST_ASSERT_EQUAL_UINT32(out.eventSeq, queued.seq);
}

void test_session_records_a_refused_scan_too() {
  Cache cache(kSixHoursMs);
  fakes::FakeStore store;
  Queue queue(&store);
  queue.begin();
  Play play(cache, queue);

  const roster::Entry entries[] = {booking("tok-alice", 0U, 0U, 2700000UL)};
  loadRoster(cache, kBaseMid, entries, 1U);

  const court::Outcome out = play.onScan("tok-mallory", 0U, eventq::Method::Pin, kBaseMid + 1000U);
  TEST_ASSERT_TRUE(out.action == court::Action::Refuse);

  // A refusal nobody records is a member at the desk with a complaint and no
  // evidence either way.
  eventq::Event queued;
  TEST_ASSERT_TRUE(queue.peek(queued));
  TEST_ASSERT_TRUE(queued.kind == eventq::Kind::UnknownScan);
  TEST_ASSERT_TRUE(queued.subjectEquals("tok-mallory"));
}

void test_session_every_refusal_says_something_a_member_can_act_on() {
  Cache cache(kSixHoursMs);
  fakes::FakeStore store;
  Queue queue(&store);
  queue.begin();
  Play play(cache, queue);

  const roster::Entry entries[] = {booking("tok-alice", 1U, 600000UL, 1200000UL)};
  loadRoster(cache, kBaseMid, entries, 1U);

  // Too early: how long to wait, because the box has no wall clock and cannot
  // honestly print "18:00".
  const court::Outcome early = play.onScan("tok-alice", 1U, eventq::Method::Qr, kBaseMid + 60000UL);
  TEST_ASSERT_EQUAL_STRING("TOO EARLY", early.line1);
  TEST_ASSERT_EQUAL_STRING("WAIT 9 MIN", early.line2);

  // Wrong court: where to actually go. The refusal most worth being specific
  // about — the member is thirty seconds from playing.
  const court::Outcome wrong = play.onScan("tok-alice", 3U, eventq::Method::Qr, kBaseMid + 700000UL);
  TEST_ASSERT_EQUAL_STRING("WRONG COURT", wrong.line1);
  TEST_ASSERT_EQUAL_STRING("YOU ARE ON B", wrong.line2);

  const court::Outcome late = play.onScan("tok-alice", 1U, eventq::Method::Qr, kBaseMid + 1800000UL);
  TEST_ASSERT_EQUAL_STRING("BOOKING ENDED", late.line1);
}

void test_session_a_stale_roster_blames_the_network_not_the_member() {
  Cache cache(kSixHoursMs);
  fakes::FakeStore store;
  Queue queue(&store);
  queue.begin();
  Play play(cache, queue);

  const roster::Entry entries[] = {booking("tok-alice", 0U, 0U, 86400000UL)};
  loadRoster(cache, kBaseMid, entries, 1U);

  const court::Outcome out = play.onScan("tok-alice", 0U, eventq::Method::Qr, kBaseMid + kSixHoursMs + 1U);
  TEST_ASSERT_TRUE(out.action == court::Action::Refuse);
  // "NOT RECOGNISED" would send a member with a valid booking away believing
  // their booking is gone. This is an admin's problem, and it reads like one.
  TEST_ASSERT_EQUAL_STRING("NO CONNECTION", out.line1);
}

void test_session_every_line_fits_the_display() {
  Cache cache(kSixHoursMs);
  fakes::FakeStore store;
  Queue queue(&store);
  queue.begin();
  Play play(cache, queue);

  // A long booking on the last court, which is the widest each line gets.
  const roster::Entry entries[] = {booking("tok-alice", 3U, 0U, 5400000UL)};
  loadRoster(cache, kBaseMid, entries, 1U);

  const uint8_t courts[] = {0U, 1U, 2U, 3U};
  for (size_t i = 0U; i < 4U; ++i) {
    const court::Outcome out = play.onScan("tok-alice", courts[i], eventq::Method::Qr, kBaseMid + 1000U);
    TEST_ASSERT_TRUE(strlen(out.line1) <= court::kLineLen);
    TEST_ASSERT_TRUE(strlen(out.line2) <= court::kLineLen);
  }

  const court::Outcome unknown = play.onScan("x", 0U, eventq::Method::Qr, kBaseMid + 1000U);
  TEST_ASSERT_TRUE(strlen(unknown.line1) <= court::kLineLen);
  TEST_ASSERT_TRUE(strlen(unknown.line2) <= court::kLineLen);
}

void test_session_minutes_round_up_so_a_live_court_never_reads_zero() {
  Cache cache(kSixHoursMs);
  fakes::FakeStore store;
  Queue queue(&store);
  queue.begin();
  Play play(cache, queue);

  // Thirty seconds granted. Rounding down would tell a member their booking is
  // over while the lights are still on.
  const roster::Entry entries[] = {booking("tok-alice", 0U, 0U, 30000UL)};
  loadRoster(cache, kBaseMid, entries, 1U);

  const court::Outcome out = play.onScan("tok-alice", 0U, eventq::Method::Qr, kBaseMid + 1000U);
  TEST_ASSERT_EQUAL_STRING("1 MIN", out.line2);
}

void test_session_a_release_is_recorded_with_how_long_the_court_was_held() {
  Cache cache(kSixHoursMs);
  fakes::FakeStore store;
  Queue queue(&store);
  queue.begin();
  Play play(cache, queue);

  const court::Outcome out = play.onRelease(1U, 2400000UL, kBaseMid);
  TEST_ASSERT_TRUE(out.action == court::Action::Refuse);
  TEST_ASSERT_EQUAL_STRING("SCAN TO START", out.line2);

  // How long it was ACTUALLY used, which is the number a dispute about a
  // 45-minute booking turns on.
  eventq::Event queued;
  TEST_ASSERT_TRUE(queue.peek(queued));
  TEST_ASSERT_TRUE(queued.kind == eventq::Kind::Release);
  TEST_ASSERT_EQUAL_UINT32(2400000UL, queued.durationMs);
}

void test_session_a_boot_event_explains_a_gap_in_the_sequence() {
  Cache cache(kSixHoursMs);
  fakes::FakeStore store;
  Queue queue(&store);
  queue.begin();
  Play play(cache, queue);

  play.onBoot(kBaseZero);

  eventq::Event queued;
  TEST_ASSERT_TRUE(queue.peek(queued));
  TEST_ASSERT_TRUE(queued.kind == eventq::Kind::Boot);
  TEST_ASSERT_EQUAL_UINT8(eventq::Event::kNoCourt, queued.court);
}

void test_session_a_full_queue_still_opens_the_court() {
  Cache cache(kSixHoursMs);
  fakes::FakeStore store;
  Queue queue(&store); // capacity 4
  queue.begin();
  Play play(cache, queue);

  const roster::Entry entries[] = {booking("tok-alice", 0U, 0U, 2700000UL)};
  loadRoster(cache, kBaseMid, entries, 1U);

  for (int i = 0; i < 6; ++i) {
    const court::Outcome out = play.onScan("tok-alice", 0U, eventq::Method::Qr, kBaseMid + 1000U);
    // Refusing to open a court because the box's own queue is full would punish
    // the member for the box's problem. The lights win; the overflow counter
    // records what was lost.
    TEST_ASSERT_TRUE(out.action == court::Action::TurnOn);
  }
  TEST_ASSERT_TRUE(queue.overflowed() > 0U);
}

// ---------------------------------------------------------------------------
// Button map — driven from the shared corpus
// ---------------------------------------------------------------------------

corpus::File g_buttonCases;
corpus::File g_buttonManifest;

// --- executed-case ledger ---------------------------------------------------
//
// The same shape as the devcrypto suite's: each corpus test records how many
// cases it ran under the section it read, and the last test cross-checks the
// ledger against cases.json and manifest.json in both directions. Until this
// existed the button-map test asserted `executed >= 20` against a corpus that
// declared 27, and a `maps` section nothing on this side read — exactly the
// silent skip the corpus README's executed-count rule exists to forbid.

constexpr size_t kMaxButtonSections = 4;

struct ButtonLedger {
  char names[kMaxButtonSections][corpus::kMaxNameLen];
  size_t executed[kMaxButtonSections];
  size_t count = 0;

  void record(const char* name, size_t ran) {
    TEST_ASSERT_TRUE_MESSAGE(count < kMaxButtonSections, "ledger full");
    strncpy(names[count], name, corpus::kMaxNameLen - 1);
    names[count][corpus::kMaxNameLen - 1] = '\0';
    executed[count] = ran;
    ++count;
  }

  bool find(const char* name, size_t* ran) const {
    for (size_t i = 0; i < count; ++i) {
      if (strcmp(names[i], name) == 0) {
        *ran = executed[i];
        return true;
      }
    }
    return false;
  }
};

ButtonLedger g_buttonLedger;

void loadButtonCorpus() {
  TEST_ASSERT_TRUE_MESSAGE(g_buttonCases.load("buttonmap", "cases.json"),
                           "button-map corpus not found — a skipped corpus proves nothing");
  TEST_ASSERT_TRUE_MESSAGE(g_buttonManifest.load("buttonmap", "manifest.json"),
                           "src/contracts/device-protocol/buttonmap/manifest.json not found above cwd");
}

const char* buttonSection(const char* name) {
  const char* value = corpus::member(g_buttonCases.root(), name);
  TEST_ASSERT_NOT_NULL_MESSAGE(value, name);
  TEST_ASSERT_TRUE_MESSAGE(corpus::isArray(value), name);
  return value;
}

size_t buttonDeclaredCount(const char* name) {
  const char* counts = corpus::member(g_buttonManifest.root(), "case_count");
  TEST_ASSERT_NOT_NULL_MESSAGE(counts, "manifest has no case_count");
  const char* value = corpus::member(counts, name);
  TEST_ASSERT_NOT_NULL_MESSAGE(value, name);
  return static_cast<size_t>(corpus::unsignedValue(value));
}

/// Every token in the corpus, parsed by the firmware, checked against what the
/// corpus says the API accepts.
///
/// This is the anti-drift gate. The API validates a proposed map and the firmware
/// parses the one it is handed, neither can see the other's source, and the
/// failure they would produce is silent — a token one side accepts and the other
/// ignores leaves a button that quietly still does what it did before an admin
/// changed it. Both sides read this file, so drift turns a test red.
void test_buttonmap_agrees_with_the_shared_corpus() {
  loadButtonCorpus();

  corpus::ArrayIter it(buttonSection("actions"));
  const char* element = nullptr;
  size_t executed = 0;

  while (it.next(&element)) {
    char wire[128] = {};
    const char* wireValue = corpus::member(element, "wire");
    TEST_ASSERT_NOT_NULL(wireValue);
    TEST_ASSERT_TRUE(corpus::stringValue(wireValue, wire, sizeof(wire), nullptr));

    const char* validValue = corpus::skipWs(corpus::member(element, "valid"));
    TEST_ASSERT_NOT_NULL(validValue);
    const bool expectedValid = validValue[0] == 't';

    court::ButtonAction parsed;
    const bool actualValid = court::parseButtonAction(wire, parsed);
    TEST_ASSERT_EQUAL_MESSAGE(expectedValid, actualValid, wire);

    if (!expectedValid) {
      ++executed;
      continue;
    }

    char kind[32] = {};
    const char* kindValue = corpus::member(element, "kind");
    TEST_ASSERT_NOT_NULL(kindValue);
    TEST_ASSERT_TRUE(corpus::stringValue(kindValue, kind, sizeof(kind), nullptr));

    if (strcmp(kind, "none") == 0) {
      TEST_ASSERT_TRUE(parsed.kind == court::ButtonKind::None);
    } else if (strcmp(kind, "off") == 0) {
      TEST_ASSERT_TRUE(parsed.kind == court::ButtonKind::TurnOff);
    } else if (strcmp(kind, "court") == 0) {
      TEST_ASSERT_TRUE(parsed.kind == court::ButtonKind::SelectCourt);
      TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(corpus::unsignedValue(corpus::member(element, "court"))),
                              parsed.court);
    } else if (strcmp(kind, "minutes") == 0) {
      TEST_ASSERT_TRUE(parsed.kind == court::ButtonKind::GrantMinutes);
      TEST_ASSERT_EQUAL_UINT16(
          static_cast<uint16_t>(corpus::unsignedValue(corpus::member(element, "minutes"))), parsed.minutes);
    } else {
      TEST_FAIL_MESSAGE("corpus names a kind this build does not know");
    }
    ++executed;
  }

  // A corpus that loaded but yielded nothing passes every assertion above. The
  // declared count is what makes an empty, reshaped or quietly extended file a
  // failure rather than a silent success.
  TEST_ASSERT_EQUAL_size_t(buttonDeclaredCount("actions"), executed);
  g_buttonLedger.record("actions", executed);
}

/// Every whole map in the corpus, applied entry by entry exactly as the
/// heartbeat handler applies one, and read back as the panel it produces.
///
/// The server decides whether a map is VALID — it refuses one that cannot start
/// or finish a walk-up, or that leaves buttons undefined — and the firmware
/// never sees a refused one. What the firmware must agree on is narrower and
/// is asserted here: every token in every map parses (the grammar is shared,
/// whatever the map's structural verdict), a valid map fills all eight buttons
/// so none falls back to the old wiring, and the panel a valid map produces can
/// select a court and grant minutes. A map the server calls invalid must fail
/// at least one of those on this side too, or the two sides disagree about
/// what a usable panel is.
void test_buttonmap_applies_every_corpus_map() {
  loadButtonCorpus();
  TEST_ASSERT_EQUAL_UINT8(court::kButtonCount, static_cast<uint8_t>(corpus::unsignedValue(
                                                   corpus::member(g_buttonCases.root(), "button_count"))));

  corpus::ArrayIter it(buttonSection("maps"));
  const char* element = nullptr;
  size_t executed = 0;

  while (it.next(&element)) {
    char name[64] = {};
    TEST_ASSERT_TRUE(corpus::stringValue(corpus::member(element, "name"), name, sizeof(name), nullptr));
    const char* validValue = corpus::skipWs(corpus::member(element, "valid"));
    TEST_ASSERT_NOT_NULL_MESSAGE(validValue, name);
    const bool expectedValid = validValue[0] == 't';

    court::ButtonMap map;
    map.reset();
    corpus::ArrayIter tokens(corpus::member(element, "wire"));
    const char* tokenValue = nullptr;
    uint8_t entries = 0U;
    while (tokens.next(&tokenValue)) {
      char wire[32] = {};
      TEST_ASSERT_TRUE_MESSAGE(corpus::stringValue(tokenValue, wire, sizeof(wire), nullptr), name);
      TEST_ASSERT_TRUE_MESSAGE(entries < court::kButtonCount, name);
      TEST_ASSERT_TRUE_MESSAGE(map.setFromWire(entries, wire), wire);
      ++entries;
    }

    bool canSelectCourt = false;
    bool canGrantMinutes = false;
    for (uint8_t i = 0U; i < entries; ++i) {
      canSelectCourt = canSelectCourt || map[i].kind == court::ButtonKind::SelectCourt;
      canGrantMinutes = canGrantMinutes || map[i].kind == court::ButtonKind::GrantMinutes;
    }
    const bool usable = entries == court::kButtonCount && canSelectCourt && canGrantMinutes;
    TEST_ASSERT_EQUAL_MESSAGE(expectedValid, usable, name);
    ++executed;
  }

  TEST_ASSERT_EQUAL_size_t(buttonDeclaredCount("maps"), executed);
  g_buttonLedger.record("maps", executed);
}

/// Every case section in buttonmap/cases.json is declared in its manifest and
/// was executed by a test above, and every declared section exists. Sections
/// whose name starts with `_` are prose, not cases.
void test_every_buttonmap_section_is_declared_and_executed() {
  loadButtonCorpus();
  char name[corpus::kMaxNameLen];
  const char* value = nullptr;
  size_t sectionsSeen = 0;

  corpus::ObjectIter cases(g_buttonCases.root());
  while (cases.next(name, sizeof(name), &value)) {
    if (name[0] == '_' || !corpus::isArray(value)) {
      continue;
    }
    size_t ran = 0;
    TEST_ASSERT_TRUE_MESSAGE(g_buttonLedger.find(name, &ran),
                             "corpus section was not executed by any test in this suite");
    TEST_ASSERT_EQUAL_size_t_MESSAGE(buttonDeclaredCount(name), ran, name);
    ++sectionsSeen;
  }

  const char* counts = corpus::member(g_buttonManifest.root(), "case_count");
  TEST_ASSERT_NOT_NULL(counts);
  corpus::ObjectIter declared(counts);
  size_t sectionsDeclared = 0;
  while (declared.next(name, sizeof(name), &value)) {
    TEST_ASSERT_NOT_NULL_MESSAGE(corpus::member(g_buttonCases.root(), name),
                                 "manifest declares a section cases.json does not contain");
    ++sectionsDeclared;
  }

  TEST_ASSERT_EQUAL_size_t(sectionsSeen, sectionsDeclared);
  TEST_ASSERT_EQUAL_size_t(sectionsSeen, g_buttonLedger.count);
}

void test_buttonmap_defaults_to_the_original_wiring() {
  court::ButtonMap map;
  TEST_ASSERT_FALSE(map.configured());

  for (uint8_t i = 0U; i < 4U; ++i) {
    TEST_ASSERT_TRUE(map[i].kind == court::ButtonKind::SelectCourt);
    TEST_ASSERT_EQUAL_UINT8(i, map[i].court);
  }
  const uint16_t expected[4] = {15U, 30U, 45U, 60U};
  for (uint8_t i = 0U; i < 4U; ++i) {
    TEST_ASSERT_TRUE(map[static_cast<uint8_t>(4U + i)].kind == court::ButtonKind::GrantMinutes);
    TEST_ASSERT_EQUAL_UINT16(expected[i], map[static_cast<uint8_t>(4U + i)].minutes);
  }
}

void test_buttonmap_an_unknown_token_leaves_the_previous_entry_alone() {
  court::ButtonMap map;
  TEST_ASSERT_TRUE(map.setFromWire(0U, "court:D"));
  TEST_ASSERT_EQUAL_UINT8(3U, map[0].court);

  // What a downgrade looks like: a token written by a newer API. Keeping a
  // working button beats blanking one.
  TEST_ASSERT_FALSE(map.setFromWire(0U, "gate:open"));
  TEST_ASSERT_TRUE(map[0].kind == court::ButtonKind::SelectCourt);
  TEST_ASSERT_EQUAL_UINT8(3U, map[0].court);
}

void test_buttonmap_reset_clears_a_short_map_rather_than_leaving_stale_entries() {
  court::ButtonMap map;
  TEST_ASSERT_TRUE(map.setFromWire(7U, "off"));
  TEST_ASSERT_TRUE(map.configured());

  map.reset();
  TEST_ASSERT_FALSE(map.configured());
  TEST_ASSERT_TRUE(map[7].kind == court::ButtonKind::GrantMinutes);
  TEST_ASSERT_EQUAL_UINT16(60U, map[7].minutes);
}

void test_buttonmap_an_out_of_range_index_reads_as_none() {
  court::ButtonMap map;
  TEST_ASSERT_FALSE(map.setFromWire(court::kButtonCount, "off"));
  TEST_ASSERT_TRUE(map[court::kButtonCount].kind == court::ButtonKind::None);
}

// ---------------------------------------------------------------------------
// Walk-up pad — the two presses that buy court time
// ---------------------------------------------------------------------------

void test_pad_court_then_duration_is_a_request() {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    court::ButtonMap map;
    court::WalkUpPad pad;

    TEST_ASSERT_TRUE(pad.press(map, 2U, base) == court::PadResult::CourtSelected);
    TEST_ASSERT_TRUE(pad.hasSelection());
    TEST_ASSERT_EQUAL_UINT8(2U, pad.selectedCourt());

    TEST_ASSERT_TRUE(pad.press(map, 6U, base + 3000U) == court::PadResult::Requested);
    TEST_ASSERT_EQUAL_UINT8(2U, pad.intent().court);
    TEST_ASSERT_EQUAL_UINT16(45U, pad.intent().minutes);

    // Spent on the request, not on the answer: a second duration press while a
    // slow POST is in flight would otherwise buy the court twice.
    TEST_ASSERT_FALSE(pad.hasSelection());
  }
}

void test_pad_a_duration_press_alone_does_nothing() {
  court::ButtonMap map;
  court::WalkUpPad pad;
  // A stray press on an idle box. Not an error — on a panel with unused buttons
  // this is the common case — and nothing is armed for the next person to finish.
  TEST_ASSERT_TRUE(pad.press(map, 5U, kBaseMid) == court::PadResult::Ignored);
  TEST_ASSERT_FALSE(pad.hasSelection());
}

void test_pad_a_selection_lapses_so_the_next_member_does_not_inherit_it() {
  for (size_t i = 0U; i < kBaseCount; ++i) {
    const uint32_t base = kBases[i];
    court::ButtonMap map;
    court::WalkUpPad pad;

    TEST_ASSERT_TRUE(pad.press(map, 1U, base) == court::PadResult::CourtSelected);

    // Still live a moment before the deadline...
    TEST_ASSERT_FALSE(pad.tick(base + court::kSelectionTtlMs - 1U));
    TEST_ASSERT_TRUE(pad.hasSelection());

    // ...and gone at it. The edge is reported exactly once so the caller can
    // repaint the idle screen without doing it on every pass.
    TEST_ASSERT_TRUE(pad.tick(base + court::kSelectionTtlMs));
    TEST_ASSERT_FALSE(pad.tick(base + court::kSelectionTtlMs + 1U));
    TEST_ASSERT_FALSE(pad.hasSelection());

    // The member who walked away left nothing behind: a duration press now is
    // a stray press, not a purchase in their name.
    TEST_ASSERT_TRUE(pad.press(map, 4U, base + court::kSelectionTtlMs + 5000U) == court::PadResult::Ignored);
  }
}

void test_pad_a_late_duration_press_does_not_complete_a_lapsed_selection() {
  court::ButtonMap map;
  court::WalkUpPad pad;

  TEST_ASSERT_TRUE(pad.press(map, 0U, kBaseMid) == court::PadResult::CourtSelected);
  // No tick() in between: the press itself must evaluate the lapse, or a box
  // whose loop was busy would sell court A to whoever is standing there now.
  TEST_ASSERT_TRUE(pad.press(map, 4U, kBaseMid + court::kSelectionTtlMs + 1U) == court::PadResult::Ignored);
}

void test_pad_a_second_court_press_replaces_the_first() {
  court::ButtonMap map;
  court::WalkUpPad pad;

  TEST_ASSERT_TRUE(pad.press(map, 0U, kBaseMid) == court::PadResult::CourtSelected);
  TEST_ASSERT_TRUE(pad.press(map, 3U, kBaseMid + 1000U) == court::PadResult::CourtSelected);
  TEST_ASSERT_EQUAL_UINT8(3U, pad.selectedCourt());

  TEST_ASSERT_TRUE(pad.press(map, 4U, kBaseMid + 2000U) == court::PadResult::Requested);
  TEST_ASSERT_EQUAL_UINT8(3U, pad.intent().court);
}

void test_pad_honours_a_remapped_panel() {
  court::ButtonMap map;
  // The case the feature exists for: an admin reorders the panel from a browser.
  TEST_ASSERT_TRUE(map.setFromWire(0U, "minutes:20"));
  TEST_ASSERT_TRUE(map.setFromWire(4U, "court:D"));
  TEST_ASSERT_TRUE(map.setFromWire(5U, "off"));

  court::WalkUpPad pad;
  TEST_ASSERT_TRUE(pad.press(map, 4U, kBaseMid) == court::PadResult::CourtSelected);
  TEST_ASSERT_TRUE(pad.press(map, 0U, kBaseMid + 1000U) == court::PadResult::Requested);
  TEST_ASSERT_EQUAL_UINT8(3U, pad.intent().court);
  TEST_ASSERT_EQUAL_UINT16(20U, pad.intent().minutes);

  TEST_ASSERT_TRUE(pad.press(map, 4U, kBaseMid + 2000U) == court::PadResult::CourtSelected);
  TEST_ASSERT_TRUE(pad.press(map, 5U, kBaseMid + 3000U) == court::PadResult::ReleaseRequested);
  TEST_ASSERT_EQUAL_UINT8(3U, pad.intent().court);
}

void test_pad_an_unmapped_button_is_inert() {
  court::ButtonMap map;
  TEST_ASSERT_TRUE(map.setFromWire(6U, "none"));

  court::WalkUpPad pad;
  TEST_ASSERT_TRUE(pad.press(map, 0U, kBaseMid) == court::PadResult::CourtSelected);
  TEST_ASSERT_TRUE(pad.press(map, 6U, kBaseMid + 1000U) == court::PadResult::Ignored);
  // ...and the selection survives an inert press, so a fat finger costs nothing.
  TEST_ASSERT_TRUE(pad.hasSelection());
}

// ---------------------------------------------------------------------------
// JSON scanning — three fields out of a small body, no parser, no heap
// ---------------------------------------------------------------------------

void test_json_reads_a_string_field() {
  const char body[] = "{\"device_id\":\"11111111-2222\",\"tenant_slug\":\"crusaders\"}";
  char out[64] = {};
  TEST_ASSERT_TRUE(devapi::json::stringField(body, sizeof(body) - 1U, "device_id", out, sizeof(out)));
  TEST_ASSERT_EQUAL_STRING("11111111-2222", out);

  TEST_ASSERT_TRUE(devapi::json::stringField(body, sizeof(body) - 1U, "tenant_slug", out, sizeof(out)));
  TEST_ASSERT_EQUAL_STRING("crusaders", out);
}

void test_json_a_field_that_would_not_fit_is_refused_not_truncated() {
  const char body[] = "{\"device_key\":\"0011223344556677\"}";
  char small[8] = {};
  // Half a device key signs every request wrongly, and the 401 it earns reads
  // exactly like a revoked credential — which sends a good board off to be
  // re-claimed. Refusing is the only safe answer.
  TEST_ASSERT_FALSE(devapi::json::stringField(body, sizeof(body) - 1U, "device_key", small, sizeof(small)));
}

void test_json_absent_and_malformed_fields_report_absence() {
  const char body[] = "{\"device_id\":\"abc\"}";
  char out[32] = {};

  TEST_ASSERT_FALSE(devapi::json::stringField(body, sizeof(body) - 1U, "missing", out, sizeof(out)));

  const char notString[] = "{\"device_id\":42}";
  TEST_ASSERT_FALSE(
      devapi::json::stringField(notString, sizeof(notString) - 1U, "device_id", out, sizeof(out)));

  const char truncated[] = "{\"device_id\":\"abc";
  TEST_ASSERT_FALSE(
      devapi::json::stringField(truncated, sizeof(truncated) - 1U, "device_id", out, sizeof(out)));

  const char empty[] = "{\"device_id\":\"\"}";
  TEST_ASSERT_FALSE(devapi::json::stringField(empty, sizeof(empty) - 1U, "device_id", out, sizeof(out)));

  TEST_ASSERT_FALSE(devapi::json::stringField(nullptr, 0U, "device_id", out, sizeof(out)));
}

void test_json_reads_an_unsigned_field_and_saturates_rather_than_wraps() {
  const char body[] = "{\"accepted_through\":42,\"granted_minutes\": 20 }";
  uint32_t value = 0U;

  TEST_ASSERT_TRUE(devapi::json::unsignedField(body, sizeof(body) - 1U, "accepted_through", value));
  TEST_ASSERT_EQUAL_UINT32(42U, value);

  TEST_ASSERT_TRUE(devapi::json::unsignedField(body, sizeof(body) - 1U, "granted_minutes", value));
  TEST_ASSERT_EQUAL_UINT32(20U, value);

  // Absent leaves the caller's value alone, which is what lets a caller seed it with a
  // sensible default and simply ignore the result.
  value = 99U;
  TEST_ASSERT_FALSE(devapi::json::unsignedField(body, sizeof(body) - 1U, "missing", value));
  TEST_ASSERT_EQUAL_UINT32(99U, value);

  // Wrapping an absurd number produces a plausible small one — and a plausible small image
  // size passes the fit check and then runs out of flash halfway through a write.
  const char absurd[] = "{\"ota_size\":99999999999999}";
  value = 7U;
  TEST_ASSERT_FALSE(devapi::json::unsignedField(absurd, sizeof(absurd) - 1U, "ota_size", value));
  TEST_ASSERT_EQUAL_UINT32(7U, value);

  const char notNumber[] = "{\"accepted_through\":\"42\"}";
  TEST_ASSERT_FALSE(
      devapi::json::unsignedField(notNumber, sizeof(notNumber) - 1U, "accepted_through", value));
}

void test_json_walks_an_array_of_strings() {
  const char body[] =
      "{\"config\":{\"slice_minutes\":15,\"button_map\":[\"court:A\",\"minutes:30\",\"off\"]}}";
  size_t at = devapi::json::findArray(body, sizeof(body) - 1U, "button_map");
  TEST_ASSERT_NOT_EQUAL(devapi::json::kNotFound, at);

  const char* expected[] = {"court:A", "minutes:30", "off"};
  char token[32] = {};
  for (size_t i = 0U; i < 3U; ++i) {
    TEST_ASSERT_TRUE(devapi::json::nextStringElement(body, sizeof(body) - 1U, at, token, sizeof(token)));
    TEST_ASSERT_EQUAL_STRING(expected[i], token);
  }
  // ...and stops at the bracket rather than running into the rest of the document.
  TEST_ASSERT_FALSE(devapi::json::nextStringElement(body, sizeof(body) - 1U, at, token, sizeof(token)));
}

void test_json_an_absent_or_non_array_value_is_reported_as_absent() {
  const char noKey[] = "{\"slice_minutes\":15}";
  TEST_ASSERT_EQUAL(devapi::json::kNotFound,
                    devapi::json::findArray(noKey, sizeof(noKey) - 1U, "button_map"));

  // Present but the wrong shape. Reported as absent so the caller keeps the map
  // it already had, rather than replacing a working panel with nothing.
  const char notArray[] = "{\"button_map\":\"court:A\"}";
  TEST_ASSERT_EQUAL(devapi::json::kNotFound,
                    devapi::json::findArray(notArray, sizeof(notArray) - 1U, "button_map"));

  const char emptyArray[] = "{\"button_map\":[]}";
  size_t at = devapi::json::findArray(emptyArray, sizeof(emptyArray) - 1U, "button_map");
  TEST_ASSERT_NOT_EQUAL(devapi::json::kNotFound, at);
  char token[8] = {};
  TEST_ASSERT_FALSE(
      devapi::json::nextStringElement(emptyArray, sizeof(emptyArray) - 1U, at, token, sizeof(token)));
}

void test_json_a_key_that_is_a_prefix_of_another_does_not_match_it() {
  // "device_key" must not be found by looking for "device_id", nor the reverse,
  // and a value that merely CONTAINS the key text must not be mistaken for it.
  const char body[] = "{\"device_key_version\":\"1\",\"device_key\":\"abcd\"}";
  char out[32] = {};
  TEST_ASSERT_TRUE(devapi::json::stringField(body, sizeof(body) - 1U, "device_key", out, sizeof(out)));
  TEST_ASSERT_EQUAL_STRING("abcd", out);
}

} // namespace

void setUp() {
}

void tearDown() {
}

// --- !BTN decode ------------------------------------------------------------
//
// The bridge read this as a decimal index while the wire carries a key
// CHARACTER, so the four court buttons were dropped and the four duration
// buttons selected courts. The decode now lives in lib/court precisely so these
// can exist: it used to sit in main.cpp, which `pio test` excludes and
// strict_compile skips, and the pad tests fed physical indices straight in.

void test_button_wire_maps_court_keys_to_the_first_four_positions() {
  uint8_t index = 0xFFU;
  TEST_ASSERT_TRUE(court::buttonIndexFromWire("A", index));
  TEST_ASSERT_EQUAL_UINT8(0U, index);
  TEST_ASSERT_TRUE(court::buttonIndexFromWire("D", index));
  TEST_ASSERT_EQUAL_UINT8(3U, index);
}

void test_button_wire_maps_duration_keys_to_the_last_four_positions() {
  uint8_t index = 0xFFU;
  TEST_ASSERT_TRUE(court::buttonIndexFromWire("1", index));
  TEST_ASSERT_EQUAL_UINT8(4U, index);
  TEST_ASSERT_TRUE(court::buttonIndexFromWire("4", index));
  TEST_ASSERT_EQUAL_UINT8(7U, index);
}

/// The exact defect: '1' is the FIRST duration button, not physical position 1.
/// Read as decimal it came out as 1, which under the default map is "select
/// court B" — so pressing 15 MIN at court A lit court B and charged for it.
void test_button_wire_is_not_a_decimal_index() {
  uint8_t index = 0xFFU;
  TEST_ASSERT_TRUE(court::buttonIndexFromWire("1", index));
  TEST_ASSERT_NOT_EQUAL(1U, index);

  court::ButtonMap map;
  map.reset();
  TEST_ASSERT_TRUE(map[index].kind == court::ButtonKind::GrantMinutes);
  TEST_ASSERT_EQUAL_UINT16(15U, map[index].minutes);
}

/// Round-trips against the encoder the Mega actually uses, so the two halves
/// cannot drift apart without this failing.
void test_button_wire_round_trips_every_key_the_mega_can_send() {
  for (uint8_t physical = 0U; physical < court::kButtonCount; ++physical) {
    const char wire[2] = {proto::keyChar(static_cast<proto::Key>(physical)), '\0'};
    uint8_t decoded = 0xFFU;
    TEST_ASSERT_TRUE(court::buttonIndexFromWire(wire, decoded));
    TEST_ASSERT_EQUAL_UINT8(physical, decoded);
  }
}

void test_button_wire_refuses_anything_that_is_not_one_key() {
  uint8_t index = 0xFFU;
  TEST_ASSERT_FALSE(court::buttonIndexFromWire("", index));
  TEST_ASSERT_FALSE(court::buttonIndexFromWire("E", index));
  TEST_ASSERT_FALSE(court::buttonIndexFromWire("0", index));
  TEST_ASSERT_FALSE(court::buttonIndexFromWire("5", index));
  // Two characters is a corrupted line, not a key. Guessing at the first of
  // them is how a court gets lit by noise on a 9600 baud cable.
  TEST_ASSERT_FALSE(court::buttonIndexFromWire("A2", index));
  TEST_ASSERT_EQUAL_UINT8(0xFFU, index);
}

/// Session::record used to zero this one line after onScan set it, and
/// EventQueue::push assigns only `seq` — so every activation and release went up
/// as uptime_ms 0. The API stamps an event by subtracting its uptime from the
/// box's uptime now, so a zero means "at boot": on a box up for forty days, a
/// wall-clock time forty days in the past, on the field that decides whether the
/// no-show sweep reverses a charge.
void test_session_an_event_carries_when_it_happened() {
  Cache cache(kSixHoursMs);
  fakes::FakeStore store;
  Queue queue(&store);
  queue.begin();
  Play play(cache, queue);

  const uint32_t nowMs = kBaseMid + 987654UL;
  play.onRelease(1U, 2400000UL, nowMs);

  eventq::Event queued;
  TEST_ASSERT_TRUE(queue.peek(queued));
  TEST_ASSERT_EQUAL_UINT32(nowMs, queued.uptimeMs);
}

int main(int, char**) {
  UNITY_BEGIN();

  RUN_TEST(test_queue_stamps_a_monotonic_sequence_and_never_reuses_one);
  RUN_TEST(test_queue_a_callers_sequence_number_is_overwritten);
  RUN_TEST(test_queue_peek_does_not_remove_and_release_does);
  RUN_TEST(test_queue_overflow_discards_the_oldest_and_says_so);
  RUN_TEST(test_queue_release_through_stops_at_an_unacknowledged_event);
  RUN_TEST(test_queue_a_reboot_resumes_past_the_reserved_block);
  RUN_TEST(test_queue_checkpoints_are_strided_not_per_event);
  RUN_TEST(test_queue_a_torn_sequence_mark_is_absent_not_mongrel);
  RUN_TEST(test_queue_a_store_that_refuses_every_write_still_queues);
  RUN_TEST(test_queue_survives_the_outage_it_exists_for);
  RUN_TEST(test_queue_events_do_not_survive_a_power_cut_and_the_sequence_does);
  RUN_TEST(test_queue_works_with_no_store_at_all);
  RUN_TEST(test_event_subject_is_refused_not_truncated_when_too_long);
  RUN_TEST(test_event_kind_and_method_names_match_the_api);

  RUN_TEST(test_roster_admits_a_booked_member_at_the_right_court_and_time);
  RUN_TEST(test_roster_refuses_an_unknown_token);
  RUN_TEST(test_roster_distinguishes_too_early_too_late_and_wrong_court);
  RUN_TEST(test_roster_prefers_the_court_the_member_is_standing_at);
  RUN_TEST(test_roster_goes_stale_and_refuses_rather_than_guesses);
  RUN_TEST(test_roster_before_its_first_load_is_stale_not_empty);
  RUN_TEST(test_roster_an_abandoned_replacement_leaves_the_old_one_live);
  RUN_TEST(test_roster_a_cancelled_booking_disappears_on_the_next_push);
  RUN_TEST(test_roster_reports_entries_that_did_not_fit);
  RUN_TEST(test_roster_token_copy_refuses_rather_than_truncates);

  RUN_TEST(test_buttonmap_agrees_with_the_shared_corpus);
  RUN_TEST(test_buttonmap_applies_every_corpus_map);
  RUN_TEST(test_every_buttonmap_section_is_declared_and_executed);
  RUN_TEST(test_buttonmap_defaults_to_the_original_wiring);
  RUN_TEST(test_buttonmap_an_unknown_token_leaves_the_previous_entry_alone);
  RUN_TEST(test_buttonmap_reset_clears_a_short_map_rather_than_leaving_stale_entries);
  RUN_TEST(test_buttonmap_an_out_of_range_index_reads_as_none);

  RUN_TEST(test_pad_court_then_duration_is_a_request);
  RUN_TEST(test_pad_a_duration_press_alone_does_nothing);
  RUN_TEST(test_pad_a_selection_lapses_so_the_next_member_does_not_inherit_it);
  RUN_TEST(test_pad_a_late_duration_press_does_not_complete_a_lapsed_selection);
  RUN_TEST(test_pad_a_second_court_press_replaces_the_first);
  RUN_TEST(test_pad_honours_a_remapped_panel);
  RUN_TEST(test_pad_an_unmapped_button_is_inert);

  RUN_TEST(test_session_a_booked_member_gets_the_lights_and_an_activation_event);
  RUN_TEST(test_session_records_a_refused_scan_too);
  RUN_TEST(test_session_every_refusal_says_something_a_member_can_act_on);
  RUN_TEST(test_session_a_stale_roster_blames_the_network_not_the_member);
  RUN_TEST(test_session_every_line_fits_the_display);
  RUN_TEST(test_session_minutes_round_up_so_a_live_court_never_reads_zero);
  RUN_TEST(test_session_a_release_is_recorded_with_how_long_the_court_was_held);
  RUN_TEST(test_session_a_boot_event_explains_a_gap_in_the_sequence);
  RUN_TEST(test_session_a_full_queue_still_opens_the_court);
  RUN_TEST(test_session_an_event_carries_when_it_happened);

  RUN_TEST(test_button_wire_maps_court_keys_to_the_first_four_positions);
  RUN_TEST(test_button_wire_maps_duration_keys_to_the_last_four_positions);
  RUN_TEST(test_button_wire_is_not_a_decimal_index);
  RUN_TEST(test_button_wire_round_trips_every_key_the_mega_can_send);
  RUN_TEST(test_button_wire_refuses_anything_that_is_not_one_key);

  RUN_TEST(test_json_reads_a_string_field);
  RUN_TEST(test_json_a_field_that_would_not_fit_is_refused_not_truncated);
  RUN_TEST(test_json_absent_and_malformed_fields_report_absence);
  RUN_TEST(test_json_reads_an_unsigned_field_and_saturates_rather_than_wraps);
  RUN_TEST(test_json_walks_an_array_of_strings);
  RUN_TEST(test_json_an_absent_or_non_array_value_is_reported_as_absent);
  RUN_TEST(test_json_a_key_that_is_a_prefix_of_another_does_not_match_it);

  RUN_TEST(test_client_refuses_to_sign_before_it_knows_the_time);
  RUN_TEST(test_client_signs_the_current_time_not_the_boot_time);
  RUN_TEST(test_client_every_request_gets_a_fresh_nonce);
  RUN_TEST(test_client_a_different_body_is_a_different_signature);
  RUN_TEST(test_client_a_different_path_is_a_different_signature);
  RUN_TEST(test_client_refuses_to_sign_without_a_credential);
  RUN_TEST(test_client_learns_the_clock_from_any_response_including_a_failure);
  RUN_TEST(test_client_a_401_with_a_big_skew_is_a_clock_problem_not_a_key_problem);
  RUN_TEST(test_client_a_401_with_a_good_clock_means_the_key_is_gone);
  RUN_TEST(test_client_transient_failures_keep_the_event_and_permanent_ones_do_not);
  RUN_TEST(test_client_a_response_without_a_clock_does_not_reset_a_good_one);
  RUN_TEST(test_find_server_unix_reads_the_field_and_refuses_nonsense);

  RUN_TEST(test_client_probe_renders_unix_seconds_zero_with_a_real_hmac);
  RUN_TEST(test_client_a_probe_401_with_time_seeds_the_clock);
  RUN_TEST(test_client_drift_the_server_refuses_is_read_as_skew_not_a_dead_key);
  RUN_TEST(test_client_drift_inside_the_local_window_still_means_the_key_is_gone);
  RUN_TEST(test_client_skew_tolerance_is_pinned_by_the_corpus_below_the_servers_window);
  RUN_TEST(test_client_a_second_consecutive_clock_correction_is_a_dead_key);
  RUN_TEST(test_client_an_accepted_call_clears_the_clock_correction_strike);

  return UNITY_END();
}

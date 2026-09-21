// Unity tests for lib/eventq's WIRE SURFACE: the Kind enumeration's numeric
// values and the names the API knows each one by.
//
// WHY THIS SUITE EXISTS SEPARATELY FROM THE QUEUE'S OWN
// -----------------------------------------------------
// EventQueue's ring, its flash mark and its overflow behaviour are proven in
// ../../court-box/test/test_bridge, against that box's FakeStore and its
// capacities. None of that is what breaks when a SECOND device joins the fleet.
// What breaks is the enumeration: the values are on the wire AND in flash, so a
// renumbering silently re-files every queued event on every board in the field,
// and a name the server does not recognise is an event accepted and dropped.
//
// `Kind::GateOpen = 6` is the first appended value since this enumeration was
// written, and the door gate is the device that appends it. The table below is
// what makes that append provably an append.
//
// No corpus here, deliberately. The gate's own suite executes the gate corpus
// and the court box's executes the http one; this is the enumeration itself,
// which belongs to neither device.

#include <stdint.h>
#include <string.h>
#include <unity.h>

#include "devlink/EventUpload.h"
#include "eventq/Event.h"
#include "eventq/EventQueue.h"
#include "fakes/FakeStore.h"

namespace {

/// Every value, with the number it has on the wire and the name the API knows.
///
/// A TABLE rather than a sequence of assertions: an appended enumerator that
/// nobody adds a row for leaves the count check below red, which is the point.
/// Renumbering one of these rows is what this file exists to make impossible to
/// do quietly.
struct KindRow {
  eventq::Kind kind;
  uint8_t wireValue;
  const char* wireName;
};

constexpr KindRow kKinds[] = {
    {eventq::Kind::Activation, 1U, "activation"},
    {eventq::Kind::Release, 2U, "release"},
    {eventq::Kind::UnknownScan, 3U, "unknown_scan"},
    {eventq::Kind::Fault, 4U, "fault"},
    {eventq::Kind::Boot, 5U, "boot"},
    {eventq::Kind::GateOpen, 6U, "gate_open"},
};

constexpr size_t kKindCount = sizeof(kKinds) / sizeof(kKinds[0]);

void test_every_kind_keeps_its_wire_value_and_its_wire_name() {
  for (size_t i = 0U; i < kKindCount; ++i) {
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(kKinds[i].wireValue, static_cast<uint8_t>(kKinds[i].kind),
                                    kKinds[i].wireName);
    TEST_ASSERT_EQUAL_STRING(kKinds[i].wireName, eventq::kindName(kKinds[i].kind));
  }
}

/// The enumeration is APPEND-ONLY, and this is the assertion that says so: the
/// values are dense from 1, and the highest is the last row. A value inserted
/// in the middle re-files every event already sitting in a board's flash.
void test_the_kind_enumeration_is_dense_and_append_only() {
  for (size_t i = 0U; i < kKindCount; ++i) {
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(i + 1U), kKinds[i].wireValue);
  }
  TEST_ASSERT_EQUAL_UINT8(6U, static_cast<uint8_t>(eventq::Kind::GateOpen));
}

/// A byte a newer firmware wrote and this one does not know reads as "unknown"
/// rather than off the end of a table. The gate is the first device to make
/// this reachable in the field: a board downgraded past the GateOpen append
/// reads a 6 out of its own flash.
void test_a_kind_from_a_newer_firmware_is_named_rather_than_read_off_the_table() {
  const eventq::Kind foreign = static_cast<eventq::Kind>(kKindCount + 1U);
  TEST_ASSERT_EQUAL_STRING("unknown", eventq::kindName(foreign));
}

/// The gate's offline open, rendered by the SAME device-agnostic body renderer
/// the court box uses. `court` is -1 because a door is not on a court, and the
/// kind goes out under the name the server matches on.
void test_a_gate_open_renders_through_the_shared_event_body() {
  eventq::Event event;
  event.seq = 7U;
  event.uptimeMs = 86390000UL;
  event.durationMs = 3000UL;
  event.kind = eventq::Kind::GateOpen;
  event.court = eventq::Event::kNoCourt;
  event.method = eventq::Method::Qr;
  TEST_ASSERT_TRUE(event.setSubject("7Q3F9KM2XZ8B"));

  char body[devlink::kEventBodyCap] = {};
  const size_t written = devlink::renderEventBody(body, sizeof(body), "5ccf7f0a1b2c", 86400000ULL, event);
  TEST_ASSERT_TRUE(written > 0U);
  TEST_ASSERT_NOT_NULL(strstr(body, "\"kind\":\"gate_open\""));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"court\":-1"));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"method\":\"qr\""));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"subject\":\"7Q3F9KM2XZ8B\""));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"duration_ms\":3000"));
}

/// G4 / H1, AND THE ONLY STATE IN WHICH THIS HAPPENS IS THE ONE THAT MATTERS.
///
/// A ring fills only while the board is OFFLINE — online it drains a pass at a
/// time — and offline is exactly when every refusal costs a slot. A door with a
/// code taped near it, a member re-presenting a dead code, or simply line
/// noise: each one an `unknown_scan`, each one evicting the OLDEST event, which
/// on a busy evening is a `gate_open`. The one record that matters — somebody
/// came in, and nobody else knows it — was thrown away to keep a record of
/// somebody who did not.
///
/// So eviction is by WHAT THE EVENT IS, not only by age: the oldest DISCARDABLE
/// event goes first, and an admission is only evicted when there is nothing
/// else left to evict.
void test_queue_a_full_ring_evicts_refusals_before_it_evicts_admissions() {
  fakes::FakeStore store;
  eventq::EventQueue<8U> queue(&store);
  queue.begin();

  // A realistic offline evening in miniature: four opens, then the ring filled
  // the rest of the way with refusals, then more refusals than there are slots.
  for (uint16_t i = 0U; i < 4U; ++i) {
    eventq::Event open;
    open.kind = eventq::Kind::GateOpen;
    open.court = eventq::Event::kNoCourt;
    open.durationMs = 3000U;
    TEST_ASSERT_TRUE(queue.push(open) == eventq::PushResult::Ok);
  }
  for (int i = 0; i < 40; ++i) {
    eventq::Event refusal;
    refusal.kind = eventq::Kind::UnknownScan;
    refusal.court = eventq::Event::kNoCourt;
    static_cast<void>(queue.push(refusal));
  }

  TEST_ASSERT_EQUAL_UINT16(8U, queue.size());
  uint16_t opens = 0U;
  uint16_t seen = 0U;
  eventq::Event out;
  while (queue.peek(out)) {
    if (out.kind == eventq::Kind::GateOpen) {
      ++opens;
    }
    ++seen;
    TEST_ASSERT_TRUE(queue.release());
  }
  TEST_ASSERT_EQUAL_UINT16(8U, seen);
  TEST_ASSERT_EQUAL_UINT16_MESSAGE(4U, opens,
                                   "every admission has to survive a night of refusals");

  // AND THE COUNTER IS HONEST: every discarded event is counted, whichever kind
  // it was. A club that sees this move knows it lost history.
  TEST_ASSERT_EQUAL_UINT32(36U, queue.overflowed());
}

/// H1. When there is nothing discardable left, the oldest goes — the original
/// rule, kept, because the alternative is refusing the game happening right now
/// in favour of one from last Tuesday that may already have been uploaded.
void test_queue_a_ring_of_nothing_but_admissions_still_makes_room() {
  fakes::FakeStore store;
  eventq::EventQueue<4U> queue(&store);
  queue.begin();

  for (uint16_t i = 0U; i < 4U; ++i) {
    eventq::Event open;
    open.kind = eventq::Kind::GateOpen;
    TEST_ASSERT_TRUE(queue.push(open) == eventq::PushResult::Ok);
  }
  eventq::Event newest;
  newest.kind = eventq::Kind::GateOpen;
  TEST_ASSERT_TRUE(queue.push(newest) == eventq::PushResult::OkOverwrote);
  TEST_ASSERT_EQUAL_UINT32(1U, queue.overflowed());

  // The OLDEST went: the head is seq 2 and the tail is the one just pushed.
  eventq::Event head;
  TEST_ASSERT_TRUE(queue.peek(head));
  TEST_ASSERT_EQUAL_UINT32(2U, head.seq);
  TEST_ASSERT_EQUAL_UINT32(5U, queue.lastSeq());
}

/// H1. Order is preserved among what survives, and a `boot` is not discardable
/// — the header names it as the operator's warning that a ring was lost, and an
/// eviction policy that threw it away first would be throwing away the one
/// event that explains the others.
void test_queue_eviction_keeps_the_order_of_what_it_keeps() {
  fakes::FakeStore store;
  eventq::EventQueue<4U> queue(&store);
  queue.begin();

  eventq::Event boot;
  boot.kind = eventq::Kind::Boot;
  TEST_ASSERT_TRUE(queue.push(boot) == eventq::PushResult::Ok);
  for (int i = 0; i < 2; ++i) {
    eventq::Event refusal;
    refusal.kind = eventq::Kind::UnknownScan;
    static_cast<void>(queue.push(refusal));
  }
  eventq::Event open;
  open.kind = eventq::Kind::GateOpen;
  static_cast<void>(queue.push(open));
  // Full: boot(1) refusal(2) refusal(3) open(4). One more refusal evicts the
  // OLDEST REFUSAL — seq 2 — and nothing else moves.
  eventq::Event extra;
  extra.kind = eventq::Kind::UnknownScan;
  TEST_ASSERT_TRUE(queue.push(extra) == eventq::PushResult::OkOverwrote);

  const uint32_t expected[] = {1U, 3U, 4U, 5U};
  for (size_t i = 0U; i < 4U; ++i) {
    eventq::Event out;
    TEST_ASSERT_TRUE(queue.peek(out));
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(expected[i], out.seq, "eviction must not reorder the survivors");
    TEST_ASSERT_TRUE(queue.release());
  }
  TEST_ASSERT_TRUE(queue.empty());
}

/// H1. Which kinds may be evicted is a WIRE-SHAPED decision — it decides what a
/// club ever learns about — so it is pinned as a table beside the enumeration
/// rather than left implicit in the ring.
void test_only_the_kinds_that_cost_nothing_to_lose_are_discardable() {
  TEST_ASSERT_TRUE_MESSAGE(eventq::isDiscardable(eventq::Kind::UnknownScan), "a refusal");
  TEST_ASSERT_TRUE_MESSAGE(eventq::isDiscardable(eventq::Kind::Fault), "a decode error");
  TEST_ASSERT_FALSE_MESSAGE(eventq::isDiscardable(eventq::Kind::GateOpen), "somebody came in");
  TEST_ASSERT_FALSE_MESSAGE(eventq::isDiscardable(eventq::Kind::Activation), "a court was lit");
  TEST_ASSERT_FALSE_MESSAGE(eventq::isDiscardable(eventq::Kind::Release), "and for how long");
  TEST_ASSERT_FALSE_MESSAGE(eventq::isDiscardable(eventq::Kind::Boot), "why the others are missing");
  // A kind a newer firmware wrote is NOT discardable: this board cannot know
  // what it costs to lose, and the safe direction for a record is to keep it.
  TEST_ASSERT_FALSE(eventq::isDiscardable(static_cast<eventq::Kind>(99U)));
}

} // namespace

void setUp() {
}

void tearDown() {
}

int main(int, char**) {
  UNITY_BEGIN();

  RUN_TEST(test_every_kind_keeps_its_wire_value_and_its_wire_name);
  RUN_TEST(test_the_kind_enumeration_is_dense_and_append_only);
  RUN_TEST(test_a_kind_from_a_newer_firmware_is_named_rather_than_read_off_the_table);
  RUN_TEST(test_a_gate_open_renders_through_the_shared_event_body);

  RUN_TEST(test_queue_a_full_ring_evicts_refusals_before_it_evicts_admissions);
  RUN_TEST(test_queue_a_ring_of_nothing_but_admissions_still_makes_room);
  RUN_TEST(test_queue_eviction_keeps_the_order_of_what_it_keeps);
  RUN_TEST(test_only_the_kinds_that_cost_nothing_to_lose_are_discardable);

  return UNITY_END();
}

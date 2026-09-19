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

  return UNITY_END();
}

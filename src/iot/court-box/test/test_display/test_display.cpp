// The court box's glass against the display/ corpus (v3): every landing,
// marquee and screen-CRC vector in src/contracts/device-protocol/display/
// executed against the Mega's composer (courtlogic::Glass), its marquee and
// the CRC both chips compute (proto::ScreenCrc), with executed == declared.
//
// Read at test time from the JSON (support/CorpusJson.h) rather than through
// a generated header: a vector added to the corpus is a vector this suite runs
// on its next execution.

#include <stdio.h>
#include <string.h>
#include <unity.h>

#include "courtlogic/Glass.h"
#include "protocol/ScreenCrc.h"
#include "support/CorpusJson.h"

using courtlogic::GlassRows;
using courtlogic::LandCourt;
using courtlogic::LandingInput;
using courtlogic::LandStatus;
using courtlogic::Layout;

namespace {

corpus::File g_cases;
corpus::File g_manifest;
size_t g_landing = 0U;
size_t g_marquee = 0U;
size_t g_crc = 0U;

char g_text[512];

const char* str(const char* object, const char* name) {
  const char* v = corpus::member(object, name);
  if (v == nullptr || !corpus::stringValue(v, g_text, sizeof(g_text), nullptr)) {
    return nullptr;
  }
  return g_text;
}

bool isNull(const char* value) {
  return value != nullptr && strncmp(value, "null", 4) == 0;
}

bool boolOf(const char* value) {
  return value != nullptr && strncmp(value, "true", 4) == 0;
}

LandStatus statusOf(const char* s) {
  if (strcmp(s, "starting") == 0) {
    return LandStatus::Starting;
  }
  if (strcmp(s, "no_wifi") == 0) {
    return LandStatus::NoWifi;
  }
  if (strcmp(s, "no_server") == 0) {
    return LandStatus::NoServer;
  }
  if (strcmp(s, "offline") == 0) {
    return LandStatus::Offline;
  }
  TEST_ASSERT_EQUAL_STRING("ready", s);
  return LandStatus::Ready;
}

void runLanding(const char* c) {
  char id[64];
  TEST_ASSERT_NOT_NULL(str(c, "id"));
  snprintf(id, sizeof(id), "%s", g_text);
  const char* in = corpus::member(c, "input");
  TEST_ASSERT_NOT_NULL_MESSAGE(in, id);

  LandingInput input;
  TEST_ASSERT_NOT_NULL_MESSAGE(str(in, "layout"), id);
  input.layout = strcmp(g_text, "expanded") == 0 ? Layout::Expanded : Layout::Compact;
  input.marquee = boolOf(corpus::member(in, "marquee"));
  TEST_ASSERT_NOT_NULL_MESSAGE(str(in, "status"), id);
  input.status = statusOf(g_text);
  char clock[8] = {0};
  const char* clockValue = corpus::member(in, "clock");
  if (!isNull(clockValue)) {
    TEST_ASSERT_TRUE(corpus::stringValue(clockValue, clock, sizeof(clock), nullptr));
  }
  input.clock = isNull(clockValue) ? nullptr : clock;
  char note[32] = {0};
  const char* noteValue = corpus::member(in, "note");
  if (!isNull(noteValue)) {
    TEST_ASSERT_TRUE(corpus::stringValue(noteValue, note, sizeof(note), nullptr));
  }
  input.note = isNull(noteValue) ? nullptr : note;
  input.page = static_cast<uint32_t>(corpus::unsignedValue(corpus::member(in, "page")));
  input.offset = static_cast<uint32_t>(corpus::unsignedValue(corpus::member(in, "offset")));

  LandCourt courts[4];
  uint8_t n = 0U;
  corpus::ArrayIter it(corpus::member(in, "courts"));
  const char* court = nullptr;
  while (it.next(&court) && n < 4U) {
    courts[n].number = static_cast<uint16_t>(corpus::unsignedValue(corpus::member(court, "number")));
    courts[n].lit = boolOf(corpus::member(court, "lit"));
    courts[n].seconds = static_cast<uint32_t>(corpus::unsignedValue(corpus::member(court, "seconds")));
    ++n;
  }
  input.courts = courts;
  input.courtCount = n;

  GlassRows rows;
  courtlogic::composeLanding(input, rows);

  corpus::ArrayIter want(corpus::member(c, "rows"));
  const char* row = nullptr;
  uint8_t r = 0U;
  while (want.next(&row)) {
    char expect[32];
    TEST_ASSERT_TRUE(corpus::stringValue(row, expect, sizeof(expect), nullptr));
    TEST_ASSERT_TRUE_MESSAGE(r < courtlogic::kGlassRows, id);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(expect, rows[r], id);
    ++r;
  }
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(courtlogic::layoutRows(input.layout), r, id);
  ++g_landing;
}

void runMarquee(const char* c) {
  char id[64];
  TEST_ASSERT_NOT_NULL(str(c, "id"));
  snprintf(id, sizeof(id), "%s", g_text);
  char text[64];
  TEST_ASSERT_TRUE(corpus::stringValue(corpus::member(c, "text"), text, sizeof(text), nullptr));
  const uint8_t width = static_cast<uint8_t>(corpus::unsignedValue(corpus::member(c, "width")));
  const uint32_t offset = static_cast<uint32_t>(corpus::unsignedValue(corpus::member(c, "offset")));
  char window[32];
  TEST_ASSERT_TRUE(corpus::stringValue(corpus::member(c, "window"), window, sizeof(window), nullptr));
  char got[32];
  courtlogic::marqueeWindow(text, width, offset, got);
  TEST_ASSERT_EQUAL_STRING_MESSAGE(window, got, id);
  ++g_marquee;
}

void runCrc(const char* c) {
  char id[64];
  TEST_ASSERT_NOT_NULL(str(c, "id"));
  snprintf(id, sizeof(id), "%s", g_text);
  const char* rows = corpus::member(c, "rows");
  uint16_t crc = proto::kCrc16Init;
  uint8_t mask = 0U;
  corpus::ObjectIter it(rows);
  char name[8];
  const char* value = nullptr;
  while (it.next(name, sizeof(name), &value)) {
    char text[64];
    TEST_ASSERT_TRUE(corpus::stringValue(value, text, sizeof(text), nullptr));
    const uint8_t row = static_cast<uint8_t>(name[0] - '0');
    crc = proto::screenCrcRow(crc, row, text);
    mask = static_cast<uint8_t>(mask | (1U << row));
  }
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(static_cast<uint8_t>(corpus::unsignedValue(corpus::member(c, "mask"))),
                                  mask, id);
  char hex[8];
  snprintf(hex, sizeof(hex), "%04X", crc);
  TEST_ASSERT_NOT_NULL(str(c, "crc"));
  TEST_ASSERT_EQUAL_STRING_MESSAGE(g_text, hex, id);
  ++g_crc;
}

void runFamily(const char* name, void (*run)(const char*)) {
  corpus::ArrayIter it(corpus::member(g_cases.root(), name));
  const char* c = nullptr;
  while (it.next(&c)) {
    run(c);
  }
}

size_t declared(const char* name) {
  return static_cast<size_t>(
      corpus::unsignedValue(corpus::member(corpus::member(g_manifest.root(), "case_count"), name)));
}

} // namespace

void setUp(void) {
}

void tearDown(void) {
}

void test_the_published_crc_check_value(void) {
  uint16_t crc = proto::kCrc16Init;
  const char* check = "123456789";
  for (size_t i = 0U; check[i] != '\0'; ++i) {
    crc = proto::crc16Update(crc, static_cast<uint8_t>(check[i]));
  }
  TEST_ASSERT_EQUAL_HEX16(0x29B1U, crc);
}

void test_every_landing_vector(void) {
  runFamily("landing", runLanding);
}

void test_every_marquee_vector(void) {
  runFamily("marquee", runMarquee);
}

void test_every_screen_crc_vector(void) {
  runFamily("screen_crc", runCrc);
}

void test_executed_equals_declared(void) {
  TEST_ASSERT_EQUAL_size_t(declared("landing"), g_landing);
  TEST_ASSERT_EQUAL_size_t(declared("marquee"), g_marquee);
  TEST_ASSERT_EQUAL_size_t(declared("screen_crc"), g_crc);
  TEST_ASSERT_TRUE(g_landing > 0U && g_marquee > 0U && g_crc > 0U);
}

void test_minutes_round_up_and_cap(void) {
  TEST_ASSERT_EQUAL_UINT32(0U, courtlogic::minutesShown(0U));
  TEST_ASSERT_EQUAL_UINT32(1U, courtlogic::minutesShown(1U));
  TEST_ASSERT_EQUAL_UINT32(1U, courtlogic::minutesShown(60U));
  TEST_ASSERT_EQUAL_UINT32(2U, courtlogic::minutesShown(61U));
  TEST_ASSERT_EQUAL_UINT32(999U, courtlogic::minutesShown(86400U));
}

int main(int, char**) {
  UNITY_BEGIN();
  if (!g_cases.load("display", "cases.json") || !g_manifest.load("display", "manifest.json")) {
    TEST_FAIL_MESSAGE("the display corpus is missing");
  }
  RUN_TEST(test_the_published_crc_check_value);
  RUN_TEST(test_every_landing_vector);
  RUN_TEST(test_every_marquee_vector);
  RUN_TEST(test_every_screen_crc_vector);
  RUN_TEST(test_executed_equals_declared);
  RUN_TEST(test_minutes_round_up_and_cap);
  return UNITY_END();
}

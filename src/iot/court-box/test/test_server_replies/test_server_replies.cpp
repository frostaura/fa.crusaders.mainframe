// The server's REAL replies to a court box, through the bridge's REAL parsers
// (docs/specs/device-api.md section 11.5, FC-9).
//
// The http/ corpus pins bytes somebody wrote down; it cannot notice the server
// starting to send something else. `make device-replay-check` closes the gap:
// the backend's DeviceReplyEmitterTests drive the real endpoints through a
// scenario matrix and write each reply with what the server knows it sent; this
// suite reads every court_box file the index names and feeds the body through
// the code the bridge runs on it — the snapshot, the court list, the roster,
// the member-code sync, the Mega settings, the activate / walk-up / extend /
// events readers — and asserts the body fits the buffer it lands in, nothing
// drifted, and every value the server sent was adopted.
//
// The lifeline objects (`key_next`, `net`) are read by the SHARED reader
// (devnet) every v3 board's lifeline is built on, so a server
// change no frozen reader could follow goes red here before any club's box sees
// it.
//
// Without DEVICE_REPLAY_DIR this suite passes with a message: the corpus suites
// cover the box on their own, and only the replay target has the server.

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unity.h>

#include "bridgelogic/Extend.h"
#include "bridgelogic/MemberScan.h"
#include "bridgelogic/ScanFlow.h"
#include "bridgelogic/V3Heartbeat.h"
#include "bridgelogic/WalkUp.h"
#include "devapi/Json.h"
#include "devlink/CodeSync.h"
#include "devlink/RosterSync.h"
#include "devnet/Net.h"
#include "memcode/KeyRing.h"
#include "roster/Roster.h"
#include "support/CorpusJson.h"

namespace {

using Cache = roster::Roster<devlink::kMaxRosterEntries>;

constexpr size_t kFileCap = 65536U;
constexpr size_t kReplyBodyCap = 512U; // activate / walk-up / extend share one buffer (FC-5)
constexpr size_t kEventsBodyCap = 192U;
char g_index[kFileCap];
char g_file[kFileCap];
char g_body[16384];

bool readFile(const char* path, char* out, size_t cap) {
  FILE* f = fopen(path, "rb");
  if (f == nullptr) {
    return false;
  }
  const size_t n = fread(out, 1U, cap - 1U, f);
  const bool more = fgetc(f) != EOF;
  fclose(f);
  if (more) {
    return false;
  }
  out[n] = '\0';
  return true;
}

int nibble(char c) {
  return (c >= '0' && c <= '9') ? c - '0' : ((c >= 'a' && c <= 'f') ? c - 'a' + 10 : -1);
}

size_t hexBody(const char* object) {
  const char* v = corpus::member(object, "body_hex");
  TEST_ASSERT_NOT_NULL_MESSAGE(v, "body_hex");
  v = corpus::skipWs(v);
  TEST_ASSERT_EQUAL_CHAR('"', v[0]);
  size_t len = 0U;
  for (const char* p = v + 1; *p != '"'; p += 2) {
    const int hi = nibble(p[0]);
    const int lo = nibble(p[1]);
    TEST_ASSERT_TRUE(hi >= 0 && lo >= 0);
    TEST_ASSERT_TRUE(len + 1U < sizeof(g_body));
    g_body[len] = static_cast<char>((hi << 4) | lo);
    ++len;
  }
  g_body[len] = '\0';
  return len;
}

void text(const char* object, const char* name, char* out, size_t cap) {
  const char* v = corpus::member(object, name);
  TEST_ASSERT_NOT_NULL_MESSAGE(v, name);
  TEST_ASSERT_TRUE_MESSAGE(corpus::stringValue(v, out, cap, nullptr), name);
}

bool flag(const char* v) {
  return corpus::skipWs(v)[0] == 't';
}

/// The Mega setting each server config key becomes, for the keys whose value
/// carries straight across (a number, or a bool as 0/1). The rest are read by the
/// bridge itself (slice, grace, walk-up cap, button map) or mapped through a
/// vocabulary (layout, relay level, line end) and checked below.
struct DirectKey {
  const char* server;
  const char* mega;
};

constexpr DirectKey kDirect[] = {
    {"lcd_marquee_step_ms", "STEP"},
    {"lcd_landing_page_seconds", "PAGE"},
    {"lcd_screen_ceiling_seconds", "CEIL"},
    {"lcd_landing_dwell_seconds", "DWELL"},
    {"lcd_after_lights_on_seconds", "AFTON"},
    {"lcd_reinit_seconds", "REINIT"},
    {"relay_authorisation_cap_minutes", "CAP"},
    {"hw_scanner_gap_ms", "SGAP"},
};

void checkConfig(const char* file, const char* body, size_t len, const char* expect) {
  bridgelogic::Drift drift;
  bridgelogic::MegaConfig cfg;
  bridgelogic::readMegaConfig(body, len, bridgelogic::defaultMegaConfig(), cfg, drift);
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(0U, drift.count, file);
  for (const DirectKey& k : kDirect) {
    const char* v = corpus::member(expect, k.server);
    if (v != nullptr) {
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(corpus::unsignedValue(v), bridgelogic::cfgValue(cfg, k.mega, 0xFFFFU),
                                       k.server);
    }
  }
  const char* marquee = corpus::member(expect, "lcd_marquee_enabled");
  if (marquee != nullptr) {
    TEST_ASSERT_EQUAL_UINT16_MESSAGE(flag(marquee) ? 1U : 0U, bridgelogic::cfgValue(cfg, "MARQ", 0xFFFFU),
                                     file);
  }
  const char* layout = corpus::member(expect, "lcd_layout");
  if (layout != nullptr) {
    char want[16] = {};
    TEST_ASSERT_TRUE(corpus::stringValue(layout, want, sizeof(want), nullptr));
    TEST_ASSERT_EQUAL_MESSAGE(strcmp(want, "expanded") == 0, cfg.expanded, file);
  }
}

void checkCourts(const char* file, const char* body, size_t len, const char* expected) {
  bridgelogic::Snapshot snap;
  TEST_ASSERT_TRUE_MESSAGE(
      bridgelogic::readSnapshot(body, len, snap, 1000U) == bridgelogic::ReadResult::Adopted, file);
  size_t i = 0U;
  const char* element = nullptr;
  corpus::ArrayIter it(expected);
  while (it.next(&element)) {
    char want[64] = {};
    TEST_ASSERT_TRUE(corpus::stringValue(element, want, sizeof(want), nullptr));
    TEST_ASSERT_TRUE_MESSAGE(i < snap.count, file);
    const bridgelogic::SnapshotCourt& c = snap.courts[i];
    char got[64] = {};
    snprintf(got, sizeof(got), "%u|%u|%lu|%c|%s", static_cast<unsigned>(c.relay), c.lit ? 1U : 0U,
             static_cast<unsigned long>(c.seconds), c.kind, c.ref[0] == '\0' ? "-" : c.ref);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(want, got, file);
    ++i;
  }
  TEST_ASSERT_EQUAL_size_t_MESSAGE(i, snap.count, file);
}

void checkHeartbeat(const char* file, uint16_t status, const char* body, size_t len, const char* expect) {
  TEST_ASSERT_EQUAL_UINT16_MESSAGE(200U, status, file);
  // §11.4: every server maximum is at most 80% of the board's buffer.
  TEST_ASSERT_TRUE_MESSAGE(len * 5U <= bridgelogic::kHeartbeatResponseCap * 4U, file);
  TEST_ASSERT_TRUE_MESSAGE(devapi::json::isCompleteObject(body, len), file);

  char name[corpus::kMaxNameLen] = {};
  const char* value = nullptr;
  corpus::ObjectIter it(expect);
  while (it.next(name, sizeof(name), &value)) {
    if (strcmp(name, "court_numbers") == 0) {
      int16_t courts[devlink::kMaxCourts] = {};
      uint8_t count = 0U;
      TEST_ASSERT_TRUE_MESSAGE(devlink::parseCourtNumbers(body, len, courts, count), file);
      uint8_t i = 0U;
      const char* n = nullptr;
      corpus::ArrayIter numbers(value);
      while (numbers.next(&n)) {
        TEST_ASSERT_TRUE_MESSAGE(i < count, file);
        TEST_ASSERT_EQUAL_INT16_MESSAGE(static_cast<int16_t>(corpus::unsignedValue(n)), courts[i], file);
        ++i;
      }
      TEST_ASSERT_EQUAL_UINT8_MESSAGE(i, count, file);
    } else if (strcmp(name, "courts") == 0) {
      checkCourts(file, body, len, value);
    } else if (strcmp(name, "config") == 0) {
      checkConfig(file, body, len, value);
    } else if (strcmp(name, "roster_count") == 0) {
      // On the heap: the roster is the box's whole 2.x table, too big for a test frame.
      Cache* cache = new Cache(6UL * 60UL * 60UL * 1000UL);
      const devlink::SyncResult r = devlink::applyRoster(body, len, *cache, 1000U);
      delete cache;
      TEST_ASSERT_TRUE_MESSAGE(r.replaced, file);
      TEST_ASSERT_EQUAL_UINT8_MESSAGE(0U, r.rejected, file);
      TEST_ASSERT_EQUAL_UINT8_MESSAGE(0U, r.dropped, file);
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(corpus::unsignedValue(value), r.accepted, file);
    } else if (strcmp(name, "code_keys_count") == 0) {
      static memcode::StepClock clock(6UL * 60UL * 60UL * 1000UL);
      static memcode::KeyRing<bridgelogic::kCourtKeyRingSlots> ring;
      const devlink::CodeSyncResult r = devlink::applyCodeSync(body, len, clock, ring, 1000U);
      TEST_ASSERT_TRUE_MESSAGE(r.keysReplaced, file);
      TEST_ASSERT_EQUAL_UINT8_MESSAGE(0U, r.rejected, file);
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(corpus::unsignedValue(value), r.accepted, file);
    } else if (strcmp(name, "key_next") == 0) {
      size_t objLen = 0U;
      const size_t at = devapi::json::findTopLevelObject(body, len, "key_next", objLen);
      TEST_ASSERT_NOT_EQUAL_MESSAGE(devapi::json::kNotFound, at, file);
      devnet::KeyRing ring;
      memcpy(ring.currentId, "k0", 3U);
      ring.currentKey[0] = '-';
      devnet::KeyRing next;
      TEST_ASSERT_TRUE_MESSAGE(
          devnet::adoptKeyNext(body + at - 1U, objLen + 2U, ring, next) == devnet::Refusal::Ok, file);
      char want[16] = {};
      text(value, "id", want, sizeof(want));
      TEST_ASSERT_EQUAL_STRING_MESSAGE(want, next.currentId, file);
    } else if (strcmp(name, "net") == 0) {
      size_t objLen = 0U;
      const size_t at = devapi::json::findTopLevelObject(body, len, "net", objLen);
      TEST_ASSERT_NOT_EQUAL_MESSAGE(devapi::json::kNotFound, at, file);
      devnet::NetSet net;
      TEST_ASSERT_TRUE_MESSAGE(devnet::adoptNet(body + at - 1U, objLen + 2U, 0U, net).adopted(), file);
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(corpus::unsignedValue(corpus::member(value, "ver")), net.ver, file);
    } else {
      TEST_FAIL_MESSAGE("a court-box heartbeat expectation this suite does not know how to check");
    }
  }
}

void checkActivate(const char* file, uint16_t status, const char* body, size_t len, const char* expect) {
  TEST_ASSERT_TRUE_MESSAGE(len * 5U <= kReplyBodyCap * 3U, file); // server at most 300 of 512 (FC-6)
  const int16_t numbers[devlink::kMaxCourts] = {1, 2, 3, 4};
  bridgelogic::ScanFlow flow;
  const bridgelogic::ActivationResult r = flow.onActivateResponse(status, body, len, numbers, 4U);
  TEST_ASSERT_FALSE_MESSAGE(r.fallbackToRoster, file);
  const char* activated = corpus::member(expect, "activated");
  if (activated != nullptr && flag(activated)) {
    const char* granted = corpus::member(expect, "granted_seconds");
    TEST_ASSERT_NOT_NULL_MESSAGE(granted, file);
    TEST_ASSERT_TRUE_MESSAGE(r.playRemainingSeconds >= corpus::unsignedValue(granted), file);
  }
}

void checkWalkUpOrExtend(const char* file, const char* endpoint, uint16_t status, const char* body,
                         size_t len) {
  TEST_ASSERT_TRUE_MESSAGE(len * 5U <= kReplyBodyCap * 3U, file);
  if (strcmp(endpoint, "walkup") == 0) {
    const bridgelogic::WalkUpResult r = bridgelogic::onWalkUpResponse(status, body, len, 0U, 60U);
    TEST_ASSERT_TRUE_MESSAGE(r.decided, file);
  } else {
    const bridgelogic::ExtendResult r = bridgelogic::onExtendResponse(status, body, len);
    TEST_ASSERT_TRUE_MESSAGE(r.decided, file);
  }
}

void checkEvents(const char* file, uint16_t status, const char* body, size_t len, const char* expect) {
  TEST_ASSERT_TRUE_MESSAGE(status >= 200U && status < 300U, file);
  TEST_ASSERT_TRUE_MESSAGE(len * 2U <= kEventsBodyCap, file); // at most 96 of 192 (FC-5)
  uint32_t through = 0U;
  TEST_ASSERT_TRUE_MESSAGE(devapi::json::topLevelUnsignedField(body, len, "accepted_through", through), file);
  const char* want = corpus::member(expect, "accepted_through");
  if (want != nullptr) {
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(corpus::unsignedValue(want), through, file);
  }
}

void test_every_server_reply_for_a_court_box_is_read_whole_by_the_bridge() {
  const char* dir = getenv("DEVICE_REPLAY_DIR");
  if (dir == nullptr || dir[0] == '\0') {
    TEST_PASS_MESSAGE(
        "DEVICE_REPLAY_DIR is not set: run `make device-replay-check` to feed the server's replies");
    return;
  }
  char path[1024];
  snprintf(path, sizeof(path), "%s/index.json", dir);
  TEST_ASSERT_TRUE_MESSAGE(readFile(path, g_index, sizeof(g_index)), "DEVICE_REPLAY_DIR has no index.json");
  const size_t declared = static_cast<size_t>(corpus::unsignedValue(corpus::member(g_index, "count")));
  corpus::ArrayIter files(corpus::member(g_index, "files"));
  const char* f = nullptr;
  size_t listed = 0U;
  size_t ours = 0U;
  while (files.next(&f)) {
    ++listed;
    char rel[512] = {};
    TEST_ASSERT_TRUE(corpus::stringValue(f, rel, sizeof(rel), nullptr));
    snprintf(path, sizeof(path), "%s/%s", dir, rel);
    TEST_ASSERT_TRUE_MESSAGE(readFile(path, g_file, sizeof(g_file)), rel);
    char device[24] = {};
    text(g_file, "device", device, sizeof(device));
    if (strcmp(device, "court_box") != 0) {
      continue;
    }
    char endpoint[24] = {};
    text(g_file, "endpoint", endpoint, sizeof(endpoint));
    const uint16_t status = static_cast<uint16_t>(corpus::unsignedValue(corpus::member(g_file, "status")));
    const size_t len = hexBody(g_file);
    const char* expect = corpus::member(g_file, "expect");
    TEST_ASSERT_NOT_NULL_MESSAGE(expect, rel);
    if (strcmp(endpoint, "heartbeat") == 0) {
      checkHeartbeat(rel, status, g_body, len, expect);
    } else if (strcmp(endpoint, "activate") == 0) {
      checkActivate(rel, status, g_body, len, expect);
    } else if (strcmp(endpoint, "walkup") == 0 || strcmp(endpoint, "extend") == 0) {
      checkWalkUpOrExtend(rel, endpoint, status, g_body, len);
    } else if (strcmp(endpoint, "events") == 0) {
      checkEvents(rel, status, g_body, len, expect);
    } else if (strcmp(endpoint, "pay-for") == 0) {
      // D10 left this image (BR-17): the server keeps the route, the box never calls it.
      continue;
    } else {
      TEST_FAIL_MESSAGE("a court-box reply for an endpoint this bridge never calls");
    }
    ++ours;
  }
  TEST_ASSERT_EQUAL_size_t_MESSAGE(declared, listed, "the index declares more files than it lists");
  TEST_ASSERT_TRUE_MESSAGE(ours > 0U, "the emitter wrote no court_box reply at all");
}

} // namespace

void setUp() {
}

void tearDown() {
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_every_server_reply_for_a_court_box_is_read_whole_by_the_bridge);
  return UNITY_END();
}

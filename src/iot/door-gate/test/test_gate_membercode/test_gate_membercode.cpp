// The door gate against the member-code corpus — every case in
// src/contracts/device-protocol/membercode/gate.json, executed and counted:
// the capability on its heartbeat, the scan and event bodies that carry a v1
// code, the widest heartbeat answer the contract allows, and what the door
// decides OFFLINE with a v1 code — the organiser and an accepted partner each
// admitted with their own code, a replay refused, a stranger not recognised,
// a booking not yet open too early, and a sync too old to trust stale.
//
// The primitives and the verifier are proved in ../../shared/test/test_memcode;
// this proves the door's own renderers and its offline decision.

#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unity.h>

#include "devapi/Json.h"
#include "devlink/CodeSync.h"
#include "devlink/EventUpload.h"
#include "devlink/RosterSync.h"
#include "eventq/Event.h"
#include "gatelogic/GateApp.h"
#include "gatelogic/GateConfig.h"
#include "gatelogic/GateFlow.h"
#include "gatelogic/GateHeartbeat.h"
#include "memcode/KeyRing.h"
#include "memcode/ReplayRing.h"
#include "memcode/StepClock.h"
#include "memcode/Token.h"
#include "support/CorpusJson.h"

void setUp(void) {
}

void tearDown(void) {
}

namespace {

constexpr char kFamily[] = "membercode";
constexpr char kFile[] = "gate.json";

corpus::File g_gate;
corpus::File g_manifest;
size_t g_requestsRun = 0U;
size_t g_responsesRun = 0U;
size_t g_offlineRun = 0U;

using Keys = memcode::KeyRing<gatelogic::kGateKeyRingSlots>;
using Uses = memcode::ReplayRing<gatelogic::kGateReplaySlots>;

const char* array(const char* doc, const char* name) {
  const char* value = corpus::member(doc, name);
  TEST_ASSERT_NOT_NULL_MESSAGE(value, name);
  TEST_ASSERT_TRUE_MESSAGE(corpus::isArray(value), name);
  return value;
}

void text(const char* object, const char* name, char* out, size_t cap) {
  const char* value = corpus::member(object, name);
  TEST_ASSERT_NOT_NULL_MESSAGE(value, name);
  TEST_ASSERT_TRUE_MESSAGE(corpus::stringValue(value, out, cap, nullptr), name);
}

uint64_t number(const char* object, const char* name) {
  const char* value = corpus::member(object, name);
  TEST_ASSERT_NOT_NULL_MESSAGE(value, name);
  return corpus::unsignedValue(value);
}

bool flag(const char* object, const char* name) {
  const char* value = corpus::member(object, name);
  TEST_ASSERT_NOT_NULL_MESSAGE(value, name);
  return strncmp(corpus::skipWs(value), "true", 4) == 0;
}

const char* hexBody(const char* object, const char* field, size_t& len) {
  static uint8_t bytes[corpus::kMaxStringLen];
  static char out[corpus::kMaxStringLen + 1U];
  size_t n = 0U;
  TEST_ASSERT_TRUE_MESSAGE(corpus::hexField(object, field, bytes, sizeof(bytes), &n), field);
  memcpy(out, bytes, n);
  out[n] = '\0';
  len = n;
  return out;
}

void runRequest(const char* c) {
  char id[64] = {};
  text(c, "id", id, sizeof(id));
  size_t len = 0U;
  const char* expected = hexBody(c, "body_hex", len);
  const char* render = corpus::member(c, "render");
  TEST_ASSERT_NOT_NULL(render);
  char out[512] = {};
  size_t n = 0U;
  const char* mac = "5ccf7f0a1b2c";
  if (strncmp(id, "gate-heartbeat-request-caps", 27) == 0) {
    char version[16] = {};
    text(render, "firmware_version", version, sizeof(version));
    gatelogic::GateDiagnostics diagnostics = {static_cast<uint32_t>(number(render, "no_push")),
                                              static_cast<uint32_t>(number(render, "events_lost")), true};
    n = gatelogic::renderGateHeartbeatBody(out, sizeof(out), mac, version, number(render, "uptime_ms"),
                                           diagnostics);
  } else if (strcmp(id, "gate-scan-request-v1") == 0) {
    char token[32] = {};
    text(render, "token", token, sizeof(token));
    n = gatelogic::renderScanBody(out, sizeof(out), mac, token);
  } else if (strcmp(id, "gate-events-request-v1-open") == 0) {
    char subject[32] = {};
    text(render, "subject", subject, sizeof(subject));
    eventq::Event event;
    event.seq = static_cast<uint32_t>(number(render, "seq"));
    event.uptimeMs = static_cast<uint32_t>(number(render, "event_uptime_ms"));
    event.kind = eventq::Kind::GateOpen;
    event.court = eventq::Event::kNoCourt;
    event.method = eventq::Method::Qr;
    event.durationMs = static_cast<uint32_t>(number(render, "duration_ms"));
    TEST_ASSERT_TRUE(event.setSubject(subject));
    n = devlink::renderEventBody(out, sizeof(out), mac, static_cast<uint32_t>(number(render, "boot_id")),
                                 number(render, "uptime_ms"), event);
  } else {
    TEST_FAIL_MESSAGE(id);
  }
  TEST_ASSERT_EQUAL_size_t_MESSAGE(len, n, id);
  TEST_ASSERT_EQUAL_STRING_MESSAGE(expected, out, id);
  ++g_requestsRun;
}

void runResponse(const char* c) {
  char id[64] = {};
  text(c, "id", id, sizeof(id));
  size_t len = 0U;
  const char* doc = hexBody(c, "body_hex", len);
  const char* expect = corpus::member(c, "expect");
  gatelogic::GateRoster cache(gatelogic::kGateConfig.rosterMaxAgeMs);
  memcode::StepClock clock(gatelogic::kGateConfig.rosterMaxAgeMs);
  Keys keys;
  const devlink::SyncResult roster = devlink::applyRoster(doc, len, cache, 1000U);
  const devlink::CodeSyncResult codes = devlink::applyCodeSync(doc, len, clock, keys, 1000U);
  TEST_ASSERT_TRUE_MESSAGE(roster.replaced, id);
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(0U, roster.rejected, id);
  TEST_ASSERT_TRUE_MESSAGE(codes.clockSynced, id);
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(static_cast<uint8_t>(number(expect, "keys_accepted")), codes.accepted, id);
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(0U, codes.rejected, id);
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(0U, codes.dropped, id);
  if (corpus::member(expect, "max_bytes") != nullptr) {
    TEST_ASSERT_TRUE_MESSAGE(len <= static_cast<size_t>(number(expect, "max_bytes")), id);
    TEST_ASSERT_TRUE_MESSAGE(len < gatelogic::kGateResponseCap, "and the board's own buffer holds it");
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(static_cast<uint8_t>(number(expect, "roster_count")), roster.accepted,
                                    id);
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(0U, roster.dropped, id);
  } else {
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(static_cast<uint32_t>(number(expect, "code_step")), clock.stepAt(1000U),
                                     id);
  }
  ++g_responsesRun;
}

void runOffline(const char* c) {
  char id[64] = {};
  text(c, "id", id, sizeof(id));
  size_t len = 0U;
  const char* doc = hexBody(c, "heartbeat_body_hex", len);
  const uint32_t at = static_cast<uint32_t>(number(c, "received_at_ms"));
  gatelogic::GateRoster cache(gatelogic::kGateConfig.rosterMaxAgeMs);
  memcode::StepClock clock(gatelogic::kGateConfig.rosterMaxAgeMs);
  Keys keys;
  Uses uses;
  TEST_ASSERT_TRUE_MESSAGE(devlink::applyRoster(doc, len, cache, at).replaced, id);
  TEST_ASSERT_TRUE_MESSAGE(devlink::applyCodeSync(doc, len, clock, keys, at).clockSynced, id);

  corpus::ArrayIter scans(array(c, "scans"));
  const char* s = nullptr;
  while (scans.next(&s)) {
    char token[32] = {};
    char reason[32] = {};
    text(s, "token", token, sizeof(token));
    text(s, "reason", reason, sizeof(reason));
    const uint32_t now = static_cast<uint32_t>(number(s, "at_ms"));
    const memcode::OfflineCodes<Keys, Uses> codes = {clock, keys, uses};
    const gatelogic::OfflineCodeDecision offline = gatelogic::decideOfflineMemberCode(
        token, codes, cache, 15000U, gatelogic::kGateConfig.unlockHardCapMs, now);
    const gatelogic::ScanDecision& d = offline.decision;
    const memcode::Verdict& verdict = offline.verdict;
    char label[96] = {};
    snprintf(label, sizeof(label), "%s: %s", id, token);
    TEST_ASSERT_EQUAL_MESSAGE(flag(s, "released"), d.released, label);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(reason, d.reason, label);
    TEST_ASSERT_TRUE_MESSAGE(d.queueEvent, label);
    TEST_ASSERT_EQUAL_MESSAGE(d.released ? eventq::Kind::GateOpen : eventq::Kind::UnknownScan, d.eventKind,
                              label);
    if (d.released) {
      // A door is released for its own time, never the booking's.
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(15000U, d.unlockMs, label);
      uses.commit(verdict.token.ref, verdict.step);
    }
  }
  ++g_offlineRun;
}

} // namespace

void test_every_gate_request_renders_byte_for_byte(void) {
  TEST_ASSERT_TRUE_MESSAGE(g_gate.load(kFamily, kFile), "membercode/gate.json not found");
  corpus::ArrayIter it(array(g_gate.root(), "requests"));
  const char* c = nullptr;
  while (it.next(&c)) {
    runRequest(c);
  }
}

void test_every_gate_heartbeat_with_codes_is_adopted_whole(void) {
  TEST_ASSERT_TRUE(g_gate.load(kFamily, kFile));
  corpus::ArrayIter it(array(g_gate.root(), "responses"));
  const char* c = nullptr;
  while (it.next(&c)) {
    runResponse(c);
  }
}

void test_the_door_decides_a_v1_code_offline_as_the_contract_says(void) {
  TEST_ASSERT_TRUE(g_gate.load(kFamily, kFile));
  corpus::ArrayIter it(array(g_gate.root(), "offline"));
  const char* c = nullptr;
  while (it.next(&c)) {
    runOffline(c);
  }
}

void test_every_declared_gate_case_was_executed(void) {
  TEST_ASSERT_TRUE(g_manifest.load(kFamily, "manifest.json"));
  const char* mine = corpus::member(corpus::member(g_manifest.root(), "files"), kFile);
  TEST_ASSERT_NOT_NULL(mine);
  corpus::ArrayIter readers(corpus::member(mine, "read_by"));
  const char* r = nullptr;
  bool named = false;
  while (readers.next(&r)) {
    char reader[24] = {};
    TEST_ASSERT_TRUE(corpus::stringValue(r, reader, sizeof(reader), nullptr));
    named = named || strcmp(reader, "fw-door-gate") == 0;
  }
  TEST_ASSERT_TRUE(named);
  const char* counts = corpus::member(mine, "case_count");
  TEST_ASSERT_EQUAL_size_t(static_cast<size_t>(corpus::unsignedValue(corpus::member(counts, "requests"))),
                           g_requestsRun);
  TEST_ASSERT_EQUAL_size_t(static_cast<size_t>(corpus::unsignedValue(corpus::member(counts, "responses"))),
                           g_responsesRun);
  TEST_ASSERT_EQUAL_size_t(static_cast<size_t>(corpus::unsignedValue(corpus::member(counts, "offline"))),
                           g_offlineRun);
}

void test_a_board_that_names_no_capability_renders_the_body_it_always_did(void) {
  char out[256] = {};
  TEST_ASSERT_TRUE(gatelogic::renderGateHeartbeatBody(out, sizeof(out), "5ccf7f0a1b2c", "1.0.0", 86400000ULL,
                                                      gatelogic::quietDiagnostics()) > 0U);
  TEST_ASSERT_EQUAL_STRING(
      "{\"mac\":\"5ccf7f0a1b2c\",\"firmware_version\":\"1.0.0\",\"uptime_ms\":86400000,\"kind\":\"gate\"}",
      out);
  // The widest body with the capability still fits the renderer's own cap.
  const gatelogic::GateDiagnostics widest = {4294967295UL, 4294967295UL, true};
  char capped[gatelogic::kGateHeartbeatBodyCap] = {};
  TEST_ASSERT_TRUE(gatelogic::renderGateHeartbeatBody(capped, sizeof(capped), "5ccf7f0a1b2c", "1.1.0",
                                                      18446744073709551615ULL, widest) > 0U);
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_every_gate_request_renders_byte_for_byte);
  RUN_TEST(test_every_gate_heartbeat_with_codes_is_adopted_whole);
  RUN_TEST(test_the_door_decides_a_v1_code_offline_as_the_contract_says);
  RUN_TEST(test_every_declared_gate_case_was_executed);
  RUN_TEST(test_a_board_that_names_no_capability_renders_the_body_it_always_did);
  return UNITY_END();
}

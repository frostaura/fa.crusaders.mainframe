// The gate 2.0.0 readers against the compat/ family — what a frozen door gate
// adopts from the bodies a later server might send (docs/specs/device-api.md
// §11). Every `door_gate` case and every gate `scan` case runs through the
// board's own code (gatelogic::readHeartbeat, readScanReply, readEventsReply,
// and the lifeline's devota/devnet readers), and the gate's `budgets` rows are
// asserted equal to the buffers this image compiles in. Executed == declared.
//
// HOW A CASE IS RUN: the base body is adopted first and must produce `prior`;
// each case then starts from that prior state, and afterwards every observable
// equals `prior` except the ones `expect.changes` names (gen_cases.py `build`).

#include <stdint.h>
#include <string.h>
#include <unity.h>

#include "devlink/RosterSync.h"
#include "devnet/Net.h"
#include "devota/Ota.h"
#include "gate_support/BigCorpus.h"
#include "gatelogic/GateReply.h"
#include "support/CorpusJson.h"

namespace {

gatetest::BigFile g_cases;
corpus::File g_manifest;

constexpr uint32_t kNow = 5000000U;

void load() {
  TEST_ASSERT_TRUE_MESSAGE(g_cases.load("compat", "cases.json"), "compat corpus not found");
  TEST_ASSERT_TRUE_MESSAGE(g_manifest.load("compat", "manifest.json"), "compat/manifest.json not found");
}

size_t declared(const char* name) {
  const char* counts = corpus::member(g_manifest.root(), "case_count");
  TEST_ASSERT_NOT_NULL(counts);
  const char* v = corpus::member(counts, name);
  TEST_ASSERT_NOT_NULL_MESSAGE(v, name);
  return static_cast<size_t>(corpus::unsignedValue(v));
}

void text(const char* object, const char* name, char* out, size_t cap) {
  const char* v = corpus::member(object, name);
  TEST_ASSERT_NOT_NULL_MESSAGE(v, name);
  TEST_ASSERT_TRUE_MESSAGE(corpus::stringValue(v, out, cap, nullptr), name);
}

bool flag(const char* object, const char* name) {
  const char* v = corpus::member(object, name);
  TEST_ASSERT_NOT_NULL_MESSAGE(v, name);
  return corpus::skipWs(v)[0] == 't';
}

bool isNull(const char* v) {
  return v == nullptr || corpus::skipWs(v)[0] == 'n';
}

uint8_t g_body[16384];

int nibble(char c) {
  return (c >= '0' && c <= '9') ? c - '0' : ((c >= 'a' && c <= 'f') ? c - 'a' + 10 : -1);
}

/// A hex member decoded straight from the corpus text: the widest body here is
/// longer than the shared reader's string bound, and hex carries no escapes.
size_t bodyOf(const char* object, const char* name) {
  const char* v = corpus::member(object, name);
  TEST_ASSERT_NOT_NULL_MESSAGE(v, name);
  v = corpus::skipWs(v);
  TEST_ASSERT_EQUAL_CHAR_MESSAGE('"', v[0], name);
  size_t len = 0U;
  for (const char* p = v + 1; *p != '"'; p += 2) {
    const int hi = nibble(p[0]);
    const int lo = nibble(p[1]);
    TEST_ASSERT_TRUE_MESSAGE(hi >= 0 && lo >= 0, name);
    TEST_ASSERT_TRUE_MESSAGE(len + 1U < sizeof(g_body), name);
    g_body[len] = static_cast<uint8_t>((hi << 4) | lo);
    ++len;
  }
  g_body[len] = 0U;
  return len;
}

// --- the observables -------------------------------------------------------

struct Lifeline {
  char otaVersion[16] = {};
  char keyNextId[16] = {};
  uint32_t netVer = 0U;
};

/// The lifeline objects as the board reads them: the OTA offer for its own
/// target, a key_next against a ring holding only the compiled key, a net
/// against nothing applied yet.
Lifeline lifelineOf(const gatelogic::HeartbeatRead& read) {
  Lifeline out;
  if (read.ota.present()) {
    devota::Offer offer;
    if (devota::parseOffer(read.ota.at, read.ota.len, devota::kTargetDoorGate, offer) ==
        devota::Refusal::Ok) {
      memcpy(out.otaVersion, offer.version, strlen(offer.version) + 1U);
    }
  }
  if (read.keyNext.present()) {
    devnet::KeyRing ring;
    memcpy(ring.currentId, "k0", 3U);
    memset(ring.currentKey, 'K', devnet::kKeyLen);
    devnet::KeyRing next;
    if (devnet::adoptKeyNext(read.keyNext.at, read.keyNext.len, ring, next) == devnet::Refusal::Ok) {
      memcpy(out.keyNextId, next.currentId, strlen(next.currentId) + 1U);
    }
  }
  if (read.net.present()) {
    devnet::NetSet net;
    if (devnet::adoptNet(read.net.at, read.net.len, 0U, net).adopted()) {
      out.netVer = net.ver;
    }
  }
  return out;
}

void assertGate(const char* id, const char* expected, const gatelogic::GateSettings& s) {
  TEST_ASSERT_EQUAL_UINT32_MESSAGE(corpus::unsignedValue(corpus::member(expected, "unlock_seconds")),
                                   s.unlockSeconds, id);
  TEST_ASSERT_EQUAL_UINT32_MESSAGE(
      corpus::unsignedValue(corpus::member(expected, "power_restore_trust_minutes")),
      s.powerRestoreTrustMinutes, id);
  TEST_ASSERT_EQUAL_UINT32_MESSAGE(corpus::unsignedValue(corpus::member(expected, "net_fallback_minutes")),
                                   s.netFallbackMinutes, id);
  TEST_ASSERT_EQUAL_UINT32_MESSAGE(corpus::unsignedValue(corpus::member(expected, "ota_probation_minutes")),
                                   s.otaProbationMinutes, id);
  TEST_ASSERT_EQUAL_MESSAGE(flag(expected, "device_fault_reporting"), s.faultReporting, id);
  TEST_ASSERT_EQUAL_UINT32_MESSAGE(
      corpus::unsignedValue(corpus::member(expected, "device_fault_max_per_hour")), s.faultMaxPerHour, id);
}

/// Each expected element, parsed by the board's own grammar, against the image.
void assertRoster(const char* id, const char* expected, const gatelogic::RosterImage& image) {
  corpus::ArrayIter it(expected);
  const char* e = nullptr;
  uint8_t i = 0U;
  while (it.next(&e)) {
    char element[64] = {};
    TEST_ASSERT_TRUE(corpus::stringValue(e, element, sizeof(element), nullptr));
    roster::Entry want;
    TEST_ASSERT_TRUE_MESSAGE(devlink::parseRosterElement(element, want), element);
    TEST_ASSERT_TRUE_MESSAGE(i < image.count, id);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(want.token, image.entries[i].token, id);
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(0U, image.entries[i].court, id);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(want.opensAtMs, image.entries[i].opensAtMs, id);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(want.closesAtMs, image.entries[i].closesAtMs, id);
    ++i;
  }
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(i, image.count, id);
}

void assertDays(const char* id, const char* expected, const gatelogic::CodeImage& image) {
  corpus::ArrayIter it(expected);
  const char* e = nullptr;
  uint8_t i = 0U;
  while (it.next(&e)) {
    char element[32] = {};
    TEST_ASSERT_TRUE(corpus::stringValue(e, element, sizeof(element), nullptr));
    memcode::DaySlot want;
    TEST_ASSERT_TRUE_MESSAGE(memcode::parseDaySlot(element, strlen(element), want), element);
    TEST_ASSERT_TRUE_MESSAGE(i < memcode::kMaxDaySlots && image.days[i].valid, id);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(want.firstStep, image.days[i].firstStep, id);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(want.endStep, image.days[i].endStep, id);
    ++i;
  }
  for (; i < memcode::kMaxDaySlots; ++i) {
    TEST_ASSERT_FALSE_MESSAGE(image.days[i].valid, id);
  }
}

void assertKeys(const char* id, const char* expected, const gatelogic::CodeImage& image) {
  corpus::ArrayIter it(expected);
  const char* e = nullptr;
  uint8_t i = 0U;
  while (it.next(&e)) {
    char element[32] = {};
    TEST_ASSERT_TRUE(corpus::stringValue(e, element, sizeof(element), nullptr));
    memcode::DayKey want;
    TEST_ASSERT_TRUE_MESSAGE(memcode::parseKeyElement(element, strlen(element), want), element);
    TEST_ASSERT_TRUE_MESSAGE(i < image.count, id);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(want.ref, image.keys[i].ref, id);
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(want.slot, image.keys[i].slot, id);
    TEST_ASSERT_EQUAL_MEMORY_MESSAGE(want.key, image.keys[i].key, sizeof(want.key), id);
    ++i;
  }
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(i, image.count, id);
}

void assertString(const char* id, const char* expected, const char* got) {
  if (isNull(expected)) {
    TEST_ASSERT_EQUAL_STRING_MESSAGE("", got, id);
    return;
  }
  char want[32] = {};
  TEST_ASSERT_TRUE(corpus::stringValue(expected, want, sizeof(want), nullptr));
  TEST_ASSERT_EQUAL_STRING_MESSAGE(want, got, id);
}

/// `name` from `changes` when the case names it, else from `prior`.
const char* observable(const char* prior, const char* changes, const char* name) {
  const char* changed = changes != nullptr ? corpus::member(changes, name) : nullptr;
  return changed != nullptr ? changed : corpus::member(prior, name);
}

void assertObservables(const char* id, const char* prior, const char* changes,
                       const gatelogic::GateBoardState& state, const Lifeline& life) {
  assertGate(id, observable(prior, changes, "gate"), state.settings);
  assertRoster(id, observable(prior, changes, "roster"), state.roster);
  assertDays(id, observable(prior, changes, "code_days"), state.codes);
  assertKeys(id, observable(prior, changes, "code_keys"), state.codes);
  assertString(id, observable(prior, changes, "ota_version"), life.otaVersion);
  assertString(id, observable(prior, changes, "key_next_id"), life.keyNextId);
  const char* net = observable(prior, changes, "net_ver");
  TEST_ASSERT_EQUAL_UINT32_MESSAGE(isNull(net) ? 0U : static_cast<uint32_t>(corpus::unsignedValue(net)),
                                   life.netVer, id);
}

/// What the HTTP port hands up: a body as long as the buffer cannot be held
/// whole, and arrives as status 0 (ResponseBody.h statusForBody).
uint16_t statusAfterRead(uint16_t status, size_t len, size_t buffer) {
  return len >= buffer ? 0U : status;
}

gatelogic::GateBoardState g_prior;

void test_every_door_gate_case_is_adopted_as_the_reference_adopts_it() {
  load();
  const char* family = corpus::member(g_cases.root(), "door_gate");
  TEST_ASSERT_NOT_NULL(family);
  const char* prior = corpus::member(family, "prior");

  // The base body, from a fresh board, must leave exactly `prior`.
  g_prior = gatelogic::GateBoardState();
  const size_t baseLen = bodyOf(family, "base_hex");
  const gatelogic::HeartbeatRead base =
      gatelogic::readHeartbeat(200U, reinterpret_cast<const char*>(g_body), baseLen, kNow, g_prior);
  TEST_ASSERT_TRUE(base.accepted);
  TEST_ASSERT_EQUAL_UINT8(0U, base.drift.count);
  assertObservables("prior", prior, nullptr, g_prior, lifelineOf(base));

  corpus::ArrayIter it(corpus::member(family, "cases"));
  const char* c = nullptr;
  size_t executed = 0U;
  while (it.next(&c)) {
    char id[corpus::kMaxNameLen] = {};
    text(c, "id", id, sizeof(id));
    const uint16_t status = static_cast<uint16_t>(corpus::unsignedValue(corpus::member(c, "status")));
    const size_t len = bodyOf(c, "body_hex");
    const char* expect = corpus::member(c, "expect");

    gatelogic::GateBoardState state = g_prior;
    const gatelogic::HeartbeatRead read =
        gatelogic::readHeartbeat(statusAfterRead(status, len, gatelogic::kGateHeartbeatResponseCap),
                                 reinterpret_cast<const char*>(g_body), len, kNow + 1000U, state);

    TEST_ASSERT_EQUAL_MESSAGE(flag(expect, "accepted"), read.accepted, id);
    TEST_ASSERT_EQUAL_MESSAGE(flag(expect, "auth_retry"), read.authRetry, id);
    TEST_ASSERT_EQUAL_MESSAGE(flag(expect, "kind_mismatch"), read.kindMismatch, id);

    // drift: the same names, no more, no fewer.
    corpus::ArrayIter names(corpus::member(expect, "drift"));
    const char* n = nullptr;
    uint8_t wanted = 0U;
    while (names.next(&n)) {
      char name[gatelogic::kDriftNameCap] = {};
      TEST_ASSERT_TRUE(corpus::stringValue(n, name, sizeof(name), nullptr));
      TEST_ASSERT_TRUE_MESSAGE(read.drift.contains(name), name);
      ++wanted;
    }
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(wanted, read.drift.count, id);

    assertObservables(id, prior, corpus::member(expect, "changes"), state, lifelineOf(read));
    ++executed;
  }
  TEST_ASSERT_EQUAL_size_t(declared("door_gate"), executed);
}

void test_every_gate_scan_case_is_classified_as_the_reference_classifies_it() {
  load();
  corpus::ArrayIter it(corpus::member(g_cases.root(), "scan"));
  const char* c = nullptr;
  size_t executed = 0U;
  while (it.next(&c)) {
    char device[24] = {};
    text(c, "device", device, sizeof(device));
    if (strcmp(device, "door_gate") != 0) {
      continue;
    }
    char id[corpus::kMaxNameLen] = {};
    text(c, "id", id, sizeof(id));
    char endpoint[16] = {};
    text(c, "endpoint", endpoint, sizeof(endpoint));
    const uint16_t status = static_cast<uint16_t>(corpus::unsignedValue(corpus::member(c, "status")));
    const size_t len = bodyOf(c, "body_hex");
    const char* body = reinterpret_cast<const char*>(g_body);
    const char* expect = corpus::member(c, "expect");
    char cls[16] = {};
    text(expect, "class", cls, sizeof(cls));
    const bool decided = strcmp(cls, "decided") == 0;

    if (strcmp(endpoint, "gate") == 0) {
      const gatelogic::ScanDecision d =
          gatelogic::readScanReply(statusAfterRead(status, len, gatelogic::kGateScanResponseCap), body, len,
                                   gatelogic::kGateConfig.unlockHardCapMs);
      TEST_ASSERT_EQUAL_MESSAGE(!decided, d.fallbackToRoster, id);
      if (decided) {
        TEST_ASSERT_EQUAL_MESSAGE(flag(expect, "opened"), d.released, id);
        const char* seconds = corpus::member(expect, "unlock_seconds");
        if (seconds != nullptr) {
          TEST_ASSERT_EQUAL_UINT32_MESSAGE(corpus::unsignedValue(seconds) * 1000U, d.unlockMs, id);
        }
      }
    } else if (strcmp(endpoint, "events") == 0) {
      uint32_t through = 0U;
      const bool read = gatelogic::readEventsReply(
          statusAfterRead(status, len, gatelogic::kGateEventsResponseCap), body, len, through);
      TEST_ASSERT_EQUAL_MESSAGE(decided, read, id);
      if (decided) {
        TEST_ASSERT_EQUAL_UINT32_MESSAGE(corpus::unsignedValue(corpus::member(expect, "accepted_through")),
                                         through, id);
      }
    } else {
      TEST_FAIL_MESSAGE("a gate scan case names an endpoint this firmware does not call");
    }
    ++executed;
  }
  TEST_ASSERT_EQUAL_size_t(declared("scan_door_gate"), executed);
}

void test_the_gates_budget_rows_are_the_buffers_this_image_compiles_in() {
  load();
  corpus::ArrayIter it(corpus::member(g_cases.root(), "budgets"));
  const char* c = nullptr;
  size_t ours = 0U;
  size_t total = 0U;
  while (it.next(&c)) {
    ++total;
    char device[24] = {};
    text(c, "device", device, sizeof(device));
    char firmware[24] = {};
    text(c, "firmware", firmware, sizeof(firmware));
    if (strcmp(device, "door_gate") != 0 || strcmp(firmware, "gate-2.0.0") != 0) {
      continue;
    }
    char endpoint[16] = {};
    text(c, "endpoint", endpoint, sizeof(endpoint));
    char direction[16] = {};
    text(c, "direction", direction, sizeof(direction));
    const size_t buffer = static_cast<size_t>(corpus::unsignedValue(corpus::member(c, "firmware_buffer")));
    size_t compiled = 0U;
    if (strcmp(endpoint, "heartbeat") == 0 && strcmp(direction, "response") == 0) {
      compiled = gatelogic::kGateHeartbeatResponseCap;
    } else if (strcmp(endpoint, "heartbeat") == 0 && strcmp(direction, "request") == 0) {
      compiled = gatelogic::kGateHeartbeatRequestCap;
    } else if (strcmp(endpoint, "gate") == 0) {
      compiled = gatelogic::kGateScanResponseCap;
    } else if (strcmp(endpoint, "events") == 0) {
      compiled = gatelogic::kGateEventsResponseCap;
    } else {
      TEST_FAIL_MESSAGE("a gate-2.0.0 budget row names an endpoint this image does not have");
    }
    TEST_ASSERT_EQUAL_size_t_MESSAGE(buffer, compiled, endpoint);
    // Every v3 response budget leaves 20% headroom (device-api.md §11.4).
    const char* serverMax = corpus::member(c, "server_max");
    if (serverMax != nullptr) {
      TEST_ASSERT_TRUE_MESSAGE(corpus::unsignedValue(serverMax) * 5U <= buffer * 4U, endpoint);
    }
    ++ours;
  }
  TEST_ASSERT_EQUAL_size_t(4U, ours);
  TEST_ASSERT_EQUAL_size_t(declared("budgets"), total);
}

} // namespace

void setUp() {
}

void tearDown() {
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_every_door_gate_case_is_adopted_as_the_reference_adopts_it);
  RUN_TEST(test_every_gate_scan_case_is_classified_as_the_reference_classifies_it);
  RUN_TEST(test_the_gates_budget_rows_are_the_buffers_this_image_compiles_in);
  return UNITY_END();
}

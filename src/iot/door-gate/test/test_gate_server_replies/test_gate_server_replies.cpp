// The server's REAL replies through the gate's own readers (device-api.md
// §11.5, FC-9, `make device-replay-check`).
//
// The corpus pins bytes somebody wrote down; it cannot notice that the server
// has started sending something else. The backend's DeviceReplyEmitterTests
// drive the real endpoints and, with DEVICE_REPLAY_DIR set, write each reply as
// `<endpoint>/<scenario>.json` — {device, caps, endpoint, status, body_hex,
// expect} — beside an `index.json` of {count, files}. This suite reads every
// file whose `device` is `door_gate` and runs its body through exactly the code
// the board runs (gatelogic::readHeartbeat, readScanReply, readEventsReply and
// the lifeline's own readers), asserting the body is whole and inside its
// buffer, nothing drifted, and every `expect` value was adopted.
//
// THE `expect` KEYS THIS SUITE UNDERSTANDS — anything else is a failure, so a
// server that starts promising something the gate cannot check is found here:
//   heartbeat: kind, roster_count, code_days_count, code_keys_count, gate
//              (an object of the six settings), heartbeat_seconds,
//              ota_version, key_next_id, net_ver
//   gate:      opened, unlock_seconds, reason
//   events:    accepted_through
//
// Without DEVICE_REPLAY_DIR this suite has nothing to read and passes, saying
// so; with it, a missing index or fewer files read than it declares fails.

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unity.h>

#include "devnet/Net.h"
#include "devota/Ota.h"
#include "gatelogic/GateReply.h"
#include "support/CorpusJson.h"

namespace {

constexpr size_t kFileCap = 65536U;
char g_index[kFileCap];
char g_file[kFileCap];
uint8_t g_body[16384];

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
    g_body[len] = static_cast<uint8_t>((hi << 4) | lo);
    ++len;
  }
  g_body[len] = 0U;
  return len;
}

bool flag(const char* v) {
  return corpus::skipWs(v)[0] == 't';
}

void text(const char* object, const char* name, char* out, size_t cap) {
  const char* v = corpus::member(object, name);
  TEST_ASSERT_NOT_NULL_MESSAGE(v, name);
  TEST_ASSERT_TRUE_MESSAGE(corpus::stringValue(v, out, cap, nullptr), name);
}

bool isNull(const char* v) {
  return corpus::skipWs(v)[0] == 'n';
}

void checkHeartbeat(const char* file, uint16_t status, const char* body, size_t len, const char* expect) {
  TEST_ASSERT_TRUE_MESSAGE(len * 5U <= gatelogic::kGateHeartbeatResponseCap * 4U, file);
  gatelogic::GateBoardState state;
  const gatelogic::HeartbeatRead read = gatelogic::readHeartbeat(status, body, len, 5000000U, state);
  TEST_ASSERT_TRUE_MESSAGE(read.accepted, file);
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(0U, read.drift.count, file);
  char name[corpus::kMaxNameLen] = {};
  const char* value = nullptr;
  corpus::ObjectIter it(expect);
  while (it.next(name, sizeof(name), &value)) {
    if (strcmp(name, "kind") == 0) {
      char want[16] = {};
      TEST_ASSERT_TRUE(corpus::stringValue(value, want, sizeof(want), nullptr));
      TEST_ASSERT_EQUAL_MESSAGE(strcmp(want, "gate") != 0, read.kindMismatch, file);
    } else if (strcmp(name, "roster_count") == 0) {
      TEST_ASSERT_TRUE_MESSAGE(read.roster == gatelogic::ArrayRead::Adopted, file);
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(corpus::unsignedValue(value), state.roster.count, file);
    } else if (strcmp(name, "code_days_count") == 0) {
      uint32_t days = 0U;
      for (uint8_t s = 0U; s < memcode::kMaxDaySlots; ++s) {
        days += state.codes.days[s].valid ? 1U : 0U;
      }
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(corpus::unsignedValue(value), days, file);
    } else if (strcmp(name, "code_keys_count") == 0) {
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(corpus::unsignedValue(value), state.codes.count, file);
    } else if (strcmp(name, "heartbeat_seconds") == 0) {
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(corpus::unsignedValue(value) * 1000U, state.heartbeatMs, file);
    } else if (strcmp(name, "gate") == 0) {
      const gatelogic::GateSettings& s = state.settings;

      const struct {
        const char* key;
        uint32_t got;
      } numbers[] = {{"unlock_seconds", s.unlockSeconds},
                     {"power_restore_trust_minutes", s.powerRestoreTrustMinutes},
                     {"net_fallback_minutes", s.netFallbackMinutes},
                     {"ota_probation_minutes", s.otaProbationMinutes},
                     {"device_fault_max_per_hour", s.faultMaxPerHour}};

      for (size_t i = 0U; i < sizeof(numbers) / sizeof(numbers[0]); ++i) {
        const char* v = corpus::member(value, numbers[i].key);
        if (v != nullptr) {
          TEST_ASSERT_EQUAL_UINT32_MESSAGE(corpus::unsignedValue(v), numbers[i].got, numbers[i].key);
        }
      }
      const char* reporting = corpus::member(value, "device_fault_reporting");
      if (reporting != nullptr) {
        TEST_ASSERT_EQUAL_MESSAGE(flag(reporting), s.faultReporting, file);
      }
    } else if (strcmp(name, "ota_version") == 0) {
      if (isNull(value)) {
        TEST_ASSERT_FALSE_MESSAGE(read.ota.present(), file);
        continue;
      }
      devota::Offer offer;
      TEST_ASSERT_TRUE_MESSAGE(devota::parseOffer(read.ota.at, read.ota.len, devota::kTargetDoorGate,
                                                  offer) == devota::Refusal::Ok,
                               file);
      char want[16] = {};
      TEST_ASSERT_TRUE(corpus::stringValue(value, want, sizeof(want), nullptr));
      TEST_ASSERT_EQUAL_STRING_MESSAGE(want, offer.version, file);
    } else if (strcmp(name, "key_next_id") == 0) {
      if (isNull(value)) {
        TEST_ASSERT_FALSE_MESSAGE(read.keyNext.present(), file);
        continue;
      }
      devnet::KeyRing ring;
      memcpy(ring.currentId, "k0", 3U);
      ring.currentKey[0] = '-';
      devnet::KeyRing next;
      TEST_ASSERT_TRUE_MESSAGE(
          devnet::adoptKeyNext(read.keyNext.at, read.keyNext.len, ring, next) == devnet::Refusal::Ok, file);
      char want[16] = {};
      TEST_ASSERT_TRUE(corpus::stringValue(value, want, sizeof(want), nullptr));
      TEST_ASSERT_EQUAL_STRING_MESSAGE(want, next.currentId, file);
    } else if (strcmp(name, "net_ver") == 0) {
      if (isNull(value)) {
        TEST_ASSERT_FALSE_MESSAGE(read.net.present(), file);
        continue;
      }
      devnet::NetSet net;
      TEST_ASSERT_TRUE_MESSAGE(devnet::adoptNet(read.net.at, read.net.len, 0U, net).adopted(), file);
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(corpus::unsignedValue(value), net.ver, file);
    } else {
      TEST_FAIL_MESSAGE("a heartbeat expectation this gate does not know how to check");
    }
  }
}

void checkGate(const char* file, uint16_t status, const char* body, size_t len, const char* expect) {
  TEST_ASSERT_TRUE_MESSAGE(len * 5U <= gatelogic::kGateScanResponseCap * 4U, file);
  const gatelogic::ScanDecision d = gatelogic::readScanReply(status, body, len, 30000U);
  TEST_ASSERT_FALSE_MESSAGE(d.fallbackToRoster, file);
  char name[corpus::kMaxNameLen] = {};
  const char* value = nullptr;
  corpus::ObjectIter it(expect);
  while (it.next(name, sizeof(name), &value)) {
    if (strcmp(name, "opened") == 0) {
      TEST_ASSERT_EQUAL_MESSAGE(flag(value), d.released, file);
    } else if (strcmp(name, "unlock_seconds") == 0) {
      if (d.released) {
        TEST_ASSERT_EQUAL_UINT32_MESSAGE(corpus::unsignedValue(value) * 1000U, d.unlockMs, file);
      }
    } else if (strcmp(name, "reason") == 0) {
      char want[32] = {};
      TEST_ASSERT_TRUE(corpus::stringValue(value, want, sizeof(want), nullptr));
      TEST_ASSERT_EQUAL_STRING_MESSAGE(want, d.reason, file);
    } else {
      TEST_FAIL_MESSAGE("a scan expectation this gate does not know how to check");
    }
  }
}

void checkEvents(const char* file, uint16_t status, const char* body, size_t len, const char* expect) {
  TEST_ASSERT_TRUE_MESSAGE(len * 2U <= gatelogic::kGateEventsResponseCap, file);
  uint32_t through = 0U;
  TEST_ASSERT_TRUE_MESSAGE(gatelogic::readEventsReply(status, body, len, through), file);
  const char* want = corpus::member(expect, "accepted_through");
  if (want != nullptr) {
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(corpus::unsignedValue(want), through, file);
  }
}

void test_every_server_reply_for_a_door_is_read_whole_by_the_gate() {
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
    if (strcmp(device, "door_gate") != 0) {
      continue;
    }
    char endpoint[24] = {};
    text(g_file, "endpoint", endpoint, sizeof(endpoint));
    const uint16_t status = static_cast<uint16_t>(corpus::unsignedValue(corpus::member(g_file, "status")));
    const size_t len = hexBody(g_file);
    const char* body = reinterpret_cast<const char*>(g_body);
    const char* expect = corpus::member(g_file, "expect");
    TEST_ASSERT_NOT_NULL_MESSAGE(expect, rel);
    if (strcmp(endpoint, "heartbeat") == 0) {
      checkHeartbeat(rel, status, body, len, expect);
    } else if (strcmp(endpoint, "gate") == 0) {
      checkGate(rel, status, body, len, expect);
    } else if (strcmp(endpoint, "events") == 0) {
      checkEvents(rel, status, body, len, expect);
    } else {
      TEST_FAIL_MESSAGE("a door reply for an endpoint this gate never calls");
    }
    ++ours;
  }
  TEST_ASSERT_EQUAL_size_t_MESSAGE(declared, listed, "the index declares more files than it lists");
  TEST_ASSERT_TRUE_MESSAGE(ours > 0U, "the emitter wrote no door_gate reply at all");
}

} // namespace

void setUp() {
}

void tearDown() {
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_every_server_reply_for_a_door_is_read_whole_by_the_gate);
  return UNITY_END();
}

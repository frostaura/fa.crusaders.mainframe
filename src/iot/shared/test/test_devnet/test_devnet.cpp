// lib/devnet against the shared contract corpus — every case in
// src/contracts/device-protocol/provision/, executed, counted, and cross-checked
// against what manifest.json declares — plus the stateful link supervisor and
// the escape decoding the corpus has no vector for.
//
// WHY THE CORPUS
// --------------
// The same four rules are enforced on both ESP images (through this library)
// and by the server when an admin saves a network or rotates a key. A value
// the console accepts and a board refuses is a network change that strands the
// fleet with nobody at the club to see it, so both sides are checked against
// `provision/gen_cases.py`, which neither wrote.

#include <stdint.h>
#include <string.h>
#include <unity.h>

#include "devnet/JsonMember.h"
#include "devnet/Net.h"
#include "support/CorpusJson.h"

namespace {

corpus::File g_cases;
corpus::File g_manifest;

void load() {
  TEST_ASSERT_TRUE_MESSAGE(g_cases.load("provision", "cases.json"),
                           "provision corpus not found — a skipped corpus proves nothing");
  TEST_ASSERT_TRUE_MESSAGE(g_manifest.load("provision", "manifest.json"),
                           "provision/manifest.json not found");
}

size_t declared(const char* section) {
  const char* counts = corpus::member(g_manifest.root(), "case_count");
  TEST_ASSERT_NOT_NULL(counts);
  const char* value = corpus::member(counts, section);
  TEST_ASSERT_NOT_NULL_MESSAGE(value, section);
  return static_cast<size_t>(corpus::unsignedValue(value));
}

const char* section(const char* name) {
  const char* value = corpus::member(g_cases.root(), name);
  TEST_ASSERT_NOT_NULL_MESSAGE(value, name);
  TEST_ASSERT_TRUE_MESSAGE(corpus::isArray(value), name);
  return value;
}

void text(const char* object, const char* name, char* out, size_t cap) {
  const char* value = corpus::member(object, name);
  TEST_ASSERT_NOT_NULL_MESSAGE(value, name);
  TEST_ASSERT_TRUE_MESSAGE(corpus::stringValue(value, out, cap, nullptr), name);
}

bool flag(const char* object, const char* name) {
  const char* value = corpus::member(object, name);
  TEST_ASSERT_NOT_NULL_MESSAGE(value, name);
  return corpus::skipWs(value)[0] == 't';
}

void rawValue(const char* object, const char* name, const char*& start, size_t& len) {
  start = corpus::member(object, name);
  TEST_ASSERT_NOT_NULL_MESSAGE(start, name);
  const char* end = corpus::skipValue(start);
  TEST_ASSERT_NOT_NULL(end);
  len = static_cast<size_t>(end - start);
}

size_t g_executed[4] = {0U, 0U, 0U, 0U};

void test_every_base_url_case() {
  load();
  corpus::ArrayIter it(section("base_urls"));
  const char* c = nullptr;
  while (it.next(&c)) {
    char id[corpus::kMaxNameLen] = {};
    text(c, "id", id, sizeof(id));
    char url[256] = {};
    text(c, "url", url, sizeof(url));
    char reason[32] = {};
    text(c, "reason", reason, sizeof(reason));
    const devnet::Refusal got = devnet::checkBaseUrl(url);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(reason, devnet::refusalName(got), id);
    TEST_ASSERT_EQUAL_MESSAGE(flag(c, "accept"), got == devnet::Refusal::Ok, id);
    ++g_executed[0];
  }
  TEST_ASSERT_EQUAL_size_t(declared("base_urls"), g_executed[0]);
}

/// The corpus's `result` against what adoptNet produced. The corpus lists the
/// profiles the object NAMED, in slot order; NetSet keeps them by slot.
void expectResult(const char* id, const char* result, const devnet::NetSet& got) {
  TEST_ASSERT_EQUAL_UINT64_MESSAGE(corpus::unsignedValue(corpus::member(result, "ver")), got.ver, id);
  const char* base = corpus::member(result, "base");
  if (corpus::skipWs(base)[0] == 'n') {
    TEST_ASSERT_FALSE_MESSAGE(got.hasBase, id);
  } else {
    char want[128] = {};
    TEST_ASSERT_TRUE(corpus::stringValue(base, want, sizeof(want), nullptr));
    TEST_ASSERT_TRUE_MESSAGE(got.hasBase, id);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(want, got.base, id);
  }
  corpus::ArrayIter wifi(corpus::member(result, "wifi"));
  const char* pair = nullptr;
  uint8_t slot = 0U;
  uint8_t listed = 0U;
  while (wifi.next(&pair)) {
    while (slot < devnet::kProfiles && !got.hasWifi[slot]) {
      ++slot;
    }
    TEST_ASSERT_TRUE_MESSAGE(slot < devnet::kProfiles, id);
    corpus::ArrayIter parts(pair);
    const char* part = nullptr;
    char ssid[64] = {};
    char psk[128] = {};
    TEST_ASSERT_TRUE(parts.next(&part));
    TEST_ASSERT_TRUE(corpus::stringValue(part, ssid, sizeof(ssid), nullptr));
    TEST_ASSERT_TRUE(parts.next(&part));
    TEST_ASSERT_TRUE(corpus::stringValue(part, psk, sizeof(psk), nullptr));
    TEST_ASSERT_EQUAL_STRING_MESSAGE(ssid, got.wifi[slot].ssid, id);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(psk, got.wifi[slot].psk, id);
    ++slot;
    ++listed;
  }
  const uint8_t held = static_cast<uint8_t>((got.hasWifi[0] ? 1U : 0U) + (got.hasWifi[1] ? 1U : 0U));
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(listed, held, id);
}

void test_every_net_case() {
  load();
  corpus::ArrayIter it(section("nets"));
  const char* c = nullptr;
  while (it.next(&c)) {
    char id[corpus::kMaxNameLen] = {};
    text(c, "id", id, sizeof(id));
    const char* net = nullptr;
    size_t netLen = 0U;
    rawValue(c, "net", net, netLen);
    const uint32_t applied = static_cast<uint32_t>(corpus::unsignedValue(corpus::member(c, "applied_ver")));
    char reason[32] = {};
    text(c, "reason", reason, sizeof(reason));

    devnet::NetSet out;
    out.ver = 12345U; // a sentinel: a refusal must leave it untouched
    const devnet::NetResult got = devnet::adoptNet(net, netLen, applied, out);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(reason, devnet::refusalName(got.reason), id);
    TEST_ASSERT_EQUAL_MESSAGE(flag(c, "adopt"), got.adopted(), id);
    if (got.adopted()) {
      expectResult(id, corpus::member(c, "result"), out);
    } else {
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(12345U, out.ver, id);
    }
    ++g_executed[1];
  }
  TEST_ASSERT_EQUAL_size_t(declared("nets"), g_executed[1]);
}

void test_every_key_case() {
  load();
  corpus::ArrayIter it(section("keys"));
  const char* c = nullptr;
  while (it.next(&c)) {
    char id[corpus::kMaxNameLen] = {};
    text(c, "id", id, sizeof(id));
    const char* keyNext = nullptr;
    size_t keyNextLen = 0U;
    rawValue(c, "key_next", keyNext, keyNextLen);

    // The ring the vector describes: `current_id` current, and the other id
    // it holds (if any) as previous. Keys a test invents; only ids matter here.
    devnet::KeyRing ring;
    text(c, "current_id", ring.currentId, sizeof(ring.currentId));
    memset(ring.currentKey, 'C', devnet::kKeyLen);
    corpus::ArrayIter held(corpus::member(c, "held_ids"));
    const char* h = nullptr;
    while (held.next(&h)) {
      char heldId[16] = {};
      TEST_ASSERT_TRUE(corpus::stringValue(h, heldId, sizeof(heldId), nullptr));
      if (strcmp(heldId, ring.currentId) != 0) {
        memcpy(ring.previousId, heldId, strlen(heldId) + 1U);
        memset(ring.previousKey, 'P', devnet::kKeyLen);
        ring.hasPrevious = true;
      }
    }
    char reason[32] = {};
    text(c, "reason", reason, sizeof(reason));

    devnet::KeyRing out;
    const devnet::Refusal got = devnet::adoptKeyNext(keyNext, keyNextLen, ring, out);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(reason, devnet::refusalName(got), id);
    TEST_ASSERT_EQUAL_MESSAGE(flag(c, "adopt"), got == devnet::Refusal::Ok, id);
    const char* object = corpus::member(c, "key_next");
    if (got == devnet::Refusal::Ok) {
      char wantId[16] = {};
      char wantKey[64] = {};
      text(object, "id", wantId, sizeof(wantId));
      text(object, "key", wantKey, sizeof(wantKey));
      TEST_ASSERT_EQUAL_STRING_MESSAGE(wantId, out.currentId, id);
      TEST_ASSERT_EQUAL_STRING_MESSAGE(wantKey, out.currentKey, id);
      // The key it replaced is kept, never erased: a 401 falls back to it.
      TEST_ASSERT_TRUE_MESSAGE(out.hasPrevious, id);
      TEST_ASSERT_EQUAL_STRING_MESSAGE(ring.currentId, out.previousId, id);
      TEST_ASSERT_EQUAL_STRING_MESSAGE(ring.currentKey, out.previousKey, id);
    } else {
      TEST_ASSERT_EQUAL_STRING_MESSAGE(ring.currentId, out.currentId, id);
      TEST_ASSERT_EQUAL_STRING_MESSAGE(ring.currentKey, out.currentKey, id);
    }
    ++g_executed[2];
  }
  TEST_ASSERT_EQUAL_size_t(declared("keys"), g_executed[2]);
}

void test_every_supervisor_case() {
  load();
  corpus::ArrayIter it(section("supervisor"));
  const char* c = nullptr;
  while (it.next(&c)) {
    char id[corpus::kMaxNameLen] = {};
    text(c, "id", id, sizeof(id));
    const uint32_t down = static_cast<uint32_t>(corpus::unsignedValue(corpus::member(c, "down_seconds")));
    const uint32_t since =
        static_cast<uint32_t>(corpus::unsignedValue(corpus::member(c, "since_attempt_seconds")));
    const uint32_t attempts = static_cast<uint32_t>(corpus::unsignedValue(corpus::member(c, "attempts")));
    char action[32] = {};
    text(c, "action", action, sizeof(action));
    TEST_ASSERT_EQUAL_STRING_MESSAGE(action, devnet::actionName(devnet::supervise(down, since, attempts)),
                                     id);
    ++g_executed[3];
  }
  TEST_ASSERT_EQUAL_size_t(declared("supervisor"), g_executed[3]);
}

void test_every_corpus_section_is_declared_and_executed() {
  load();
  char name[corpus::kMaxNameLen] = {};
  const char* value = nullptr;
  size_t seen = 0U;
  corpus::ObjectIter cases(g_cases.root());
  while (cases.next(name, sizeof(name), &value)) {
    if (!corpus::isArray(value)) {
      continue;
    }
    const bool known = strcmp(name, "base_urls") == 0 || strcmp(name, "nets") == 0 ||
                       strcmp(name, "keys") == 0 || strcmp(name, "supervisor") == 0;
    TEST_ASSERT_TRUE_MESSAGE(known, "a provision/ section no test in this suite executes");
    ++seen;
  }
  TEST_ASSERT_EQUAL_size_t(4U, seen);
  TEST_ASSERT_EQUAL_size_t(declared("base_urls") + declared("nets") + declared("keys") +
                               declared("supervisor"),
                           g_executed[0] + g_executed[1] + g_executed[2] + g_executed[3]);

  const char* constants = corpus::member(g_cases.root(), "constants");
  TEST_ASSERT_EQUAL_UINT64(devnet::kBaseUrlMax,
                           corpus::unsignedValue(corpus::member(constants, "base_url_max")));
  TEST_ASSERT_EQUAL_UINT64(devnet::kSupervisorGraceS,
                           corpus::unsignedValue(corpus::member(constants, "supervisor_grace_seconds")));
  TEST_ASSERT_EQUAL_UINT64(devnet::kSupervisorRestartS,
                           corpus::unsignedValue(corpus::member(constants, "supervisor_restart_seconds")));
  corpus::ArrayIter backoff(corpus::member(constants, "supervisor_backoff_seconds"));
  const char* step = nullptr;
  uint8_t i = 0U;
  while (backoff.next(&step)) {
    TEST_ASSERT_TRUE(i < devnet::kSupervisorBackoffSteps);
    TEST_ASSERT_EQUAL_UINT64(devnet::kSupervisorBackoffS[i], corpus::unsignedValue(step));
    ++i;
  }
  TEST_ASSERT_EQUAL_UINT8(devnet::kSupervisorBackoffSteps, i);
}

// --- beyond the corpus ------------------------------------------------------

/// The stateful supervisor, ticked once a second through a whole outage, at a
/// clock base with the 2^32 ms wrap inside it: it reconnects at 30 s, then at
/// the backoff, and restarts at fifteen minutes — and a returning link forgets
/// the outage.
void test_supervisor_through_a_whole_outage() {
  const uint32_t bases[] = {1000U, 0xFFFF0000U};
  for (size_t b = 0U; b < 2U; ++b) {
    devnet::Supervisor sup;
    const uint32_t t0 = bases[b];
    TEST_ASSERT_TRUE(sup.tick(t0, true) == devnet::Action::None);
    uint32_t reconnectsAt[16] = {};
    uint8_t reconnects = 0U;
    uint32_t restartAt = 0U;
    for (uint32_t s = 0U; s <= 1000U && restartAt == 0U; ++s) {
      const devnet::Action a = sup.tick(t0 + (s * 1000U), false);
      if (a == devnet::Action::ReconnectNextProfile && reconnects < 16U) {
        reconnectsAt[reconnects++] = s;
      } else if (a == devnet::Action::Restart) {
        restartAt = s;
      }
    }
    // 30, then +30, +60, +120, +240, then +300 capped: 30, 60, 120, 240, 480, 780.
    const uint32_t want[] = {30U, 60U, 120U, 240U, 480U, 780U};
    TEST_ASSERT_EQUAL_UINT8(6U, reconnects);
    TEST_ASSERT_EQUAL_UINT32_ARRAY(want, reconnectsAt, 6U);
    TEST_ASSERT_EQUAL_UINT32(900U, restartAt);

    // A blip shorter than the grace never reconnects, and the link coming back
    // clears the outage so the next drop gets its own grace.
    devnet::Supervisor blip;
    for (uint32_t s = 0U; s < 29U; ++s) {
      TEST_ASSERT_TRUE(blip.tick(t0 + (s * 1000U), false) == devnet::Action::None);
    }
    TEST_ASSERT_TRUE(blip.tick(t0 + 29000U, true) == devnet::Action::None);
    TEST_ASSERT_EQUAL_UINT32(0U, blip.downSeconds(t0 + 29000U));
    TEST_ASSERT_TRUE(blip.tick(t0 + 40000U, false) == devnet::Action::None);
    TEST_ASSERT_TRUE(blip.tick(t0 + 69000U, false) == devnet::Action::None);
    TEST_ASSERT_TRUE(blip.tick(t0 + 70000U, false) == devnet::Action::ReconnectNextProfile);
  }
}

/// The server's serialiser escapes `+`, `&`, `'` and every non-ASCII
/// character. A board that stored the escape would join nothing.
void test_net_values_are_read_with_their_escapes_decoded() {
  const char* net =
      "{\"ver\":7,\"wifi0_ssid\":\"Caf\\u00e9 Court\",\"wifi0_psk\":\"squash\\u002Bcourt&\\\"4\\\"\","
      "\"base\":\"http:\\/\\/mainframe.lan:8088\"}";
  devnet::NetSet out;
  const devnet::NetResult got = devnet::adoptNet(net, strlen(net), 6U, out);
  TEST_ASSERT_EQUAL_STRING("ok", devnet::refusalName(got.reason));
  TEST_ASSERT_EQUAL_STRING("Caf\xC3\xA9 Court", out.wifi[0].ssid);
  TEST_ASSERT_EQUAL_STRING("squash+court&\"4\"", out.wifi[0].psk);
  TEST_ASSERT_EQUAL_STRING("http://mainframe.lan:8088", out.base);

  // A non-ASCII PASSWORD is not WPA2-printable and is refused, not mangled.
  const char* bad = "{\"ver\":8,\"wifi0_ssid\":\"CLUB\",\"wifi0_psk\":\"p\\u00e4ssword1\"}";
  TEST_ASSERT_EQUAL_STRING("wifi0_psk",
                           devnet::refusalName(devnet::adoptNet(bad, strlen(bad), 6U, out).reason));
  // A lone surrogate is not a character.
  const char* lone = "{\"ver\":8,\"wifi0_ssid\":\"\\ud800CLUB\",\"wifi0_psk\":\"\"}";
  TEST_ASSERT_EQUAL_STRING("wifi0_ssid",
                           devnet::refusalName(devnet::adoptNet(lone, strlen(lone), 6U, out).reason));
  // A profile named only as nulls is not named at all, and a null base is no
  // URL.
  const char* nulls = "{\"ver\":8,\"wifi1_ssid\":null,\"wifi1_psk\":null,\"base\":\"http://10.0.0.5\"}";
  devnet::NetSet n;
  TEST_ASSERT_TRUE(devnet::adoptNet(nulls, strlen(nulls), 6U, n).adopted());
  TEST_ASSERT_FALSE(n.hasWifi[1]);
  const char* nullBase = "{\"ver\":8,\"base\":null}";
  TEST_ASSERT_EQUAL_STRING("base_empty",
                           devnet::refusalName(devnet::adoptNet(nullBase, strlen(nullBase), 6U, n).reason));
}

/// Only the outermost object's members count: a `ver` nested elsewhere is not
/// the network's version.
void test_net_reads_only_its_own_members() {
  const char* nested = "{\"note\":{\"ver\":9},\"base\":\"http://10.0.0.5\"}";
  devnet::NetSet out;
  TEST_ASSERT_EQUAL_STRING("ver",
                           devnet::refusalName(devnet::adoptNet(nested, strlen(nested), 0U, out).reason));
  const char* fraction = "{\"ver\":9.5,\"base\":\"http://10.0.0.5\"}";
  TEST_ASSERT_EQUAL_STRING("ver",
                           devnet::refusalName(devnet::adoptNet(fraction, strlen(fraction), 0U, out).reason));
}

/// Two rotations in a row: each moves the ring forward and drops the oldest.
void test_key_ring_moves_forward_and_holds_two() {
  devnet::KeyRing ring;
  memcpy(ring.currentId, "k0", 3U);
  memset(ring.currentKey, 'A', devnet::kKeyLen);
  const char* k1 = "{\"id\":\"k1\",\"key\":\"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\"}";
  devnet::KeyRing one;
  TEST_ASSERT_EQUAL_STRING("ok", devnet::refusalName(devnet::adoptKeyNext(k1, strlen(k1), ring, one)));
  TEST_ASSERT_EQUAL_STRING("k1", one.currentId);
  TEST_ASSERT_EQUAL_STRING("k0", one.previousId);
  const char* k2 = "{\"id\":\"k2\",\"key\":\"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC\"}";
  devnet::KeyRing two;
  TEST_ASSERT_EQUAL_STRING("ok", devnet::refusalName(devnet::adoptKeyNext(k2, strlen(k2), one, two)));
  TEST_ASSERT_EQUAL_STRING("k2", two.currentId);
  TEST_ASSERT_EQUAL_STRING("k1", two.previousId);
  TEST_ASSERT_EQUAL_STRING("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", two.previousKey);
  // Re-sent next beat (the server has not seen the new key yet): `current`.
  devnet::KeyRing three;
  TEST_ASSERT_EQUAL_STRING("current", devnet::refusalName(devnet::adoptKeyNext(k2, strlen(k2), two, three)));
}

/// THE LIFELINE TOLERATES A LATER SERVER (device-api.md §11.1). `net` and
/// `key_next` carrying keys of every JSON kind — including objects that
/// themselves name `ver`, `base`, `id` and `key` — are read for their own
/// members only, and an absent required member is still a refusal.
void test_net_and_key_next_ignore_extra_keys_of_every_kind() {
  const char* net =
      "{\"meta\":{\"ver\":99,\"base\":\"http://10.9.9.9\"},\"ver\":4,\"why\":\"router \\\"swap\\\"\","
      "\"base\":\"http://192.168.1.20:8088\",\"weight\":2.5e1,\"wifi0_ssid\":\"CRUSADERS\",\"n\":null,"
      "\"wifi0_psk\":\"squash-court-4\",\"list\":[\"wifi1_ssid\",{\"wifi1_psk\":\"x\"}],\"on\":true,"
      "\"wifi1_ssid\":\"CRUSADERS-NEW\",\"wifi1_psk\":\"new-router-pass\",\"zz\":false}";
  devnet::NetSet out;
  TEST_ASSERT_EQUAL_STRING("ok", devnet::refusalName(devnet::adoptNet(net, strlen(net), 3U, out).reason));
  TEST_ASSERT_EQUAL_UINT32(4U, out.ver);
  TEST_ASSERT_EQUAL_STRING("http://192.168.1.20:8088", out.base);
  TEST_ASSERT_EQUAL_STRING("CRUSADERS", out.wifi[0].ssid);
  TEST_ASSERT_EQUAL_STRING("squash-court-4", out.wifi[0].psk);
  TEST_ASSERT_EQUAL_STRING("CRUSADERS-NEW", out.wifi[1].ssid);
  TEST_ASSERT_EQUAL_STRING("new-router-pass", out.wifi[1].psk);
  const char* noVer = "{\"meta\":{\"ver\":99},\"base\":\"http://192.168.1.20:8088\",\"wifi0_ssid\":\"C\","
                      "\"wifi0_psk\":\"squash-court-4\",\"extra\":[1,2]}";
  devnet::NetSet refused;
  TEST_ASSERT_EQUAL_STRING("ver",
                           devnet::refusalName(devnet::adoptNet(noVer, strlen(noVer), 0U, refused).reason));

  devnet::KeyRing ring;
  memcpy(ring.currentId, "k1", 3U);
  memset(ring.currentKey, 'A', devnet::kKeyLen);
  const char* keyNext = "{\"rotation\":{\"id\":\"k9\",\"key\":\"short\"},\"id\":\"k2\",\"started\":17000,"
                        "\"n\":null,\"key\":\"Zq7Hn2Vb5Rt8Wy1Lp4Mk6Xc9Ds3Fg0Jh_a-QeUoIiEr\",\"tags\":[\"a\"],"
                        "\"grace\":1.5,\"on\":true}";
  devnet::KeyRing next;
  TEST_ASSERT_EQUAL_STRING("ok",
                           devnet::refusalName(devnet::adoptKeyNext(keyNext, strlen(keyNext), ring, next)));
  TEST_ASSERT_EQUAL_STRING("k2", next.currentId);
  TEST_ASSERT_EQUAL_STRING("Zq7Hn2Vb5Rt8Wy1Lp4Mk6Xc9Ds3Fg0Jh_a-QeUoIiEr", next.currentKey);
  TEST_ASSERT_EQUAL_STRING("k1", next.previousId);
  const char* noKey =
      "{\"rotation\":{\"key\":\"Zq7Hn2Vb5Rt8Wy1Lp4Mk6Xc9Ds3Fg0Jh_a-QeUoIiEr\"},\"id\":\"k2\"}";
  devnet::KeyRing kept;
  TEST_ASSERT_NOT_EQUAL(static_cast<int>(devnet::Refusal::Ok),
                        static_cast<int>(devnet::adoptKeyNext(noKey, strlen(noKey), ring, kept)));
  TEST_ASSERT_EQUAL_STRING("k1", kept.currentId);
}

} // namespace

void setUp() {
}

void tearDown() {
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_every_base_url_case);
  RUN_TEST(test_every_net_case);
  RUN_TEST(test_every_key_case);
  RUN_TEST(test_every_supervisor_case);
  RUN_TEST(test_every_corpus_section_is_declared_and_executed);
  RUN_TEST(test_supervisor_through_a_whole_outage);
  RUN_TEST(test_net_values_are_read_with_their_escapes_decoded);
  RUN_TEST(test_net_reads_only_its_own_members);
  RUN_TEST(test_key_ring_moves_forward_and_holds_two);
  RUN_TEST(test_net_and_key_next_ignore_extra_keys_of_every_kind);
  return UNITY_END();
}

// The member-code libraries against the shared contract corpus — every case in
// src/contracts/device-protocol/membercode/ that manifest.json says the SHARED
// firmware suite reads, executed, counted, and cross-checked against the count
// the manifest declares.
//
// WHY THE CORPUS AND NOT HAND-WRITTEN EXPECTATIONS
// ------------------------------------------------
// Four implementations have to agree on these bytes — the court bridge and the
// door gate (this code), the server (C#) and the member's phone (TypeScript over
// WebCrypto) — and none can see another's source. The vectors are written by
// src/iot/tools/membercode_vectors.py from the spec with Python's own hmac,
// hashlib and zoneinfo, so every implementation is checked against arithmetic
// none of them wrote. A hand-written expectation here would be this suite
// agreeing with itself.
//
// WHY THE COUNTS ARE ASSERTED
// ---------------------------
// The corpus README's rule: a side that skips what it cannot parse passes every
// assertion it runs. The last test compares what ran with what is declared, per
// file and per section, for every file whose `read_by` names `fw-shared` — so a
// case added to the corpus and not executed here is red.

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unity.h>

#include "devcrypto/Base64Url.h"
#include "devcrypto/Hex.h"
#include "devcrypto/Sha256.h"
#include "devlink/CodeSync.h"
#include "devlink/RosterSync.h"
#include "memcode/GuessGuard.h"
#include "memcode/KeyRing.h"
#include "memcode/ReplayRing.h"
#include "memcode/StepClock.h"
#include "memcode/Token.h"
#include "memcode/Totp.h"
#include "memcode/Verifier.h"
#include "roster/Roster.h"
#include "support/CorpusJson.h"

void setUp(void) {
}

void tearDown(void) {
}

namespace {

constexpr char kFamily[] = "membercode";

/// One loaded file at a time is enough, and 64 KB each is not stack material.
corpus::File g_file;
corpus::File g_manifest;

/// What this suite executed, per (file, section), for the final count check.
struct Executed {
  char file[32];
  char section[32];
  size_t count;
};

Executed g_executed[32];
size_t g_executedCount = 0U;

void noteExecuted(const char* file, const char* section) {
  for (size_t i = 0U; i < g_executedCount; ++i) {
    if (strcmp(g_executed[i].file, file) == 0 && strcmp(g_executed[i].section, section) == 0) {
      ++g_executed[i].count;
      return;
    }
  }
  TEST_ASSERT_TRUE_MESSAGE(g_executedCount < 32U, "too many sections for the ledger");
  Executed& e = g_executed[g_executedCount++];
  snprintf(e.file, sizeof(e.file), "%s", file);
  snprintf(e.section, sizeof(e.section), "%s", section);
  e.count = 1U;
}

size_t executedCount(const char* file, const char* section) {
  for (size_t i = 0U; i < g_executedCount; ++i) {
    if (strcmp(g_executed[i].file, file) == 0 && strcmp(g_executed[i].section, section) == 0) {
      return g_executed[i].count;
    }
  }
  return 0U;
}

const char* load(const char* file) {
  char message[96];
  snprintf(message, sizeof(message), "membercode/%s not found — a skipped corpus proves nothing", file);
  TEST_ASSERT_TRUE_MESSAGE(g_file.load(kFamily, file), message);
  return g_file.root();
}

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
  const char* p = corpus::skipWs(value);
  return strncmp(p, "true", 4) == 0;
}

bool has(const char* object, const char* name) {
  return corpus::member(object, name) != nullptr;
}

/// A `*_hex` member into `out`; returns the byte count.
size_t hex(const char* object, const char* name, uint8_t* out, size_t cap) {
  size_t n = 0U;
  TEST_ASSERT_TRUE_MESSAGE(corpus::hexField(object, name, out, cap, &n), name);
  return n;
}

/// `body_hex` as a NUL-terminated document. Static: bodies run to several KB.
const char* body(const char* object, size_t& len) {
  static uint8_t bytes[corpus::kMaxStringLen];
  static char out[corpus::kMaxStringLen + 1U];
  len = hex(object, "body_hex", bytes, sizeof(bytes));
  memcpy(out, bytes, len);
  out[len] = '\0';
  return out;
}

void assertDigits(uint32_t value, const char* expected, size_t digits, const char* label) {
  char rendered[12] = {};
  snprintf(rendered, sizeof(rendered), "%0*lu", static_cast<int>(digits), static_cast<unsigned long>(value));
  TEST_ASSERT_EQUAL_STRING_MESSAGE(expected, rendered, label);
}

const char* verdictName(roster::Verdict v) {
  switch (v) {
  case roster::Verdict::Allow:
    return "allow";
  case roster::Verdict::Unknown:
    return "unknown";
  case roster::Verdict::TooEarly:
    return "too_early";
  case roster::Verdict::TooLate:
    return "too_late";
  case roster::Verdict::WrongCourt:
    return "wrong_court";
  case roster::Verdict::Stale:
    return "stale";
  }
  return "?";
}

} // namespace

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

void test_sha256_matches_every_vector_fed_whole_and_byte_by_byte(void) {
  const char* doc = load("sha256.json");
  corpus::ArrayIter it(array(doc, "cases"));
  const char* c = nullptr;
  static uint8_t message[512];
  while (it.next(&c)) {
    char id[48] = {};
    text(c, "id", id, sizeof(id));
    const size_t len = hex(c, "message_hex", message, sizeof(message));
    const uint64_t repeat = number(c, "repeat");
    uint8_t expected[32];
    TEST_ASSERT_EQUAL_size_t_MESSAGE(32U, hex(c, "digest_hex", expected, sizeof(expected)), id);

    // Whole: the message `repeat` times, in chunks, so the million-'a' vector
    // crosses every buffer boundary.
    dc::Sha256 whole;
    static uint8_t chunk[4096];
    size_t chunkReps = len == 0U ? 1U : sizeof(chunk) / len;
    if (chunkReps > repeat) {
      chunkReps = static_cast<size_t>(repeat);
    }
    for (size_t r = 0U; r < chunkReps; ++r) {
      memcpy(chunk + (r * len), message, len);
    }
    uint64_t fed = 0U;
    while (fed < repeat) {
      const uint64_t reps = (repeat - fed) < chunkReps ? (repeat - fed) : chunkReps;
      whole.update(chunk, static_cast<size_t>(reps) * len);
      fed += reps == 0U ? 1U : reps;
    }
    uint8_t digest[32];
    whole.finish(digest);
    TEST_ASSERT_EQUAL_HEX8_ARRAY_MESSAGE(expected, digest, 32, id);

    // Byte by byte, for the short ones: the streaming buffer must not care how
    // the message arrives.
    if (repeat == 1U) {
      dc::Sha256 bytewise;
      for (size_t i = 0U; i < len; ++i) {
        bytewise.update(message + i, 1U);
      }
      bytewise.finish(digest);
      TEST_ASSERT_EQUAL_HEX8_ARRAY_MESSAGE(expected, digest, 32, id);
    }
    noteExecuted("sha256.json", "cases");
  }
}

void test_hmac_sha256_matches_rfc_4231_and_the_contract_shapes(void) {
  const char* doc = load("hmac.json");
  corpus::ArrayIter it(array(doc, "cases"));
  const char* c = nullptr;
  static uint8_t key[256];
  static uint8_t data[512];
  while (it.next(&c)) {
    char id[48] = {};
    text(c, "id", id, sizeof(id));
    const size_t keyLen = hex(c, "key_hex", key, sizeof(key));
    const size_t dataLen = hex(c, "data_hex", data, sizeof(data));
    uint8_t expected[32];
    const size_t macLen = hex(c, "mac_hex", expected, sizeof(expected));
    uint8_t mac[32];
    dc::hmacSha256(key, keyLen, data, dataLen, mac);
    TEST_ASSERT_EQUAL_HEX8_ARRAY_MESSAGE(expected, mac, macLen, id);
    noteExecuted("hmac.json", "cases");
  }
}

void test_hkdf_sha256_matches_rfc_5869(void) {
  const char* doc = load("hkdf.json");
  corpus::ArrayIter it(array(doc, "cases"));
  const char* c = nullptr;
  while (it.next(&c)) {
    char id[48] = {};
    text(c, "id", id, sizeof(id));
    uint8_t ikm[128];
    uint8_t salt[128];
    uint8_t info[128];
    uint8_t expected[128];
    const size_t ikmLen = hex(c, "ikm_hex", ikm, sizeof(ikm));
    const size_t saltLen = hex(c, "salt_hex", salt, sizeof(salt));
    const size_t infoLen = hex(c, "info_hex", info, sizeof(info));
    const size_t okmLen = hex(c, "okm_hex", expected, sizeof(expected));
    TEST_ASSERT_EQUAL_size_t_MESSAGE(static_cast<size_t>(number(c, "length")), okmLen, id);
    uint8_t okm[128];
    const dc::ByteSpan saltSpan = {salt, saltLen};
    const dc::ByteSpan ikmSpan = {ikm, ikmLen};
    const dc::ByteSpan infoSpan = {info, infoLen};
    TEST_ASSERT_TRUE_MESSAGE(dc::hkdfSha256(saltSpan, ikmSpan, infoSpan, okm, okmLen), id);
    TEST_ASSERT_EQUAL_HEX8_ARRAY_MESSAGE(expected, okm, okmLen, id);
    noteExecuted("hkdf.json", "cases");
  }
  // The RFC's ceiling, and a zero length, are refusals rather than truncations.
  uint8_t out[8];
  const dc::ByteSpan none = {nullptr, 0U};
  const dc::ByteSpan one = {out, 1U};
  TEST_ASSERT_FALSE(dc::hkdfSha256(none, one, none, out, 0U));
  TEST_ASSERT_FALSE(dc::hkdfSha256(none, one, none, out, (255U * dc::kSha256Bytes) + 1U));
}

void test_totp_matches_rfc_6238_and_the_contract_keys(void) {
  const char* doc = load("totp.json");
  corpus::ArrayIter it(array(doc, "cases"));
  const char* c = nullptr;
  while (it.next(&c)) {
    char id[48] = {};
    char code[12] = {};
    text(c, "id", id, sizeof(id));
    text(c, "code", code, sizeof(code));
    uint8_t key[64];
    const size_t keyLen = hex(c, "key_hex", key, sizeof(key));
    const uint64_t step = number(c, "step");
    const uint8_t digits = static_cast<uint8_t>(number(c, "digits"));
    TEST_ASSERT_EQUAL_UINT64_MESSAGE(number(c, "unix") / 30U, step, id);
    assertDigits(memcode::hotp(key, keyLen, step, digits), code, digits, id);
    noteExecuted("totp.json", "cases");
  }
}

void test_base64url_is_strict_both_ways(void) {
  // Not a corpus file: the corpus pins the ELEMENTS that carry base64url
  // (codesync.json); this pins the codec's own refusals.
  const uint8_t bytes[12] = {0xFBU, 0xFFU, 0xBFU, 0xFBU, 0xFFU, 0xBFU,
                             0x00U, 0x10U, 0x83U, 0x10U, 0x51U, 0x87U};
  char textOut[dc::b64url::encodedLen(12U) + 1U] = {};
  TEST_ASSERT_TRUE(dc::b64url::encode(bytes, sizeof(bytes), textOut, sizeof(textOut)));
  TEST_ASSERT_EQUAL_STRING("-_-_-_-_ABCDEFGH", textOut);
  uint8_t back[12] = {};
  size_t n = 0U;
  TEST_ASSERT_TRUE(dc::b64url::decode(textOut, 16U, back, sizeof(back), &n));
  TEST_ASSERT_EQUAL_size_t(12U, n);
  TEST_ASSERT_EQUAL_HEX8_ARRAY(bytes, back, 12);

  TEST_ASSERT_FALSE(dc::b64url::decode("+_-_-_-_ABCDEFGH", 16U, back, sizeof(back), &n)); // standard alphabet
  TEST_ASSERT_FALSE(dc::b64url::decode("QQ==", 4U, back, sizeof(back), &n));              // padding
  TEST_ASSERT_FALSE(dc::b64url::decode("QUJ", 3U, back, 1U, &n));                         // does not fit
  TEST_ASSERT_FALSE(dc::b64url::decode("QR", 2U, back, sizeof(back), &n));                // trailing bits set
  TEST_ASSERT_TRUE(dc::b64url::decode("QQ", 2U, back, sizeof(back), &n));                 // 'A'
  TEST_ASSERT_EQUAL_size_t(1U, n);
  TEST_ASSERT_EQUAL_HEX8(0x41U, back[0]);
  TEST_ASSERT_FALSE(dc::b64url::decode("QUJDR", 5U, back, sizeof(back), &n)); // a dangling sextet
}

// ---------------------------------------------------------------------------
// The chain, the token
// ---------------------------------------------------------------------------

void test_derivation_chain_master_to_token(void) {
  const char* doc = load("derivation.json");
  uint8_t master[64];
  const size_t masterLen = hex(doc, "fixture_master_key_hex", master, sizeof(master));
  corpus::ArrayIter it(array(doc, "cases"));
  const char* c = nullptr;
  while (it.next(&c)) {
    char id[64] = {};
    char tenant[40] = {};
    char user[40] = {};
    char ref[8] = {};
    text(c, "id", id, sizeof(id));
    text(c, "tenant_id", tenant, sizeof(tenant));
    text(c, "user_id", user, sizeof(user));
    text(c, "ref", ref, sizeof(ref));

    uint8_t expectedSecret[32];
    hex(c, "member_secret_hex", expectedSecret, sizeof(expectedSecret));
    uint8_t secret[32];
    TEST_ASSERT_TRUE_MESSAGE(memcode::deriveMemberSecret(master, masterLen, tenant, user,
                                                         static_cast<uint32_t>(number(c, "generation")),
                                                         secret),
                             id);
    TEST_ASSERT_EQUAL_HEX8_ARRAY_MESSAGE(expectedSecret, secret, 32, id);

    uint32_t refValue = 0U;
    TEST_ASSERT_TRUE_MESSAGE(memcode::decodeRef(ref, refValue), id);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(static_cast<uint32_t>(number(c, "ref_value")), refValue, id);

    corpus::ArrayIter steps(array(c, "steps"));
    const char* s = nullptr;
    while (steps.next(&s)) {
      char day[16] = {};
      char on[12] = {};
      char off[12] = {};
      char token[24] = {};
      char kdayText[24] = {};
      text(s, "club_day", day, sizeof(day));
      text(s, "on", on, sizeof(on));
      text(s, "off", off, sizeof(off));
      text(s, "token", token, sizeof(token));
      text(s, "kday_b64url", kdayText, sizeof(kdayText));
      const uint32_t step = static_cast<uint32_t>(number(s, "step"));

      uint8_t expectedKday[12];
      hex(s, "kday_hex", expectedKday, sizeof(expectedKday));
      uint8_t kday[12];
      TEST_ASSERT_TRUE_MESSAGE(memcode::deriveDayKey(secret, day, kday), id);
      TEST_ASSERT_EQUAL_HEX8_ARRAY_MESSAGE(expectedKday, kday, 12, id);
      uint8_t fromWire[12];
      size_t n = 0U;
      TEST_ASSERT_TRUE_MESSAGE(dc::b64url::decode(kdayText, strlen(kdayText), fromWire, sizeof(fromWire), &n),
                               id);
      TEST_ASSERT_EQUAL_HEX8_ARRAY_MESSAGE(expectedKday, fromWire, 12, id);

      const uint32_t onValue = memcode::onCode(secret, step);
      const uint32_t offValue = memcode::offCode(kday, step);
      assertDigits(onValue, on, 8U, id);
      assertDigits(offValue, off, 6U, id);
      char rendered[memcode::kTokenLen + 1U] = {};
      TEST_ASSERT_TRUE(memcode::format(refValue, onValue, offValue, rendered, sizeof(rendered)));
      TEST_ASSERT_EQUAL_STRING_MESSAGE(token, rendered, id);
    }
    noteExecuted("derivation.json", "cases");
  }
}

void test_token_encode_and_decode(void) {
  const char* doc = load("token.json");
  TEST_ASSERT_EQUAL_UINT64(memcode::kTokenLen, number(doc, "token_len"));

  corpus::ArrayIter enc(array(doc, "encode"));
  const char* c = nullptr;
  while (enc.next(&c)) {
    char id[48] = {};
    char token[24] = {};
    char ref[8] = {};
    char on[12] = {};
    char off[12] = {};
    text(c, "id", id, sizeof(id));
    text(c, "token", token, sizeof(token));
    text(c, "ref", ref, sizeof(ref));
    text(c, "on", on, sizeof(on));
    text(c, "off", off, sizeof(off));
    char refOut[8] = {};
    TEST_ASSERT_TRUE_MESSAGE(memcode::encodeRef(static_cast<uint32_t>(number(c, "ref_value")), refOut), id);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(ref, refOut, id);
    char rendered[memcode::kTokenLen + 1U] = {};
    TEST_ASSERT_TRUE_MESSAGE(memcode::format(static_cast<uint32_t>(number(c, "ref_value")),
                                             static_cast<uint32_t>(strtoul(on, nullptr, 10)),
                                             static_cast<uint32_t>(strtoul(off, nullptr, 10)), rendered,
                                             sizeof(rendered)),
                             id);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(token, rendered, id);
    noteExecuted("token.json", "encode");
  }

  corpus::ArrayIter dec(array(doc, "decode"));
  while (dec.next(&c)) {
    char id[48] = {};
    char input[48] = {};
    text(c, "id", id, sizeof(id));
    text(c, "input", input, sizeof(input));
    memcode::Token token;
    const bool ok = memcode::parse(input, token);
    TEST_ASSERT_EQUAL_MESSAGE(flag(c, "ok"), ok, id);
    if (ok) {
      char ref[8] = {};
      char on[12] = {};
      char off[12] = {};
      text(c, "ref", ref, sizeof(ref));
      text(c, "on", on, sizeof(on));
      text(c, "off", off, sizeof(off));
      TEST_ASSERT_EQUAL_STRING_MESSAGE(ref, token.refText, id);
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(static_cast<uint32_t>(number(c, "ref_value")), token.ref, id);
      assertDigits(token.on, on, 8U, id);
      assertDigits(token.off, off, 6U, id);
    }
    noteExecuted("token.json", "decode");
  }
}

// ---------------------------------------------------------------------------
// The wire: roster elements, key and day elements, a whole sync
// ---------------------------------------------------------------------------

void test_roster_elements_carry_one_to_four_refs(void) {
  const char* doc = load("roster.json");
  corpus::ArrayIter it(array(doc, "elements"));
  const char* c = nullptr;
  while (it.next(&c)) {
    char id[48] = {};
    char element[64] = {};
    text(c, "id", id, sizeof(id));
    text(c, "element", element, sizeof(element));
    roster::Entry entry;
    const bool ok = devlink::parseRosterElement(element, entry);
    TEST_ASSERT_EQUAL_MESSAGE(flag(c, "ok"), ok, id);
    if (ok) {
      char token[32] = {};
      text(c, "token", token, sizeof(token));
      TEST_ASSERT_EQUAL_STRING_MESSAGE(token, entry.token, id);
      TEST_ASSERT_EQUAL_UINT8_MESSAGE(static_cast<uint8_t>(number(c, "relay")), entry.court, id);
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(static_cast<uint32_t>(number(c, "opens_ms")), entry.opensAtMs, id);
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(static_cast<uint32_t>(number(c, "closes_ms")), entry.closesAtMs, id);
      const char* refs = corpus::member(c, "refs");
      if (refs != nullptr && corpus::isArray(refs)) {
        corpus::ArrayIter ri(refs);
        const char* r = nullptr;
        while (ri.next(&r)) {
          char ref[8] = {};
          TEST_ASSERT_TRUE(corpus::stringValue(r, ref, sizeof(ref), nullptr));
          TEST_ASSERT_TRUE_MESSAGE(roster::refListNames(entry.token, ref), id);
        }
      }
    }
    noteExecuted("roster.json", "elements");
  }
}

void test_roster_decides_a_proved_ref_and_never_crosses_the_two_paths(void) {
  const char* doc = load("roster.json");
  corpus::ArrayIter it(array(doc, "decide"));
  const char* c = nullptr;
  while (it.next(&c)) {
    char id[64] = {};
    char expected[16] = {};
    text(c, "id", id, sizeof(id));
    text(c, "verdict", expected, sizeof(expected));

    roster::Roster<devlink::kMaxRosterEntries> cache(static_cast<uint32_t>(number(c, "max_age_ms")));
    cache.beginReplace(static_cast<uint32_t>(number(c, "accepted_at_ms")));
    corpus::ArrayIter els(array(c, "roster"));
    const char* e = nullptr;
    while (els.next(&e)) {
      char element[64] = {};
      TEST_ASSERT_TRUE(corpus::stringValue(e, element, sizeof(element), nullptr));
      roster::Entry entry;
      TEST_ASSERT_TRUE_MESSAGE(devlink::parseRosterElement(element, entry), id);
      TEST_ASSERT_TRUE(cache.add(entry));
    }
    cache.commitReplace();

    const roster::CourtCount courts(static_cast<uint8_t>(number(c, "courts")));
    const uint32_t at = static_cast<uint32_t>(number(c, "at_ms"));
    roster::Decision decision;
    if (has(c, "ref")) {
      char ref[8] = {};
      text(c, "ref", ref, sizeof(ref));
      decision = cache.decideMember(ref, courts, at);
    } else {
      char token[32] = {};
      text(c, "token", token, sizeof(token));
      decision = cache.decide(token, courts, at);
    }
    TEST_ASSERT_EQUAL_STRING_MESSAGE(expected, verdictName(decision.verdict), id);
    if (has(c, "court")) {
      TEST_ASSERT_EQUAL_UINT8_MESSAGE(static_cast<uint8_t>(number(c, "court")), decision.entry.court, id);
    }
    if (has(c, "grant_ms")) {
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(static_cast<uint32_t>(number(c, "grant_ms")), decision.grantMs, id);
    }
    noteExecuted("roster.json", "decide");
  }
}

void test_key_and_day_elements(void) {
  const char* doc = load("codesync.json");
  TEST_ASSERT_EQUAL_UINT64(memcode::kKeyElementLen, number(doc, "key_len"));
  corpus::ArrayIter keys(array(doc, "key_elements"));
  const char* c = nullptr;
  while (keys.next(&c)) {
    char id[48] = {};
    char element[64] = {};
    text(c, "id", id, sizeof(id));
    text(c, "element", element, sizeof(element));
    memcode::DayKey key;
    const bool ok = memcode::parseKeyElement(element, strlen(element), key);
    TEST_ASSERT_EQUAL_MESSAGE(flag(c, "ok"), ok, id);
    if (ok) {
      char ref[8] = {};
      text(c, "ref", ref, sizeof(ref));
      uint32_t refValue = 0U;
      TEST_ASSERT_TRUE(memcode::decodeRef(ref, refValue));
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(refValue, key.ref, id);
      TEST_ASSERT_EQUAL_UINT8_MESSAGE(static_cast<uint8_t>(number(c, "slot")), key.slot, id);
      uint8_t expected[12];
      hex(c, "key_hex", expected, sizeof(expected));
      TEST_ASSERT_EQUAL_HEX8_ARRAY_MESSAGE(expected, key.key, 12, id);
    }
    noteExecuted("codesync.json", "key_elements");
  }
  corpus::ArrayIter days(array(doc, "day_elements"));
  while (days.next(&c)) {
    char id[48] = {};
    char element[64] = {};
    text(c, "id", id, sizeof(id));
    text(c, "element", element, sizeof(element));
    memcode::DaySlot day;
    const bool ok = memcode::parseDaySlot(element, strlen(element), day);
    TEST_ASSERT_EQUAL_MESSAGE(flag(c, "ok"), ok, id);
    if (ok) {
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(static_cast<uint32_t>(number(c, "first_step")), day.firstStep, id);
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(static_cast<uint32_t>(number(c, "end_step")), day.endStep, id);
    }
    noteExecuted("codesync.json", "day_elements");
  }
}

namespace {

template <uint8_t Cap> void checkApply(const char* c, const char* id) {
  size_t len = 0U;
  const char* doc = body(c, len);
  const uint32_t at = static_cast<uint32_t>(number(c, "received_at_ms"));
  memcode::StepClock clock(21600000UL);
  memcode::KeyRing<Cap> ring;
  // A ring that already holds something, so "untouched" is observable.
  ring.beginReplace();
  memcode::DaySlot old;
  old.firstStep = 1U;
  old.endStep = 2U;
  old.valid = true;
  TEST_ASSERT_TRUE(ring.setDay(0U, old));
  memcode::DayKey sentinel;
  sentinel.ref = 1U;
  TEST_ASSERT_TRUE(ring.add(sentinel));
  ring.commitReplace();

  const devlink::CodeSyncResult result = devlink::applyCodeSync(doc, len, clock, ring, at);
  const char* expect = corpus::member(c, "expect");
  const char* clockExpect = corpus::member(expect, "clock");
  TEST_ASSERT_EQUAL_MESSAGE(flag(clockExpect, "synced"), result.clockSynced, id);
  if (result.clockSynced) {
    const uint32_t step = static_cast<uint32_t>(number(clockExpect, "step"));
    const uint32_t stepMs = static_cast<uint32_t>(number(clockExpect, "step_ms"));
    TEST_ASSERT_TRUE_MESSAGE(clock.trusted(at), id);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(step, clock.stepAt(at), id);
    // The phase is honoured: the step turns over exactly (30000 - step_ms) later.
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(step, clock.stepAt(at + (memcode::kStepMs - stepMs) - 1U), id);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(step + 1U, clock.stepAt(at + (memcode::kStepMs - stepMs)), id);
  } else {
    TEST_ASSERT_FALSE_MESSAGE(clock.synced(), id);
  }

  const char* keysExpect = corpus::member(expect, "keys");
  TEST_ASSERT_EQUAL_MESSAGE(flag(keysExpect, "replaced"), result.keysReplaced, id);
  if (!result.keysReplaced) {
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(1U, ring.size(), id);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(1U, ring.at(0U).ref, id);
    TEST_ASSERT_TRUE_MESSAGE(ring.day(0U).valid && ring.day(0U).firstStep == 1U, id);
    return;
  }
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(static_cast<uint8_t>(number(keysExpect, "accepted")), result.accepted, id);
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(static_cast<uint8_t>(number(keysExpect, "rejected")), result.rejected, id);
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(static_cast<uint8_t>(number(keysExpect, "dropped")), result.dropped, id);
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(result.accepted, ring.size(), id);

  corpus::ArrayIter entries(array(keysExpect, "entries"));
  const char* e = nullptr;
  uint8_t i = 0U;
  while (entries.next(&e)) {
    char ref[8] = {};
    text(e, "ref", ref, sizeof(ref));
    uint32_t refValue = 0U;
    TEST_ASSERT_TRUE(memcode::decodeRef(ref, refValue));
    TEST_ASSERT_TRUE_MESSAGE(i < ring.size(), id);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(refValue, ring.at(i).ref, id);
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(static_cast<uint8_t>(number(e, "slot")), ring.at(i).slot, id);
    uint8_t key[12];
    hex(e, "key_hex", key, sizeof(key));
    TEST_ASSERT_EQUAL_HEX8_ARRAY_MESSAGE(key, ring.at(i).key, 12, id);
    ++i;
  }
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(ring.size(), i, id);

  corpus::ArrayIter days(array(keysExpect, "days"));
  const char* d = nullptr;
  uint8_t slot = 0U;
  while (days.next(&d)) {
    TEST_ASSERT_TRUE_MESSAGE(slot < memcode::kMaxDaySlots, id);
    const char* p = corpus::skipWs(d);
    if (strncmp(p, "null", 4) == 0) {
      TEST_ASSERT_FALSE_MESSAGE(ring.day(slot).valid, id);
    } else {
      TEST_ASSERT_TRUE_MESSAGE(ring.day(slot).valid, id);
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(static_cast<uint32_t>(number(d, "first_step")),
                                       ring.day(slot).firstStep, id);
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(static_cast<uint32_t>(number(d, "end_step")), ring.day(slot).endStep,
                                       id);
    }
    ++slot;
  }
  // Every slot the vector does not name is EMPTY — the sentinel day the ring
  // held before this body must not survive a replacement.
  for (; slot < memcode::kMaxDaySlots; ++slot) {
    TEST_ASSERT_FALSE_MESSAGE(ring.day(slot).valid, id);
  }
}

} // namespace

void test_code_sync_applies_a_whole_body_by_the_roster_rules(void) {
  const char* doc = load("codesync.json");
  corpus::ArrayIter it(array(doc, "apply"));
  const char* c = nullptr;
  while (it.next(&c)) {
    char id[48] = {};
    text(c, "id", id, sizeof(id));
    const uint64_t capacity = number(c, "key_capacity");
    if (capacity == 24U) {
      checkApply<24U>(c, id);
    } else if (capacity == 3U) {
      checkApply<3U>(c, id);
    } else {
      TEST_FAIL_MESSAGE("a key_capacity this suite has no ring for");
    }
    noteExecuted("codesync.json", "apply");
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

namespace {

template <uint8_t ReplayCap> void runScenario(const char* c, const char* id) {
  uint32_t maxAge = 21600000UL;
  if (has(c, "max_age_ms")) {
    maxAge = static_cast<uint32_t>(number(c, "max_age_ms"));
  }
  memcode::StepClock clock(maxAge);
  memcode::KeyRing<24U> ring;
  memcode::ReplayRing<ReplayCap> used;

  ring.beginReplace();
  corpus::ArrayIter days(array(c, "days"));
  const char* d = nullptr;
  uint8_t slot = 0U;
  while (days.next(&d)) {
    char element[40] = {};
    TEST_ASSERT_TRUE(corpus::stringValue(d, element, sizeof(element), nullptr));
    memcode::DaySlot day;
    TEST_ASSERT_TRUE_MESSAGE(memcode::parseDaySlot(element, strlen(element), day), id);
    TEST_ASSERT_TRUE(ring.setDay(slot, day));
    ++slot;
  }
  corpus::ArrayIter keys(array(c, "keys"));
  const char* k = nullptr;
  while (keys.next(&k)) {
    char element[40] = {};
    TEST_ASSERT_TRUE(corpus::stringValue(k, element, sizeof(element), nullptr));
    memcode::DayKey key;
    TEST_ASSERT_TRUE_MESSAGE(memcode::parseKeyElement(element, strlen(element), key), id);
    TEST_ASSERT_TRUE(ring.add(key));
  }
  ring.commitReplace();

  const auto runScans = [&](const char* list) {
    corpus::ArrayIter scans(list);
    const char* s = nullptr;
    while (scans.next(&s)) {
      char token[40] = {};
      char expect[16] = {};
      text(s, "token", token, sizeof(token));
      text(s, "expect", expect, sizeof(expect));
      const uint32_t at = static_cast<uint32_t>(number(s, "at_ms"));
      const memcode::Verdict v = memcode::verify(token, clock, ring, used, at);
      char label[96] = {};
      snprintf(label, sizeof(label), "%s: %s at %lu", id, token, static_cast<unsigned long>(at));
      TEST_ASSERT_EQUAL_STRING_MESSAGE(expect, memcode::statusName(v.status), label);
      if (has(s, "ref")) {
        char ref[8] = {};
        text(s, "ref", ref, sizeof(ref));
        TEST_ASSERT_EQUAL_STRING_MESSAGE(ref, v.token.refText, label);
      }
      if (has(s, "step")) {
        TEST_ASSERT_EQUAL_UINT32_MESSAGE(static_cast<uint32_t>(number(s, "step")), v.step, label);
      }
      if (flag(s, "commit")) {
        TEST_ASSERT_TRUE_MESSAGE(v.status == memcode::Status::Ok, label);
        used.commit(v.token.ref, v.step);
      }
    }
  };

  if (has(c, "unsynced_scans")) {
    runScans(array(c, "unsynced_scans"));
  }
  const char* sync = corpus::member(c, "sync");
  TEST_ASSERT_NOT_NULL(sync);
  TEST_ASSERT_TRUE_MESSAGE(clock.sync(static_cast<uint32_t>(number(sync, "step")),
                                      static_cast<uint32_t>(number(sync, "step_ms")),
                                      static_cast<uint32_t>(number(sync, "at_ms"))),
                           id);
  runScans(array(c, "scans"));
}

} // namespace

void test_offline_verification_scenarios(void) {
  const char* doc = load("verify.json");
  TEST_ASSERT_EQUAL_UINT64(memcode::kStepMs, number(doc, "step_ms"));
  TEST_ASSERT_EQUAL_UINT64(memcode::kWindowSteps, number(doc, "window"));
  corpus::ArrayIter it(array(doc, "scenarios"));
  const char* c = nullptr;
  while (it.next(&c)) {
    char id[48] = {};
    text(c, "id", id, sizeof(id));
    const uint64_t capacity = number(c, "replay_capacity");
    if (capacity == 4U) {
      runScenario<4U>(c, id);
    } else if (capacity == 2U) {
      runScenario<2U>(c, id);
    } else {
      TEST_FAIL_MESSAGE("a replay_capacity this suite has no ring for");
    }
    noteExecuted("verify.json", "scenarios");
  }
}

void test_step_clock_refuses_a_phase_outside_the_step_and_forgets_on_demand(void) {
  memcode::StepClock clock(1000U);
  TEST_ASSERT_FALSE(clock.trusted(0U));
  TEST_ASSERT_EQUAL_UINT32(0U, clock.stepAt(0U));
  TEST_ASSERT_FALSE(clock.sync(5U, memcode::kStepMs, 0U));
  TEST_ASSERT_FALSE(clock.synced());
  TEST_ASSERT_TRUE(clock.sync(5U, memcode::kStepMs - 1U, 100U));
  TEST_ASSERT_EQUAL_UINT32(5U, clock.stepAt(100U));
  TEST_ASSERT_EQUAL_UINT32(6U, clock.stepAt(101U));
  TEST_ASSERT_TRUE(clock.trusted(1100U));
  TEST_ASSERT_FALSE(clock.trusted(1101U));
  clock.forget();
  TEST_ASSERT_FALSE(clock.trusted(100U));
}

/// THE STEP CLOCK, UNSYNCED FOR 49.7 DAYS (R18 D18-2). Its age is a 32-bit
/// difference, so a sync taken 2^32 ms + 1 s ago read one second old: trusted,
/// and 143 165 steps behind the member's phone — which accepts any code
/// photographed at the time of that sync. Observed every pass (hourly here),
/// a clock past its maximum age stays untrusted until the next sync. Every
/// clock base, both ages past the wrap.
void test_step_clock_an_age_past_the_millis_wrap_never_reads_trusted_again(void) {
  const uint32_t bases[] = {0U, 1234567U, 0xFFFFF000U, 0xFFFFFFFFU};
  const uint64_t ages[] = {0x100000000ULL + 1000ULL, 0x100000000ULL + 86400000ULL};
  const uint32_t sixHours = 21600000UL;
  for (const uint32_t base : bases) {
    for (const uint64_t age : ages) {
      memcode::StepClock clock(sixHours);
      TEST_ASSERT_TRUE(clock.sync(1000U, 0U, base));
      for (uint64_t t = 0U; t < age; t += 3600000ULL) {
        const uint32_t now = static_cast<uint32_t>(base + t);
        clock.observe(now);
        // Observing a fresh clock does not age it.
        TEST_ASSERT_EQUAL(t <= sixHours, clock.trusted(now));
      }
      const uint32_t back = static_cast<uint32_t>(base + age);
      clock.observe(back);
      TEST_ASSERT_FALSE_MESSAGE(clock.trusted(back), "a step clock 49.7 days old read trusted again");
      TEST_ASSERT_EQUAL_UINT32(0U, clock.stepAt(back));

      // Only a sync clears it — and a forget and re-sync too.
      TEST_ASSERT_TRUE(clock.sync(144166U, 0U, back));
      TEST_ASSERT_TRUE(clock.trusted(back));
      TEST_ASSERT_EQUAL_UINT32(144166U, clock.stepAt(back));
      clock.forget();
      TEST_ASSERT_TRUE(clock.sync(144166U, 0U, back));
      TEST_ASSERT_TRUE(clock.trusted(back + sixHours));
    }
  }
}

void test_replay_ring_keeps_the_highest_step_and_evicts_the_oldest(void) {
  memcode::ReplayRing<2U> used;
  TEST_ASSERT_FALSE(used.seen(7U, 100U));
  used.commit(7U, 100U);
  TEST_ASSERT_TRUE(used.seen(7U, 100U));
  TEST_ASSERT_TRUE(used.seen(7U, 99U));
  TEST_ASSERT_FALSE(used.seen(7U, 101U));
  // A LOWER step never lowers the mark.
  used.commit(7U, 90U);
  TEST_ASSERT_TRUE(used.seen(7U, 100U));
  used.commit(8U, 100U);
  used.commit(9U, 100U); // evicts 7, the oldest
  TEST_ASSERT_FALSE(used.seen(7U, 100U));
  TEST_ASSERT_TRUE(used.seen(8U, 100U));
  TEST_ASSERT_EQUAL_UINT8(2U, used.size());
  used.clear();
  TEST_ASSERT_FALSE(used.seen(8U, 100U));
}

void test_key_ring_looks_keys_up_by_the_slot_whose_range_holds_the_step(void) {
  memcode::KeyRing<2U> ring;
  ring.beginReplace();
  memcode::DaySlot today;
  today.firstStep = 100U;
  today.endStep = 200U;
  today.valid = true;
  memcode::DaySlot tomorrow;
  tomorrow.firstStep = 200U;
  tomorrow.endStep = 300U;
  tomorrow.valid = true;
  TEST_ASSERT_TRUE(ring.setDay(0U, today));
  TEST_ASSERT_TRUE(ring.setDay(1U, tomorrow));
  TEST_ASSERT_FALSE(ring.setDay(2U, tomorrow));
  memcode::DayKey a;
  a.ref = 5U;
  a.slot = 0U;
  a.key[0] = 0xAAU;
  memcode::DayKey b;
  b.ref = 5U;
  b.slot = 1U;
  b.key[0] = 0xBBU;
  memcode::DayKey c;
  c.ref = 6U;
  TEST_ASSERT_TRUE(ring.add(a));
  TEST_ASSERT_TRUE(ring.add(b));
  TEST_ASSERT_FALSE(ring.add(c)); // full: counted, not silently lost
  // Nothing is live until the commit.
  TEST_ASSERT_NULL(ring.keyFor(5U, 150U));
  ring.commitReplace();
  TEST_ASSERT_EQUAL_UINT8(1U, ring.dropped());
  TEST_ASSERT_EQUAL_HEX8(0xAAU, ring.keyFor(5U, 199U)[0]);
  TEST_ASSERT_EQUAL_HEX8(0xBBU, ring.keyFor(5U, 200U)[0]);
  TEST_ASSERT_NULL(ring.keyFor(5U, 99U));
  TEST_ASSERT_NULL(ring.keyFor(5U, 300U));
  TEST_ASSERT_NULL(ring.keyFor(6U, 150U));
  ring.clear();
  TEST_ASSERT_NULL(ring.keyFor(5U, 150U));
  TEST_ASSERT_EQUAL_UINT8(0U, ring.size());
}

void test_a_scanned_ref_list_never_matches_and_a_ref_never_matches_a_code(void) {
  // The security property of the roster's two paths, pinned directly as well as
  // through the corpus: a REF is printed in every code, so `m` + a REF must not
  // be a key to that member's court; and a REF must never match a legacy code
  // that happens to contain its four characters.
  roster::Roster<4U> cache(1000000U);
  cache.beginReplace(0U);
  roster::Entry refs;
  TEST_ASSERT_TRUE(devlink::parseRosterElement("mK7M2P4XR|0|0|900", refs));
  roster::Entry legacy;
  TEST_ASSERT_TRUE(devlink::parseRosterElement("K7M2XXXXXXXX|1|0|900", legacy));
  TEST_ASSERT_TRUE(cache.add(refs));
  TEST_ASSERT_TRUE(cache.add(legacy));
  cache.commitReplace();

  TEST_ASSERT_EQUAL(roster::Verdict::Unknown, cache.decide("mK7M2P4XR", roster::CourtCount(4U), 10U).verdict);
  TEST_ASSERT_EQUAL(roster::Verdict::Unknown, cache.decide("mK7M2", roster::CourtCount(4U), 10U).verdict);
  const roster::Decision member = cache.decideMember("K7M2", roster::CourtCount(4U), 10U);
  TEST_ASSERT_EQUAL(roster::Verdict::Allow, member.verdict);
  TEST_ASSERT_EQUAL_UINT8(0U, member.entry.court);
  // Straddling two REFs is no REF.
  TEST_ASSERT_EQUAL(roster::Verdict::Unknown,
                    cache.decideMember("M2P4", roster::CourtCount(4U), 10U).verdict);
  TEST_ASSERT_TRUE(cache.occupied(0U, 10U));
  TEST_ASSERT_TRUE(cache.occupied(1U, 10U));
  TEST_ASSERT_FALSE(cache.occupied(2U, 10U));
  TEST_ASSERT_FALSE(cache.occupied(0U, 900000U));
}

void test_guess_guard_locks_after_five_wrong_codes_and_backs_off(void) {
  memcode::GuessGuard guard;
  const uint32_t t0 = 0xFFFFF000U; // across the millis() wrap, as a box runs for months
  for (uint8_t i = 0U; i < memcode::kGuessFailures - 1U; ++i) {
    guard.failed(t0 + i);
    TEST_ASSERT_FALSE(guard.locked(t0 + i));
  }
  guard.failed(t0 + 10U);
  TEST_ASSERT_TRUE(guard.locked(t0 + 10U));
  TEST_ASSERT_TRUE(guard.locked(t0 + 10U + memcode::kGuessLockBaseMs - 1U));
  TEST_ASSERT_FALSE(guard.locked(t0 + 10U + memcode::kGuessLockBaseMs));
  // The next trip locks for twice as long.
  TEST_ASSERT_EQUAL_UINT32(memcode::kGuessLockBaseMs * 2U, guard.nextLockMs());
  // Wrong codes spread wider than the window never add up to a lock.
  memcode::GuessGuard slow;
  for (uint32_t i = 0U; i < 20U; ++i) {
    slow.failed(i * (memcode::kGuessWindowMs / 4U));
    TEST_ASSERT_FALSE(slow.locked(i * (memcode::kGuessWindowMs / 4U)));
  }
  // A code that verifies resets everything.
  guard.succeeded();
  TEST_ASSERT_FALSE(guard.locked(t0 + 11U));
  TEST_ASSERT_EQUAL_UINT32(memcode::kGuessLockBaseMs, guard.nextLockMs());
  // The back-off is capped.
  memcode::GuessGuard capped;
  uint32_t now = 0U;
  for (int trip = 0; trip < 12; ++trip) {
    for (uint8_t i = 0U; i < memcode::kGuessFailures; ++i) {
      capped.failed(now);
    }
    now += memcode::kGuessLockMaxMs + 1U;
  }
  TEST_ASSERT_EQUAL_UINT32(memcode::kGuessLockMaxMs, capped.nextLockMs());
}

namespace {

/// A ring with one member's key for day [900, 1900) and a clock at step 1000.
struct OneKey {
  OneKey() : clock(21600000UL) {
    for (uint8_t i = 0U; i < memcode::kDayKeyBytes; ++i) {
      key.key[i] = static_cast<uint8_t>(i + 1U);
    }
    key.ref = 77U;
    memcode::DaySlot day;
    day.firstStep = 900U;
    day.endStep = 1900U;
    day.valid = true;
    ring.beginReplace();
    TEST_ASSERT_TRUE(ring.setDay(0U, day));
    TEST_ASSERT_TRUE(ring.add(key));
    ring.commitReplace();
    TEST_ASSERT_TRUE(clock.sync(1000U, 0U, 0U));
  }

  void token(uint32_t ref, uint32_t off, char* out) {
    TEST_ASSERT_TRUE(memcode::format(ref, 12345678U, off, out, memcode::kTokenLen + 1U));
  }

  memcode::StepClock clock;
  memcode::KeyRing<4U> ring;
  memcode::ReplayRing<4U> used;
  memcode::GuessGuard guard;
  memcode::DayKey key;
};

} // namespace

void test_verify_guarded_throttles_guessing_and_a_good_code_resets_it(void) {
  OneKey f;
  const memcode::OfflineCodes<memcode::KeyRing<4U>, memcode::ReplayRing<4U>> codes = {f.clock, f.ring, f.used,
                                                                                      f.guard};
  const uint32_t right = memcode::offCode(f.key.key, 1000U);
  char wrong[memcode::kTokenLen + 1U] = {};
  f.token(77U, (right + 1U) % 1000000U, wrong);
  for (uint8_t i = 0U; i < memcode::kGuessFailures; ++i) {
    TEST_ASSERT_EQUAL(memcode::Status::WrongCode, memcode::verifyGuarded(wrong, codes, 100U).status);
  }
  char good[memcode::kTokenLen + 1U] = {};
  f.token(77U, right, good);
  // Locked: even the RIGHT code is not tried — that is the stated trade.
  const memcode::Verdict locked = memcode::verifyGuarded(good, codes, 200U);
  TEST_ASSERT_EQUAL(memcode::Status::Throttled, locked.status);
  TEST_ASSERT_EQUAL_UINT32(77U, locked.token.ref);
  // A key the ring does not hold, or a malformed scan, never feeds the guard.
  memcode::GuessGuard fresh;
  const memcode::OfflineCodes<memcode::KeyRing<4U>, memcode::ReplayRing<4U>> other = {f.clock, f.ring, f.used,
                                                                                      fresh};
  char nokey[memcode::kTokenLen + 1U] = {};
  f.token(78U, right, nokey);
  for (int i = 0; i < 20; ++i) {
    TEST_ASSERT_EQUAL(memcode::Status::NoKey, memcode::verifyGuarded(nokey, other, 300U).status);
    TEST_ASSERT_EQUAL(memcode::Status::Malformed, memcode::verifyGuarded("7Q3F9KM2XZ8B", other, 300U).status);
  }
  TEST_ASSERT_FALSE(fresh.locked(300U));
  // After the lock, a good code — the one for the step it now is — verifies and
  // resets the back-off.
  const uint32_t after = 200U + memcode::kGuessLockBaseMs;
  char later[memcode::kTokenLen + 1U] = {};
  f.token(77U, memcode::offCode(f.key.key, f.clock.stepAt(after)), later);
  TEST_ASSERT_EQUAL(memcode::Status::Ok, memcode::verifyGuarded(later, codes, after).status);
  TEST_ASSERT_EQUAL_UINT32(memcode::kGuessLockBaseMs, f.guard.nextLockMs());
}

void test_an_online_use_is_recorded_so_the_code_cannot_be_used_offline_after(void) {
  OneKey f;
  char good[memcode::kTokenLen + 1U] = {};
  f.token(77U, memcode::offCode(f.key.key, 1000U), good);
  memcode::recordOnlineUse(good, f.clock, f.ring, f.used, 5000U);
  TEST_ASSERT_EQUAL(memcode::Status::Replayed, memcode::verify(good, f.clock, f.ring, f.used, 6000U).status);
  // A member this device holds no key for is recorded one step AHEAD, which
  // covers every step the server can have accepted around it.
  char unknown[memcode::kTokenLen + 1U] = {};
  f.token(99U, 123456U, unknown);
  memcode::recordOnlineUse(unknown, f.clock, f.ring, f.used, 5000U);
  TEST_ASSERT_TRUE(f.used.seen(99U, 1001U));
  TEST_ASSERT_FALSE(f.used.seen(99U, 1002U));
  // A legacy code, or a board with no trusted clock, records nothing.
  const uint8_t before = f.used.size();
  memcode::recordOnlineUse("7Q3F9KM2XZ8B", f.clock, f.ring, f.used, 5000U);
  memcode::StepClock unsynced(1000U);
  memcode::recordOnlineUse(good, unsynced, f.ring, f.used, 5000U);
  TEST_ASSERT_EQUAL_UINT8(before, f.used.size());
}

// ---------------------------------------------------------------------------
// Executed == declared
// ---------------------------------------------------------------------------

void test_every_declared_fw_shared_case_was_executed(void) {
  TEST_ASSERT_TRUE_MESSAGE(g_manifest.load(kFamily, "manifest.json"), "membercode/manifest.json not found");
  const char* files = corpus::member(g_manifest.root(), "files");
  TEST_ASSERT_NOT_NULL(files);
  corpus::ObjectIter fit(files);
  char name[corpus::kMaxNameLen] = {};
  const char* entry = nullptr;
  size_t filesRead = 0U;
  while (fit.next(name, sizeof(name), &entry)) {
    bool mine = false;
    corpus::ArrayIter readers(corpus::member(entry, "read_by"));
    const char* r = nullptr;
    while (readers.next(&r)) {
      char reader[24] = {};
      TEST_ASSERT_TRUE(corpus::stringValue(r, reader, sizeof(reader), nullptr));
      mine = mine || strcmp(reader, "fw-shared") == 0;
    }
    if (!mine) {
      continue;
    }
    ++filesRead;
    corpus::ObjectIter sections(corpus::member(entry, "case_count"));
    char section[corpus::kMaxNameLen] = {};
    const char* count = nullptr;
    while (sections.next(section, sizeof(section), &count)) {
      char label[96] = {};
      snprintf(label, sizeof(label), "%s/%s", name, section);
      TEST_ASSERT_EQUAL_size_t_MESSAGE(static_cast<size_t>(corpus::unsignedValue(count)),
                                       executedCount(name, section), label);
    }
  }
  // Nine files name this suite; a manifest that lost one must not pass quietly.
  TEST_ASSERT_EQUAL_size_t(9U, filesRead);
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_sha256_matches_every_vector_fed_whole_and_byte_by_byte);
  RUN_TEST(test_hmac_sha256_matches_rfc_4231_and_the_contract_shapes);
  RUN_TEST(test_hkdf_sha256_matches_rfc_5869);
  RUN_TEST(test_totp_matches_rfc_6238_and_the_contract_keys);
  RUN_TEST(test_base64url_is_strict_both_ways);
  RUN_TEST(test_derivation_chain_master_to_token);
  RUN_TEST(test_token_encode_and_decode);
  RUN_TEST(test_roster_elements_carry_one_to_four_refs);
  RUN_TEST(test_roster_decides_a_proved_ref_and_never_crosses_the_two_paths);
  RUN_TEST(test_key_and_day_elements);
  RUN_TEST(test_code_sync_applies_a_whole_body_by_the_roster_rules);
  RUN_TEST(test_offline_verification_scenarios);
  RUN_TEST(test_step_clock_refuses_a_phase_outside_the_step_and_forgets_on_demand);
  RUN_TEST(test_step_clock_an_age_past_the_millis_wrap_never_reads_trusted_again);
  RUN_TEST(test_replay_ring_keeps_the_highest_step_and_evicts_the_oldest);
  RUN_TEST(test_key_ring_looks_keys_up_by_the_slot_whose_range_holds_the_step);
  RUN_TEST(test_a_scanned_ref_list_never_matches_and_a_ref_never_matches_a_code);
  RUN_TEST(test_guess_guard_locks_after_five_wrong_codes_and_backs_off);
  RUN_TEST(test_verify_guarded_throttles_guessing_and_a_good_code_resets_it);
  RUN_TEST(test_an_online_use_is_recorded_so_the_code_cannot_be_used_offline_after);
  RUN_TEST(test_every_declared_fw_shared_case_was_executed);
  return UNITY_END();
}

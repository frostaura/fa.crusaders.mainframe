// Unity tests for dc::Sha256 / dc::HmacSha256 / dc::hkdf / dc::signer.
//
// This is the firmware half of the shared corpus in
// src/contracts/device-protocol/http. The other half is
// DeviceProtocolCorpusTests on the server. Neither side can see the other's
// source; the vectors were produced by a third, independent implementation, so
// a failure here means this code is wrong — not that the corpus was written to
// agree with it.
//
// What is at stake: a canonical string the firmware builds one byte differently
// from the server is a 401 with no diagnostic, on a board in an electrical
// cupboard, discovered by a trip to the club.
//
// Two kinds of test live here.
//
//   1. Corpus tests. Every declared case is executed and the count is asserted
//      against manifest.json — the anti-drift rule from the corpus README. A
//      side that silently skips what it does not recognise passes a checksum
//      and fails in the field; counting what actually ran is the assertion with
//      teeth.
//
//   2. Properties the corpus cannot express: that streaming update() in chunks
//      that straddle the 64-byte block gives the same digest as one call, and
//      that the signature comparison is constant-time in the ways that matter.

#include <stdint.h>
#include <string.h>
#include <unity.h>

#include "CorpusJson.h"
#include "devcrypto/Hex.h"
#include "devcrypto/Hkdf.h"
#include "devcrypto/HmacSha256.h"
#include "devcrypto/RequestSigner.h"
#include "devcrypto/Sha256.h"

namespace {

// Static, not stack: two 64 KB corpus buffers in a Unity test frame is a stack
// overflow on some hosts and an ASAN report on the rest.
corpus::File g_cases;
corpus::File g_manifest;

constexpr size_t kMaxHexChars = corpus::kMaxStringLen;
constexpr size_t kMaxBytes = kMaxHexChars / 2;

char g_text[corpus::kMaxStringLen];
uint8_t g_bytesA[kMaxBytes];
uint8_t g_bytesB[kMaxBytes];

// --- executed-case ledger ---------------------------------------------------
//
// Each corpus test records how many cases it ran under the section name it
// read. The last test cross-checks the ledger against both cases.json and
// manifest.json, so a section present in the corpus that no test handles fails
// as loudly as a count mismatch.

constexpr size_t kMaxSections = 8;

struct Ledger {
  char names[kMaxSections][corpus::kMaxNameLen];
  size_t executed[kMaxSections];
  size_t count = 0;

  void record(const char* name, size_t ran) {
    TEST_ASSERT_TRUE_MESSAGE(count < kMaxSections, "ledger full");
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

Ledger g_ledger;

// --- helpers ----------------------------------------------------------------

const char* section(const char* name) {
  const char* value = corpus::member(g_cases.root(), name);
  TEST_ASSERT_NOT_NULL_MESSAGE(value, name);
  TEST_ASSERT_TRUE_MESSAGE(corpus::isArray(value), name);
  return value;
}

size_t declaredCount(const char* name) {
  const char* counts = corpus::member(g_manifest.root(), "case_count");
  TEST_ASSERT_NOT_NULL(counts);
  const char* value = corpus::member(counts, name);
  TEST_ASSERT_NOT_NULL_MESSAGE(value, name);
  return static_cast<size_t>(corpus::unsignedValue(value));
}

/// Reads a hex-valued field into `out`, returning its length in bytes.
size_t hexField(const char* object, const char* name, uint8_t* out, size_t outCap) {
  const char* value = corpus::member(object, name);
  TEST_ASSERT_NOT_NULL_MESSAGE(value, name);

  size_t textLen = 0;
  TEST_ASSERT_TRUE(corpus::stringValue(value, g_text, sizeof(g_text), &textLen));

  size_t byteLen = 0;
  TEST_ASSERT_TRUE_MESSAGE(dc::hex::decode(g_text, textLen, out, outCap, &byteLen), name);
  return byteLen;
}

/// Reads a text field into the caller's buffer.
void textField(const char* object, const char* name, char* out, size_t outCap) {
  const char* value = corpus::member(object, name);
  TEST_ASSERT_NOT_NULL_MESSAGE(value, name);
  TEST_ASSERT_TRUE_MESSAGE(corpus::stringValue(value, out, outCap, nullptr), name);
}

uint64_t unsignedField(const char* object, const char* name) {
  const char* value = corpus::member(object, name);
  TEST_ASSERT_NOT_NULL_MESSAGE(value, name);
  return corpus::unsignedValue(value);
}

/// Asserts a digest equals the lowercase-hex string in `field`. Compared as
/// text so a failure prints both hex strings rather than two byte arrays.
void assertHexFieldEquals(const char* object, const char* field, const uint8_t* actual, size_t actualLen) {
  char expected[dc::hex::encodedSize(dc::Sha256::kDigestSize)];
  textField(object, field, expected, sizeof(expected));

  char got[dc::hex::encodedSize(dc::Sha256::kDigestSize)];
  TEST_ASSERT_TRUE(dc::hex::encodeLower(actual, actualLen, got, sizeof(got)));
  TEST_ASSERT_EQUAL_STRING(expected, got);
}

dc::ByteSpan span(const uint8_t* data, size_t len) {
  dc::ByteSpan s;
  s.data = data;
  s.len = len;
  return s;
}

const uint8_t* asBytes(const char* text) {
  return reinterpret_cast<const uint8_t*>(text);
}

} // namespace

// --- corpus availability ----------------------------------------------------
//
// Run first. Every other corpus test depends on the files being present, and a
// corpus that cannot be found must fail rather than quietly execute zero cases.

void test_corpus_files_are_present(void) {
  TEST_ASSERT_TRUE_MESSAGE(g_cases.load("cases.json"),
                           "src/contracts/device-protocol/http/cases.json not found above cwd");
  TEST_ASSERT_TRUE_MESSAGE(g_manifest.load("manifest.json"),
                           "src/contracts/device-protocol/http/manifest.json not found above cwd");
}

// --- SHA-256 ----------------------------------------------------------------
//
// Tested on its own so a broken primitive is diagnosed at the primitive rather
// than three layers up inside a canonical string. The corpus lengths sit around
// the 64-byte block and the 55/56-byte padding boundary, which is where a
// hand-written implementation goes wrong.

void test_sha256_matches_every_vector(void) {
  size_t executed = 0;
  corpus::ArrayIter it(section("sha256"));
  const char* testCase = nullptr;

  while (it.next(&testCase)) {
    const size_t inputLen = hexField(testCase, "input_hex", g_bytesA, sizeof(g_bytesA));

    uint8_t digest[dc::Sha256::kDigestSize];
    dc::Sha256::hash(g_bytesA, inputLen, digest);

    assertHexFieldEquals(testCase, "digest", digest, sizeof(digest));
    ++executed;
  }

  TEST_ASSERT_EQUAL_size_t(declaredCount("sha256"), executed);
  g_ledger.record("sha256", executed);
}

// The property the corpus cannot express. update() splits input across the
// 64-byte block boundary, and the buffering that does the splitting is the part
// with no test vector of its own: a one-shot hash of the same bytes exercises
// none of it. Chunk sizes 1, 63, 64 and 65 put a block boundary respectively
// everywhere, just before, exactly at, and just after every buffer top-up.
void test_sha256_streaming_matches_one_shot_at_every_chunk_size(void) {
  uint8_t input[300];
  for (size_t i = 0; i < sizeof(input); ++i) {
    input[i] = static_cast<uint8_t>(i * 7U);
  }

  const size_t chunkSizes[] = {1, 63, 64, 65, 127, 128};
  const size_t lengths[] = {0, 1, 55, 56, 57, 63, 64, 65, 119, 128, 200, sizeof(input)};

  for (size_t l = 0; l < sizeof(lengths) / sizeof(lengths[0]); ++l) {
    const size_t len = lengths[l];

    uint8_t expected[dc::Sha256::kDigestSize];
    dc::Sha256::hash(input, len, expected);

    for (size_t c = 0; c < sizeof(chunkSizes) / sizeof(chunkSizes[0]); ++c) {
      const size_t chunk = chunkSizes[c];

      dc::Sha256 streamed;
      for (size_t offset = 0; offset < len; offset += chunk) {
        const size_t remaining = len - offset;
        streamed.update(input + offset, (remaining < chunk) ? remaining : chunk);
      }

      uint8_t actual[dc::Sha256::kDigestSize];
      streamed.final(actual);

      TEST_ASSERT_EQUAL_HEX8_ARRAY(expected, actual, dc::Sha256::kDigestSize);
    }
  }
}

// An instance is reused across requests on the device — a stale length counter
// or a stale buffer would show up here and nowhere else.
void test_sha256_instance_is_reusable_after_init(void) {
  uint8_t expected[dc::Sha256::kDigestSize];
  dc::Sha256::hash(asBytes("abc"), 3, expected);

  dc::Sha256 sha;
  uint8_t discarded[dc::Sha256::kDigestSize];
  sha.update(asBytes("a longer first message that spans past one block boundary xxxxxxxxxxxx"), 69);
  sha.final(discarded);

  sha.init();
  sha.update(asBytes("abc"), 3);

  uint8_t actual[dc::Sha256::kDigestSize];
  sha.final(actual);
  TEST_ASSERT_EQUAL_HEX8_ARRAY(expected, actual, dc::Sha256::kDigestSize);
}

// --- HMAC-SHA256 ------------------------------------------------------------
//
// Key lengths straddle the 64-byte block: shorter is zero-padded, exactly 64 is
// used as-is, longer is hashed first. All three are separate code, and the
// middle one is the off-by-one.

void test_hmac_sha256_matches_every_vector(void) {
  size_t executed = 0;
  corpus::ArrayIter it(section("hmac_sha256"));
  const char* testCase = nullptr;

  while (it.next(&testCase)) {
    const size_t keyLen = hexField(testCase, "key_hex", g_bytesA, sizeof(g_bytesA));
    const size_t messageLen = hexField(testCase, "message_hex", g_bytesB, sizeof(g_bytesB));

    uint8_t mac[dc::HmacSha256::kDigestSize];
    dc::HmacSha256::mac(g_bytesA, keyLen, g_bytesB, messageLen, mac);

    assertHexFieldEquals(testCase, "mac", mac, sizeof(mac));
    ++executed;
  }

  TEST_ASSERT_EQUAL_size_t(declaredCount("hmac_sha256"), executed);
  g_ledger.record("hmac_sha256", executed);
}

// --- canonical string and request signature ---------------------------------

void test_canonical_string_matches_every_vector_byte_for_byte(void) {
  size_t executed = 0;
  corpus::ArrayIter it(section("requests"));
  const char* testCase = nullptr;

  char method[16];
  char path[256];
  char nonce[128];

  while (it.next(&testCase)) {
    textField(testCase, "method", method, sizeof(method));
    textField(testCase, "path_and_query", path, sizeof(path));
    textField(testCase, "nonce", nonce, sizeof(nonce));

    const size_t bodyLen = hexField(testCase, "body_hex", g_bytesA, sizeof(g_bytesA));

    uint8_t bodyHash[dc::Sha256::kDigestSize];
    dc::Sha256::hash(g_bytesA, bodyLen, bodyHash);
    assertHexFieldEquals(testCase, "body_sha256", bodyHash, sizeof(bodyHash));

    dc::DeviceRequest request;
    request.method = method;
    request.pathAndQuery = path;
    request.unixSeconds = unsignedField(testCase, "unix_seconds");
    request.nonce = nonce;

    char canonical[512];
    const size_t canonicalLen = dc::signer::canonicalString(request, bodyHash, canonical, sizeof(canonical));
    TEST_ASSERT_GREATER_THAN_size_t(0, canonicalLen);

    // Compared as bytes, not as text: a canonical string that differs only in
    // encoding compares equal as a string and produces a different HMAC.
    const size_t expectedLen = hexField(testCase, "canonical_hex", g_bytesB, sizeof(g_bytesB));
    TEST_ASSERT_EQUAL_size_t(expectedLen, canonicalLen);
    TEST_ASSERT_EQUAL_HEX8_ARRAY(g_bytesB, asBytes(canonical), expectedLen);

    // The whole-body convenience must agree with the streamed-hash form.
    char fromBody[512];
    TEST_ASSERT_EQUAL_size_t(canonicalLen, dc::signer::canonicalStringFromBody(
                                               request, span(g_bytesA, bodyLen), fromBody, sizeof(fromBody)));
    TEST_ASSERT_EQUAL_STRING(canonical, fromBody);

    ++executed;
  }

  TEST_ASSERT_EQUAL_size_t(declaredCount("requests"), executed);
  g_ledger.record("requests", executed);
}

void test_request_signature_matches_every_vector(void) {
  uint8_t key[64];
  const char* keyValue = corpus::member(g_cases.root(), "signing_key_hex");
  TEST_ASSERT_NOT_NULL(keyValue);
  size_t keyTextLen = 0;
  TEST_ASSERT_TRUE(corpus::stringValue(keyValue, g_text, sizeof(g_text), &keyTextLen));
  size_t keyLen = 0;
  TEST_ASSERT_TRUE(dc::hex::decode(g_text, keyTextLen, key, sizeof(key), &keyLen));

  size_t executed = 0;
  corpus::ArrayIter it(section("requests"));
  const char* testCase = nullptr;

  char method[16];
  char path[256];
  char nonce[128];
  char expected[dc::signer::kSignatureBufSize];

  while (it.next(&testCase)) {
    textField(testCase, "method", method, sizeof(method));
    textField(testCase, "path_and_query", path, sizeof(path));
    textField(testCase, "nonce", nonce, sizeof(nonce));
    textField(testCase, "signature", expected, sizeof(expected));

    const size_t bodyLen = hexField(testCase, "body_hex", g_bytesA, sizeof(g_bytesA));

    dc::DeviceRequest request;
    request.method = method;
    request.pathAndQuery = path;
    request.unixSeconds = unsignedField(testCase, "unix_seconds");
    request.nonce = nonce;

    // signBody() goes through feedCanonical(), which never materialises the
    // canonical string — the path the firmware actually takes.
    char actual[dc::signer::kSignatureBufSize];
    TEST_ASSERT_TRUE(
        dc::signer::signBody(request, span(g_bytesA, bodyLen), span(key, keyLen), actual, sizeof(actual)));
    TEST_ASSERT_EQUAL_STRING(expected, actual);

    uint8_t bodyHash[dc::Sha256::kDigestSize];
    dc::Sha256::hash(g_bytesA, bodyLen, bodyHash);
    TEST_ASSERT_TRUE(dc::signer::verify(request, bodyHash, span(key, keyLen), expected));

    // A tampered signature must not verify, however close it is.
    char tampered[dc::signer::kSignatureBufSize];
    memcpy(tampered, expected, sizeof(tampered));
    tampered[dc::signer::kSignatureHexLen - 1] =
        (tampered[dc::signer::kSignatureHexLen - 1] == '0') ? '1' : '0';
    TEST_ASSERT_FALSE(dc::signer::verify(request, bodyHash, span(key, keyLen), tampered));

    ++executed;
  }

  TEST_ASSERT_EQUAL_size_t(declaredCount("requests"), executed);
}

// The corpus carries 4294967295 for exactly this reason: a timestamp held in an
// int32_t formats as "-1", and the resulting 401 has no diagnostic on it.
void test_unsigned_formatting_spans_the_32_bit_boundary(void) {
  char out[dc::signer::kMaxUnsignedDigits + 1];

  TEST_ASSERT_EQUAL_size_t(1, dc::signer::formatUnsigned(0U, out, sizeof(out)));
  TEST_ASSERT_EQUAL_STRING("0", out);

  TEST_ASSERT_EQUAL_size_t(10, dc::signer::formatUnsigned(2147483647U, out, sizeof(out)));
  TEST_ASSERT_EQUAL_STRING("2147483647", out);

  TEST_ASSERT_EQUAL_size_t(10, dc::signer::formatUnsigned(4294967295U, out, sizeof(out)));
  TEST_ASSERT_EQUAL_STRING("4294967295", out);

  TEST_ASSERT_EQUAL_size_t(20, dc::signer::formatUnsigned(18446744073709551615ULL, out, sizeof(out)));
  TEST_ASSERT_EQUAL_STRING("18446744073709551615", out);

  // A buffer that cannot hold the value writes nothing rather than a truncated
  // number, which would sign as a different timestamp.
  char tiny[3];
  TEST_ASSERT_EQUAL_size_t(0, dc::signer::formatUnsigned(1700000000U, tiny, sizeof(tiny)));
}

// --- HKDF -------------------------------------------------------------------
//
// The provisioning path: an admin registers a device and the server derives its
// key from one master secret. The salt is a .NET Guid.ToByteArray(), whose
// first three groups are little-endian — taken from the corpus as bytes, never
// re-derived from the printed GUID here.

void test_hkdf_matches_every_vector(void) {
  size_t executed = 0;
  corpus::ArrayIter it(section("hkdf"));
  const char* testCase = nullptr;

  char master[128];
  char info[128];
  char deviceId[64];
  uint8_t salt[32];

  while (it.next(&testCase)) {
    textField(testCase, "master_utf8", master, sizeof(master));
    textField(testCase, "info_utf8", info, sizeof(info));
    textField(testCase, "device_id", deviceId, sizeof(deviceId));
    const size_t saltLen = hexField(testCase, "salt_hex", salt, sizeof(salt));

    // The info string is asserted separately from the key so a mismatch says
    // which half is wrong instead of only that the bytes differ.
    char expectedInfo[128];
    strcpy(expectedInfo, "crusaders-device:");
    strcat(expectedInfo, deviceId);
    strcat(expectedInfo, ":v");
    char version[dc::signer::kMaxUnsignedDigits + 1];
    dc::signer::formatUnsigned(unsignedField(testCase, "key_version"), version, sizeof(version));
    strcat(expectedInfo, version);
    TEST_ASSERT_EQUAL_STRING(expectedInfo, info);

    dc::hkdf::Inputs inputs;
    inputs.ikm = span(asBytes(master), strlen(master));
    inputs.salt = span(salt, saltLen);
    inputs.info = span(asBytes(info), strlen(info));

    uint8_t key[32];
    TEST_ASSERT_TRUE(dc::hkdf::derive(inputs, key, sizeof(key)));
    assertHexFieldEquals(testCase, "key_hex", key, sizeof(key));

    ++executed;
  }

  TEST_ASSERT_EQUAL_size_t(declaredCount("hkdf"), executed);
  g_ledger.record("hkdf", executed);
}

// RFC 5869 §2.3: output longer than one hash block chains T(i-1) into the next
// round, and the first 32 bytes of a longer output must equal a 32-byte one.
// The corpus only ever asks for 32, so this is the only thing holding the
// chaining honest.
void test_hkdf_expand_chains_blocks_and_respects_its_ceiling(void) {
  const uint8_t ikm[] = {1, 2, 3, 4};
  const uint8_t salt[] = {9, 9, 9};
  const uint8_t info[] = {'i', 'n', 'f', 'o'};

  dc::hkdf::Inputs inputs;
  inputs.ikm = span(ikm, sizeof(ikm));
  inputs.salt = span(salt, sizeof(salt));
  inputs.info = span(info, sizeof(info));

  uint8_t shortOut[32];
  uint8_t longOut[100];
  TEST_ASSERT_TRUE(dc::hkdf::derive(inputs, shortOut, sizeof(shortOut)));
  TEST_ASSERT_TRUE(dc::hkdf::derive(inputs, longOut, sizeof(longOut)));
  TEST_ASSERT_EQUAL_HEX8_ARRAY(shortOut, longOut, sizeof(shortOut));

  uint8_t prk[32];
  dc::hkdf::extract(inputs.salt, inputs.ikm, prk);
  uint8_t one[1];
  TEST_ASSERT_FALSE(dc::hkdf::expand(prk, inputs.info, one, 0));
  TEST_ASSERT_FALSE(dc::hkdf::expand(prk, inputs.info, longOut, (255U * 32U) + 1U));
}

// --- hex and constant-time comparison ---------------------------------------

void test_hex_encodes_lowercase_and_round_trips(void) {
  const uint8_t bytes[] = {0x00U, 0x0FU, 0xA5U, 0xFFU, 0xDEU, 0xADU};
  char text[dc::hex::encodedSize(sizeof(bytes))];

  TEST_ASSERT_TRUE(dc::hex::encodeLower(bytes, sizeof(bytes), text, sizeof(text)));
  TEST_ASSERT_EQUAL_STRING("000fa5ffdead", text);

  // One byte short of the terminator must fail rather than truncate.
  char tooSmall[dc::hex::encodedSize(sizeof(bytes)) - 1];
  TEST_ASSERT_FALSE(dc::hex::encodeLower(bytes, sizeof(bytes), tooSmall, sizeof(tooSmall)));

  uint8_t decoded[sizeof(bytes)];
  size_t decodedLen = 0;
  TEST_ASSERT_TRUE(dc::hex::decode(text, strlen(text), decoded, sizeof(decoded), &decodedLen));
  TEST_ASSERT_EQUAL_size_t(sizeof(bytes), decodedLen);
  TEST_ASSERT_EQUAL_HEX8_ARRAY(bytes, decoded, sizeof(bytes));

  // Uppercase is accepted on input, an odd length and a non-hex character are not.
  TEST_ASSERT_TRUE(dc::hex::decode("A5FF", 4, decoded, sizeof(decoded), &decodedLen));
  TEST_ASSERT_EQUAL_HEX8(0xA5U, decoded[0]);
  TEST_ASSERT_FALSE(dc::hex::decode("abc", 3, decoded, sizeof(decoded), &decodedLen));
  TEST_ASSERT_FALSE(dc::hex::decode("ab0g", 4, decoded, sizeof(decoded), &decodedLen));
}

// A length mismatch and a single flipped bit are the two failures a signature
// check must never accept; the first is what a truncated header looks like and
// the second is what a brute-force attempt looks like.
void test_constant_time_compare_rejects_length_mismatch_and_flipped_bits(void) {
  const uint8_t a[] = {0xDEU, 0xADU, 0xBEU, 0xEFU};
  uint8_t b[] = {0xDEU, 0xADU, 0xBEU, 0xEFU};

  TEST_ASSERT_TRUE(dc::hex::constantTimeEquals(a, sizeof(a), b, sizeof(b)));

  // Length mismatch, including a prefix that matches every byte it has.
  TEST_ASSERT_FALSE(dc::hex::constantTimeEquals(a, sizeof(a), b, sizeof(b) - 1));
  TEST_ASSERT_FALSE(dc::hex::constantTimeEquals(a, sizeof(a) - 1, b, sizeof(b)));

  // Every single-bit flip, at every position, in both directions.
  for (size_t i = 0; i < sizeof(b); ++i) {
    for (unsigned bit = 0; bit < 8U; ++bit) {
      b[i] = static_cast<uint8_t>(b[i] ^ static_cast<uint8_t>(1U << bit));
      TEST_ASSERT_FALSE(dc::hex::constantTimeEquals(a, sizeof(a), b, sizeof(b)));
      TEST_ASSERT_FALSE(dc::hex::constantTimeEquals(b, sizeof(b), a, sizeof(a)));
      b[i] = static_cast<uint8_t>(b[i] ^ static_cast<uint8_t>(1U << bit));
    }
  }
  TEST_ASSERT_TRUE(dc::hex::constantTimeEquals(a, sizeof(a), b, sizeof(b)));

  // Empty compares equal to empty; a null signature header does not.
  TEST_ASSERT_TRUE(dc::hex::constantTimeEquals(nullptr, 0, nullptr, 0));
  TEST_ASSERT_FALSE(dc::hex::constantTimeEqualsText("abc", nullptr));
  TEST_ASSERT_FALSE(dc::hex::constantTimeEqualsText("abc", "abcd"));
  TEST_ASSERT_TRUE(dc::hex::constantTimeEqualsText("abc", "abc"));
}

// --- the anti-drift assertion itself ----------------------------------------
//
// Runs last. Every array section in cases.json must be declared in
// manifest.json, must be non-empty, and must have been executed by one of the
// tests above with a matching count. A section nobody handles — a new "kind"
// added to the corpus that this side does not understand — fails here, which is
// precisely what a checksum over the file would not catch.

void test_every_corpus_section_is_declared_and_executed(void) {
  char name[corpus::kMaxNameLen];
  const char* value = nullptr;
  size_t sectionsSeen = 0;

  corpus::ObjectIter cases(g_cases.root());
  while (cases.next(name, sizeof(name), &value)) {
    if (!corpus::isArray(value)) {
      continue; // signing_key_hex and friends are inputs, not case lists.
    }
    ++sectionsSeen;

    size_t ran = 0;
    TEST_ASSERT_TRUE_MESSAGE(g_ledger.find(name, &ran),
                             "corpus section was not executed by any test in this suite");
    TEST_ASSERT_GREATER_THAN_size_t(0, ran);
    TEST_ASSERT_EQUAL_size_t(declaredCount(name), ran);
  }

  // And the other direction: a section declared in the manifest but missing
  // from cases.json would otherwise be invisible.
  const char* counts = corpus::member(g_manifest.root(), "case_count");
  TEST_ASSERT_NOT_NULL(counts);

  size_t declaredSections = 0;
  const char* countValue = nullptr;
  corpus::ObjectIter declared(counts);
  while (declared.next(name, sizeof(name), &countValue)) {
    ++declaredSections;
    TEST_ASSERT_NOT_NULL_MESSAGE(corpus::member(g_cases.root(), name),
                                 "manifest declares a section cases.json does not contain");
  }

  TEST_ASSERT_EQUAL_size_t(declaredSections, sectionsSeen);
  TEST_ASSERT_EQUAL_size_t(sectionsSeen, g_ledger.count);
}

// --- runner -----------------------------------------------------------------

void setUp(void) {
}

void tearDown(void) {
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_corpus_files_are_present);
  RUN_TEST(test_sha256_matches_every_vector);
  RUN_TEST(test_sha256_streaming_matches_one_shot_at_every_chunk_size);
  RUN_TEST(test_sha256_instance_is_reusable_after_init);
  RUN_TEST(test_hmac_sha256_matches_every_vector);
  RUN_TEST(test_canonical_string_matches_every_vector_byte_for_byte);
  RUN_TEST(test_request_signature_matches_every_vector);
  RUN_TEST(test_unsigned_formatting_spans_the_32_bit_boundary);
  RUN_TEST(test_hkdf_matches_every_vector);
  RUN_TEST(test_hkdf_expand_chains_blocks_and_respects_its_ceiling);
  RUN_TEST(test_hex_encodes_lowercase_and_round_trips);
  RUN_TEST(test_constant_time_compare_rejects_length_mismatch_and_flipped_bits);
  RUN_TEST(test_every_corpus_section_is_declared_and_executed);
  return UNITY_END();
}

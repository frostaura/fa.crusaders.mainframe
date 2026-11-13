// lib/devota (and devcrypto's RSA verify under it) against the shared contract
// corpus — every case in src/contracts/device-protocol/ota/, executed, counted,
// and cross-checked against what manifest.json declares.
//
// WHY THE CORPUS AND NOT HAND-WRITTEN EXPECTATIONS
// ------------------------------------------------
// Three implementations verify these bytes and none may be checked against
// itself: this library (and through it the court box's bridge and the door
// gate), and the server, which refuses an upload whose signature does not
// verify. `ota/gen_cases.py` signs with Python's own `pow` under TEST keys, and
// its signatures were cross-checked against an independent RSA when the family
// was made. A signature verifier that agreed with a hand-written expectation
// would be agreeing with whoever wrote both.
//
// WHY THE COUNTS ARE ASSERTED
// ---------------------------
// The corpus README's rule: a side that skips what it cannot parse passes
// every assertion it runs. So every section's executed count is compared with
// `case_count`, and every array in cases.json must be a section this suite
// executes.

#include <stdint.h>
#include <string.h>
#include <unity.h>

#include "devcrypto/Rsa.h"
#include "devcrypto/Sha256.h"
#include "devota/Ota.h"
#include "support/CorpusJson.h"

namespace {

corpus::File g_cases;
corpus::File g_manifest;

void load() {
  TEST_ASSERT_TRUE_MESSAGE(g_cases.load("ota", "cases.json"), "ota corpus not found — a skipped corpus proves nothing");
  TEST_ASSERT_TRUE_MESSAGE(g_manifest.load("ota", "manifest.json"), "ota/manifest.json not found");
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

/// The raw JSON text of a member's value — an object handed to the library
/// exactly as a heartbeat would carry it.
void rawValue(const char* object, const char* name, const char*& start, size_t& len) {
  start = corpus::member(object, name);
  TEST_ASSERT_NOT_NULL_MESSAGE(start, name);
  const char* end = corpus::skipValue(start);
  TEST_ASSERT_NOT_NULL(end);
  len = static_cast<size_t>(end - start);
}

/// The test key named `which` ("public_key" or "other_public_key").
void modulus(const char* which, uint8_t out[dc::kRsa2048Bytes]) {
  const char* key = corpus::member(g_cases.root(), which);
  TEST_ASSERT_NOT_NULL_MESSAGE(key, which);
  TEST_ASSERT_EQUAL_UINT64(65537U, corpus::unsignedValue(corpus::member(key, "e")));
  char hex[(dc::kRsa2048Bytes * 2U) + 1U] = {};
  text(key, "n_hex", hex, sizeof(hex));
  TEST_ASSERT_TRUE_MESSAGE(devota::parseModulusHex(hex, out), which);
}

struct Fields {
  char target[32] = {};
  char version[32] = {};
  uint32_t size = 0U;
  char sha256[80] = {};
};

void fields(const char* object, Fields& f) {
  const char* obj = corpus::member(object, "fields");
  TEST_ASSERT_NOT_NULL(obj);
  text(obj, "target", f.target, sizeof(f.target));
  text(obj, "version", f.version, sizeof(f.version));
  f.size = static_cast<uint32_t>(corpus::unsignedValue(corpus::member(obj, "size")));
  text(obj, "sha256", f.sha256, sizeof(f.sha256));
}

size_t g_executed[5] = {0U, 0U, 0U, 0U, 0U};

// ---------------------------------------------------------------------------

void test_every_manifest_is_the_exact_text_that_is_signed() {
  load();
  corpus::ArrayIter it(section("manifests"));
  const char* c = nullptr;
  while (it.next(&c)) {
    char id[corpus::kMaxNameLen] = {};
    text(c, "id", id, sizeof(id));
    Fields f;
    fields(c, f);
    char rendered[devota::kManifestCap] = {};
    const size_t n = devota::manifestText(f.target, f.version, f.size, f.sha256, rendered, sizeof(rendered));
    TEST_ASSERT_TRUE_MESSAGE(n > 0U, id);

    uint8_t expected[devota::kManifestCap] = {};
    size_t expectedLen = 0U;
    TEST_ASSERT_TRUE(corpus::hexField(c, "text_hex", expected, sizeof(expected), &expectedLen));
    TEST_ASSERT_EQUAL_size_t_MESSAGE(expectedLen, n, id);
    TEST_ASSERT_EQUAL_MEMORY_MESSAGE(expected, rendered, n, id);

    uint8_t digest[32] = {};
    dc::sha256(reinterpret_cast<const uint8_t*>(rendered), n, digest);
    uint8_t wanted[32] = {};
    size_t wantedLen = 0U;
    TEST_ASSERT_TRUE(corpus::hexField(c, "digest_hex", wanted, sizeof(wanted), &wantedLen));
    TEST_ASSERT_EQUAL_MEMORY_MESSAGE(wanted, digest, 32U, id);
    ++g_executed[0];
  }
  TEST_ASSERT_EQUAL_size_t(declared("manifests"), g_executed[0]);
}

void test_every_signature_verifies_or_is_refused_for_its_reason() {
  load();
  corpus::ArrayIter it(section("signatures"));
  const char* c = nullptr;
  while (it.next(&c)) {
    char id[corpus::kMaxNameLen] = {};
    text(c, "id", id, sizeof(id));
    Fields f;
    fields(c, f);
    char sig[400] = {};
    text(c, "sig", sig, sizeof(sig));
    char key[32] = {};
    text(c, "key", key, sizeof(key));
    uint8_t n[dc::kRsa2048Bytes];
    modulus(key, n);
    char reason[32] = {};
    text(c, "reason", reason, sizeof(reason));

    char manifest[devota::kManifestCap] = {};
    const size_t len = devota::manifestText(f.target, f.version, f.size, f.sha256, manifest, sizeof(manifest));
    TEST_ASSERT_TRUE_MESSAGE(len > 0U, id);
    const devota::Refusal got = devota::verifySignature(manifest, len, sig, n);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(reason, devota::refusalName(got), id);
    TEST_ASSERT_EQUAL_MESSAGE(flag(c, "valid"), got == devota::Refusal::Ok, id);
    ++g_executed[1];
  }
  TEST_ASSERT_EQUAL_size_t(declared("signatures"), g_executed[1]);
}

void test_every_version_gate_case() {
  load();
  corpus::ArrayIter it(section("versions"));
  const char* c = nullptr;
  while (it.next(&c)) {
    char id[corpus::kMaxNameLen] = {};
    text(c, "id", id, sizeof(id));
    char running[32] = {};
    char offered[32] = {};
    text(c, "running", running, sizeof(running));
    text(c, "offered", offered, sizeof(offered));
    devota::FailedList failed;
    corpus::ArrayIter versions(corpus::member(c, "failed"));
    const char* v = nullptr;
    while (versions.next(&v)) {
      char version[32] = {};
      TEST_ASSERT_TRUE(corpus::stringValue(v, version, sizeof(version), nullptr));
      failed.add(version);
    }
    char reason[32] = {};
    text(c, "reason", reason, sizeof(reason));
    const devota::Refusal got = devota::acceptVersion(running, offered, failed);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(reason, devota::refusalName(got), id);
    TEST_ASSERT_EQUAL_MESSAGE(flag(c, "accept"), got == devota::Refusal::Ok, id);
    ++g_executed[2];
  }
  TEST_ASSERT_EQUAL_size_t(declared("versions"), g_executed[2]);
}

void test_every_offer_is_parsed_or_refused_for_its_reason() {
  load();
  corpus::ArrayIter it(section("offers"));
  const char* c = nullptr;
  while (it.next(&c)) {
    char id[corpus::kMaxNameLen] = {};
    text(c, "id", id, sizeof(id));
    char own[32] = {};
    text(c, "own_target", own, sizeof(own));
    const char* ota = nullptr;
    size_t otaLen = 0U;
    rawValue(c, "ota", ota, otaLen);
    char reason[32] = {};
    text(c, "reason", reason, sizeof(reason));

    devota::Offer offer;
    const devota::Refusal got = devota::parseOffer(ota, otaLen, own, offer);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(reason, devota::refusalName(got), id);
    TEST_ASSERT_EQUAL_MESSAGE(flag(c, "accept"), got == devota::Refusal::Ok, id);
    if (got == devota::Refusal::Ok) {
      // Every field read as the server wrote it.
      const char* obj = corpus::member(c, "ota");
      char want[400] = {};
      text(obj, "target", want, sizeof(want));
      TEST_ASSERT_EQUAL_STRING_MESSAGE(want, offer.target, id);
      text(obj, "version", want, sizeof(want));
      TEST_ASSERT_EQUAL_STRING_MESSAGE(want, offer.version, id);
      TEST_ASSERT_EQUAL_UINT32_MESSAGE(corpus::unsignedValue(corpus::member(obj, "size")), offer.size, id);
      text(obj, "sha256", want, sizeof(want));
      TEST_ASSERT_EQUAL_STRING_MESSAGE(want, offer.sha256, id);
      text(obj, "sig", want, sizeof(want));
      TEST_ASSERT_EQUAL_STRING_MESSAGE(want, offer.sig, id);
      text(obj, "path", want, sizeof(want));
      TEST_ASSERT_EQUAL_STRING_MESSAGE(want, offer.path, id);
    } else {
      // A refusal adopts nothing.
      TEST_ASSERT_EQUAL_STRING_MESSAGE("", offer.target, id);
    }
    ++g_executed[3];
  }
  TEST_ASSERT_EQUAL_size_t(declared("offers"), g_executed[3]);
}

/// Streams `image` through the hash in chunks of `chunk` bytes, as a download
/// arrives, and verifies what came out against the offer.
devota::Refusal stream(const uint8_t* image, size_t len, size_t chunk, const devota::Offer& offer,
                       const uint8_t* n) {
  dc::Sha256 hash;
  uint32_t bytes = 0U;
  for (size_t at = 0U; at < len; at += chunk) {
    const size_t take = (len - at) < chunk ? (len - at) : chunk;
    hash.update(image + at, take);
    bytes += static_cast<uint32_t>(take);
  }
  uint8_t digest[32] = {};
  hash.finish(digest);
  return devota::verifyStaged(offer, digest, bytes, n);
}

void test_every_image_streams_hashes_and_verifies_in_any_chunking() {
  load();
  uint8_t n[dc::kRsa2048Bytes];
  modulus("public_key", n);
  corpus::ArrayIter it(section("images"));
  const char* c = nullptr;
  while (it.next(&c)) {
    char id[corpus::kMaxNameLen] = {};
    text(c, "id", id, sizeof(id));
    static uint8_t image[8192];
    size_t len = 0U;
    TEST_ASSERT_TRUE(corpus::hexField(c, "image_hex", image, sizeof(image), &len));
    TEST_ASSERT_EQUAL_UINT64_MESSAGE(corpus::unsignedValue(corpus::member(c, "size")), len, id);

    const char* offerText = nullptr;
    size_t offerLen = 0U;
    rawValue(c, "offer", offerText, offerLen);
    char target[32] = {};
    text(corpus::member(c, "offer"), "target", target, sizeof(target));
    devota::Offer offer;
    TEST_ASSERT_EQUAL_STRING_MESSAGE("ok", devota::refusalName(devota::parseOffer(offerText, offerLen, target, offer)), id);

    // Any chunking: a download arrives in whatever pieces TCP hands over.
    const size_t chunks[] = {1U, 7U, 64U, 1000U, len};
    for (size_t k = 0U; k < sizeof(chunks) / sizeof(chunks[0]); ++k) {
      TEST_ASSERT_EQUAL_STRING_MESSAGE("ok", devota::refusalName(stream(image, len, chunks[k], offer, n)), id);
    }

    // ONE TAMPERED BYTE anywhere — the first, a middle one, the last — is a
    // hash mismatch, and the image is never committed.
    const size_t where[] = {0U, len / 2U, len - 1U};
    for (size_t k = 0U; k < 3U; ++k) {
      image[where[k]] ^= 0x01U;
      TEST_ASSERT_EQUAL_STRING_MESSAGE("sha256", devota::refusalName(stream(image, len, 64U, offer, n)), id);
      image[where[k]] ^= 0x01U;
    }
    // A download cut one byte short, and one that ran a byte long.
    TEST_ASSERT_EQUAL_STRING_MESSAGE("size", devota::refusalName(stream(image, len - 1U, 64U, offer, n)), id);
    image[len] = 0x00U;
    TEST_ASSERT_EQUAL_STRING_MESSAGE("size", devota::refusalName(stream(image, len + 1U, 64U, offer, n)), id);

    // The right image under the WRONG key — what a rogue server on the LAN can
    // sign — is refused by the signature, after the hash agreed.
    uint8_t other[dc::kRsa2048Bytes];
    modulus("other_public_key", other);
    TEST_ASSERT_EQUAL_STRING_MESSAGE("sig", devota::refusalName(stream(image, len, 64U, offer, other)), id);
    ++g_executed[4];
  }
  TEST_ASSERT_EQUAL_size_t(declared("images"), g_executed[4]);
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
    const bool known = strcmp(name, "manifests") == 0 || strcmp(name, "signatures") == 0 ||
                       strcmp(name, "versions") == 0 || strcmp(name, "offers") == 0 || strcmp(name, "images") == 0;
    TEST_ASSERT_TRUE_MESSAGE(known, "an ota/ section no test in this suite executes");
    ++seen;
  }
  TEST_ASSERT_EQUAL_size_t(5U, seen);
  size_t total = 0U;
  for (size_t i = 0U; i < 5U; ++i) {
    total += g_executed[i];
  }
  TEST_ASSERT_EQUAL_size_t(declared("manifests") + declared("signatures") + declared("versions") +
                               declared("offers") + declared("images"),
                           total);
  // The constants the library compiles in are the corpus's.
  const char* constants = corpus::member(g_cases.root(), "constants");
  char magic[32] = {};
  text(constants, "manifest_magic", magic, sizeof(magic));
  TEST_ASSERT_EQUAL_STRING(devota::kManifestMagic, magic);
  char prefix[64] = {};
  text(constants, "path_prefix", prefix, sizeof(prefix));
  TEST_ASSERT_EQUAL_STRING(devota::kPathPrefix, prefix);
  TEST_ASSERT_EQUAL_UINT64(devota::kSigB64Len, corpus::unsignedValue(corpus::member(constants, "sig_b64_len")));
  const char* maxBytes = corpus::member(constants, "target_max_bytes");
  TEST_ASSERT_EQUAL_UINT64(devota::kCourtBridgeMaxBytes, corpus::unsignedValue(corpus::member(maxBytes, "court_bridge")));
  TEST_ASSERT_EQUAL_UINT64(devota::kDoorGateMaxBytes, corpus::unsignedValue(corpus::member(maxBytes, "door_gate")));
}

// --- beyond the corpus: properties the vectors cannot express ---------------

void test_failed_list_keeps_the_four_newest() {
  devota::FailedList failed;
  failed.add("2.0.1");
  failed.add("2.0.2");
  failed.add("2.0.2"); // a repeat is not a second slot
  failed.add("2.0.3");
  failed.add("2.0.4");
  TEST_ASSERT_EQUAL_UINT8(4U, failed.count);
  failed.add("2.0.5");
  TEST_ASSERT_EQUAL_UINT8(4U, failed.count);
  TEST_ASSERT_FALSE(failed.contains("2.0.1"));
  TEST_ASSERT_TRUE(failed.contains("2.0.2"));
  TEST_ASSERT_TRUE(failed.contains("2.0.5"));
  failed.add("not-a-version-at-all-too-long");
  TEST_ASSERT_TRUE(failed.contains("2.0.5"));
}

void test_probation_commits_when_proven_and_rolls_back_otherwise() {
  // Three resets: boots 1..3 wait, the fourth rolls back.
  TEST_ASSERT_TRUE(devota::Probation::atBoot(1U) == devota::Probation::Decision::None);
  TEST_ASSERT_TRUE(devota::Probation::atBoot(3U) == devota::Probation::Decision::None);
  TEST_ASSERT_TRUE(devota::Probation::atBoot(4U) == devota::Probation::Decision::RollBack);

  // At a base with the 2^32 ms wrap inside the window.
  const uint32_t bases[] = {0U, 0xFFFFF000U};
  for (size_t b = 0U; b < 2U; ++b) {
    devota::Probation p;
    TEST_ASSERT_TRUE(p.tick(bases[b], true) == devota::Probation::Decision::None); // never begun
    p.begin(bases[b], 600000U);
    TEST_ASSERT_TRUE(p.tick(bases[b] + 599999U, false) == devota::Probation::Decision::None);
    TEST_ASSERT_TRUE(p.tick(bases[b] + 600000U, false) == devota::Probation::Decision::RollBack);
    TEST_ASSERT_FALSE(p.active());
    TEST_ASSERT_TRUE(p.tick(bases[b] + 700000U, true) == devota::Probation::Decision::None);

    devota::Probation q;
    q.begin(bases[b], 600000U);
    TEST_ASSERT_TRUE(q.tick(bases[b] + 1000U, true) == devota::Probation::Decision::Commit);
    TEST_ASSERT_TRUE(q.tick(bases[b] + 900000U, false) == devota::Probation::Decision::None);
  }
}

void test_modulus_hex_is_exact() {
  uint8_t out[dc::kRsa2048Bytes];
  char hex[(dc::kRsa2048Bytes * 2U) + 2U];
  memset(hex, 'a', dc::kRsa2048Bytes * 2U);
  hex[dc::kRsa2048Bytes * 2U] = '\0';
  TEST_ASSERT_TRUE(devota::parseModulusHex(hex, out));
  hex[0] = 'g';
  TEST_ASSERT_FALSE(devota::parseModulusHex(hex, out));
  hex[0] = 'A';
  hex[dc::kRsa2048Bytes * 2U - 1U] = '\0';
  TEST_ASSERT_FALSE(devota::parseModulusHex(hex, out));
}

} // namespace

void setUp() {}

void tearDown() {}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_every_manifest_is_the_exact_text_that_is_signed);
  RUN_TEST(test_every_signature_verifies_or_is_refused_for_its_reason);
  RUN_TEST(test_every_version_gate_case);
  RUN_TEST(test_every_offer_is_parsed_or_refused_for_its_reason);
  RUN_TEST(test_every_image_streams_hashes_and_verifies_in_any_chunking);
  RUN_TEST(test_every_corpus_section_is_declared_and_executed);
  RUN_TEST(test_failed_list_keeps_the_four_newest);
  RUN_TEST(test_probation_commits_when_proven_and_rolls_back_otherwise);
  RUN_TEST(test_modulus_hex_is_exact);
  return UNITY_END();
}

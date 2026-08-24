// Unity tests for the UDP discovery beacon, the claim commitment and the
// announce schedule.
//
// Two halves, and the split is deliberate.
//
// The CORPUS half walks src/contracts/device-protocol/discovery/cases.json,
// which is shared ground owned by neither side: the .NET listener reads the
// same file. Those cases say what the bytes are. The suite asserts that the
// number of cases it EXECUTED equals the number manifest.json declares, and
// that none was skipped as an unrecognised kind — a side that quietly ignores
// what it cannot parse passes a checksum test over the corpus and fails in the
// field.
//
// The PROPERTY half asserts what a fixture list cannot express:
//   * field order on receipt genuinely does not matter — the same fields
//     shuffled produce the same packet, the same canonical form and the same
//     signature verdict;
//   * a single flipped bit anywhere in a signed packet fails verification;
//   * the commitment changes when the nonce changes and the code does not,
//     which is what makes yesterday's capture worthless today;
//   * the announce schedule survives the millis() rollover at 0xFFFFFFFF,
//     which is the normal case for a box in an electrical cupboard;
//   * a claimed box refuses an unsigned OFFER, and the claim code cannot reach
//     the wire.
//
// The corpus reaches this file through corpus_generated.h rather than a JSON
// parser: the code under test has no heap, and a hand-rolled parser's own bugs
// would show up here as protocol failures. The JSON stays the source of truth;
// see src/iot/tools/gen_discovery_corpus.py.

#include <stdint.h>
#include <string.h>
#include <unity.h>

#include "corpus_generated.h"
#include "devcrypto/ByteSpan.h"
#include "devcrypto/Hex.h"
#include "discovery/Announcer.h"
#include "discovery/Beacon.h"
#include "discovery/BeaconCodec.h"
#include "discovery/Claim.h"
#include "discovery/Offer.h"
#include "fakes/FakeClock.h"

namespace {

using discovery::AcceptedOffer;
using discovery::Announcer;
using discovery::ClaimCheck;
using discovery::ClaimCode;
using discovery::ClaimGuard;
using discovery::DecodeError;
using discovery::Identity;
using discovery::Packet;
using discovery::State;
using discovery::Verb;

// Counts what the corpus runners actually executed. Asserted against
// manifest.json at the end; see the anti-drift rule in
// src/contracts/device-protocol/README.md.
size_t g_encodeExecuted = 0;
size_t g_decodeExecuted = 0;
size_t g_claimExecuted = 0;
size_t g_unknownKinds = 0;

/// Byte written into every unused position of an encode buffer, so an encoder
/// that runs past its capacity is caught even without a sanitiser.
constexpr char kPoison = '\x7F';

constexpr size_t kScratch = 512;

bool eq(const char* a, const char* b) {
  return a != nullptr && b != nullptr && strcmp(a, b) == 0;
}

uint64_t toU64(const char* s) {
  uint64_t v = 0;
  for (size_t i = 0; s[i] != '\0'; ++i) {
    v = (v * 10U) + static_cast<uint64_t>(s[i] - '0');
  }
  return v;
}

/// The key the corpus's signatures were made with, decoded once.
dc::ByteSpan signingKey() {
  static uint8_t key[32];
  static size_t len = 0;
  if (len == 0) {
    TEST_ASSERT_TRUE(
        dc::hex::decode(corpus::kSigningKeyHex, strlen(corpus::kSigningKeyHex), key, sizeof(key), &len));
  }
  return dc::ByteSpan{key, len};
}

const char* fieldOf(const corpus::FieldSpec* fields, size_t n, const char* key) {
  for (size_t i = 0; i < n; ++i) {
    if (eq(fields[i].key, key)) {
      return fields[i].value;
    }
  }
  return nullptr;
}

/// Build `CRSDR1 <VERB> k=v ...*CC\n` with the checksum computed HERE, straight
/// from the spec's words — the XOR of every byte between the space after the
/// verb and the '*' — rather than by calling the encoder. A test that pastes a
/// literal checksum drifts silently the moment its body is edited.
size_t buildWire(const char* verb, const corpus::FieldSpec* fields, size_t n, char* out) {
  const char* kHex = "0123456789ABCDEF";
  size_t k = 0;
  for (const char* p = "CRSDR1 "; *p != '\0'; ++p) {
    out[k++] = *p;
  }
  for (const char* p = verb; *p != '\0'; ++p) {
    out[k++] = *p;
  }
  out[k++] = ' ';
  const size_t bodyStart = k;
  for (size_t i = 0; i < n; ++i) {
    if (i != 0) {
      out[k++] = ' ';
    }
    for (const char* p = fields[i].key; *p != '\0'; ++p) {
      out[k++] = *p;
    }
    out[k++] = '=';
    for (const char* p = fields[i].value; *p != '\0'; ++p) {
      out[k++] = *p;
    }
  }
  uint8_t cs = 0;
  for (size_t i = bodyStart; i < k; ++i) {
    cs = static_cast<uint8_t>(cs ^ static_cast<uint8_t>(out[i]));
  }
  out[k++] = '*';
  out[k++] = kHex[(cs >> 4) & 0x0F];
  out[k++] = kHex[cs & 0x0F];
  out[k++] = '\n';
  out[k] = '\0';
  return k;
}

/// The claim code behind a corpus commitment. The corpus is self-consistent on
/// purpose: every `cch` on an ANNOUNCE is the commitment of one of the worked
/// claim examples, so the encode cases can be built through ClaimCode::commit()
/// instead of by pasting the hex — which is what proves the wire value is
/// derived from a code rather than merely equal to a string.
ClaimCode codeForCommitment(const char* commitment, const char* nonceHex) {
  for (size_t i = 0; i < corpus::kClaimExampleCount; ++i) {
    const corpus::ClaimExample& ex = corpus::kClaimExamples[i];
    if (eq(ex.commitment, commitment) && eq(ex.nonce, nonceHex)) {
      return ClaimCode::fromText(ex.code);
    }
  }
  TEST_FAIL_MESSAGE("the corpus announces a commitment no claim example produces");
  return ClaimCode();
}

Identity identityOf(const corpus::FieldSpec* fields, size_t n) {
  Identity id;
  id.mac = fieldOf(fields, n, "mac");
  id.hardware = fieldOf(fields, n, "hw");
  id.firmware = fieldOf(fields, n, "fw");
  id.megaFirmware = fieldOf(fields, n, "mega");
  return id;
}

/// Build a corpus encode case's packet using ONLY the named constructors.
///
/// This is what proves the safety rules are not decorative. There is no "set
/// verb, set field" path available to a caller, so the corpus cannot ask for an
/// ANNOUNCE carrying a claim code even if a case tried to, and the `sig` field
/// can only arrive by signing.
bool packetFromCase(const corpus::EncodeCase& c, Packet& out) {
  const corpus::FieldSpec* f = c.fields;
  const size_t n = c.fieldCount;
  const char* nonce = fieldOf(f, n, "n");
  const char* state = fieldOf(f, n, "st");

  if (eq(c.verb, "ANNOUNCE") && eq(state, "unclaimed")) {
    const ClaimCode code = codeForCommitment(fieldOf(f, n, "cch"), nonce);
    out = Packet::announceUnclaimed(identityOf(f, n), nonce, code.commit(nonce),
                                    static_cast<uint32_t>(toU64(fieldOf(f, n, "up"))));
  } else if (eq(c.verb, "ANNOUNCE") && eq(state, "claimed")) {
    out = Packet::announceClaimed(identityOf(f, n), nonce, fieldOf(f, n, "dev"), fieldOf(f, n, "ten"),
                                  static_cast<uint32_t>(toU64(fieldOf(f, n, "up"))));
  } else if (eq(c.verb, "OFFER")) {
    out = Packet::offer(fieldOf(f, n, "url"), toU64(fieldOf(f, n, "t")), nonce);
  } else {
    return false;
  }

  if (fieldOf(f, n, "sig") != nullptr) {
    TEST_ASSERT_TRUE_MESSAGE(discovery::sign(out, signingKey()), c.id);
  }
  return !out.empty();
}

void assertFieldsMatch(const Packet& p, const corpus::FieldSpec* fields, size_t n, const char* id) {
  TEST_ASSERT_EQUAL_size_t_MESSAGE(n, static_cast<size_t>(p.fieldCount()), id);
  for (size_t i = 0; i < n; ++i) {
    // Both the order it arrived in and the lookup consumers actually use.
    TEST_ASSERT_EQUAL_STRING_MESSAGE(fields[i].key, p.key(static_cast<uint8_t>(i)), id);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(fields[i].value, p.value(static_cast<uint8_t>(i)), id);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(fields[i].value, p.find(fields[i].key), id);
  }
}

// --- encode corpus ---------------------------------------------------------

void runEncodeCase(const corpus::EncodeCase& c) {
  if (!eq(c.kind, "encode")) {
    ++g_unknownKinds;
    return;
  }
  Packet p;
  TEST_ASSERT_TRUE_MESSAGE(packetFromCase(c, p), c.id);

  char out[kScratch];
  memset(out, kPoison, sizeof(out));
  const size_t want = strlen(c.wire);
  const size_t n = discovery::encode(p, out, sizeof(out));
  TEST_ASSERT_EQUAL_size_t_MESSAGE(want, n, c.id);
  TEST_ASSERT_EQUAL_MEMORY_MESSAGE(c.wire, out, want, c.id);

  char canonical[kScratch];
  const size_t cn = discovery::canonicalInto(p, canonical, sizeof(canonical));
  TEST_ASSERT_EQUAL_size_t_MESSAGE(strlen(c.canonical), cn, c.id);
  TEST_ASSERT_EQUAL_STRING_MESSAGE(c.canonical, canonical, c.id);

  if (p.isSigned()) {
    TEST_ASSERT_TRUE_MESSAGE(discovery::verify(p, signingKey()), c.id);
  }

  // Every encode case must survive its own round trip: the bytes this side
  // produces are the bytes it has to be able to read back.
  Packet back;
  TEST_ASSERT_TRUE_MESSAGE(discovery::decode(out, n, back) == DecodeError::None, c.id);
  assertFieldsMatch(back, c.fields, c.fieldCount, c.id);
  ++g_encodeExecuted;
}

// --- decode corpus ---------------------------------------------------------

void runDecodeCase(const corpus::DecodeCase& c) {
  Packet p;
  const DecodeError e = discovery::decode(c.wire, strlen(c.wire), p);
  if (c.ok) {
    TEST_ASSERT_EQUAL_STRING_MESSAGE("", discovery::errorName(e), c.id);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.verb, discovery::verbName(p.verb()), c.id);
    assertFieldsMatch(p, c.fields, c.fieldCount, c.id);
  } else {
    TEST_ASSERT_EQUAL_STRING_MESSAGE(c.error, discovery::errorName(e), c.id);
    // A rejected datagram leaves nothing behind. A partially filled packet is
    // how half a spoofed beacon ends up being answered.
    TEST_ASSERT_TRUE_MESSAGE(p.empty(), c.id);
    TEST_ASSERT_EQUAL_size_t_MESSAGE(0, static_cast<size_t>(p.fieldCount()), c.id);
  }
}

} // namespace

// --- corpus runners --------------------------------------------------------

void test_corpus_encode_cases(void) {
  for (size_t i = 0; i < corpus::kEncodeCaseCount; ++i) {
    runEncodeCase(corpus::kEncodeCases[i]);
  }
}

void test_corpus_decode_cases(void) {
  for (size_t i = 0; i < corpus::kDecodeCaseCount; ++i) {
    const corpus::DecodeCase& c = corpus::kDecodeCases[i];
    if (!eq(c.kind, "decode")) {
      ++g_unknownKinds;
      continue;
    }
    runDecodeCase(c);
    ++g_decodeExecuted;
  }
}

void test_corpus_claim_examples(void) {
  // The firmware's own constants against the corpus, not against themselves.
  TEST_ASSERT_EQUAL_STRING(corpus::kClaimAlphabet, discovery::kClaimAlphabet);
  TEST_ASSERT_EQUAL_size_t(corpus::kClaimCodeLength, discovery::kClaimCodeLen);
  TEST_ASSERT_EQUAL_size_t(corpus::kCommitmentHexLength, discovery::kCommitmentHexLen);

  for (size_t i = 0; i < corpus::kClaimExampleCount; ++i) {
    const corpus::ClaimExample& ex = corpus::kClaimExamples[i];
    const ClaimCode code = ClaimCode::fromText(ex.code);
    TEST_ASSERT_FALSE_MESSAGE(code.empty(), ex.code);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(ex.commitment, code.commit(ex.nonce).hex(), ex.code);
    ++g_claimExecuted;
  }
}

/// The anti-drift assertion with teeth. A case added to cases.json without a
/// matching bump in manifest.json fails here, and so does a case whose kind
/// this suite silently skipped.
void test_corpus_executed_count_matches_the_manifest(void) {
  TEST_ASSERT_EQUAL_size_t_MESSAGE(0, g_unknownKinds, "a corpus case was skipped as an unknown kind");
  TEST_ASSERT_EQUAL_size_t_MESSAGE(corpus::kDeclaredEncodeCases, g_encodeExecuted,
                                   "executed encode cases != manifest.json case_count.encode");
  TEST_ASSERT_EQUAL_size_t_MESSAGE(corpus::kDeclaredDecodeCases, g_decodeExecuted,
                                   "executed decode cases != manifest.json case_count.decode");
  TEST_ASSERT_EQUAL_size_t_MESSAGE(corpus::kDeclaredClaimExamples, g_claimExecuted,
                                   "executed claim examples != manifest.json case_count.claim_examples");
  // Guards the other direction: a case deleted from cases.json without touching
  // the manifest would otherwise make the counts agree at zero.
  TEST_ASSERT_EQUAL_size_t(corpus::kEncodeCaseCount, g_encodeExecuted);
  TEST_ASSERT_EQUAL_size_t(corpus::kDecodeCaseCount, g_decodeExecuted);
  TEST_ASSERT_EQUAL_size_t(corpus::kClaimExampleCount, g_claimExecuted);
}

// --- the property half -----------------------------------------------------

namespace {

const corpus::EncodeCase& caseById(const char* id) {
  for (size_t i = 0; i < corpus::kEncodeCaseCount; ++i) {
    if (eq(corpus::kEncodeCases[i].id, id)) {
      return corpus::kEncodeCases[i];
    }
  }
  TEST_FAIL_MESSAGE("the corpus no longer carries a case this test names");
  return corpus::kEncodeCases[0];
}

/// A deterministic byte source. Entropy is a port precisely so a test can be
/// this boring: a code has to be reproducible for a worked example to mean
/// anything.
class SeededEntropy final : public discovery::IEntropySource {
public:
  explicit SeededEntropy(uint32_t seed) : state_(seed) {}

  uint8_t nextByte() override {
    // xorshift32. Not a CSPRNG and not pretending to be one — the production
    // source is the platform's, and this exists to be repeatable.
    state_ ^= static_cast<uint32_t>(state_ << 13);
    state_ ^= state_ >> 17;
    state_ ^= static_cast<uint32_t>(state_ << 5);
    return static_cast<uint8_t>(state_ & 0xFFU);
  }

private:
  uint32_t state_;
};

/// Walks every byte value exactly once, so the mapping from bytes to characters
/// can be checked for bias directly rather than statistically.
class CountingEntropy final : public discovery::IEntropySource {
public:
  uint8_t nextByte() override {
    const uint8_t v = next_;
    next_ = static_cast<uint8_t>(next_ + 1U);
    return v;
  }

private:
  uint8_t next_ = 0;
};

} // namespace

/// Field order on the wire must not change anything: not the fields the box
/// reads, not the canonical form, and not the signature verdict. Nothing in the
/// packet fixes the order, so a receiver that depends on it works against one
/// implementation and fails against the other — which is the whole reason the
/// signature is over a sorted canonical form and not over the bytes.
void test_decode_does_not_care_about_field_order(void) {
  const corpus::EncodeCase& c = caseById("enc-announce-claimed");
  const size_t n = c.fieldCount;

  char reference[kScratch];
  size_t referenceLen = 0;

  for (size_t rotation = 0; rotation < n; ++rotation) {
    corpus::FieldSpec shuffled[corpus::kMaxCaseFields];
    for (size_t i = 0; i < n; ++i) {
      // A rotation for the bulk of the permutations, reversed on odd passes, so
      // the first and last fields both take every position.
      const size_t source = (rotation % 2 == 0) ? ((i + rotation) % n) : (n - 1 - ((i + rotation) % n));
      shuffled[i] = c.fields[source];
    }

    char wire[kScratch];
    const size_t len = buildWire(c.verb, shuffled, n, wire);

    Packet p;
    TEST_ASSERT_EQUAL_STRING(discovery::errorName(DecodeError::None),
                             discovery::errorName(discovery::decode(wire, len, p)));
    TEST_ASSERT_EQUAL_size_t(n, static_cast<size_t>(p.fieldCount()));
    for (size_t i = 0; i < n; ++i) {
      TEST_ASSERT_EQUAL_STRING(c.fields[i].value, p.find(c.fields[i].key));
    }

    char canonical[kScratch];
    const size_t cn = discovery::canonicalInto(p, canonical, sizeof(canonical));
    TEST_ASSERT_EQUAL_STRING(c.canonical, canonical);
    TEST_ASSERT_TRUE(discovery::verify(p, signingKey()));

    if (rotation == 0) {
      referenceLen = cn;
      memcpy(reference, canonical, cn + 1);
    } else {
      TEST_ASSERT_EQUAL_size_t(referenceLen, cn);
      TEST_ASSERT_EQUAL_MEMORY(reference, canonical, cn);
    }
  }
}

/// One bit, anywhere. Both halves matter: a flip in the signature must be
/// caught (that is the MAC doing its job) and so must a flip in a field the
/// signature covers (that is the canonical form doing its job — a canonicaliser
/// that dropped a field would pass the first test and fail this one).
void test_verification_fails_on_a_single_flipped_bit(void) {
  const corpus::EncodeCase& c = caseById("enc-offer-signed");
  const size_t n = c.fieldCount;

  char wire[kScratch];
  size_t len = buildWire(c.verb, c.fields, n, wire);
  Packet clean;
  TEST_ASSERT_TRUE(discovery::decode(wire, len, clean) == DecodeError::None);
  TEST_ASSERT_TRUE(discovery::verify(clean, signingKey()));

  char mutated[corpus::kMaxCaseFields][discovery::kMaxValueLen + 1];
  for (size_t target = 0; target < n; ++target) {
    for (size_t bit = 0; bit < strlen(c.fields[target].value); ++bit) {
      corpus::FieldSpec fields[corpus::kMaxCaseFields];
      for (size_t i = 0; i < n; ++i) {
        fields[i] = c.fields[i];
      }
      const size_t valueLen = strlen(c.fields[target].value);
      memcpy(mutated[target], c.fields[target].value, valueLen + 1);
      // Bit 0 of a printable character stays printable and never produces a
      // space, a '=' or a '*', so the packet still frames and the ONLY thing
      // that changed is a byte the signature covers.
      mutated[target][bit] = static_cast<char>(mutated[target][bit] ^ 0x01);
      fields[target].value = mutated[target];

      len = buildWire(c.verb, fields, n, wire);
      Packet p;
      TEST_ASSERT_TRUE(discovery::decode(wire, len, p) == DecodeError::None);
      TEST_ASSERT_FALSE_MESSAGE(discovery::verify(p, signingKey()),
                                "a one-bit change verified against the same key");
    }
  }
}

/// The commitment has to change every boot, or a commitment captured yesterday
/// claims the board today. The code is what the admin types and does not change
/// within a boot, so the nonce is the only thing that can carry that.
void test_the_commitment_changes_with_the_nonce(void) {
  const ClaimCode code = ClaimCode::fromText("K7RM4XPT");
  TEST_ASSERT_FALSE(code.empty());

  const discovery::ClaimCommitment first = code.commit("a1b2c3d4e5f60718");
  const discovery::ClaimCommitment second = code.commit("a1b2c3d4e5f60719");
  TEST_ASSERT_EQUAL_size_t(discovery::kCommitmentHexLen, strlen(first.hex()));
  TEST_ASSERT_FALSE(eq(first.hex(), second.hex()));

  // And the other axis: the same nonce with a different code is a different
  // commitment, which is what makes an impostor's fabricated value never match.
  const ClaimCode other = ClaimCode::fromText("K7RM4XPU");
  TEST_ASSERT_FALSE(eq(first.hex(), other.commit("a1b2c3d4e5f60718").hex()));

  // A code the board does not have cannot commit to anything.
  TEST_ASSERT_TRUE(ClaimCode().commit("a1b2c3d4e5f60718").empty());
  TEST_ASSERT_TRUE(code.commit("").empty());
}

void test_a_claim_code_is_rejected_unless_it_is_exactly_right(void) {
  TEST_ASSERT_FALSE(ClaimCode::fromText("K7RM4XPT").empty());
  TEST_ASSERT_TRUE(ClaimCode::fromText(nullptr).empty());
  TEST_ASSERT_TRUE(ClaimCode::fromText("").empty());
  TEST_ASSERT_TRUE(ClaimCode::fromText("K7RM4XP").empty());   // Too short.
  TEST_ASSERT_TRUE(ClaimCode::fromText("K7RM4XPTT").empty()); // Too long.
  // The four characters the alphabet leaves out, because a human reads this off
  // a 16x2 display and types it on a phone.
  TEST_ASSERT_TRUE(ClaimCode::fromText("I7RM4XPT").empty());
  TEST_ASSERT_TRUE(ClaimCode::fromText("O7RM4XPT").empty());
  TEST_ASSERT_TRUE(ClaimCode::fromText("07RM4XPT").empty());
  TEST_ASSERT_TRUE(ClaimCode::fromText("17RM4XPT").empty());
  TEST_ASSERT_TRUE(ClaimCode::fromText("k7rm4xpt").empty()); // Lowercase is not the alphabet.
}

/// Every byte value must land inside the alphabet, and land there evenly: 256
/// bytes over 32 characters is exactly eight each. A generator that took the
/// byte modulo a non-power-of-two alphabet would fail the second half of this
/// and nothing else, which is why it is asserted rather than reasoned about.
void test_generated_codes_use_the_alphabet_without_bias(void) {
  CountingEntropy entropy;
  uint8_t histogram[discovery::kClaimAlphabetSize] = {0};

  for (size_t round = 0; round < 32; ++round) {
    const ClaimCode code = ClaimCode::generate(entropy);
    TEST_ASSERT_EQUAL_size_t(discovery::kClaimCodeLen, strlen(code.lcdText()));
    for (size_t i = 0; i < discovery::kClaimCodeLen; ++i) {
      const char* found = strchr(discovery::kClaimAlphabet, code.lcdText()[i]);
      TEST_ASSERT_NOT_NULL(found);
      ++histogram[static_cast<size_t>(found - discovery::kClaimAlphabet)];
    }
  }
  for (size_t i = 0; i < discovery::kClaimAlphabetSize; ++i) {
    TEST_ASSERT_EQUAL_UINT8(8, histogram[i]);
  }

  // Deterministic under a seed, which is the point of injecting the source.
  SeededEntropy a(0x12345678U);
  SeededEntropy b(0x12345678U);
  SeededEntropy c(0x87654321U);
  const ClaimCode first = ClaimCode::generate(a);
  TEST_ASSERT_EQUAL_STRING(first.lcdText(), ClaimCode::generate(b).lcdText());
  TEST_ASSERT_FALSE(eq(first.lcdText(), ClaimCode::generate(c).lcdText()));
}

/// The commitment has already proved the board's identity by the time a code is
/// typed, so this is the second lock on the same door. It exists because an
/// unbounded retry loop against eight characters is the kind of thing that is
/// only noticed after a year of running.
void test_claiming_locks_after_three_wrong_codes(void) {
  ClaimGuard guard(ClaimCode::fromText("K7RM4XPT"));
  TEST_ASSERT_TRUE(guard.check("K7RM4XPT") == ClaimCheck::Match);
  TEST_ASSERT_TRUE(guard.check("WRONGCOD") == ClaimCheck::Wrong);
  TEST_ASSERT_TRUE(guard.check("WRONGCOD") == ClaimCheck::Wrong);
  TEST_ASSERT_TRUE(guard.check("WRONGCOD") == ClaimCheck::Locked);
  TEST_ASSERT_TRUE(guard.locked());
  // Including the right one: the board reboots or stays unclaimed.
  TEST_ASSERT_TRUE(guard.check("K7RM4XPT") == ClaimCheck::Locked);
  TEST_ASSERT_EQUAL_UINT8(discovery::kClaimAttemptLimit, guard.wrongAttempts());

  // A guard with no code matches nothing, rather than matching everything.
  ClaimGuard empty;
  TEST_ASSERT_TRUE(empty.check("") == ClaimCheck::Wrong);
}

// --- the safety rules ------------------------------------------------------

// A claimed box that acts on an unsigned OFFER can be pointed at a fake
// mainframe by anything on the club WiFi, and from there at the relays.
//
// The type system carries most of this test. ClaimedBox's constructor takes the
// signing key as a required argument, ClaimedBox::accept() has no overload that
// skips verification, and AcceptedOffer has no public constructor — so "accept
// this OFFER without checking the signature" is a line that does not compile
// rather than a bug waiting to be found. What is left to assert at runtime is
// that the check is actually wired to the key.
void test_a_claimed_box_refuses_an_unsigned_offer(void) {
  const char* kNonce = "a1b2c3d4e5f60718";
  Packet unsignedOffer = Packet::offer("http://192.168.68.20:8088", 1755900000U, kNonce);
  TEST_ASSERT_FALSE(unsignedOffer.empty());
  TEST_ASSERT_FALSE(unsignedOffer.isSigned());

  const discovery::ClaimedBox box(signingKey(), kNonce);
  TEST_ASSERT_TRUE(box.hasKey());

  AcceptedOffer accepted;
  TEST_ASSERT_FALSE(box.accept(unsignedOffer, accepted));
  TEST_ASSERT_TRUE(accepted.empty());
  TEST_ASSERT_EQUAL_STRING("", accepted.url());

  // The same OFFER signed by somebody else's key is refused too — "unsigned"
  // and "signed by the wrong key" are the same answer on purpose.
  uint8_t rogueBytes[32];
  memset(rogueBytes, 0x5A, sizeof(rogueBytes));
  Packet rogue = Packet::offer("http://10.0.0.66:8088", 1755900000U, kNonce);
  TEST_ASSERT_TRUE(discovery::sign(rogue, dc::ByteSpan{rogueBytes, sizeof(rogueBytes)}));
  TEST_ASSERT_FALSE(box.accept(rogue, accepted));
  TEST_ASSERT_TRUE(accepted.empty());
}

void test_a_claimed_box_accepts_a_properly_signed_offer(void) {
  const char* kNonce = "a1b2c3d4e5f60718";
  Packet offer = Packet::offer("http://192.168.68.20:8088", 1755900000U, kNonce);
  TEST_ASSERT_TRUE(discovery::sign(offer, signingKey()));

  const discovery::ClaimedBox box(signingKey(), kNonce);
  AcceptedOffer accepted;
  TEST_ASSERT_TRUE(box.accept(offer, accepted));
  TEST_ASSERT_FALSE(accepted.empty());
  TEST_ASSERT_EQUAL_STRING("http://192.168.68.20:8088", accepted.url());
  TEST_ASSERT_EQUAL_UINT64(1755900000U, accepted.unixSeconds());

  // A key of the wrong length is not quietly padded or truncated: such a box
  // accepts nothing at all.
  uint8_t shortKey[16] = {0};
  const discovery::ClaimedBox unusable(dc::ByteSpan{shortKey, sizeof(shortKey)}, kNonce);
  TEST_ASSERT_FALSE(unusable.hasKey());
  TEST_ASSERT_FALSE(unusable.accept(offer, accepted));
}

/// An OFFER that does not echo THIS boot's nonce is a replay of one captured
/// earlier, and is refused whether or not it is signed.
void test_an_offer_must_echo_this_boots_nonce(void) {
  const char* kThisBoot = "a1b2c3d4e5f60718";
  const char* kLastBoot = "0000000000000000";

  Packet stale = Packet::offer("http://192.168.68.20:8088", 1755900000U, kLastBoot);
  TEST_ASSERT_TRUE(discovery::sign(stale, signingKey()));

  AcceptedOffer accepted;
  const discovery::ClaimedBox claimed(signingKey(), kThisBoot);
  TEST_ASSERT_FALSE(claimed.accept(stale, accepted));

  const discovery::UnclaimedBox unclaimed(kThisBoot);
  TEST_ASSERT_FALSE(unclaimed.accept(stale, accepted));

  // A box that does not know its own nonce accepts nothing, rather than
  // accepting everything.
  const discovery::UnclaimedBox nameless(nullptr);
  Packet fresh = Packet::offer("http://192.168.68.20:8088", 1755900000U, kThisBoot);
  TEST_ASSERT_FALSE(nameless.accept(fresh, accepted));
  TEST_ASSERT_TRUE(unclaimed.accept(fresh, accepted));
  TEST_ASSERT_EQUAL_STRING("http://192.168.68.20:8088", accepted.url());
}

/// An unclaimed box has no key, so it cannot check a signature and must not
/// demand one — otherwise no board could ever be claimed. It still checks the
/// verb, the version and the nonce.
void test_an_unclaimed_box_takes_an_unsigned_offer_but_not_any_packet(void) {
  const char* kNonce = "a1b2c3d4e5f60718";
  const discovery::UnclaimedBox box(kNonce);
  AcceptedOffer accepted;

  Packet offer = Packet::offer("http://192.168.68.20:8088", 1755900000U, kNonce);
  TEST_ASSERT_TRUE(box.accept(offer, accepted));

  // A signed OFFER is fine too: the signature is simply not checkable yet.
  TEST_ASSERT_TRUE(discovery::sign(offer, signingKey()));
  TEST_ASSERT_TRUE(box.accept(offer, accepted));

  // An ANNOUNCE is not an OFFER, however well formed.
  const ClaimCode code = ClaimCode::fromText("K7RM4XPT");
  Identity id;
  id.mac = "5ccf7f1a2b3c";
  id.hardware = "esp8266";
  id.firmware = "1.0.0";
  const Packet announce = Packet::announceUnclaimed(id, kNonce, code.commit(kNonce), 42U);
  TEST_ASSERT_FALSE(announce.empty());
  TEST_ASSERT_FALSE(box.accept(announce, accepted));

  // And neither is a packet from a protocol version this firmware does not
  // speak, which arrives as an OFFER with a `v` this build does not know.
  const corpus::FieldSpec future[] = {
      {"v", "2"}, {"url", "http://192.168.68.20:8088"}, {"t", "1755900000"}, {"n", "a1b2c3d4e5f60718"}};
  char wire[kScratch];
  const size_t len = buildWire("OFFER", future, 4, wire);
  Packet p;
  TEST_ASSERT_TRUE(discovery::decode(wire, len, p) == DecodeError::None);
  TEST_ASSERT_FALSE(box.accept(p, accepted));
}

/// The claim code is the one secret the box has, and it must never leave the
/// LCD. What makes that structural is that Packet has no public field setter
/// and announceUnclaimed() takes a ClaimCommitment — there is no expression
/// that puts a ClaimCode into a packet. What is left to assert is that the
/// encoder does not put it there by some other route, and that a board with no
/// commitment produces no beacon rather than a blank one.
void test_the_claim_code_never_reaches_the_wire(void) {
  const char* kNonce = "a1b2c3d4e5f60718";
  const ClaimCode code = ClaimCode::fromText("K7RM4XPT");
  Identity id;
  id.mac = "5ccf7f1a2b3c";
  id.hardware = "esp8266";
  id.firmware = "1.0.0";

  const Packet announce = Packet::announceUnclaimed(id, kNonce, code.commit(kNonce), 42U);
  char wire[kScratch];
  const size_t n = discovery::encode(announce, wire, sizeof(wire));
  TEST_ASSERT_TRUE(n > 0);
  wire[n] = '\0';
  TEST_ASSERT_NULL_MESSAGE(strstr(wire, code.lcdText()), "the claim code was broadcast");
  TEST_ASSERT_NOT_NULL(strstr(wire, code.commit(kNonce).hex()));

  // No commitment, no beacon. An ANNOUNCE with a blank `cch` puts a board in
  // the admin's list as an entry that can never be claimed.
  TEST_ASSERT_TRUE(Packet::announceUnclaimed(id, kNonce, discovery::ClaimCommitment(), 42U).empty());
  TEST_ASSERT_EQUAL_size_t(0, discovery::encode(Packet(), wire, sizeof(wire)));
}

/// A claimed board announces itself claimed, and the server can tell.
///
/// The bug this pins: a provisioned board kept broadcasting the UNCLAIMED beacon
/// forever, because the choice of which announce to send lived in main.cpp where
/// nothing tested it — so an already-connected board kept appearing in the
/// admin's "connect a board" list as though it were still up for grabs. The
/// decision is now Packet::shouldAnnounceClaimed, and this exercises it plus the
/// full announce → sign → verify roundtrip the server does.
void test_a_provisioned_board_announces_itself_claimed(void) {
  const char* kNonce = "a1b2c3d4e5f60718";
  const char* kDeviceId = "11111111-2222-3333-4444-555555555555";
  const char* kSlug = "crusaders";

  // The decision. All three inputs required; a missing slug falls back so the
  // board stays discoverable rather than sending a claimed announce with no
  // tenant on it.
  TEST_ASSERT_TRUE(Packet::shouldAnnounceClaimed(true, kDeviceId, kSlug));
  TEST_ASSERT_FALSE(Packet::shouldAnnounceClaimed(false, kDeviceId, kSlug));
  TEST_ASSERT_FALSE(Packet::shouldAnnounceClaimed(true, "", kSlug));
  TEST_ASSERT_FALSE(Packet::shouldAnnounceClaimed(true, kDeviceId, ""));

  Identity id;
  id.mac = "5ccf7f1a2b3c";
  id.hardware = "esp8266";
  id.firmware = "1.0.0";

  Packet claimed = Packet::announceClaimed(id, kNonce, kDeviceId, kSlug, 99U);
  TEST_ASSERT_FALSE(claimed.empty());

  // st=claimed is what drops it out of the discoverable-as-claimable list.
  TEST_ASSERT_EQUAL_STRING("claimed", claimed.find("st"));
  TEST_ASSERT_EQUAL_STRING(kDeviceId, claimed.find("dev"));
  TEST_ASSERT_EQUAL_STRING(kSlug, claimed.find("ten"));

  // Signed with the device key, and it verifies against that key — which is what
  // stops anyone on the WiFi asserting device X moved to their address.
  TEST_ASSERT_TRUE(discovery::sign(claimed, signingKey()));
  TEST_ASSERT_TRUE(claimed.isSigned());
  TEST_ASSERT_TRUE(discovery::verify(claimed, signingKey()));

  // The claim code and commitment do not appear on a claimed announce — that is
  // an unclaimed-board concern only.
  char wire[kScratch];
  const size_t n = discovery::encode(claimed, wire, sizeof(wire));
  TEST_ASSERT_TRUE(n > 0);
  wire[n] = '\0';
  TEST_ASSERT_NULL(strstr(wire, "cch="));
}

// --- codec properties ------------------------------------------------------

/// Encoding is all or nothing at EVERY capacity. A truncated datagram still has
/// bytes where a checksum would be, and the alternative to refusing it is a
/// half-written beacon that something answers.
void test_encode_is_all_or_nothing_at_every_capacity(void) {
  const corpus::EncodeCase& c = caseById("enc-announce-claimed");
  Packet p;
  TEST_ASSERT_TRUE(packetFromCase(c, p));
  const size_t want = strlen(c.wire);

  for (size_t cap = 0; cap <= want + 2; ++cap) {
    char out[kScratch];
    memset(out, kPoison, sizeof(out));
    const size_t n = discovery::encode(p, out, cap);
    if (cap < want) {
      TEST_ASSERT_EQUAL_size_t(0, n);
    } else {
      TEST_ASSERT_EQUAL_size_t(want, n);
      TEST_ASSERT_EQUAL_MEMORY(c.wire, out, want);
    }
    for (size_t i = cap; i < sizeof(out); ++i) {
      TEST_ASSERT_EQUAL_MESSAGE(kPoison, out[i], "the encoder wrote past its capacity");
    }
  }
}

/// The fixed buffers are a refusal, not a truncation. A datagram with more
/// fields, a longer value or a longer key than this build holds is dropped
/// whole: decoding it to something nobody sent is worse than not decoding it,
/// and a future protocol version adding a field must not be half-understood.
void test_oversized_packets_are_refused_rather_than_truncated(void) {
  corpus::FieldSpec fields[discovery::kMaxFields + 1];
  static const char* kKeys[] = {"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m"};
  for (size_t i = 0; i < discovery::kMaxFields + 1; ++i) {
    fields[i].key = kKeys[i];
    fields[i].value = "1";
  }

  char wire[kScratch];
  Packet p;
  size_t len = buildWire("ANNOUNCE", fields, discovery::kMaxFields, wire);
  TEST_ASSERT_EQUAL_STRING("", discovery::errorName(discovery::decode(wire, len, p)));
  TEST_ASSERT_EQUAL_size_t(discovery::kMaxFields, static_cast<size_t>(p.fieldCount()));

  len = buildWire("ANNOUNCE", fields, discovery::kMaxFields + 1, wire);
  TEST_ASSERT_EQUAL_STRING("bad_frame", discovery::errorName(discovery::decode(wire, len, p)));
  TEST_ASSERT_TRUE(p.empty());

  char longValue[discovery::kMaxValueLen + 2];
  memset(longValue, 'x', sizeof(longValue) - 1);
  longValue[sizeof(longValue) - 1] = '\0';
  const corpus::FieldSpec oversizedValue[] = {{"v", "1"}, {"url", longValue}};
  len = buildWire("OFFER", oversizedValue, 2, wire);
  TEST_ASSERT_EQUAL_STRING("bad_frame", discovery::errorName(discovery::decode(wire, len, p)));

  const corpus::FieldSpec oversizedKey[] = {{"v", "1"}, {"averylongkey", "1"}};
  len = buildWire("OFFER", oversizedKey, 2, wire);
  TEST_ASSERT_EQUAL_STRING("bad_frame", discovery::errorName(discovery::decode(wire, len, p)));

  // And a datagram longer than any packet this protocol has, which is what an
  // unrelated sender on port 48653 looks like once it gets past the magic.
  char huge[discovery::kMaxPacketLen * 2];
  memset(huge, 'x', sizeof(huge));
  memcpy(huge, "CRSDR1 ANNOUNCE ", 16);
  TEST_ASSERT_EQUAL_STRING("bad_frame", discovery::errorName(discovery::decode(huge, sizeof(huge), p)));
}

/// One optional trailing terminator is tolerated. A sender that appends CRLF is
/// wrong about the spec but not about the packet, and there is no ambiguity to
/// resolve: a datagram is atomic.
void test_a_trailing_terminator_is_optional(void) {
  const corpus::EncodeCase& c = caseById("enc-offer-unsigned");
  char wire[kScratch];
  const size_t len = buildWire(c.verb, c.fields, c.fieldCount, wire);

  Packet withNewline;
  TEST_ASSERT_TRUE(discovery::decode(wire, len, withNewline) == DecodeError::None);

  Packet without;
  TEST_ASSERT_TRUE(discovery::decode(wire, len - 1, without) == DecodeError::None);

  char crlf[kScratch];
  memcpy(crlf, wire, len - 1);
  crlf[len - 1] = '\r';
  crlf[len] = '\n';
  Packet withCrlf;
  TEST_ASSERT_TRUE(discovery::decode(crlf, len + 1, withCrlf) == DecodeError::None);

  for (uint8_t i = 0; i < withNewline.fieldCount(); ++i) {
    TEST_ASSERT_EQUAL_STRING(withNewline.value(i), without.value(i));
    TEST_ASSERT_EQUAL_STRING(withNewline.value(i), withCrlf.value(i));
  }
}

// --- the announce schedule -------------------------------------------------

/// millis() wraps to zero after ~49.71 days, which for a box in an electrical
/// cupboard is the normal case rather than an edge case. The firmware this
/// replaces compared clock readings directly and left a relay closed for weeks;
/// this walks the schedule straight across 0xFFFFFFFF.
void test_the_announce_schedule_survives_the_millis_rollover(void) {
  fakes::FakeClock clock(0xFFFFFFFFU - 2000U);
  Announcer announcer;
  TEST_ASSERT_TRUE(announcer.state() == State::Unclaimed);
  TEST_ASSERT_FALSE(announcer.isAnnouncing());
  TEST_ASSERT_FALSE(announcer.due(clock.nowMs()));

  announcer.linkUp(clock.nowMs());
  TEST_ASSERT_TRUE(announcer.state() == State::Announcing);
  // Immediately on link-up: the admin is standing at the cupboard.
  TEST_ASSERT_TRUE(announcer.due(clock.nowMs()));
  TEST_ASSERT_FALSE(announcer.due(clock.nowMs()));
  TEST_ASSERT_EQUAL_UINT32(discovery::kUnclaimedIntervalMs, announcer.intervalMs());

  uint32_t announces = 0;
  for (size_t step = 0; step < 200; ++step) {
    clock.advance(100U);
    if (announcer.due(clock.nowMs())) {
      ++announces;
    }
  }
  // 20 seconds at 5 s, and the wrap happened four seconds in.
  TEST_ASSERT_TRUE(clock.value() < 0xFFFFFFFFU - 2000U);
  TEST_ASSERT_EQUAL_UINT32(4, announces);

  announcer.claimed(clock.nowMs());
  TEST_ASSERT_TRUE(announcer.state() == State::Claimed);
  TEST_ASSERT_EQUAL_UINT32(discovery::kClaimedIntervalMs, announcer.intervalMs());
  TEST_ASSERT_TRUE(announcer.due(clock.nowMs()));

  announces = 0;
  for (size_t step = 0; step < 1200; ++step) {
    clock.advance(100U);
    if (announcer.due(clock.nowMs())) {
      ++announces;
    }
  }
  TEST_ASSERT_EQUAL_UINT32(2, announces); // 120 seconds at 60 s.
  TEST_ASSERT_EQUAL_UINT32(1 + 4 + 1 + 2, announcer.announceCount());
}

/// A board that loses the link stops broadcasting but stays claimed: being
/// claimed is a fact about the board, not about the network. Coming back is a
/// link-up, so it announces immediately rather than up to a minute later.
void test_link_down_stops_the_schedule_without_forgetting_the_claim(void) {
  fakes::FakeClock clock(1000U);
  Announcer announcer;
  announcer.linkUp(clock.nowMs());
  TEST_ASSERT_TRUE(announcer.due(clock.nowMs()));

  announcer.linkDown();
  TEST_ASSERT_FALSE(announcer.isAnnouncing());
  TEST_ASSERT_TRUE(announcer.state() == State::Unclaimed);
  clock.advance(60000U);
  TEST_ASSERT_FALSE(announcer.due(clock.nowMs()));
  TEST_ASSERT_EQUAL_UINT32(0, announcer.remainingMs(clock.nowMs()));

  announcer.claimed(clock.nowMs());
  TEST_ASSERT_TRUE(announcer.due(clock.nowMs()));
  announcer.linkDown();
  TEST_ASSERT_TRUE(announcer.state() == State::Claimed);
  TEST_ASSERT_FALSE(announcer.isAnnouncing());

  clock.advance(120000U);
  TEST_ASSERT_FALSE(announcer.due(clock.nowMs()));
  announcer.linkUp(clock.nowMs());
  TEST_ASSERT_TRUE(announcer.state() == State::Claimed);
  TEST_ASSERT_TRUE(announcer.due(clock.nowMs()));
  TEST_ASSERT_EQUAL_UINT32(discovery::kClaimedIntervalMs, announcer.remainingMs(clock.nowMs()));
}

/// A board that was blocked — an OTA, a long DNS timeout — must not emit a
/// burst of catch-up announces when it comes back. The interval is rearmed from
/// the moment the announce actually went out.
void test_a_long_stall_does_not_produce_a_burst_of_announces(void) {
  fakes::FakeClock clock(0U);
  Announcer announcer;
  announcer.linkUp(clock.nowMs());
  TEST_ASSERT_TRUE(announcer.due(clock.nowMs()));

  clock.advance(600000U); // Ten minutes with nobody calling due().
  TEST_ASSERT_TRUE(announcer.due(clock.nowMs()));
  TEST_ASSERT_FALSE(announcer.due(clock.nowMs()));
  TEST_ASSERT_EQUAL_UINT32(discovery::kUnclaimedIntervalMs, announcer.remainingMs(clock.nowMs()));
}

// --- runner ----------------------------------------------------------------

void setUp(void) {
}

void tearDown(void) {
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_corpus_encode_cases);
  RUN_TEST(test_corpus_decode_cases);
  RUN_TEST(test_corpus_claim_examples);
  RUN_TEST(test_corpus_executed_count_matches_the_manifest);
  RUN_TEST(test_decode_does_not_care_about_field_order);
  RUN_TEST(test_verification_fails_on_a_single_flipped_bit);
  RUN_TEST(test_the_commitment_changes_with_the_nonce);
  RUN_TEST(test_a_claim_code_is_rejected_unless_it_is_exactly_right);
  RUN_TEST(test_generated_codes_use_the_alphabet_without_bias);
  RUN_TEST(test_claiming_locks_after_three_wrong_codes);
  RUN_TEST(test_a_claimed_box_refuses_an_unsigned_offer);
  RUN_TEST(test_a_claimed_box_accepts_a_properly_signed_offer);
  RUN_TEST(test_an_offer_must_echo_this_boots_nonce);
  RUN_TEST(test_an_unclaimed_box_takes_an_unsigned_offer_but_not_any_packet);
  RUN_TEST(test_the_claim_code_never_reaches_the_wire);
  RUN_TEST(test_a_provisioned_board_announces_itself_claimed);
  RUN_TEST(test_encode_is_all_or_nothing_at_every_capacity);
  RUN_TEST(test_oversized_packets_are_refused_rather_than_truncated);
  RUN_TEST(test_a_trailing_terminator_is_optional);
  RUN_TEST(test_the_announce_schedule_survives_the_millis_rollover);
  RUN_TEST(test_link_down_stops_the_schedule_without_forgetting_the_claim);
  RUN_TEST(test_a_long_stall_does_not_produce_a_burst_of_announces);
  return UNITY_END();
}

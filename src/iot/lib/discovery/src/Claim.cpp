// Claim code, commitment and attempt limit. See include/discovery/Claim.h for
// why the code never reaches the wire and why entropy is injected.

#include "discovery/Claim.h"

#include <string.h>

#include "devcrypto/Hex.h"
#include "devcrypto/Sha256.h"

namespace discovery {
namespace {

/// Bytes of the digest kept. Two hex characters per byte.
constexpr size_t kCommitmentBytes = kCommitmentHexLen / 2;

static_assert(kCommitmentBytes * 2 == kCommitmentHexLen, "commitment length must be a whole number of bytes");
static_assert(kCommitmentBytes <= dc::Sha256::kDigestSize, "commitment cannot be longer than the digest");

bool inAlphabet(char c) {
  for (size_t i = 0; i < kClaimAlphabetSize; ++i) {
    if (kClaimAlphabet[i] == c) {
      return true;
    }
  }
  return false;
}

} // namespace

ClaimCommitment::ClaimCommitment() : hex_() {
  hex_[0] = '\0';
}

ClaimCode::ClaimCode() : text_() {
  text_[0] = '\0';
}

ClaimCode ClaimCode::generate(IEntropySource& entropy) {
  ClaimCode code;
  for (size_t i = 0; i < kClaimCodeLen; ++i) {
    // Masking rather than a modulo: 256 is a multiple of 32, so the low five
    // bits are uniform. `byte % 30` on a 30-character alphabet would make the
    // first two characters 3% more likely than the rest, which is the sort of
    // bias that is never noticed and never justified.
    const uint8_t index = static_cast<uint8_t>(entropy.nextByte() & (kClaimAlphabetSize - 1U));
    code.text_[i] = kClaimAlphabet[index];
  }
  code.text_[kClaimCodeLen] = '\0';
  return code;
}

ClaimCode ClaimCode::fromText(const char* text) {
  ClaimCode code;
  if (text == nullptr || strlen(text) != kClaimCodeLen) {
    return code;
  }
  for (size_t i = 0; i < kClaimCodeLen; ++i) {
    if (!inAlphabet(text[i])) {
      // All or nothing. A code accepted with one character silently dropped is
      // a code that will never match the commitment, diagnosed as a hardware
      // fault three visits later.
      return ClaimCode();
    }
  }
  memcpy(code.text_, text, kClaimCodeLen);
  code.text_[kClaimCodeLen] = '\0';
  return code;
}

ClaimCommitment ClaimCode::commit(const char* nonceHex) const {
  ClaimCommitment out;
  if (empty() || nonceHex == nullptr || nonceHex[0] == '\0') {
    return out;
  }

  // Streamed rather than assembled in a buffer: the separator is the only thing
  // between two variable-length strings, and a buffer here would need a maximum
  // nonce length that nothing else in the protocol has.
  dc::Sha256 sha;
  sha.update(reinterpret_cast<const uint8_t*>(text_), kClaimCodeLen);
  const char separator = ':';
  sha.update(reinterpret_cast<const uint8_t*>(&separator), 1);
  sha.update(reinterpret_cast<const uint8_t*>(nonceHex), strlen(nonceHex));

  uint8_t digest[dc::Sha256::kDigestSize];
  sha.final(digest);

  // Truncation is of the DIGEST, not of its hex text. Hashing to hex and then
  // cutting the string would give the same answer here, but only because the
  // kept length is even — and the version of that mistake that keeps an odd
  // number of characters produces a commitment neither side can reproduce.
  static_cast<void>(dc::hex::encodeLower(digest, kCommitmentBytes, out.hex_, sizeof(out.hex_)));
  return out;
}

bool ClaimCode::matches(const char* presented) const {
  if (empty() || presented == nullptr) {
    return false;
  }
  return dc::hex::constantTimeEqualsText(text_, presented);
}

ClaimGuard::ClaimGuard() : code_(), wrong_(0) {
}

ClaimGuard::ClaimGuard(const ClaimCode& code) : code_(code), wrong_(0) {
}

ClaimCheck ClaimGuard::check(const char* presented) {
  if (locked()) {
    return ClaimCheck::Locked;
  }
  if (code_.matches(presented)) {
    return ClaimCheck::Match;
  }
  wrong_ = static_cast<uint8_t>(wrong_ + 1U);
  // Report Locked on the attempt that reaches the limit, not on the one after
  // it: the caller's LCD message differs, and "you have used your last try"
  // arriving one attempt late is how a member ends up rebooting the board
  // twice.
  return locked() ? ClaimCheck::Locked : ClaimCheck::Wrong;
}

} // namespace discovery

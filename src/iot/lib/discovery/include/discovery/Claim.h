// Crusaders Mainframe — the claim code a board displays, and the commitment it
// broadcasts instead.
//
// WHY A COMMITMENT AND NOT THE CODE
// ---------------------------------
// An admin clicks "connect this board" against a list of announcers. Anything
// on the club WiFi can announce, so the list alone proves nothing: the question
// the protocol has to answer is whether the key about to be issued reaches the
// box in the cupboard or a laptop in the car park.
//
// The board answers it by committing. It shows eight characters on its own LCD
// — a channel nothing on the network can read — and broadcasts only
// SHA256(code ":" nonce) truncated to 16 hex characters. The admin types what
// the LCD shows; the API recomputes the commitment for every announcer and
// claims the one that matches. A fabricated commitment never matches, and an
// impostor that copies a real board's nonce and commitment produces two
// announcers with the same value, which the API refuses out loud. The residual
// attack is denial of service, not key theft.
//
// The alphabet has no I, O, 0 or 1 in it, because this is read off a 16x2
// display in an electrical cupboard and typed on a phone. 32^8 is about
// 1.1e12 and the commitment changes every boot, so guessing is not a path.
//
// WHY THE CODE CANNOT REACH THE WIRE
// ----------------------------------
// The LCD needs the characters, so lcdText() exists. What makes "the code is
// never broadcast" a structural property rather than a rule in a document is on
// the packet side: Packet has no public field setter, and the only constructor
// that produces an unclaimed ANNOUNCE takes a ClaimCommitment. There is no
// expression that puts a ClaimCode into a Packet — see Beacon.h.
//
// WHY ENTROPY IS INJECTED
// -----------------------
// random(), millis() and the ESP's hardware RNG are all platform calls, and a
// generator that reaches for one directly cannot be tested: the corpus's worked
// examples exist precisely so a specific code can be produced on demand. So the
// byte source is a port, taken by reference, exactly as the hal/ ports are. It
// lives here rather than in hal/ because claiming is its only consumer; the
// production implementation belongs in the composition root with the others.
//
// No Arduino headers, no heap, no String/std::string/std::vector.

#ifndef CRUSADERS_DISCOVERY_CLAIM_H
#define CRUSADERS_DISCOVERY_CLAIM_H

#include <stddef.h>
#include <stdint.h>

namespace discovery {

/// Characters in a claim code. Eight, because 32^8 is far past guessable and a
/// ninth character is one more thing to mistype off an LCD.
inline constexpr size_t kClaimCodeLen = 8;

/// No I, O, 0 or 1: each of those has a twin that a tired human reads it as.
inline constexpr char kClaimAlphabet[] = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// 32 exactly. The generator masks a byte with 31 rather than taking it modulo
/// the size, which is unbiased ONLY because the size is a power of two — so the
/// property is asserted here rather than assumed at the point of use.
inline constexpr size_t kClaimAlphabetSize = 32;

static_assert(sizeof(kClaimAlphabet) == kClaimAlphabetSize + 1, "claim alphabet must hold 32 characters");
static_assert((kClaimAlphabetSize & (kClaimAlphabetSize - 1)) == 0,
              "claim alphabet size must be a power of two, or the byte mask biases the code");

/// Hex characters of SHA-256 kept in the commitment. 16 is 64 bits: enough that
/// a collision cannot be produced on a club LAN, short enough to fit a beacon.
inline constexpr size_t kCommitmentHexLen = 16;

/// Wrong codes accepted before claiming is locked until reboot. The commitment
/// has already proved the board's identity by the time a code is checked, so
/// this is the second lock on the same door — but an unbounded retry loop
/// against an eight-character code is exactly the kind of thing that is only
/// noticed after it has been running for a year.
inline constexpr uint8_t kClaimAttemptLimit = 3;

/// Byte-at-a-time entropy port. See the header comment for why this is injected.
class IEntropySource {
public:
  virtual ~IEntropySource() = default;

  /// One uniformly distributed byte. Every byte value must be possible: the
  /// generator masks with 31, so a source that only ever returns even bytes
  /// halves the code space without failing anything.
  virtual uint8_t nextByte() = 0;
};

/// What goes on the wire in place of the code.
///
/// Has no public constructor that fills it: the only way to obtain a non-empty
/// ClaimCommitment is ClaimCode::commit(). That is what keeps the `cch` field
/// derived from a real code rather than from whatever a caller had to hand.
class ClaimCommitment {
public:
  /// Empty. hex() is "" and an ANNOUNCE built with it is refused.
  ClaimCommitment();

  /// 16 lowercase hex characters, or "" when empty. Never null.
  const char* hex() const { return hex_; }

  bool empty() const { return hex_[0] == '\0'; }

private:
  friend class ClaimCode;

  char hex_[kCommitmentHexLen + 1];
};

/// The eight characters on the LCD.
///
/// Comparing a presented code against this one is deliberately NOT public: it
/// goes through ClaimGuard, which counts the attempts. A bare matches() would
/// make the attempt limit something every call site has to remember.
class ClaimCode {
public:
  /// Empty. lcdText() is "" and commit() yields an empty commitment.
  ClaimCode();

  /// Eight characters drawn from the alphabet, one entropy byte each.
  static ClaimCode generate(IEntropySource& entropy);

  /// Parse a code that came from somewhere else — the corpus, or a code the
  /// board persisted. Returns an empty ClaimCode if the length is wrong or any
  /// character is outside the alphabet; there is no partial acceptance.
  static ClaimCode fromText(const char* text);

  bool empty() const { return text_[0] == '\0'; }

  /// The characters, for the panel. Named for the only destination that is
  /// legitimate — see the header comment on why the wire is not one.
  const char* lcdText() const { return text_; }

  /// SHA256(code ":" nonceHex) truncated to kCommitmentHexLen lowercase hex
  /// characters. The nonce is regenerated each boot, so the commitment is too;
  /// a commitment observed yesterday claims nothing today.
  ClaimCommitment commit(const char* nonceHex) const;

private:
  friend class ClaimGuard;

  /// Constant time over equal lengths. A code checked with strcmp leaks how
  /// many leading characters were right, and eight characters recovered one at
  /// a time is 8 * 32 guesses instead of 32^8.
  bool matches(const char* presented) const;

  char text_[kClaimCodeLen + 1];
};

/// The verdict on a presented claim code.
enum class ClaimCheck : uint8_t {
  Match = 0,
  Wrong,
  /// kClaimAttemptLimit wrong codes have been seen. Nothing is checked in this
  /// state, including a correct code: the board reboots or stays unclaimed.
  Locked,
};

/// Holds the displayed code and the attempt counter together, so the limit is
/// not something a caller can forget to apply.
class ClaimGuard {
public:
  ClaimGuard();

  explicit ClaimGuard(const ClaimCode& code);

  ClaimCheck check(const char* presented);

  uint8_t wrongAttempts() const { return wrong_; }

  bool locked() const { return wrong_ >= kClaimAttemptLimit; }

private:
  ClaimCode code_;
  uint8_t wrong_;
};

} // namespace discovery

#endif // CRUSADERS_DISCOVERY_CLAIM_H

// Wire codec, canonical form and MAC for the discovery beacon. See
// include/discovery/BeaconCodec.h.

#include "discovery/BeaconCodec.h"

#include <string.h>

#include "devcrypto/Hex.h"
#include "devcrypto/HmacSha256.h"

namespace discovery {
namespace {

/// Shortest byte sequence that could be a packet: magic, a space, a
/// one-character verb, a space, a one-character field, and `*CC`. Anything
/// shorter is bad_frame and is not even long enough to have a magic worth
/// checking — which is why the empty datagram is a framing failure rather than
/// a magic failure.
constexpr size_t kMinPacketLen = kMagicLen + 1 + 1 + 1 + 1 + 3;

/// "ANNOUNCE" is the longest verb. A longer token is bad_verb: it is
/// well-framed and unrecognised, which is exactly what bad_verb means.
constexpr size_t kMaxVerbLen = 8;

char hexDigit(uint8_t nibble) {
  const uint8_t v = static_cast<uint8_t>(nibble & 0x0FU);
  return v < 10U ? static_cast<char>('0' + static_cast<int>(v))
                 : static_cast<char>('A' + static_cast<int>(v - 10U));
}

/// UPPERCASE hex only, on purpose and to the same rule as the serial protocol.
/// 'a' and 'A' differ by one bit, which is precisely the corruption the field
/// exists to catch, so accepting both would spend the checksum to buy nothing.
bool hexValue(char c, uint8_t& out) {
  if (c >= '0' && c <= '9') {
    out = static_cast<uint8_t>(c - '0');
    return true;
  }
  if (c >= 'A' && c <= 'F') {
    out = static_cast<uint8_t>(static_cast<uint8_t>(c - 'A') + 10U);
    return true;
  }
  return false;
}

uint8_t xorOf(const char* s, size_t n) {
  uint8_t cs = 0;
  for (size_t i = 0; i < n; ++i) {
    cs = static_cast<uint8_t>(cs ^ static_cast<uint8_t>(static_cast<unsigned char>(s[i])));
  }
  return cs;
}

bool sameText(const char* a, const char* b) {
  while (*a != '\0' && *a == *b) {
    ++a;
    ++b;
  }
  return *a == *b;
}

/// Byte-wise ascending, the ordering both sides sort by. Not strcoll and not
/// case-insensitive: keys are ASCII lowercase literals, and any ordering the
/// two implementations could disagree about is a signing string they disagree
/// about.
bool keyIsBefore(const char* a, const char* b) {
  return strcmp(a, b) < 0;
}

/// Bounded writer. Every append is checked, and once it has run out of room it
/// stays failed, so the encoder can do its work unconditionally and consult
/// ok() once at the end rather than testing after every byte.
///
/// The serial codec has the same helper. It is file-static inside that module's
/// translation unit, and hoisting it into a shared library would widen
/// protocol's public surface for the sake of thirty lines — so this is a
/// deliberate duplicate rather than an oversight.
class Writer {
public:
  Writer(char* out, size_t cap) : out_(out), cap_(out == nullptr ? 0 : cap) {}

  void raw(char c) {
    if (!ok_) {
      return;
    }
    if (n_ >= cap_) {
      ok_ = false;
      return;
    }
    out_[n_] = c;
    ++n_;
  }

  void rawText(const char* s) {
    for (size_t i = 0; s[i] != '\0'; ++i) {
      raw(s[i]);
    }
  }

  /// A byte that the checksum covers.
  void body(char c) {
    cs_ = static_cast<uint8_t>(cs_ ^ static_cast<uint8_t>(static_cast<unsigned char>(c)));
    raw(c);
  }

  void bodyText(const char* s) {
    for (size_t i = 0; s[i] != '\0'; ++i) {
      body(s[i]);
    }
  }

  bool ok() const { return ok_; }

  uint8_t checksum() const { return cs_; }

  size_t size() const { return n_; }

private:
  char* out_;
  size_t cap_;
  size_t n_ = 0;
  uint8_t cs_ = 0;
  bool ok_ = true;
};

/// Where the parts of a datagram are, once it is known to be framed at all.
struct Framing {
  size_t verbStart = 0;
  size_t verbLen = 0;
  size_t bodyStart = 0;
  size_t bodyLen = 0;
  uint8_t checksum = 0;
};

/// Magic, checksum position and the verb/body split. Everything that can be
/// decided from the shape alone, before a single byte is interpreted.
DecodeError frameOf(const char* bytes, size_t n, Framing& f) {
  if (n < kMinPacketLen || n > kMaxPacketLen) {
    return DecodeError::BadFrame;
  }
  if (memcmp(bytes, kMagic, kMagicLen) != 0 || bytes[kMagicLen] != ' ') {
    // The separator is part of the magic check: `CRSDR12 ...` is not this
    // protocol either, and reading it as CRSDR1 would be generous about the one
    // field whose whole job is to be exact.
    return DecodeError::BadMagic;
  }

  const size_t star = n - 3;
  if (bytes[star] != '*') {
    return DecodeError::BadFrame;
  }
  uint8_t hi = 0;
  uint8_t lo = 0;
  if (!hexValue(bytes[star + 1], hi) || !hexValue(bytes[star + 2], lo)) {
    // Not bad_frame: the field is present and in the right place, it is the
    // checksum itself that is unacceptable — a lowercase one included.
    return DecodeError::BadChecksum;
  }
  f.checksum = static_cast<uint8_t>(static_cast<uint8_t>(hi << 4) | lo);

  f.verbStart = kMagicLen + 1;
  size_t verbEnd = f.verbStart;
  while (verbEnd < star && bytes[verbEnd] != ' ') {
    ++verbEnd;
  }
  if (verbEnd >= star) {
    return DecodeError::BadFrame; // No space after the verb, so no body.
  }
  f.verbLen = verbEnd - f.verbStart;
  f.bodyStart = verbEnd + 1;
  f.bodyLen = star - f.bodyStart;
  return DecodeError::None;
}

Verb verbOf(const char* bytes, size_t len) {
  if (len == 0 || len > kMaxVerbLen) {
    return Verb::Unknown;
  }
  char name[kMaxVerbLen + 1];
  memcpy(name, bytes, len);
  name[len] = '\0';
  return verbFromName(name);
}

/// Field indices in canonical order, `sig` excluded. Returns how many.
uint8_t canonicalOrder(const Packet& packet, uint8_t* order) {
  uint8_t m = 0;
  for (uint8_t i = 0; i < packet.fieldCount(); ++i) {
    if (!sameText(packet.key(i), "sig")) {
      order[m] = i;
      m = static_cast<uint8_t>(m + 1U);
    }
  }
  // Insertion sort: at most a dozen fields, and it is stable, in place and
  // short enough to read. Nothing here justifies anything cleverer.
  for (uint8_t i = 1; i < m; ++i) {
    const uint8_t held = order[i];
    uint8_t j = i;
    while (j > 0 && keyIsBefore(packet.key(held), packet.key(order[j - 1]))) {
      order[j] = order[j - 1];
      j = static_cast<uint8_t>(j - 1U);
    }
    order[j] = held;
  }
  return m;
}

/// Lowercase hex HMAC of the canonical form. False if the packet does not
/// canonicalise, which is the only way this fails.
bool macHex(const Packet& packet, const dc::ByteSpan& key, char* out, size_t cap) {
  char canonical[kMaxCanonicalLen];
  const size_t n = canonicalInto(packet, canonical, sizeof(canonical));
  if (n == 0) {
    return false;
  }
  uint8_t digest[dc::HmacSha256::kDigestSize];
  dc::HmacSha256::mac(key.data, key.len, reinterpret_cast<const uint8_t*>(canonical), n, digest);
  return dc::hex::encodeLower(digest, sizeof(digest), out, cap);
}

} // namespace

size_t encode(const Packet& packet, char* out, size_t cap) {
  if (packet.empty()) {
    return 0;
  }
  Writer w(out, cap);
  w.rawText(kMagic);
  w.raw(' ');
  w.rawText(verbName(packet.verb()));
  // The space after the verb is NOT checksummed; the spec says the checksum
  // covers the bytes between it and the '*'. The spaces BETWEEN fields are.
  w.raw(' ');
  for (uint8_t i = 0; i < packet.fieldCount(); ++i) {
    if (i != 0) {
      w.body(' ');
    }
    w.bodyText(packet.key(i));
    w.body('=');
    w.bodyText(packet.value(i));
  }
  w.raw('*');
  const uint8_t cs = w.checksum();
  w.raw(hexDigit(static_cast<uint8_t>(cs >> 4)));
  w.raw(hexDigit(cs));
  w.raw('\n');
  return w.ok() ? w.size() : 0;
}

DecodeError decode(const char* bytes, size_t len, Packet& out) {
  out = Packet();
  if (bytes == nullptr) {
    return DecodeError::BadFrame;
  }

  size_t n = len;
  if (n > 0 && bytes[n - 1] == '\n') {
    --n;
  }
  if (n > 0 && bytes[n - 1] == '\r') {
    --n;
  }

  Framing f;
  DecodeError e = frameOf(bytes, n, f);
  if (e != DecodeError::None) {
    return e;
  }

  // Integrity before meaning. A packet whose bytes are in doubt is not worth
  // asking questions about, and answering "unknown verb" for a corrupted one
  // would send the club looking for a version mismatch that is not there.
  if (xorOf(bytes + f.bodyStart, f.bodyLen) != f.checksum) {
    return DecodeError::BadChecksum;
  }

  const Verb v = verbOf(bytes + f.verbStart, f.verbLen);
  if (v == Verb::Unknown) {
    return DecodeError::BadVerb;
  }
  if (f.bodyLen == 0) {
    return DecodeError::BadFrame;
  }

  Packet built = Packet::ofVerb(v);
  e = Packet::fill(bytes + f.bodyStart, f.bodyLen, built);
  if (e != DecodeError::None) {
    return e;
  }
  out = built;
  return DecodeError::None;
}

size_t canonicalInto(const Packet& packet, char* out, size_t cap) {
  if (packet.empty() || out == nullptr) {
    return 0;
  }
  uint8_t order[kMaxFields];
  const uint8_t m = canonicalOrder(packet, order);

  Writer w(out, cap);
  w.rawText(verbName(packet.verb()));
  for (uint8_t i = 0; i < m; ++i) {
    w.raw('\n');
    w.rawText(packet.key(order[i]));
    w.raw('=');
    w.rawText(packet.value(order[i]));
  }
  const size_t n = w.size();
  w.raw('\0'); // Counted against cap, not against the returned length.
  return w.ok() ? n : 0;
}

bool sign(Packet& packet, const dc::ByteSpan& key) {
  if (packet.empty() || packet.isSigned()) {
    return false;
  }
  char signature[dc::Sha256::kHexSize];
  if (!macHex(packet, key, signature, sizeof(signature))) {
    return false;
  }
  return packet.add("sig", signature);
}

bool verify(const Packet& packet, const dc::ByteSpan& key) {
  const char* presented = packet.find("sig");
  if (presented == nullptr) {
    return false;
  }
  char expected[dc::Sha256::kHexSize];
  if (!macHex(packet, key, expected, sizeof(expected))) {
    return false;
  }
  return dc::hex::constantTimeEqualsText(expected, presented);
}

} // namespace discovery

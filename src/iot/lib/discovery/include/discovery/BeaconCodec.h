// Crusaders Mainframe — discovery beacon wire codec, canonical form and MAC.
//
// Encoding and decoding are both one call, unlike the serial codec's streaming
// decoder. A UDP datagram arrives whole or not at all: there is no half packet
// to buffer, no terminator to resynchronise on, and nothing to be gained from a
// byte-at-a-time state machine. A datagram that does not parse is dropped, and
// the next one is five seconds behind it.
//
// Decoding is required to survive, and is tested against, all of:
//   * fields in any order, since nothing on the wire fixes it;
//   * unrelated traffic on port 48653, which is dropped on the magic;
//   * a bad, lowercase or missing checksum;
//   * an unknown verb, an empty body, a field with no '=', a duplicate key,
//     a truncated datagram and an empty one — each with its own error;
//   * more fields or longer values than the fixed buffers hold.
//
// THE CANONICAL FORM
// ------------------
//     <VERB> \n key=value \n key=value ...
// with the fields other than `sig` sorted by key. Same discipline as the HTTP
// request signer and for the same reason: a canonicalisation under which two
// different packets can produce one signing string is a signature-reuse hole.
// Sorting is what lets receive-side field order be free.
//
// No Arduino headers, no heap.

#ifndef CRUSADERS_DISCOVERY_BEACONCODEC_H
#define CRUSADERS_DISCOVERY_BEACONCODEC_H

#include <stddef.h>
#include <stdint.h>

#include "devcrypto/ByteSpan.h"
#include "discovery/Beacon.h"

namespace discovery {

/// Encode as `CRSDR1 <VERB> k=v ...*CC\n`, fields in the order the packet holds
/// them, checksum over the field text only.
///
/// Returns the number of bytes written, or 0 if the packet is empty or would
/// not fit in `cap`. On 0 NOTHING may be transmitted: the contents of `out` are
/// unspecified and this function never produces a partial datagram. A truncated
/// beacon still has a plausible checksum position and would be answered.
///
/// `out` need never exceed kMaxPacketLen.
size_t encode(const Packet& packet, char* out, size_t cap);

/// Decode one datagram. `len` is passed rather than inferred with strlen
/// because a datagram is a byte count, not a C string, and the empty datagram
/// is a real case.
///
/// One optional trailing terminator is tolerated — `\n` or `\r\n` — because a
/// sender that appends CRLF is wrong about the spec but not about the packet.
/// On any error `out` is left empty rather than partially filled.
///
/// Declared in Beacon.h as well, where Packet befriends it: filling a Packet is
/// the one thing no public API can do.
DecodeError decode(const char* bytes, size_t len, Packet& out);

/// Write the canonical signing form. Returns its length excluding the
/// terminator, or 0 if it does not fit; `cap` must leave room for the NUL.
/// Exposed for the shared corpus and for diagnostics — being able to print the
/// exact bytes is what turns a signature mismatch from a mystery into a diff.
size_t canonicalInto(const Packet& packet, char* out, size_t cap);

/// Append `sig`, the lowercase hex HMAC-SHA256 of the canonical form.
///
/// False if the packet is empty, already signed, or does not fit — never a
/// packet with a wrong signature on it.
bool sign(Packet& packet, const dc::ByteSpan& key);

/// Constant-time check of a packet's `sig` against `key`. False when there is
/// no `sig` at all, so "unsigned" and "wrongly signed" are one answer here on
/// purpose: both mean the packet was not produced by the holder of the key.
///
/// Calling this is NOT what makes a claimed box safe. Nothing forces a caller
/// to call it, which is why the accept path for a claimed box goes through
/// ClaimedBox in Offer.h instead.
bool verify(const Packet& packet, const dc::ByteSpan& key);

} // namespace discovery

#endif // CRUSADERS_DISCOVERY_BEACONCODEC_H

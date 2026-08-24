// Crusaders Mainframe — UDP discovery beacon, value types.
//
// WHY THIS EXISTS
// ---------------
// The board this replaces hardcoded its address:
//
//     IPAddress local_IP(192, 168, 68, 150);
//
// which works until somebody changes the router, the subnet, or plugs in a
// second board — and it is invisible to the API either way, so "connecting a
// board" meant an admin reading an IP off a sticker. The requirement is DHCP on
// both sides and no static addresses anywhere, which means the box has to
// announce itself and the API has to answer.
//
// The wire format is deliberately the same shape as the Serial3 line protocol,
// so one mental model covers both links:
//
//     CRSDR1 <VERB> key=value key=value ... *CC\n
//
// `CRSDR1` is magic and version; a datagram not starting with it is dropped
// without parsing, because port 48653 on a club LAN receives things that were
// never meant for it. `*CC` is two UPPERCASE hex digits, the XOR of every byte
// between the space after the verb and the '*'. UDP's own checksum is optional
// on IPv4 and is sometimes transmitted as zero; this one is not optional.
//
// Fields are ORDER-INDEPENDENT ON RECEIPT and order-preserving on send. The
// signature is computed over a canonical form instead (see BeaconCodec.h), so
// receive-side order can be free without making two different packets share a
// signing string.
//
// THE SAFETY RULES, AND WHY THEY ARE TYPES AND NOT COMMENTS
// --------------------------------------------------------
// 1. The claim code must never be encodable into an ANNOUNCE. Packet has no
//    public field setter — announceUnclaimed() takes a ClaimCommitment, and a
//    ClaimCommitment can only come from ClaimCode::commit(). There is no
//    expression that puts the code itself into a packet.
// 2. A claimed box must not act on an unsigned OFFER; a rogue on the LAN would
//    otherwise redirect it to a fake mainframe. That rule lives in Offer.h,
//    where the only type that can accept an OFFER on behalf of a claimed box
//    takes the signing key as a required constructor argument.
//
// No Arduino headers, no heap, no String/std::string/std::vector.

#ifndef CRUSADERS_DISCOVERY_BEACON_H
#define CRUSADERS_DISCOVERY_BEACON_H

#include <stddef.h>
#include <stdint.h>

#include "devcrypto/ByteSpan.h"
#include "discovery/Claim.h"

namespace discovery {

/// Magic and protocol version, as one token.
inline constexpr char kMagic[] = "CRSDR1";
inline constexpr size_t kMagicLen = 6;

static_assert(sizeof(kMagic) == kMagicLen + 1, "kMagicLen must match kMagic");

/// Value of the `v` field. Distinct from the magic on purpose: the magic is
/// changed when the framing changes, `v` when the field set does.
inline constexpr char kProtocolVersion[] = "1";

/// Both directions, both ends. Announces are broadcast to it and OFFERs are
/// unicast back from it.
inline constexpr uint16_t kUdpPort = 48653;

/// Fields a packet can hold. The widest packet the named constructors produce
/// is the signed claimed ANNOUNCE, at 11 fields; 12 leaves one spare. A
/// datagram carrying more is refused as bad_frame rather than truncated —
/// silently dropping the 13th field of a future protocol version would be a
/// packet that decodes to something nobody sent.
inline constexpr size_t kMaxFields = 12;

/// Longest key. `mega` is the longest in the spec at four characters.
inline constexpr size_t kMaxKeyLen = 8;

/// Longest value. Sized by `sig`, which is 64 hex characters and the longest
/// field in the protocol; a device id (36) and a base URL fit inside it.
inline constexpr size_t kMaxValueLen = 64;

/// Buffer that holds any packet the named constructors can produce, terminator
/// included, and the largest datagram the decoder will look at. The signed
/// claimed ANNOUNCE is 234 bytes; 320 leaves room for a longer URL or tenant
/// slug without spending RAM the ESP8266 needs elsewhere.
inline constexpr size_t kMaxPacketLen = 320;

/// The canonical signing form is the same fields with the same separators,
/// minus the magic, the checksum and the `sig` field — so it is never longer
/// than the packet it came from, and this bound needs no separate derivation.
inline constexpr size_t kMaxCanonicalLen = kMaxPacketLen;

enum class Verb : uint8_t {
  Unknown = 0,
  /// box -> 255.255.255.255:48653
  Announce,
  /// API -> box, unicast to the announcing address
  Offer,
};

inline constexpr size_t kVerbCount = 3;

/// Why a datagram did not become a Packet.
///
/// The names are the strings in the shared corpus. Each failure has its own
/// enumerator because they are diagnosed differently at the club: bad_magic is
/// unrelated traffic and is normal, bad_checksum is a network or a spoof,
/// bad_frame is a sender that does not speak this protocol correctly.
enum class DecodeError : uint8_t {
  None = 0,
  /// Does not start with CRSDR1. Not logged as a fault; the port sees noise.
  BadMagic,
  /// XOR mismatch, or a checksum that is not two UPPERCASE hex digits.
  BadChecksum,
  /// Structurally not a packet: too short, no `*CC`, empty body, a field with
  /// no '=', or more fields or longer values than the fixed buffers hold.
  BadFrame,
  /// Well-formed, unknown verb.
  BadVerb,
  /// The same key twice. Refused rather than last-wins: two values for `st` is
  /// not a packet anyone meant to send.
  DuplicateKey,
};

/// Corpus name of a decode error — "bad_magic", "duplicate_key". "" for None.
const char* errorName(DecodeError e);

/// Wire spelling of a verb, "" for Verb::Unknown.
const char* verbName(Verb v);

/// Verb for a wire spelling, Verb::Unknown if there is no such verb.
Verb verbFromName(const char* name);

/// What a board says about itself in every ANNOUNCE. Strings are borrowed and
/// never outlive the call.
struct Identity {
  /// MAC address, lowercase hex, no separators. The board's stable identity.
  const char* mac = nullptr;
  /// "esp8266" or "esp32".
  const char* hardware = nullptr;
  /// This firmware's version.
  const char* firmware = nullptr;
  /// The ATmega's firmware version. Null or "" omits the `mega` field, which is
  /// the honest thing to send before the Mega has answered a PING — an absent
  /// field and a field reading "unknown" are different facts.
  const char* megaFirmware = nullptr;
};

class Packet;

DecodeError decode(const char* bytes, size_t len, Packet& out);
bool sign(Packet& packet, const dc::ByteSpan& key);

/// One discovery datagram, decoded or about to be sent.
///
/// Constructed only through the named constructors below, or by decode(). There
/// is no public field setter, which is what makes rule 1 in the header comment
/// structural: a caller cannot add `cch=<the claim code>` because a caller
/// cannot add anything.
class Packet {
public:
  /// Empty: Verb::Unknown, no fields. Usable as an out-parameter; encodes to
  /// nothing.
  Packet();

  // --- named constructors --------------------------------------------------

  /// First boot. Carries the commitment, never the code, and no signature —
  /// an unclaimed board has no key. What it leaks is a MAC, a firmware version
  /// and an uptime, which is what anyone on the WiFi already gets from ARP.
  ///
  /// Returns an empty Packet if the commitment is empty or anything does not
  /// fit: a beacon with a blank `cch` cannot be claimed and would put the board
  /// in the admin's list as an entry that never works.
  static Packet announceUnclaimed(const Identity& id, const char* nonceHex, const ClaimCommitment& commitment,
                                  uint32_t uptimeSeconds);

  /// Steady state. Carries the device id and tenant slug; the caller signs it
  /// with sign(), without which an attacker could assert that device X had
  /// moved to their address.
  static Packet announceClaimed(const Identity& id, const char* nonceHex, const char* deviceId,
                                const char* tenantSlug, uint32_t uptimeSeconds);

  /// The API's answer. `nonceHex` echoes the announcing board's nonce, so an
  /// OFFER captured today cannot be replayed at the board's next boot.
  static Packet offer(const char* url, uint64_t unixSeconds, const char* nonceHex);

  /// Whether a board in this state should announce itself CLAIMED.
  ///
  /// The decision is small but it is a decision, and it used to live in main.cpp
  /// where nothing tested it — so a provisioned board went on broadcasting the
  /// unclaimed beacon and kept appearing in the admin's "connect a board" list.
  /// All three inputs must hold: the board is provisioned, it knows its device
  /// id, and it knows its tenant. A missing slug falls back to unclaimed rather
  /// than sending a claimed announce with an empty `ten` field — the smaller
  /// wrong is "listed as connectable", not "vanishes from the admin's view".
  static bool shouldAnnounceClaimed(bool provisioned, const char* deviceId, const char* tenantSlug);

  // --- accessors -----------------------------------------------------------

  Verb verb() const { return verb_; }

  bool empty() const { return verb_ == Verb::Unknown; }

  uint8_t fieldCount() const { return count_; }

  /// Key of field `i` in the order it was written or received, "" out of range.
  const char* key(uint8_t i) const;

  const char* value(uint8_t i) const;

  /// Value for `name`, or nullptr when absent. This is the only lookup the
  /// consumers use, which is what makes field order on receipt genuinely
  /// irrelevant rather than merely documented as irrelevant.
  const char* find(const char* name) const;

  bool has(const char* name) const { return find(name) != nullptr; }

  /// True when a `sig` field is present. Says nothing about whether it VERIFIES
  /// — that question is answered by BeaconCodec's verify(), and acted on only
  /// through ClaimedBox in Offer.h.
  bool isSigned() const { return has("sig"); }

private:
  friend DecodeError decode(const char* bytes, size_t len, Packet& out);
  friend bool sign(Packet& packet, const dc::ByteSpan& key);

  static Packet ofVerb(Verb v);

  /// Appends a field. False if the key or value does not fit, either is empty,
  /// or the key is already present. Callers treat false as "abandon the whole
  /// packet": a partial beacon is worse than a missing one, because it is
  /// answered.
  bool add(const char* name, const char* text);

  bool addBounded(const char* name, const char* text, size_t textLen);

  bool addUnsigned(const char* name, uint64_t v);

  /// Parse the field text of a datagram — everything between the space after
  /// the verb and the '*' — into fields. Lives on Packet rather than in the
  /// codec's anonymous namespace because filling a Packet is private by design;
  /// widening the friendship instead would have handed the whole class to a
  /// translation unit.
  static DecodeError fill(const char* body, size_t len, Packet& out);

  static DecodeError addToken(const char* token, size_t len, Packet& out);

  /// The common head of both ANNOUNCE forms: v, mac, hw, fw and the optional
  /// mega. Field ORDER on send is this, then the state-specific fields, then
  /// up, then sig. Nothing depends on it — the receiver sorts — but a stable
  /// order makes two captures of the same board diffable.
  bool addIdentity(const Identity& id);

  Verb verb_;
  uint8_t count_;
  char keys_[kMaxFields][kMaxKeyLen + 1];
  char values_[kMaxFields][kMaxValueLen + 1];
};

} // namespace discovery

#endif // CRUSADERS_DISCOVERY_BEACON_H

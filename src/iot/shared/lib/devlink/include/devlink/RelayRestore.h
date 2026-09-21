// Crusaders Mainframe — what should be ON after a power dip.
//
// THE HOLE THIS CLOSES (GOAL item 17)
// -----------------------------------
// A power dip loses every lit court and there is no restore path ANYWHERE. The
// Mega's `begin()` opens every relay — which is correct and must not change; it
// is what makes a watchdog reset safe — the bridge comes up believing every
// court is dark as of now, and the heartbeat response carries no relay or light
// state at all. The member's booking is still live, they are still charged, and
// the roster will not re-grant them: it admits a scan, and nobody is standing
// at the box to scan again. So the court stays dark for the rest of an evening
// somebody paid for, and the only record of it is a complaint.
//
// The server knows exactly which courts should be on, because it issued every
// grant. This is that knowledge, on the wire.
//
// THE WIRE
// --------
//     "relays": ["0|1834|3fa85f64", "2|600|9c1d0e22"]
//
// An array of PIPE-DELIMITED STRINGS, not objects, deliberately. This end has a
// heapless JSON SCANNER rather than a parser: `devapi::json` offers
// `nextStringElement` / `nextUnsignedElement` and no object-array walker at all.
// The roster already proves the idiom and `devlink::detail::nextStringSpan`
// already walks it. Adding an object walker to a heapless scanner is a new
// failure surface on an 8-bit part, for no gain a reader of the JSON would ever
// see.
//
// `<relay>|<remaining_seconds>|<booking_ref>`:
//
//   relay             exactly ONE digit 0-3, `detail::parseRelayDigit`'s rule —
//                     the roster's, unchanged and now shared rather than
//                     restated. A two-digit relay is malformed, not relay 1.
//   remaining_seconds digits only, and the UNCAPPED true remainder relative to
//                     the instant the response was produced. See below.
//   booking_ref       the first eight hex of the booking id, FOR THE TRACE. It
//                     is never the activation code, and nothing on this board
//                     may decide anything from it — see below.
//
// WHY NO CLOCK IS NEEDED, WHICH IS WHY THIS DESIGN WORKS AT ALL
// --------------------------------------------------------------
// `remaining_seconds` is relative to the response, exactly like the roster's
// `opens_in` / `closes_in`. A box that has just lost power has no idea what
// time it is and may not get one for minutes; an absolute end time would be
// unusable until it did, which is precisely the window this exists to cover.
// Nothing in this file reads `millis()`.
//
// WHY THE REMAINDER IS UNCAPPED HERE
// ----------------------------------
// The box clamps the `!ON` to ninety minutes itself, twice — once in the codec
// and once on the Mega, whose timer does not take the ESP's number on trust
// (`RelayGuard.h`) — and arms its extension logic from the UNCAPPED value.
// Capping here would hide from the bridge that the booking outlives the relay
// deadline, which is the one thing `!EXT` exists for: the court would go dark
// ninety minutes in with half the booking left, and the restore would have
// caused it.
//
// ON IS THE ONLY DIRECTION
// ------------------------
// Only relays that SHOULD BE ON appear. An ABSENT `relays` key means "this API
// does not do restore" and changes nothing. An EMPTY ARRAY means "nothing
// should be on" and still switches nothing OFF — making an empty array an
// off-command would hand the API a way to darken a court mid-game, which it
// must not have, and a dropped response would do it by accident.
//
// WHY `booking_ref` IS INERT
// --------------------------
// It rides along so a technician can tie a lit court to a booking in the audit
// trail, and for nothing else. No branch in any firmware may read it, which is
// what makes "never the activation code" a property of this board as well as a
// rule for the server: even if a server sent a code in that field, there is no
// code path here that could act on one. It is validated only enough to be safe
// to print and to fit.
//
// DEVICE-AGNOSTIC. This takes a plain array and a capacity. The assertion that
// four relays is THIS box's number stays in the court box's own tree, the way
// `bridgelogic/RosterTokenFits.h` does — a shared library that knew how many
// relays a device has would be sizing a gate's array to a court box's bank.
//
// No Arduino headers, no heap, no String. Compiles for AVR, Xtensa and the
// host, and at gnu++11 for the generated sketches.

#ifndef CRUSADERS_DEVLINK_RELAYRESTORE_H
#define CRUSADERS_DEVLINK_RELAYRESTORE_H

#include <stddef.h>
#include <stdint.h>

namespace devlink {

/// The first eight hex of a booking id. Eight because that is what the server
/// sends and what a technician greps for; REFUSED rather than truncated past
/// it, on the roster's rule — half an identifier names a different thing.
inline constexpr size_t kMaxBookingRefLen = 8U;

/// One relay the server says should be on.
struct RelayRestore {
  /// 0-3, an index into this box's relay bank.
  uint8_t relay = 0U;
  /// The TRUE remainder in seconds, relative to the response. Uncapped: the
  /// caller clamps what it puts on the relay and arms `!EXT` from this.
  uint32_t remainingSeconds = 0U;
  /// The booking's first eight hex, for the trace. Inert — see the header.
  char bookingRef[kMaxBookingRefLen + 1U] = {};
};

/// Reads the top-level `relays` array of a heartbeat response into `out`.
///
/// True when the response CARRIES a restore — the key was present, was an
/// array, and the body was a complete document — with `count` set to the
/// elements written into `out` and `rejected`, when given, to the elements this
/// box did not apply.
///
/// False, with `count` and `rejected` UNTOUCHED, when:
///
///   * the key is absent, or is not an array. An older API that does not do
///     restore must not be able to look like one that restores nothing.
///   * `body` is null, or `out` is null.
///   * the body is not a COMPLETE JSON document. Every element of this array
///     CLOSES A RELAY — it energises a court — and half a document is not a
///     sentence the server finished saying. The restore is additive and is
///     re-served on every heartbeat while those courts should be on, so waiting
///     one interval costs seconds; acting on a cut body costs a court lit from
///     bytes nobody sent. Same rule as `applyRoster`'s, for a heavier reason.
///
/// <b>An empty array returns TRUE with `count` 0</b>, and that is not the same
/// answer as an absent key: the caller learns the server has an opinion and the
/// opinion is "none". It still switches nothing off.
///
/// <b>Malformed elements are skipped and COUNTED, and the rest are applied.</b>
/// `RosterSync.h`'s sentence — one bad booking must not blank the evening's
/// other fifteen — with a court that is dark and should not be as the cost.
///
/// `rejected` also counts WELL-FORMED elements past `cap`. From this box's
/// point of view both are the same event: the server said to light a court and
/// this box did not. A server telling a four-relay box to light five relays is
/// a configuration violation in its own right, and nobody should discover
/// either of them from a dark court.
///
/// <b>The TOP-LEVEL `relays`</b>, not the first one anywhere in the document.
/// This array drives relays directly, and `findArray` takes the first match in
/// document order — so a nested one placed before the real one is the list this
/// board would have energised (round G4, B2, with a court instead of a lock).
bool parseRelayRestore(const char* body, size_t len, RelayRestore* out, uint8_t cap, uint8_t& count,
                       uint8_t* rejected = nullptr);

/// Parses one `relay|remaining_seconds|booking_ref` element of `len` bytes.
/// False, with `out` untouched, on any refusal in the grammar above.
///
/// Exposed because the element grammar is the thing the contract corpus pins,
/// and a grammar only reachable through an array walk is a grammar whose
/// refusals can only be tested through one.
bool parseRelayRestoreElement(const char* text, size_t len, RelayRestore& out);

} // namespace devlink

#endif // CRUSADERS_DEVLINK_RELAYRESTORE_H

// Crusaders Mainframe — reading three fields out of a small JSON body, without a
// parser and without a heap.
//
// WHY NOT ArduinoJson, WHICH IS ALREADY A DEPENDENCY
// --------------------------------------------------
// It allocates. On an ESP8266 the heap is shared with the TLS stack, and a
// heartbeat that allocates a document four times a minute is a heap that
// fragments over a season in a cupboard — which shows up as a box that stops
// being able to make an HTTPS connection after six weeks and recovers on a
// reboot, i.e. the worst kind of bug to diagnose from a distance.
//
// What is actually needed is: one integer, three strings, and one array of short
// strings, out of a document the server controls and whose shape is pinned by the
// contract corpus. That is a scanner, not a parser.
//
// WHY IT IS HERE AND NOT IN main.cpp
// ----------------------------------
// `pio test -e native` builds lib/ and test/ and nothing else — src/ is filtered
// out. Scanning written in the composition root is scanning no host test can
// reach, and the first version of this WAS in main.cpp: it scored CCN 21 against
// a limit of 15 and could not be tested at all. Both problems had the same cause.
//
// WHAT IT DELIBERATELY DOES NOT DO
// --------------------------------
// It does not validate JSON. A malformed body produces a miss, never a crash and
// never a wrong value — every function reports absence rather than guessing, and
// every caller treats absence as "learned nothing" rather than as a default.
//
// No Arduino headers, no heap, no String. Compiles for AVR, Xtensa and the host.

#ifndef CRUSADERS_DEVAPI_JSON_H
#define CRUSADERS_DEVAPI_JSON_H

#include <stddef.h>
#include <stdint.h>

namespace devapi {
namespace json {

/// Not-found, for every position-returning function here.
inline constexpr size_t kNotFound = static_cast<size_t>(-1);

/// Position just past the closing quote of the KEY `"<key>"`, or kNotFound.
///
/// <b>A key is a quoted string followed by optional whitespace and a colon.</b>
/// A quoted string that is a VALUE, or an element of an array, is skipped whole.
/// That distinction is the whole point of this function: a gate heartbeat
/// response opens `{"kind":"gate",…}` and carries a `"gate":{…}` object later,
/// so a scan that matched quoted text anywhere returned the value of `kind` —
/// which read the right number off the contract corpus and would have driven a
/// lock for somebody else's the moment a field was added between the two. Every
/// server-controlled string is a decoy for this: a tenant slugged `roster`, a
/// door named `heartbeat_seconds`, a `reason` of `court_number`.
///
/// <b>Keys are found at ANY DEPTH, by a flat scan.</b> The court box reads
/// `button_map`, `slice_minutes` and `walk_up_max_minutes` out of the
/// heartbeat's nested `config` object with no path expression at all. That is
/// depended upon, not tolerated — narrowing this to the top level is a breaking
/// change, and there is no path syntax here to replace it with. A caller that
/// needs a key from one particular object scopes the scan itself, by finding
/// that object's key first and reading from there (`gatelogic::adoptUnlockMs`).
///
/// <b>`\`-escapes are honoured</b> when deciding where a string ends, so a quote
/// inside a value cannot put the scan out of phase with the document. A body
/// truncated inside a string ends the scan: nothing past it is readable.
size_t findKey(const char* body, size_t len, const char* key);

/// Copies the string value of `key` into `out`. False when the key is absent, the
/// value is not a string, or it would not fit.
///
/// <b>Refuses rather than truncates.</b> Half a value is a different value, and
/// every caller here treats absence as "learned nothing" while a truncation
/// would be acted on as fact.
///
/// <b>Escape pairs are copied verbatim, not decoded</b>, and cost two bytes of
/// `outCap`. This is a scanner, not a parser; it agrees with findKey about where
/// the string ends and claims nothing further about what is in it.
bool stringField(const char* body, size_t len, const char* key, char* out, size_t outCap);

/// Reads the unsigned integer value of `key`. False when the key is absent, the value is
/// not a bare integer, or it would overflow.
///
/// <b>Saturating, never wrapping.</b> A body claiming 10^30 is nonsense; wrapping it
/// produces a plausible small number, and a plausible small number for a granted
/// duration or an accepted sequence is acted on rather than questioned.
bool unsignedField(const char* body, size_t len, const char* key, uint32_t& out);

/// Reads the boolean value of `key`. False when the key is absent or the value
/// is not literally `true` or `false` — a quoted "true" is reported as absent,
/// for the same reason a quoted integer is.
bool boolField(const char* body, size_t len, const char* key, bool& out);

/// Position of the first byte INSIDE the object under `key`, with `outLen` set
/// to the bytes from there up to (not including) its matching `}`. kNotFound,
/// with `outLen` untouched, when the key is absent, its value is not an object,
/// or the braces never balance.
///
/// This is how a caller reads a field from ONE object when the flat scan above
/// would find the same field name elsewhere. `findKey` plus a read from there
/// is not the same thing: it bounds the scan at the START of the object and not
/// at its end, so a key added to the document AFTER the object would be adopted
/// as if it were inside it.
///
/// Strings are skipped whole while matching braces, so a `{` or `}` inside a
/// value cannot close the object early.
size_t findObject(const char* body, size_t len, const char* key, size_t& outLen);

/// Position of the first element of the array under `key`, or kNotFound when the
/// key is absent or its value is not an array.
size_t findArray(const char* body, size_t len, const char* key);

/// Reads the next string element starting at `at`, advancing `at` past it.
/// False at the closing bracket, at the end of the buffer, or on a non-string.
bool nextStringElement(const char* body, size_t len, size_t& at, char* out, size_t outCap);

/// Reads the next unsigned-integer element starting at `at`, advancing `at`
/// past it. False at the closing bracket, at the end of the buffer, on a
/// non-integer element, or on overflow — never a wrapped value.
bool nextUnsignedElement(const char* body, size_t len, size_t& at, uint32_t& out);

/// True when `body` is one WHOLE JSON object: optional whitespace, a `{`, a
/// balanced body, its matching `}`, and nothing after it but whitespace.
///
/// WHY A READER OF SINGLE FIELDS NEEDS THIS AT ALL
/// -----------------------------------------------
/// Every other function here reads one field and is deliberately tolerant of a
/// body it cannot fully parse — a truncated response still yields the fields
/// that arrived whole, which is the right answer for `heartbeat_seconds`. It is
/// the WRONG answer for anything a caller REPLACES a cached collection from: a
/// roster cut off by a short read is eleven entries where the server sent
/// sixteen, and committing it discards five bookings the server never cancelled
/// AND re-stamps the cache fresh, so those five members are refused for the
/// whole staleness window with nothing anywhere saying why.
///
/// So a caller that replaces state asks this FIRST, and treats an incomplete
/// body as no push at all.
///
/// Braces and brackets are counted rather than type-matched, and strings —
/// escapes included — are skipped whole, so a `{` or a `]` inside a value
/// counts for nothing. An unterminated string is incomplete by definition.
bool isCompleteObject(const char* body, size_t len);

} // namespace json
} // namespace devapi

#endif // CRUSADERS_DEVAPI_JSON_H

// Crusaders Mainframe — what `API_BASE_URL` is allowed to say, decided by the
// compiler rather than by a board on a wall.
//
// THE FOUR MISTAKES THIS TURNS INTO COMPILE ERRORS
// ------------------------------------------------
// 1. A HOSTNAME. `http://mainframe.local:8088` looks more maintainable than an
//    address and is the single worst value that can go in this file. The ESP32
//    core resolves a host through `WiFiGenericClass::hostByName`, which is
//    bounded by NEITHER `setConnectTimeout` NOR `setTimeout`: it waits for the
//    lwIP DNS resolver, whose own retry schedule runs to about 16 s and then
//    about 15 s again on the second server. One heartbeat against an
//    unreachable DNS server therefore holds loop() for half a minute — five
//    times the watchdog — so the board resets, boots, heartbeats, and resets
//    again, forever, having admitted nobody. An IPv4 literal takes no DNS path
//    at all and every call is bounded by the two HTTP timeouts, which is the
//    whole of what `kWorstBlockingCallMs` and the watchdog assert are built on.
//
// 2. `https://`. `HTTPClient::begin(WiFiClient&, url)` ACCEPTS an https URL
//    against a plain `WiFiClient` — no error, no warning — and then speaks
//    cleartext HTTP to port 443. Every scan and the bearer key go out in the
//    clear to a port nothing is listening on in the way the URL claims. The
//    device API is cleartext on the club LAN by design (see the spec's threat
//    section); what is not allowed is a URL that says otherwise.
//
// 3. A TRAILING SLASH. The port concatenates `baseUrl + path` and every path
//    starts with `/`, so `http://192.168.1.10:8088/` produces
//    `//api/v1/device/gate` — a 404, which the gate correctly treats as "the
//    board learned nothing" and falls back to the roster for. A door that
//    quietly runs offline-only against a perfectly healthy server.
//
// 4. A BASE URL THAT DOES NOT FIT. `char url[kUrlBufSize]` is the buffer the
//    concatenation lands in; too long a base silently produced no request at
//    all.
//
// WHY A GRAMMAR AND NOT A REGEX OR A RUNTIME CHECK
// ------------------------------------------------
// There is nothing a runtime check could usefully do. The value is compiled in,
// there is no console, no display and no provisioning path — the only feedback
// surface is one LED — so "wrong URL" and "server down" are the same slow blink
// to the person on the ladder. The compiler is the only place this can be
// caught, and it costs nothing at run time.
//
// Every function is ONE return statement: the generated Arduino sketch compiles
// at `-std=gnu++11`. See StaticText.h.
//
// No Arduino headers, no heap, no String. Compiles for Xtensa and the host.

#ifndef CRUSADERS_GATELOGIC_APIBASEURL_H
#define CRUSADERS_GATELOGIC_APIBASEURL_H

#include <stddef.h>
#include <stdint.h>

#include "gatelogic/StaticText.h"

namespace gatelogic {

/// The only scheme this firmware speaks, spelled out so the check and the
/// error message cannot drift apart.
inline constexpr char kApiScheme[] = "http://";

/// `http://255.255.255.255:65535` — the longest base URL the grammar below
/// admits, which is what makes the buffer size provable rather than guessed.
inline constexpr size_t kMaxApiBaseUrlLen = 7U + 15U + 6U;

/// Room for the longest path this firmware posts to. `GateFlow.h` asserts its
/// three path constants against it, so a fourth endpoint cannot outgrow the
/// buffer unnoticed.
inline constexpr size_t kMaxPathLen = 32U;

/// The buffer `Esp32HttpPort::post` renders `baseUrl + path` into. Derived, so
/// the static_assert below and the array that actually exists are the same
/// number by construction.
inline constexpr size_t kUrlBufSize = kMaxApiBaseUrlLen + kMaxPathLen + 1U;

namespace url {

/// FAILURE, AS AN OFFSET RATHER THAN A NULL POINTER.
///
/// Every step of the grammar below propagates failure, and it used to propagate
/// it as `nullptr` — which meant every step compared a pointer derived from the
/// address of a string literal against null. GCC under `-fsanitize=undefined`
/// will not fold an object's address in a constant expression, so the whole
/// grammar stops being constexpr and every `static_assert` built on it fails to
/// COMPILE, on a compiler nobody here runs. An offset is an integer: it folds
/// under every compiler and every sanitizer, and it costs nothing. The same
/// trap, and where it was found, is in `StaticText.h` and
/// `memory/gotchas-build.md`.
///
/// Every function still has ONE return statement — the sketch is gnu++11 — and
/// every one short-circuits on `kNoMatch` BEFORE indexing, so a failed step
/// never reads `s[kNoMatch]`.
inline constexpr size_t kNoMatch = static_cast<size_t>(-1);

constexpr bool isDigit(char c) {
  return c >= '0' && c <= '9';
}

/// Digits from `s + at`, stopping at the first byte that is not one.
constexpr unsigned digitRun(const char* s, size_t at) {
  return isDigit(s[at]) ? 1U + digitRun(s, at + 1U) : 0U;
}

/// The value of the `n` digits at `s + at`.
constexpr unsigned digitValue(const char* s, size_t at, unsigned n, unsigned acc) {
  return n == 0U ? acc : digitValue(s, at + 1U, n - 1U, acc * 10U + static_cast<unsigned>(s[at] - '0'));
}

/// One dotted-quad octet: one to three digits, at most 255, and no redundant
/// leading zero. `010` is refused because it is genuinely ambiguous — several
/// resolvers read a leading zero as octal, and a base URL that means one host
/// to the compiler and another to lwIP is worse than one that does not parse.
constexpr bool isOctet(const char* s, size_t at, unsigned n) {
  return n >= 1U && n <= 3U && !(n > 1U && s[at] == '0') && digitValue(s, at, n, 0U) <= 255U;
}

/// Past one octet, or kNoMatch.
constexpr size_t pastOctet(const char* s, size_t at) {
  return at == kNoMatch ? kNoMatch : isOctet(s, at, digitRun(s, at)) ? at + digitRun(s, at) : kNoMatch;
}

constexpr size_t pastDot(const char* s, size_t at) {
  return (at != kNoMatch && s[at] == '.') ? at + 1U : kNoMatch;
}

/// Past `d.d.d.d`, or kNoMatch.
constexpr size_t pastIpv4(const char* s, size_t at) {
  return pastOctet(s, pastDot(s, pastOctet(s, pastDot(s, pastOctet(s, pastDot(s, pastOctet(s, at)))))));
}

/// 1 to 65535, written without a leading zero.
constexpr bool isPort(const char* s, size_t at, unsigned n) {
  return n >= 1U && n <= 5U && s[at] != '0' && digitValue(s, at, n, 0U) <= 65535U;
}

/// Past an OPTIONAL `:port`. No colon at all is legal and leaves the offset
/// where it was — the API on port 80 needs none.
constexpr size_t pastPort(const char* s, size_t at) {
  return at == kNoMatch                             ? kNoMatch
         : s[at] != ':'                             ? at
         : isPort(s, at + 1U, digitRun(s, at + 1U)) ? at + 1U + digitRun(s, at + 1U)
                                                    : kNoMatch;
}

constexpr bool endsHere(const char* s, size_t at) {
  return at != kNoMatch && s[at] == '\0';
}

} // namespace url

/// `http://` + an IPv4 literal + an optional `:port`, and then the end of the
/// string — no path, no trailing slash, no query, no credentials.
constexpr bool isValidApiBaseUrl(const char* url) {
  return text::startsWith(url, kApiScheme) &&
         url::endsHere(url, url::pastPort(url, url::pastIpv4(url, text::length(kApiScheme))));
}

/// It also has to fit, together with the longest path, in the one buffer the
/// HTTP port renders into.
constexpr bool apiBaseUrlFits(const char* url) {
  return text::length(url) <= kMaxApiBaseUrlLen;
}

} // namespace gatelogic

#endif // CRUSADERS_GATELOGIC_APIBASEURL_H

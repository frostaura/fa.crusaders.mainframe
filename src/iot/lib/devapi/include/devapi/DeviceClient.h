// Crusaders Mainframe — the device half of the API contract, minus the socket.
//
// WHY THERE IS NO HTTP CLIENT IN HERE
// -----------------------------------
// `pio test -e native` builds lib/ and test/ and nothing else. Anything that
// touches WiFiClientSecure is unreachable from the host runner, and what needs
// testing is not "can it open a socket" — it is whether the signature matches
// the server's byte for byte, whether a clock 400 seconds out is detected, and
// whether a 401 clears the key or retries forever.
//
// So this renders the exact bytes of a request and interprets the exact bytes
// of a response. main.cpp owns the socket and does nothing else. That is also
// what lets the simulator be a REAL implementation of the protocol rather than
// a second stub the .NET tests would only be checking against themselves.
//
// THE SIGNATURE MUST MATCH DeviceRequestSigner ON THE SERVER
// ----------------------------------------------------------
//     METHOD \n PATH_AND_QUERY \n UNIX_SECONDS \n NONCE \n lowercase_hex(sha256(body))
//
// dc::signer owns that string and is pinned against the shared corpus. This
// class owns the HEADERS that carry it, which is a separate way to be wrong:
// a correct signature under the wrong header name is a 401 nobody can explain.
//
// WHY THE BOX TRACKS CLOCK SKEW EXPLICITLY
// ----------------------------------------
// There is no RTC. Boot time is zero and the only clock is millis(). The
// signature carries a Unix timestamp the server checks against a skew window,
// so an unsynchronised box cannot make a single successful call — and, worse,
// fails in a way that looks like a bad key rather than a bad clock.
//
// So the box learns the time from the `server_unix` field of any response,
// including the 401 that rejected it, and holds an OFFSET rather than a clock:
// unixNow = offset + millis()/1000. That survives the wrap, needs no RTC, and
// re-converges on every call.
//
// No Arduino headers, no heap, no String. Compiles for AVR, Xtensa and the host.

#ifndef CRUSADERS_DEVAPI_DEVICECLIENT_H
#define CRUSADERS_DEVAPI_DEVICECLIENT_H

#include <stddef.h>
#include <stdint.h>

#include "devcrypto/ByteSpan.h"
#include "devcrypto/RequestSigner.h"

namespace devapi {

/// Header names, matching DeviceAuthenticationHandler on the server. Wrong
/// names produce a 401 that looks exactly like a wrong key, so they are
/// constants rather than string literals at the call site.
inline constexpr char kHeaderDeviceId[] = "X-Device-Id";
inline constexpr char kHeaderTimestamp[] = "X-Device-Timestamp";
inline constexpr char kHeaderNonce[] = "X-Device-Nonce";
inline constexpr char kHeaderSignature[] = "X-Device-Signature";

/// Longest device id (a GUID with dashes) plus a terminator.
inline constexpr size_t kMaxDeviceIdLen = 36U;

/// Nonce length in hex characters. 16 bytes of entropy per request; the server
/// remembers recent nonces, so a replay of a captured request is refused even
/// inside the skew window.
inline constexpr size_t kNonceBytes = 16U;
inline constexpr size_t kNonceHexLen = kNonceBytes * 2U;

/// Correction size below which a 401-with-time is judged "not a clock problem".
///
/// This MUST be strictly below the server's own skew window (120 s,
/// DeviceVerifier ClockSkew) — the asymmetry is the whole point. The server
/// starts refusing at 120 s of drift; a local threshold at or above that (this
/// used to be 300) opens a dead band: a board drifted 2–5 minutes gets the
/// 401, adopts the server time, measures a correction smaller than the local
/// threshold, concludes "not skew", and re-provisions over a perfectly healthy
/// credential. At 90 s, every drift the server can refuse for skew corrects by
/// more than this and is read as the clock problem it is.
///
/// Both numbers are pinned in the shared corpus (`clock` in http/cases.json)
/// and asserted from both sides, so neither can move without the other
/// noticing.
inline constexpr int64_t kSkewToleranceSeconds = 90;

/// What the box needs before it can sign anything.
struct Credentials {
  /// The device id, as the API issued it.
  const char* deviceId = nullptr;
  /// The derived device key, raw bytes.
  dc::ByteSpan key;

  bool usable() const {
    return deviceId != nullptr && deviceId[0] != '\0' && key.data != nullptr && key.len > 0U;
  }
};

/// What the caller wants to send, before it is signed.
///
/// A struct rather than four more parameters on sign(): the complexity gate
/// caps a function at six arguments, and "method, path, body, len, uptime,
/// buffers, out" is seven — so the next field to be added would force this
/// change anyway.
struct Call {
  const char* method = nullptr;
  const char* pathAndQuery = nullptr;
  const char* body = nullptr;
  size_t bodyLen = 0U;
};

/// One outbound call, rendered.
///
/// Borrowed pointers into buffers the caller owns — nothing here allocates or
/// outlives the call that produced it.
struct SignedRequest {
  const char* method = nullptr;
  const char* pathAndQuery = nullptr;
  const char* body = nullptr;
  size_t bodyLen = 0U;

  const char* deviceId = nullptr;
  const char* timestamp = nullptr;
  const char* nonce = nullptr;
  const char* signature = nullptr;
};

/// Scratch owned by the caller and filled by sign(). Held apart from
/// SignedRequest so the request can stay a bundle of const pointers.
struct RequestBuffers {
  char timestamp[dc::signer::kMaxUnsignedDigits + 1U] = {};
  char nonce[kNonceHexLen + 1U] = {};
  char signature[dc::signer::kSignatureBufSize] = {};
};

/// Bytes for a nonce. Injected so a test can produce a SPECIFIC request and
/// compare it against a fixture — a client that reached for a platform RNG
/// could only ever be tested against itself.
class IEntropySource {
public:
  virtual ~IEntropySource() = default;
  virtual uint8_t nextByte() = 0;
};

/// What came back, as far as the box cares.
struct Response {
  /// HTTP status, or 0 when the request never completed.
  uint16_t status = 0U;
  /// `server_unix` from the body, or 0 if absent. Present on errors too, which
  /// is what lets a clock-skew 401 be self-correcting.
  uint64_t serverUnix = 0U;
};

/// How the box should react to a response. The mapping is here rather than at
/// the call site because "what does a 401 mean" is a policy question with a
/// wrong answer that bricks a board.
enum class Reaction : uint8_t {
  /// Accepted. Any queued events covered by it may be released.
  Accepted = 0U,
  /// Refused for a reason retrying will not fix — a malformed body, an unknown
  /// court. Retrying forever would pin the queue behind an event that can never
  /// be accepted, so it is dropped and counted.
  Rejected = 1U,
  /// Transient: no route, a 5xx, a timeout. Keep the event and back off.
  Retry = 2U,
  /// The clock was out of the server's skew window. The offset has been
  /// corrected from the response; retry immediately rather than backing off,
  /// because the next attempt is expected to work. Never answered twice in a
  /// row — see react().
  ClockCorrected = 3U,
  /// The credential is not accepted. The box must re-provision; hammering the
  /// endpoint with a key the server has revoked is how a board gets rate
  /// limited out of ever recovering.
  Reprovision = 4U,
};

class DeviceClient {
public:
  DeviceClient(const Credentials& credentials, IEntropySource& entropy)
      : credentials_(credentials), entropy_(entropy) {}

  /// Renders one signed request. False when the credential is unusable, the
  /// clock is unknown, or the buffers are too small — never a partially-signed
  /// request, because a request carrying a stale signature field is a 401 that
  /// looks exactly like a bad key.
  ///
  /// <b>`uptimeMs` is not optional and is not a convenience.</b> The signed
  /// timestamp is `offset + uptime`, and an earlier draft of this signed the
  /// offset alone — which is the epoch seconds at BOOT. That works for the
  /// first few minutes of a board's life and then fails permanently, with a
  /// 401 that reads as a revoked key and sends the box off to re-provision.
  bool sign(const Call& call, uint32_t uptimeMs, RequestBuffers& buffers, SignedRequest& out) const;

  /// Renders one clock-probe request: identical to sign() in every byte except
  /// that the signed timestamp is literally 0. The HMAC is real — signing needs
  /// no clock, only a timestamp VALUE, and 0 is the value the server's
  /// clock-bootstrap contract expects: it refuses the request for skew and the
  /// 401 body's `server_unix` seeds the clock.
  ///
  /// This is how a power-cycled provisioned board recovers its clock without
  /// abandoning its credential. sign() still refuses without a clock — that
  /// refusal protects every NORMAL call from reading its own 401 as a revoked
  /// key; a probe is the one call whose 401 is the point.
  ///
  /// Takes no uptime: there is no clock for it to be added to, and a parameter
  /// that is accepted and ignored reads as if it mattered.
  bool probe(const Call& call, RequestBuffers& buffers, SignedRequest& out) const;

  /// The box's best guess at Unix time. Zero until a response has been seen —
  /// and a zero timestamp is deliberately NOT signable, so an unsynchronised
  /// box fails locally rather than by 401.
  uint64_t unixNow(uint32_t uptimeMs) const;

  /// Learns the offset from a server response. Idempotent and safe to call for
  /// every response including failures.
  void adoptServerTime(uint64_t serverUnix, uint32_t uptimeMs);

  bool clockKnown() const { return clockKnown_; }

  /// The signed offset applied to uptime seconds. Meaningless until
  /// clockKnown().
  int64_t clockOffset() const { return offset_; }

  /// Interprets a response. Also adopts the server time, so a caller cannot
  /// forget to.
  ///
  /// ClockCorrected is supposed to be self-curing — the very next attempt
  /// carries the adopted time and is accepted — so a SECOND consecutive one
  /// means the server keeps 401ing WITH a time attached, and a box that
  /// trusts that forever retries at 1 s for the rest of its life. Two strikes
  /// and the 401 is answered as the Reprovision it evidently is. An Accepted
  /// clears the strike; a Retry or Rejected in between neither clears nor
  /// counts, because a network blip says nothing about the credential. The
  /// policy lives here rather than at the call site so every caller of
  /// react() — heartbeat and event drain alike — shares one count.
  Reaction react(const Response& response, uint32_t uptimeMs);

  void setCredentials(const Credentials& credentials) { credentials_ = credentials; }

  const Credentials& credentials() const { return credentials_; }

private:
  /// The one place a request is rendered: nonce, timestamp formatting, HMAC,
  /// output. sign() and probe() differ ONLY in the timestamp value they pass,
  /// so the canonical string cannot drift between them.
  bool render(const Call& call, uint64_t unixSeconds, RequestBuffers& buffers, SignedRequest& out) const;

  Credentials credentials_;
  IEntropySource& entropy_;

  int64_t offset_ = 0;
  bool clockKnown_ = false;

  /// Consecutive ClockCorrected reactions not yet cleared by an Accepted.
  uint8_t clockCorrectedStreak_ = 0U;
};

/// Reads `"server_unix": <digits>` out of a JSON body without a parser.
///
/// A parser on this part costs flash and a heap the ESP shares with the TLS
/// stack, to extract one integer from a document the server controls. Returns
/// 0 when the field is absent or unreadable, which callers treat as "no clock
/// information", never as "the epoch".
uint64_t findServerUnix(const char* body, size_t len);

} // namespace devapi

#endif // CRUSADERS_DEVAPI_DEVICECLIENT_H

#include "devapi/DeviceClient.h"

#include <string.h>

#include "devcrypto/Hex.h"
#include "devcrypto/Sha256.h"

namespace devapi {

namespace {

bool isDigit(char c) {
  return c >= '0' && c <= '9';
}

} // namespace

bool DeviceClient::sign(const Call& call, uint32_t uptimeMs, RequestBuffers& buffers,
                        SignedRequest& out) const {
  if (!clockKnown_) {
    // Refuse locally rather than sign with a timestamp of zero. A zero
    // timestamp is a guaranteed 401, and a 401 is indistinguishable from a
    // revoked key — which would send the box off to re-provision over what is
    // only an unsynchronised clock. A caller that WANTS the zero-timestamp
    // 401, because the 401 body carries the clock, says so with probe().
    return false;
  }

  // offset + uptime, through the one helper that knows the rule. Signing the
  // offset alone would be signing the epoch second at BOOT — correct for about
  // as long as it takes to notice nothing is wrong, then a permanent 401.
  const uint64_t seconds = unixNow(uptimeMs);
  if (seconds == 0U) {
    return false;
  }
  return render(call, seconds, buffers, out);
}

bool DeviceClient::probe(const Call& call, RequestBuffers& buffers, SignedRequest& out) const {
  // The timestamp is 0 by contract: there is no clock to add an uptime to.
  return render(call, 0U, buffers, out);
}

bool DeviceClient::render(const Call& call, uint64_t unixSeconds, RequestBuffers& buffers,
                          SignedRequest& out) const {
  if (!credentials_.usable() || call.method == nullptr || call.pathAndQuery == nullptr) {
    return false;
  }

  uint8_t nonce[kNonceBytes];
  for (size_t i = 0U; i < kNonceBytes; ++i) {
    nonce[i] = entropy_.nextByte();
  }
  if (!dc::hex::encodeLower(nonce, sizeof(nonce), buffers.nonce, sizeof(buffers.nonce))) {
    return false;
  }

  if (dc::signer::formatUnsigned(unixSeconds, buffers.timestamp, sizeof(buffers.timestamp)) == 0U) {
    return false;
  }

  dc::DeviceRequest request;
  request.method = call.method;
  request.pathAndQuery = call.pathAndQuery;
  request.unixSeconds = unixSeconds;
  request.nonce = buffers.nonce;

  const dc::ByteSpan bodySpan{reinterpret_cast<const uint8_t*>(call.body),
                              call.body == nullptr ? 0U : call.bodyLen};
  if (!dc::signer::signBody(request, bodySpan, credentials_.key, buffers.signature,
                            sizeof(buffers.signature))) {
    return false;
  }

  out.method = call.method;
  out.pathAndQuery = call.pathAndQuery;
  out.body = call.body;
  out.bodyLen = call.body == nullptr ? 0U : call.bodyLen;
  out.deviceId = credentials_.deviceId;
  out.timestamp = buffers.timestamp;
  out.nonce = buffers.nonce;
  out.signature = buffers.signature;
  return true;
}

uint64_t DeviceClient::unixNow(uint32_t uptimeMs) const {
  if (!clockKnown_) {
    return 0U;
  }
  const int64_t candidate = offset_ + static_cast<int64_t>(uptimeMs / 1000U);
  return candidate < 0 ? 0U : static_cast<uint64_t>(candidate);
}

void DeviceClient::adoptServerTime(uint64_t serverUnix, uint32_t uptimeMs) {
  if (serverUnix == 0U) {
    // Absent, not "the epoch". A response without the field teaches nothing and
    // must not reset a good offset.
    return;
  }
  offset_ = static_cast<int64_t>(serverUnix) - static_cast<int64_t>(uptimeMs / 1000U);
  clockKnown_ = true;
}

OfferClock DeviceClient::adoptOfferTime(uint64_t offerUnix, uint32_t uptimeMs) {
  if (offerUnix == 0U) {
    return OfferClock::Absent;
  }
  if (!clockKnown_) {
    adoptServerTime(offerUnix, uptimeMs);
    return OfferClock::Bootstrapped;
  }
  // Signed arithmetic on the difference, so "behind" and "ahead" are asked as
  // two questions and neither one wraps.
  const int64_t current = static_cast<int64_t>(unixNow(uptimeMs));
  const int64_t delta = static_cast<int64_t>(offerUnix) - current;
  if (delta < 0) {
    if (offersIgnored_ < UINT16_MAX) {
      ++offersIgnored_;
    }
    return OfferClock::IgnoredBehind;
  }
  if (delta > kSkewToleranceSeconds) {
    if (offersIgnored_ < UINT16_MAX) {
      ++offersIgnored_;
    }
    return OfferClock::IgnoredTooFar;
  }
  adoptServerTime(offerUnix, uptimeMs);
  return OfferClock::Adopted;
}

Reaction DeviceClient::react(const Response& response, uint32_t uptimeMs) {
  const bool hadClock = clockKnown_;
  const int64_t previousOffset = offset_;
  adoptServerTime(response.serverUnix, uptimeMs);

  if (response.status >= 200U && response.status < 300U) {
    clockCorrectedStreak_ = 0U;
    return Reaction::Accepted;
  }

  if (response.status == 401U || response.status == 403U) {
    // A 401 is ambiguous by design — the server will not say whether the key
    // was wrong or the clock was — so the box decides from what it just
    // learned. If the response carried a time and the box was materially out,
    // the clock is the likelier explanation and is now fixed; retry once
    // rather than abandoning a perfectly good key.
    if (response.serverUnix != 0U) {
      const bool wasSkewed = !hadClock || (previousOffset - offset_ > kSkewToleranceSeconds) ||
                             (offset_ - previousOffset > kSkewToleranceSeconds);
      if (wasSkewed) {
        // Once is a clock problem. Twice in a row — the retry that carried the
        // adopted time was refused with yet another time — is a server that
        // keeps rejecting-with-time, and believing it indefinitely is a 1 s
        // hammer for the rest of the board's life. Second strike reads as the
        // credential problem it is.
        if (clockCorrectedStreak_ >= 1U) {
          clockCorrectedStreak_ = 0U;
          return Reaction::Reprovision;
        }
        ++clockCorrectedStreak_;
        return Reaction::ClockCorrected;
      }
    }
    // Cleared so a future credential does not inherit half a strike.
    clockCorrectedStreak_ = 0U;
    return Reaction::Reprovision;
  }

  if (response.status == 429U || response.status >= 500U || response.status == 0U) {
    // Rate limited, server-side, or never completed. All transient, all worth
    // keeping the event for.
    return Reaction::Retry;
  }

  if (response.status >= 400U) {
    // A 4xx the box caused. Retrying an identical request cannot fix it, and
    // doing so forever pins every later event behind one the server will never
    // take.
    return Reaction::Rejected;
  }

  return Reaction::Retry;
}

uint64_t findServerUnix(const char* body, size_t len) {
  if (body == nullptr || len == 0U) {
    return 0U;
  }

  static const char kKey[] = "\"server_unix\"";
  const size_t keyLen = sizeof(kKey) - 1U;
  if (len < keyLen) {
    return 0U;
  }

  for (size_t i = 0U; i + keyLen <= len; ++i) {
    if (memcmp(body + i, kKey, keyLen) != 0) {
      continue;
    }

    size_t j = i + keyLen;
    while (j < len && (body[j] == ' ' || body[j] == ':')) {
      ++j;
    }
    if (j >= len || !isDigit(body[j])) {
      // The key is there but the value is not a bare integer — a string, null,
      // or a truncated body. Reported as absent rather than half-read.
      return 0U;
    }

    uint64_t value = 0U;
    while (j < len && isDigit(body[j])) {
      const uint64_t digit = static_cast<uint64_t>(body[j] - '0');
      // Saturating rather than wrapping: a body claiming 10^30 seconds is
      // nonsense, and wrapping it would produce a plausible-looking clock.
      if (value > (UINT64_MAX - digit) / 10U) {
        return 0U;
      }
      value = value * 10U + digit;
      ++j;
    }
    return value;
  }

  return 0U;
}

} // namespace devapi

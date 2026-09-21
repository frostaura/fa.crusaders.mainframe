#include "posix_gate_hal/PosixGateHal.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#include "gatelogic/ApiBaseUrl.h"
#include "gatelogic/GateConfig.h"
#include "gatelogic/ResponseBody.h"
#include "timebase/TimeBase.h"

namespace posix_gate_hal {
namespace {

/// Every line this binary prints carries the board's own clock, because every
/// number the harness asserts on — a release that lasted three seconds, a call
/// that spent its whole budget — is measured in it and not in the host's.
void stamp(hal::IClock& clock, const char* channel, const char* text) {
  printf("[%s] %s t=%lums\n", channel, text, static_cast<unsigned long>(clock.nowMs()));
  static_cast<void>(fflush(stdout));
}

const char* levelName(hal::PinLevel level) {
  return level == hal::PinLevel::kHigh ? "HIGH" : "LOW";
}

/// One millisecond of doing nothing, which is what the ESP32 port's `idle()`
/// does through the core's `delay(1)`. Without it a read is a spin.
void sleepOneMs() {
  timespec ts;
  ts.tv_sec = 0;
  ts.tv_nsec = 1000000L;
  static_cast<void>(nanosleep(&ts, nullptr));
}

} // namespace

// --- pin --------------------------------------------------------------------

ConsolePinOut::ConsolePinOut(const char* label, hal::PinLevel onLevel, hal::IClock& clock)
    : label_(label), onLevel_(onLevel), clock_(clock) {
}

void ConsolePinOut::report() {
  const bool on = level_ == onLevel_;
  if (announced_ && on == wasOn_) {
    // The same state, written again. `LockDriver::set` is idempotent by design
    // and writes the level every time; echoing that would bury the two lines
    // that matter under one per pass.
    return;
  }
  announced_ = true;
  wasOn_ = on;
  char line[96];
  static_cast<void>(snprintf(line, sizeof(line), "%s level=%s%s", on ? "ON " : "OFF", levelName(level_),
                             driving_ ? "" : " (register only, pin not driving)"));
  stamp(clock_, label_, line);
}

void ConsolePinOut::write(hal::PinLevel level) {
  level_ = level;
  report();
}

void ConsolePinOut::driveOutput() {
  driving_ = true;
  // Announced unconditionally: the transition from "in the output register" to
  // "on the pin" is the boot-safety property gatelogic/PinOut.h exists for, and
  // a transcript that did not mark it could not show which side of it a level
  // was written on.
  char line[96];
  static_cast<void>(snprintf(line, sizeof(line), "driving, level=%s (%s)", levelName(level_),
                             level_ == onLevel_ ? "ON" : "OFF"));
  stamp(clock_, label_, line);
}

// --- scanner ----------------------------------------------------------------

ConsoleScanner::ConsoleScanner() : buf_(), head_(0U), len_(0U), dropped_(0U), rxError_(false) {
}

bool ConsoleScanner::read(uint8_t& out) {
  if (len_ == 0U) {
    return false;
  }
  out = buf_[head_];
  head_ = static_cast<uint16_t>((head_ + 1U) % kCapacity);
  --len_;
  return true;
}

bool ConsoleScanner::takeRxError() {
  const bool had = rxError_;
  rxError_ = false;
  return had;
}

bool ConsoleScanner::feedByte(uint8_t value) {
  const bool full = len_ == kCapacity;
  if (full) {
    head_ = static_cast<uint16_t>((head_ + 1U) % kCapacity);
    --len_;
    ++dropped_;
  }
  buf_[(head_ + len_) % kCapacity] = value;
  ++len_;
  return !full;
}

void ConsoleScanner::feedLine(const char* text) {
  for (const char* p = text; p != nullptr && *p != '\0'; ++p) {
    static_cast<void>(feedByte(static_cast<uint8_t>(*p)));
  }
  static_cast<void>(feedByte(static_cast<uint8_t>('\n')));
}

// --- link -------------------------------------------------------------------

void ConsoleLink::set(bool up) {
  if (announced_ && up == up_) {
    return;
  }
  announced_ = true;
  up_ = up;
  stamp(clock_, "link", up ? "up" : "down");
}

// --- watchdog ---------------------------------------------------------------

void ConsoleWatchdog::kick() {
  const uint32_t now = clock_.nowMs();
  if (!seeded_) {
    seeded_ = true;
    lastKickMs_ = now;
    return;
  }
  const uint32_t gap = tb::since(now, lastKickMs_);
  lastKickMs_ = now;
  if (gap > worstGapMs_) {
    worstGapMs_ = gap;
  }
  if (gap < periodMs_) {
    return;
  }
  // ON REAL HARDWARE THIS LINE IS A RESET. Printed rather than acted on: a
  // simulator that killed itself here would turn the one relation this board is
  // built on into an unexplained exit, and the transcript is the evidence.
  ++breaches_;
  char line[128];
  static_cast<void>(snprintf(line, sizeof(line),
                             "UNKICKED %lums >= period %lums — a real board would have RESET here",
                             static_cast<unsigned long>(gap), static_cast<unsigned long>(periodMs_)));
  stamp(clock_, "wdt", line);
}

// --- http -------------------------------------------------------------------

namespace {

/// The parsed `http://<ipv4>[:port]` the composition root already validated
/// against `gatelogic::isValidApiBaseUrl`.
struct Endpoint {
  char host[16];
  uint16_t port;
};

/// Splits a base URL the grammar has already accepted. False only if it was
/// never valid, which the composition root refuses to start with.
bool splitBaseUrl(const char* baseUrl, Endpoint& out) {
  const size_t scheme = strlen(gatelogic::kApiScheme);
  if (baseUrl == nullptr || strncmp(baseUrl, gatelogic::kApiScheme, scheme) != 0) {
    return false;
  }
  const char* hostStart = baseUrl + scheme;
  const char* colon = strchr(hostStart, ':');
  const size_t hostLen = colon != nullptr ? static_cast<size_t>(colon - hostStart) : strlen(hostStart);
  if (hostLen == 0U || hostLen >= sizeof(out.host)) {
    return false;
  }
  memcpy(out.host, hostStart, hostLen);
  out.host[hostLen] = '\0';
  out.port = 80U;
  if (colon != nullptr) {
    const long port = strtol(colon + 1, nullptr, 10);
    if (port <= 0L || port > 65535L) {
      return false;
    }
    out.port = static_cast<uint16_t>(port);
  }
  return true;
}

/// `gatelogic::IResponseStream` over a socket, with the one byte of buffering
/// the header phase needs.
///
/// Buffered rather than one `recv` per byte because the header phase and the
/// BODY phase read from the same socket and must not lose a byte between them:
/// a `recv` that returned twelve bytes while the headers wanted three would
/// otherwise throw nine bytes of the body away.
class SocketStream final : public gatelogic::IResponseStream {
public:
  explicit SocketStream(int fd) : fd_(fd) {}

  int available() override {
    if (len_ > pos_) {
      return static_cast<int>(len_ - pos_);
    }
    fill();
    return static_cast<int>(len_ - pos_);
  }

  int read() override {
    if (len_ <= pos_) {
      fill();
    }
    if (len_ <= pos_) {
      return -1;
    }
    return static_cast<int>(buf_[pos_++]);
  }

  /// False once the peer has hung up AND nothing is left buffered — which is
  /// the end of a body that declared no length, and is what HTTP/1.0 with
  /// `Connection: close` produces.
  bool connected() override { return !closed_ || len_ > pos_; }

  void idle() override { sleepOneMs(); }

private:
  void fill() {
    if (closed_) {
      return;
    }
    pos_ = 0U;
    len_ = 0U;
    const ssize_t got = ::recv(fd_, buf_, sizeof(buf_), 0);
    if (got > 0) {
      len_ = static_cast<size_t>(got);
      return;
    }
    if (got == 0) {
      closed_ = true;
      return;
    }
    if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
      closed_ = true;
    }
  }

  int fd_;
  uint8_t buf_[1024] = {};
  size_t pos_ = 0U;
  size_t len_ = 0U;
  bool closed_ = false;
};

/// What the status line and the headers said, which is all `frameFromHeaders`
/// needs plus the status itself.
struct Headers {
  int status;
  int contentLength;
  bool chunked;
};

/// One header line, or the empty line that ends them. False on a timeout or a
/// peer that hung up mid-headers.
bool readLine(gatelogic::IResponseStream& stream, hal::IClock& clock, uint32_t headerDeadline, char* out,
              size_t cap) {
  size_t len = 0U;
  for (;;) {
    if (tb::reached(clock.nowMs(), headerDeadline)) {
      return false;
    }
    const int byte = stream.read();
    if (byte < 0) {
      if (!stream.connected()) {
        return false;
      }
      stream.idle();
      continue;
    }
    if (byte == '\n') {
      while (len > 0U && (out[len - 1U] == '\r')) {
        --len;
      }
      out[len] = '\0';
      return true;
    }
    if (len + 1U < cap) {
      out[len++] = static_cast<char>(byte);
    }
    // Over-long header lines are TRUNCATED rather than refused. The two this
    // reader cares about are short and fixed; a 512-byte `Server:` banner is
    // not a reason to fail a call.
  }
}

bool startsWithNoCase(const char* text, const char* prefix) {
  for (size_t i = 0U; prefix[i] != '\0'; ++i) {
    const char a = text[i];
    const char b = prefix[i];
    const char la = (a >= 'A' && a <= 'Z') ? static_cast<char>(a + 32) : a;
    const char lb = (b >= 'A' && b <= 'Z') ? static_cast<char>(b + 32) : b;
    if (la != lb) {
      return false;
    }
  }
  return true;
}

bool containsNoCase(const char* text, const char* needle) {
  for (size_t i = 0U; text[i] != '\0'; ++i) {
    if (startsWithNoCase(text + i, needle)) {
      return true;
    }
  }
  return false;
}

/// The status line and every header, bounded by an ABSOLUTE deadline.
///
/// The board's header phase is `HTTPClient`'s and is bounded only by an
/// inter-byte timeout — a peer that dribbles resets it for ever, which is the
/// one case the watchdog exists for. A host socket can have a real deadline, so
/// this one does. The difference is in the header's `WHAT IS DELIBERATELY NOT
/// REPRODUCED`, and it makes the simulator slightly safer than the board on
/// that path and never less so.
bool readHeaders(gatelogic::IResponseStream& stream, hal::IClock& clock, uint32_t headerDeadline,
                 Headers& out) {
  out.status = 0;
  out.contentLength = gatelogic::kUnknownBodyLength;
  out.chunked = false;

  char line[512];
  if (!readLine(stream, clock, headerDeadline, line, sizeof(line))) {
    return false;
  }
  // "HTTP/1.1 200 OK". The status is the second token.
  const char* space = strchr(line, ' ');
  if (space == nullptr) {
    return false;
  }
  out.status = static_cast<int>(strtol(space + 1, nullptr, 10));
  if (out.status <= 0) {
    return false;
  }

  for (;;) {
    if (!readLine(stream, clock, headerDeadline, line, sizeof(line))) {
      return false;
    }
    if (line[0] == '\0') {
      return true;
    }
    if (startsWithNoCase(line, "content-length:")) {
      out.contentLength = static_cast<int>(strtol(strchr(line, ':') + 1, nullptr, 10));
    } else if (startsWithNoCase(line, "transfer-encoding:")) {
      // Tolerant of `chunked` at the END of a coding list, which is where RFC
      // 7230 §3.3.1 requires it if it is present at all. The same reading as
      // `Esp32HttpPort::headerSaysChunked`.
      out.chunked = containsNoCase(line, "chunked");
    }
  }
}

/// A non-blocking connect bounded by `gatelogic::kHttpConnectTimeoutMs`. -1 on
/// any failure, which the caller turns into "the request never completed".
int connectBounded(const Endpoint& endpoint, hal::IClock& clock, uint32_t connectDeadline) {
  const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) {
    return -1;
  }
  const int flags = ::fcntl(fd, F_GETFL, 0);
  if (flags < 0 || ::fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) {
    static_cast<void>(::close(fd));
    return -1;
  }
  int one = 1;
  static_cast<void>(::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one)));

  sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons(endpoint.port);
  if (::inet_pton(AF_INET, endpoint.host, &addr.sin_addr) != 1) {
    static_cast<void>(::close(fd));
    return -1;
  }

  if (::connect(fd, reinterpret_cast<const sockaddr*>(&addr), sizeof(addr)) == 0) {
    return fd;
  }
  if (errno != EINPROGRESS) {
    static_cast<void>(::close(fd));
    return -1;
  }

  for (;;) {
    if (tb::reached(clock.nowMs(), connectDeadline)) {
      // THE CONNECT BUDGET, SPENT IN FULL. A host that drops SYNs rather than
      // refusing them is the case this bounds, and it is one of the three
      // phases `kWorstBlockingCallMs` is the sum of.
      static_cast<void>(::close(fd));
      return -1;
    }
    fd_set write;
    FD_ZERO(&write);
    FD_SET(fd, &write);
    timeval slice;
    slice.tv_sec = 0;
    slice.tv_usec = 20000;
    const int ready = ::select(fd + 1, nullptr, &write, nullptr, &slice);
    if (ready < 0) {
      if (errno == EINTR) {
        continue;
      }
      static_cast<void>(::close(fd));
      return -1;
    }
    if (ready == 0) {
      continue;
    }
    int soError = 0;
    socklen_t soLen = sizeof(soError);
    if (::getsockopt(fd, SOL_SOCKET, SO_ERROR, &soError, &soLen) < 0 || soError != 0) {
      static_cast<void>(::close(fd));
      return -1;
    }
    return fd;
  }
}

/// Writes the whole request, or fails. A short write is retried because the
/// socket is non-blocking — the same thing a 9600 baud UART makes every caller
/// in this tree handle.
bool writeAll(int fd, const char* data, size_t len, hal::IClock& clock, uint32_t writeDeadline) {
  size_t sent = 0U;
  while (sent < len) {
    if (tb::reached(clock.nowMs(), writeDeadline)) {
      return false;
    }
    const ssize_t wrote = ::send(fd, data + sent, len - sent, 0);
    if (wrote > 0) {
      sent += static_cast<size_t>(wrote);
      continue;
    }
    if (wrote < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) {
      sleepOneMs();
      continue;
    }
    return false;
  }
  return true;
}

} // namespace

gatelogic::HttpOutcome SocketHttpPort::post(const char* path, const char* body, char* out, size_t outCap) {
  if (baseUrl_ == nullptr || authorization_ == nullptr || authorization_[0] == '\0') {
    return gatelogic::noCall();
  }

  // Sized from the same grammar the board static_asserts API_BASE_URL against,
  // so "the base URL fits" is decided in the same place for both builds.
  char url[gatelogic::kUrlBufSize];
  const int written = snprintf(url, sizeof(url), "%s%s", baseUrl_, path);
  if (written < 0 || static_cast<size_t>(written) >= sizeof(url)) {
    return gatelogic::noCall();
  }

  Endpoint endpoint;
  if (!splitBaseUrl(baseUrl_, endpoint)) {
    return gatelogic::noCall();
  }

  const uint32_t startedAt = clock_.nowMs();
  ++calls_;

  // PHASE ONE: the TCP connect, bounded by kHttpConnectTimeoutMs.
  const int fd = connectBounded(endpoint, clock_, startedAt + gatelogic::kHttpConnectTimeoutMs);
  if (fd < 0) {
    const uint32_t spent = tb::since(clock_.nowMs(), startedAt);
    if (spent > worstCallMs_) {
      worstCallMs_ = spent;
    }
    return gatelogic::noCall();
  }

  // HTTP/1.0 WITH `Connection: close`, WHICH IS WHAT THE SHIPPED FIRMWARE ASKS
  // FOR. `Esp32HttpPort` gets it from `useHTTP10(true)` + `setReuse(false)`;
  // there is no HTTPClient here, so it is spelled out. Kestrel answers every
  // device route `Transfer-Encoding: chunked` on a kept-open socket to a 1.1
  // client, and a reader that stops when the peer closes never stops — which is
  // round G3's critical, and why the request below is 1.0 and the reader
  // de-chunks anyway.
  char request[512];
  const int head =
      snprintf(request, sizeof(request),
               "POST %s HTTP/1.0\r\n"
               "Host: %s:%u\r\n"
               "Content-Type: application/json\r\n"
               "Authorization: %s\r\n"
               "Content-Length: %zu\r\n"
               "Connection: close\r\n"
               "\r\n",
               path, endpoint.host, static_cast<unsigned>(endpoint.port), authorization_, strlen(body));
  gatelogic::HttpOutcome outcome = gatelogic::noCall();
  if (head > 0 && static_cast<size_t>(head) < sizeof(request) &&
      writeAll(fd, request, static_cast<size_t>(head), clock_,
               startedAt + gatelogic::kHttpConnectTimeoutMs + gatelogic::kHttpResponseTimeoutMs) &&
      writeAll(fd, body, strlen(body), clock_,
               startedAt + gatelogic::kHttpConnectTimeoutMs + gatelogic::kHttpResponseTimeoutMs)) {
    SocketStream stream(fd);
    Headers headers;
    // PHASE TWO: the status line and the headers, on their own budget sampled
    // from the moment the connect returned.
    const uint32_t headersFrom = clock_.nowMs();
    if (readHeaders(stream, clock_, headersFrom + gatelogic::kHttpResponseTimeoutMs, headers)) {
      // PHASE THREE: the body, on a budget sampled AFTER the headers returned
      // and never from the instant the whole call started — round G2 did the
      // latter and handed a perfectly good 4.6 KB roster a deadline already in
      // the past. The SAME `gatelogic::readBody` the board runs, framed by the
      // SAME `gatelogic::frameFromHeaders`.
      gatelogic::BodyResult read = gatelogic::BodyResult::Ok;
      if (out != nullptr && outCap > 0U) {
        out[0] = '\0';
        const gatelogic::BodyFrame frame =
            gatelogic::frameFromHeaders(headers.contentLength, headers.chunked);
        read = gatelogic::readBody(stream, clock_, clock_.nowMs() + gatelogic::kHttpBodyBudgetMs, frame, out,
                                   outCap);
      }
      const uint16_t peerStatus = static_cast<uint16_t>(headers.status);
      outcome = gatelogic::HttpOutcome{gatelogic::statusForBody(peerStatus, read), peerStatus};
    }
  }

  static_cast<void>(::close(fd));
  const uint32_t spent = tb::since(clock_.nowMs(), startedAt);
  if (spent > worstCallMs_) {
    worstCallMs_ = spent;
  }
  return outcome;
}

// --- decision log -----------------------------------------------------------

void ConsoleDecisionLog::decided(const gatelogic::ScanDecision& decision, const char* token,
                                 uint32_t grantedMs, uint32_t nowMs) {
  ++count_;
  // BOTH DURATIONS, because they differ exactly when a bound bit: `asked_ms` is
  // what the decision wanted and `granted_ms` is what UnlockTimer actually gave
  // after the per-request cap AND the whole-window cap. An event claiming a
  // release the cap never allowed is a club reading an audit trail that is not
  // true, and the same is true of a transcript.
  //
  // `queued` is NOT relabelled as a source here, tempting as that is. It means
  // one thing — "the API does not already know about this" — which is true of
  // every decision the cached roster took and false of every decision the API
  // took, but is ALSO false for a line refused as unreadable while the API is
  // reachable, because the API can see for itself that nothing was asked. The
  // field says what it is; the harness knows which of the two it unplugged.
  printf("[decision] released=%d reason=%s asked_ms=%lu granted_ms=%lu queued=%d out_of_service=%d "
         "token=%s t=%lums\n",
         decision.released ? 1 : 0, decision.reason[0] == '\0' ? "-" : decision.reason,
         static_cast<unsigned long>(decision.unlockMs), static_cast<unsigned long>(grantedMs),
         decision.queueEvent ? 1 : 0, decision.outOfService ? 1 : 0,
         (token == nullptr || token[0] == '\0') ? "-" : token, static_cast<unsigned long>(nowMs));
  static_cast<void>(fflush(stdout));
}

} // namespace posix_gate_hal

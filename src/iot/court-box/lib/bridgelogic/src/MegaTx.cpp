// See include/bridgelogic/MegaTx.h and docs/specs/device-serial-protocol.md v3,
// "Acknowledgement and retry" and "The paced sender".

#include "bridgelogic/MegaTx.h"

#include <stdlib.h>
#include <string.h>

#include "protocol/Codec.h"
#include "protocol/ScreenCrc.h"
#include "timebase/TimeBase.h"

namespace bridgelogic {

namespace {

uint32_t argU32(const proto::Frame& f, uint8_t i) {
  return static_cast<uint32_t>(strtoul(f.arg(i), nullptr, 10));
}

int32_t opinion(const proto::Frame& f, uint8_t i) {
  return f.arg(i)[0] == '-' ? proto::kNoOpinion : static_cast<int32_t>(argU32(f, i));
}

bool courtOf(const proto::Frame& f, proto::Court& c) {
  return proto::courtFromChar(f.arg(0)[0], c);
}

/// `frame` rebuilt with `tag` (a v3 Mega), or as is (v2: tag 0).
proto::Frame tagged(const proto::Frame& f, uint8_t tag) {
  proto::Court c = proto::Court::A;
  switch (f.verb()) {
  case proto::Verb::On:
    return courtOf(f, c) ? proto::Frame::on(c, argU32(f, 1U), tag) : proto::Frame();
  case proto::Verb::Off:
    return courtOf(f, c) ? proto::Frame::off(c, tag) : proto::Frame();
  case proto::Verb::Ext:
    return courtOf(f, c) ? proto::Frame::ext(c, argU32(f, 1U), tag) : proto::Frame();
  case proto::Verb::Auth:
    return proto::Frame::auth(static_cast<uint16_t>(argU32(f, 0U)), tag);
  case proto::Verb::Want: {
    const int32_t s[4] = {opinion(f, 1U), opinion(f, 2U), opinion(f, 3U), opinion(f, 4U)};
    return proto::Frame::want(tag, s);
  }
  case proto::Verb::Cfg:
    return proto::Frame::cfg(tag, f.arg(1U), static_cast<uint16_t>(argU32(f, 2U)));
  case proto::Verb::Unknown:
  case proto::Verb::Lcd:
  case proto::Verb::Rst:
  case proto::Verb::Ping:
  case proto::Verb::Btn:
  case proto::Verb::Scan:
  case proto::Verb::State:
  case proto::Verb::Pong:
  case proto::Verb::Evt:
  case proto::Verb::Err:
  case proto::Verb::Row:
  case proto::Verb::Show:
  case proto::Verb::Idle:
  case proto::Verb::Map:
  case proto::Verb::Rw:
  case proto::Verb::Cmt:
  case proto::Verb::Land:
  case proto::Verb::Note:
  case proto::Verb::Live:
  case proto::Verb::Ack:
  case proto::Verb::Boot:
  case proto::Verb::Held:
  case proto::Verb::Diag:
  case proto::Verb::Hw:
    break;
  }
  return proto::Frame();
}

bool isV3Only(proto::Verb v) {
  return v == proto::Verb::Want || v == proto::Verb::Cfg || v == proto::Verb::Land || v == proto::Verb::Note ||
         v == proto::Verb::Live || v == proto::Verb::Rw || v == proto::Verb::Cmt;
}

/// A v2 Mega refuses every escape but %2C and %25: `!` never reaches it.
void stripBang(const char* in, char* out, size_t cap) {
  size_t i = 0U;
  for (; in[i] != '\0' && i + 1U < cap; ++i) {
    out[i] = in[i] == '!' ? '.' : in[i];
  }
  out[i] = '\0';
}

} // namespace

size_t encodeV3Screen(const Screen& screen, uint8_t seq, char* out, size_t cap) {
  // v2's action-row-only update (flags bit1) is v3's keep with that row alone.
  const bool actionOnly = (screen.flags & 0x02U) != 0U;
  const uint8_t mask = actionOnly ? static_cast<uint8_t>(1U << (proto::kMaxRows - 1U)) : 0x0FU;
  uint8_t flags = static_cast<uint8_t>(screen.flags & 0x01U);
  if (actionOnly) {
    flags = static_cast<uint8_t>(flags | 0x02U);
  }
  if ((screen.flags & 0x04U) != 0U) {
    flags = static_cast<uint8_t>(flags | 0x04U); // chain
  }
  size_t at = 0U;
  uint16_t crc = proto::kCrc16Init;
  for (uint8_t r = 0U; r < proto::kMaxRows; ++r) {
    if ((mask & (1U << r)) == 0U) {
      continue;
    }
    const size_t n = proto::encode(proto::Frame::rw(seq, r, 0U, screen.rows[r]), out + at, cap - at);
    if (n == 0U) {
      return 0U;
    }
    at += n;
    crc = proto::screenCrcRow(crc, r, screen.rows[r]);
  }
  const size_t n = proto::encode(proto::Frame::cmt(seq, mask, screen.holdSeconds, flags, crc), out + at, cap - at);
  return n == 0U ? 0U : at + n;
}

MegaTx::MegaTx()
    : dialect_(MegaDialect::Unknown), tag_(0U), seq_(0U), ackedLayout_(-1), queue_(), count_(0U),
      priorityBytes_(0U), current_(), currentLen_(0U), currentAt_(0U), pending_(), unacked_(), unackedCount_(0U),
      screens_(), screenHead_(0U), screenCount_(0U), screenInFlight_(false), screenSeq_(0U), screenResends_(0U),
      screenSentAtMs_(0U), inFlight_(), screenBusy_(false), screensDropped_(0U), pendingLayout_(-1),
      layoutTag_(0U) {
}

void MegaTx::setMegaVersion(const char* version) {
  const long major = strtol(version, nullptr, 10);
  const MegaDialect d = major >= 3 ? MegaDialect::V3 : MegaDialect::V2;
  if (d == dialect_) {
    return;
  }
  dialect_ = d;
  for (uint8_t i = 0U; i < kPendingSlots; ++i) {
    pending_[i].used = false;
  }
  ackedLayout_ = -1;
  screenInFlight_ = false;
}

void MegaTx::megaBooted() {
  for (uint8_t i = 0U; i < kPendingSlots; ++i) {
    pending_[i].used = false;
  }
  ackedLayout_ = -1;
  pendingLayout_ = -1;
  screenInFlight_ = false;
}

uint8_t MegaTx::pendingCount() const {
  uint8_t n = 0U;
  for (uint8_t i = 0U; i < kPendingSlots; ++i) {
    n = static_cast<uint8_t>(n + (pending_[i].used ? 1U : 0U));
  }
  return n;
}

uint8_t MegaTx::nextTag() {
  tag_ = static_cast<uint8_t>(tag_ + 1U);
  if (tag_ == 0U) {
    tag_ = 1U;
  }
  return tag_;
}

bool MegaTx::enqueue(const char* bytes, size_t len, bool priority) {
  const size_t limit = priority ? kQueueBytes : static_cast<size_t>(kQueueBytes - kReservedBytes);
  if (len == 0U || count_ + len > limit) {
    return false;
  }
  if (priority) {
    // Ahead of every queued screen byte, behind every queued priority frame.
    memmove(queue_ + priorityBytes_ + len, queue_ + priorityBytes_, count_ - priorityBytes_);
    memcpy(queue_ + priorityBytes_, bytes, len);
    priorityBytes_ = static_cast<uint16_t>(priorityBytes_ + len);
  } else {
    memcpy(queue_ + count_, bytes, len);
  }
  count_ = static_cast<uint16_t>(count_ + len);
  return true;
}

bool MegaTx::encodeAndQueue(const proto::Frame& frame, bool priority) {
  char buf[proto::kMaxFrameLen];
  const size_t len = proto::encode(frame, buf, sizeof(buf));
  return enqueue(buf, len, priority);
}

bool MegaTx::command(const proto::Frame& frame, uint32_t nowMs) {
  if (dialect_ == MegaDialect::Unknown) {
    return false; // BR-05: no relay frame before the Mega is heard
  }
  if (dialect_ == MegaDialect::V2) {
    if (isV3Only(frame.verb())) {
      return true;
    }
    return encodeAndQueue(tagged(frame, proto::kNoTag), true);
  }
  uint8_t slot = kPendingSlots;
  for (uint8_t i = 0U; i < kPendingSlots && slot == kPendingSlots; ++i) {
    if (!pending_[i].used) {
      slot = i;
    }
  }
  if (slot == kPendingSlots) {
    return false;
  }
  const uint8_t tag = nextTag();
  const proto::Frame t = tagged(frame, tag);
  char line[proto::kMaxFrameLen];
  const size_t len = t.empty() ? 0U : proto::encode(t, line, sizeof(line));
  if (len == 0U || len > kPendingLineMax || !enqueue(line, len, true)) {
    return false;
  }
  Pending& p = pending_[slot];
  p.used = true;
  p.tag = tag;
  p.attempts = 1U;
  p.sentAtMs = nowMs;
  p.verb = t.verb();
  proto::Court c = proto::Court::A;
  p.court = (p.verb == proto::Verb::On || p.verb == proto::Verb::Off || p.verb == proto::Verb::Ext) && courtOf(t, c)
                ? static_cast<uint8_t>(c)
                : 0xFFU;
  p.len = static_cast<uint8_t>(len);
  memcpy(p.line, line, len);
  if (frame.verb() == proto::Verb::Cfg && strcmp(frame.arg(1U), "LAYOUT") == 0) {
    pendingLayout_ = static_cast<int8_t>(argU32(frame, 2U) == 1U ? 1 : 0);
    layoutTag_ = tag;
  }
  return true;
}

bool MegaTx::plain(const proto::Frame& frame) {
  if (dialect_ != MegaDialect::V3 && isV3Only(frame.verb())) {
    return true;
  }
  return encodeAndQueue(frame, false);
}

bool MegaTx::screen(const Screen& s, uint32_t nowMs) {
  if (dialect_ != MegaDialect::V3) {
    // v2 (or not yet heard: a 2.1.0 Mega reads !ROW/!SHOW, and so does 3.0.0).
    char buf[(proto::kMaxRows + 1U) * proto::kMaxFrameLen];
    size_t at = 0U;
    for (size_t i = 0U; i < kScreenFrameCount; ++i) {
      proto::Frame f = screenFrame(s, i);
      if (i < proto::kMaxRows) {
        char text[court::kLineLen + 1U];
        stripBang(s.rows[i], text, sizeof(text));
        f = proto::Frame::row(static_cast<uint8_t>(i), text);
      }
      const size_t n = proto::encode(f, buf + at, sizeof(buf) - at);
      if (n == 0U) {
        return false;
      }
      at += n;
    }
    if (!enqueue(buf, at, false)) {
      if (screensDropped_ < UINT16_MAX) {
        ++screensDropped_;
      }
      return false;
    }
    return true;
  }
  if (screenCount_ >= kScreenSlots) {
    // Full: the oldest waiting screen is dropped whole and counted.
    screenHead_ = static_cast<uint8_t>((screenHead_ + 1U) % kScreenSlots);
    --screenCount_;
    if (screensDropped_ < UINT16_MAX) {
      ++screensDropped_;
    }
  }
  screens_[(screenHead_ + screenCount_) % kScreenSlots] = s;
  ++screenCount_;
  startScreen(nowMs);
  return true;
}

void MegaTx::startScreen(uint32_t nowMs) {
  if (screenInFlight_ || screenCount_ == 0U || dialect_ != MegaDialect::V3) {
    return;
  }
  // A newer screen supersedes every older one still waiting: only the latest
  // is worth the wire; the older ones are counted as dropped.
  while (screenCount_ > 1U) {
    screenHead_ = static_cast<uint8_t>((screenHead_ + 1U) % kScreenSlots);
    --screenCount_;
    if (screensDropped_ < UINT16_MAX) {
      ++screensDropped_;
    }
  }
  char buf[(proto::kMaxRows + 1U) * proto::kMaxFrameLen];
  const uint8_t seq = seq_;
  const size_t n = encodeV3Screen(screens_[screenHead_], seq, buf, sizeof(buf));
  if (n == 0U || !enqueue(buf, n, false)) {
    return; // no room yet: retried next pump
  }
  seq_ = static_cast<uint8_t>(seq_ + 1U);
  inFlight_ = screens_[screenHead_];
  screenHead_ = static_cast<uint8_t>((screenHead_ + 1U) % kScreenSlots);
  --screenCount_;
  screenInFlight_ = true;
  screenSeq_ = seq;
  screenResends_ = 0U;
  screenSentAtMs_ = nowMs;
}

void MegaTx::onAck(const proto::Frame& ack, uint32_t nowMs) {
  const char* id = ack.arg(0U);
  const uint32_t code = argU32(ack, 1U);
  if (id[0] == 'S') {
    const uint32_t seq = static_cast<uint32_t>(strtoul(id + 1, nullptr, 10));
    if (!screenInFlight_ || seq != screenSeq_) {
      return;
    }
    screenInFlight_ = false;
    if (code == static_cast<uint32_t>(proto::AckCode::Incomplete) && screenResends_ == 0U) {
      // Re-sent once, whole, under a new seq.
      char buf[(proto::kMaxRows + 1U) * proto::kMaxFrameLen];
      const uint8_t next = seq_;
      const size_t n = encodeV3Screen(inFlight_, next, buf, sizeof(buf));
      if (n > 0U && enqueue(buf, n, false)) {
        seq_ = static_cast<uint8_t>(seq_ + 1U);
        screenInFlight_ = true;
        screenSeq_ = next;
        screenResends_ = 1U;
        screenSentAtMs_ = nowMs;
      }
      return;
    }
    if (code == static_cast<uint32_t>(proto::AckCode::Busy)) {
      screenBusy_ = true;
    }
    startScreen(nowMs);
    return;
  }
  const uint8_t tag = static_cast<uint8_t>(strtoul(id, nullptr, 10));
  for (uint8_t i = 0U; i < kPendingSlots; ++i) {
    if (pending_[i].used && pending_[i].tag == tag) {
      pending_[i].used = false;
    }
  }
  if (tag == layoutTag_ && pendingLayout_ >= 0 && code == static_cast<uint32_t>(proto::AckCode::Applied)) {
    ackedLayout_ = pendingLayout_;
    pendingLayout_ = -1;
  }
}

void MegaTx::pump(hal::ITransport& link, uint32_t nowMs) {
  for (uint8_t i = 0U; i < kPendingSlots; ++i) {
    Pending& p = pending_[i];
    if (!p.used || tb::since(nowMs, p.sentAtMs) < kAckTimeoutMs) {
      continue;
    }
    if (p.attempts > kMaxRetries) {
      p.used = false;
      if (unackedCount_ < kPendingSlots) {
        UnackedFrame& u = unacked_[unackedCount_];
        u.verb = p.verb;
        u.tag = p.tag;
        u.court = p.court;
        ++unackedCount_;
      }
      continue;
    }
    // The SAME tag: a retry whose first copy did arrive is answered duplicate.
    if (enqueue(p.line, p.len, true)) {
      ++p.attempts;
      p.sentAtMs = nowMs;
    }
  }
  if (screenInFlight_ && tb::since(nowMs, screenSentAtMs_) >= kScreenAckTimeoutMs) {
    screenInFlight_ = false;
    // Timed out: re-sent once under a new seq — unless a newer screen is
    // already waiting, which supersedes it.
    if (screenResends_ == 0U && screenCount_ == 0U) {
      screens_[screenHead_] = inFlight_;
      screenCount_ = 1U;
      startScreen(nowMs);
      screenResends_ = 1U;
    }
  }
  startScreen(nowMs);
  writeFrom(link);
}

void MegaTx::writeFrom(hal::ITransport& link) {
  if (!link.connected()) {
    return;
  }
  size_t room = link.writable();
  while (room > 0U) {
    if (currentAt_ >= currentLen_) {
      // The next whole frame off the front of the queue.
      if (count_ == 0U) {
        return;
      }
      uint16_t n = 0U;
      while (n < count_ && queue_[n] != '\n') {
        ++n;
      }
      n = static_cast<uint16_t>(n < count_ ? n + 1U : n);
      if (n > sizeof(current_)) {
        n = sizeof(current_);
      }
      memcpy(current_, queue_, n);
      memmove(queue_, queue_ + n, count_ - n);
      count_ = static_cast<uint16_t>(count_ - n);
      priorityBytes_ = priorityBytes_ > n ? static_cast<uint16_t>(priorityBytes_ - n) : 0U;
      currentLen_ = n;
      currentAt_ = 0U;
    }
    const size_t left = static_cast<size_t>(currentLen_ - currentAt_);
    const size_t offer = left < room ? left : room;
    const size_t wrote = link.write(reinterpret_cast<const uint8_t*>(current_ + currentAt_), offer);
    if (wrote == 0U) {
      return;
    }
    currentAt_ = static_cast<uint16_t>(currentAt_ + wrote);
    room -= wrote;
  }
}

bool MegaTx::takeUnacked(UnackedFrame& out) {
  if (unackedCount_ == 0U) {
    return false;
  }
  out = unacked_[0];
  for (uint8_t i = 1U; i < unackedCount_; ++i) {
    unacked_[i - 1U] = unacked_[i];
  }
  --unackedCount_;
  return true;
}

bool MegaTx::takeScreenBusy() {
  const bool b = screenBusy_;
  screenBusy_ = false;
  return b;
}

} // namespace bridgelogic

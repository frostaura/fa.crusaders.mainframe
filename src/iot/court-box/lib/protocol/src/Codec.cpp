// Wire codec for the court box serial protocol. See include/protocol/Codec.h.

#include "protocol/Codec.h"

namespace proto {
namespace {

const char* const kLegacyScanPrefix = "CHECK:";
constexpr size_t kLegacyScanPrefixLen = 6;

char hexDigit(uint8_t nibble) {
  const uint8_t v = static_cast<uint8_t>(nibble & 0x0FU);
  return v < 10U ? static_cast<char>('0' + static_cast<int>(v))
                 : static_cast<char>('A' + static_cast<int>(v - 10U));
}

/// Uppercase hex only, on purpose. The spec says the checksum is written with
/// uppercase digits, and accepting lowercase would widen the set of byte
/// sequences that count as a valid frame for no gain — 'a' and 'A' differ by a
/// single bit, which is exactly the corruption this field exists to catch.
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

bool startsWith(const char* s, size_t n, const char* prefix, size_t prefixLen) {
  if (n < prefixLen) {
    return false;
  }
  for (size_t i = 0; i < prefixLen; ++i) {
    if (s[i] != prefix[i]) {
      return false;
    }
  }
  return true;
}

bool textIs(const char* s, size_t n, const char* literal) {
  size_t i = 0;
  for (; i < n; ++i) {
    if (literal[i] == '\0' || literal[i] != s[i]) {
      return false;
    }
  }
  return literal[i] == '\0';
}

size_t indexOf(const char* s, size_t n, char c) {
  for (size_t i = 0; i < n; ++i) {
    if (s[i] == c) {
      return i;
    }
  }
  return n;
}

enum class ArgStatus : uint8_t { Ok, Malformed, TooLong };

/// Reverse the argument escaping: `%2C` -> ',' and `%25` -> '%'.
///
/// Anything else beginning with '%' is REJECTED rather than passed through. A
/// decoder that silently keeps a malformed escape does not round-trip, and the
/// two sides of this link have no way to discover the disagreement except by a
/// relay firing on the wrong court.
ArgStatus unescapeInto(const char* s, size_t n, Arg& out) {
  out.clear();
  size_t i = 0;
  while (i < n) {
    char c = s[i];
    if (c == '%') {
      if (n - i < 3) {
        return ArgStatus::Malformed;
      }
      if (s[i + 1] == '2' && s[i + 2] == 'C') {
        c = ',';
      } else if (s[i + 1] == '2' && s[i + 2] == '5') {
        c = '%';
      } else if (s[i + 1] == '2' && s[i + 2] == '1') {
        // v3: '!' is the frame sentinel on both links, so a literal one in
        // text travels as %21 (a bare '!' restarts the line, see feed()).
        c = '!';
      } else if (s[i + 1] == '2' && s[i + 2] == 'A') {
        // v3: accepted, never required — the checksum is the LAST '*'.
        c = '*';
      } else {
        return ArgStatus::Malformed;
      }
      i += 3;
    } else {
      i += 1;
    }
    if (!out.push(c)) {
      return ArgStatus::TooLong;
    }
  }
  return ArgStatus::Ok;
}

/// Decimal digits only, non-empty, saturating instead of wrapping. Saturation
/// matters: `!ON,A,99999999999` must become the hard cap, not a small number.
bool parseU32(const Arg& a, uint32_t& out) {
  const char* s = a.c_str();
  if (a.empty()) {
    return false;
  }
  uint32_t v = 0;
  for (size_t i = 0; i < a.size(); ++i) {
    if (s[i] < '0' || s[i] > '9') {
      return false;
    }
    const uint32_t digit = static_cast<uint32_t>(s[i] - '0');
    if (v > (0xFFFFFFFFU - digit) / 10U) {
      v = 0xFFFFFFFFU;
    } else {
      v = (v * 10U) + digit;
    }
  }
  out = v;
  return true;
}

uint16_t clampTo(uint32_t seconds, uint16_t lowest, uint16_t highest) {
  if (seconds < lowest) {
    return lowest;
  }
  if (seconds > highest) {
    return highest;
  }
  return static_cast<uint16_t>(seconds);
}

/// Bounded writer. Every append is checked, and once it has run out of room it
/// stays failed, so encode() can do its work unconditionally and consult ok()
/// exactly once at the end instead of testing after every byte.
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

  void body(char c) {
    cs_ = static_cast<uint8_t>(cs_ ^ static_cast<uint8_t>(static_cast<unsigned char>(c)));
    raw(c);
  }

  void bodyText(const char* s) {
    for (size_t i = 0; s[i] != '\0'; ++i) {
      body(s[i]);
    }
  }

  /// Apply the argument escaping. The checksum covers the ESCAPED bytes,
  /// because it covers what is on the wire.
  void bodyEscaped(const char* s) {
    for (size_t i = 0; s[i] != '\0'; ++i) {
      if (s[i] == ',') {
        bodyText("%2C");
      } else if (s[i] == '%') {
        bodyText("%25");
      } else if (s[i] == '!') {
        // v3 reserves '!' on both links. A 2.1.0 Mega refuses %21, so the
        // bridge replaces '!' in text before encoding for one (MegaLink).
        bodyText("%21");
      } else {
        body(s[i]);
      }
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

/// The legacy downlink messages that are a fixed string and nothing else.
///
/// RESET and ENTER CODE both put the box back to its idle state. The other
/// three are pure display instructions, so they become an LCD frame carrying
/// the same text. The spec does not say what the second line holds; empty is
/// the only reading that does not invent words for the panel.
/// The three fixed refusal messages, with the exact two lines Carl's sketch puts
/// on the panel for each.
///
/// Taken from the sketch rather than inferred from the command name, and they do
/// not match it: `DENIED` displays "ACCESS DENIED", and two of the three carry a
/// second line telling the player what to do about it. Decoding these to the
/// command text alone would have shown a member less than the hardware shows
/// them today — a silent downgrade in the one place the system talks to someone
/// standing at a locked court.
struct LegacyMessage {
  const char* command;
  const char* line1;
  const char* line2;
};

constexpr LegacyMessage kLegacyMessages[] = {
    {"INVALID CODE", "INVALID CODE", "TRY AGAIN"},
    {"LOW BALANCE", "LOW BALANCE", "TOP UP"},
    {"DENIED", "ACCESS DENIED", ""},
};

bool legacyFixedMessage(const char* line, size_t n, Frame& out) {
  if (textIs(line, n, "RESET") || textIs(line, n, "ENTER CODE")) {
    out = Frame::rst();
    return true;
  }
  for (const LegacyMessage& m : kLegacyMessages) {
    if (textIs(line, n, m.command)) {
      out = Frame::lcd(m.line1, m.line2);
      return true;
    }
  }
  return false;
}

char lowerCourt(char c) {
  return (c >= 'A' && c <= 'D') ? static_cast<char>(c + ('a' - 'A')) : c;
}

} // namespace

// --- encoding --------------------------------------------------------------

size_t encode(const Frame& f, char* out, size_t cap) {
  if (f.empty()) {
    return 0;
  }
  Writer w(out, cap);
  w.raw('!');
  w.bodyText(verbName(f.verb()));
  for (uint8_t i = 0; i < f.argCount(); ++i) {
    w.body(',');
    w.bodyEscaped(f.arg(i));
  }
  w.raw('*');
  const uint8_t cs = w.checksum();
  w.raw(hexDigit(static_cast<uint8_t>(cs >> 4)));
  w.raw(hexDigit(cs));
  w.raw('\n');
  return w.ok() ? w.size() : 0;
}

bool isLegacyRepresentable(const Frame& f) {
  // Table-driven rather than a switch, so adding a verb forces a decision in
  // kVerbSpecs instead of quietly defaulting to "not representable".
  return specOf(f.verb()).legacy;
}

size_t encodeLegacy(const Frame& f, char* out, size_t cap) {
  if (!isLegacyRepresentable(f)) {
    return 0;
  }
  Writer w(out, cap);
  const Verb v = f.verb();
  if (v == Verb::On || v == Verb::Btn) {
    // Uplink `A` (button A) and downlink `A` (relay A on) collide by design;
    // each end only ever reads one direction. The ON duration is dropped here
    // because the legacy message has nowhere to put it.
    w.raw(f.arg(0)[0]);
  } else if (v == Verb::Off) {
    w.raw(lowerCourt(f.arg(0)[0]));
  } else if (v == Verb::Rst) {
    w.rawText("RESET");
  } else if (v == Verb::Lcd) {
    // A '|' inside the text would be ambiguous to a legacy peer. Legacy has no
    // escaping to fix that with, which is one more reason v2 exists.
    w.rawText(f.arg(0));
    w.raw('|');
    w.rawText(f.arg(1));
  } else {
    w.rawText(kLegacyScanPrefix);
    w.rawText(f.arg(0));
  }
  w.raw('\n');
  return w.ok() ? w.size() : 0;
}

// --- decoding --------------------------------------------------------------

Decoder::Decoder(Link link, LegacyDialect legacy)
    : link_(link), legacy_(legacy), line_(), len_(0), overrun_(false), lastWasCr_(false), queue_(), head_(0),
      count_(0), dropped_(0) {
}

void Decoder::reset() {
  len_ = 0;
  overrun_ = false;
  lastWasCr_ = false;
  head_ = 0;
  count_ = 0;
}

bool Decoder::push(const Result& r) {
  if (count_ >= kQueueCap) {
    // Dropping is the least-bad option left: the caller broke the drain
    // contract, and overwriting a Result the caller has not seen would lose a
    // relay command instead of a duplicate one.
    dropped_ = static_cast<uint16_t>(dropped_ + 1U);
    return true;
  }
  queue_[(static_cast<size_t>(head_) + count_) % kQueueCap] = r;
  count_ = static_cast<uint8_t>(count_ + 1U);
  return true;
}

bool Decoder::pushFrame(const Frame& f) {
  Result r;
  r.error = DecodeError::None;
  r.frame = f;
  return push(r);
}

bool Decoder::pushError(DecodeError e) {
  Result r;
  r.error = e;
  return push(r);
}

bool Decoder::pop(Result& out) {
  if (count_ == 0) {
    return false;
  }
  out = queue_[head_];
  head_ = static_cast<uint8_t>((static_cast<size_t>(head_) + 1U) % kQueueCap);
  count_ = static_cast<uint8_t>(count_ - 1U);
  return true;
}

bool Decoder::feed(char c) {
  if (c == '\n' || c == '\r') {
    // `\r\n` is ONE terminator. Treating it as two would turn every frame from
    // a CRLF peer into a frame plus a spurious empty line.
    const bool alreadyTerminated = (c == '\n') && lastWasCr_;
    lastWasCr_ = (c == '\r');
    return alreadyTerminated ? false : endLine();
  }
  lastWasCr_ = false;
  if (c == '!' && (len_ > 0U || overrun_)) {
    // v3 resynchronisation (DL-02). A bare '!' can only start a frame — every
    // text '!' is escaped — so a line still open when one arrives was cut
    // short by a lost byte. Under v2 the decoder waited for '\n' and the torn
    // line swallowed the intact `!ON` behind it. Abandon it, say so once, and
    // start the new frame here.
    const bool wasOverrun = overrun_;
    len_ = 0;
    overrun_ = false;
    line_[0] = c;
    len_ = 1U;
    return pushError(wasOverrun ? DecodeError::Overrun : DecodeError::BadFrame);
  }
  if (len_ >= kMaxFrameLen) {
    // Stop storing but keep consuming: the line is lost either way, and the
    // only useful thing left to do is find the next terminator.
    overrun_ = true;
    return false;
  }
  line_[len_] = c;
  len_ = static_cast<uint16_t>(len_ + 1U);
  return false;
}

bool Decoder::endLine() {
  const uint16_t n = len_;
  const bool wasOverrun = overrun_;
  len_ = 0;
  overrun_ = false;

  if (wasOverrun) {
    // Report and resynchronise. The buffered prefix is NOT parsed: a frame
    // assembled from a truncated line is exactly the half-understood command
    // the checksum exists to prevent.
    return pushError(DecodeError::Overrun);
  }
  if (n == 0) {
    return false; // Blank line, or the gap between two frames. Not an error.
  }
  return parseLine(line_, n);
}

bool Decoder::parseLine(const char* line, size_t n) {
  // '!' is the sentinel precisely because no legacy message in either direction
  // begins with it, so this dispatch is unambiguous.
  if (line[0] == '!') {
    return parseV2(line, n);
  }
  if (legacy_ == LegacyDialect::Refuse) {
    // Not a frame in the only dialect this decoder speaks. Reported, never
    // guessed at: on the production Mega this line is ESP boot garbage or coil
    // noise, and the legacy table would have read a lone `A` as ninety minutes
    // of lights.
    return pushError(DecodeError::BadFrame);
  }
  return parseLegacy(line, n);
}

DecodeError Decoder::splitBody(const char* body, size_t n, Arg* fields, uint8_t& count) {
  count = 0;
  size_t start = 0;
  for (size_t i = 0; i <= n; ++i) {
    if (i != n && body[i] != ',') {
      continue;
    }
    if (count > kMaxArgs) {
      return DecodeError::BadArg;
    }
    const ArgStatus st = unescapeInto(body + start, i - start, fields[count]);
    if (st != ArgStatus::Ok) {
      return DecodeError::BadArg;
    }
    count = static_cast<uint8_t>(count + 1U);
    start = i + 1;
  }
  return DecodeError::None;
}

namespace {

/// `!ROW`'s row index, validated.
///
/// It has no column in kVerbSpecs because it is neither a court nor a duration
/// — and unlike either of those it is the argument whose being wrong would put
/// the text somewhere the sender did not mean, silently. So it is REFUSED
/// rather than clamped: `!ROW,4` on a four-row protocol is a peer that
/// disagrees with this one about the hardware, and folding it onto row 3 would
/// hide the disagreement behind a screen that merely looks odd.
DecodeError rowIndexOf(const Arg& a, uint8_t& out) {
  uint32_t raw = 0;
  if (!parseU32(a, raw) || raw >= kMaxRows) {
    return DecodeError::BadArg;
  }
  out = static_cast<uint8_t>(raw);
  return DecodeError::None;
}

} // namespace

namespace {

/// Decimal 0..`highest` with no leading zero (one spelling per number), into `out`.
bool parseBounded(const Arg& a, uint32_t highest, uint32_t& out) {
  if (a.empty() || (a.size() > 1U && a.c_str()[0] == '0')) {
    return false;
  }
  uint32_t raw = 0;
  if (!parseU32(a, raw) || raw > highest) {
    return false;
  }
  out = raw;
  return true;
}

bool isUpperHex(const Arg& a, size_t digits) {
  if (a.size() != digits) {
    return false;
  }
  uint8_t ignored = 0;
  for (size_t i = 0; i < digits; ++i) {
    if (!hexValue(a.c_str()[i], ignored)) {
      return false;
    }
  }
  return true;
}

/// Saturating decimal parse then clamp into [lowest, highest], rewriting the
/// argument with the clamped value — the v2 rule for durations.
bool clampArg(Arg& a, uint32_t lowest, uint32_t highest) {
  uint32_t raw = 0;
  if (!parseU32(a, raw)) {
    return false;
  }
  a.setU32(raw < lowest ? lowest : (raw > highest ? highest : raw));
  return true;
}

/// "-" (no opinion) or a clamped number; `zeroIsError` refuses a 0 before the
/// clamp (a `!WANT` of 0 would read as a one-second light once clamped).
bool opinionArg(Arg& a, uint32_t lowest, uint32_t highest, bool zeroIsError) {
  if (a.equals("-")) {
    return true;
  }
  uint32_t raw = 0;
  if (!parseU32(a, raw) || (zeroIsError && raw == 0U)) {
    return false;
  }
  return clampArg(a, lowest, highest);
}

bool cfgKeyArg(const Arg& a) {
  if (a.empty() || a.size() > 6U) {
    return false;
  }
  for (size_t i = 0; i < a.size(); ++i) {
    if (a.c_str()[i] < 'A' || a.c_str()[i] > 'Z') {
      return false;
    }
  }
  return true;
}

bool ackIdArg(const Arg& a) {
  uint32_t ignored = 0;
  if (!a.empty() && a.c_str()[0] == 'S') {
    Arg seq;
    static_cast<void>(seq.set(a.c_str() + 1));
    return parseBounded(seq, 255U, ignored);
  }
  return parseBounded(a, 255U, ignored) && ignored != 0U;
}

/// The tag on a v3 relay frame: 1..255, no leading zero (0 would collide with
/// "untagged").
bool tagArg(const Arg& a) {
  uint32_t tag = 0;
  return parseBounded(a, 255U, tag) && tag != 0U;
}

/// One v3 argument by its grammar letter (kVerbSpecs' `grammar`):
///   s seq 0-255 · r row 0-3 · o column offset 0|24 · X text · m mask 1-15 ·
///   H hold, clamped [1,120] · f flags 0-255 · h four uppercase hex ·
///   t tag 1-255 · w '-' or seconds 1-5400 (clamped, 0 refused) ·
///   k CFG key, 1-6 uppercase letters · v value 0-65535 ·
///   l '-' or seconds 0-86400 (clamped) · T note TTL [0,3600] · P live [1,120] ·
///   a ack id (tag or S<seq>) · e ack code 0-4 · b two uppercase hex ·
///   n any decimal · p 0|1 · d 0-5.
/// The plain bounded-integer letters. `handled` false for every other letter.
bool numericArg(char letter, Arg& a, bool& handled) {
  uint32_t value = 0;
  handled = true;
  switch (letter) {
  case 's':
  case 'f':
    return parseBounded(a, 255U, value);
  case 'r':
    return parseBounded(a, kMaxRows - 1U, value);
  case 'o':
    return parseBounded(a, kRwSegment, value) && (value == 0U || value == kRwSegment);
  case 'm':
    return parseBounded(a, 15U, value) && value != 0U;
  case 'v':
    return parseBounded(a, 65535U, value);
  case 'e':
    return parseBounded(a, kAckMaxCode, value);
  case 'n':
    return parseU32(a, value);
  case 'p':
    return parseBounded(a, 1U, value);
  case 'd':
    return parseBounded(a, 5U, value);
  default:
    handled = false;
    return false;
  }
}

/// The letters with a grammar of their own: text, hex, tags, opinions, clamps.
bool shapedArg(char letter, Arg& a) {
  switch (letter) {
  case 'X':
    return true;
  case 'H':
    return clampArg(a, kShowHoldMinSeconds, kShowHoldMaxSeconds);
  case 'h':
    return isUpperHex(a, 4U);
  case 't':
    return tagArg(a);
  case 'w':
    return opinionArg(a, kRelayMinSeconds, kRelayHardCapSeconds, true);
  case 'k':
    return cfgKeyArg(a);
  case 'l':
    return opinionArg(a, 0U, kLandMaxSeconds, false);
  case 'T':
    return clampArg(a, 0U, kNoteMaxSeconds);
  case 'P':
    return clampArg(a, kLiveMinSeconds, kLiveMaxSeconds);
  case 'a':
    return ackIdArg(a);
  case 'b':
    return isUpperHex(a, 2U);
  default:
    return false;
  }
}

/// One v3 argument by its grammar letter (kVerbSpecs' `grammar`):
///   s seq 0-255 · r row 0-3 · o column offset 0|24 · X text · m mask 1-15 ·
///   H hold, clamped [1,120] · f flags 0-255 · h four uppercase hex ·
///   t tag 1-255 · w '-' or seconds 1-5400 (clamped, 0 refused) ·
///   k CFG key, 1-6 uppercase letters · v value 0-65535 ·
///   l '-' or seconds 0-86400 (clamped) · T note TTL [0,3600] · P live [1,120] ·
///   a ack id (tag or S<seq>) · e ack code 0-4 · b two uppercase hex ·
///   n any decimal · p 0|1 · d 0-5.
/// Two switches rather than a table: a table would sit in the Mega's 8 KB of
/// RAM (AVR keeps constexpr data in .data), and the image is at its 4 KB budget.
bool v3Arg(char letter, Arg& a) {
  bool handled = false;
  const bool ok = numericArg(letter, a, handled);
  return handled ? ok : shapedArg(letter, a);
}

bool wrongDirection(Link link, Dir dir) {
  return (dir == Dir::Down && link == Link::Uplink) || (dir == Dir::Up && link == Link::Downlink);
}

} // namespace

DecodeError Decoder::buildV2Frame(Verb v, const VerbSpec& spec, Arg* args, uint8_t argc, Frame& out) {
  Court court = Court::A;
  if (spec.courtArg >= 0) {
    const Arg& a = args[spec.courtArg];
    if (a.size() != 1 || !courtFromChar(a.c_str()[0], court)) {
      return DecodeError::NoCourt;
    }
  }

  uint16_t seconds = 0;
  if (spec.secondsArg >= 0) {
    uint32_t raw = 0;
    if (!parseU32(args[spec.secondsArg], raw)) {
      return DecodeError::BadArg;
    }
    seconds = clampTo(raw, spec.minSeconds, spec.maxSeconds);
    args[spec.secondsArg].setU32(seconds);
  }

  out = (v == Verb::On && argc == spec.minArgs) ? Frame::on(court, seconds)
                                                : Frame::fromValidated(spec, args, argc);
  return DecodeError::None;
}

DecodeError Decoder::buildFrame(Link link, Arg* fields, uint8_t count, Frame& out) {
  const Verb v = verbFromName(fields[0].c_str());
  if (v == Verb::Unknown) {
    return DecodeError::BadVerb;
  }
  const VerbSpec& spec = specOf(v);
  const uint8_t argc = static_cast<uint8_t>(count - 1U);
  if (argc < spec.minArgs || argc > spec.maxArgs) {
    return DecodeError::BadArg;
  }

  // Direction is part of the v3 grammar: a relay verb echoed back by a wiring
  // fault is never acted on (see Dir for why v2's verbs stay Any).
  if (wrongDirection(link, spec.dir)) {
    return DecodeError::BadVerb;
  }

  Arg* args = fields + 1;
  if (spec.grammar != nullptr) {
    for (uint8_t i = 0; i < argc; ++i) {
      if (!v3Arg(spec.grammar[i], args[i])) {
        return DecodeError::BadArg;
      }
    }
    out = Frame::fromValidated(spec, args, argc);
    return DecodeError::None;
  }
  if (spec.optionalTag && argc == spec.maxArgs && !tagArg(args[argc - 1U])) {
    return DecodeError::BadArg;
  }
  if (v == Verb::Row) {
    uint8_t rowIndex = 0;
    const DecodeError e = rowIndexOf(args[0], rowIndex);
    if (e != DecodeError::None) {
      return e;
    }
    // Through its own constructor, for the same reason ON is: the refusal rule
    // then lives in ONE place and the wire cannot mint a frame the factory
    // would not have built.
    out = Frame::row(rowIndex, args[1].c_str());
    return DecodeError::None;
  }

  return buildV2Frame(v, spec, args, argc, out);
}

bool Decoder::parseV2(const char* line, size_t n) {
  // Shortest legal frame is `!` + a two-character verb + `*` + two hex digits.
  if (n < 6 || line[n - 3] != '*') {
    return pushError(DecodeError::BadFrame);
  }
  uint8_t hi = 0;
  uint8_t lo = 0;
  if (!hexValue(line[n - 2], hi) || !hexValue(line[n - 1], lo)) {
    return pushError(DecodeError::BadFrame);
  }

  const size_t bodyLen = n - 4; // Between '!' and '*', exclusive of both.
  const uint8_t want = static_cast<uint8_t>(static_cast<uint8_t>(hi << 4) | lo);
  if (xorOf(line + 1, bodyLen) != want) {
    return pushError(DecodeError::BadCrc);
  }

  Arg fields[kMaxArgs + 1];
  uint8_t count = 0;
  DecodeError e = splitBody(line + 1, bodyLen, fields, count);
  Frame f;
  if (e == DecodeError::None) {
    e = buildFrame(link_, fields, count, f);
  }
  return e == DecodeError::None ? pushFrame(f) : pushError(e);
}

bool Decoder::parseLegacy(const char* line, size_t n) {
  return link_ == Link::Downlink ? parseLegacyDownlink(line, n) : parseLegacyUplink(line, n);
}

bool Decoder::parseLegacyDownlink(const char* line, size_t n) {
  Court court = Court::A;
  if (n == 1 && courtFromChar(line[0], court)) {
    // A legacy on gets the hard cap, because the alternative is forever.
    return pushFrame(Frame::on(court, kRelayHardCapSeconds));
  }
  if (n == 1 && line[0] >= 'a' && line[0] <= 'd') {
    static_cast<void>(courtFromChar(static_cast<char>(line[0] - ('a' - 'A')), court));
    return pushFrame(Frame::off(court));
  }
  Frame special;
  if (legacyFixedMessage(line, n, special)) {
    return pushFrame(special);
  }
  const size_t bar = indexOf(line, n, '|');
  if (bar < n) {
    // `<line1>|<line2>` also arms the buttons in Carl's sketch, so it is two v2
    // frames: the display, and the AUTH window that was implicit in it.
    Arg first;
    Arg second;
    static_cast<void>(first.set(line, bar));
    static_cast<void>(second.set(line + bar + 1, n - bar - 1));
    static_cast<void>(pushFrame(Frame::lcd(first.c_str(), second.c_str())));
    return pushFrame(Frame::auth(kAuthDefaultSeconds));
  }
  return pushError(DecodeError::BadFrame);
}

bool Decoder::parseLegacyUplink(const char* line, size_t n) {
  Key key = Key::CourtA;
  if (n == 1 && keyFromChar(line[0], key)) {
    return pushFrame(Frame::btn(key));
  }
  if (startsWith(line, n, kLegacyScanPrefix, kLegacyScanPrefixLen)) {
    Arg code;
    // A scanner code that does not fit is refused, not shortened: a truncated
    // code is a valid-looking code belonging to somebody else.
    if (!code.set(line + kLegacyScanPrefixLen, n - kLegacyScanPrefixLen) || code.empty()) {
      return pushError(DecodeError::BadArg);
    }
    return pushFrame(Frame::scan(code.c_str()));
  }
  return pushError(DecodeError::BadFrame);
}

} // namespace proto

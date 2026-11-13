// Unity tests for the ATmega2560 <-> ESP8266 line protocol codec.
//
// Two halves, and the split is deliberate.
//
// The CORPUS half walks src/contracts/device-protocol/serial/cases.json, which
// is shared ground owned by neither side of the link. Those cases say what the
// bytes are. The suite asserts that the number of cases it EXECUTED equals the
// number manifest.json declares, and that none was skipped as an unrecognised
// kind — a side that quietly ignores what it cannot parse passes a checksum
// test over the corpus and fails in the field.
//
// The PROPERTY half asserts things a fixture list cannot: that encode never
// writes past its capacity at ANY capacity, that escaping round-trips for every
// byte that needs it, that the decoder resynchronises after arbitrary garbage,
// and that an ON frame without a duration does not exist.
//
// The corpus reaches this file through corpus_generated.h rather than a JSON
// parser: the code under test is written for an 8-bit micro with no heap, and a
// hand-rolled JSON parser's own bugs would show up here as protocol failures.
// The JSON stays the source of truth; see src/iot/court-box/tools/gen_corpus.py.

#include <stdint.h>
#include <string.h>
#include <unity.h>

#include "corpus_generated.h"
#include "protocol/Codec.h"
#include "protocol/Protocol.h"

namespace {

using proto::Court;
using proto::DecodeError;
using proto::Frame;
using proto::Key;
using proto::Link;
using proto::Verb;

// Counts what the corpus runners actually executed. Asserted against
// manifest.json at the end; see the anti-drift rule in
// src/contracts/device-protocol/README.md.
size_t g_encodeExecuted = 0;
size_t g_decodeExecuted = 0;
size_t g_unknownKinds = 0;

/// Byte written into every unused position of an encode buffer, so an encoder
/// that runs past its capacity is caught even without a sanitiser.
constexpr char kPoison = '\x7F';

constexpr size_t kScratch = 512;

/// Build `!<body>*CC<terminator>` with the checksum computed HERE, straight from
/// the spec's words — XOR of every byte between '!' and '*' — rather than by
/// calling the encoder. A hand-written test that pastes a literal checksum
/// drifts silently the moment its body is edited; several in this file did
/// exactly that before this helper existed.
size_t v2Line(const char* body, const char* terminator, char* out) {
  const char* kHex = "0123456789ABCDEF";
  uint8_t cs = 0;
  size_t n = 0;
  out[n++] = '!';
  for (size_t i = 0; body[i] != '\0'; ++i) {
    cs = static_cast<uint8_t>(cs ^ static_cast<uint8_t>(body[i]));
    out[n++] = body[i];
  }
  out[n++] = '*';
  out[n++] = kHex[(cs >> 4) & 0x0F];
  out[n++] = kHex[cs & 0x0F];
  for (size_t i = 0; terminator[i] != '\0'; ++i) {
    out[n++] = terminator[i];
  }
  out[n] = '\0';
  return n;
}

/// Feed a whole NUL-terminated string, draining after every byte, and return
/// how many Results came out. `got` may be null when only the count matters.
size_t feedAll(proto::Decoder& d, const char* bytes, proto::Decoder::Result* got, size_t cap) {
  size_t n = 0;
  for (size_t i = 0; bytes[i] != '\0'; ++i) {
    static_cast<void>(d.feed(bytes[i]));
    proto::Decoder::Result r;
    while (d.pop(r)) {
      if (got != nullptr && n < cap) {
        got[n] = r;
      }
      ++n;
    }
  }
  return n;
}

bool eq(const char* a, const char* b) {
  return a != nullptr && b != nullptr && strcmp(a, b) == 0;
}

uint32_t toU32(const char* s) {
  uint32_t v = 0;
  for (size_t i = 0; s[i] != '\0'; ++i) {
    v = (v * 10U) + static_cast<uint32_t>(s[i] - '0');
  }
  return v;
}

uint16_t toU16(const char* s) {
  return static_cast<uint16_t>(toU32(s));
}

Court courtOf(const char* s) {
  Court c = Court::A;
  TEST_ASSERT_TRUE_MESSAGE(proto::courtFromChar(s[0], c), "corpus court argument is not A-D");
  return c;
}

Key keyOf(const char* s) {
  Key k = Key::CourtA;
  TEST_ASSERT_TRUE_MESSAGE(proto::keyFromChar(s[0], k), "corpus key argument is not A-D or 1-4");
  return k;
}

DecodeError errorOf(const char* name) {
  for (uint8_t i = 0; i <= static_cast<uint8_t>(DecodeError::Overrun); ++i) {
    const DecodeError e = static_cast<DecodeError>(i);
    if (eq(proto::errorName(e), name)) {
      return e;
    }
  }
  TEST_FAIL_MESSAGE("corpus names a decode error this build does not know");
  return DecodeError::None;
}

/// The overlay half of frameFromSpec, split off it rather than grown into it.
///
/// An if-chain over eighteen verbs scores past the complexity gate's limit of
/// 15, and the gate covers this suite. Two functions over nine each is the
/// same table read twice, which is what the gate is asking for.
bool overlayFrameFromSpec(const corpus::FrameSpec& s, Frame& out) {
  const char* v = s.verb;
  if (eq(v, "ROW")) {
    out = Frame::row(static_cast<uint8_t>(toU32(s.args[0])), s.args[1]);
  } else if (eq(v, "SHOW")) {
    out = Frame::show(toU32(s.args[0]), static_cast<uint8_t>(toU32(s.args[1])));
  } else if (eq(v, "IDLE")) {
    out = Frame::idle(static_cast<uint8_t>(toU32(s.args[0])), s.args[1]);
  } else if (eq(v, "MAP")) {
    const int16_t numbers[4] = {
        static_cast<int16_t>(toU32(s.args[0])), static_cast<int16_t>(toU32(s.args[1])),
        static_cast<int16_t>(toU32(s.args[2])), static_cast<int16_t>(toU32(s.args[3]))};
    out = Frame::map(numbers);
  } else {
    return false;
  }
  return true;
}

/// "-" or a number, for the v3 opinion slots of `!WANT` and `!LAND`.
int32_t opinionOf(const char* s) {
  return eq(s, "-") ? proto::kNoOpinion : static_cast<int32_t>(toU32(s));
}

uint16_t hexOf(const char* s) {
  uint16_t v = 0;
  for (size_t i = 0; s[i] != '\0'; ++i) {
    const char c = s[i];
    v = static_cast<uint16_t>((v << 4) | static_cast<uint16_t>(c <= '9' ? c - '0' : c - 'A' + 10));
  }
  return v;
}

/// The v3 downlink verbs, from their named constructors.
bool v3DownFrameFromSpec(const corpus::FrameSpec& s, Frame& out) {
  const char* v = s.verb;
  if (eq(v, "RW")) {
    out = Frame::rw(static_cast<uint8_t>(toU32(s.args[0])), static_cast<uint8_t>(toU32(s.args[1])),
                    static_cast<uint8_t>(toU32(s.args[2])), s.args[3]);
  } else if (eq(v, "CMT")) {
    out = Frame::cmt(static_cast<uint8_t>(toU32(s.args[0])), static_cast<uint8_t>(toU32(s.args[1])),
                     toU32(s.args[2]), static_cast<uint8_t>(toU32(s.args[3])), hexOf(s.args[4]));
  } else if (eq(v, "WANT")) {
    const int32_t secs[4] = {opinionOf(s.args[1]), opinionOf(s.args[2]), opinionOf(s.args[3]), opinionOf(s.args[4])};
    out = Frame::want(static_cast<uint8_t>(toU32(s.args[0])), secs);
  } else if (eq(v, "CFG")) {
    out = Frame::cfg(static_cast<uint8_t>(toU32(s.args[0])), s.args[1], toU16(s.args[2]));
  } else if (eq(v, "LAND")) {
    const int32_t secs[4] = {opinionOf(s.args[0]), opinionOf(s.args[1]), opinionOf(s.args[2]), opinionOf(s.args[3])};
    out = Frame::land(secs);
  } else if (eq(v, "NOTE")) {
    out = Frame::note(toU32(s.args[0]), s.args[1]);
  } else if (eq(v, "LIVE")) {
    out = Frame::live(toU32(s.args[0]));
  } else {
    return false;
  }
  return true;
}

/// The v3 uplink verbs, from their named constructors.
bool v3UpFrameFromSpec(const corpus::FrameSpec& s, Frame& out) {
  const char* v = s.verb;
  if (eq(v, "ACK")) {
    const proto::AckCode code = static_cast<proto::AckCode>(toU32(s.args[1]));
    out = s.args[0][0] == 'S' ? Frame::ackScreen(static_cast<uint8_t>(toU32(s.args[0] + 1)), code)
                              : Frame::ack(static_cast<uint8_t>(toU32(s.args[0])), code);
  } else if (eq(v, "BOOT")) {
    out = Frame::boot(s.args[0], static_cast<uint8_t>(hexOf(s.args[1])), static_cast<uint8_t>(hexOf(s.args[2])));
  } else if (eq(v, "HELD")) {
    out = Frame::held(static_cast<uint8_t>(hexOf(s.args[0])), toU32(s.args[1]));
  } else if (eq(v, "DIAG")) {
    const uint16_t c[5] = {toU16(s.args[0]), toU16(s.args[1]), toU16(s.args[2]), toU16(s.args[3]),
                           toU16(s.args[4])};
    out = Frame::diag(c);
  } else if (eq(v, "HW")) {
    out = Frame::hw(static_cast<uint8_t>(hexOf(s.args[0])), static_cast<uint8_t>(toU32(s.args[1])),
                    static_cast<uint8_t>(toU32(s.args[2])), static_cast<uint8_t>(toU32(s.args[3])),
                    static_cast<uint8_t>(hexOf(s.args[4])));
  } else {
    return v3DownFrameFromSpec(s, out);
  }
  return true;
}

/// The four v2 relay/auth verbs, with v3's optional tag.
bool taggedFrameFromSpec(const corpus::FrameSpec& s, Frame& out) {
  const char* v = s.verb;
  if (eq(v, "ON")) {
    out = Frame::on(courtOf(s.args[0]), toU32(s.args[1]),
                    s.argCount > 2U ? static_cast<uint8_t>(toU32(s.args[2])) : proto::kNoTag);
  } else if (eq(v, "OFF")) {
    out = Frame::off(courtOf(s.args[0]), s.argCount > 1U ? static_cast<uint8_t>(toU32(s.args[1])) : proto::kNoTag);
  } else if (eq(v, "EXT")) {
    out = Frame::ext(courtOf(s.args[0]), toU32(s.args[1]),
                     s.argCount > 2U ? static_cast<uint8_t>(toU32(s.args[2])) : proto::kNoTag);
  } else if (eq(v, "AUTH")) {
    out = Frame::auth(toU16(s.args[0]), s.argCount > 1U ? static_cast<uint8_t>(toU32(s.args[1])) : proto::kNoTag);
  } else {
    return v3UpFrameFromSpec(s, out);
  }
  return true;
}

/// Build a Frame from a corpus FrameSpec using ONLY the named constructors.
///
/// This is what proves the safety rule is not decorative: there is no generic
/// "set verb, set args" path available to a caller, so the corpus cannot ask
/// for an ON frame without a duration even if a case tried to.
bool frameFromSpec(const corpus::FrameSpec& s, Frame& out) {
  const char* v = s.verb;
  if (eq(v, "LCD")) {
    out = Frame::lcd(s.args[0], s.args[1]);
  } else if (eq(v, "RST")) {
    out = Frame::rst();
  } else if (eq(v, "PING")) {
    out = Frame::ping();
  } else if (eq(v, "BTN")) {
    out = Frame::btn(keyOf(s.args[0]));
  } else if (eq(v, "SCAN")) {
    out = Frame::scan(s.args[0]);
  } else if (eq(v, "STATE")) {
    const uint16_t remaining[4] = {toU16(s.args[1]), toU16(s.args[2]), toU16(s.args[3]), toU16(s.args[4])};
    out = Frame::state(static_cast<uint8_t>(toU32(s.args[0])), remaining);
  } else if (eq(v, "PONG")) {
    out = s.argCount >= 5U
              ? Frame::pong(s.args[0], toU32(s.args[1]), toU16(s.args[2]), toU16(s.args[3]), toU16(s.args[4]))
              : Frame::pong(s.args[0], toU32(s.args[1]));
  } else if (eq(v, "EVT")) {
    out = Frame::evt(s.args[0], s.args[1]);
  } else if (eq(v, "ERR")) {
    out = Frame::err(errorOf(s.args[0]));
  } else if (!overlayFrameFromSpec(s, out)) {
    return taggedFrameFromSpec(s, out);
  }
  return true;
}

void assertFrameMatches(const Frame& actual, const corpus::FrameSpec& expected, const char* id) {
  TEST_ASSERT_EQUAL_STRING_MESSAGE(expected.verb, proto::verbName(actual.verb()), id);
  TEST_ASSERT_EQUAL_size_t_MESSAGE(expected.argCount, actual.argCount(), id);
  for (size_t i = 0; i < expected.argCount; ++i) {
    TEST_ASSERT_EQUAL_STRING_MESSAGE(expected.args[i], actual.arg(static_cast<uint8_t>(i)), id);
  }
}

// --- encode corpus ---------------------------------------------------------

void runEncodeCase(const corpus::EncodeCase& c) {
  Frame f;
  TEST_ASSERT_TRUE_MESSAGE(frameFromSpec(c.frame, f), c.id);

  char out[kScratch];
  memset(out, kPoison, sizeof(out));
  const size_t cap = c.cap < sizeof(out) ? c.cap : sizeof(out);

  size_t n = 0;
  if (eq(c.kind, "encode_v2")) {
    n = proto::encode(f, out, cap);
  } else if (eq(c.kind, "encode_legacy")) {
    n = proto::encodeLegacy(f, out, cap);
  } else {
    ++g_unknownKinds;
    return;
  }

  const size_t want = strlen(c.bytes);
  TEST_ASSERT_EQUAL_size_t_MESSAGE(want, n, c.id);
  if (want > 0) {
    TEST_ASSERT_EQUAL_MEMORY_MESSAGE(c.bytes, out, want, c.id);
  }
  for (size_t i = cap; i < sizeof(out); ++i) {
    TEST_ASSERT_EQUAL_MESSAGE(kPoison, out[i], "encoder wrote past its capacity");
  }
  ++g_encodeExecuted;
}

// --- decode corpus ---------------------------------------------------------

/// How the bytes are handed to the decoder. Both modes must give identical
/// results: a decoder whose behaviour depends on where the UART happened to
/// split the stream is broken by definition.
enum class FeedMode {
  DrainEveryByte, ///< Pop after each byte, the way an ISR-driven loop would.
  DrainPerChunk,  ///< Pop only at chunk boundaries, so results queue up.
};

size_t collect(const corpus::DecodeCase& c, FeedMode mode, proto::Decoder::Result* got, size_t cap) {
  proto::Decoder d(eq(c.link, "uplink") ? Link::Uplink : Link::Downlink);
  size_t n = 0;
  for (size_t ci = 0; ci < c.chunkCount; ++ci) {
    const char* chunk = c.chunks[ci];
    for (size_t i = 0; chunk[i] != '\0'; ++i) {
      static_cast<void>(d.feed(chunk[i]));
      if (mode == FeedMode::DrainEveryByte) {
        while (n < cap && d.pop(got[n])) {
          ++n;
        }
      }
    }
    while (n < cap && d.pop(got[n])) {
      ++n;
    }
  }
  TEST_ASSERT_EQUAL_UINT16_MESSAGE(0, d.droppedResults(), c.id);
  TEST_ASSERT_EQUAL_size_t_MESSAGE(0, d.pending(), c.id);
  return n;
}

void runDecodeCase(const corpus::DecodeCase& c, FeedMode mode) {
  proto::Decoder::Result got[8];
  const size_t n = collect(c, mode, got, 8);

  TEST_ASSERT_EQUAL_size_t_MESSAGE(c.expectCount, n, c.id);
  for (size_t i = 0; i < c.expectCount; ++i) {
    const corpus::ExpectSpec& want = c.expect[i];
    if (want.error[0] != '\0') {
      TEST_ASSERT_FALSE_MESSAGE(got[i].isFrame(), c.id);
      TEST_ASSERT_EQUAL_STRING_MESSAGE(want.error, proto::errorName(got[i].error), c.id);
    } else {
      TEST_ASSERT_TRUE_MESSAGE(got[i].isFrame(), c.id);
      assertFrameMatches(got[i].frame, want.frame, c.id);
    }
  }
}

} // namespace

// --- corpus runners --------------------------------------------------------

void test_corpus_encode_cases(void) {
  for (size_t i = 0; i < corpus::kEncodeCaseCount; ++i) {
    runEncodeCase(corpus::kEncodeCases[i]);
  }
}

void test_corpus_decode_cases(void) {
  for (size_t i = 0; i < corpus::kDecodeCaseCount; ++i) {
    const corpus::DecodeCase& c = corpus::kDecodeCases[i];
    if (!eq(c.kind, "decode")) {
      ++g_unknownKinds;
      continue;
    }
    // Both feed modes, because where the UART splits the stream must not matter.
    runDecodeCase(c, FeedMode::DrainEveryByte);
    runDecodeCase(c, FeedMode::DrainPerChunk);
    ++g_decodeExecuted;
  }
}

/// The anti-drift assertion with teeth. A case added to cases.json without a
/// matching bump in manifest.json fails here, and so does a case whose kind
/// this suite silently skipped.
void test_corpus_executed_count_matches_the_manifest(void) {
  TEST_ASSERT_EQUAL_size_t_MESSAGE(0, g_unknownKinds, "a corpus case was skipped as an unknown kind");
  TEST_ASSERT_EQUAL_size_t_MESSAGE(corpus::kDeclaredEncodeCases, g_encodeExecuted,
                                   "executed encode cases != manifest.json case_count.encode");
  TEST_ASSERT_EQUAL_size_t_MESSAGE(corpus::kDeclaredDecodeCases, g_decodeExecuted,
                                   "executed decode cases != manifest.json case_count.decode");
  // Guards the other direction: a case deleted from cases.json without touching
  // the manifest would otherwise make the counts agree at zero.
  TEST_ASSERT_EQUAL_size_t(corpus::kEncodeCaseCount, g_encodeExecuted);
  TEST_ASSERT_EQUAL_size_t(corpus::kDecodeCaseCount, g_decodeExecuted);
}

// --- the safety rule -------------------------------------------------------

// A relay that is closed with no deadline is the single most expensive failure
// this system can have: the legacy `A` message had nowhere to put a duration,
// and the off command lived in a VBA macro on a PC that could sleep.
//
// The type system carries most of this test. `Frame::on(court, seconds)` is the
// only way to obtain an ON frame, and `seconds` is a required parameter, so
// "ON without a duration" is a line that does not compile rather than a bug
// waiting to be found. What is left to assert at runtime is that the WIRE path
// is held to the same rule, and that the clamp never yields zero.
void test_on_always_carries_a_duration(void) {
  TEST_ASSERT_EQUAL_UINT8(2, proto::kVerbSpecs[static_cast<size_t>(Verb::On)].minArgs);
  TEST_ASSERT_EQUAL_INT8(1, proto::kVerbSpecs[static_cast<size_t>(Verb::On)].secondsArg);

  const uint16_t durations[] = {0, 1, 2, 1800, 5399, 5400, 5401, 60000, 65535};
  for (size_t i = 0; i < sizeof(durations) / sizeof(durations[0]); ++i) {
    const Frame f = Frame::on(Court::B, durations[i]);
    TEST_ASSERT_EQUAL_UINT8(2, f.argCount());
    const uint32_t seconds = toU32(f.arg(1));
    TEST_ASSERT_TRUE(seconds >= proto::kRelayMinSeconds);
    TEST_ASSERT_TRUE(seconds <= proto::kRelayHardCapSeconds);
  }
}

/// Every downlink line that could plausibly be read as "turn court A on" and
/// carries no usable duration must either fail, or come back clamped. None of
/// them may produce an unbounded ON.
void test_no_wire_form_produces_an_unbounded_on(void) {
  const char* bodies[] = {"ON,A",      "ON,A,",   "ON,A,0",           "ON,A,-1",
                          "ON,A,SOON", "ON,A,+1", "ON,A,99999999999", "ON,A,5401"};
  for (size_t i = 0; i < sizeof(bodies) / sizeof(bodies[0]); ++i) {
    char line[kScratch];
    static_cast<void>(v2Line(bodies[i], "\n", line));

    proto::Decoder d(Link::Downlink);
    proto::Decoder::Result got[4];
    const size_t n = feedAll(d, line, got, 4);
    for (size_t k = 0; k < n && k < 4; ++k) {
      if (got[k].isFrame() && got[k].frame.verb() == Verb::On) {
        const uint32_t seconds = toU32(got[k].frame.arg(1));
        TEST_ASSERT_TRUE_MESSAGE(seconds >= proto::kRelayMinSeconds, bodies[i]);
        TEST_ASSERT_TRUE_MESSAGE(seconds <= proto::kRelayHardCapSeconds, bodies[i]);
      }
    }
  }

  // The legacy bare `A` is the one form that MUST become an ON, and it gets the
  // hard cap, because the alternative is forever.
  proto::Decoder legacy(Link::Downlink);
  proto::Decoder::Result r;
  TEST_ASSERT_EQUAL_size_t(1, feedAll(legacy, "A\n", &r, 1));
  TEST_ASSERT_TRUE(r.isFrame());
  TEST_ASSERT_EQUAL_UINT32(proto::kRelayHardCapSeconds, toU32(r.frame.arg(1)));
}

/// The screen's half of the safety rule.
///
/// A refusal screen that never leaves the glass, with every button dead behind
/// it, is what GOAL items 11 and 15 are about, and the fix is structural rather
/// than per-screen: EVERY overlay carries a hold, and the hold is clamped by
/// the decoder — out of reach of a bridge, of a future firmware, and of any
/// configuration. So no wire form of `!SHOW` may yield a hold outside the
/// bounds, and in particular none may yield zero.
void test_no_wire_form_produces_a_permanent_screen(void) {
  const char* bodies[] = {"SHOW,0,0",  "SHOW,0,1",     "SHOW,1,0",           "SHOW,120,0",       "SHOW,121,0",
                          "SHOW,-1,0", "SHOW,NEVER,0", "SHOW,99999999999,0", "SHOW,4294967295,0"};
  bool sawFrame = false;
  for (size_t i = 0; i < sizeof(bodies) / sizeof(bodies[0]); ++i) {
    char line[kScratch];
    static_cast<void>(v2Line(bodies[i], "\n", line));

    proto::Decoder d(Link::Downlink);
    proto::Decoder::Result got[4];
    const size_t n = feedAll(d, line, got, 4);
    for (size_t k = 0; k < n && k < 4; ++k) {
      if (got[k].isFrame() && got[k].frame.verb() == Verb::Show) {
        sawFrame = true;
        const uint32_t seconds = toU32(got[k].frame.arg(0));
        TEST_ASSERT_TRUE_MESSAGE(seconds >= proto::kShowHoldMinSeconds, bodies[i]);
        TEST_ASSERT_TRUE_MESSAGE(seconds <= proto::kShowHoldMaxSeconds, bodies[i]);
      }
    }
  }
  TEST_ASSERT_TRUE_MESSAGE(sawFrame, "no SHOW body decoded at all — the clamp was never exercised");

  // And the factory, which is the path the bridge actually takes.
  const uint32_t asked[] = {0U, 1U, 119U, 120U, 121U, 5400U, 0xFFFFFFFFU};
  for (size_t i = 0; i < sizeof(asked) / sizeof(asked[0]); ++i) {
    const uint32_t held = toU32(Frame::show(asked[i], 0U).arg(0));
    TEST_ASSERT_TRUE(held >= proto::kShowHoldMinSeconds);
    TEST_ASSERT_TRUE(held <= proto::kShowHoldMaxSeconds);
  }
}

/// A row index is an index, not a quantity: it is refused, never clamped.
///
/// Clamping it would write the text onto the last row the panel has, which
/// looks like a working screen and hides a peer that disagrees with this one
/// about how many rows exist.
void test_row_refuses_a_row_the_protocol_does_not_have(void) {
  for (uint8_t r = 0U; r < proto::kMaxRows; ++r) {
    const Frame f = Frame::row(r, "X");
    TEST_ASSERT_FALSE(f.empty());
    TEST_ASSERT_EQUAL_UINT32(r, toU32(f.arg(0)));
  }
  TEST_ASSERT_TRUE(Frame::row(proto::kMaxRows, "X").empty());
  TEST_ASSERT_TRUE(Frame::row(255U, "X").empty());

  const char* bodies[] = {"ROW,4,X", "ROW,9,X", "ROW,-1,X", "ROW,TOP,X", "ROW,99999999999,X"};
  for (size_t i = 0; i < sizeof(bodies) / sizeof(bodies[0]); ++i) {
    char line[kScratch];
    static_cast<void>(v2Line(bodies[i], "\n", line));

    proto::Decoder d(Link::Downlink);
    proto::Decoder::Result got[4];
    const size_t n = feedAll(d, line, got, 4);
    TEST_ASSERT_EQUAL_size_t_MESSAGE(1, n, bodies[i]);
    TEST_ASSERT_FALSE_MESSAGE(got[0].isFrame(), bodies[i]);
    TEST_ASSERT_EQUAL_MESSAGE(DecodeError::BadArg, got[0].error, bodies[i]);
  }
}

// --- encoder properties ----------------------------------------------------

/// The checksum, recomputed here from the spec's words rather than from the
/// codec's code: XOR of every byte between '!' and '*', exclusive.
void test_checksum_is_the_xor_between_bang_and_star(void) {
  const uint16_t remaining[4] = {1800, 0, 0, 120};
  const Frame frames[] = {Frame::on(Court::A, 1800), Frame::lcd("SMITH, J", "50% LEFT"),
                          Frame::state(5, remaining), Frame::rst()};

  for (size_t i = 0; i < sizeof(frames) / sizeof(frames[0]); ++i) {
    char out[kScratch];
    const size_t n = proto::encode(frames[i], out, sizeof(out));
    TEST_ASSERT_TRUE(n >= 6);
    TEST_ASSERT_EQUAL_CHAR('!', out[0]);
    TEST_ASSERT_EQUAL_CHAR('*', out[n - 4]);
    TEST_ASSERT_EQUAL_CHAR('\n', out[n - 1]);

    uint8_t xorAcc = 0;
    for (size_t k = 1; k < n - 4; ++k) {
      xorAcc = static_cast<uint8_t>(xorAcc ^ static_cast<uint8_t>(out[k]));
    }
    char want[3];
    const char* kHex = "0123456789ABCDEF";
    want[0] = kHex[(xorAcc >> 4) & 0x0F];
    want[1] = kHex[xorAcc & 0x0F];
    want[2] = '\0';
    TEST_ASSERT_EQUAL_MEMORY(want, out + n - 3, 2);
  }
}

/// At every capacity below the exact length, encode must emit NOTHING. A
/// truncated relay command is worse than a missing one, so there is no
/// "partial frame" outcome at any capacity.
void test_encode_is_all_or_nothing_at_every_capacity(void) {
  const Frame f = Frame::on(Court::C, 1800);
  char reference[kScratch];
  const size_t full = proto::encode(f, reference, sizeof(reference));
  TEST_ASSERT_TRUE(full > 0);

  for (size_t cap = 0; cap < full; ++cap) {
    char out[kScratch];
    memset(out, kPoison, sizeof(out));
    TEST_ASSERT_EQUAL_size_t(0, proto::encode(f, out, cap));
    for (size_t i = cap; i < sizeof(out); ++i) {
      TEST_ASSERT_EQUAL_CHAR(kPoison, out[i]);
    }
  }

  char exact[kScratch];
  memset(exact, kPoison, sizeof(exact));
  TEST_ASSERT_EQUAL_size_t(full, proto::encode(f, exact, full));
  TEST_ASSERT_EQUAL_MEMORY(reference, exact, full);
}

void test_encode_of_an_empty_frame_writes_nothing(void) {
  char out[kScratch];
  memset(out, kPoison, sizeof(out));
  TEST_ASSERT_EQUAL_size_t(0, proto::encode(Frame(), out, sizeof(out)));
  TEST_ASSERT_EQUAL_size_t(0, proto::encodeLegacy(Frame(), out, sizeof(out)));
  TEST_ASSERT_EQUAL_CHAR(kPoison, out[0]);
}

/// A scanner code that does not fit is refused rather than shortened: a
/// truncated code is a valid-looking code belonging to somebody else.
void test_scan_refuses_an_oversized_code(void) {
  char tooLong[proto::kMaxArgLen + 2];
  memset(tooLong, '9', sizeof(tooLong) - 1);
  tooLong[sizeof(tooLong) - 1] = '\0';
  TEST_ASSERT_TRUE(Frame::scan(tooLong).empty());

  char exact[proto::kMaxArgLen + 1];
  memset(exact, '9', sizeof(exact) - 1);
  exact[sizeof(exact) - 1] = '\0';
  TEST_ASSERT_FALSE(Frame::scan(exact).empty());
}

// --- round-trip ------------------------------------------------------------

/// Every v2 encode case in the corpus must decode back to the frame it came
/// from. Encoding and decoding are separate code paths, so this catches an
/// escape that only one of them implements.
void test_every_encoded_frame_round_trips(void) {
  for (size_t i = 0; i < corpus::kEncodeCaseCount; ++i) {
    const corpus::EncodeCase& c = corpus::kEncodeCases[i];
    if (!eq(c.kind, "encode_v2") || c.bytes[0] == '\0') {
      continue;
    }
    Frame original;
    TEST_ASSERT_TRUE_MESSAGE(frameFromSpec(c.frame, original), c.id);

    char wire[kScratch];
    const size_t n = proto::encode(original, wire, sizeof(wire));
    TEST_ASSERT_TRUE_MESSAGE(n > 0, c.id);

    // Decoded on the link the verb travels: v3 made direction part of the
    // grammar, so an uplink-only verb is refused on the downlink.
    const proto::Dir dir = proto::specOf(original.verb()).dir;
    proto::Decoder d(dir == proto::Dir::Up ? Link::Uplink : Link::Downlink);
    proto::Decoder::Result r;
    size_t results = 0;
    for (size_t k = 0; k < n; ++k) {
      static_cast<void>(d.feed(wire[k]));
      while (d.pop(r)) {
        ++results;
        TEST_ASSERT_TRUE_MESSAGE(r.isFrame(), c.id);
        TEST_ASSERT_TRUE_MESSAGE(original == r.frame, c.id);
      }
    }
    TEST_ASSERT_EQUAL_size_t_MESSAGE(1, results, c.id);
  }
}

/// Escaping is exact, not approximate. Every byte that needs escaping, in every
/// position, including strings that are nothing but escapes.
void test_escaping_round_trips_exactly(void) {
  const char* texts[] = {
      "",       ",",        "%",     ",,",     "%%",       ",%",      "%,",       "%2C",
      "%25",    "a,b",      "a%b",   "100%",   ",leading", "trail,",  "SMITH, J", "50% OFF, TODAY",
      ",,,,,,", "%%%%%%%%", "A%2CB", "%%2C%%", "!*\\|",    "1,2,3,4",
  };
  for (size_t i = 0; i < sizeof(texts) / sizeof(texts[0]); ++i) {
    const Frame original = Frame::lcd(texts[i], "X");
    char wire[kScratch];
    const size_t n = proto::encode(original, wire, sizeof(wire));
    TEST_ASSERT_TRUE(n > 0);

    proto::Decoder d(Link::Downlink);
    proto::Decoder::Result r;
    for (size_t k = 0; k < n; ++k) {
      static_cast<void>(d.feed(wire[k]));
    }
    TEST_ASSERT_TRUE(d.pop(r));
    TEST_ASSERT_TRUE(r.isFrame());
    TEST_ASSERT_EQUAL_STRING(texts[i], r.frame.arg(0));
    TEST_ASSERT_EQUAL_STRING("X", r.frame.arg(1));
    TEST_ASSERT_FALSE(d.pop(r));
  }
}

/// A '%' that is not one of the two defined escapes is refused, never kept.
/// Silently keeping it would break the round-trip above, and neither end of
/// this link can discover such a disagreement except by a relay firing on the
/// wrong court.
void test_malformed_escapes_are_refused(void) {
  const char* bodies[] = {"LCD,%,B",  "LCD,%2,B",  "LCD,%2X,B", "LCD,%%,B",
                          "LCD,A%,B", "LCD,%2c,B", "LCD,%GG,B", "LCD,A,%1F"};
  for (size_t i = 0; i < sizeof(bodies) / sizeof(bodies[0]); ++i) {
    char line[kScratch];
    static_cast<void>(v2Line(bodies[i], "\n", line));

    proto::Decoder d(Link::Downlink);
    proto::Decoder::Result r;
    TEST_ASSERT_EQUAL_size_t_MESSAGE(1, feedAll(d, line, &r, 1), bodies[i]);
    TEST_ASSERT_FALSE_MESSAGE(r.isFrame(), bodies[i]);
    TEST_ASSERT_EQUAL_STRING_MESSAGE("BADARG", proto::errorName(r.error), bodies[i]);
  }
}

// --- decoder robustness ----------------------------------------------------

/// Every single-bit corruption of the checksum field, and of the body, must be
/// caught. This is not hypothetical: 9600 baud over jumper wires next to four
/// switching relay coils is exactly where a bit gets flipped, and a corrupted
/// `a` arriving as `A` turns lights on and leaves them on.
void test_single_bit_corruption_of_the_body_is_caught(void) {
  const Frame f = Frame::on(Court::A, 1800);
  char wire[kScratch];
  const size_t n = proto::encode(f, wire, sizeof(wire));

  size_t caught = 0;
  size_t attempted = 0;
  for (size_t pos = 1; pos < n - 1; ++pos) { // Skip '!' and the terminator.
    for (int bit = 0; bit < 7; ++bit) {      // 7 bits: the wire is ASCII.
      char corrupted[kScratch];
      memcpy(corrupted, wire, n);
      corrupted[pos] = static_cast<char>(corrupted[pos] ^ (1 << bit));
      if (memcmp(corrupted, wire, n) == 0) {
        continue;
      }
      ++attempted;

      proto::Decoder d(Link::Downlink);
      proto::Decoder::Result r;
      for (size_t k = 0; k < n; ++k) {
        static_cast<void>(d.feed(corrupted[k]));
      }
      bool acceptedIdentical = false;
      while (d.pop(r)) {
        if (r.isFrame() && r.frame == f) {
          acceptedIdentical = true;
        }
      }
      if (!acceptedIdentical) {
        ++caught;
      }
    }
  }
  TEST_ASSERT_TRUE(attempted > 50);
  TEST_ASSERT_EQUAL_size_t_MESSAGE(attempted, caught,
                                   "a single-bit corruption decoded to the original frame");
}

void test_crlf_is_one_terminator_not_two(void) {
  char stream[kScratch];
  size_t n = v2Line("RST", "\r\n", stream);
  n += v2Line("PING", "\r\n", stream + n);
  TEST_ASSERT_TRUE(n > 0);

  proto::Decoder d(Link::Downlink);
  proto::Decoder::Result got[4];
  TEST_ASSERT_EQUAL_size_t(2, feedAll(d, stream, got, 4));
  TEST_ASSERT_TRUE(got[0].isFrame());
  TEST_ASSERT_EQUAL_STRING("RST", proto::verbName(got[0].frame.verb()));
  TEST_ASSERT_TRUE(got[1].isFrame());
  TEST_ASSERT_EQUAL_STRING("PING", proto::verbName(got[1].frame.verb()));
}

/// An over-long line is reported and DISCARDED. It is never parsed from the
/// buffered prefix: `!ON,A,999...` truncated at the buffer edge still looks
/// like a valid relay command, and acting on it is the half-understood command
/// the checksum exists to prevent.
void test_overrun_is_reported_and_never_yields_a_frame(void) {
  proto::Decoder d(Link::Downlink);
  proto::Decoder::Result r;

  // The prefix is a valid-looking relay command, deliberately: this is the
  // truncation that must NOT be acted on.
  const char* head = "!ON,A,1800";
  for (const char* p = head; *p != '\0'; ++p) {
    static_cast<void>(d.feed(*p));
  }
  for (size_t i = 0; i < proto::kMaxFrameLen * 3; ++i) {
    static_cast<void>(d.feed('9'));
    TEST_ASSERT_EQUAL_size_t(0, d.pending());
  }
  static_cast<void>(d.feed('\n'));
  TEST_ASSERT_TRUE(d.pop(r));
  TEST_ASSERT_FALSE(r.isFrame());
  TEST_ASSERT_EQUAL_STRING("OVERRUN", proto::errorName(r.error));
  TEST_ASSERT_FALSE(d.pop(r));

  // Resynchronised: the very next frame decodes cleanly.
  char good[kScratch];
  static_cast<void>(v2Line("OFF,B", "\n", good));
  TEST_ASSERT_EQUAL_size_t(1, feedAll(d, good, &r, 1));
  TEST_ASSERT_TRUE(r.isFrame());
  TEST_ASSERT_EQUAL_STRING("OFF", proto::verbName(r.frame.verb()));
  TEST_ASSERT_EQUAL_STRING("B", r.frame.arg(0));
}

/// Garbage in the stream must cost exactly the frames it corrupted and no more.
/// The decoder is fed a long alternating stream and has to produce every good
/// frame in it.
void test_decoder_recovers_from_arbitrary_garbage(void) {
  const char* junk[] = {"",           "\n",
                        "\r\n",       "xyzzy\n",
                        "!!!!\n",     "!ON,A,1800*00\n",
                        "\r",         "%%%%\n",
                        "!ZZ,1*7A\n", "                    \n"};

  char good[kScratch];
  static_cast<void>(v2Line("PING", "\n", good));

  proto::Decoder d(Link::Downlink);
  proto::Decoder::Result r;
  size_t recovered = 0;
  for (size_t i = 0; i < sizeof(junk) / sizeof(junk[0]); ++i) {
    proto::Decoder::Result noise[4];
    const size_t errors = feedAll(d, junk[i], noise, 4);
    for (size_t k = 0; k < errors && k < 4; ++k) {
      TEST_ASSERT_FALSE_MESSAGE(noise[k].isFrame(), junk[i]);
    }

    TEST_ASSERT_EQUAL_size_t_MESSAGE(1, feedAll(d, good, &r, 1), junk[i]);
    TEST_ASSERT_TRUE(r.isFrame());
    TEST_ASSERT_EQUAL_STRING("PING", proto::verbName(r.frame.verb()));
    ++recovered;
  }
  TEST_ASSERT_EQUAL_size_t(sizeof(junk) / sizeof(junk[0]), recovered);
  TEST_ASSERT_EQUAL_UINT16(0, d.droppedResults());
}

/// A byte lost mid-frame costs that one frame and no more.
///
/// This is the correctness property the ESP8266's enlarged receive ring rests
/// on. The ring is a mitigation — it holds the frames that arrive during a
/// blocking HTTP call — but a call that overruns it still drops bytes, and the
/// question is whether a dropped byte corrupts a cascade or just the one frame it
/// fell out of. It is the latter: the damaged frame fails its checksum and is
/// discarded, and the next intact frame decodes. `!EVT,AUTOOFF` — the one event
/// the ESP must not miss — is short, so it is either whole or gone, never merged
/// into whatever follows.
void test_a_byte_lost_mid_frame_costs_only_that_frame(void) {
  char damaged[kScratch];
  char intact[kScratch];
  static_cast<void>(v2Line("EVT,AUTOOFF,A", "\n", damaged));
  static_cast<void>(v2Line("SCAN,MEM-0042", "\n", intact));

  // Drop a byte from the middle of the first frame's body — an overflow ate it.
  // The checksum no longer matches, so the frame is not acted on.
  const size_t drop = 6;
  char stream[kScratch];
  size_t n = 0;
  for (size_t i = 0; damaged[i] != '\0'; ++i) {
    if (i == drop) {
      continue;
    }
    stream[n++] = damaged[i];
  }
  for (size_t i = 0; intact[i] != '\0'; ++i) {
    stream[n++] = intact[i];
  }
  stream[n] = '\0';

  proto::Decoder d(Link::Uplink);
  proto::Decoder::Result got[4];
  const size_t results = feedAll(d, stream, got, 4);

  // The intact SCAN frame is recovered — that is the point.
  bool sawScan = false;
  bool sawBadAutoOff = false;
  for (size_t i = 0; i < results && i < 4; ++i) {
    if (got[i].isFrame() && strcmp(proto::verbName(got[i].frame.verb()), "SCAN") == 0) {
      sawScan = true;
    }
    // The damaged AUTOOFF must NOT surface as a valid frame.
    if (got[i].isFrame() && got[i].frame.argCount() >= 1 && strcmp(got[i].frame.arg(0), "AUTOOFF") == 0) {
      sawBadAutoOff = true;
    }
  }
  TEST_ASSERT_TRUE_MESSAGE(sawScan, "the frame after a mid-frame byte drop was not recovered");
  TEST_ASSERT_FALSE_MESSAGE(sawBadAutoOff, "a checksum-damaged frame was acted on");
}

void test_reset_discards_a_partial_line(void) {
  char whole[kScratch];
  const size_t n = v2Line("ON,A,1800", "\n", whole);
  const size_t split = 8;

  proto::Decoder d(Link::Downlink);
  for (size_t i = 0; i < split; ++i) {
    static_cast<void>(d.feed(whole[i]));
  }
  d.reset();

  proto::Decoder::Result r;
  size_t results = 0;
  for (size_t i = split; i < n; ++i) {
    static_cast<void>(d.feed(whole[i]));
    while (d.pop(r)) {
      ++results;
    }
  }
  TEST_ASSERT_EQUAL_size_t(1, results);
  TEST_ASSERT_FALSE_MESSAGE(r.isFrame(), "reset() must not leave half a frame behind");
}

/// Results are dropped, and COUNTED, when the caller ignores the drain
/// contract. Counted, because a bridge that is quietly losing button presses
/// should be able to say so rather than looking idle.
void test_undrained_results_are_dropped_and_counted(void) {
  char stream[kScratch];
  size_t n = 0;
  for (size_t i = 0; i < 4; ++i) {
    n += v2Line("PING", "\n", stream + n);
  }

  proto::Decoder d(Link::Downlink);
  for (size_t i = 0; i < n; ++i) {
    static_cast<void>(d.feed(stream[i]));
  }
  TEST_ASSERT_EQUAL_size_t(2, d.pending());
  TEST_ASSERT_EQUAL_UINT16(2, d.droppedResults());
}

// --- legacy ----------------------------------------------------------------

/// The uplink/downlink collision, asserted from both sides. `A` is "relay A on"
/// going down and "button A pressed" going up. The spec preserves this rather
/// than fixing it, because each end only ever reads one direction.
void test_legacy_direction_collision_is_preserved(void) {
  proto::Decoder down(Link::Downlink);
  proto::Decoder up(Link::Uplink);
  proto::Decoder::Result r;

  static_cast<void>(down.feed('A'));
  static_cast<void>(down.feed('\n'));
  TEST_ASSERT_TRUE(down.pop(r));
  TEST_ASSERT_TRUE(r.isFrame());
  TEST_ASSERT_EQUAL_STRING("ON", proto::verbName(r.frame.verb()));
  TEST_ASSERT_EQUAL_STRING("A", r.frame.arg(0));
  TEST_ASSERT_EQUAL_STRING("5400", r.frame.arg(1));

  static_cast<void>(up.feed('A'));
  static_cast<void>(up.feed('\n'));
  TEST_ASSERT_TRUE(up.pop(r));
  TEST_ASSERT_TRUE(r.isFrame());
  TEST_ASSERT_EQUAL_STRING("BTN", proto::verbName(r.frame.verb()));
  TEST_ASSERT_EQUAL_STRING("A", r.frame.arg(0));
}

void test_legacy_representability_matches_the_verb_table(void) {
  const uint16_t remaining[4] = {0, 0, 0, 0};
  TEST_ASSERT_TRUE(proto::isLegacyRepresentable(Frame::on(Court::A, 60)));
  TEST_ASSERT_TRUE(proto::isLegacyRepresentable(Frame::off(Court::A)));
  TEST_ASSERT_TRUE(proto::isLegacyRepresentable(Frame::rst()));
  TEST_ASSERT_TRUE(proto::isLegacyRepresentable(Frame::lcd("A", "B")));
  TEST_ASSERT_TRUE(proto::isLegacyRepresentable(Frame::btn(Key::Slot2)));
  TEST_ASSERT_TRUE(proto::isLegacyRepresentable(Frame::scan("1")));

  // Everything v2 ADDS has no legacy spelling, which is the point of adding it.
  TEST_ASSERT_FALSE(proto::isLegacyRepresentable(Frame()));
  TEST_ASSERT_FALSE(proto::isLegacyRepresentable(Frame::ext(Court::A, 60)));
  TEST_ASSERT_FALSE(proto::isLegacyRepresentable(Frame::auth(30)));
  TEST_ASSERT_FALSE(proto::isLegacyRepresentable(Frame::ping()));
  TEST_ASSERT_FALSE(proto::isLegacyRepresentable(Frame::state(0, remaining)));
  TEST_ASSERT_FALSE(proto::isLegacyRepresentable(Frame::pong("1", 1)));
  TEST_ASSERT_FALSE(proto::isLegacyRepresentable(Frame::evt("A", "B")));
  TEST_ASSERT_FALSE(proto::isLegacyRepresentable(Frame::err(DecodeError::BadArg)));
}

/// Legacy out, legacy in: what encodeLegacy emits for a peer must be what the
/// decoder makes of the same bytes coming back the other way.
void test_legacy_encoding_round_trips_through_the_decoder(void) {
  const Frame downlink[] = {Frame::on(Court::A, 1800), Frame::on(Court::D, 60), Frame::off(Court::B),
                            Frame::rst(), Frame::lcd("ENTER CODE", "COURT A")};
  for (size_t i = 0; i < sizeof(downlink) / sizeof(downlink[0]); ++i) {
    char wire[kScratch];
    const size_t n = proto::encodeLegacy(downlink[i], wire, sizeof(wire));
    TEST_ASSERT_TRUE(n > 0);

    proto::Decoder d(Link::Downlink);
    proto::Decoder::Result r;
    for (size_t k = 0; k < n; ++k) {
      static_cast<void>(d.feed(wire[k]));
    }
    TEST_ASSERT_TRUE(d.pop(r));
    TEST_ASSERT_TRUE(r.isFrame());
    TEST_ASSERT_EQUAL_STRING(proto::verbName(downlink[i].verb()), proto::verbName(r.frame.verb()));
    TEST_ASSERT_EQUAL_STRING(downlink[i].arg(0), r.frame.arg(0));
  }

  const Frame uplink[] = {Frame::btn(Key::CourtC), Frame::btn(Key::Slot4), Frame::scan("045A2F19B4")};
  for (size_t i = 0; i < sizeof(uplink) / sizeof(uplink[0]); ++i) {
    char wire[kScratch];
    const size_t n = proto::encodeLegacy(uplink[i], wire, sizeof(wire));
    TEST_ASSERT_TRUE(n > 0);

    proto::Decoder d(Link::Uplink);
    proto::Decoder::Result r;
    for (size_t k = 0; k < n; ++k) {
      static_cast<void>(d.feed(wire[k]));
    }
    TEST_ASSERT_TRUE(d.pop(r));
    TEST_ASSERT_TRUE(r.isFrame());
    TEST_ASSERT_TRUE(uplink[i] == r.frame);
  }
}

/// The legacy on has no duration, so it decodes to the hard cap: 90 minutes of
/// wrong is recoverable, seven weeks of lights is not.
void test_legacy_on_gets_the_hard_cap(void) {
  const char courts[] = {'A', 'B', 'C', 'D'};
  for (size_t i = 0; i < sizeof(courts); ++i) {
    proto::Decoder d(Link::Downlink);
    proto::Decoder::Result r;
    static_cast<void>(d.feed(courts[i]));
    static_cast<void>(d.feed('\n'));
    TEST_ASSERT_TRUE(d.pop(r));
    TEST_ASSERT_TRUE(r.isFrame());
    TEST_ASSERT_EQUAL_UINT32(proto::kRelayHardCapSeconds, toU32(r.frame.arg(1)));
  }
}

// --- runner ----------------------------------------------------------------

void setUp(void) {
}

void tearDown(void) {
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_corpus_encode_cases);
  RUN_TEST(test_corpus_decode_cases);
  RUN_TEST(test_corpus_executed_count_matches_the_manifest);
  RUN_TEST(test_on_always_carries_a_duration);
  RUN_TEST(test_no_wire_form_produces_an_unbounded_on);
  RUN_TEST(test_no_wire_form_produces_a_permanent_screen);
  RUN_TEST(test_row_refuses_a_row_the_protocol_does_not_have);
  RUN_TEST(test_checksum_is_the_xor_between_bang_and_star);
  RUN_TEST(test_encode_is_all_or_nothing_at_every_capacity);
  RUN_TEST(test_encode_of_an_empty_frame_writes_nothing);
  RUN_TEST(test_scan_refuses_an_oversized_code);
  RUN_TEST(test_every_encoded_frame_round_trips);
  RUN_TEST(test_escaping_round_trips_exactly);
  RUN_TEST(test_malformed_escapes_are_refused);
  RUN_TEST(test_single_bit_corruption_of_the_body_is_caught);
  RUN_TEST(test_crlf_is_one_terminator_not_two);
  RUN_TEST(test_overrun_is_reported_and_never_yields_a_frame);
  RUN_TEST(test_decoder_recovers_from_arbitrary_garbage);
  RUN_TEST(test_a_byte_lost_mid_frame_costs_only_that_frame);
  RUN_TEST(test_reset_discards_a_partial_line);
  RUN_TEST(test_undrained_results_are_dropped_and_counted);
  RUN_TEST(test_legacy_direction_collision_is_preserved);
  RUN_TEST(test_legacy_representability_matches_the_verb_table);
  RUN_TEST(test_legacy_encoding_round_trips_through_the_decoder);
  RUN_TEST(test_legacy_on_gets_the_hard_cap);
  return UNITY_END();
}

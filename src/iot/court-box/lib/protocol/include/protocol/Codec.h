// Crusaders Mainframe — court box serial protocol, wire codec.
//
// Encoding is one call. Decoding is a byte-at-a-time state machine, because
// that is how a UART delivers: an ISR or a `while (Serial3.available())` loop
// hands over whatever arrived, which may be half a frame, two frames, or a
// frame split across two passes of loop().
//
// The decoder is required to survive, and is tested against, all of:
//   * bytes arriving one at a time, and a partial frame followed by the rest;
//   * `\r\n` counted as ONE terminator, not two empty frames;
//   * a line longer than the buffer: report OVERRUN, resynchronise at the next
//     terminator, and never emit a frame assembled from a truncated line;
//   * garbage between frames;
//   * a bad checksum, which yields BADCRC and drops the frame — a half
//     understood relay command is worse than a missing one.
//
// No Arduino headers, no heap.

#ifndef CRUSADERS_CODEC_H
#define CRUSADERS_CODEC_H

#include <stddef.h>
#include <stdint.h>

#include "protocol/Protocol.h"

namespace proto {

/// Which side of the link the bytes are travelling.
///
/// v2 frames are self-describing and do not need this. Legacy ones do: a bare
/// `A` means "relay A on" coming down and "button A pressed" going up. The spec
/// preserves that collision rather than fixing it, because it is unambiguous in
/// practice — each end only ever reads one direction — and changing it would
/// break the compatibility the legacy table exists to provide.
enum class Link : uint8_t {
  Downlink, ///< Bridge -> Mega. Decoded by the Mega.
  Uplink,   ///< Mega -> bridge. Decoded by the bridge.
};

/// Whether a decoder honours Carl's unchecksummed legacy dialect at all.
///
/// The production Mega REFUSES it. The legacy downlink is the one path by which
/// a relay closes without a checksummed command — a lone `A` between two
/// terminators is `!ON,A,5400` — and the wire it listens on receives the
/// ESP8266's 74880-baud boot banner at every ESP reset, beside four relay
/// coils. The serial spec names exactly that corruption as the defect v2
/// exists to fix. The dialect stays in the codec, tested against the corpus,
/// for the simulator and the bench (a v2 Mega paired with the original bridge);
/// the composition root of a real box does not opt in.
enum class LegacyDialect : uint8_t {
  /// Lines without the `!` sentinel are parsed as Carl's dialect.
  Accept,
  /// Lines without the `!` sentinel are reported as BADFRAME, whatever they say.
  Refuse,
};

/// Encode a frame as `!VERB,arg1,arg2*CC\n`.
///
/// Returns the number of bytes written, or 0 if the frame would not fit in
/// `cap` or is empty. On 0 NOTHING may be transmitted: the contents of `out`
/// are unspecified, and this function never produces a partial frame. A
/// truncated relay command is worse than no command at all.
///
/// `out` need never exceed kMaxFrameLen for any frame the named constructors
/// can produce.
size_t encode(const Frame& f, char* out, size_t cap);

/// Encode a frame in Carl's legacy dialect, for a peer that has not been
/// updated. Returns bytes written, or 0 if it does not fit OR the verb has no
/// legacy spelling (EXT, AUTH, PING, PONG, STATE, EVT, ERR — the things v2 adds).
///
/// The duration on an ON frame is LOST here, because the legacy message has
/// nowhere to put it. That is not a bug in this function, it is the defect v2
/// exists to fix, and it is why the Mega's own auto-off timer is independent of
/// anything the bridge says.
size_t encodeLegacy(const Frame& f, char* out, size_t cap);

/// True when `f` has a legacy spelling at all.
bool isLegacyRepresentable(const Frame& f);

/// Streaming line decoder. Fed one byte at a time; emits Results.
class Decoder {
public:
  /// A decoded frame, or the reason a line failed to become one.
  struct Result {
    DecodeError error = DecodeError::None;
    Frame frame;

    bool isFrame() const { return error == DecodeError::None; }
  };

  /// `legacy` defaults to Accept so every existing caller and corpus test keeps
  /// its meaning; the production Mega passes Refuse explicitly (see CourtBox).
  explicit Decoder(Link link, LegacyDialect legacy = LegacyDialect::Accept);

  /// Feed one byte. Returns true when at least one Result became available.
  ///
  /// PRECONDITION: drain with pop() until it returns false before feeding more.
  /// One line can yield two Results — a legacy `<line1>|<line2>` is an LCD frame
  /// AND the AUTH window it implies — so the queue holds two. A caller that
  /// ignores the precondition loses Results rather than corrupting them, and
  /// droppedResults() counts what it lost.
  bool feed(char c);

  /// Pop the oldest pending Result. False when the queue is empty.
  bool pop(Result& out);

  size_t pending() const { return count_; }

  /// Results discarded because the caller did not drain the queue.
  uint16_t droppedResults() const { return dropped_; }

  /// Abandon any partial line and any pending Results. Use after a link reset;
  /// there is no way to know where a half-received line was going.
  void reset();

private:
  /// Two: the legacy two-line prompt is the only line that expands to more than
  /// one Result, and it expands to exactly two.
  static constexpr size_t kQueueCap = 2;

  bool endLine();
  bool parseLine(const char* line, size_t n);
  bool parseV2(const char* line, size_t n);
  bool parseLegacy(const char* line, size_t n);
  bool parseLegacyDownlink(const char* line, size_t n);
  bool parseLegacyUplink(const char* line, size_t n);

  static DecodeError splitBody(const char* body, size_t n, Arg* fields, uint8_t& count);
  static DecodeError buildFrame(Link link, Arg* fields, uint8_t count, Frame& out);
  /// The v2-grammar tail of buildFrame: the court and duration, validated and
  /// clamped, then the frame (ON through its own constructor).
  static DecodeError buildV2Frame(Verb v, const VerbSpec& spec, Arg* args, uint8_t argc, Frame& out);

  bool push(const Result& r);
  bool pushFrame(const Frame& f);
  bool pushError(DecodeError e);

  Link link_;
  LegacyDialect legacy_;
  char line_[kMaxFrameLen];
  uint16_t len_;
  bool overrun_;
  bool lastWasCr_;
  Result queue_[kQueueCap];
  uint8_t head_;
  uint8_t count_;
  uint16_t dropped_;
};

} // namespace proto

#endif // CRUSADERS_CODEC_H

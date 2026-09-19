// Crusaders Mainframe — turning scanner bytes into one token, or into nothing.
//
// WHAT ARRIVES
// ------------
// A serial barcode module on Serial2 at 9600 8N1. It emits the decoded payload
// followed by \r, \n or \r\n, on its own schedule, whenever somebody presents a
// phone — and it repeats while the phone is held there. 9600 baud over jumper
// wire beside a switching relay coil produces truncated payloads, split lines
// and dropped terminators in normal service, not just in theory.
//
// THE RULES, FROM THE CONTRACT
// ----------------------------
//   * bytes accumulate until CR or LF; CRLF is one terminator, not two
//   * the line is trimmed of leading and trailing whitespace
//   * an empty line is ignored entirely — no decision, no LED, no event
//   * a line longer than the token cap is REFUSED, never truncated, and the
//     rest of that line is discarded
//   * a non-printable byte discards the whole line
//
// WHY REFUSE RATHER THAN TRUNCATE
// -------------------------------
// The same rule as roster::Entry's: a token cut short is a DIFFERENT token, and
// a different token can match a different member. Twenty-one characters
// truncated to twenty is not "nearly right", it is somebody else's booking.
//
// WHY A NON-PRINTABLE BYTE COSTS THE LINE
// ---------------------------------------
// It is the signature of the noise this cable actually produces. A framing
// error inserts a byte nobody typed; carrying on with the rest of the line
// would present the server with a token that is neither what was scanned nor
// anything it can recognise, and would spend an API call doing it.
//
// No Arduino headers, no heap, no String. Compiles for Xtensa and the host.

#ifndef CRUSADERS_GATELOGIC_SCANASSEMBLER_H
#define CRUSADERS_GATELOGIC_SCANASSEMBLER_H

#include <stddef.h>
#include <stdint.h>

#include "roster/Roster.h"

namespace gatelogic {

/// What one byte produced.
enum class ScanEvent : uint8_t {
  /// Nothing yet, or a line that was discarded without a decision: empty, or
  /// corrupted by a non-printable byte.
  None = 0U,
  /// A complete, printable, trimmed, in-bounds token. Read it with token().
  Token = 1U,
  /// A complete line this board refuses without looking at it: too long for the
  /// token cap. The caller denies it exactly as it denies an unknown token —
  /// the bytes are gone and there is nothing to ask the API about.
  Refused = 2U,
};

class ScanAssembler {
public:
  /// Feed one received byte.
  ScanEvent feed(uint8_t byte);

  /// The token from the last ScanEvent::Token. NUL-terminated; empty otherwise.
  const char* token() const { return token_; }

  /// Throw away a partial line — on a link-down, or at boot.
  void reset();

private:
  char line_[roster::kMaxTokenLen + 1U] = {};
  char token_[roster::kMaxTokenLen + 1U] = {};
  /// Characters held in `line_`. Stops at the cap; `overflow_` remembers that
  /// more arrived, which is what makes the refusal a refusal and not a
  /// truncation.
  uint8_t len_ = 0U;
  bool overflow_ = false;
  bool corrupt_ = false;
};

} // namespace gatelogic

#endif // CRUSADERS_GATELOGIC_SCANASSEMBLER_H

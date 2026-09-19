#include "gatelogic/ScanAssembler.h"

namespace gatelogic {
namespace {

/// Space and horizontal tab. Trimmed off both ends; CR and LF are terminators
/// and never reach here.
bool isTrimmable(uint8_t byte) {
  return byte == static_cast<uint8_t>(' ') || byte == static_cast<uint8_t>('\t');
}

/// What may go into the line at all: printable ASCII, plus the horizontal tab.
///
/// The tab is admitted so that it can be TRIMMED. Some scanner modules are
/// configured with a tab suffix, and a tab arriving as corruption rather than
/// as whitespace would cost a member their scan for a reason nobody could see.
/// Everything else — NUL, the other control bytes, DEL, and the high half a
/// framing error produces — costs the line.
bool isAccepted(uint8_t byte) {
  return (byte >= 0x20U && byte < 0x7FU) || byte == static_cast<uint8_t>('\t');
}

bool isTerminator(uint8_t byte) {
  return byte == static_cast<uint8_t>('\r') || byte == static_cast<uint8_t>('\n');
}

} // namespace

void ScanAssembler::reset() {
  len_ = 0U;
  overflow_ = false;
  corrupt_ = false;
  line_[0] = '\0';
}

void ScanAssembler::markCorrupt() {
  corrupt_ = true;
}

ScanEvent ScanAssembler::feed(uint8_t byte) {
  if (!isTerminator(byte)) {
    if (!isAccepted(byte)) {
      // The line is dead from here. Kept accumulating-but-marked rather than
      // reset on the spot, so the bytes that follow are swallowed with it
      // instead of becoming the head of a phantom second scan.
      corrupt_ = true;
      return ScanEvent::None;
    }
    if (len_ >= roster::kMaxTokenLen) {
      // One character past the cap is enough to know. The rest of the line is
      // still consumed — it is not the start of the next token.
      overflow_ = true;
      return ScanEvent::None;
    }
    line_[len_] = static_cast<char>(byte);
    ++len_;
    line_[len_] = '\0';
    return ScanEvent::None;
  }

  // A terminator. CRLF is ONE terminator: the second byte ends an empty line,
  // which is ignored, so nothing special is needed for it.
  //
  // The token is copied out BEFORE reset() runs. `line_` is the buffer reset()
  // empties, so reading through it afterwards reads what reset just wrote.
  ScanEvent result = ScanEvent::None;
  if (corrupt_) {
    result = ScanEvent::None;
  } else if (overflow_) {
    result = ScanEvent::Refused;
  } else {
    // Trim. Leading first, so an all-whitespace line ends at length 0 rather
    // than underflowing the trailing loop.
    uint8_t length = len_;
    uint8_t first = 0U;
    while (length > 0U && isTrimmable(static_cast<uint8_t>(line_[first]))) {
      ++first;
      --length;
    }
    while (length > 0U && isTrimmable(static_cast<uint8_t>(line_[first + length - 1U]))) {
      --length;
    }
    if (length > 0U) {
      for (uint8_t i = 0U; i < length; ++i) {
        token_[i] = line_[first + i];
      }
      token_[length] = '\0';
      result = ScanEvent::Token;
    }
  }

  reset();
  return result;
}

} // namespace gatelogic

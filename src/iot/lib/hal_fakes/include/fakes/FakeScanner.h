// Crusaders Mainframe — recording fake for hal::IScannerPort.
//
// WHY THE FEED IS A QUEUE AND NOT A STRING
// ----------------------------------------
// The interesting scanner behaviour is not "a code arrived". It is that a code
// arrives in pieces, at 9600 baud, across many passes of the main loop, and
// sometimes never finishes. A test drives that by feeding a fragment, letting
// the code under test drain and make no decision, then feeding the rest — which
// only works if the fake holds bytes between drains.
//
// Feeding is byte-clean: feedByte(0x00) is delivered like any other value, so a
// test can prove the framing layer does not treat NUL as a terminator, and
// corruption can be injected exactly where it hurts. That is not hypothetical:
// the scanner's TTL line runs beside four switching relay coils.
//
// OVERFLOW IS REPORTED, NOT ABSORBED
// ----------------------------------
// feed() returns false and latches overflowed() when the queue is full. A fake
// that silently dropped the tail would turn "the code under test never saw the
// terminator" into a passing test with a mysterious assertion further down.
//
// No Arduino headers, no heap, no String.

#ifndef CRUSADERS_FAKES_FAKESCANNER_H
#define CRUSADERS_FAKES_FAKESCANNER_H

#include <stdint.h>

#include "hal/Scanner.h"

#include "fakes/ByteQueue.h"

namespace fakes {

class FakeScanner final : public hal::IScannerPort {
public:
  /// A QR payload here is a short token; 128 bytes holds several plus their
  /// terminators.
  static constexpr uint16_t kCapacity = 128U;

  bool read(uint8_t& out) override {
    if (!queue_.pop(out)) {
      return false;
    }
    ++delivered_;
    return true;
  }

  // --- stimulus ------------------------------------------------------------

  bool feedByte(uint8_t value) { return queue_.push(value); }

  /// Queue a NUL-terminated fragment. No terminator is appended: a fragment
  /// with no \r or \n is precisely the partial-line case.
  bool feed(const char* text) {
    if (text == nullptr) {
      return false;
    }
    for (uint16_t i = 0U; text[i] != '\0'; ++i) {
      if (!feedByte(static_cast<uint8_t>(text[i]))) {
        return false;
      }
    }
    return true;
  }

  /// Queue a fragment plus a terminator. Defaults to '\r' because that is what
  /// the fitted module emits; '\n' and "\r\n" are both legal on this port,
  /// which is why the terminator is a parameter and not baked in.
  bool feedLine(const char* text, char terminator = '\r') {
    return feed(text) && feedByte(static_cast<uint8_t>(terminator));
  }

  // --- observation ---------------------------------------------------------

  uint16_t pending() const { return queue_.size(); }

  bool overflowed() const { return queue_.overflowed(); }

  uint16_t delivered() const { return delivered_; }

  void reset() {
    queue_.clear();
    delivered_ = 0U;
  }

private:
  ByteQueue<kCapacity> queue_;
  uint16_t delivered_ = 0U;
};

} // namespace fakes

#endif // CRUSADERS_FAKES_FAKESCANNER_H

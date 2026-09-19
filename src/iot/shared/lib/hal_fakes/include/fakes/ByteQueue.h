// Crusaders Mainframe — the fixed-capacity byte queue the recording fakes share.
//
// WHY IT IS SHARED
// ----------------
// Both the scanner fake and the transport fake need "bytes arrive in fragments
// and are drained one at a time". Two hand-written copies of a head/tail queue
// in test infrastructure is two places for an off-by-one to hide, and a bug in
// a fake does not fail loudly — it makes some other module's test lie. One
// implementation, tested directly.
//
// WHY IT OVERFLOWS INSTEAD OF WRAPPING
// ------------------------------------
// A full queue refuses the byte and latches overflowed(). A ring that
// overwrote the oldest byte would turn "the test fed more than it drained"
// into a scenario nobody wrote, silently.
//
// Capacity is a template parameter rather than a heap allocation because these
// fakes must stay free of dynamic memory: the same discipline as the firmware,
// so nothing here can drift into a habit that will not compile for the ATmega.
//
// No Arduino headers, no heap, no String.

#ifndef CRUSADERS_FAKES_BYTEQUEUE_H
#define CRUSADERS_FAKES_BYTEQUEUE_H

#include <stdint.h>

namespace fakes {

template <uint16_t Capacity> class ByteQueue {
public:
  static constexpr uint16_t kCapacity = Capacity;

  /// Queue one byte. False (and overflowed() latched) when full.
  bool push(uint8_t value) {
    compact();
    if (tail_ >= Capacity) {
      overflowed_ = true;
      return false;
    }
    buffer_[tail_] = value;
    ++tail_;
    return true;
  }

  /// Take the oldest byte. False when empty.
  bool pop(uint8_t& out) {
    if (head_ >= tail_) {
      return false;
    }
    out = buffer_[head_];
    ++head_;
    return true;
  }

  uint16_t size() const { return static_cast<uint16_t>(tail_ - head_); }

  bool empty() const { return head_ >= tail_; }

  /// Latched: once a test has overrun the queue, every later assertion about
  /// what was delivered is suspect, so the flag does not clear on drain.
  bool overflowed() const { return overflowed_; }

  void clear() {
    head_ = 0U;
    tail_ = 0U;
    overflowed_ = false;
  }

private:
  /// Reclaim the drained prefix. Only unread bytes move, so a long test session
  /// cannot hit a false overflow just because it has drained and refilled.
  void compact() {
    if (tail_ < Capacity || head_ == 0U) {
      return;
    }
    const uint16_t remaining = size();
    for (uint16_t i = 0U; i < remaining; ++i) {
      buffer_[i] = buffer_[static_cast<uint16_t>(head_ + i)];
    }
    head_ = 0U;
    tail_ = remaining;
  }

  uint8_t buffer_[Capacity] = {};
  uint16_t head_ = 0U;
  uint16_t tail_ = 0U;
  bool overflowed_ = false;
};

} // namespace fakes

#endif // CRUSADERS_FAKES_BYTEQUEUE_H

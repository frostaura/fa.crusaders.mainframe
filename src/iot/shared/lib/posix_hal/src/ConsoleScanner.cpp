// The console scanner. See include/posix_hal/ConsoleScanner.h.

#include "posix_hal/ConsoleScanner.h"

namespace posix_hal {

ConsoleScanner::ConsoleScanner() : buf_(), head_(0U), len_(0U), dropped_(0U) {
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

bool ConsoleScanner::feedByte(uint8_t value) {
  const bool full = len_ == kCapacity;
  if (full) {
    head_ = static_cast<uint16_t>((head_ + 1U) % kCapacity);
    --len_;
    ++dropped_;
  }
  const uint16_t tail = static_cast<uint16_t>((head_ + len_) % kCapacity);
  buf_[tail] = value;
  ++len_;
  return !full;
}

void ConsoleScanner::feedLine(const char* text) {
  if (text == nullptr) {
    return;
  }
  for (uint16_t i = 0U; text[i] != '\0'; ++i) {
    static_cast<void>(feedByte(static_cast<uint8_t>(text[i])));
  }
  static_cast<void>(feedByte(static_cast<uint8_t>('\n')));
}

} // namespace posix_hal

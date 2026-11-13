// See include/courtlogic/ScannerBaud.h.

#include "courtlogic/ScannerBaud.h"

namespace courtlogic {

namespace {

/// The auto-detect order, as codes: 9600, 115200, 57600, 38400, 19200. The
/// common factory rates first.
constexpr uint8_t kOrder[5] = {1U, 5U, 4U, 3U, 2U};

} // namespace

uint8_t baudCodeOf(uint32_t rate) {
  return rate == 9600UL     ? 1U
         : rate == 19200UL  ? 2U
         : rate == 38400UL  ? 3U
         : rate == 57600UL  ? 4U
         : rate == 115200UL ? 5U
                            : 0U;
}

uint32_t baudOfCode(uint8_t code) {
  return code == 2U ? 19200UL : code == 3U ? 38400UL : code == 4U ? 57600UL : code == 5U ? 115200UL : 9600UL;
}

ScannerBaud::ScannerBaud() : code_(1U), bursts_(0U), auto_(true), locked_(false) {
}

void ScannerBaud::configure(uint8_t code) {
  bursts_ = 0U;
  if (code >= 1U && code <= 5U) {
    auto_ = false;
    locked_ = true;
    code_ = code;
    return;
  }
  auto_ = true;
  locked_ = false;
  code_ = 1U;
}

void ScannerBaud::cleanLine() {
  bursts_ = 0U;
  if (auto_) {
    locked_ = true;
  }
}

bool ScannerBaud::garbage(bool idle) {
  if (!auto_ || locked_) {
    return false;
  }
  if (bursts_ < kBaudGarbageBursts) {
    ++bursts_;
  }
  if (bursts_ < kBaudGarbageBursts || !idle) {
    return false;
  }
  bursts_ = 0U;
  uint8_t at = 0U;
  for (uint8_t i = 0U; i < 5U; ++i) {
    if (kOrder[i] == code_) {
      at = i;
    }
  }
  code_ = kOrder[(at + 1U) % 5U];
  return true;
}

} // namespace courtlogic

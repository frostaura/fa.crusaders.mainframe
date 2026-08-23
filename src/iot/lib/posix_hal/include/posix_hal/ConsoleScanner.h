// Crusaders Mainframe — hal::IScannerPort fed from the simulator's console.
//
// A scan in the simulator is a line somebody types, or a line a test harness
// pipes in. The bytes go into a queue and come out one at a time, exactly as
// they arrive from a 9600 baud module, so courtlogic::ScanAssembler does the
// same line assembly here as it does on the board — including the case where a
// line arrives split across two passes of the loop.
//
// The queue is byte-clean: feedByte(0x00) is delivered like any other value.
// hal/Scanner.h requires that, and it is what lets a harness inject the
// corruption that a TTL line running beside four relay coils actually produces.
//
// Rejected: reusing fakes::FakeScanner. Its queue latches an overflow flag and
// refuses further bytes so a test that overran its own fixture fails loudly;
// a simulator that stopped accepting scans after 128 bytes would be a fixture
// rule shipped in a binary. This one drops the oldest byte and says so.

#ifndef CRUSADERS_POSIX_HAL_CONSOLESCANNER_H
#define CRUSADERS_POSIX_HAL_CONSOLESCANNER_H

#include <stdint.h>

#include "hal/Scanner.h"

namespace posix_hal {

class ConsoleScanner final : public hal::IScannerPort {
public:
  /// Room for several codes and their terminators.
  static constexpr uint16_t kCapacity = 512U;

  ConsoleScanner();

  bool read(uint8_t& out) override;

  /// Queue one byte. False when the buffer is full, in which case the OLDEST
  /// byte is dropped to make room — a simulator that stopped accepting input
  /// would look like a hung device, and this at least stays usable.
  bool feedByte(uint8_t value);

  /// Queue a NUL-terminated string followed by '\n', which is what presenting a
  /// phone to the module looks like.
  void feedLine(const char* text);

  /// Bytes discarded because the buffer was full. Non-zero means the console is
  /// being fed faster than the box is draining it.
  uint32_t droppedBytes() const { return dropped_; }

private:
  uint8_t buf_[kCapacity];
  uint16_t head_;
  uint16_t len_;
  uint32_t dropped_;
};

} // namespace posix_hal

#endif // CRUSADERS_POSIX_HAL_CONSOLESCANNER_H

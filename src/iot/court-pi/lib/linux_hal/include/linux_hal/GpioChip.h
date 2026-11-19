// Crusaders Mainframe — a thin wrapper over the Linux GPIO character device
// (uAPI v2, <linux/gpio.h>, kernel 5.10+). No libgpiod: the kernel header is the
// whole dependency, so the binary builds on a stock Raspberry Pi OS and in CI.
//
// One GpioLine is one kernel line request. A relay line is switched between
// INPUT (released, high-Z — the external pull-down holds the court dark) and
// OUTPUT at the active level, which is the Mega's PinDrive rule unchanged.

#ifndef CRUSADERS_LINUX_HAL_GPIOCHIP_H
#define CRUSADERS_LINUX_HAL_GPIOCHIP_H

#include <stdint.h>

namespace linux_hal {

/// The chip whose label names a Raspberry Pi's 40-pin bank. `override` (a path
/// such as /dev/gpiochip0) wins when not null. Returns an open fd or -1.
int openPiGpioChip(const char* overridePath, char* labelOut, unsigned labelCap);

enum class Bias : uint8_t { Disabled, PullUp, PullDown };

class GpioLine {
public:
  GpioLine() = default;
  ~GpioLine();
  GpioLine(const GpioLine&) = delete;
  GpioLine& operator=(const GpioLine&) = delete;

  /// Requests `offset` on `chipFd` as an input with `bias`. False on failure.
  bool requestInput(int chipFd, uint8_t offset, Bias bias, const char* consumer);
  /// Re-configures an already requested line. False on failure.
  bool makeInput(Bias bias);
  bool makeOutput(bool high);
  bool setValue(bool high);
  /// -1 on failure, else 0/1.
  int value() const;

  bool valid() const { return fd_ >= 0; }

  void release();

private:
  bool configure(uint64_t flags, bool high);
  int fd_ = -1;
};

/// Several inputs read in ONE ioctl (the button panel): a consistent snapshot.
class GpioInputs {
public:
  GpioInputs() = default;
  ~GpioInputs();
  GpioInputs(const GpioInputs&) = delete;
  GpioInputs& operator=(const GpioInputs&) = delete;

  bool request(int chipFd, const uint8_t* offsets, uint8_t count, Bias bias, const char* consumer);
  /// Bit i is line i's level. False on failure (then `bits` is untouched).
  bool read(uint64_t& bits) const;

  bool valid() const { return fd_ >= 0; }

private:
  int fd_ = -1;
  uint8_t count_ = 0U;
};

} // namespace linux_hal

#endif // CRUSADERS_LINUX_HAL_GPIOCHIP_H

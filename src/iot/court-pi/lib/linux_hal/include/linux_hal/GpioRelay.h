// Crusaders Mainframe — the four court relays on Raspberry Pi GPIO.
//
// The Pi counterpart of arduino_hal::ArduinoRelay, with the same contract:
//   * released = the line is an INPUT with the SoC bias DISABLED. The external
//     10 k pull-down on the buffer input (docs/specs/court-box-pi.md §3) holds
//     the court dark, for either relay polarity the resistor was fitted for;
//   * on = OUTPUT, already at the closing level in the same ioctl;
//   * setPolarity() re-drives every closed relay at the new level;
//   * the status LED is lit while any court is.
//
// What the Pi adds, because the Mega's reset did it for free:
//   * releaseAll() is safe to call from a fresh process that owns nothing —
//     `court-io --release` is systemd's ExecStopPost, so a court-io that died
//     by any route (SIGKILL, segfault, watchdog) leaves every line an input
//     before systemd starts the next one.

#ifndef CRUSADERS_LINUX_HAL_GPIORELAY_H
#define CRUSADERS_LINUX_HAL_GPIORELAY_H

#include <stdint.h>

#include "hal/Relay.h"

#include "linux_hal/GpioChip.h"

namespace linux_hal {

class GpioRelay final : public hal::IRelayPort {
public:
  explicit GpioRelay(hal::RelayPolarity bootPolarity);

  /// Claims the four relay lines and the LED, every relay released. False if
  /// any line could not be claimed — court-io then refuses to run, because a
  /// relay it cannot release is a relay it must not be trusted to close.
  bool begin(int chipFd);

  void set(uint8_t channel, bool on) override;
  bool isOn(uint8_t channel) const override;
  void allOff() override;
  void setPolarity(hal::RelayPolarity polarity) override;

  hal::RelayPolarity polarity() const override { return polarity_; }

  /// Count of drive ioctls the kernel refused since start (reported in logs).
  uint32_t driveFailures() const { return driveFailures_; }

  /// Requests every relay line as an input and lets it go. For ExecStopPost.
  static bool releaseAll(int chipFd);

private:
  void drive(uint8_t channel, bool on);

  GpioLine lines_[hal::kRelayChannelCount];
  GpioLine led_;
  bool state_[hal::kRelayChannelCount] = {};
  hal::RelayPolarity polarity_;
  uint32_t driveFailures_ = 0U;
};

} // namespace linux_hal

#endif // CRUSADERS_LINUX_HAL_GPIORELAY_H

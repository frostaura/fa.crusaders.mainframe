// Crusaders Mainframe — the HD44780 + PCF8574 backpack on the Pi's I2C1.
//
// A port of arduino_hal::LcdDisplay (Mega 3.0.0) from Wire to /dev/i2c-N, with
// every behaviour the Mega's glass relies on kept:
//   * the backpack address is PROBED in courtlogic::kLcdProbeOrder (or forced
//     by !CFG,LCDA) at begin and after every bus error;
//   * an error abandons the write, courtlogic::DisplayHoldoff skips the next 20,
//     and the first allowed write re-synchronises the controller (4-bit reset)
//     before it paints — the timeout bounds the stall, the re-sync recovers the
//     glass;
//   * cellsPerPass() is measured from the last paint against an 8 ms budget.
//
// What changes on Linux: there is no Wire timeout to arm (the kernel's
// i2c-bcm2835 driver times a transfer out and returns -ETIMEDOUT/-EREMOTEIO),
// there is no SCL bit-bang (the kernel recovers the bus), and the bus clock is
// set once in /boot/firmware/config.txt (dtparam=i2c_arm_baudrate=100000) —
// 100 kHz, because the backpack's 5 V side sits behind a level shifter on a
// panel lead.

#ifndef CRUSADERS_LINUX_HAL_I2CLCD_H
#define CRUSADERS_LINUX_HAL_I2CLCD_H

#include <stdint.h>

#include "hal/Display.h"

#include "courtlogic/DisplayHoldoff.h"

namespace linux_hal {

inline constexpr uint32_t kPaintBudgetMicros = 8000UL;

typedef void (*IdleHook)(void* context);

class I2cLcd final : public hal::IDisplayPort {
public:
  I2cLcd() = default;
  ~I2cLcd() override;

  /// Opens the bus and initialises the panel. False only when the BUS cannot be
  /// opened; a missing panel is reported as address() == 0, like the Mega.
  bool begin(const char* busPath);

  void clear() override;
  void print(uint8_t row, uint8_t col, const char* text) override;
  bool writable() override;
  bool takeGlassLost() override;
  void reinit() override;

  uint8_t cellsPerPass() const override { return cellsPerPass_; }

  uint16_t timeouts() const override { return holdoff_.timeouts(); }

  uint16_t recoveries() const override { return recoveries_; }

  uint8_t address() const override { return address_; }

  void setAddress(uint8_t address) override;

  /// Called between I2C writes so a long paint never starves the buttons.
  void setIdleHook(IdleHook hook, void* context) {
    idleHook_ = hook;
    idleContext_ = context;
  }

  /// One address probe. Public for the probe callback.
  bool answers(uint8_t address);

private:
  bool writeBytes(const uint8_t* data, uint8_t len);
  bool nibble(uint8_t data);
  bool send(uint8_t value, uint8_t mode);
  bool command(uint8_t value);
  uint8_t findAddress();
  void initController();
  void busError();
  bool ready();
  void recover();
  void idle();

  courtlogic::DisplayHoldoff holdoff_;
  IdleHook idleHook_ = nullptr;
  void* idleContext_ = nullptr;
  int fd_ = -1;
  uint8_t selected_ = 0U;
  uint8_t requested_ = 0U;
  uint8_t address_ = 0U;
  uint8_t cellsPerPass_ = 8U;
  uint16_t recoveries_ = 0U;
  bool glassLost_ = true;
  bool errorSinceProbe_ = true;
};

} // namespace linux_hal

#endif // CRUSADERS_LINUX_HAL_I2CLCD_H

// Crusaders Mainframe — hal::IDisplayPort on an HD44780 behind a PCF8574 I2C
// backpack, driven directly (Mega 3.0.0).
//
// WHY THERE IS NO LIBRARY UNDER THIS ANY MORE
// -------------------------------------------
// LiquidCrystal_I2C fixes the backpack's address at construction and keeps the
// nibble writer private, and 3.0.0 needs both at run time: the fitted
// backpack's chip — PCF8574T (0x20-0x27) or PCF8574AT (0x38-0x3F) — is
// unrecorded (HW-2), so the address is PROBED (0x27, 0x3F, 0x20-0x26,
// 0x38-0x3E, each bounded by the bus timeout) at boot and at every re-init
// after a bus error, or forced by `!CFG,LCDA`; and the self-healing glass
// re-runs the 4-bit initialisation every `REINIT` seconds on landing (DL-05).
// The protocol to the backpack is eight lines: a nibble is one I2C
// transaction of three bytes (data, data|En, data), a character two nibbles.
//
// THE BUS CANNOT HANG THE BOX
// ---------------------------
// The bus is brought up with Wire's timeout armed (25 ms) BEFORE the first
// transaction, a slave holding SDA low is released by nine SCL clocks and a
// STOP, and every transaction's result is read: a timeout OR a NACK is a bus
// error, counted (`!DIAG` arg 0 — a backpack that stopped answering is
// counted, not silent) and answered by a holdoff (courtlogic::DisplayHoldoff)
// and a re-sync, after which the caller repaints every cell (takeGlassLost).
//
// THE PAINT BUDGET
// ----------------
// The bus runs at 400 kHz (a character costs ~0.2 ms) and falls back to
// 100 kHz for the rest of the boot if the backpack does not answer at 400 kHz
// or errors there. cellsPerPass() is derived from the measured cost of the
// last writes, so the Mega's loop never spends more than ~8 ms of a pass on
// the glass and the 64-byte Serial3 ring is drained every ~10 ms (DL-02).
//
// THE IDLE HOOK (DL-15)
// ---------------------
// Eight milliseconds of paint, ten of re-init, or a probe that waits out bus
// timeouts are still time in which no pass looks at the buttons, and a short
// tap with one of them in the wrong place was lost. setIdleHook() names a
// function the driver calls between bus transactions and inside every wait,
// at most once per kIdleEveryMicros; main.cpp points it at
// CourtBox::sampleButtons, so the debounce rule sees the pins about every
// half millisecond however long the glass takes. The hook must not touch the
// display.

#ifndef CRUSADERS_ARDUINO_HAL_LCDDISPLAY_H
#define CRUSADERS_ARDUINO_HAL_LCDDISPLAY_H

#ifdef TARGET_COURT_MEGA

#include <stdint.h>

#include "hal/Display.h"

#include "courtlogic/DisplayHoldoff.h"

namespace arduino_hal {

/// How long one I2C transaction may stall before it is abandoned.
inline constexpr uint32_t kWireTimeoutMicros = 25000UL;

/// The per-pass paint budget.
inline constexpr uint32_t kPaintBudgetMicros = 8000UL;

/// The idle hook runs at most this often (a sample of eight pins is ~40 us).
inline constexpr uint32_t kIdleEveryMicros = 500UL;

/// What the driver calls between bus transactions; see setIdleHook().
typedef void (*IdleHook)(void* context);

class LcdDisplay final : public hal::IDisplayPort {
public:
  LcdDisplay();

  /// Bus up with its timeout armed, the panel's power-on wait, the address
  /// probe and the 4-bit initialisation. Bounded: sixteen probe timeouts are
  /// 0.4 s, inside the 8 s boot watchdog.
  void begin();

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

  /// Called between bus transactions and during every wait, at most once per
  /// kIdleEveryMicros. Store only: safe before begin(), from file scope.
  void setIdleHook(IdleHook hook, void* context);

  /// Runs the idle hook if one is set and kIdleEveryMicros have passed.
  void idle();

private:
  /// One nibble (already in the high four bits) with Rs as `mode`; false on a
  /// bus error, which is also noted.
  bool nibble(uint8_t data);
  bool send(uint8_t value, uint8_t mode);
  bool command(uint8_t value);
  /// The address that answers, per LCDA (0 = probe). 0 when none does.
  uint8_t findAddress();
  /// The 4-bit reset sequence and mode commands, without clearing.
  void initController();
  void busError();
  bool ready();
  void recover();
  /// delayMicroseconds(us), with the idle hook kept running through it.
  void wait(uint32_t us);

  courtlogic::DisplayHoldoff holdoff_;
  IdleHook idleHook_;
  void* idleContext_;
  uint32_t idleAtMicros_;
  uint8_t requested_;
  uint8_t address_;
  uint8_t cellsPerPass_;
  uint16_t recoveries_;
  bool glassLost_;
  bool errorSinceProbe_;
  bool slowBus_;
};

} // namespace arduino_hal

#endif // TARGET_COURT_MEGA

#endif // CRUSADERS_ARDUINO_HAL_LCDDISPLAY_H

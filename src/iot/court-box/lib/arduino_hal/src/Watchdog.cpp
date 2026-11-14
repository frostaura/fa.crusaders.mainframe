// The AVR watchdog. See include/arduino_hal/Watchdog.h.

#include "arduino_hal/Watchdog.h"

#ifdef TARGET_COURT_MEGA

#include <Arduino.h>

#include <avr/wdt.h>

namespace {

/// MCUSR as it stood at reset, kept in `.noinit` so neither the C runtime's
/// zeroing of `.bss` nor anything later clears it (FWM-12, HW-6). Reported in
/// `!BOOT`: bit0 power-on, bit1 external, bit2 brown-out, bit3 watchdog.
/// Whether the board's stk500v2 bootloader leaves MCUSR intact for the
/// application is a bench check (FWM-11, lights-controller.md): if it clears
/// it, `!BOOT` reads `00` and says so honestly rather than inventing a cause.
uint8_t gResetCause __attribute__((section(".noinit")));

/// Runs from .init3, before main(). Saves then clears the reset-cause register
/// and turns the watchdog off, so a reset the watchdog caused does not
/// immediately cause another. `naked` because there is no stack frame yet;
/// `used` because nothing references it and the linker would otherwise drop
/// it. The AVR-libc manual prescribes exactly this sequence for any program
/// that enables the WDT.
void disableWatchdogEarly() __attribute__((naked, used, section(".init3")));

void disableWatchdogEarly() {
  gResetCause = MCUSR;
  MCUSR = 0U;
  wdt_disable();
}

} // namespace

namespace arduino_hal {

uint8_t resetCause() {
  return gResetCause;
}

void watchdogBeginBoot() {
  // Eight seconds, armed before anything in setup() can touch a peripheral. The
  // longest legitimate init is LcdDisplay::begin()'s ~1.1 s of library delays;
  // a wedged bus adds 25 ms per abandoned transaction on top. Eight bounds both
  // without ever firing on a healthy board.
  wdt_enable(WDTO_8S);
}

void watchdogBegin() {
  // Two seconds: an order of magnitude longer than the longest legitimate pass
  // (a full two-row paint with the bus healthy is ~10 ms; a single bus timeout
  // is 25 ms) and short enough that a lit court is never held past its deadline
  // by more than a couple of seconds.
  wdt_enable(WDTO_2S);
}

void watchdogKick() {
  wdt_reset();
}

#ifdef WDT_BENCH_STALL
void watchdogBenchStall() {
  // No wdt_reset() in here, deliberately. This is the only code in the tree
  // that can stall a pass past the watchdog period, and it exists so the bench
  // check has something real to observe.
  for (;;) {
  }
}
#endif

} // namespace arduino_hal

#endif // TARGET_COURT_MEGA

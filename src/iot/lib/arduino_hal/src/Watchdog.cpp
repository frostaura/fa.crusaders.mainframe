// The AVR watchdog. See include/arduino_hal/Watchdog.h.

#include "arduino_hal/Watchdog.h"

#ifdef TARGET_COURT_MEGA

#include <Arduino.h>
#include <avr/wdt.h>

namespace {

/// Runs from .init3, before main(). Clears the reset-cause register and turns
/// the watchdog off, so a reset the watchdog caused does not immediately cause
/// another. `naked` because there is no stack frame yet; `used` because nothing
/// references it and the linker would otherwise drop it. The AVR-libc manual
/// prescribes exactly this sequence for any program that enables the WDT.
void disableWatchdogEarly() __attribute__((naked, used, section(".init3")));

void disableWatchdogEarly() {
  MCUSR = 0U;
  wdt_disable();
}

} // namespace

namespace arduino_hal {

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

} // namespace arduino_hal

#endif // TARGET_COURT_MEGA

// Crusaders Mainframe — the ATmega2560's hardware watchdog.
//
// WHY THE MEGA HAS ONE
// --------------------
// The Mega's single hard-safety property is that RelayGuard::tick runs every
// pass of loop(), behind nothing. Anything that stops loop() returning — a
// wedged I2C bus under the LCD, a driver spinning on a peripheral — stops the
// auto-off timer with a court lit, and no GPIO reaches the Mega's RESET so the
// ESP cannot recover it. The watchdog is the thing behind "behind nothing": a
// stall longer than kWatchdogPeriod ends in a hardware reset, which re-runs
// setup(), which opens every relay before it does anything else
// (ArduinoRelay::begin drives the released level before pinMode).
//
// WHY THE .init3 HOOK
// -------------------
// After a watchdog reset the WDT stays ENABLED with the shortest prescale
// (16 ms) until software clears MCUSR and disables it. The Arduino core does
// not do that, and 16 ms is less than the time the core takes to reach
// setup(): the part resets again, and again, forever — the "WDT boot loop" that
// older Mega2560 stk500v2 bootloaders are known for. The hook runs before main()
// and before the C runtime has done anything worth losing, so the reset is
// survived rather than repeated.
//
// The Mega's own bootloader is out of software's reach: a bootloader that
// itself loops on a WDT reset is a bench finding, not a firmware one, and the
// go-live checklist carries the check. What can be pinned here is that the
// firmware side never contributes to the loop.
//
// Compiled only for the Mega. The ESP8266 core has its own watchdog, and it is
// already on.

#ifndef CRUSADERS_ARDUINO_HAL_WATCHDOG_H
#define CRUSADERS_ARDUINO_HAL_WATCHDOG_H

#ifdef TARGET_COURT_MEGA

namespace arduino_hal {

/// Enable the watchdog with a two-second period. Call once, at the END of
/// setup(): LCD init alone spends ~50 ms in delay() calls, and a period that
/// has to survive setup() would be a period too long to protect loop().
void watchdogBegin();

/// Restart the countdown. Called once per pass of loop(), from the composition
/// root — never from inside a driver, where it would hide the stall it exists
/// to end.
void watchdogKick();

} // namespace arduino_hal

#endif // TARGET_COURT_MEGA

#endif // CRUSADERS_ARDUINO_HAL_WATCHDOG_H

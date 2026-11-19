// Crusaders Mainframe — the little a court-box process needs from systemd and
// from Linux in place of what an AVR or an ESP8266 gave it for free.
//
//   * notify(): sd_notify without libsystemd — READY=1 once, WATCHDOG=1 every
//     pass. A process that stops kicking is killed and restarted by systemd
//     (WatchdogSec=), which is the Mega's 2 s watchdog reset re-expressed.
//   * bootCause(): what the Mega reports in !BOOT as MCUSR and the ESP in
//     `diag.reset`. A marker in /run (tmpfs: wiped by a power cycle, kept across
//     a process restart) tells a first start since power-on from a restart.

#ifndef CRUSADERS_LINUX_HAL_SERVICE_H
#define CRUSADERS_LINUX_HAL_SERVICE_H

#include <stdint.h>

namespace linux_hal {

/// Sends `state` (e.g. "READY=1") to $NOTIFY_SOCKET. A no-op outside systemd.
void notify(const char* state);

/// Rate-limited WATCHDOG=1: at most every 200 ms however often it is called.
void kickWatchdog();

enum class BootCause : uint8_t { PowerOn, Restart };

/// Reads then (re)writes `markerPath`. PowerOn when it was absent.
BootCause bootCause(const char* markerPath);

/// mkdir -p for a directory path. True when it exists afterwards.
bool ensureDir(const char* path);

} // namespace linux_hal

#endif // CRUSADERS_LINUX_HAL_SERVICE_H

// Crusaders Mainframe — the firmware version string, as one token.
//
// WHY IT IS ASSEMBLED FROM MACROS RATHER THAN WRITTEN OUT
// -------------------------------------------------------
// The three numbers already exist as FW_VERSION_MAJOR/MINOR/PATCH in
// platformio.ini's [common] block, where both firmwares and the simulator pick
// them up. A second, hand-written "1.0.0" here would be a copy that nobody
// updates in the same commit — and this string goes out in `!PONG` and in the
// heartbeat's `firmware_version`, which is what the admin Devices screen shows
// and the only way to tell from a desk which image a board is running. A
// version that lies about that is worse than no version at all.
//
// The defaults exist for tools/strict_compile.sh, which compiles these headers
// with no PlatformIO flags at all. They are deliberately 0.0.0: a binary
// reporting 0.0.0 was built outside the build system, which is exactly what a
// reader should conclude.
//
// This is one header in its own library rather than a header inside courtlogic,
// because PlatformIO's dependency finder pulls in a whole library at a time: the
// ESP8266 would otherwise compile the ATmega's entire application in order to
// learn its own version number.
//
// No Arduino headers, no heap.

#ifndef CRUSADERS_FWVERSION_VERSION_H
#define CRUSADERS_FWVERSION_VERSION_H

#ifndef FW_VERSION_MAJOR
#define FW_VERSION_MAJOR 0
#endif
#ifndef FW_VERSION_MINOR
#define FW_VERSION_MINOR 0
#endif
#ifndef FW_VERSION_PATCH
#define FW_VERSION_PATCH 0
#endif

// Two levels, because the argument of a single-level stringify is not expanded.
#define CRUSADERS_STRINGIFY_(x) #x
#define CRUSADERS_STRINGIFY(x) CRUSADERS_STRINGIFY_(x)

namespace fw {

/// "MAJOR.MINOR.PATCH". Carried by `!PONG` and by the beacon's `fw` field.
inline constexpr char kFirmwareVersion[] = CRUSADERS_STRINGIFY(FW_VERSION_MAJOR) "." CRUSADERS_STRINGIFY(
    FW_VERSION_MINOR) "." CRUSADERS_STRINGIFY(FW_VERSION_PATCH);

} // namespace fw

#endif // CRUSADERS_FWVERSION_VERSION_H

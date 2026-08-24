// Crusaders Mainframe — firmware versions, compared.
//
// WHY THIS IS NOT strcmp
// ----------------------
// "1.10.0" is newer than "1.9.0" and sorts before it as text. A box that
// compared versions as strings would stop taking updates the moment a minor
// number reached double digits, and would do it silently — the heartbeat would
// keep offering the update and the box would keep deciding it already had it.
//
// WHY AN UNPARSEABLE VERSION IS OLDER THAN EVERYTHING
// ---------------------------------------------------
// A box running a build whose version string is malformed should be able to
// escape by updating. Treating "unknown" as newest would strand exactly the
// boxes most in need of a fix.
//
// No Arduino headers, no heap, no String. Compiles for AVR, Xtensa and the host.

#ifndef CRUSADERS_OTACORE_VERSION_H
#define CRUSADERS_OTACORE_VERSION_H

#include <stdint.h>

namespace ota {

struct Version {
  uint16_t major = 0U;
  uint16_t minor = 0U;
  uint16_t patch = 0U;
  bool parsed = false;

  /// -1, 0 or 1. An unparsed version is older than any parsed one, and two
  /// unparsed versions are equal — so a box with a broken version string takes
  /// the first update it is offered and takes it only once.
  int compare(const Version& other) const;

  bool olderThan(const Version& other) const { return compare(other) < 0; }
};

/// Parses "major.minor.patch". Anything else yields `parsed == false`.
/// Trailing text after the patch number is refused rather than ignored: "1.2.3-rc1"
/// and "1.2.3" are different builds and must not compare equal.
Version parseVersion(const char* text);

} // namespace ota

#endif // CRUSADERS_OTACORE_VERSION_H

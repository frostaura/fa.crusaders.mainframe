#include "bridgelogic/MegaLink.h"

namespace bridgelogic {

bool shouldRepaintIdentity(bool seenPong, uint32_t previousSeconds, uint32_t seconds) {
  if (!seenPong) {
    // The Mega has just become reachable. Nothing it is showing came from this
    // bridge, whether it was powered off, or the DIP block had the ESP's UART
    // on the USB socket while a credential was typed in.
    return true;
  }
  // Uptime cannot go backwards on a running part, so this is a reset. Equal is
  // not a reset: the Mega reports whole seconds and two pongs inside one second
  // are ordinary.
  return seconds < previousSeconds;
}

IdentityScreen identityScreen(bool wifiUp) {
  if (wifiUp) {
    return IdentityScreen{kIdentityOnlineLine1, kIdentityOnlineLine2};
  }
  return IdentityScreen{kIdentityOfflineLine1, kIdentityOfflineLine2};
}

} // namespace bridgelogic

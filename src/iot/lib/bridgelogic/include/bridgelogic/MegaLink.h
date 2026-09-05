// Crusaders Mainframe — the two link-level questions the bridge asks about the
// Mega, kept out of the composition root so the host suite can pin them.
//
// WHY THE IDENTITY SCREEN NEEDED A RULE
// -------------------------------------
// `showIdentityScreen()` — CONNECTED / SCAN TO START, or CLAIM CODE, or
// NO WIFI SET / `!WIFI,SSID,PASS` — was reachable from three places and none of
// them fires on the path that matters (review 3, finding 9): the WiFi up-edge,
// which a box with no credential never reaches; a Mega-restart test written as
// `seconds < gMegaUptime`, which starts at 0 so the FIRST `!PONG` can never
// satisfy it; and Reprovision. `setup()` never called it at all. So a
// technician who flashed the credential-free CI image, restored the run DIPs
// and saw the Mega's own idle text (CRUSADERS COURTS / SCAN TO START)
// reasonably concluded the credential had persisted, boxed the unit, and left
// a box that never joins — with three documents promising them a NO WIFI SET
// screen that no code path could paint.
//
// The rule is therefore two cases, not one: the FIRST pong of this boot, and a
// pong whose uptime went backwards. The first case is also what closes the DIP
// half of review 3 finding 19 — while the technician types `!WIFI` with DIP 5
// and 6 ON, the ESP's UART is on the USB socket and the Mega is not on the
// other end of it at all, so no pong has ever arrived; restoring DIP 1 and 2
// produces one, and that is the moment the glass can be told what the box is.
//
// No Arduino headers, no heap. Compiles for Xtensa and the host.

#ifndef CRUSADERS_BRIDGELOGIC_MEGALINK_H
#define CRUSADERS_BRIDGELOGIC_MEGALINK_H

#include <stdint.h>

namespace bridgelogic {

/// True when a `!PONG` means the Mega's screen cannot be trusted to say what
/// this box is.
///
/// `seenPong` is whether any pong has arrived since the bridge booted;
/// `previousSeconds` is the uptime the last one carried, `seconds` this one's.
/// A Mega that reset is back on its idle text and has no idea a claim is in
/// progress; a Mega that has only just appeared has never been told.
bool shouldRepaintIdentity(bool seenPong, uint32_t previousSeconds, uint32_t seconds);

} // namespace bridgelogic

#endif // CRUSADERS_BRIDGELOGIC_MEGALINK_H

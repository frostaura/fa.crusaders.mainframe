// Crusaders Mainframe — the two link-level questions the bridge asks about the
// Mega, kept out of the composition root so the host suite can pin them.
//
// WHY THE IDENTITY SCREEN NEEDED A RULE
// -------------------------------------
// `showIdentityScreen()` was reachable from three places and none of them fires
// on the path that matters (review 3, finding 9): the WiFi up-edge, which a box
// that never joins does not reach; a Mega-restart test written as
// `seconds < gMegaUptime`, which starts at 0 so the FIRST `!PONG` can never
// satisfy it; and a reprovision path that no longer exists. `setup()` never
// called it at all. So a technician who flashed the box, restored the run DIPs
// and saw the Mega's own idle text reasonably concluded it was working, boxed
// the unit, and left a box that never joins.
//
// The rule is therefore two cases, not one: the FIRST pong of this boot, and a
// pong whose uptime went backwards. The first case is what makes a DIP change
// visible on the glass at all — while the ESP is being flashed with DIP 5 and 6
// ON its UART is on the USB socket and the Mega is not on the other end of it,
// so no pong has ever arrived; restoring DIP 1 and 2 produces one, and that is
// the moment the glass can be told what the box is.
//
// THE TWO SCREENS
// ---------------
// There are exactly two now. `CONNECTED / SCAN TO START` once the box is on the
// WiFi; the Mega's own idle text while it is not. There is no CLAIM CODE screen
// because there is nothing to claim, and no NO WIFI SET screen because the
// credential is compiled in and cannot be missing at runtime. Both live here as
// constants so the composition root cannot paint a fourth one nothing tests.
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
/// A Mega that reset is back on its idle text and has no idea whether the
/// bridge is on the WiFi; a Mega that has only just appeared has never been
/// told.
bool shouldRepaintIdentity(bool seenPong, uint32_t previousSeconds, uint32_t seconds);

/// The box is on the club WiFi and ready to be scanned at.
inline constexpr char kIdentityOnlineLine1[] = "CONNECTED";
inline constexpr char kIdentityOnlineLine2[] = "SCAN TO START";

/// The box is not on the WiFi. The same words the Mega paints when it is idle,
/// deliberately: the court still works offline from the roster cache, so a
/// screen shouting an error at a member who can simply scan would be a lie in
/// the other direction. What the WiFi costs is walk-ups and fresh bookings, and
/// those refuse with their own lines when they are tried.
inline constexpr char kIdentityOfflineLine1[] = "CRUSADERS COURTS";
inline constexpr char kIdentityOfflineLine2[] = "SCAN TO START";

/// The two lines the glass should carry whenever the screen may be stale.
struct IdentityScreen {
  const char* line1;
  const char* line2;
};

/// Which of the two screens above, by whether the box is on the club WiFi.
///
/// A FUNCTION RATHER THAN A BRANCH IN THE COMPOSITION ROOT, because there were
/// two branches and one of them was wrong (D1-7). `loop()`'s pad-lapse repaint
/// painted the OFFLINE lines unconditionally while `showIdentityScreen()`, a
/// few lines away, chose properly — so a member who selected a court and walked
/// off left a box on the WiFi claiming to be offline until the next WiFi edge,
/// a Mega reset or a scan. `pio test -e native` filters `src/` out entirely, so
/// neither branch was reachable from a test and nothing said they had drifted.
IdentityScreen identityScreen(bool wifiUp);

/// When the Mega last booted, on THIS half's clock, from `!BOOT` (uptime 0)
/// and every `!PONG` (uptime in seconds).
///
/// A raw "uptime went backwards" test misses a reset whenever the bridge's last
/// figure was itself small — the `!BOOT` it just heard reads 0, so the next
/// reset's `!PONG` at 0 is not "less" (soak SOAK_SEED=110498118). The instant
/// the uptime implies (`now - uptime`) moves only when the Mega restarted, so a
/// jump of more than kSlackMs is a reset however young the previous boot was.
class MegaBootClock {
public:
  /// Seconds-resolution uptime plus a frame's transit: anything inside this is
  /// the same boot.
  static constexpr uint32_t kSlackMs = 3000UL;

  /// A `!PONG` (or `!BOOT`, with 0). True when it proves a restart since the
  /// previous observation.
  bool observe(uint32_t nowMs, uint32_t uptimeSeconds);

  bool seen() const { return seen_; }

private:
  uint32_t bootAtMs_ = 0U;
  bool seen_ = false;
};

/// When to ask the Mega for a `!PONG` because a line from it was LOST.
///
/// A Mega-only reset announces itself with `!BOOT` and then `!STATE`; if the
/// link garbles both, the bridge's next evidence used to be the Mega's own
/// periodic `!STATE` ten seconds later, and a paid court sat dark that long
/// (soak SOAK_SEED=114940677). A line that failed to decode is the one moment
/// the bridge KNOWS it missed something, so it answers with `!PING`: the
/// `!PONG`'s uptime regression is the reset trigger (`shouldRepaintIdentity`).
/// Paced by a small bucket — three at once, one more every five seconds — so
/// the losses a reset clusters (its `!BOOT`, its `!STATE`, a line just before)
/// each get their `!PING`, while a cable that garbles everything costs at most
/// one `!PONG` exchange (about 100 bytes) every five seconds, 2% of the link.
class MegaProbe {
public:
  static constexpr uint8_t kBurst = 3U;
  static constexpr uint32_t kRefillMs = 5000UL;

  /// An uplink line did not decode. True when a `!PING` should go now.
  bool lineLost(uint32_t nowMs);

private:
  uint8_t tokens_ = kBurst;
  uint32_t refilledAtMs_ = 0U;
  bool started_ = false;
};

} // namespace bridgelogic

#endif // CRUSADERS_BRIDGELOGIC_MEGALINK_H

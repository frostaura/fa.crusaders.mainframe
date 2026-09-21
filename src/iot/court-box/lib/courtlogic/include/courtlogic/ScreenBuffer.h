// Crusaders Mainframe — the glass: who owns it, and what takes a screen away.
//
// THE BUG THIS TYPE EXISTS TO MAKE UNREPRESENTABLE
// ------------------------------------------------
// A refusal screen the bridge painted for an unrecognised scan never left the
// panel. Three facts composed: `AuthWindow::arm(now, 0)` calls `disarm()`,
// `disarm()` does not set the lapse edge, and any `!LCD` disarmed the Mega's
// only other timer. So for a scan the API did not recognise — the bridge sends
// `!LCD,<refusal>` and then `!AUTH,0` — BOTH paths back to the idle screen were
// shut, and because the window was also shut every button press was dropped as
// unauthorised. Fifty seconds into the reproduction the glass still read
// `NOT RECOGNISED / SEE THE DESK` and the only uplink was the periodic
// `!STATE`. That is "some screens never leave and no buttons work to close it",
// exactly, and it was intermittent BY MEMBERSHIP STATUS — a recognised refusal
// recovered after thirty seconds because its window lapsed naturally — which is
// why it survived review.
//
// The fix is structural, not a timeout added to each screen. Every screen the
// bridge paints is an OVERLAY and an overlay cannot outlive its deadline, which
// the decoder clamps into [1, 120] seconds. No screen — not one from a future
// firmware, not one from a confused firmware, not one from a bridge that has
// stopped running — can persist past two minutes. A screen added next year
// inherits that without anybody remembering to.
//
// WHY THE TIMER AND THE LANDING SCREEN ARE ON THE MEGA
// ----------------------------------------------------
// THE ESP IS THE HALF THAT GOES AWAY. That is the founding argument of the
// Mega/ESP split (court-box/README.md): the relay auto-off timer lives here
// precisely because "if the ESP hangs, the WiFi drops and the backend dies, the
// lights still go off". A screen-revert timer on the ESP is a timer that stops
// when the ESP crashes — and every stuck screen is a screen whose only possible
// rescuer is the half that just failed.
//
// The Mega also already holds the truth worth showing. RelayGuard is the
// authority on every court's remaining time; rendering it here costs ZERO link
// bandwidth, where pushing a per-second countdown from the ESP over 9600 baud
// would cost ~117 ms of every second if the whole screen were repainted.
//
// What does NOT move here is the COPY. The Mega is the half that cannot be
// reflashed without a screwdriver, and verdict wording is exactly the thing a
// club changes its mind about. Words stay on the ESP; MECHANISM lives here.
//
// THE LAYOUT CONTRACT
// -------------------
//   row 0  title — what is true
//   row 1  detail — the number, or the reason
//   row 2  live court state, or secondary detail
//   row 3  what to press, plus a countdown or a clock in the right-hand cells
// Zones never swap meaning between screens, and **rows 0-1 truncated at
// court::kSafeSubsetCols are a complete message on every screen**, so a 1602
// fitted by mistake degrades to the old behaviour rather than to half a
// sentence. Rows 2-3 and the columns past 16 carry enrichment only.
//
// NO CUSTOM GLYPHS, DELIBERATELY. The countdown is plain digits. A bar would
// cost CGRAM that the I2C re-sync path has to restore after every bus wedge,
// and it carries no information the digits do not.
//
// No Arduino headers, no heap, no String/std::string/std::vector. This links
// into an ATmega2560 with 8 KB of SRAM.

#ifndef CRUSADERS_COURTLOGIC_SCREENBUFFER_H
#define CRUSADERS_COURTLOGIC_SCREENBUFFER_H

#include <stddef.h>
#include <stdint.h>

#include "hal/Display.h"

#include "courtlogic/RelayGuard.h"
#include "protocol/Protocol.h"
#include "timebase/TimeBase.h"

namespace courtlogic {

/// The two lines shown when nothing else is.
///
/// A VERBAL CALL TO ACTION, not branding. An idle kiosk that shows only a name
/// is one people walk past; the second line is the instruction, and it is the
/// line a member who has never used the box reads first.
inline constexpr char kIdleLine1[] = "CRUSADERS COURTS";
inline constexpr char kIdleLine2[] = "SCAN YOUR CODE";

/// Painted the instant a scan completes, before any answer exists.
///
/// The sketch this replaces painted "VERIFYING..." on every scan; v2 moved
/// every scan-path LCD write to the ESP, so with the bridge crashed, rebooting
/// or mid-failed-flash a scan produced NO visible change and members re-scanned
/// until they reported the scanner as broken. This is local feedback only — no
/// decision moves onto the Mega — and the bridge's own answer replaces it
/// within a second when the bridge is alive.
inline constexpr char kScanFeedbackLine1[] = "CHECKING YOUR CODE";
inline constexpr char kScanFeedbackLine2[] = "";
inline constexpr char kScanFeedbackLine3[] = "Please wait";

/// How long an overlay stands when nobody said. Ten seconds is GOAL item 1's
/// number and the old scan-feedback timeout, kept, made the DEFAULT rather than
/// the only value, and — the point — no longer cancellable by a repaint.
#ifdef LCD_REVERT_MS
inline constexpr uint32_t kDefaultHoldMs = LCD_REVERT_MS;
#else
inline constexpr uint32_t kDefaultHoldMs = 10000UL;
#endif

/// How long a hint stands in the action row before it reverts.
#ifdef LCD_HINT_MS
inline constexpr uint32_t kHintMs = LCD_HINT_MS;
#else
inline constexpr uint32_t kHintMs = 3000UL;
#endif

/// The shortest gap between two hints.
///
/// A stuck button holds itself down for ever and the panel has no debounce
/// beyond ButtonPanel's; without this, one jammed contact strobes the glass and
/// floods the I2C bus at loop rate, which is a worse failure than the dead
/// button it is reporting.
inline constexpr uint32_t kHintRateLimitMs = 2000UL;

/// How often the landing screen's live cells and the countdown are repainted.
/// One row per second, ~21 I2C writes, entirely local: no serial traffic.
inline constexpr uint32_t kLandingRefreshMs = 1000UL;

/// The right-hand zone of the action row: a clock or a countdown, NEVER both.
///
/// TWO WIDTHS, and the difference is load-bearing rather than fussy. `hh:mm` is
/// five characters and appears only on the LANDING screen, whose left text this
/// file owns and holds to fifteen columns. A countdown is at most three digits
/// and appears on OVERLAYS, whose action row is written by the other half of
/// the board and is held by contract to sixteen columns — so a five-column
/// countdown zone would silently eat the sixteenth character of every screen
/// that carries one. They are the same zone to a reader and two different
/// numbers to the glass.
inline constexpr uint8_t kClockCols = 5U;
inline constexpr uint8_t kCountdownCols = 4U;

/// On a panel WIDER than the safe subset the countdown must sit entirely to the
/// right of it, or it eats the sixteenth character of every action row written
/// to the contract. On a panel that IS the safe subset there is no room to the
/// right of it and the overlap is the documented degradation — rows 0-1 still
/// carry the whole message, which is the only thing the contract promises.
static_assert(hal::kDisplayCols <= hal::kSafeSubsetCols ||
                  kCountdownCols + hal::kSafeSubsetCols <= hal::kDisplayCols,
              "on a wide panel the countdown would overwrite the last column of an action row "
              "written to the 16-column contract");

/// Seconds at which the countdown starts saying what it MEANS rather than just
/// counting. Below this the action row reads `READY IN <n> s`, which is GOAL
/// item 18's "time left, then ready" made visible without a second state that
/// could get stuck.
inline constexpr uint16_t kReadyInSeconds = 5U;

/// Link-state bits carried by `!IDLE`. The box is READY in all of them, because
/// the box always accepts a scan: the offline roster path works, and a screen
/// shouting an error at a member who can simply scan is a lie in the other
/// direction.
inline constexpr uint8_t kLinkWifiUp = 0x01U;
inline constexpr uint8_t kLinkApiUp = 0x02U;
inline constexpr uint8_t kLinkClockValid = 0x04U;
inline constexpr uint8_t kLinkRestorePending = 0x08U;

/// `!SHOW` flag bits.
///
/// bit1 is what lets the BRIDGE answer a press it could not act on without
/// wiping the screen underneath. The Mega can only ever know ONE reason a press
/// was dropped — its window was shut — because it has no button map and no
/// notion of a half-made purchase. "That button does nothing here" and "choose
/// a court first" are the bridge's to say, and saying them with a full overlay
/// would take away the screen the member was reading. So the bridge stages row
/// 3 alone and commits it with this bit: the action row is replaced for the
/// hold and then put back, and rows 0-2 are never touched.
inline constexpr uint8_t kShowCountdown = 0x01U;
inline constexpr uint8_t kShowActionRowOnly = 0x02U;

/// The panel, the overlay deadline, the landing screen and the hint row.
///
/// Held by CourtBox, which gives it every frame that is about the glass and one
/// call per pass. It never reads the clock itself: `nowMs` is threaded through
/// so every sub-step of a pass is evaluated against the same instant, which is
/// the rule CourtBox::poll commits to.
class ScreenBuffer {
public:
  explicit ScreenBuffer(hal::IDisplayPort& display);

  /// True for the verbs this owns. CourtBox's dispatch chain gains ONE branch
  /// rather than five: its own comment records that the chain is already at the
  /// complexity gate's limit.
  static bool owns(proto::Verb verb);

  /// Landing screen, no overlay, no hint. Both the power-on state and `!RST`.
  void begin(uint32_t nowMs);

  /// `!ROW` — stage one row. Paints nothing.
  void stageRow(uint8_t row, const char* text);

  /// `!SHOW` — commit the staged rows ATOMICALLY and arm the revert deadline.
  ///
  /// Atomic because a two-row repaint made of two writes is a repaint the
  /// member SEES half of: the old screen's second line under the new screen's
  /// first, for one I2C write. `CRUSADERS COURTS / 45 MIN` was the observed
  /// torn frame.
  ///
  /// `seconds` is clamped again here even though the decoder clamped it: this
  /// class is also reachable from a caller that did not come off the wire, and
  /// the clamp is the whole safety property.
  void show(uint32_t seconds, uint8_t flags, uint32_t nowMs);

  /// `!LCD` — the two-row form, kept and now given a deadline.
  ///
  /// This is what makes the fix hold for a bridge that has NOT been reflashed:
  /// an un-upgraded bridge sending only `!LCD` can no longer produce a screen
  /// that never leaves.
  void overlay(const char* line1, const char* line2, uint32_t nowMs);

  /// `!IDLE` — what the landing screen's action row says, and the club's wall
  /// time. `hhmm` is four digits or proto::kNoClock.
  void setLink(uint8_t flags, const char* hhmm, uint32_t nowMs);

  /// `!MAP` — the club court number behind each relay, 0 for unmapped. A relay
  /// the heartbeat never mapped renders BLANK, not as a dark court: the box
  /// does not drive it and should not claim to.
  void setCourtNumbers(const int16_t numbers[hal::kRelayChannelCount]);

  /// A press that was dropped because the window was shut. Rate-limited;
  /// replaces the action row for kHintMs and then puts it back.
  ///
  /// This is the other half of "buttons that do nothing": the DROP is correct —
  /// a press queued until the next window opens would fire a relay on the NEXT
  /// member's scan, which is the unexpiring-flag defect the window exists to
  /// close — but the SILENCE was not. Six presses across all eight channels
  /// produced no frame, no pixel and no sound, and the box was
  /// indistinguishable from broken. It is worse than it sounds, because the
  /// stuck-screen bug shut the window too: a member facing a frozen screen was
  /// pressing buttons that were guaranteed to do nothing.
  ///
  /// One cause, because one cause is all this half can honestly distinguish.
  /// The bridge's two — "choose a court first" and "that button is unused" —
  /// arrive as an action-row-only `!SHOW`; see kShowActionRowOnly.
  void hint(uint32_t nowMs);

  /// Any debounced press, whether or not it was forwarded.
  ///
  /// Re-arms the current hold. That is the "simple action" a timed response is
  /// owed: a member part-way through choosing does not lose the choice because
  /// they were reading. It is free — the Mega sees every debounced press
  /// whether or not the window lets it through.
  void noteActivity(uint32_t nowMs);

  /// One pass: expire the hint, expire the overlay, and repaint the live cells
  /// at most once a second.
  void poll(const RelayGuard& relays, uint32_t nowMs);

  bool overlayActive() const { return hold_.isArmed(); }

  /// Hints suppressed by the rate limit. A climbing count is a stuck button,
  /// and it is the counter that tells a jammed contact apart from a quiet box.
  uint16_t suppressedHints() const { return suppressedHints_; }

private:
  void paintRow(uint8_t row, const char* text);
  void commit();
  void renderLanding(const RelayGuard& relays, uint32_t nowMs);
  void renderCourtRow(const RelayGuard& relays, uint32_t nowMs, char* out) const;
  void renderActionRow(uint32_t nowMs, char* out) const;
  void refreshLive(const RelayGuard& relays, uint32_t nowMs);
  void writeTail(char* row, const char* tail, uint8_t width) const;
  void writeCountdown(char* row, uint16_t seconds) const;
  uint16_t holdLeftSeconds(uint32_t nowMs) const;
  bool showActionRowOnly(uint32_t seconds, uint32_t nowMs);
  bool hintRateLimited(uint32_t nowMs);

  hal::IDisplayPort& display_;

  /// What `!ROW` writes into and what `!SHOW` commits. Separate from the live
  /// copy so a bridge staging the NEXT screen cannot corrupt the one a member
  /// is reading.
  char staged_[proto::kMaxRows][hal::kDisplayCols + 1U];

  /// What is on the glass now, so the action row can be re-derived after a hint
  /// without asking the bridge to repaint.
  char live_[proto::kMaxRows][hal::kDisplayCols + 1U];

  tb::Deadline hold_;
  tb::Deadline hintUntil_;
  tb::Deadline hintAllowedAt_;
  tb::Deadline refresh_;

  /// What the current hold was armed FOR, so any press can re-arm it to the
  /// same length rather than to a default.
  uint32_t holdMs_;

  /// Minute of the club's day, or kNoClockMinute. Advanced on millis() between
  /// heartbeats so the glass is right in the gaps; BLANKED rather than allowed
  /// to go stale, because loading, failed and empty are three different states
  /// and a stale clock is the one that lies.
  static constexpr uint16_t kNoClockMinute = 0xFFFFU;
  uint16_t clockMinute_;
  uint32_t clockStampMs_;

  int16_t courtNumbers_[hal::kRelayChannelCount];

  uint8_t linkFlags_;
  uint8_t showFlags_;
  uint16_t suppressedHints_;
};

} // namespace courtlogic

#endif // CRUSADERS_COURTLOGIC_SCREENBUFFER_H

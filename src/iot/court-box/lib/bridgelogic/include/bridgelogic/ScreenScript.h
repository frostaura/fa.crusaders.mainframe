// Crusaders Mainframe — one value that describes a whole screen.
//
// WHY A SCREEN IS ONE VALUE AND NOT FOUR CALLS
// --------------------------------------------
// `settleScan` already gives the online path and the offline roster path one
// guarantee about the RELAY: both go through the same function, so they cannot
// disagree about which court is lit or for how long. The glass had no such
// guarantee. Every screen was two string literals composed at whichever call
// site happened to need them — `main.cpp` for five of them, `ScanFlow.cpp` for
// six, `WalkUp.cpp` for nine — so "the same situation" read differently
// depending on which path decided it, and nothing anywhere could look at all
// the screens at once.
//
// A Screen is therefore ONE value: four rows, a hold, and a flag. It is built
// here, from a table, and the table is what the layout contract below is tested
// against. A screen that breaks the contract fails a test rather than reaching
// a member standing in a corridor.
//
// THE LAYOUT CONTRACT — enforced by a table-driven test over EVERY screen
// -----------------------------------------------------------------------
//  1. Rows 0-1, truncated at court::kSafeSubsetCols (16), must be a COMPLETE
//     and CORRECT message: non-empty, not ending mid-word, and carrying the
//     screen's key noun. A 1602 fitted by mistake degrades to today's
//     behaviour, never to a lie or to half a sentence.
//  2. Row 3 columns 0-15 name what to press; columns 16-19 carry the countdown
//     or the clock, never both — so row 3's text is bounded at 16 whatever the
//     panel is.
//  3. Zones never swap meaning between screens: row 0 is the title (what is
//     true), row 1 the detail (the number, the reason), row 2 live state or
//     secondary detail, row 3 the action row.
//  4. Nothing on the glass is ever a code, an id, or a number the member did
//     not choose. A club court number is a number the member chose when they
//     booked; a booking id, a token and a relay index are not.
//
// THE ONE CARVE-OUT FROM RULE 1, stated rather than smuggled: a greeting row is
// `HI <NAME>`, and a sixteen-character name clipped at column 16 is a SHORTENED
// NAME, not a broken sentence — the message is still complete and still
// correct. The contract test names this exception explicitly and still holds
// the row to the panel's own width.
//
// WHY THE ACTION ROW COMES FROM THE LIVE BUTTON MAP
// -------------------------------------------------
// Because the panel is remappable and the glass is not the authority on it. A
// club that maps `minutes:20` must read `20`; a slot mapped `off` or `none` is
// a button that does nothing and renders blank rather than advertising a
// duration that is not there. Hardcoding `15 30 45 60` is how a screen tells a
// member to press a button that buys something else.
//
// CARL'S FLOW IS Scan -> card -> court -> time, AND A BOOKED MEMBER IS ASKED
// NEITHER QUESTION. Their court and their length are already decided; asking is
// slower and is a second thing to get wrong. Decisively, THE PANEL HAS NO OK
// BUTTON — the eight buttons are four courts and four durations — so "press any
// button to confirm" maps onto nothing and would fire a court selection. The
// card still appears, so the flow still reads as Scan -> card -> court -> time;
// for a booking the last two are answered before the member arrives. There is
// no confirm press here and a booked member cannot override their court at the
// panel: the booking names the court, and a button that can name its own court
// is a button that opens any court in the club.
//
// No Arduino headers, no heap, no String. Compiles for Xtensa and the host.

#ifndef CRUSADERS_BRIDGELOGIC_SCREENSCRIPT_H
#define CRUSADERS_BRIDGELOGIC_SCREENSCRIPT_H

#include <stddef.h>
#include <stdint.h>

#include "bridgelogic/WallClock.h"
#include "devlink/LcdSettings.h"
#include "court/ButtonMap.h"
#include "court/Session.h"
#include "protocol/Protocol.h"

namespace bridgelogic {

/// `!SHOW`'s flags. bit0 asks the Mega for a countdown in row 3's right-hand
/// four columns; the other bits are unallocated and MUST stay zero, because a
/// bit this build sets and the Mega does not know is a screen nobody designed.
inline constexpr uint8_t kShowFlagCountdown = 0x01U;

/// The tenant's `lcd_revert_seconds`: how long a verdict stands before the Mega
/// reverts to its landing screen. Ten seconds is long enough to read twice and
/// short enough that the next member is not looking at somebody else's refusal.
inline constexpr uint16_t kRevertSeconds = 10U;

/// The tenant's `lcd_choice_seconds`. Longer than a verdict because a member is
/// mid-decision rather than reading an answer — a half-made purchase is the one
/// thing on this box a timeout can actually lose.
inline constexpr uint16_t kChoiceSeconds = 20U;

/// The tenant's `lcd_card_seconds`: the greeting card, which is an
/// acknowledgement and not a thing to read.
inline constexpr uint16_t kCardSeconds = 2U;

/// The "one moment" hold: the 4 s HTTP bound plus slack. NEVER indefinite —
/// a screen with no deadline is the failure proto::kShowHoldMaxSeconds exists
/// to make unrepresentable, and this one sits in front of a blocking call that
/// can end in a reset.
inline constexpr uint16_t kWaitSeconds = 6U;

/// Longest `member_display` the box will render. The server truncates to this,
/// so the firmware never has to — and `devapi::json` REFUSES rather than
/// truncates, so a longer one degrades to kNoName rather than to half a name.
inline constexpr size_t kMaxMemberNameLen = 16U;

/// What a member is greeted as when the API identified nobody, or sent a name
/// this build could not take whole. Honest, and never a missing screen.
inline constexpr char kNoName[] = "THERE";

/// Columns per cell of the action row: four cells at columns 0, 4, 8 and 12.
///
/// FOUR RATHER THAN FIVE, which is what makes rule 2 satisfiable. Five-wide
/// cells put a two-digit label in the fourth cell at columns 15-16, which is
/// inside the countdown zone — so the countdown would overwrite the last
/// duration a member can press. Four-wide holds every label this panel can
/// carry (a duration is at most 90, a court letter is one character) inside
/// columns 0-15.
inline constexpr size_t kActionCellCols = 4U;

/// Physical button the court cells and the duration cells start at. The cell
/// position IS the button position, which is what makes the row readable at
/// all: the member looks at the glass and then at the button under it.
inline constexpr uint8_t kCourtCellsFrom = 0U;
inline constexpr uint8_t kDurationCellsFrom = 4U;

/// One screen, as the bridge stages it: `!ROW` per non-empty row, then `!SHOW`.
struct Screen {
  char rows[proto::kMaxRows][court::kLineLen + 1U];
  /// Clamped by the wire anyway — proto::kShowHoldMinSeconds..MaxSeconds — and
  /// held inside those bounds here too, so the value a test reads is the value
  /// the Mega will act on.
  uint16_t holdSeconds;
  uint8_t flags;
};

/// Every screen this box can paint. Contiguous from zero: kScreenSpecs is
/// indexed by the value, and the whole point of the contract test is that it
/// can walk all of them.
enum class ScreenId : uint8_t {
  /// A court was lit for this member, by any path.
  Grant = 0U,
  /// They scanned again on a court this box already has lit.
  AlreadyOn,
  NoBooking,
  InsufficientBalance,
  WrongCourt,
  TooEarly,
  NotRecognised,
  /// The slot is over — `ended`, or an `activated:true` with nothing left.
  SlotEnded,
  CourtInUse,
  NoTimeAvailable,
  MinutesOutOfRange,
  ClubClosed,
  PurchaseEnded,
  ActivationRefused,
  /// HTTP status 0: the box could not reach the server at all.
  NoConnection,
  /// Anything else. The only screen that is allowed to be vague.
  SeeTheDesk,
  /// The `!ON` never left the bridge.
  OnNotSent,
  /// An OFF press on a court this member's window is not bound to.
  NotYourCourt,
  /// A duration press with no scan behind it.
  ScanFirst,
  /// A court is selected and the box is waiting for a duration.
  ChooseTime,
  /// A walk-up purchase is in flight.
  OneMoment,
  /// The card, for a member the API named who has a booking.
  CardBooked,
  /// The card, for a member the API named who has no booking.
  CardNoBooking,
  /// The card on the OFFLINE roster path, where the box has no member name.
  /// The roster carries tokens and courts; putting sixteen names in a
  /// 2048-byte heartbeat body to greet somebody is not a trade worth making,
  /// and `BOOKING FOUND` is honest where `HI THERE` on a named-member screen
  /// would be a shrug.
  CardBookedOffline,
};

inline constexpr uint8_t kScreenCount = 24U;

/// Everything any screen might name. One struct rather than a parameter list
/// because the complexity gate caps a function at six arguments and this is
/// eleven — and because `court` and `courtNumber` are both small integers that
/// would swap at a call site with nothing failing to compile.
struct ScreenFacts {
  /// Relay index 0-3, rendered as A-D. Never shown as a number: a relay index
  /// is not something the member chose (rule 4).
  uint8_t court = 0U;
  /// The CLUB's court number, which the member did choose when they booked.
  int16_t courtNumber = 0;
  /// Minutes — granted, remaining, or the most that can be bought.
  uint32_t minutes = 0U;
  /// `HH:MM`, or EMPTY when the clock is not trusted. Every time on the glass
  /// comes from bridgelogic::WallClock, which blanks rather than guesses; a row
  /// whose only content is a blanked time renders blank rather than "Ends ".
  char endsAt[kDisplayTimeLen] = {};
  char atTime[kDisplayTimeLen] = {};
  char fromTime[kDisplayTimeLen] = {};
  char toTime[kDisplayTimeLen] = {};
  /// `member_display`, or empty for kNoName.
  char name[kMaxMemberNameLen + 1U] = {};
  /// The LIVE panel. Null falls back to the compiled-in default map, which is
  /// the original wiring — the same rule court::ButtonMap follows.
  const court::ButtonMap* buttons = nullptr;
};

/// Which tenant setting a screen's hold comes from.
///
/// A CLASS rather than a number, because the composition root must not have to
/// recognise a hold by its VALUE to know which setting replaces it — that is a
/// mapping that breaks silently the day two defaults coincide.
enum class HoldClass : uint8_t {
  /// `lcd_revert_seconds`: a verdict, read once and gone.
  Revert = 0U,
  /// `lcd_choice_seconds`: the member is mid-decision, not reading an answer.
  Choice,
  /// `lcd_card_seconds`: an acknowledgement, not a thing to read.
  Card,
  /// The blocking call's own bound plus slack. NOT a tenant setting: a club
  /// cannot be allowed to set this longer than the call it sits in front of.
  Wait,
};

/// The hold class of `id`, for a caller that needs to know before it has a
/// Screen — or that is reporting on one.
HoldClass holdClassOf(ScreenId id);

/// The screen for `id`, filled from `facts`.
Screen screenFor(ScreenId id, const ScreenFacts& facts);

/// The same screen with its hold taken from the tenant's adopted settings.
///
/// NONE OF THEM RETROACTIVELY: this is applied as a screen is BUILT, so a hold
/// that shortened while somebody was looking at a screen does not cut the one
/// they are reading. The Wait class ignores the settings entirely — a club must
/// not be able to set the "one moment" screen longer than the HTTP call it
/// stands in front of, because that is how a screen outlives the reset that
/// call can end in.
Screen screenFor(ScreenId id, const ScreenFacts& facts, const devlink::LcdSettings& settings);

/// Renders one action row: four cells of kActionCellCols columns, taken from
/// physical buttons `from`..`from+3` of `map`. A SelectCourt cell renders its
/// letter, a GrantMinutes cell its minutes, and an `off`- or `none`-mapped slot
/// renders BLANK — a button that does nothing must not advertise a duration.
void renderActionRow(const court::ButtonMap& map, uint8_t from, char* out, size_t cap);

/// Copies `member_display` into `facts.name`, or leaves it empty for kNoName.
///
/// Reads it TOLERANTLY: absent is the ordinary case for a refusal the API
/// produced before it resolved anybody, and for every response until the
/// backend starts sending the field at all. A name that will not fit is
/// REFUSED by devapi::json rather than truncated — half a name is a different
/// member — and degrades to kNoName rather than to a missing screen.
void readMemberDisplay(const char* body, size_t len, ScreenFacts& facts);

} // namespace bridgelogic

#endif // CRUSADERS_BRIDGELOGIC_SCREENSCRIPT_H

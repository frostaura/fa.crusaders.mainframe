// Crusaders Mainframe — court box serial protocol, value types.
//
// WHY THIS EXISTS
// ---------------
// The link is Mega Serial3 <-> ESP8266 Serial, 9600 8N1, over jumper wires that
// run next to four switching relay coils. The wiring cannot change. Carl's
// original protocol — one bare character per message, no checksum — has two
// defects that a server-driven system cannot survive:
//
//   1. `A` closes relay A and NOTHING in the firmware ever opens it. The off
//      command was scheduled by a VBA macro on a Windows PC. If that PC sleeps,
//      the court lights stay on indefinitely. The message has nowhere to put a
//      duration, so this is a protocol defect, not an implementation one.
//   2. A corrupted `a` that arrives as `A` turns lights on and leaves them on,
//      and there is no way to tell it from a legitimate command.
//
// v2 is `!VERB,arg1,arg2*CC\n` — sentinel, verb, escaped arguments, NMEA-style
// XOR checksum, terminator. It is strictly additive: every legacy verb still
// decodes, and there is an encoder mode that emits legacy lines, so a v2 Mega
// paired with a legacy bridge behaves exactly as today.
//
// THE SAFETY RULE, AND WHY IT IS A TYPE AND NOT A COMMENT
// -------------------------------------------------------
// `Frame::on()` takes the duration as a REQUIRED constructor argument. There is
// no public default constructor that yields Verb::On, no setter for the verb,
// and no setter for the arguments. An indefinite-on is therefore not
// representable: you cannot forget the duration, because there is no overload
// that lets you.
//
// The wire path is held to the same rule by kVerbSpecs, which is constexpr and
// static_asserted below: ON's minArgs is 2 and its secondsArg is 1, so the
// decoder cannot mint an ON frame from a line that carries no duration. The
// decoder additionally routes ON through Frame::on() itself — belt and braces,
// because this is the single most expensive failure the system can have.
//
// Durations are CLAMPED, never rejected. A clamped light is a wrong-length
// game; a rejected one is a dark court with a member standing in it.
//
// No Arduino headers, no heap, no String/std::string/std::vector. This links
// into an ATmega2560 with 8 KB of SRAM.

#ifndef CRUSADERS_PROTOCOL_H
#define CRUSADERS_PROTOCOL_H

#include <stddef.h>
#include <stdint.h>

namespace proto {

/// The widest frame is `!STATE,<mask>,<remA>,<remB>,<remC>,<remD>` — five
/// arguments. Nothing in the protocol needs more, so the array is sized exactly
/// and the decoder reports BADARG rather than growing.
inline constexpr size_t kMaxArgs = 5;

/// Longest single argument, after unescaping. The LCD is driven as 16 columns
/// and a scanner code is short; 24 leaves headroom without spending SRAM the
/// Mega does not have.
inline constexpr size_t kMaxArgLen = 24;

/// Buffer size that is guaranteed to hold any frame the named constructors can
/// produce, terminator included. Derivation: the only verbs whose arguments can
/// contain escapable bytes are LCD, SCAN, EVT and ERR, and none of those has
/// more than two arguments. Worst case is LCD with two 24-byte arguments that
/// are entirely commas, each expanding 3x:
///     '!' + "LCD" + (',' + 72) + (',' + 72) + '*' + 2 + '\n' == 154.
/// STATE's five arguments are numeric and never escape, so it is far shorter.
/// 192 covers both with room to spare and is also the decoder's line buffer:
/// a longer line is an OVERRUN, not a silent truncation.
inline constexpr size_t kMaxFrameLen = 192;

/// RELAY_HARD_CAP_MS / 1000. The upper clamp for every duration on the wire.
inline constexpr uint16_t kRelayHardCapSeconds = 5400;

/// Lower clamp for a relay duration. Zero is not a legal ON: it would be an
/// indefinite-on by another name if any consumer read it as "no limit".
inline constexpr uint16_t kRelayMinSeconds = 1;

/// AUTH_TTL_MS / 1000. The window a legacy `<line1>|<line2>` implies, since the
/// legacy protocol arms the buttons as a side effect of showing that prompt.
inline constexpr uint16_t kAuthDefaultSeconds = 30;

/// Rows the overlay protocol can address, 0-3.
///
/// A PROTOCOL constant, not a display one: the wire must mean the same thing
/// whatever panel is fitted, so `!ROW,3` is a well-formed frame on a box built
/// for a 1602 and the DISPLAY layer is what drops a row it does not have. The
/// two are held together by a static_assert on the device side
/// (courtlogic/CourtBox.cpp), which is where a header that knows about both
/// belongs — the same rule bridgelogic/RosterTokenFits.h follows.
inline constexpr uint8_t kMaxRows = 4;

/// The bounds on a `!SHOW` hold, and the whole of GOAL items 11 and 15.
///
/// Every screen the bridge paints is an OVERLAY with a deadline, and the
/// deadline is clamped HERE — on the way in, by the Mega, out of reach of any
/// configuration. No screen a bridge paints can persist past two minutes:
/// not one from a future firmware, not one from a confused firmware, and not
/// one from a bridge that has stopped running at all. That is the structural
/// version of "put a timeout on every screen", which is the version that
/// survives somebody adding a screen and forgetting.
///
/// The lower bound exists for the same reason kRelayMinSeconds does: zero is a
/// permanent screen wearing a timeout's clothes if any consumer reads it as
/// "no limit".
inline constexpr uint16_t kShowHoldMinSeconds = 1;
inline constexpr uint16_t kShowHoldMaxSeconds = 120;

/// What `!IDLE` carries instead of `hhmm` when the box does not trust its
/// clock. A blank clock is honest; a stale one is not.
inline constexpr char kNoClock[] = "----";

#ifdef LCD_HOLD_MAX_MS
static_assert(LCD_HOLD_MAX_MS == static_cast<uint32_t>(kShowHoldMaxSeconds) * 1000UL,
              "kShowHoldMaxSeconds and the court_mega build flag have drifted apart");
#endif

#ifdef RELAY_HARD_CAP_MS
static_assert(RELAY_HARD_CAP_MS == 5400000UL,
              "kRelayHardCapSeconds and the court_mega build flag have drifted apart");
#endif

#ifdef AUTH_TTL_MS
static_assert(AUTH_TTL_MS == 30000UL,
              "kAuthDefaultSeconds and the court_bridge build flag have drifted apart");
#endif

/// Every verb in the protocol, both directions. Values are contiguous from 0
/// because kVerbSpecs is indexed by them.
enum class Verb : uint8_t {
  Unknown = 0,
  // Downlink: bridge -> Mega.
  On,
  Off,
  Ext,
  Lcd,
  Auth,
  Rst,
  Ping,
  // Uplink: Mega -> bridge.
  Btn,
  Scan,
  State,
  Pong,
  Evt,
  Err,
  // APPEND-ONLY BELOW THIS LINE. kVerbSpecs is indexed by the value, so a new
  // verb goes at the END and nothing is ever reordered — which is why these
  // four downlink verbs sit after the uplink block rather than with their own
  // direction. Direction is kVerbSpecs's business and the decoder's, not the
  // enum's ordering.
  Row,  ///< Downlink. Stage one row of the pending overlay. Paints nothing.
  Show, ///< Downlink. Commit the staged rows atomically and arm their deadline.
  Idle, ///< Downlink. What the Mega-rendered landing screen's status row says.
  Map,  ///< Downlink. The club court number behind each relay index.
  // v3 (Mega 3.0.0 / bridge 3.0.0), appended in the order the spec fixes:
  // RW CMT WANT CFG LAND NOTE LIVE ACK BOOT HELD DIAG HW. 3.0.0 is the last Mega
  // image, so these are every frame a future bridge can steer it with.
  Rw,   ///< Downlink. Stage a 24-character segment of one row of screen <seq>.
  Cmt,  ///< Downlink. Commit screen <seq>: row mask, hold, flags, CRC-16.
  Want, ///< Downlink. Relay reconcile: ensure each relay lit for at least N s.
  Cfg,  ///< Downlink. Set one bounded Mega setting.
  Land, ///< Downlink. Paid seconds per relay for the landing.
  Note, ///< Downlink. A landing note in the status slot, with a TTL.
  Live, ///< Downlink. Bridge liveness: the next frame within <period> s.
  Ack,  ///< Uplink. Tagged frame or screen commit acknowledged, with a code.
  Boot, ///< Uplink. First frame after every Mega reset.
  Held, ///< Uplink. A key chord held inside the boot window.
  Diag, ///< Uplink. Since-boot counters, after every !PONG.
  // The 2026-11-13 addendum (hardware facts), appended after DIAG.
  Hw, ///< Uplink. The hardware facts the Mega is actually running with.
};

inline constexpr size_t kVerbCount = 30;

/// Which decoder may produce a verb. v2's verbs are Any — the Mega application
/// already answers a v2 uplink verb on its downlink with `!ERR,BADVERB`, and
/// the corpus pins a v2 `!SCAN` decoding on the downlink — so the direction
/// check the v3 chapter adds is enforced at the decoder for the verbs v3
/// added, where nothing older depends on the looser rule.
enum class Dir : uint8_t { Any = 0, Down, Up };

/// The tag on a v3 relay frame and the id in `!ACK`: 1..255, 0 = untagged.
inline constexpr uint8_t kNoTag = 0U;

/// v3 bounds the decoder clamps into (the per-key `!CFG` clamp is the Mega
/// application's, not the codec's).
inline constexpr uint32_t kLandMaxSeconds = 86400UL;
inline constexpr uint16_t kNoteMaxSeconds = 3600U;
inline constexpr uint16_t kLiveMinSeconds = 1U;
inline constexpr uint16_t kLiveMaxSeconds = 120U;
inline constexpr uint16_t kHeldMinSeconds = 5U;
inline constexpr uint16_t kHeldMaxSeconds = 60U;
inline constexpr uint8_t kRwSegment = 24U; ///< A row is up to two segments, offset 0 and 24.
inline constexpr uint8_t kRowTextMax = 48U;
inline constexpr uint8_t kAckMaxCode = 4U;

/// `!ACK` codes.
enum class AckCode : uint8_t { Applied = 0, Duplicate = 1, Refused = 2, Incomplete = 3, Busy = 4 };

/// The "no opinion" spelling of a `!WANT` or `!LAND` slot, as a number.
inline constexpr int32_t kNoOpinion = -1;

/// Courts are A-D. Making this an enum rather than a char means a Frame cannot
/// carry a court that does not exist; NOCOURT is a decode-time verdict about
/// bytes on the wire, never a state a constructed Frame can be in.
enum class Court : uint8_t { A = 0, B, C, D };

/// The eight physical buttons: four court selectors and four duration slots.
enum class Key : uint8_t { CourtA = 0, CourtB, CourtC, CourtD, Slot1, Slot2, Slot3, Slot4 };

/// Why a line did not become a Frame.
///
/// The first four are the `!ERR,<code>` codes; the last two are the
/// `!EVT,<name>` names. They share one enum because the decoder produces all
/// six and the caller decides which channel to report each on.
enum class DecodeError : uint8_t {
  None = 0,
  BadCrc,   ///< Checksum mismatch. The frame is DROPPED, never guessed at.
  BadVerb,  ///< Well-formed frame, unknown verb.
  BadArg,   ///< Wrong argument count, malformed %-escape, over-long argument.
  NoCourt,  ///< Court argument outside A-D.
  BadFrame, ///< Structurally not a frame in either dialect.
  Overrun,  ///< Line exceeded kMaxFrameLen; resynchronised at the terminator.
};

/// Wire name of a decode error: "BADCRC", "OVERRUN", and so on.
const char* errorName(DecodeError e);

/// Per-verb grammar. This table, not scattered `if` statements, is what makes
/// the argument rules auditable — and what the ON static_assert below can
/// actually assert against.
struct VerbSpec {
  Verb verb;
  char name[6]; ///< Wire spelling. "STATE" is the longest at 5 + NUL.
  uint8_t minArgs;
  uint8_t maxArgs;
  int8_t courtArg;   ///< Index of the A-D court argument, -1 if the verb has none.
  int8_t secondsArg; ///< Index of a clamped duration argument, -1 if none.
  /// Lower clamp for that duration. AUTH allows 0: it disarms.
  uint16_t minSeconds;
  /// Upper clamp for it. A FIELD rather than one global constant because the
  /// two durations on this wire bound different things: a relay duration is
  /// bounded by the ninety-minute hard cap that stops an unattended court
  /// burning, and a screen hold is bounded by the two minutes that stop a
  /// screen becoming permanent. One constant serving both would have let a
  /// `!SHOW,5400` stand on the glass for an hour and a half.
  uint16_t maxSeconds;
  bool legacy; ///< Has a spelling in Carl's dialect. Everything v2 ADDS does not.
  /// v3: the last argument may be a tag (`!ON`, `!OFF`, `!EXT`, `!AUTH`). The
  /// tagged form is maxArgs; the v2 form one fewer.
  bool optionalTag;
  Dir dir;
  /// v3 verbs only: one letter per argument naming its grammar (nullptr for a
  /// v2 verb, whose rules are the court/seconds fields above). Letters are
  /// documented at Codec.cpp's validateV3Arg.
  const char* grammar;
};

inline constexpr VerbSpec kVerbSpecs[kVerbCount] = {
    {Verb::Unknown, "", 0, 0, -1, -1, 0, 0, false, false, Dir::Any, nullptr},
    {Verb::On, "ON", 2, 3, 0, 1, kRelayMinSeconds, kRelayHardCapSeconds, true, true, Dir::Any, nullptr},
    {Verb::Off, "OFF", 1, 2, 0, -1, 0, 0, true, true, Dir::Any, nullptr},
    {Verb::Ext, "EXT", 2, 3, 0, 1, kRelayMinSeconds, kRelayHardCapSeconds, false, true, Dir::Any, nullptr},
    {Verb::Lcd, "LCD", 2, 2, -1, -1, 0, 0, true, false, Dir::Any, nullptr},
    {Verb::Auth, "AUTH", 1, 2, -1, 0, 0, kRelayHardCapSeconds, false, true, Dir::Any, nullptr},
    {Verb::Rst, "RST", 0, 0, -1, -1, 0, 0, true, false, Dir::Any, nullptr},
    {Verb::Ping, "PING", 0, 0, -1, -1, 0, 0, false, false, Dir::Any, nullptr},
    {Verb::Btn, "BTN", 1, 1, -1, -1, 0, 0, true, false, Dir::Any, nullptr},
    {Verb::Scan, "SCAN", 1, 1, -1, -1, 0, 0, true, false, Dir::Any, nullptr},
    {Verb::State, "STATE", 5, 5, -1, -1, 0, 0, false, false, Dir::Any, nullptr},
    // PONG takes two arguments or five. The three counters are ADDITIVE: a
    // bridge flashed ahead of the Mega it is wired to must still read the
    // answer, and the Mega is the half that is not reflashed with it.
    {Verb::Pong, "PONG", 2, 5, -1, -1, 0, 0, false, false, Dir::Any, nullptr},
    {Verb::Evt, "EVT", 2, 2, -1, -1, 0, 0, false, false, Dir::Any, nullptr},
    {Verb::Err, "ERR", 1, 1, -1, -1, 0, 0, false, false, Dir::Any, nullptr},
    {Verb::Row, "ROW", 2, 2, -1, -1, 0, 0, false, false, Dir::Any, nullptr},
    {Verb::Show, "SHOW", 2, 2, -1, 0, kShowHoldMinSeconds, kShowHoldMaxSeconds, false, false, Dir::Any,
     nullptr},
    {Verb::Idle, "IDLE", 2, 2, -1, -1, 0, 0, false, false, Dir::Any, nullptr},
    {Verb::Map, "MAP", 4, 4, -1, -1, 0, 0, false, false, Dir::Any, nullptr},
    {Verb::Rw, "RW", 4, 4, -1, -1, 0, 0, false, false, Dir::Down, "sroX"},
    {Verb::Cmt, "CMT", 5, 5, -1, -1, 0, 0, false, false, Dir::Down, "smHfh"},
    {Verb::Want, "WANT", 5, 5, -1, -1, 0, 0, false, false, Dir::Down, "twwww"},
    {Verb::Cfg, "CFG", 3, 3, -1, -1, 0, 0, false, false, Dir::Down, "tkv"},
    {Verb::Land, "LAND", 4, 4, -1, -1, 0, 0, false, false, Dir::Down, "llll"},
    {Verb::Note, "NOTE", 2, 2, -1, -1, 0, 0, false, false, Dir::Down, "TX"},
    {Verb::Live, "LIVE", 1, 1, -1, -1, 0, 0, false, false, Dir::Down, "P"},
    {Verb::Ack, "ACK", 2, 2, -1, -1, 0, 0, false, false, Dir::Up, "ae"},
    {Verb::Boot, "BOOT", 3, 3, -1, -1, 0, 0, false, false, Dir::Up, "Xbb"},
    {Verb::Held, "HELD", 2, 2, -1, -1, 0, 0, false, false, Dir::Up, "bG"},
    {Verb::Diag, "DIAG", 5, 5, -1, -1, 0, 0, false, false, Dir::Up, "nnnnn"},
    {Verb::Hw, "HW", 5, 5, -1, -1, 0, 0, false, false, Dir::Up, "bpdpb"},
};

/// kVerbSpecs is indexed by the Verb value, so a row in the wrong place would
/// silently give every verb someone else's grammar. Checked at compile time.
///
/// Recursive, and one return statement, because a constexpr function with a
/// loop in it is C++14. This header has to be valid C++11 as well: the Arduino
/// AVR core hard-codes `-std=gnu++11` in its platform.txt and the Arduino IDE
/// offers no way to override it, so the generated sketch in src/iot/court-box/arduino/ —
/// the route the box is actually flashed by — compiles this file at C++11 while
/// PlatformIO compiles it at C++17. Do not "simplify" it back to a loop; the
/// PlatformIO build will stay green and `make arduino-check`'s compile will not.
constexpr bool verbSpecsAreInEnumOrder(size_t i = 0) {
  return i >= kVerbCount || (kVerbSpecs[i].verb == static_cast<Verb>(i) && verbSpecsAreInEnumOrder(i + 1));
}

static_assert(verbSpecsAreInEnumOrder(), "kVerbSpecs must be indexed by Verb");

// The safety rule, enforced at compile time on the wire path. If someone edits
// ON's row to make the duration optional, the build stops here rather than the
// court burning until somebody walks past it.
static_assert(kVerbSpecs[static_cast<size_t>(Verb::Cmt)].grammar[2] == 'H',
              "CMT's hold must be clamped like SHOW's: no commit can outlive two minutes");
static_assert(kVerbSpecs[static_cast<size_t>(Verb::On)].minArgs == 2,
              "ON must require a duration argument on the wire");
static_assert(kVerbSpecs[static_cast<size_t>(Verb::On)].secondsArg == 1,
              "ON's duration must be the clamped argument");
static_assert(kVerbSpecs[static_cast<size_t>(Verb::On)].minSeconds >= kRelayMinSeconds,
              "ON must not be clampable down to zero seconds");
static_assert(kVerbSpecs[static_cast<size_t>(Verb::On)].maxSeconds == kRelayHardCapSeconds,
              "ON's duration must still be bounded by the relay hard cap");

// The other half of the safety rule, for the screen. If someone widens SHOW's
// clamp, the build stops here rather than a refusal screen standing on the
// glass all evening with every button dead behind it — which is the failure
// this verb was added to make unrepresentable.
static_assert(kVerbSpecs[static_cast<size_t>(Verb::Show)].secondsArg == 0,
              "SHOW's hold must be the clamped argument");
static_assert(kVerbSpecs[static_cast<size_t>(Verb::Show)].maxSeconds == kShowHoldMaxSeconds,
              "SHOW's hold must be bounded by kShowHoldMaxSeconds");
static_assert(kVerbSpecs[static_cast<size_t>(Verb::Show)].minSeconds >= kShowHoldMinSeconds,
              "SHOW must not be clampable down to a zero-second hold");
static_assert(kVerbSpecs[static_cast<size_t>(Verb::Row)].maxArgs == 2,
              "ROW carries a row index and a row of text, and nothing else");

/// Grammar row for a verb. Verb::Unknown's row for anything out of range.
const VerbSpec& specOf(Verb v);

/// Wire spelling of a verb, "" for Verb::Unknown.
const char* verbName(Verb v);

/// Verb for a wire spelling, Verb::Unknown if there is no such verb.
Verb verbFromName(const char* name);

bool courtFromChar(char c, Court& out);
char courtChar(Court c);
bool keyFromChar(char c, Key& out);
char keyChar(Key k);

/// A fixed-capacity, always-NUL-terminated argument.
///
/// Truncation is explicit rather than silent: every mutator says whether the
/// value fit. Callers that must not lose data (a scanner code — a truncated
/// member code is a DIFFERENT member) treat `false` as an error; callers where
/// truncation is the documented behaviour (LCD text, which the 16-column panel
/// truncates anyway) ignore it.
class Arg {
public:
  Arg();

  void clear();

  /// Copy a NUL-terminated string. Returns false if it had to truncate.
  bool set(const char* s);

  /// Copy `n` bytes. Returns false if it had to truncate.
  bool set(const char* s, size_t n);

  /// Render an unsigned decimal. Always fits.
  void setU32(uint32_t v);

  /// Append one byte. Returns false if the argument is already full.
  bool push(char c);

  const char* c_str() const { return buf_; }

  size_t size() const { return len_; }

  bool empty() const { return len_ == 0; }

  bool equals(const char* s) const;

private:
  char buf_[kMaxArgLen + 1];
  uint8_t len_;
};

class Decoder;

/// One protocol message.
///
/// Constructed only through the named constructors below. There is no public
/// verb setter and no public argument setter, so a Frame is always in a state
/// one of these produced — which is what makes `ON` without a duration
/// unrepresentable rather than merely discouraged.
///
/// The default constructor yields Verb::Unknown: an empty Frame, usable as an
/// out-parameter, that encodes to nothing.
class Frame {
public:
  Frame();

  // --- Downlink: bridge -> Mega -------------------------------------------

  /// Close a relay for AT MOST `seconds`.
  ///
  /// `seconds` is a required parameter and always will be. This is the whole
  /// point of v2: the legacy `A` message had nowhere to put a duration, so an
  /// unattended court could burn for weeks. `seconds` is clamped into
  /// [kRelayMinSeconds, kRelayHardCapSeconds] rather than rejected.
  /// Open a relay for `seconds`, clamped to [kRelayMinSeconds, kRelayHardCapSeconds].
  ///
  /// uint32_t, not uint16_t. The clamp inside has always taken a uint32_t, but the
  /// parameter narrowed before it ever ran — so a caller holding a duration in
  /// milliseconds, or minutes read off an API response, truncated at 65,536
  /// seconds and the clamp then saw a small number and passed it through. Both
  /// failures are short rather than long, so neither could hold a court on; a
  /// booking of 65,536,000 ms came out as the one-second minimum, and a grant of
  /// 1093 minutes lit the court for 44 seconds while the display promised
  /// "1093 MIN". Taking the wide type is what makes the clamp mean what it says.
  static Frame on(Court court, uint32_t seconds);
  /// v3: the same, tagged (1..255; kNoTag gives the v2 form).
  static Frame on(Court court, uint32_t seconds, uint8_t tag);

  static Frame off(Court court);
  static Frame off(Court court, uint8_t tag);

  /// Extend an already-open relay's deadline to now + `seconds`. Clamped like on(),
  /// and wide for the same reason.
  static Frame ext(Court court, uint32_t seconds);
  static Frame ext(Court court, uint32_t seconds, uint8_t tag);

  /// Two display lines. Text longer than kMaxArgLen is truncated — the panel is
  /// driven as 16 columns, so this loses nothing a player would have seen.
  ///
  /// STILL SUPPORTED AND STILL THE SHORT PATH. It stages rows 0 and 1 and
  /// commits them with the default hold, so a bridge that only ever sends
  /// `!LCD` can no longer produce a screen that never leaves. That is the
  /// point of routing it through the same deadline: the fix holds for an
  /// un-upgraded bridge, not only for the one this change ships with.
  static Frame lcd(const char* line1, const char* line2);

  /// Stage one row of the pending overlay. Paints NOTHING: `!SHOW` commits.
  ///
  /// Returns an EMPTY frame for a row the protocol does not have. Refused
  /// rather than folded onto the last row, on the same rule scan() follows: a
  /// peer addressing row 4 disagrees with this one about the hardware, and
  /// quietly writing its text somewhere else would hide that disagreement
  /// behind a screen that merely looks wrong.
  ///
  /// Text longer than kMaxArgLen truncates, exactly as lcd()'s does.
  static Frame row(uint8_t row, const char* text);

  /// Commit the staged rows atomically and hold them for `seconds`.
  ///
  /// `seconds` is clamped into [kShowHoldMinSeconds, kShowHoldMaxSeconds] —
  /// clamped, never refused, because a refused hold is a screen with no
  /// deadline at all and that is the bug. `flags` bit0 asks for the countdown
  /// in row 3's right-hand columns.
  static Frame show(uint32_t seconds, uint8_t flags);

  /// What the Mega-rendered landing screen's status row should say.
  ///
  /// `flags`: bit0 WiFi up, bit1 API reachable, bit2 clock trusted, bit3 a
  /// power-dip restore is still pending. `hhmm` is four digits of club-local
  /// wall time, or kNoClock when the box does not trust its clock.
  static Frame idle(uint8_t flags, const char* hhmm);

  /// The club's court number behind each relay index; 0 is unmapped.
  ///
  /// Values are clamped into [0, 9999]: a court number is a label the club
  /// chose, and one that will not fit four columns of a character LCD is a
  /// label this glass cannot show whatever it does.
  static Frame map(const int16_t numbers[4]);

  /// Accept button input for `seconds`. 0 disarms, so there is no lower clamp.
  static Frame auth(uint16_t seconds);
  static Frame auth(uint16_t seconds, uint8_t tag);

  // --- v3 downlink -----------------------------------------------------------

  /// Stage `text` (at most one 24-character segment) into `row` of screen
  /// `seq`, at column `offset` 0 or 24. Empty on a bad row or offset.
  static Frame rw(uint8_t seq, uint8_t row, uint8_t offset, const char* text);

  /// Commit screen `seq`. `mask` 1..15 (empty otherwise); the hold clamps
  /// into [1, 120] exactly as `!SHOW`'s.
  static Frame cmt(uint8_t seq, uint8_t mask, uint32_t holdSeconds, uint8_t flags, uint16_t crc);

  /// Per relay: kNoOpinion, or seconds clamped into [1, 5400].
  static Frame want(uint8_t tag, const int32_t seconds[4]);

  /// One Mega setting. `key` is 1-6 uppercase letters (empty Frame otherwise).
  static Frame cfg(uint8_t tag, const char* key, uint16_t value);

  /// Per relay: kNoOpinion, or paid seconds clamped into [0, 86400].
  static Frame land(const int32_t seconds[4]);

  static Frame note(uint32_t ttlSeconds, const char* text);

  static Frame live(uint32_t periodSeconds);

  static Frame rst();
  static Frame ping();

  // --- Uplink: Mega -> bridge ---------------------------------------------

  static Frame btn(Key key);

  /// A complete line from the QR scanner. Returns an empty Frame if the code
  /// does not fit: a truncated member code identifies the wrong member.
  static Frame scan(const char* code);

  /// Relay bitmask plus per-relay seconds remaining, index 0..3 == courts A..D.
  static Frame state(uint8_t mask, const uint16_t remaining[4]);

  static Frame pong(const char* version, uint32_t uptimeSeconds);

  /// The same answer, carrying the Mega's three since-boot counters.
  ///
  /// They exist on the Mega already (CourtBox's diagnostics) and nothing off
  /// the board could read them, so a climbing "presses thrown away because the
  /// window was shut" — a stuck button, or a bridge that stopped sending
  /// `!AUTH` — was invisible from the office. The bridge diffs them per
  /// heartbeat and reports the delta as a fault.
  static Frame pong(const char* version, uint32_t uptimeSeconds, uint16_t txDropped, uint16_t rxErrors,
                    uint16_t unauthorised);
  static Frame evt(const char* name, const char* detail);
  static Frame err(DecodeError code);

  // --- v3 uplink -------------------------------------------------------------

  static Frame ack(uint8_t tag, AckCode code);
  static Frame ackScreen(uint8_t seq, AckCode code);
  /// `cause` is MCUSR, `held` the keys down at reset; both two uppercase hex.
  static Frame boot(const char* version, uint8_t cause, uint8_t held);
  static Frame held(uint8_t mask, uint32_t seconds);
  static Frame diag(const uint16_t counters[5]);
  /// `!HW,<lcd>,<rpol>,<sbaud>,<ssuf>,<keys>`: the LCD address that answered
  /// (0 = none, two uppercase hex), relay level 0|1, scanner baud code 0-5,
  /// line end 0|1, unarmed-forward key mask (two uppercase hex).
  static Frame hw(uint8_t lcdAddress, uint8_t relayLevel, uint8_t baudCode, uint8_t lineEnd, uint8_t keys);

  // --- Accessors -----------------------------------------------------------

  Verb verb() const { return verb_; }

  uint8_t argCount() const { return argc_; }

  /// Argument `i`, or "" when out of range. Never null.
  const char* arg(uint8_t i) const;

  bool empty() const { return verb_ == Verb::Unknown; }

  bool operator==(const Frame& other) const;

  bool operator!=(const Frame& other) const { return !(*this == other); }

private:
  // The decoder has to build every verb from bytes it did not choose, so it
  // gets the one generic path. That path is still held to ON's arity by
  // kVerbSpecs, whose ON row is static_asserted above, and the decoder routes
  // ON through Frame::on() anyway.
  friend class Decoder;

  static Frame ofVerb(Verb v);
  static Frame fromValidated(const VerbSpec& spec, const Arg* args, uint8_t argc);

  bool pushArg(const char* s);
  bool pushArgChar(char c);
  bool pushArgU32(uint32_t v);
  bool pushArgHex(uint32_t v, uint8_t digits);
  bool pushArgOpinion(int32_t v, uint32_t lowest, uint32_t highest);

  Verb verb_;
  uint8_t argc_;
  Arg args_[kMaxArgs];
};

} // namespace proto

#endif // CRUSADERS_PROTOCOL_H

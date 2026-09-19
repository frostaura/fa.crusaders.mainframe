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
};

inline constexpr size_t kVerbCount = 14;

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
  int8_t courtArg;     ///< Index of the A-D court argument, -1 if the verb has none.
  int8_t secondsArg;   ///< Index of a clamped duration argument, -1 if none.
  uint16_t minSeconds; ///< Lower clamp for that duration. AUTH allows 0: it disarms.
  bool legacy;         ///< Has a spelling in Carl's dialect. Everything v2 ADDS does not.
};

inline constexpr VerbSpec kVerbSpecs[kVerbCount] = {
    {Verb::Unknown, "", 0, 0, -1, -1, 0, false},    {Verb::On, "ON", 2, 2, 0, 1, kRelayMinSeconds, true},
    {Verb::Off, "OFF", 1, 1, 0, -1, 0, true},       {Verb::Ext, "EXT", 2, 2, 0, 1, kRelayMinSeconds, false},
    {Verb::Lcd, "LCD", 2, 2, -1, -1, 0, true},      {Verb::Auth, "AUTH", 1, 1, -1, 0, 0, false},
    {Verb::Rst, "RST", 0, 0, -1, -1, 0, true},      {Verb::Ping, "PING", 0, 0, -1, -1, 0, false},
    {Verb::Btn, "BTN", 1, 1, -1, -1, 0, true},      {Verb::Scan, "SCAN", 1, 1, -1, -1, 0, true},
    {Verb::State, "STATE", 5, 5, -1, -1, 0, false}, {Verb::Pong, "PONG", 2, 2, -1, -1, 0, false},
    {Verb::Evt, "EVT", 2, 2, -1, -1, 0, false},     {Verb::Err, "ERR", 1, 1, -1, -1, 0, false},
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
static_assert(kVerbSpecs[static_cast<size_t>(Verb::On)].minArgs == 2,
              "ON must require a duration argument on the wire");
static_assert(kVerbSpecs[static_cast<size_t>(Verb::On)].secondsArg == 1,
              "ON's duration must be the clamped argument");
static_assert(kVerbSpecs[static_cast<size_t>(Verb::On)].minSeconds >= kRelayMinSeconds,
              "ON must not be clampable down to zero seconds");

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

  static Frame off(Court court);

  /// Extend an already-open relay's deadline to now + `seconds`. Clamped like on(),
  /// and wide for the same reason.
  static Frame ext(Court court, uint32_t seconds);

  /// Two display lines. Text longer than kMaxArgLen is truncated — the panel is
  /// driven as 16 columns, so this loses nothing a player would have seen.
  static Frame lcd(const char* line1, const char* line2);

  /// Accept button input for `seconds`. 0 disarms, so there is no lower clamp.
  static Frame auth(uint16_t seconds);

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
  static Frame evt(const char* name, const char* detail);
  static Frame err(DecodeError code);

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

  Verb verb_;
  uint8_t argc_;
  Arg args_[kMaxArgs];
};

} // namespace proto

#endif // CRUSADERS_PROTOCOL_H

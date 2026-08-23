// Crusaders Mainframe — what each of the eight buttons does, as the box sees it.
//
// WHY THIS IS NOT A constexpr TABLE
// ---------------------------------
// The wiring is fixed: eight buttons on pins 22-36, screwed into a cupboard, and
// the club is not rewiring it. What the buttons MEAN is a different question, and
// one the club changes its mind about — which four select courts, which four
// select durations, whether one of them turns a court off instead. Hardcoding
// that means a person with a laptop standing at the box every time somebody
// reconsiders.
//
// So the meaning arrives on the heartbeat, as eight short strings, and this is
// what turns them into decisions. The INDEX is always the physical button: entry
// 0 is the button on pin 22 whatever it now does. That is what makes remapping
// mean anything — an admin swapping courts A and C changes two strings and
// touches no hardware.
//
// WHY IT DEFAULTS TO THE OLD WIRING
// ---------------------------------
// A box that has never had a heartbeat, or whose heartbeat carried nothing
// usable, behaves exactly as the hand-built box already did: courts A-D, then
// 15/30/45/60 minutes. Any other default would change the behaviour of every box
// in the club the first time one rebooted before its first heartbeat.
//
// WHY THE PARSER IS THIS SMALL
// ----------------------------
// It compares short ASCII tokens and reads at most three digits. That is the
// whole grammar, chosen on the API side precisely so this end needs no JSON
// parser and no allocator — see Services/ButtonMap.cs, which is the authority on
// the format and rejects anything this would have to guess about.
//
// No Arduino headers, no heap, no String. Compiles for AVR, Xtensa and the host.

#ifndef CRUSADERS_COURT_BUTTONMAP_H
#define CRUSADERS_COURT_BUTTONMAP_H

#include <stddef.h>
#include <stdint.h>

namespace court {

/// Physical buttons on a court box. Fixed by the wiring.
inline constexpr uint8_t kButtonCount = 8U;

/// The longest grant a single button may carry. Mirrors ButtonMap.MaxGrantMinutes
/// on the server; a value past it is refused here too rather than trusted, because
/// "the server validated it" stops being true the moment somebody edits the
/// database by hand.
inline constexpr uint16_t kMaxGrantMinutes = 240U;

enum class ButtonKind : uint8_t {
  /// A button the club has decided not to use.
  None = 0U,
  /// Select a court, 0-3 for A-D.
  SelectCourt = 1U,
  /// Ask for this many minutes on the selected court.
  GrantMinutes = 2U,
  /// Release the selected court early.
  TurnOff = 3U,
};

struct ButtonAction {
  ButtonKind kind = ButtonKind::None;
  /// Court index for SelectCourt; meaningless otherwise.
  uint8_t court = 0U;
  /// Minutes for GrantMinutes; meaningless otherwise.
  uint16_t minutes = 0U;
};

/// The eight-entry map the heartbeat delivers.
class ButtonMap {
public:
  /// Courts A-D then 15/30/45/60 — exactly what the hand-built box did.
  ButtonMap();

  /// Replaces one entry from its wire form. False when the token is not one this
  /// build understands, leaving the previous entry in place.
  ///
  /// Entry-at-a-time rather than a whole array, because the caller is walking a
  /// JSON array it is decoding incrementally and has nowhere to put eight strings
  /// at once.
  bool setFromWire(uint8_t index, const char* wire);

  /// Discards everything and returns to the default. Called before applying a
  /// heartbeat's map, so a shorter array cannot leave stale entries behind.
  void reset();

  const ButtonAction& operator[](uint8_t index) const;

  /// True once at least one entry has been replaced from a heartbeat. A box still
  /// on its defaults is worth being able to say so on a diagnostics screen.
  bool configured() const { return configured_; }

private:
  ButtonAction actions_[kButtonCount];
  bool configured_ = false;
};

/// Parses one wire token: `court:A`, `minutes:45`, `off`, `none`.
/// False leaves `out` untouched.
bool parseButtonAction(const char* wire, ButtonAction& out);

} // namespace court

#endif // CRUSADERS_COURT_BUTTONMAP_H

// Crusaders Mainframe — the two presses that buy court time at the box.
//
// THE INTERACTION
// ---------------
// A member walks up to a free court with no booking. They press a court button,
// then a duration button, and the lights come on. Two presses, no screen to read,
// nothing to type — which is the only interaction that works for somebody holding
// a racquet in a corridor.
//
// WHY THE FIRST PRESS EXPIRES
// ---------------------------
// Somebody presses "court C", changes their mind and walks away. If that
// selection persisted, the next person to press "45 minutes" — a completely
// different member, an hour later — would buy 45 minutes on court C in their own
// name. So a selection lapses, and lapses silently: the display goes back to idle
// and nothing was charged, because nothing was ever asked for.
//
// WHY THE ORDER IS FIXED
// ----------------------
// Duration-then-court would work equally well in the abstract, and it is exactly
// the kind of thing two implementations end up disagreeing about. Court first,
// always: it matches the panel's left-to-right layout, it matches the default
// map, and it means a stray duration press on an idle box does nothing rather
// than arming a half-request nobody can see.
//
// WHAT THIS DOES NOT DECIDE
// -------------------------
// The price. A walk-up is truncated at the next booking and charged pro rata, and
// both of those facts live in the API — the box does not know the tariff, does
// not know the next booking, and must not guess at either. This produces an
// INTENT; the bridge posts it and the API answers with what was actually sold.
//
// That makes walk-ups the one thing here that needs the network. A booked member
// scanning works offline; buying new time does not. That is the right way round:
// refusing to sell is a member at the desk, where refusing a booking they already
// paid for is a member in the dark.
//
// No Arduino headers, no heap, no String. Compiles for AVR, Xtensa and the host.

#ifndef CRUSADERS_COURT_WALKUPPAD_H
#define CRUSADERS_COURT_WALKUPPAD_H

#include <stdint.h>

#include "court/ButtonMap.h"
#include "timebase/TimeBase.h"

namespace court {

/// How long a court selection stands before it lapses, until the API says
/// otherwise.
///
/// Long enough to read the panel and decide; short enough that a member who
/// walked away has not left a live selection for the next person to complete.
///
/// A HALF-MADE PURCHASE IS THE ONE THING ON THIS BOX A TIMEOUT CAN LOSE, which
/// is why the tenant's `lcd_choice_seconds` (default 20 s) replaces this and
/// why that screen carries a visible countdown that any press re-arms. Ten
/// seconds is right for a verdict the member can simply re-scan for; it is not
/// right for a choice they are halfway through making.
inline constexpr uint32_t kSelectionTtlMs = 15000UL;

/// What a press produced.
enum class PadResult : uint8_t {
  /// Nothing happened — an unmapped button, or a duration press with no court
  /// selected. Deliberately not an error: on a box with four unused buttons this
  /// is the common case.
  Ignored = 0U,
  /// A court is now selected and the box is waiting for a duration.
  CourtSelected = 1U,
  /// Both presses are in. `intent()` describes what to ask the API for.
  Requested = 2U,
  /// A request to release the selected court.
  ReleaseRequested = 3U,
};

struct WalkUpIntent {
  uint8_t court = 0U;
  uint16_t minutes = 0U;
};

class WalkUpPad {
public:
  explicit WalkUpPad(uint32_t selectionTtlMs = kSelectionTtlMs) : ttlMs_(selectionTtlMs) {}

  /// One debounced press of physical button `index`, interpreted through `map`.
  PadResult press(const ButtonMap& map, uint8_t index, uint32_t nowMs);

  /// Called every pass so a lapsed selection clears even with nobody pressing
  /// anything. True on the pass the selection actually lapsed, so the caller can
  /// repaint the idle screen exactly once rather than on every pass.
  bool tick(uint32_t nowMs);

  bool hasSelection() const { return selected_; }

  uint8_t selectedCourt() const { return court_; }

  const WalkUpIntent& intent() const { return intent_; }

  /// Forgets any selection. Used when the API has answered, so a slow response
  /// cannot be completed twice by a second duration press.
  void clear();

  /// Adopt the tenant's `lcd_choice_seconds`.
  ///
  /// Takes effect from the NEXT selection, never from the live one: shortening
  /// the window under somebody who is mid-purchase would lapse a selection they
  /// are looking at. Same rule the heartbeat interval follows.
  void setTtlMs(uint32_t ttlMs) { ttlMs_ = ttlMs; }

  uint32_t ttlMs() const { return ttlMs_; }

  /// Milliseconds left before the selection lapses, 0 when nothing is selected
  /// or it has already lapsed. What the countdown in row 3 renders.
  uint32_t remainingMs(uint32_t nowMs) const;

private:
  uint32_t ttlMs_;
  bool selected_ = false;
  uint8_t court_ = 0U;
  uint32_t selectedAtMs_ = 0U;
  WalkUpIntent intent_;
};

} // namespace court

#endif // CRUSADERS_COURT_WALKUPPAD_H

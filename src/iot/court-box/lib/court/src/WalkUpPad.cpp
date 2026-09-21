#include "court/WalkUpPad.h"

namespace court {

void WalkUpPad::clear() {
  selected_ = false;
  court_ = 0U;
  selectedAtMs_ = 0U;
}

uint32_t WalkUpPad::remainingMs(uint32_t nowMs) const {
  if (!selected_) {
    return 0U;
  }
  // tb::since for the same reason tick() uses it: every uint32_t is a legal
  // millis() reading, so a plain subtraction reads as 49 days on the pass that
  // straddles the wrap.
  const uint32_t elapsed = tb::since(nowMs, selectedAtMs_);
  return elapsed >= ttlMs_ ? 0U : ttlMs_ - elapsed;
}

bool WalkUpPad::tick(uint32_t nowMs) {
  if (!selected_) {
    return false;
  }
  // tb::since, not subtraction: millis() wraps at 49.7 days and a box that has
  // been up for two months must not have every selection lapse instantly.
  if (tb::since(nowMs, selectedAtMs_) < ttlMs_) {
    return false;
  }
  clear();
  return true;
}

PadResult WalkUpPad::press(const ButtonMap& map, uint8_t index, uint32_t nowMs) {
  // A press is also activity, so evaluate the lapse first: a court selected
  // twenty seconds ago is gone by the time this duration press lands, and
  // completing it would sell time to whoever happens to be standing there now.
  static_cast<void>(tick(nowMs));

  const ButtonAction& action = map[index];

  switch (action.kind) {
  case ButtonKind::SelectCourt:
    selected_ = true;
    court_ = action.court;
    selectedAtMs_ = nowMs;
    return PadResult::CourtSelected;

  case ButtonKind::GrantMinutes:
    if (!selected_) {
      // A stray duration press on an idle box. Nothing is armed and nothing is
      // shown, because there is nothing to tell the member yet.
      return PadResult::Ignored;
    }
    intent_.court = court_;
    intent_.minutes = action.minutes;
    // The selection is spent here rather than when the API answers. A second
    // duration press while a slow request is in flight would otherwise buy the
    // court twice.
    clear();
    return PadResult::Requested;

  case ButtonKind::TurnOff:
    if (!selected_) {
      return PadResult::Ignored;
    }
    intent_.court = court_;
    intent_.minutes = 0U;
    clear();
    return PadResult::ReleaseRequested;

  case ButtonKind::None:
    return PadResult::Ignored;
  }

  // Only from a kind byte this build does not know. Outside the switch so
  // -Wswitch-enum still fails on a genuinely unhandled enumerator.
  return PadResult::Ignored;
}

} // namespace court

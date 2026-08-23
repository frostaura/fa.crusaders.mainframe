#include "court/ButtonMap.h"

#include <string.h>

namespace court {

namespace {

/// Case-insensitive prefix match. The server lower-cases what it writes, but this
/// is the boundary between two implementations and being strict about case here
/// would make a correct map fail for a reason nobody could see on a 16x2 display.
bool startsWithIgnoreCase(const char* text, const char* prefix, size_t& consumed) {
  size_t i = 0U;
  while (prefix[i] != '\0') {
    const char a = text[i];
    if (a == '\0') {
      return false;
    }
    const char lowerA = (a >= 'A' && a <= 'Z') ? static_cast<char>(a + 32) : a;
    if (lowerA != prefix[i]) {
      return false;
    }
    ++i;
  }
  consumed = i;
  return true;
}

bool equalsIgnoreCase(const char* text, const char* other) {
  size_t consumed = 0U;
  return startsWithIgnoreCase(text, other, consumed) && text[consumed] == '\0';
}

/// Skips leading spaces. The server trims, but a hand-edited settings row does not.
const char* skipSpaces(const char* text) {
  while (*text == ' ' || *text == '\t') {
    ++text;
  }
  return text;
}

/// True when nothing but whitespace remains.
///
/// The server trims BOTH ends before it validates, so it accepts " court:A " —
/// and a firmware that only skipped the leading space would refuse a map the
/// admin screen had already told them was fine, leaving one button dead with no
/// explanation anywhere. The shared corpus is what caught that; the case is
/// there because a hand-edited settings row has spaces on both sides.
bool onlySpacesRemain(const char* text) {
  return *skipSpaces(text) == '\0';
}

/// Reads at most four digits. False on no digits, a non-digit tail, or overflow —
/// never a partial number, because "minutes:6000x" silently becoming 6000 is four
/// days of lights.
bool readMinutes(const char* text, uint16_t& out) {
  uint32_t value = 0U;
  size_t digits = 0U;
  while (text[digits] >= '0' && text[digits] <= '9') {
    value = value * 10U + static_cast<uint32_t>(text[digits] - '0');
    ++digits;
    if (digits > 4U) {
      return false;
    }
  }
  if (digits == 0U || !onlySpacesRemain(text + digits)) {
    return false;
  }
  if (value == 0U || value > kMaxGrantMinutes) {
    return false;
  }
  out = static_cast<uint16_t>(value);
  return true;
}

} // namespace

bool parseButtonAction(const char* wire, ButtonAction& out) {
  if (wire == nullptr) {
    return false;
  }
  const char* text = skipSpaces(wire);

  if (onlySpacesRemain(text) || equalsIgnoreCase(text, "none")) {
    out.kind = ButtonKind::None;
    out.court = 0U;
    out.minutes = 0U;
    return true;
  }
  if (equalsIgnoreCase(text, "off")) {
    out.kind = ButtonKind::TurnOff;
    out.court = 0U;
    out.minutes = 0U;
    return true;
  }

  size_t consumed = 0U;
  if (startsWithIgnoreCase(text, "court:", consumed)) {
    const char* value = skipSpaces(text + consumed);
    const char letter = (value[0] >= 'a' && value[0] <= 'z') ? static_cast<char>(value[0] - 32) : value[0];
    if (letter < 'A' || letter > 'D' || !onlySpacesRemain(value + 1)) {
      return false;
    }
    out.kind = ButtonKind::SelectCourt;
    out.court = static_cast<uint8_t>(letter - 'A');
    out.minutes = 0U;
    return true;
  }

  if (startsWithIgnoreCase(text, "minutes:", consumed)) {
    uint16_t minutes = 0U;
    if (!readMinutes(skipSpaces(text + consumed), minutes)) {
      return false;
    }
    out.kind = ButtonKind::GrantMinutes;
    out.court = 0U;
    out.minutes = minutes;
    return true;
  }

  return false;
}

ButtonMap::ButtonMap() {
  reset();
}

void ButtonMap::reset() {
  for (uint8_t i = 0U; i < 4U; ++i) {
    actions_[i].kind = ButtonKind::SelectCourt;
    actions_[i].court = i;
    actions_[i].minutes = 0U;
  }
  const uint16_t defaults[4] = {15U, 30U, 45U, 60U};
  for (uint8_t i = 0U; i < 4U; ++i) {
    actions_[4U + i].kind = ButtonKind::GrantMinutes;
    actions_[4U + i].court = 0U;
    actions_[4U + i].minutes = defaults[i];
  }
  configured_ = false;
}

bool ButtonMap::setFromWire(uint8_t index, const char* wire) {
  if (index >= kButtonCount) {
    return false;
  }
  ButtonAction parsed;
  if (!parseButtonAction(wire, parsed)) {
    // The previous entry stays. A token this build does not understand is what a
    // downgrade looks like, and keeping a working button beats blanking one.
    return false;
  }
  actions_[index] = parsed;
  configured_ = true;
  return true;
}

const ButtonAction& ButtonMap::operator[](uint8_t index) const {
  static const ButtonAction kNone;
  return index < kButtonCount ? actions_[index] : kNone;
}

} // namespace court

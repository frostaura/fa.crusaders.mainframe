// Crusaders Mainframe — recording fake for hal::IButtonPort.
//
// WHY A PER-SAMPLE SCRIPT
// -----------------------
// The debounce rule is a statement about a SEQUENCE of samples: a level that
// has held for 80 ms is a press, anything shorter is contact chatter. To test
// it, a fake has to be able to say "the next six reads of channel 0 are H, L,
// H, L, L, L" — one scripted level per read.
//
// The script is written as a string of 'H' and 'L' so the bounce is legible in
// the test source: script(0, "HLHLLLLL") looks like an oscilloscope trace. It
// spells the ELECTRICAL levels, not "pressed"/"released", because the port
// returns levels and the INPUT_PULLUP inversion (pressed == LOW) is exactly the
// thing a test should be forced to spell out rather than assume.
//
// Rejected: scripting by duration ("pressed for 40 ms"). It would make the fake
// own a clock, couple two fakes together, and hide the sample-by-sample view
// that the debounce rule is actually about.
//
// When a script runs out the fake HOLDS the last level rather than resetting.
// A button does not spring back because the test stopped describing it, and a
// reset-to-released would silently manufacture a release edge.
//
// No Arduino headers, no heap, no String.

#ifndef CRUSADERS_FAKES_FAKEBUTTONS_H
#define CRUSADERS_FAKES_FAKEBUTTONS_H

#include <stdint.h>

#include "hal/Button.h"
#include "hal/PinLevel.h"

namespace fakes {

class FakeButtons final : public hal::IButtonPort {
public:
  /// Samples per channel. At a 1 ms loop this covers the 80 ms debounce window
  /// in one script; longer scenarios re-script mid-test.
  static constexpr uint8_t kScriptLen = 96U;

  hal::PinLevel read(uint8_t channel) override {
    if (channel >= hal::kButtonCount) {
      ++badChannelReads_;
      return hal::kButtonReleasedLevel;
    }
    ++reads_[channel];
    if (cursor_[channel] < length_[channel]) {
      held_[channel] = script_[channel][cursor_[channel]];
      ++cursor_[channel];
    } else if (length_[channel] > 0U) {
      ++exhaustedReads_[channel];
    }
    return held_[channel] ? hal::PinLevel::kHigh : hal::PinLevel::kLow;
  }

  // --- stimulus ------------------------------------------------------------

  /// Script the next reads of one channel. `pattern` is 'H'/'h' for HIGH
  /// (released) and 'L'/'l' for LOW (pressed); any other character is rejected
  /// outright rather than guessed at, because a typo'd trace that quietly reads
  /// as "released" is a test that proves nothing.
  ///
  /// Returns false on a bad channel, a bad character, or a pattern longer than
  /// kScriptLen. A rejected script leaves the channel untouched.
  bool script(uint8_t channel, const char* pattern) {
    if (channel >= hal::kButtonCount || pattern == nullptr) {
      return false;
    }
    uint8_t count = 0U;
    for (uint8_t i = 0U; pattern[i] != '\0'; ++i) {
      if (count >= kScriptLen || !decode(pattern[i], scratch_[count])) {
        return false;
      }
      ++count;
    }
    for (uint8_t i = 0U; i < count; ++i) {
      script_[channel][i] = scratch_[i];
    }
    length_[channel] = count;
    cursor_[channel] = 0U;
    exhaustedReads_[channel] = 0U;
    return true;
  }

  /// Hold a channel at one level with no script, for the many tests that only
  /// care that a button is not being pressed.
  void hold(uint8_t channel, hal::PinLevel level) {
    if (channel >= hal::kButtonCount) {
      return;
    }
    held_[channel] = (level == hal::PinLevel::kHigh);
    length_[channel] = 0U;
    cursor_[channel] = 0U;
    // Re-describing a channel clears the flag: the complaint is "you asserted
    // against samples you never wrote down", and this call writes them down.
    exhaustedReads_[channel] = 0U;
  }

  void press(uint8_t channel) { hold(channel, hal::kButtonPressedLevel); }

  void release(uint8_t channel) { hold(channel, hal::kButtonReleasedLevel); }

  // --- observation ---------------------------------------------------------

  uint16_t reads(uint8_t channel) const { return channel < hal::kButtonCount ? reads_[channel] : 0U; }

  /// True once a scripted channel has been read past the end of its script.
  /// A test that intended to describe the whole scenario and did not is a test
  /// that is asserting against a held level it never wrote down.
  bool scriptExhausted(uint8_t channel) const {
    return channel < hal::kButtonCount && exhaustedReads_[channel] > 0U;
  }

  uint8_t scriptRemaining(uint8_t channel) const {
    if (channel >= hal::kButtonCount) {
      return 0U;
    }
    return static_cast<uint8_t>(length_[channel] - cursor_[channel]);
  }

  uint16_t badChannelReads() const { return badChannelReads_; }

private:
  static bool decode(char symbol, bool& high) {
    if (symbol == 'H' || symbol == 'h') {
      high = true;
      return true;
    }
    if (symbol == 'L' || symbol == 'l') {
      high = false;
      return true;
    }
    return false;
  }

  // Idle state is released, which on INPUT_PULLUP is HIGH.
  bool held_[hal::kButtonCount] = {true, true, true, true, true, true, true, true};
  bool script_[hal::kButtonCount][kScriptLen] = {};
  bool scratch_[kScriptLen] = {};
  uint8_t length_[hal::kButtonCount] = {};
  uint8_t cursor_[hal::kButtonCount] = {};
  uint16_t reads_[hal::kButtonCount] = {};
  uint16_t exhaustedReads_[hal::kButtonCount] = {};
  uint16_t badChannelReads_ = 0U;
};

} // namespace fakes

#endif // CRUSADERS_FAKES_FAKEBUTTONS_H

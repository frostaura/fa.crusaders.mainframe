// Crusaders Mainframe — hal::IDisplayPort as two framed lines on stdout.
//
// It keeps the grid rather than logging the calls, for the reason
// fakes::FakeDisplay's header gives: the questions worth answering are "what
// does the glass say now" and "what fell off the right-hand edge", and a call
// log answers neither. The rendered lines are also how a person watching the
// simulator sees the claim code the board is displaying — which is the only
// channel that code is ever legitimately on.
//
// The frame is drawn at kDisplayCols wide, so text that a 16-column panel would
// have truncated is visibly truncated here too.

#ifndef CRUSADERS_POSIX_HAL_CONSOLEDISPLAY_H
#define CRUSADERS_POSIX_HAL_CONSOLEDISPLAY_H

#include <stdint.h>

#include "hal/Display.h"

namespace posix_hal {

class ConsoleDisplay final : public hal::IDisplayPort {
public:
  ConsoleDisplay();

  void clear() override;

  void print(uint8_t row, uint8_t col, const char* text) override;

  /// One row, space-padded and NUL-terminated. "" for a row that does not exist.
  const char* row(uint8_t index) const;

private:
  void blank();

  /// Repaint stdout only when the glass actually changed. A court box repaints
  /// its rows on a schedule, and echoing every identical repaint would bury the
  /// relay and protocol lines in the same transcript.
  void render();

  char grid_[hal::kDisplayRows][hal::kDisplayCols + 1U];
  bool dirty_;
};

} // namespace posix_hal

#endif // CRUSADERS_POSIX_HAL_CONSOLEDISPLAY_H

// The console LCD. See include/posix_hal/ConsoleDisplay.h.

#include "posix_hal/ConsoleDisplay.h"

#include <stdio.h>

namespace posix_hal {

ConsoleDisplay::ConsoleDisplay() : grid_(), dirty_(false) {
  // Blank WITHOUT rendering. A constructor that printed would put two empty
  // panels above the simulator's first line of output, and that first line is
  // the bound port — which a harness reads with a single readline().
  blank();
}

void ConsoleDisplay::clear() {
  blank();
  dirty_ = true;
  render();
}

void ConsoleDisplay::blank() {
  for (uint8_t r = 0U; r < hal::kDisplayRows; ++r) {
    for (uint8_t c = 0U; c < hal::kDisplayCols; ++c) {
      grid_[r][c] = ' ';
    }
    grid_[r][hal::kDisplayCols] = '\0';
  }
}

void ConsoleDisplay::print(uint8_t row, uint8_t col, const char* text) {
  if (row >= hal::kDisplayRows || col >= hal::kDisplayCols || text == nullptr) {
    return;
  }
  uint8_t c = col;
  for (uint16_t i = 0U; text[i] != '\0' && c < hal::kDisplayCols; ++i) {
    if (grid_[row][c] != text[i]) {
      grid_[row][c] = text[i];
      dirty_ = true;
    }
    ++c;
  }
  render();
}

const char* ConsoleDisplay::row(uint8_t index) const {
  return index < hal::kDisplayRows ? grid_[index] : "";
}

void ConsoleDisplay::render() {
  if (!dirty_) {
    return;
  }
  dirty_ = false;
  for (uint8_t r = 0U; r < hal::kDisplayRows; ++r) {
    printf("[lcd] |%s|\n", grid_[r]);
  }
  static_cast<void>(fflush(stdout));
}

} // namespace posix_hal

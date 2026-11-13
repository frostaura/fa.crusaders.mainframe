// Crusaders Mainframe — recording fake for hal::IDisplayPort.
//
// WHY IT MODELS THE GRID INSTEAD OF LOGGING CALLS
// -----------------------------------------------
// A call log answers "did you print COURT A?". The questions that actually
// matter on the panel are "what does the glass say now?" and "what fell off
// the right-hand edge?", and a call log cannot answer either.
//
// Two real failures this catches that a call log does not:
//   - Repainting a row with a shorter string leaves the tail of the previous
//     message behind, so "COURT A 45 MIN" becomes "COURT A 5 MINN". The grid
//     shows it; the call log shows two innocent-looking print() calls.
//   - Text that overruns the last column is silently lost. The panel is driven
//     as 20x4 with rows 0-1 kept to the 16-column safe subset, so a row 0-1
//     message that runs past column 16 would be cut on a 1602 swapped in.
//
// Rows read back space-padded to the full width (kDisplayCols — 20 under the
// [lcd] flags, 16 without them) and NUL-terminated, so a test asserts the exact
// row with TEST_ASSERT_EQUAL_STRING. Padding is not
// cosmetic: it is what makes the leftover-tail bug visible in the assertion.
//
// No Arduino headers, no heap, no String.

#ifndef CRUSADERS_FAKES_FAKEDISPLAY_H
#define CRUSADERS_FAKES_FAKEDISPLAY_H

#include <stdint.h>

#include "hal/Display.h"

namespace fakes {

class FakeDisplay final : public hal::IDisplayPort {
public:
  FakeDisplay() { clear(); }

  void clear() override {
    ++clearCalls_;
    for (uint8_t r = 0U; r < hal::kDisplayRows; ++r) {
      for (uint8_t c = 0U; c < hal::kDisplayCols; ++c) {
        grid_[r][c] = ' ';
      }
      grid_[r][hal::kDisplayCols] = '\0';
    }
  }

  void print(uint8_t row, uint8_t col, const char* text) override {
    ++printCalls_;
    if (holding_) {
      // A driver in bus holdoff drops the write: the glass keeps whatever it had.
      return;
    }
    if (row >= hal::kDisplayRows || text == nullptr) {
      ++offGridCalls_;
      return;
    }
    if (col >= hal::kDisplayCols) {
      // Starts past the last column: nothing can land on the glass at all.
      ++offGridCalls_;
      countDropped(text, 0U);
      return;
    }
    uint8_t c = col;
    uint16_t i = 0U;
    while (text[i] != '\0' && c < hal::kDisplayCols) {
      grid_[row][c] = text[i];
      ++c;
      ++i;
    }
    countDropped(text, i);
  }

  // --- observation ---------------------------------------------------------

  /// One row, space-padded to kDisplayCols and NUL-terminated. An out-of-range
  /// row returns an empty string rather than reading past the grid.
  // --- v3 self-healing glass -------------------------------------------------

  bool writable() override { return !holding_; }

  bool takeGlassLost() override {
    const bool lost = lost_;
    lost_ = false;
    return lost;
  }

  void reinit() override { ++reinitCalls_; }

  uint8_t cellsPerPass() const override { return cellsPerPass_; }

  uint16_t timeouts() const override { return timeouts_; }

  uint8_t address() const override { return address_; }

  void setAddress(uint8_t address) override {
    requestedAddress_ = address;
    ++addressCalls_;
  }

  /// What the fake answers as: 0 models a panel nobody fitted (HW-2).
  void setAnsweringAddress(uint8_t address) { address_ = address; }

  uint8_t requestedAddress() const { return requestedAddress_; }

  /// One I2C timeout as the real driver suffers it: the controller is
  /// re-synchronised, which clears the glass, and the caller is told.
  void glitch() {
    for (uint8_t r = 0U; r < hal::kDisplayRows; ++r) {
      for (uint8_t c = 0U; c < hal::kDisplayCols; ++c) {
        grid_[r][c] = ' ';
      }
    }
    lost_ = true;
    ++timeouts_;
  }

  /// A nibble desync no timeout reports: garbage on the glass, nobody told.
  void scramble(uint8_t rowIndex) {
    if (rowIndex < hal::kDisplayRows) {
      for (uint8_t c = 0U; c < hal::kDisplayCols; ++c) {
        grid_[rowIndex][c] = '#';
      }
    }
  }

  void setHolding(bool holding) { holding_ = holding; }

  void setCellsPerPass(uint8_t cells) { cellsPerPass_ = cells; }

  uint16_t reinitCalls() const { return reinitCalls_; }

  const char* row(uint8_t index) const { return index < hal::kDisplayRows ? grid_[index] : ""; }

  char at(uint8_t rowIndex, uint8_t col) const {
    if (rowIndex >= hal::kDisplayRows || col >= hal::kDisplayCols) {
      return '\0';
    }
    return grid_[rowIndex][col];
  }

  /// Characters that fell off the right-hand edge. Non-zero means the caller
  /// wrote a message the panel cannot show — a truncated court name is a
  /// support call, not a cosmetic issue.
  uint16_t droppedChars() const { return droppedChars_; }

  /// print() calls addressed to a row that does not exist, to a column past the
  /// last one, or with a null pointer. All three drop the whole call.
  uint16_t offGridCalls() const { return offGridCalls_; }

  uint16_t printCalls() const { return printCalls_; }

  uint16_t clearCalls() const { return clearCalls_; }

  void resetCounters() {
    droppedChars_ = 0U;
    offGridCalls_ = 0U;
    printCalls_ = 0U;
    clearCalls_ = 0U;
  }

private:
  void countDropped(const char* text, uint16_t written) {
    uint16_t i = written;
    while (text[i] != '\0') {
      ++droppedChars_;
      ++i;
    }
  }

  char grid_[hal::kDisplayRows][hal::kDisplayCols + 1U] = {};
  uint16_t droppedChars_ = 0U;
  uint16_t offGridCalls_ = 0U;
  uint16_t printCalls_ = 0U;
  uint16_t clearCalls_ = 0U;
  uint16_t reinitCalls_ = 0U;
  uint16_t timeouts_ = 0U;
  uint8_t cellsPerPass_ = 255U;
  bool lost_ = false;
  bool holding_ = false;
  uint8_t address_ = 0x27U;
  uint8_t requestedAddress_ = 0U;
  uint16_t addressCalls_ = 0U;
};

} // namespace fakes

#endif // CRUSADERS_FAKES_FAKEDISPLAY_H

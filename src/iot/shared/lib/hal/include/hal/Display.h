// Crusaders Mainframe — the LCD port.
//
// WHY THIS EXISTS
// ---------------
// An HD44780-compatible panel behind a PCF8574 I2C backpack at 0x27. The panel
// fitted is physically 20x4, but the firmware drives it as 16x2 by decision:
// 16x2 renders correctly on either panel, so a swapped display degrades to a
// smaller screen instead of to garbage on a court-side box nobody can service
// quickly.
//
// WHY print() TRUNCATES AND NEVER WRAPS
// -------------------------------------
// On an HD44780 the DDRAM rows are not contiguous in the order a human would
// guess: line 1 continues into line 3, and line 2 into line 4. Text that runs
// off the right edge of line 1 therefore reappears in the middle of line 3, not
// at the start of line 2. There is no wrapping behaviour worth having, so the
// port truncates at the last column and says so.
//
// Rejected: a printf-style formatting method on the port. It drags vsnprintf
// (~1.5 KB of flash and a stack frame with a variadic buffer) into the ATmega
// for the sake of two-line status text, and it moves message composition below
// the port where the host tests cannot see it.
//
// No Arduino headers. Compiles for AVR, Xtensa and the host test runner.

#ifndef CRUSADERS_HAL_DISPLAY_H
#define CRUSADERS_HAL_DISPLAY_H

#include <stdint.h>

namespace hal {

// Geometry follows the target's LCD_COLS/LCD_ROWS build flags when they are
// defined (see platformio.ini env:court_mega) and falls back to the 16x2
// decision otherwise, so the host build and the strict-compile gate agree with
// the firmware without either one hardcoding a second copy of the number.
#ifdef LCD_COLS
constexpr uint8_t kDisplayCols = static_cast<uint8_t>(LCD_COLS);
#else
constexpr uint8_t kDisplayCols = 16U;
#endif

#ifdef LCD_ROWS
constexpr uint8_t kDisplayRows = static_cast<uint8_t>(LCD_ROWS);
#else
constexpr uint8_t kDisplayRows = 2U;
#endif

/// A character-cell display, addressed by row and column.
class IDisplayPort {
public:
  virtual ~IDisplayPort() = default;

  /// Blank every cell and leave the cursor state unspecified. On real hardware
  /// this costs ~2 ms, which is why callers repaint rows rather than clearing
  /// on every pass of the main loop.
  virtual void clear() = 0;

  /// Write NUL-terminated `text` starting at (row, col).
  ///
  /// Characters that would fall past the last column are dropped, not wrapped
  /// (see the file header). A row at or beyond kDisplayRows drops the whole
  /// call: a partially rendered screen on the wrong line is worse than a
  /// missing line, because the operator reads it as current.
  ///
  /// The port does not pad. Callers repainting a row must write a full-width
  /// string or clear first, otherwise the tail of the previous message stays
  /// on the glass — which is how "COURT A 45 MIN" becomes "COURT A 5 MIN".
  virtual void print(uint8_t row, uint8_t col, const char* text) = 0;
};

} // namespace hal

#endif // CRUSADERS_HAL_DISPLAY_H

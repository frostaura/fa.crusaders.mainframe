// Crusaders Mainframe — the LCD port.
//
// WHY THIS EXISTS
// ---------------
// An HD44780-compatible panel behind a PCF8574 I2C backpack. Which panel is
// fitted — a 1602 or a 2004 — and at which address is unrecorded (HW-2,
// HW-11), so since Mega 3.0.0 neither is compiled in: the driver addresses the
// 20x4 DDRAM grid either controller has, the runtime LAYOUT setting decides
// how much of it is drawn (compact 16x2 on any doubt), and the address is
// probed. Columns 16-19 and rows 2-3 written to a 1602 land in off-glass DDRAM
// and are harmless.
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

/// The grid the driver addresses: the expanded layout's 20x4. Not a build
/// flag any more (FWM-17): a flag that described a panel nobody had looked at
/// was the defect.
constexpr uint8_t kDisplayCols = 20U;
constexpr uint8_t kDisplayRows = 4U;

/// The columns a 16-column panel would show.
///
/// THE SAFE-SUBSET CONTRACT, as a number both halves of a box can name. The
/// geometry above says how wide the glass IS; this says how much of it a
/// message may depend on. Rows 0-1 truncated here must still be a complete and
/// correct message on every screen, so a 1602 fitted where a 2004A was
/// expected degrades to a smaller screen rather than to half a sentence —
/// which is the property this port chose 16x2 for in the first place, kept as
/// a contract now that the firmware drives the panel it actually has.
///
/// It is HERE rather than in one board's own library because both the half
/// that composes the text and the half that paints it have to agree about it,
/// and neither may depend on the other.
constexpr uint8_t kSafeSubsetCols = 16U;

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

  // --- v3: the self-healing glass (Mega 3.0.0) -------------------------------
  //
  // The Mega keeps a shadow of what it believes is on the glass and paints
  // toward what it wants there, a few cells a pass. These four let a driver
  // tell it how far to trust that shadow. The defaults are a perfect panel,
  // which is what a console or a fake is.

  /// False while the driver is holding off after a bus fault: whatever the
  /// caller writes now is dropped, so the glass is UNKNOWN, never "landing".
  virtual bool writable() { return true; }

  /// True once after the glass may have changed behind the caller's back (a
  /// bus timeout, a resync that cleared the controller): every cell is dirty.
  virtual bool takeGlassLost() { return false; }

  /// Re-run the controller's initialisation (HD44780: 0x3,0x3,0x3,0x2 and the
  /// mode commands), without clearing — the caller repaints every cell. Fixes
  /// a nibble desync that no bus timeout reports (DL-05).
  virtual void reinit() {}

  /// How many character cells may be written in one pass of the Mega's loop
  /// within its paint budget (8 ms): the per-character bus time decides it.
  virtual uint8_t cellsPerPass() const { return 255U; }

  /// Bus errors since boot — I2C timeouts AND NACKs, so a backpack that
  /// stopped answering is counted, not silent (`!DIAG` arg 0, HW-2).
  virtual uint16_t timeouts() const { return 0U; }

  /// Controller re-initialisations the driver ran on its own to recover from a
  /// bus error (`!DIAG` arg 1 adds the periodic ones the caller asked for).
  virtual uint16_t recoveries() const { return 0U; }

  /// The I2C address that answered, 0 when none did (`!HW` arg 0).
  virtual uint8_t address() const { return 0x27U; }

  /// `!CFG,LCDA`: 0 probes 0x27, 0x3F, 0x20-0x26, 0x38-0x3E in that order at
  /// the next (re-)initialisation; any other value drives that address only.
  virtual void setAddress(uint8_t address) { static_cast<void>(address); }
};

} // namespace hal

#endif // CRUSADERS_HAL_DISPLAY_H

// Crusaders Mainframe — which I2C address the LCD backpack answers at (HW-2).
//
// The backpack's chip is unrecorded: a PCF8574T answers at 0x20-0x27 (0x27 by
// factory default), a PCF8574AT at 0x38-0x3F (0x3F). With `!CFG,LCDA` 0 the
// Mega probes 0x27, then 0x3F, then 0x20-0x26 and 0x38-0x3E, in that order, at
// boot and on every re-init after a bus error, and drives the first that ACKs;
// a non-zero LCDA drives that address only. 0 means nothing answered, which
// `!HW` reports as `00` so the console shows a dead glass instead of a blank one
// nobody reports. The order is here, pure, so the host suite proves it; the
// driver supplies the bus.
//
// No Arduino headers. C++11 as well as C++17.

#ifndef CRUSADERS_COURTLOGIC_LCDPROBE_H
#define CRUSADERS_COURTLOGIC_LCDPROBE_H

#include <stdint.h>

namespace courtlogic {

inline constexpr uint8_t kLcdProbeCount = 16U;

inline constexpr uint8_t kLcdProbeOrder[kLcdProbeCount] = {0x27U, 0x3FU, 0x20U, 0x21U, 0x22U, 0x23U, 0x24U, 0x25U,
                                                           0x26U, 0x38U, 0x39U, 0x3AU, 0x3BU, 0x3CU, 0x3DU, 0x3EU};

/// Does a device ACK at `address`? The driver's bus transaction, bounded by
/// the bus timeout.
typedef bool (*LcdAnswers)(uint8_t address, void* context);

/// The address to drive: `requested` alone when non-zero, else the first of
/// kLcdProbeOrder that answers; 0 when none does.
uint8_t probeLcdAddress(uint8_t requested, LcdAnswers answers, void* context);

} // namespace courtlogic

#endif // CRUSADERS_COURTLOGIC_LCDPROBE_H

// See include/courtlogic/LcdProbe.h.

#include "courtlogic/LcdProbe.h"

namespace courtlogic {

uint8_t probeLcdAddress(uint8_t requested, LcdAnswers answers, void* context) {
  if (requested != 0U) {
    return answers(requested, context) ? requested : static_cast<uint8_t>(0U);
  }
  for (uint8_t i = 0U; i < kLcdProbeCount; ++i) {
    if (answers(kLcdProbeOrder[i], context)) {
      return kLcdProbeOrder[i];
    }
  }
  return 0U;
}

} // namespace courtlogic

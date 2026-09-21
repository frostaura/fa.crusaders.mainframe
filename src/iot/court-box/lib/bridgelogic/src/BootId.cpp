#include "bridgelogic/BootId.h"

namespace bridgelogic {

uint32_t bootIdFrom(uint32_t drawn) {
  return drawn == 0U ? kBootIdForZeroDraw : drawn;
}

} // namespace bridgelogic

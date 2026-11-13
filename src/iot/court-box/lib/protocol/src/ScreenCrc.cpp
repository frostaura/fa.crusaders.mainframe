// See include/protocol/ScreenCrc.h.

#include "protocol/ScreenCrc.h"

namespace proto {

uint16_t crc16Update(uint16_t crc, uint8_t byte) {
  crc = static_cast<uint16_t>(crc ^ static_cast<uint16_t>(static_cast<uint16_t>(byte) << 8U));
  for (uint8_t bit = 0U; bit < 8U; ++bit) {
    crc = (crc & 0x8000U) != 0U ? static_cast<uint16_t>(static_cast<uint16_t>(crc << 1U) ^ 0x1021U) : static_cast<uint16_t>(crc << 1U);
  }
  return crc;
}

uint16_t screenCrcRow(uint16_t crc, uint8_t row, const char* text) {
  crc = crc16Update(crc, row);
  for (uint16_t i = 0U; text != nullptr && text[i] != '\0'; ++i) {
    crc = crc16Update(crc, static_cast<uint8_t>(text[i]));
  }
  return crc16Update(crc, 0U);
}

} // namespace proto

#include "linux_hal/I2cLcd.h"

#include <errno.h>
#include <fcntl.h>
#include <linux/i2c-dev.h>
#include <linux/i2c.h>
#include <sys/ioctl.h>
#include <time.h>
#include <unistd.h>

#include "courtlogic/LcdProbe.h"

namespace linux_hal {

namespace {

// PCF8574 -> HD44780, the HW-61 backpack: P0 RS, P1 RW, P2 En, P3 backlight, P4-7 D4-7.
constexpr uint8_t kRsBit = 0x01U;
constexpr uint8_t kEnBit = 0x04U;
constexpr uint8_t kBacklightBit = 0x08U;
constexpr uint8_t kClear = 0x01U;
constexpr uint8_t kEntryLeft = 0x06U;
constexpr uint8_t kDisplayOn = 0x0CU;
constexpr uint8_t kFunction4Bit2 = 0x28U;
constexpr uint8_t kSetDdram = 0x80U;
constexpr uint8_t kRowOffset[4] = {0x00U, 0x40U, 0x14U, 0x54U};

uint64_t monoMicros() {
  timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<uint64_t>(ts.tv_sec) * 1000000ULL + static_cast<uint64_t>(ts.tv_nsec) / 1000ULL;
}

void sleepMicros(uint32_t us) {
  timespec ts;
  ts.tv_sec = static_cast<time_t>(us / 1000000UL);
  ts.tv_nsec = static_cast<long>(us % 1000000UL) * 1000L;
  while (nanosleep(&ts, &ts) != 0 && errno == EINTR) {
  }
}

bool probeAnswers(uint8_t address, void* context) {
  return static_cast<I2cLcd*>(context)->answers(address);
}

} // namespace

I2cLcd::~I2cLcd() {
  if (fd_ >= 0) {
    ::close(fd_);
  }
}

void I2cLcd::idle() {
  if (idleHook_ != nullptr) {
    idleHook_(idleContext_);
  }
}

bool I2cLcd::begin(const char* busPath) {
  fd_ = ::open(busPath, O_RDWR | O_CLOEXEC);
  if (fd_ < 0) {
    return false;
  }
  sleepMicros(50000U); // the HD44780's own power-on wait
  address_ = findAddress();
  if (address_ != 0U) {
    initController();
    static_cast<void>(command(kClear));
    sleepMicros(2000U);
  }
  glassLost_ = true;
  return true;
}

bool I2cLcd::answers(uint8_t address) {
  idle();
  if (fd_ < 0) {
    return false;
  }
  // A one-byte READ, not a quick-write: a PCF8574 answers it with its port
  // latch and nothing on the glass changes. A NACK is -EREMOTEIO.
  uint8_t sink = 0U;
  i2c_msg msg;
  msg.addr = address;
  msg.flags = I2C_M_RD;
  msg.len = 1U;
  msg.buf = &sink;
  i2c_rdwr_ioctl_data xfer;
  xfer.msgs = &msg;
  xfer.nmsgs = 1U;
  return ::ioctl(fd_, I2C_RDWR, &xfer) == 1;
}

uint8_t I2cLcd::findAddress() {
  errorSinceProbe_ = false;
  selected_ = 0U;
  return courtlogic::probeLcdAddress(requested_, probeAnswers, this);
}

bool I2cLcd::writeBytes(const uint8_t* data, uint8_t len) {
  if (fd_ < 0 || address_ == 0U) {
    return false;
  }
  if (selected_ != address_) {
    if (::ioctl(fd_, I2C_SLAVE, address_) != 0) {
      return false;
    }
    selected_ = address_;
  }
  return ::write(fd_, data, len) == static_cast<ssize_t>(len);
}

bool I2cLcd::nibble(uint8_t data) {
  idle();
  const uint8_t base = static_cast<uint8_t>(data | kBacklightBit);
  const uint8_t frame[3] = {base, static_cast<uint8_t>(base | kEnBit), base};
  if (!writeBytes(frame, 3U)) {
    busError();
    return false;
  }
  return true;
}

bool I2cLcd::send(uint8_t value, uint8_t mode) {
  return nibble(static_cast<uint8_t>((value & 0xF0U) | mode)) &&
         nibble(static_cast<uint8_t>(static_cast<uint8_t>(value << 4U) | mode));
}

bool I2cLcd::command(uint8_t value) {
  const bool ok = send(value, 0U);
  sleepMicros(40U);
  return ok;
}

void I2cLcd::initController() {
  static_cast<void>(nibble(0x30U));
  sleepMicros(4500U);
  static_cast<void>(nibble(0x30U));
  sleepMicros(4500U);
  static_cast<void>(nibble(0x30U));
  sleepMicros(150U);
  static_cast<void>(nibble(0x20U));
  static_cast<void>(command(kFunction4Bit2));
  static_cast<void>(command(kDisplayOn));
  static_cast<void>(command(kEntryLeft));
}

void I2cLcd::busError() {
  holdoff_.noteTimeout();
  errorSinceProbe_ = true;
  glassLost_ = true;
}

void I2cLcd::recover() {
  if (recoveries_ < UINT16_MAX) {
    ++recoveries_;
  }
  address_ = findAddress();
  if (address_ != 0U) {
    initController();
  }
  glassLost_ = true;
}

void I2cLcd::setAddress(uint8_t address) {
  if (address == requested_) {
    return;
  }
  requested_ = address;
  errorSinceProbe_ = true;
  holdoff_.noteTimeout();
}

bool I2cLcd::ready() {
  if (!holdoff_.allow()) {
    return false;
  }
  if (holdoff_.takeResync()) {
    recover();
    return !holdoff_.holding() && address_ != 0U;
  }
  if (address_ == 0U) {
    holdoff_.noteTimeout();
    return false;
  }
  return true;
}

bool I2cLcd::writable() {
  return ready();
}

bool I2cLcd::takeGlassLost() {
  const bool lost = glassLost_;
  glassLost_ = false;
  return lost;
}

void I2cLcd::reinit() {
  if (address_ == 0U || holdoff_.holding()) {
    return;
  }
  if (errorSinceProbe_) {
    recover();
    return;
  }
  initController();
  glassLost_ = true;
}

void I2cLcd::clear() {
  if (address_ == 0U || holdoff_.holding()) {
    return;
  }
  static_cast<void>(command(kClear));
  sleepMicros(2000U);
  glassLost_ = true;
}

void I2cLcd::print(uint8_t row, uint8_t col, const char* text) {
  if (row >= hal::kDisplayRows || col >= hal::kDisplayCols || text == nullptr || address_ == 0U ||
      holdoff_.holding()) {
    return;
  }
  const uint64_t started = monoMicros();
  if (!command(static_cast<uint8_t>(kSetDdram | (kRowOffset[row] + col)))) {
    return;
  }
  uint8_t c = col;
  uint8_t n = 0U;
  for (uint16_t i = 0U; text[i] != '\0' && c < hal::kDisplayCols; ++i) {
    if (!send(static_cast<uint8_t>(text[i]), kRsBit)) {
      return;
    }
    ++c;
    ++n;
  }
  const uint64_t spent = monoMicros() - started;
  const uint64_t perCell = spent / static_cast<uint64_t>(n + 1U);
  const uint64_t cells = perCell == 0U ? 80U : kPaintBudgetMicros / perCell;
  cellsPerPass_ = static_cast<uint8_t>(cells < 2U ? 2U : (cells > 80U ? 80U : cells));
}

} // namespace linux_hal

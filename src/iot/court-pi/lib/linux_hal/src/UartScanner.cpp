#include "linux_hal/UartScanner.h"

#include <errno.h>
#include <fcntl.h>
#include <termios.h>
#include <unistd.h>

namespace linux_hal {

namespace {

speed_t speedFor(uint32_t baud) {
  switch (baud) {
  case 1200U:
    return B1200;
  case 2400U:
    return B2400;
  case 4800U:
    return B4800;
  case 9600U:
    return B9600;
  case 19200U:
    return B19200;
  case 38400U:
    return B38400;
  case 57600U:
    return B57600;
  case 115200U:
    return B115200;
  default:
    return B0;
  }
}

} // namespace

UartScanner::~UartScanner() {
  if (fd_ >= 0) {
    ::close(fd_);
  }
}

bool UartScanner::begin(const char* path, uint32_t baud) {
  fd_ = ::open(path, O_RDWR | O_NOCTTY | O_NONBLOCK | O_CLOEXEC);
  if (fd_ < 0) {
    return false;
  }
  return applyBaud(baud);
}

bool UartScanner::applyBaud(uint32_t baud) {
  const speed_t speed = speedFor(baud);
  if (fd_ < 0 || speed == B0) {
    return false;
  }
  termios tio;
  if (tcgetattr(fd_, &tio) != 0) {
    return false;
  }
  cfmakeraw(&tio); // 8N1, no echo, no line discipline: bytes as the scanner sent them
  tio.c_cflag |= static_cast<tcflag_t>(CLOCAL | CREAD);
  tio.c_cflag &= static_cast<tcflag_t>(~CRTSCTS);
  tio.c_cc[VMIN] = 0;
  tio.c_cc[VTIME] = 0;
  cfsetispeed(&tio, speed);
  cfsetospeed(&tio, speed);
  if (tcsetattr(fd_, TCSANOW, &tio) != 0) {
    return false;
  }
  static_cast<void>(tcflush(fd_, TCIFLUSH)); // bytes framed at the old baud are noise
  head_ = 0U;
  len_ = 0U;
  baud_ = baud;
  return true;
}

void UartScanner::setBaud(uint32_t baud) {
  if (baud != baud_) {
    static_cast<void>(applyBaud(baud));
  }
}

bool UartScanner::read(uint8_t& out) {
  if (head_ >= len_) {
    head_ = 0U;
    len_ = 0U;
    if (fd_ < 0) {
      return false;
    }
    const ssize_t got = ::read(fd_, buf_, sizeof(buf_));
    if (got <= 0) {
      return false;
    }
    len_ = static_cast<uint16_t>(got);
  }
  out = buf_[head_];
  ++head_;
  return true;
}

} // namespace linux_hal

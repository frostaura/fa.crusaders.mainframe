#include "linux_hal/GpioChip.h"

#include <dirent.h>
#include <fcntl.h>
#include <linux/gpio.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

namespace linux_hal {

namespace {

/// The labels of the bank the 40-pin header is wired to, oldest Pi first.
constexpr const char* kPiLabels[] = {"pinctrl-bcm2835", "pinctrl-bcm2711", "pinctrl-rp1", "pinctrl-bcm2712"};

bool isPiLabel(const char* label) {
  for (const char* known : kPiLabels) {
    if (strcmp(label, known) == 0) {
      return true;
    }
  }
  return false;
}

uint64_t biasFlag(Bias bias) {
  switch (bias) {
  case Bias::PullUp:
    return GPIO_V2_LINE_FLAG_BIAS_PULL_UP;
  case Bias::PullDown:
    return GPIO_V2_LINE_FLAG_BIAS_PULL_DOWN;
  case Bias::Disabled:
    break;
  }
  return GPIO_V2_LINE_FLAG_BIAS_DISABLED;
}

void copyConsumer(char* out, const char* consumer) {
  strncpy(out, consumer != nullptr ? consumer : "court-io", GPIO_MAX_NAME_SIZE - 1U);
  out[GPIO_MAX_NAME_SIZE - 1U] = '\0';
}

} // namespace

int openPiGpioChip(const char* overridePath, char* labelOut, unsigned labelCap) {
  if (overridePath != nullptr && overridePath[0] != '\0') {
    const int fd = ::open(overridePath, O_RDWR | O_CLOEXEC);
    if (fd >= 0 && labelOut != nullptr && labelCap > 0U) {
      gpiochip_info info;
      memset(&info, 0, sizeof(info));
      if (::ioctl(fd, GPIO_GET_CHIPINFO_IOCTL, &info) == 0) {
        snprintf(labelOut, labelCap, "%s", info.label);
      }
    }
    return fd;
  }
  DIR* dir = ::opendir("/dev");
  if (dir == nullptr) {
    return -1;
  }
  int found = -1;
  while (dirent* entry = ::readdir(dir)) {
    if (strncmp(entry->d_name, "gpiochip", 8U) != 0) {
      continue;
    }
    char path[300];
    snprintf(path, sizeof(path), "/dev/%s", entry->d_name);
    const int fd = ::open(path, O_RDWR | O_CLOEXEC);
    if (fd < 0) {
      continue;
    }
    gpiochip_info info;
    memset(&info, 0, sizeof(info));
    if (::ioctl(fd, GPIO_GET_CHIPINFO_IOCTL, &info) == 0 && isPiLabel(info.label)) {
      if (labelOut != nullptr && labelCap > 0U) {
        snprintf(labelOut, labelCap, "%s", info.label);
      }
      found = fd;
      break;
    }
    ::close(fd);
  }
  ::closedir(dir);
  return found;
}

GpioLine::~GpioLine() {
  release();
}

bool GpioLine::requestInput(int chipFd, uint8_t offset, Bias bias, const char* consumer) {
  release();
  gpio_v2_line_request req;
  memset(&req, 0, sizeof(req));
  req.offsets[0] = offset;
  req.num_lines = 1U;
  copyConsumer(req.consumer, consumer);
  req.config.flags = GPIO_V2_LINE_FLAG_INPUT | biasFlag(bias);
  if (::ioctl(chipFd, GPIO_V2_GET_LINE_IOCTL, &req) != 0) {
    return false;
  }
  fd_ = req.fd;
  return true;
}

bool GpioLine::configure(uint64_t flags, bool high) {
  if (fd_ < 0) {
    return false;
  }
  gpio_v2_line_config cfg;
  memset(&cfg, 0, sizeof(cfg));
  cfg.flags = flags;
  if ((flags & GPIO_V2_LINE_FLAG_OUTPUT) != 0U) {
    // The output value rides in the same ioctl, so the line never drives the
    // wrong level for even one instruction between "output" and "value".
    cfg.num_attrs = 1U;
    cfg.attrs[0].attr.id = GPIO_V2_LINE_ATTR_ID_OUTPUT_VALUES;
    cfg.attrs[0].attr.values = high ? 1U : 0U;
    cfg.attrs[0].mask = 1U;
  }
  return ::ioctl(fd_, GPIO_V2_LINE_SET_CONFIG_IOCTL, &cfg) == 0;
}

bool GpioLine::makeInput(Bias bias) {
  return configure(GPIO_V2_LINE_FLAG_INPUT | biasFlag(bias), false);
}

bool GpioLine::makeOutput(bool high) {
  return configure(GPIO_V2_LINE_FLAG_OUTPUT, high);
}

bool GpioLine::setValue(bool high) {
  if (fd_ < 0) {
    return false;
  }
  gpio_v2_line_values values;
  values.bits = high ? 1U : 0U;
  values.mask = 1U;
  return ::ioctl(fd_, GPIO_V2_LINE_SET_VALUES_IOCTL, &values) == 0;
}

int GpioLine::value() const {
  if (fd_ < 0) {
    return -1;
  }
  gpio_v2_line_values values;
  values.bits = 0U;
  values.mask = 1U;
  if (::ioctl(fd_, GPIO_V2_LINE_GET_VALUES_IOCTL, &values) != 0) {
    return -1;
  }
  return (values.bits & 1U) != 0U ? 1 : 0;
}

void GpioLine::release() {
  if (fd_ >= 0) {
    ::close(fd_);
    fd_ = -1;
  }
}

GpioInputs::~GpioInputs() {
  if (fd_ >= 0) {
    ::close(fd_);
  }
}

bool GpioInputs::request(int chipFd, const uint8_t* offsets, uint8_t count, Bias bias, const char* consumer) {
  if (offsets == nullptr || count == 0U || count > 64U) {
    return false;
  }
  gpio_v2_line_request req;
  memset(&req, 0, sizeof(req));
  for (uint8_t i = 0U; i < count; ++i) {
    req.offsets[i] = offsets[i];
  }
  req.num_lines = count;
  copyConsumer(req.consumer, consumer);
  req.config.flags = GPIO_V2_LINE_FLAG_INPUT | biasFlag(bias);
  if (::ioctl(chipFd, GPIO_V2_GET_LINE_IOCTL, &req) != 0) {
    return false;
  }
  fd_ = req.fd;
  count_ = count;
  return true;
}

bool GpioInputs::read(uint64_t& bits) const {
  if (fd_ < 0) {
    return false;
  }
  gpio_v2_line_values values;
  values.bits = 0U;
  values.mask = count_ >= 64U ? ~0ULL : ((1ULL << count_) - 1ULL);
  if (::ioctl(fd_, GPIO_V2_LINE_GET_VALUES_IOCTL, &values) != 0) {
    return false;
  }
  bits = values.bits;
  return true;
}

} // namespace linux_hal

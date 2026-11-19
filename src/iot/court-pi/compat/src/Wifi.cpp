// court-pi compat — WiFi station, TCP client and the ESP object on Linux.
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <poll.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/statvfs.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include "ESP8266WiFi.h"
#include "compat/BrainConfig.h"
#include "linux_hal/Service.h"

extern char** environ;

ESP8266WiFiClass WiFi;
EspClass ESP;

namespace {

uint64_t monoMs() {
  timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<uint64_t>(ts.tv_sec) * 1000ULL + static_cast<uint64_t>(ts.tv_nsec) / 1000000ULL;
}

/// True when /proc/net/route holds a default route that is up. Cached for a
/// second: the bridge asks every pass.
bool haveDefaultRoute() {
  static uint64_t checkedAt = 0U;
  static bool cached = false;
  const uint64_t now = monoMs();
  if (checkedAt != 0U && now - checkedAt < 1000U) {
    return cached;
  }
  checkedAt = now;
  cached = false;
  FILE* f = fopen("/proc/net/route", "r");
  if (f == nullptr) {
    return false;
  }
  char line[256];
  while (fgets(line, sizeof(line), f) != nullptr) {
    char iface[32];
    unsigned long dest = 1UL;
    unsigned long gateway = 0UL;
    unsigned flags = 0U;
    if (sscanf(line, "%31s %lx %lx %x", iface, &dest, &gateway, &flags) == 4 && dest == 0UL &&
        (flags & 0x1U) != 0U) {
      cached = true;
      break;
    }
  }
  fclose(f);
  return cached;
}

bool readSysMac(const char* iface, uint8_t mac[6]) {
  char path[96];
  snprintf(path, sizeof(path), "/sys/class/net/%s/address", iface);
  FILE* f = fopen(path, "r");
  if (f == nullptr) {
    return false;
  }
  char text[32] = {};
  const bool got = fgets(text, sizeof(text), f) != nullptr;
  fclose(f);
  text[strcspn(text, "\r\n")] = '\0';
  return got && compat::parseMac(text, mac);
}

/// Runs nmcli without waiting (SIGCHLD is ignored, so it reaps itself).
void spawnNmcli(const char* ssid, const char* psk, const char* iface) {
  const char* argv[12];
  int n = 0;
  argv[n++] = "nmcli";
  argv[n++] = "--wait";
  argv[n++] = "30";
  argv[n++] = "device";
  argv[n++] = "wifi";
  argv[n++] = "connect";
  argv[n++] = ssid;
  if (psk != nullptr && psk[0] != '\0') {
    argv[n++] = "password";
    argv[n++] = psk;
  }
  argv[n++] = "ifname";
  argv[n++] = iface;
  argv[n] = nullptr;
  pid_t pid = 0;
  const int rc = posix_spawnp(&pid, "nmcli", nullptr, nullptr, const_cast<char* const*>(argv), environ);
  if (rc != 0) {
    fprintf(stderr, "[court-brain] nmcli not runnable (%s) — WiFi left to the OS\n", strerror(rc));
  } else {
    // Never the passphrase: the journal is readable by more people than secrets.h.
    fprintf(stderr, "[court-brain] joining WiFi \"%s\" on %s\n", ssid, iface);
  }
}

/// The SSID wlan0 is associated with now, via nmcli. Empty when unknown.
void currentSsid(char* out, size_t cap) {
  out[0] = '\0';
  FILE* p = popen("nmcli -t -f ACTIVE,SSID device wifi 2>/dev/null", "r");
  if (p == nullptr) {
    return;
  }
  char line[160];
  while (fgets(line, sizeof(line), p) != nullptr) {
    if (strncmp(line, "yes:", 4U) == 0) {
      line[strcspn(line, "\r\n")] = '\0';
      const size_t n = strnlen(line + 4, cap - 1U);
      memcpy(out, line + 4, n);
      out[n] = '\0';
      break;
    }
  }
  static_cast<void>(pclose(p));
}

rst_info gReset = {};
bool gResetRead = false;

} // namespace

wl_status_t ESP8266WiFiClass::status() {
  return haveDefaultRoute() ? WL_CONNECTED : WL_DISCONNECTED;
}

uint8_t* ESP8266WiFiClass::macAddress(uint8_t* mac) {
  const compat::BrainConfig& c = compat::config();
  if (c.macSet) {
    memcpy(mac, c.mac, 6U);
  } else if (!readSysMac(c.iface, mac)) {
    memset(mac, 0, 6U);
    fprintf(stderr, "[court-brain] no MAC for %s — set COURT_BRAIN_IFACE or COURT_BRAIN_MAC\n", c.iface);
  }
  return mac;
}

int ESP8266WiFiClass::begin(const char* ssid, const char* passphrase) {
  const compat::BrainConfig& c = compat::config();
  if (!c.manageWifi || ssid == nullptr || ssid[0] == '\0') {
    return WL_IDLE_STATUS;
  }
  char now[64];
  currentSsid(now, sizeof(now));
  if (strcmp(now, ssid) == 0) {
    return WL_CONNECTED; // already there: re-joining would only drop the link
  }
  spawnNmcli(ssid, passphrase, c.iface);
  return WL_DISCONNECTED;
}

bool ESP8266WiFiClass::disconnect(bool) {
  return true; // the following begin() switches networks itself
}

bool ESP8266WiFiClass::mode(WiFiMode_t) {
  return true;
}

void ESP8266WiFiClass::persistent(bool) {
}

WiFiClient::~WiFiClient() {
  stop();
}

bool WiFiClient::connect(const char* host, uint16_t port, uint32_t timeoutMs) {
  stop();
  addrinfo hints;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  char service[8];
  snprintf(service, sizeof(service), "%u", static_cast<unsigned>(port));
  addrinfo* res = nullptr;
  if (getaddrinfo(host, service, &hints, &res) != 0 || res == nullptr) {
    return false;
  }
  const uint64_t deadline = monoMs() + timeoutMs;
  for (addrinfo* ai = res; ai != nullptr && fd_ < 0; ai = ai->ai_next) {
    const int fd = ::socket(ai->ai_family, ai->ai_socktype | SOCK_NONBLOCK | SOCK_CLOEXEC, ai->ai_protocol);
    if (fd < 0) {
      continue;
    }
    if (::connect(fd, ai->ai_addr, ai->ai_addrlen) != 0 && errno != EINPROGRESS) {
      ::close(fd);
      continue;
    }
    pollfd pfd = {fd, POLLOUT, 0};
    const uint64_t now = monoMs();
    const int wait = now >= deadline ? 0 : static_cast<int>(deadline - now);
    int soError = 0;
    socklen_t soLen = sizeof(soError);
    if (::poll(&pfd, 1, wait) == 1 && ::getsockopt(fd, SOL_SOCKET, SO_ERROR, &soError, &soLen) == 0 &&
        soError == 0) {
      fd_ = fd;
    } else {
      ::close(fd);
    }
  }
  freeaddrinfo(res);
  eof_ = false;
  head_ = 0U;
  len_ = 0U;
  return fd_ >= 0;
}

bool WiFiClient::fill(int waitMs) {
  if (head_ < len_) {
    return true;
  }
  head_ = 0U;
  len_ = 0U;
  if (fd_ < 0 || eof_) {
    return false;
  }
  if (waitMs > 0) {
    pollfd pfd = {fd_, POLLIN, 0};
    if (::poll(&pfd, 1, waitMs) <= 0) {
      return false;
    }
  }
  const ssize_t got = ::recv(fd_, buf_, sizeof(buf_), 0);
  if (got > 0) {
    len_ = static_cast<size_t>(got);
    return true;
  }
  if (got == 0 || (errno != EAGAIN && errno != EWOULDBLOCK)) {
    eof_ = true;
  }
  return false;
}

int WiFiClient::available() {
  fill(0);
  return static_cast<int>(len_ - head_);
}

int WiFiClient::read(uint8_t* out, size_t len) {
  if (!fill(0)) {
    return 0;
  }
  const size_t n = len < (len_ - head_) ? len : (len_ - head_);
  memcpy(out, buf_ + head_, n);
  head_ += n;
  return static_cast<int>(n);
}

uint8_t WiFiClient::connected() {
  if (fd_ < 0) {
    return 0U;
  }
  fill(0);
  return (!eof_ || head_ < len_) ? 1U : 0U;
}

bool WiFiClient::sendAll(const char* data, size_t len, uint32_t timeoutMs) {
  const uint64_t deadline = monoMs() + timeoutMs;
  size_t sent = 0U;
  while (fd_ >= 0 && sent < len) {
    const ssize_t n = ::send(fd_, data + sent, len - sent, MSG_NOSIGNAL);
    if (n > 0) {
      sent += static_cast<size_t>(n);
      continue;
    }
    if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
      return false;
    }
    const uint64_t now = monoMs();
    if (now >= deadline) {
      return false;
    }
    pollfd pfd = {fd_, POLLOUT, 0};
    static_cast<void>(::poll(&pfd, 1, static_cast<int>(deadline - now)));
  }
  return sent == len;
}

bool WiFiClient::readLine(char* out, size_t cap, uint64_t deadlineMs) {
  size_t n = 0U;
  for (;;) {
    if (head_ >= len_) {
      const uint64_t now = monoMs();
      if (now >= deadlineMs || !fill(static_cast<int>(deadlineMs - now))) {
        if (monoMs() >= deadlineMs || eof_) {
          return false;
        }
        continue;
      }
    }
    const char c = static_cast<char>(buf_[head_++]);
    if (c == '\n') {
      if (n > 0U && out[n - 1U] == '\r') {
        --n;
      }
      out[n] = '\0';
      return true;
    }
    if (n + 1U < cap) {
      out[n++] = c;
    }
  }
}

void WiFiClient::stop() {
  if (fd_ >= 0) {
    ::close(fd_);
    fd_ = -1;
  }
  head_ = 0U;
  len_ = 0U;
  eof_ = false;
}

const rst_info* EspClass::getResetInfoPtr() {
  if (!gResetRead) {
    char marker[200];
    snprintf(marker, sizeof(marker), "%s/court-brain.started", compat::config().run);
    gReset.reason = linux_hal::bootCause(marker) == linux_hal::BootCause::PowerOn ? REASON_DEFAULT_RST
                                                                                  : REASON_SOFT_RESTART;
    gResetRead = true;
  }
  return &gReset;
}

void EspClass::restart() {
  fprintf(stderr, "[court-brain] restart requested — exiting for systemd to restart\n");
  fflush(nullptr);
  exit(0);
}

namespace {

uint32_t clampU32(unsigned long long v) {
  return v > 0xFFFFFFFFULL ? 0xFFFFFFFFU : static_cast<uint32_t>(v);
}

uint32_t memAvailable() {
  FILE* f = fopen("/proc/meminfo", "r");
  if (f == nullptr) {
    return 0U;
  }
  char line[128];
  unsigned long long kb = 0ULL;
  while (fgets(line, sizeof(line), f) != nullptr) {
    if (sscanf(line, "MemAvailable: %llu kB", &kb) == 1) {
      break;
    }
  }
  fclose(f);
  return clampU32(kb * 1024ULL);
}

bool rtcPath(char* out, size_t cap) {
  const int n = snprintf(out, cap, "%s/rtc-memory.bin", compat::config().run);
  return n > 0 && static_cast<size_t>(n) < cap;
}

} // namespace

uint32_t EspClass::getFreeHeap() {
  return memAvailable();
}

uint32_t EspClass::getMaxFreeBlockSize() {
  return memAvailable();
}

uint32_t EspClass::getFreeContStack() {
  rlimit rl;
  if (getrlimit(RLIMIT_STACK, &rl) != 0 || rl.rlim_cur == RLIM_INFINITY) {
    return 8U * 1024U * 1024U;
  }
  return clampU32(rl.rlim_cur);
}

uint32_t EspClass::getFreeSketchSpace() {
  struct statvfs vfs;
  if (statvfs(compat::config().data, &vfs) != 0) {
    return 0U;
  }
  return clampU32(static_cast<unsigned long long>(vfs.f_bavail) * vfs.f_frsize);
}

uint32_t EspClass::getFlashChipRealSize() {
  struct statvfs vfs;
  if (statvfs(compat::config().data, &vfs) != 0) {
    return 0U;
  }
  return clampU32(static_cast<unsigned long long>(vfs.f_blocks) * vfs.f_frsize);
}

bool EspClass::rtcUserMemoryRead(uint32_t offset, uint32_t* data, size_t size) {
  char path[200];
  if (data == nullptr || !rtcPath(path, sizeof(path))) {
    return false;
  }
  FILE* f = fopen(path, "rb");
  if (f == nullptr) {
    return false;
  }
  const bool ok = fseek(f, static_cast<long>(offset) * 4L, SEEK_SET) == 0 && fread(data, 1U, size, f) == size;
  fclose(f);
  return ok;
}

bool EspClass::rtcUserMemoryWrite(uint32_t offset, uint32_t* data, size_t size) {
  char path[200];
  if (data == nullptr || !rtcPath(path, sizeof(path))) {
    return false;
  }
  const int fd = ::open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0600);
  if (fd < 0) {
    return false;
  }
  const bool ok = ::pwrite(fd, data, size, static_cast<off_t>(offset) * 4) == static_cast<ssize_t>(size);
  ::close(fd);
  return ok; // tmpfs: no fsync — RTC memory does not survive a power cut either
}

#include "linux_hal/Service.h"

#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

namespace linux_hal {

void notify(const char* state) {
  const char* path = getenv("NOTIFY_SOCKET");
  if (path == nullptr || path[0] == '\0' || state == nullptr) {
    return;
  }
  sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  const size_t len = strlen(path);
  if (len >= sizeof(addr.sun_path)) {
    return;
  }
  memcpy(addr.sun_path, path, len);
  if (addr.sun_path[0] == '@') {
    addr.sun_path[0] = '\0'; // abstract namespace
  }
  const int fd = ::socket(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  if (fd < 0) {
    return;
  }
  const socklen_t addrLen = static_cast<socklen_t>(offsetof(sockaddr_un, sun_path) + len);
  static_cast<void>(
      ::sendto(fd, state, strlen(state), MSG_NOSIGNAL, reinterpret_cast<sockaddr*>(&addr), addrLen));
  ::close(fd);
}

void kickWatchdog() {
  static uint64_t lastMs = 0U;
  timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  const uint64_t now =
      static_cast<uint64_t>(ts.tv_sec) * 1000ULL + static_cast<uint64_t>(ts.tv_nsec) / 1000000ULL;
  if (lastMs != 0U && now - lastMs < 200U) {
    return;
  }
  lastMs = now;
  notify("WATCHDOG=1");
}

BootCause bootCause(const char* markerPath) {
  const bool existed = ::access(markerPath, F_OK) == 0;
  const int fd = ::open(markerPath, O_WRONLY | O_CREAT | O_CLOEXEC, 0644);
  if (fd >= 0) {
    ::close(fd);
  }
  return existed ? BootCause::Restart : BootCause::PowerOn;
}

bool ensureDir(const char* path) {
  char buf[256];
  const int n = snprintf(buf, sizeof(buf), "%s", path);
  if (n <= 0 || static_cast<size_t>(n) >= sizeof(buf)) {
    return false;
  }
  for (char* p = buf + 1; *p != '\0'; ++p) {
    if (*p == '/') {
      *p = '\0';
      static_cast<void>(::mkdir(buf, 0755));
      *p = '/';
    }
  }
  return ::mkdir(buf, 0755) == 0 || errno == EEXIST;
}

} // namespace linux_hal

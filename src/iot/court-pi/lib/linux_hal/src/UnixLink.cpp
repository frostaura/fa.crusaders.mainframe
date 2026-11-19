#include "linux_hal/UnixLink.h"

#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

namespace linux_hal {

namespace {

bool setNonBlocking(int fd) {
  const int flags = fcntl(fd, F_GETFL, 0);
  return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

bool fillAddress(const char* path, sockaddr_un& addr) {
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  if (path == nullptr || strlen(path) >= sizeof(addr.sun_path)) {
    return false;
  }
  strcpy(addr.sun_path, path);
  return true;
}

uint64_t monoMs() {
  timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<uint64_t>(ts.tv_sec) * 1000ULL + static_cast<uint64_t>(ts.tv_nsec) / 1000000ULL;
}

/// What court-io advertises as room: the Mega's own UART tx ring is 64 bytes
/// and CourtBox paces itself to whatever this says, so a generous figure only
/// means it never has to wait on a socket that never fills.
constexpr size_t kAdvisoryWritable = 1024U;

} // namespace

UnixLinkServer::~UnixLinkServer() {
  dropPeer();
  if (listenFd_ >= 0) {
    ::close(listenFd_);
  }
}

bool UnixLinkServer::listen(const char* path) {
  sockaddr_un addr;
  if (!fillAddress(path, addr)) {
    return false;
  }
  static_cast<void>(::unlink(path)); // a stale socket from the previous run
  listenFd_ = ::socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (listenFd_ < 0) {
    return false;
  }
  if (::bind(listenFd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0 ||
      ::chmod(path, S_IRUSR | S_IWUSR | S_IRGRP | S_IWGRP) != 0 || ::listen(listenFd_, 1) != 0 ||
      !setNonBlocking(listenFd_)) {
    ::close(listenFd_);
    listenFd_ = -1;
    return false;
  }
  return true;
}

void UnixLinkServer::acceptPending() {
  if (listenFd_ < 0) {
    return;
  }
  const int fd = ::accept4(listenFd_, nullptr, nullptr, SOCK_NONBLOCK | SOCK_CLOEXEC);
  if (fd < 0) {
    return;
  }
  dropPeer(); // a new bridge replaces the old one, like a re-seated cable
  peerFd_ = fd;
}

bool UnixLinkServer::connected() {
  return peerFd_ >= 0;
}

size_t UnixLinkServer::writable() {
  return peerFd_ >= 0 ? kAdvisoryWritable : 0U;
}

size_t UnixLinkServer::write(const uint8_t* data, size_t len) {
  if (peerFd_ < 0 || data == nullptr || len == 0U) {
    return 0U;
  }
  const ssize_t wrote = ::send(peerFd_, data, len, MSG_NOSIGNAL);
  if (wrote < 0) {
    if (errno != EAGAIN && errno != EWOULDBLOCK) {
      dropPeer();
    }
    return 0U;
  }
  return static_cast<size_t>(wrote);
}

bool UnixLinkServer::read(uint8_t& out) {
  if (rxHead_ >= rxLen_) {
    rxHead_ = 0U;
    rxLen_ = 0U;
    if (peerFd_ < 0) {
      return false;
    }
    const ssize_t got = ::recv(peerFd_, rx_, sizeof(rx_), 0);
    if (got == 0 || (got < 0 && errno != EAGAIN && errno != EWOULDBLOCK)) {
      dropPeer();
      return false;
    }
    if (got < 0) {
      return false;
    }
    rxLen_ = static_cast<size_t>(got);
  }
  out = rx_[rxHead_];
  ++rxHead_;
  return true;
}

void UnixLinkServer::dropPeer() {
  if (peerFd_ >= 0) {
    ::close(peerFd_);
    peerFd_ = -1;
  }
  rxHead_ = 0U;
  rxLen_ = 0U;
}

void UnixLinkClient::configure(const char* path, size_t rxCapacity) {
  path_ = path;
  free(rx_);
  rxCap_ = rxCapacity < 64U ? 64U : rxCapacity;
  rx_ = static_cast<uint8_t*>(malloc(rxCap_));
  rxHead_ = 0U;
  rxLen_ = 0U;
}

void UnixLinkClient::dial() {
  const uint64_t now = monoMs();
  if (fd_ >= 0 || path_ == nullptr || now < nextDialMs_) {
    return;
  }
  nextDialMs_ = now + 500U;
  sockaddr_un addr;
  if (!fillAddress(path_, addr)) {
    return;
  }
  const int fd = ::socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) {
    return;
  }
  if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0 || !setNonBlocking(fd)) {
    ::close(fd);
    return;
  }
  fd_ = fd;
  txLen_ = 0U; // bytes queued for a court-io that has gone are not for this one
}

void UnixLinkClient::drop() {
  if (fd_ >= 0) {
    ::close(fd_);
    fd_ = -1;
  }
  txLen_ = 0U;
}

void UnixLinkClient::pump() {
  dial();
  if (fd_ < 0) {
    txLen_ = 0U; // a wire to nowhere: the bytes are gone, as on a UART
    return;
  }
  if (txLen_ > 0U) {
    const ssize_t wrote = ::send(fd_, tx_, txLen_, MSG_NOSIGNAL);
    if (wrote > 0) {
      memmove(tx_, tx_ + wrote, txLen_ - static_cast<size_t>(wrote));
      txLen_ -= static_cast<size_t>(wrote);
    } else if (wrote < 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
      drop();
      return;
    }
  }
  if (rx_ == nullptr) {
    return;
  }
  // Compact, then read into the free tail of the ring.
  if (rxHead_ > 0U) {
    memmove(rx_, rx_ + rxHead_, rxLen_ - rxHead_);
    rxLen_ -= rxHead_;
    rxHead_ = 0U;
  }
  if (rxLen_ < rxCap_) {
    const ssize_t got = ::recv(fd_, rx_ + rxLen_, rxCap_ - rxLen_, 0);
    if (got > 0) {
      rxLen_ += static_cast<size_t>(got);
    } else if (got == 0 || (errno != EAGAIN && errno != EWOULDBLOCK)) {
      drop();
    }
  }
}

int UnixLinkClient::available() {
  pump();
  return static_cast<int>(rxLen_ - rxHead_);
}

int UnixLinkClient::read() {
  if (rxHead_ >= rxLen_) {
    pump();
  }
  if (rxHead_ >= rxLen_) {
    return -1;
  }
  return rx_[rxHead_++];
}

int UnixLinkClient::availableForWrite() {
  pump();
  return static_cast<int>(kTxCapacity - txLen_);
}

size_t UnixLinkClient::write(const uint8_t* data, size_t len) {
  if (data == nullptr) {
    return 0U;
  }
  const size_t room = kTxCapacity - txLen_;
  const size_t n = len < room ? len : room;
  memcpy(tx_ + txLen_, data, n);
  txLen_ += n;
  pump();
  return n;
}

} // namespace linux_hal

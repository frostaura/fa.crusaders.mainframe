// The loopback TCP link. See include/posix_hal/TcpTransport.h.

#include "posix_hal/TcpTransport.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

namespace posix_hal {

namespace {

bool setNonBlocking(int fd) {
  const int flags = fcntl(fd, F_GETFL, 0);
  return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

} // namespace

TcpTransport::TcpTransport() : listenFd_(-1), peerFd_(-1), boundPort_(0U), rx_(), rxHead_(0U), rxLen_(0U) {
}

TcpTransport::~TcpTransport() {
  close();
}

bool TcpTransport::listen(uint16_t port, bool allInterfaces) {
  close();
  listenFd_ = ::socket(AF_INET, SOCK_STREAM, 0);
  if (listenFd_ < 0) {
    return false;
  }
  const int one = 1;
  static_cast<void>(::setsockopt(listenFd_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one)));

  sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons(port);
  // Loopback unless explicitly opted out of. See the header: a simulated relay
  // controller answering on every interface is an unauthenticated one, and the
  // only place that is acceptable is inside a container whose own loopback is
  // unreachable from a port mapping.
  addr.sin_addr.s_addr = htonl(allInterfaces ? INADDR_ANY : INADDR_LOOPBACK);

  if (::bind(listenFd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
    close();
    return false;
  }
  socklen_t addrLen = sizeof(addr);
  if (::getsockname(listenFd_, reinterpret_cast<sockaddr*>(&addr), &addrLen) == 0) {
    boundPort_ = ntohs(addr.sin_port);
  }
  if (::listen(listenFd_, 1) != 0 || !setNonBlocking(listenFd_)) {
    close();
    return false;
  }
  return true;
}

void TcpTransport::acceptPending() {
  if (listenFd_ < 0 || peerFd_ >= 0) {
    return;
  }
  const int fd = ::accept(listenFd_, nullptr, nullptr);
  if (fd < 0) {
    return;
  }
  if (!setNonBlocking(fd)) {
    ::close(fd);
    return;
  }
  // Nagle off. A protocol frame is under 200 bytes and the peer is waiting for
  // it; coalescing would add up to 40 ms of latency that the real 9600 baud
  // link does not have, and every timing assertion in the .NET suite would then
  // be measuring TCP rather than the device.
  const int one = 1;
  static_cast<void>(::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one)));
  peerFd_ = fd;
  rxHead_ = 0U;
  rxLen_ = 0U;
}

bool TcpTransport::connected() {
  acceptPending();
  return peerFd_ >= 0;
}

size_t TcpTransport::writable() {
  return peerFd_ >= 0 ? kAdvisoryWritable : 0U;
}

size_t TcpTransport::write(const uint8_t* data, size_t len) {
  if (peerFd_ < 0 || data == nullptr || len == 0U) {
    return 0U;
  }
  // MSG_NOSIGNAL: a peer that disappeared mid-write must return an error, not
  // kill the process with SIGPIPE. A simulator that dies when the test harness
  // closes its socket is a simulator that fails the test it was proving.
  const ssize_t wrote = ::send(peerFd_, data, len, MSG_NOSIGNAL);
  if (wrote < 0) {
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      return 0U;
    }
    dropPeer();
    return 0U;
  }
  return static_cast<size_t>(wrote);
}

bool TcpTransport::fill() {
  if (rxHead_ < rxLen_) {
    return true;
  }
  rxHead_ = 0U;
  rxLen_ = 0U;
  if (peerFd_ < 0) {
    return false;
  }
  const ssize_t got = ::recv(peerFd_, rx_, kRxCapacity, 0);
  if (got > 0) {
    rxLen_ = static_cast<size_t>(got);
    return true;
  }
  if (got == 0) {
    // Orderly close. The peer is gone; the relay deadlines are not.
    dropPeer();
    return false;
  }
  if (errno != EAGAIN && errno != EWOULDBLOCK) {
    dropPeer();
  }
  return false;
}

bool TcpTransport::read(uint8_t& out) {
  acceptPending();
  if (!fill()) {
    return false;
  }
  out = rx_[rxHead_];
  ++rxHead_;
  return true;
}

void TcpTransport::dropPeer() {
  if (peerFd_ >= 0) {
    ::close(peerFd_);
    peerFd_ = -1;
  }
  rxHead_ = 0U;
  rxLen_ = 0U;
}

void TcpTransport::close() {
  dropPeer();
  if (listenFd_ >= 0) {
    ::close(listenFd_);
    listenFd_ = -1;
  }
  boundPort_ = 0U;
}

} // namespace posix_hal

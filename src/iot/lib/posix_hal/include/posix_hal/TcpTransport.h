// Crusaders Mainframe — hal::ITransport over a TCP socket on loopback.
//
// WHY THE SIMULATOR SPEAKS THE REAL PROTOCOL OVER A SOCKET
// --------------------------------------------------------
// The .NET integration tests need something on the other end of the device
// protocol. The cheap option is a hand-written stub in the test project, and
// the trouble with that is it only ever agrees with itself: both sides of the
// conversation are then written from the same reading of the spec, so a
// misreading passes. This transport puts the REAL lib/protocol codec and the
// REAL courtlogic::CourtBox behind a socket, so the tests exercise the same
// bytes the ATmega will.
//
// LOOPBACK ONLY, AND NOT CONFIGURABLE
// -----------------------------------
// bind() is to 127.0.0.1 and there is no parameter to change it. A simulated
// court box that answered on 0.0.0.0 would be a relay controller listening on
// the developer's network with no authentication whatsoever — which is exactly
// the shape of thing OutboundAddressGuard exists to keep the API away from.
//
// ONE PEER AT A TIME
// ------------------
// The Mega has one UART to the bridge, so the simulator has one client. A
// second connection would give two writers on one link, which is a state the
// real hardware cannot be in and therefore not a state anything above the port
// is written to survive. The listener holds a backlog of one and a new peer
// simply waits.
//
// WHY IT NEVER BLOCKS
// -------------------
// Same reason as the real driver: the loop that would block is the loop
// servicing the relay auto-off timer. The socket is non-blocking and a write
// that cannot be accepted returns short, which the caller already has to handle
// because a 9600 baud UART does the same thing.

#ifndef CRUSADERS_POSIX_HAL_TCPTRANSPORT_H
#define CRUSADERS_POSIX_HAL_TCPTRANSPORT_H

#include <stddef.h>
#include <stdint.h>

#include "hal/Transport.h"

namespace posix_hal {

/// Advisory free space reported while a peer is attached.
///
/// A fixed number, not the socket's real send buffer: writable() is documented
/// as advisory on every implementation of this port, and asking the kernel adds
/// a syscall per frame to refine a number the caller must re-check anyway.
inline constexpr size_t kAdvisoryWritable = 1024U;

class TcpTransport final : public hal::ITransport {
public:
  TcpTransport();

  ~TcpTransport() override;

  TcpTransport(const TcpTransport&) = delete;
  TcpTransport& operator=(const TcpTransport&) = delete;

  /// Start listening on 127.0.0.1:`port`. False on any failure, with the reason
  /// left in errno; the simulator prints it and exits rather than running as a
  /// court box nothing can talk to.
  bool listen(uint16_t port);

  /// The port actually bound. Differs from the requested one when 0 was passed
  /// to ask the kernel for a free port, which is how a test harness runs
  /// several simulators at once without choosing numbers by hand.
  uint16_t boundPort() const { return boundPort_; }

  /// Accept a waiting peer if there is not one already. Called from the main
  /// loop; connected() also calls it, so a caller that only ever asks
  /// "connected?" still picks a peer up.
  void acceptPending();

  bool connected() override;

  size_t writable() override;

  size_t write(const uint8_t* data, size_t len) override;

  bool read(uint8_t& out) override;

  /// Drop the current peer, as a real link drops when the ESP reboots for OTA.
  void dropPeer();

  void close();

private:
  bool fill();

  int listenFd_;
  int peerFd_;
  uint16_t boundPort_;

  /// One UART ring's worth. Sized to match fakes::FakeTransport's RX capacity
  /// so a scenario that overruns the fake overruns this too.
  static constexpr size_t kRxCapacity = 256U;
  uint8_t rx_[kRxCapacity];
  size_t rxHead_;
  size_t rxLen_;
};

} // namespace posix_hal

#endif // CRUSADERS_POSIX_HAL_TCPTRANSPORT_H

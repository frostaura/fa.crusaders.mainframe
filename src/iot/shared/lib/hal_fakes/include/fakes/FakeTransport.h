// Crusaders Mainframe — recording fake for hal::ITransport.
//
// WHAT IT CAN SIMULATE, AND WHY EACH ONE IS REAL
// ----------------------------------------------
//   setConnected(false)  the peer is absent or resetting. The ESP restarts
//                        itself (the link supervisor, the stall watchdog, a
//                        portal save), so the Mega sees this in service.
//   setWriteFailure()    the driver accepts the call and writes nothing, while
//                        still claiming space in writable(). Real drivers do
//                        not know they are failing; a fake where failure is
//                        visible in advance would let code "handle" it by
//                        checking, which is not available in the field.
//   setMaxChunk(n)       a partial write: fewer bytes accepted than offered,
//                        with no error. This is the ordinary case on a 64-byte
//                        UART ring at 9600 baud, not a fault.
//   the bounded TX ring  kTxCapacity is 64 to match the AVR HardwareSerial TX
//                        buffer. A 40-byte frame plus a second one overruns it,
//                        which is exactly how far apart two frames can be sent
//                        before the link becomes the constraint.
//
// WHY IT CAPTURES LINES AS WELL AS BYTES
// --------------------------------------
// The wire is bytes; the protocol is lines. Tests upstream want to assert
// "!ON,A,900*3F" went out, and doing that against a byte buffer means every
// test re-implements line splitting. The capture is verbatim apart from the
// '\n' — a stray '\r' stays visible, because on this link a stray '\r' is a
// real defect and not something a helper should tidy away.
//
// Capture overflow (too many lines, or a line longer than kMaxLineLen) latches
// a flag instead of wrapping, for the same reason the relay fake's log does.
//
// No Arduino headers, no heap, no String.

#ifndef CRUSADERS_FAKES_FAKETRANSPORT_H
#define CRUSADERS_FAKES_FAKETRANSPORT_H

#include <stddef.h>
#include <stdint.h>

#include "hal/Transport.h"

#include "fakes/ByteQueue.h"

namespace fakes {

class FakeTransport final : public hal::ITransport {
public:
  /// Matches the ATmega HardwareSerial TX ring, so an overrun here happens at
  /// the same offered length it happens at on the bench.
  static constexpr size_t kTxCapacity = 64U;
  static constexpr uint16_t kRxCapacity = 256U;
  static constexpr uint8_t kMaxLines = 96U;
  static constexpr uint8_t kMaxLineLen = 48U;

  bool connected() override { return connected_; }

  size_t writable() override {
    if (!connected_) {
      return 0U;
    }
    return kTxCapacity - txLen_;
  }

  size_t write(const uint8_t* data, size_t len) override {
    ++writeCalls_;
    if (data == nullptr) {
      return 0U;
    }
    if (!connected_) {
      ++writesWhileDisconnected_;
      droppedBytes_ += len;
      return 0U;
    }
    if (failWrites_) {
      ++failedWrites_;
      droppedBytes_ += len;
      return 0U;
    }
    const size_t free = kTxCapacity - txLen_;
    if (len > free) {
      ++overruns_;
    }
    const size_t accepted = acceptedCount(len, free);
    for (size_t i = 0U; i < accepted; ++i) {
      tx_[txLen_] = static_cast<char>(data[i]);
      ++txLen_;
      capture(data[i]);
    }
    tx_[txLen_] = '\0';
    if (accepted < len) {
      ++partialWrites_;
      droppedBytes_ += len - accepted;
    }
    return accepted;
  }

  bool read(uint8_t& out) override {
    if (!connected_) {
      // A dropped link delivers nothing, but the queued bytes survive so a test
      // can reconnect and prove the recovery path drains them.
      return false;
    }
    return rx_.pop(out);
  }

  // --- stimulus ------------------------------------------------------------

  void setConnected(bool connectedNow) { connected_ = connectedNow; }

  /// Every subsequent write() accepts nothing while writable() keeps reporting
  /// space. See the file header for why the failure is invisible in advance.
  void setWriteFailure(bool failing) { failWrites_ = failing; }

  /// Cap how many bytes a single write() will take, independent of free space.
  void setMaxChunk(size_t bytes) { maxChunk_ = bytes; }

  /// The peer consumed what was queued. Captured lines are NOT cleared: they
  /// are the transcript of the session, and a drain is not an un-send.
  void drainTx() {
    txLen_ = 0U;
    tx_[0] = '\0';
  }

  bool feedByte(uint8_t value) { return rx_.push(value); }

  bool feed(const char* text) {
    if (text == nullptr) {
      return false;
    }
    for (uint16_t i = 0U; text[i] != '\0'; ++i) {
      if (!feedByte(static_cast<uint8_t>(text[i]))) {
        return false;
      }
    }
    return true;
  }

  /// Feed a whole frame including its '\n', the way the peer sends one.
  bool feedLine(const char* text) { return feed(text) && feedByte(static_cast<uint8_t>('\n')); }

  /// Forget the captured transcript (not the TX ring), so a long scenario can
  /// assert on what happened since a point.
  void clearLines() {
    lineCount_ = 0U;
    captureOverflowed_ = false;
  }

  // --- observation ---------------------------------------------------------

  /// Bytes currently sitting in the TX buffer, NUL-terminated for assertion.
  const char* txText() const { return tx_; }

  size_t txPending() const { return txLen_; }

  uint8_t lineCount() const { return lineCount_; }

  /// A completed outbound line, without its '\n'. Out-of-range returns "".
  const char* line(uint8_t index) const { return index < lineCount_ ? lines_[index] : ""; }

  /// Bytes written since the last completed line — a frame still in flight.
  /// Non-zero at the end of a test means something emitted an unterminated
  /// frame, which the peer will silently glue onto the next one.
  uint8_t partialLineLen() const { return partialLen_; }

  /// write() calls that could not fit everything offered in the TX buffer.
  uint16_t overruns() const { return overruns_; }

  /// write() calls that accepted some but not all of what was offered, for any
  /// reason (buffer full or chunk limit).
  uint16_t partialWrites() const { return partialWrites_; }

  uint16_t failedWrites() const { return failedWrites_; }

  uint16_t writesWhileDisconnected() const { return writesWhileDisconnected_; }

  uint16_t writeCalls() const { return writeCalls_; }

  /// Every byte offered to write() that never made it into the buffer.
  size_t droppedBytes() const { return droppedBytes_; }

  /// Latched when the transcript could not hold a line, or a line was longer
  /// than kMaxLineLen. Any assertion about captured lines is void if set.
  bool captureOverflowed() const { return captureOverflowed_; }

  bool rxOverflowed() const { return rx_.overflowed(); }

  uint16_t rxPending() const { return rx_.size(); }

private:
  size_t acceptedCount(size_t len, size_t free) const {
    size_t accepted = len;
    if (accepted > maxChunk_) {
      accepted = maxChunk_;
    }
    if (accepted > free) {
      accepted = free;
    }
    return accepted;
  }

  void capture(uint8_t value) {
    if (value == static_cast<uint8_t>('\n')) {
      commitLine();
      return;
    }
    if (partialLen_ >= kMaxLineLen) {
      captureOverflowed_ = true;
      return;
    }
    partial_[partialLen_] = static_cast<char>(value);
    ++partialLen_;
    partial_[partialLen_] = '\0';
  }

  void commitLine() {
    if (lineCount_ >= kMaxLines) {
      captureOverflowed_ = true;
      partialLen_ = 0U;
      partial_[0] = '\0';
      return;
    }
    for (uint8_t i = 0U; i <= partialLen_; ++i) {
      lines_[lineCount_][i] = partial_[i];
    }
    ++lineCount_;
    partialLen_ = 0U;
    partial_[0] = '\0';
  }

  bool connected_ = true;
  bool failWrites_ = false;
  size_t maxChunk_ = kTxCapacity;

  char tx_[kTxCapacity + 1U] = {};
  size_t txLen_ = 0U;

  ByteQueue<kRxCapacity> rx_;

  char lines_[kMaxLines][kMaxLineLen + 1U] = {};
  uint8_t lineCount_ = 0U;
  char partial_[kMaxLineLen + 1U] = {};
  uint8_t partialLen_ = 0U;
  bool captureOverflowed_ = false;

  uint16_t overruns_ = 0U;
  uint16_t partialWrites_ = 0U;
  uint16_t failedWrites_ = 0U;
  uint16_t writesWhileDisconnected_ = 0U;
  uint16_t writeCalls_ = 0U;
  size_t droppedBytes_ = 0U;
};

} // namespace fakes

#endif // CRUSADERS_FAKES_FAKETRANSPORT_H

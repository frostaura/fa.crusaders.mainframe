// Crusaders Mainframe — the bridge's side of the Mega link: the paced,
// never-dropping, acknowledged sender (bridge 3.0.0).
//
// WHY THIS EXISTS (DL-01, FSF-01, DL-06, BR-05)
// ---------------------------------------------
// 2.3.0 wrote a frame only if the whole of it fitted the ESP8266's 128-byte
// hardware TX FIFO at that instant, and returned false otherwise — so a fast
// server, answering while the FIFO still held the ONE MOMENT screen, made the
// bridge silently refuse the online activation's `!ON`. And its one-slot
// retry was cleared by the `!AUTH` sent right after every `!ON`, so a
// corrupted `!ON` was never re-sent.
//
// So: every frame is queued (1024 bytes) and drained into the UART as it has
// room, never a partial frame ahead of another's bytes. Relay, `!AUTH`,
// `!WANT` and `!CFG` frames go ahead of queued screen frames (but never inside
// one) and have 128 bytes reserved; when the queue is full a SCREEN is dropped
// whole, oldest first, and counted (`screen_dropped`) — a relay frame never is.
// To a 3.0.0 Mega every ACK-able frame is tagged (1-255, skipping 0) and stays
// pending until its `!ACK`: re-sent after 400 ms with the SAME tag, at most
// three times, then reported (`mega_unacked`) and handed back so the caller
// paints TRY AGAIN for a relay frame. At most one screen is in flight: the
// next `!RW` series starts after the previous `!CMT` is acknowledged or has
// timed out (600 ms, then re-sent once under a new seq).
//
// The dialect is the Mega's version: v3 to a 3.x Mega, v2 (untagged,
// `!ROW`/`!SHOW`, `!` replaced in text) to anything older, and until a
// version has been heard NO relay frame at all (BR-05).
//
// Pure: the caller hands pump() its transport. No Arduino headers, no heap.

#ifndef CRUSADERS_BRIDGELOGIC_MEGATX_H
#define CRUSADERS_BRIDGELOGIC_MEGATX_H

#include <stddef.h>
#include <stdint.h>

#include "hal/Transport.h"

#include "bridgelogic/ScreenScript.h"
#include "protocol/Protocol.h"

namespace bridgelogic {

enum class MegaDialect : uint8_t { Unknown = 0, V2, V3 };

/// A tagged frame that was never acknowledged (three retries spent).
struct UnackedFrame {
  proto::Verb verb = proto::Verb::Unknown;
  uint8_t court = 0xFFU; ///< for ON/OFF/EXT, else 0xFF
  uint8_t tag = 0U;
};

class MegaTx {
public:
  static constexpr uint16_t kQueueBytes = 1024U;
  static constexpr uint16_t kReservedBytes = 128U;
  static constexpr uint32_t kAckTimeoutMs = 400UL;
  static constexpr uint8_t kMaxRetries = 3U;
  static constexpr uint32_t kScreenAckTimeoutMs = 600UL;
  static constexpr uint8_t kPendingSlots = 8U;
  static constexpr uint8_t kScreenSlots = 3U;

  MegaTx();

  /// From `!BOOT` / `!PONG`: "3.0.0" -> V3, anything older -> V2. A dialect
  /// change abandons every pending acknowledgement (a new Mega boot owes
  /// nothing to the old one's tags).
  void setMegaVersion(const char* version);

  MegaDialect dialect() const { return dialect_; }

  /// The Mega restarted (`!BOOT`, or a `!PONG` uptime that went backwards):
  /// its tags, its staging and its acknowledged layout are gone with it.
  void megaBooted();

  /// A relay or control frame the Mega acts on (`!ON`, `!OFF`, `!EXT`,
  /// `!AUTH`, `!WANT`, `!CFG`). Tagged to a v3 Mega. False when it cannot be
  /// queued, or before the Mega has been heard (BR-05): the caller treats
  /// false exactly as an unsendable `!ON` (TRY AGAIN).
  /// `frame` is built UNTAGGED; the tag is added here.
  bool command(const proto::Frame& frame, uint32_t nowMs);

  /// Anything else (`!PING`, `!IDLE`, `!MAP`, `!LAND`, `!NOTE`, `!LIVE`,
  /// `!RST`): queued as is. `!WANT`/`!CFG`/`!LAND`/`!NOTE`/`!LIVE` are v3 only
  /// and dropped (returning true) to a v2 Mega, which would answer BADVERB.
  bool plain(const proto::Frame& frame);

  /// A whole screen: `!RW`/`!CMT` for a v3 Mega, `!ROW`s + `!SHOW` for v2.
  bool screen(const Screen& screen, uint32_t nowMs);

  /// `!ACK,<id>,<code>` from the Mega.
  void onAck(const proto::Frame& ack, uint32_t nowMs);

  /// Retries and timeouts, then as many queued bytes as `link` has room for.
  void pump(hal::ITransport& link, uint32_t nowMs);

  /// One frame that ran out of retries, once.
  bool takeUnacked(UnackedFrame& out);

  /// The last `!CMT` the Mega refused busy (inside its dwell), once.
  bool takeScreenBusy();

  uint16_t screensDropped() const { return screensDropped_; }

  uint16_t queued() const { return count_; }

  bool idle() const { return count_ == 0U && pendingCount() == 0U && !screenInFlight_ && screenCount_ == 0U; }

  uint8_t pendingCount() const;

  /// The last `!CFG,LAYOUT` value the Mega acknowledged this boot, or -1.
  int8_t ackedLayout() const { return ackedLayout_; }

private:
  /// The widest tagged command (`!WANT,255,5400,5400,5400,5400*CC` and
  /// `!CFG,255,REINIT,65535*CC`) with its terminator.
  static constexpr uint8_t kPendingLineMax = 48U;

  /// A tagged frame awaiting its `!ACK`, kept ENCODED (the retry re-sends the
  /// same bytes, same tag) rather than as a proto::Frame, which is five
  /// 25-byte arguments: 8 slots of encoded lines are 640 bytes less of the
  /// bridge's static RAM.
  struct Pending {
    bool used;
    uint8_t tag;
    uint8_t attempts;
    proto::Verb verb;
    uint8_t court;
    uint8_t len;
    uint32_t sentAtMs;
    char line[kPendingLineMax];
  };

  bool enqueue(const char* bytes, size_t len, bool priority);
  bool encodeAndQueue(const proto::Frame& frame, bool priority);
  uint8_t nextTag();
  void startScreen(uint32_t nowMs);
  void writeFrom(hal::ITransport& link);
  void dropOldestScreenBytes();

  MegaDialect dialect_;
  uint8_t tag_;
  uint8_t seq_;
  int8_t ackedLayout_;

  // The byte queue: priority frames are inserted ahead of the screen region,
  // never inside a frame. `inFlight_` is the frame being written now.
  char queue_[kQueueBytes];
  uint16_t count_;
  uint16_t priorityBytes_;
  char current_[proto::kMaxFrameLen];
  uint16_t currentLen_;
  uint16_t currentAt_;

  Pending pending_[kPendingSlots];
  UnackedFrame unacked_[kPendingSlots];
  uint8_t unackedCount_;

  Screen screens_[kScreenSlots];
  uint8_t screenHead_;
  uint8_t screenCount_;
  bool screenInFlight_;
  uint8_t screenSeq_;
  uint8_t screenResends_;
  uint32_t screenSentAtMs_;
  Screen inFlight_;
  bool screenBusy_;
  uint16_t screensDropped_;
  int8_t pendingLayout_;
  uint8_t layoutTag_;
};

/// Encodes `!RW`/`!CMT` for `screen` under `seq` into `out` (each frame a
/// line), and the CRC the Mega will check. Exposed for the tests.
size_t encodeV3Screen(const Screen& screen, uint8_t seq, char* out, size_t cap);

} // namespace bridgelogic

#endif // CRUSADERS_BRIDGELOGIC_MEGATX_H

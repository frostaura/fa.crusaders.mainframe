// Crusaders Mainframe — hal::IRelayPort as a line on stdout.
//
// The simulator has no coils, so the only thing this port can do is SAY what a
// driver would have put on the pin. It prints the electrical level as well as
// the logical state, and it gets that level from hal::relayLevelFor() rather
// than writing the inversion out again — so a change to the active-LOW mapping
// shows up in the simulator's transcript, which is one of the few places a
// human actually reads it.
//
// The polarity is the composition root's to name (the simulator reads the same
// RELAY_ACTIVE_LOW build flag the Mega does), so the transcript's `pin level`
// is the level the fitted relays would actually see.
//
// Rejected: reusing fakes::FakeRelay. The fakes latch an overflow flag when
// their event log fills and stop recording, because a test that overran its own
// fixture must fail loudly. A simulator runs for hours; that behaviour would
// make it stop reporting after 32 relay changes, which is a fixture rule
// leaking into a shipped binary.

#ifndef CRUSADERS_POSIX_HAL_CONSOLERELAY_H
#define CRUSADERS_POSIX_HAL_CONSOLERELAY_H

#include <stdint.h>

#include "hal/Relay.h"

namespace posix_hal {

class ConsoleRelay final : public hal::IRelayPort {
public:
  explicit ConsoleRelay(hal::RelayPolarity polarity = hal::RelayPolarity::kActiveLow);

  void set(uint8_t channel, bool on) override;

  bool isOn(uint8_t channel) const override;

  void allOff() override;

private:
  hal::RelayPolarity polarity_;
  bool state_[hal::kRelayChannelCount];
};

} // namespace posix_hal

#endif // CRUSADERS_POSIX_HAL_CONSOLERELAY_H

#include "gatelogic/GateApp.h"

#include <string.h>

#include "devapi/DeviceClient.h"
#include "devapi/Json.h"
#include "devlink/EventUpload.h"
#include "gatelogic/GateHeartbeat.h"

namespace gatelogic {

GateApp::GateApp(const Ports& ports)
    : clock_(*ports.clock), scanner_(*ports.scanner), watchdog_(*ports.watchdog), link_(*ports.link),
      api_(*ports.api), breaker_(*ports.breaker), lock_(*ports.lock), unlock_(*ports.unlock),
      led_(*ports.led), ledPin_(*ports.ledPin), assembler_(*ports.assembler), debounce_(*ports.debounce),
      roster_(*ports.roster), queue_(*ports.queue), mac_(ports.mac), firmwareVersion_(ports.firmwareVersion),
      heartbeatBody_(ports.heartbeatBody), heartbeatBodyCap_(ports.heartbeatBodyCap),
      ledActiveHigh_(ports.ledActiveHigh) {
}

// --- boot -------------------------------------------------------------------

void GateApp::beginOutputs() {
  lock_.begin();
  // The same level-before-mode rule the lock follows. A lamp is not a safety
  // surface, but two pins set up two different ways is how the safe one
  // eventually gets the unsafe treatment.
  ledPin_.write(ledPinLevel(false, ledActiveHigh_));
  ledPin_.driveOutput();
}

void GateApp::begin() {
  const uint32_t now = clock_.nowMs();
  uptime_.seed(now);
  // ScanAssembler.h has promised a reset "at boot, or on a link-down" since it
  // was written, and nothing ever called it. A board that reset mid-scan came
  // up holding the tail of somebody's line as the head of the next one.
  assembler_.reset();
  // A fallback only: the link-up edge re-arms this to "now" (pumpLink).
  heartbeatAt_.arm(now, heartbeatMs_);

  queue_.begin();
  eventq::Event boot;
  boot.kind = eventq::Kind::Boot;
  boot.court = eventq::Event::kNoCourt;
  boot.uptimeMs = now;
  static_cast<void>(queue_.push(boot));

  led_.setLinkUp(false);
  led_.cue(LedCue::Boot, now);
}

// --- one pass ---------------------------------------------------------------

void GateApp::pass() {
  blockingCalls_ = 0U;
  blocked_ = false;

  const uint32_t now = clock_.nowMs();
  uptime_.tick(now);
  watchdog_.kick();

  // The scanner FIRST, before the blocking calls below: a scan that arrived a
  // moment ago should be decided now rather than after a heartbeat has spent
  // its whole timeout finding out the API is gone.
  pumpScanner();
  pumpLock();
  pumpLink();
  pumpEvents();
  pumpHeartbeat();

  // The lamp last, so what it shows is the state every step above just left it
  // in.
  pumpLed();
}

void GateApp::beforeBlocking() {
  watchdog_.kick();
  blocked_ = true;
  ++blockingCalls_;
}

void GateApp::afterBlocking() {
  watchdog_.kick();
  // The deadline, re-checked with a FRESH clock. The call may have just spent
  // its whole worst case, and the relay is still closed on a door whose window
  // ended during it.
  pumpLock();
}

Attempt GateApp::attempt(uint32_t nowMs) {
  return chooseAttempt(linkUp_, breaker_.open(nowMs));
}

// --- the scanner ------------------------------------------------------------

void GateApp::pumpScanner() {
  if (scanner_.takeRxError()) {
    // The driver dropped bytes. What read() hands up next is in order and
    // printable and has a hole in it, so the line in flight is discarded
    // through its next terminator rather than trimmed into a token nobody
    // scanned.
    assembler_.markCorrupt();
  }

  // `!blocked_` is the ONE-CALL-PER-PASS rule, enforced where the calls
  // actually come from. A pass with three complete tokens in the buffer would
  // otherwise make three blocking calls and hold the loop for three worst
  // cases; the two that do not get decided here are not lost, they are still in
  // the UART buffer and are decided on the passes that follow, ten milliseconds
  // apart.
  uint8_t byte = 0U;
  for (uint16_t i = 0U; i < kScannerBytesPerPass && !blocked_ && scanner_.read(byte); ++i) {
    feedByte(byte);
  }
}

void GateApp::feedByte(uint8_t byte) {
  switch (assembler_.feed(byte)) {
  case ScanEvent::Token:
    decideScan(assembler_.token());
    break;
  case ScanEvent::Refused:
    refuseUnreadableLine();
    break;
  case ScanEvent::None:
    break;
  }
}

void GateApp::refuseUnreadableLine() {
  const uint32_t now = clock_.nowMs();
  // The SAME judgement a scan makes — the radio AND the breaker. Asking about
  // the radio alone queued nothing while the host was down, which is the one
  // window in which an unreadable scan is worth knowing about.
  const ScanDecision decision = refuseUnreadable(attempt(now) == Attempt::RosterOnly);
  const uint32_t granted = apply(decision, now);
  queue(decision, "", now, granted);
}

void GateApp::decideScan(const char* token) {
  const uint32_t asked = clock_.nowMs();
  if (debounce_.suppresses(token, asked)) {
    // The same phone, still held at the window. Not a decision, not an API
    // call, not an audit row, and not a re-armed lock.
    return;
  }

  ScanDecision decision;
  if (attempt(asked) == Attempt::Online) {
    beforeBlocking();
    decision = api_.scan(mac_, token, unlockMs_, kGateConfig.unlockHardCapMs);
    afterBlocking();
  } else {
    decision.fallbackToRoster = true;
  }

  // A FRESH read, on BOTH branches — the online one because the call may have
  // just spent its whole worst case, and the roster one so there is only one
  // rule here instead of two that can drift apart.
  //
  // This instant is what the release window, the queued event and the debounce
  // are all stamped from. Reading it before the call is what made a 2.9-second
  // round trip on a three-second grant a 100-millisecond relay pulse: the door
  // did not open, and the server logged an entry.
  const uint32_t now = clock_.nowMs();
  if (decision.fallbackToRoster) {
    decision = fromRoster(roster_.decide(token, roster::CourtCount(1U), now), unlockMs_,
                          kGateConfig.unlockHardCapMs);
  }

  const uint32_t granted = apply(decision, now);
  // What the lock was ACTUALLY given, not what was asked for. The two differ
  // whenever the window bound bites, and an event claiming a release the cap
  // never allowed is a club reading an audit trail that is not true.
  queue(decision, token, now, granted);
  debounce_.decided(token, now);
}

uint32_t GateApp::apply(const ScanDecision& decision, uint32_t nowMs) {
  if (!decision.released) {
    led_.cue(LedCue::Denied, nowMs);
    return 0U;
  }
  if (unlock_.request(nowMs, decision.unlockMs)) {
    // The opening edge. A re-arm changes only when the door closes, and writing
    // the relay again for a door that is already open would be a click the
    // member reads as a second decision.
    lock_.set(true);
  }
  led_.setReleased(true);
  return unlock_.remainingMs(nowMs);
}

void GateApp::queue(const ScanDecision& decision, const char* subject, uint32_t nowMs, uint32_t grantedMs) {
  if (!decision.queueEvent) {
    // Never for a decision the API itself made: the API already wrote its own
    // audit row, and a second copy would show every member entering twice.
    return;
  }
  eventq::Event event;
  event.kind = decision.eventKind;
  // A door is not on a court. The queue's sentinel renders as -1 on the wire.
  event.court = eventq::Event::kNoCourt;
  event.method = eventq::Method::Qr;
  event.uptimeMs = nowMs;
  event.durationMs = decision.released ? grantedMs : 0U;
  static_cast<void>(event.setSubject(subject));
  static_cast<void>(queue_.push(event));
}

// --- the lock, the link and the lamp ----------------------------------------

void GateApp::pumpLock() {
  if (!unlock_.tick(clock_.nowMs())) {
    return;
  }
  lock_.set(false);
  led_.setReleased(false);
}

void GateApp::pumpLink() {
  const bool up = link_.up();
  if (up == linkUp_) {
    return;
  }
  linkUp_ = up;
  led_.setLinkUp(up);
  // The bytes in flight when the radio changed state are not the head of the
  // next scan. ScanAssembler.h promises this on a link event; this is the call.
  assembler_.reset();
  if (up) {
    // Immediately, not after a full interval: the heartbeat is what fills the
    // roster, and until it has, an offline scan is refused.
    heartbeatAt_.arm(clock_.nowMs(), 0U);
  }
}

void GateApp::pumpLed() {
  ledPin_.write(ledPinLevel(led_.on(clock_.nowMs()), ledActiveHigh_));
}

// --- the two uploads --------------------------------------------------------

void GateApp::pumpEvents() {
  const uint32_t now = clock_.nowMs();
  if (blocked_ || !linkUp_ || queue_.empty() || breaker_.open(now)) {
    return;
  }

  // One event per pass. A board back from a week offline has a full ring, and
  // draining it in one iteration would stop the scanner being read — which is a
  // member standing at a door that is busy talking about last Tuesday.
  eventq::Event event;
  if (!queue_.peek(event)) {
    return;
  }

  char body[devlink::kEventBodyCap];
  if (devlink::renderEventBody(body, sizeof(body), mac_, uptime_.value(), event) == 0U) {
    // Unrenderable. The caps make this unreachable, but KEEPING it would pin
    // every later event behind it forever and the board would stop reporting
    // anything at all.
    static_cast<void>(queue_.release());
    return;
  }

  char response[192] = {};
  beforeBlocking();
  const uint16_t status = api_.uploadEvent(body, response, sizeof(response));
  afterBlocking();
  applyEventReaction(status, response);
}

void GateApp::applyEventReaction(uint16_t status, const char* response) {
  switch (devapi::react(status)) {
  case devapi::Reaction::Accepted: {
    uint32_t through = 0U;
    if (devapi::json::unsignedField(response, strlen(response), "accepted_through", through)) {
      static_cast<void>(queue_.releaseThrough(through));
    }
    return;
  }
  case devapi::Reaction::Rejected:
    // A 4xx the board caused. Retrying an identical request forever pins every
    // later event behind one the server will never take.
    static_cast<void>(queue_.release());
    return;
  case devapi::Reaction::Retry:
    // Transient, or a 401 saying the compiled-in key is wrong — which is about
    // every request rather than this event. Keep it and try again.
    return;
  }
}

void GateApp::pumpHeartbeat() {
  const uint32_t now = clock_.nowMs();
  if (blocked_ || !heartbeatAt_.expired(now) || !linkUp_) {
    return;
  }

  // THE HEARTBEAT IGNORES THE BREAKER, DELIBERATELY, AND THIS IS WHAT IT COSTS.
  // It is the probe the breaker closes on: gated by it, a board that lost the
  // API once would never find out it was back. The price is that against a dead
  // host one pass every heartbeat interval spends a whole worst-case call, and
  // a member scanning during that pass waits for it. The alternative is a door
  // that stays offline-only until somebody power-cycles it.
  heartbeatBody_[0] = '\0';
  beforeBlocking();
  const uint16_t status =
      api_.heartbeat(mac_, firmwareVersion_, uptime_.value(), heartbeatBody_, heartbeatBodyCap_);
  afterBlocking();

  // ARMED AFTER THE CALL. Armed before it, the call's own duration comes out of
  // the interval: four seconds on a thirty-second cadence is a board
  // heartbeating every twenty-six, and against a dead host — where a call costs
  // its whole worst case — every twenty-two.
  heartbeatAt_.arm(clock_.nowMs(), heartbeatMs_);

  adoptHeartbeat(status);
}

void GateApp::adoptHeartbeat(uint16_t status) {
  if (status == 403U) {
    // THE CLUB TOOK THIS BOARD OUT OF SERVICE. An empty roster, committed, so
    // the offline fallback admits nobody — leaving the old one in place would
    // keep the door letting every rostered member in for the whole staleness
    // window after an admin pressed the button meant to stop exactly that.
    //
    // Committed rather than abandoned, so `everLoaded()` stays true and the
    // refusal is `not_recognised` rather than `roster_stale`.
    //
    // THE RESIDUAL: a board that cannot REACH the server never hears the 403.
    // It keeps admitting rostered bookings until its roster goes stale at
    // ROSTER_MAX_AGE_MS, and no firmware can close that window.
    roster_.beginReplace(clock_.nowMs());
    roster_.commitReplace();
    return;
  }

  if (devapi::react(status) != devapi::Reaction::Accepted) {
    // Transient, refused, or a key the tenant does not know. Nothing to adopt
    // and nothing to do but keep the cadence: the heartbeat IS the probe the
    // breaker closes on, and a board whose key is wrong is fixed by a reflash.
    return;
  }

  const size_t len = strlen(heartbeatBody_);
  static_cast<void>(adoptUnlockMs(heartbeatBody_, len, unlockMs_));
  // The roster's times are relative to the instant the server produced them,
  // so the roster is anchored to a FRESH read. Every accepted heartbeat
  // re-anchors it, which is what resets staleness; ROSTER_MAX_AGE_MS only
  // governs how long the last one survives offline.
  lastSync_ = devlink::applyRoster(heartbeatBody_, len, roster_, clock_.nowMs());
  // Takes effect from the NEXT arm. The one above already used the old value,
  // which is a one-interval delay and not worth a re-arm that could shorten
  // this interval to nothing.
  static_cast<void>(devlink::parseHeartbeatInterval(heartbeatBody_, len, heartbeatMs_));
  // Unknown keys — anything a later contract adds — are ignored by
  // construction: every reader above looks up the key it wants.
}

} // namespace gatelogic

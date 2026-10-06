#include "gatelogic/GateApp.h"

#include <string.h>

#include "devapi/DeviceClient.h"
#include "devapi/Json.h"
#include "devlink/CodeSync.h"
#include "devlink/EventUpload.h"
#include "gatelogic/GateHeartbeat.h"

namespace gatelogic {

GateApp::GateApp(const Ports& ports)
    : clock_(*ports.clock), scanner_(*ports.scanner), watchdog_(*ports.watchdog), link_(*ports.link),
      api_(*ports.api), breaker_(*ports.breaker), lock_(*ports.lock), unlock_(*ports.unlock),
      led_(*ports.led), ledPin_(*ports.ledPin), assembler_(*ports.assembler), debounce_(*ports.debounce),
      roster_(*ports.roster), queue_(*ports.queue), faults_(*ports.faults), log_(ports.log), mac_(ports.mac),
      firmwareVersion_(ports.firmwareVersion), bootId_(ports.bootId),
      watchdogResetRun_(ports.watchdogResetRun), bootReason_(ports.bootReason),
      heartbeatBody_(ports.heartbeatBody), heartbeatBodyCap_(ports.heartbeatBodyCap),
      ledActiveHigh_(ports.ledActiveHigh) {
}

void GateApp::fault(const char* code) {
  // A FRESH CLOCK READ, like every other instant in this class. A fault
  // recorded from an instant sampled before a blocking call would arm its
  // window a whole worst case in the past and be that much less of a limit.
  faults_.record(code, clock_.nowMs());
}

// --- boot -------------------------------------------------------------------

void GateApp::setWatchdogArmed(bool armed) {
  // The lamp and nothing else. See the header for why the door is untouched.
  led_.setFault(!armed);
}

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

  // THE FIRST CALL, HELD BACK AFTER A WATCHDOG RESET (round G4, A4). A peer
  // that dribbles headers holds one `POST()` open past any budget this firmware
  // can enforce, and the watchdog ends it by resetting the part — which lands
  // right back here, arms a heartbeat, associates, and reaches that peer again
  // within a second. For ever, with no roster and a door that admits nobody.
  //
  // Armed on `firstCallAt_` rather than folded into `heartbeatAt_`, because
  // `pumpLink`'s up edge re-arms THAT to "now" on every association — which is
  // correct and is precisely what makes the loop tight. Disarmed on a healthy
  // boot, so this costs nothing in normal service.
  firstCallHeldBackMs_ = firstCallDelayMs(watchdogResetRun_);
  if (firstCallHeldBackMs_ > 0U) {
    firstCallAt_.arm(now, firstCallHeldBackMs_);
  }

  queue_.begin();
  eventq::Event boot;
  boot.kind = eventq::Kind::Boot;
  boot.court = eventq::Event::kNoCourt;
  boot.uptimeMs = now;
  static_cast<void>(queue_.push(boot));

  led_.setLinkUp(false);
  led_.cue(LedCue::Boot, now);

  // WHY THIS BOARD IS RUNNING, recorded at the one moment it is knowable.
  //
  // Both go in, and they are not the same fact: `wdt_reset` is the RUN — this
  // board has been reset by its watchdog at least once in a row and is holding
  // its first call back because of it — and `boot_reason_<x>` is this ONE
  // boot's cause, which on a healthy board is `boot_reason_power_on` and is the
  // baseline everything else is read against. A board that reports only the
  // first says nothing at all when it is well.
  //
  // `begin()` runs before any pass, so these are the first two things in the
  // log and the first fault event the drain hands the ring.
  if (watchdogResetRun_ > 0U) {
    fault(kFaultWdtReset);
  }
  if (bootReason_ != nullptr) {
    fault(bootReason_);
  }
}

// --- one pass ---------------------------------------------------------------

void GateApp::pass() {
  blockingCalls_ = 0U;
  blocked_ = false;

  const uint32_t now = clock_.nowMs();
  uptime_.tick(now);
  watchdog_.kick();
  forgetElapsedWindows(now);

  // THE LINK FIRST, because it is the input every step below is decided
  // against. Read after the scanner, `linkUp_` was a whole pass out of date,
  // so the first scan after the radio re-associated was decided from the
  // roster — and on a board whose roster is empty or stale that is a member
  // refused at a door whose network is working.
  pumpLink();

  // THE MEMBER AT THE DOOR WINS THE PASS — BUT NOT FOR EVER.
  //
  // The scanner is drained before the blocking calls below because a scan that
  // arrived a moment ago should be decided now rather than after a heartbeat
  // has spent its whole timeout finding out the API is gone. A scanner that
  // never stops talking would otherwise win EVERY pass, and a board that never
  // heartbeats is a board whose roster ages out at six hours and then admits
  // nobody. So the priority is bounded: after kMaxScanPassesBeforeUpload
  // consecutive passes in which a scan took the call with an upload waiting,
  // the upload goes first.
  //
  // WHAT THAT COSTS THE MEMBER IN THE FIFTH PASS, MEASURED RATHER THAN GUESSED.
  // This comment said "waits ten milliseconds". It is one whole blocking call
  // plus the pass tick — kWorstBlockingCallMs + kIdleDelayMs, 12 010 ms with
  // this image's numbers — and the measured figure against an 8-second
  // heartbeat was 8 081 ms. Ten milliseconds is what the scan waits when the
  // upload it queued behind returns instantly.
  //
  // AND BOTH UPLOADS ARE BOUNDED, NOT JUST THE HEARTBEAT. Round G2 bounded the
  // heartbeat alone; round G3 measured what that left: a scan offered every
  // 210 ms kept the heartbeat at 116 an hour and let the event drain post
  // NOTHING for the whole hour, so a night's offline entries sat in a ring
  // that overwrote its own oldest rows.
  const uint32_t beforeScanner = clock_.nowMs();
  const bool heartbeatDue = heartbeatReady(beforeScanner);
  const bool uploadWaiting = heartbeatDue || eventDrainReady(beforeScanner);
  if (uploadWaiting && scanDeferrals_ >= kMaxScanPassesBeforeUpload) {
    // The heartbeat first when both are waiting — it is what keeps the roster
    // fresh and what hears a 403 — and `blocked_` gives the pass to whichever
    // of the two actually got it.
    pumpHeartbeat();
    pumpEvents();
  }

  const uint16_t callsBeforeScanner = blockingCalls_;
  pumpScanner();
  const bool scanTookTheCall = blockingCalls_ > callsBeforeScanner;
  pumpLock();
  if (uploadWaiting && scanTookTheCall && scanDeferrals_ < kMaxScanPassesBeforeUpload) {
    ++scanDeferrals_;
  }

  // THE HEARTBEAT BEFORE THE EVENT DRAIN, AND THIS ORDER IS THE WHOLE OF E1.
  //
  // Both are gated on the same one-blocking-call-per-pass flag, so whichever
  // runs first takes the pass. With the drain first, an `/events` that refused
  // while keeping the head event — a 401, a 408, a 429, a 5xx, or a 200 whose
  // `accepted_through` does not reach the head — re-posted it on every pass and
  // the heartbeat NEVER RAN AGAIN. `begin()` queues a `boot` event on every
  // boot, so that was not an exotic path: it was the normal one for any board
  // that met a rate limiter, a WAF, or a club that disabled it.
  //
  // Three things followed, each worse than the refusal: the roster aged out at
  // ROSTER_MAX_AGE_MS and the door then admitted NOBODY; a board taken out of
  // service never heard the heartbeat's 403 and kept admitting rostered
  // members through a door an admin believed was shut; and the API was hammered
  // about twenty-five times a second by a device that speaks twice a minute.
  //
  // A heartbeat is due once an interval. This costs the drain one pass in three
  // thousand and is what keeps the roster fresh.
  pumpHeartbeat();
  pumpEvents();

  // AFTER BOTH UPLOADS, so everything this pass noticed — including the HTTP
  // status of the one blocking call it made — is counted before the drain
  // looks. It makes no call of its own and is therefore outside the
  // one-call-per-pass rule entirely.
  pumpFaults();

  // The lamp last, so what it shows is the state every step above just left it
  // in.
  pumpLed();
}

namespace {

/// Disarms `window` once it has ended. Disarmed reads exactly as elapsed does —
/// remaining() is 0 either way — so this changes no decision; it only stops an
/// ended window AGEING.
void forgetIfElapsed(tb::Deadline& window, uint32_t nowMs) {
  if (window.isArmed() && window.remaining(nowMs) == 0U) {
    window.disarm();
  }
}

} // namespace

void GateApp::forgetElapsedWindows(uint32_t nowMs) {
  // EVERY "MAY I YET?" WINDOW, ON EVERY PASS, WHATEVER THE LINK IS DOING
  // (review round 17, D17-2). A Deadline armed more than 2^31 ms ago reads as
  // PENDING again, and each of these was looked at only by the step it gates —
  // which does not run while the radio is down, the breaker is open, or nobody
  // is at the door. Measured in the suite, after a quiet spell past 24.8 days:
  // the event drain's backoff and the heartbeat's floor kept a board whose link
  // had come back silent, so its roster never refilled; the `/gate` call floor
  // refused the first member back `too_fast`; the unreadable-line window met a
  // holed line with silence — each for up to 24.8 MORE days. Disarmed here
  // within one pass of ending, none of them can age. `eventBackoffMs_` is kept,
  // so the next refusal still doubles from where the last one left off.
  //
  // NOT `heartbeatAt_`: its expired() means "due", disarmed means "never", and
  // the link-up edge re-arms it to "now" (pumpLink), which is its own cure.
  forgetIfElapsed(firstCallAt_, nowMs);
  forgetIfElapsed(scanCallFloorAt_, nowMs);
  forgetIfElapsed(unreadableAt_, nowMs);
  forgetIfElapsed(heartbeatFloorAt_, nowMs);
  forgetIfElapsed(eventsAt_, nowMs);

  // AND EVERY "HOW OLD IS IT?" AGE, for the mirror-image reason (review round
  // 18, D18-2). An age is a 32-bit difference, so one 2^32 ms + 1 s old reads
  // one second old: a roster from before a 49.7-day outage opened the door for
  // a seven-week-old booking, the step clock trusted a sync 143 165 steps
  // behind, a debounce slot dropped its member's next scan, and the lamp
  // replayed a refusal. Each latches — or forgets — here, on the pass its age
  // passes its bound, so no later reading can make it young again.
  roster_.observe(nowMs);
  stepClock_.observe(nowMs);
  debounce_.observe(nowMs);
  led_.observe(nowMs);
}

void GateApp::pumpFaults() {
  const uint32_t now = clock_.nowMs();

  // THE TWO FAULTS THAT ARE ONLY VISIBLE AS A CHANGE.
  //
  // `EventQueue::overflowed()` is a since-boot TOTAL, and what the fault
  // channel wants is occurrences, so the jump between two passes is what is
  // recorded — in one call, because a board back from an evening offline can
  // jump by hundreds and a loop here would be a pass spent counting.
  const uint32_t lost = queue_.overflowed();
  if (lost > eventsLostSeen_) {
    faults_.recordMany(kFaultQueueOverflow, now, lost - eventsLostSeen_);
    eventsLostSeen_ = lost;
  }

  // The breaker's closed→OPEN edge, not its state: a breaker that stays open
  // for ten minutes is ONE fault, and counting the state would be one per pass
  // — about a hundred a second — which the aggregation would then faithfully
  // report as a board with sixty thousand faults an hour.
  const bool open = breaker_.open(now);
  if (open && !breakerWasOpen_) {
    faults_.record(kFaultBreakerOpen, now);
  }
  breakerWasOpen_ = open;

  // A DIAGNOSTIC MAY NOT EVICT AN ADMISSION, AND A FULL RING IS THE ONLY STATE
  // IN WHICH IT COULD (round G4's H1, arriving from the other direction).
  //
  // The ring fills only while the board is offline — online it drains a pass at
  // a time — and offline is exactly when every slot is a `gate_open` nobody
  // else knows about. `isDiscardable(Kind::Fault)` protects the OTHER kinds
  // from a fault already IN the ring; it does nothing about the push that puts
  // one there, which on a ring full of `gate_open` evicts the oldest admission.
  //
  // Measured: the evicted record itself increments `overflowed()`, which is a
  // `queue_overflow` fault, which is another push a window later. A diagnostic
  // that eats the records it is diagnosing.
  //
  // NOTHING IS LOST BY WAITING. The count stays in the log and goes out whole
  // once the link returns and the drain makes room — which is the entire reason
  // a fault is counted rather than queued.
  if (queue_.full()) {
    return;
  }

  // AT MOST ONE. See the header on this function.
  eventq::Event event;
  if (faults_.drain(now, event)) {
    static_cast<void>(queue_.push(event));
  }
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
    // THE HOLE IS AT THE TAIL OF WHAT IS BUFFERED, NOT IN THE LINE IN ASSEMBLY.
    //
    // A receive FIFO overruns when it is FULL: everything the driver already
    // has it keeps, and what it drops is what arrived next. So the bytes
    // `read()` hands up afterwards are the OLD ones — in order, printable,
    // whole lines — followed by the far side of a hole. Marking only the line
    // in assembly therefore poisoned the WRONG LINE: a good buffered line was
    // thrown away and the holed one was handed up a few passes later as a
    // perfectly valid token, which is a refusal for somebody standing there
    // or, far worse, a match on another member's booking.
    //
    // The whole buffer goes instead, and then everything through the NEXT
    // TERMINATOR, because the last thing buffered may be half of the holed
    // line. If the drain ended ON a terminator the holed line is already
    // complete and the next byte starts a clean one.
    // AND IT IS SAID OUT LOUD NOW. A UART overrun was the quietest thing this
    // board could notice: the member got a denial blink, the bytes went in the
    // bin, and nothing anywhere could tell a cable running beside a switching
    // relay coil from a member presenting a dead code. 9600 baud on jumper wire
    // produces these by the dozen a minute when the routing is wrong, and the
    // fix is a cable, which nobody can order without evidence.
    fault(kFaultScannerUartError);

    bool endedOnTerminator = false;
    uint8_t dropped = 0U;
    for (uint16_t i = 0U; i < kScannerDrainOnErrorBytes && scanner_.read(dropped); ++i) {
      endedOnTerminator = isLineTerminator(dropped);
    }
    assembler_.reset();
    if (!endedOnTerminator) {
      assembler_.markCorrupt();
    }
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
  // THE SAME ANSWER TO THE MEMBER FOR BOTH, and that is deliberate. From where
  // they are standing an over-long code and a holed one are one thing — the
  // board could not read what they presented — and there is nothing to ask the
  // API about in either case, because the bytes were discarded rather than
  // truncated and a token cut short is a different member's token.
  //
  // `Corrupt` used to be `None`: no blink, no record, nothing, while
  // `pumpScanner`'s comment promised feedback (round G4, L1).
  //
  // THE CLUB DOES NOT GET THE SAME ANSWER, and that is the fault channel's
  // whole point. An over-long line is somebody presenting the wrong KIND of
  // code — a shipping label, a loyalty card, a QR that is not the club's — and
  // it is answered at the desk. A corrupt line is a CABLE, routed beside a
  // switching relay coil, and it is answered with a cable. Two codes, because
  // two different people do something about them.
  case ScanEvent::Refused:
    fault(kFaultScanOversize);
    refuseUnreadableLine();
    break;
  case ScanEvent::Corrupt:
    // COUNTED HERE AS WELL AS AT THE DRIVER OVERRUN IN `pumpScanner`, and the
    // two are not one event counted twice: an overrun that happens to end on a
    // terminator never produces a `Corrupt` at all, and a byte outside the
    // roster's alphabet produces one with no overrun anywhere. Counting only
    // one of the two would leave a whole path silent, which is the state this
    // code is being added to end. The number means "times the scanner could not
    // be read", not "distinct root causes".
    fault(kFaultScannerUartError);
    refuseUnreadableLine();
    break;
  case ScanEvent::None:
    break;
  }
}

void GateApp::refuseUnreadableLine() {
  const uint32_t now = clock_.nowMs();
  // RATE-LIMITED, AND THIS IS WHAT MAKES L1'S FEEDBACK SAFE TO GIVE. A cable
  // running beside a switching relay coil produces holed lines by the hundred:
  // unlimited, the lamp would strobe and, offline, the event ring would fill
  // with noise and evict the admissions that matter. One answer per window,
  // which is the debounce's own number — the rate a member's own repeated scans
  // are already answered at — and what happens in between is nothing at all
  // rather than something quieter.
  if (unreadableAt_.remaining(now) > 0U) {
    return;
  }
  unreadableAt_.arm(now, kUnreadableFeedbackMs);
  // The SAME judgement a scan makes — the radio AND the breaker. Asking about
  // the radio alone queued nothing while the host was down, which is the one
  // window in which an unreadable scan is worth knowing about.
  ScanDecision decision = refuseUnreadable(attempt(now) == Attempt::RosterOnly);
  const uint32_t granted = apply(decision, now);
  queue(decision, "", now, granted);
  // No token: the bytes were discarded rather than truncated, and a token cut
  // short is a different member's token.
  report(decision, "", now, granted);
}

void GateApp::decideScan(const char* token) {
  const uint32_t asked = clock_.nowMs();
  if (debounce_.suppresses(token, asked)) {
    // The same phone, still held at the window. Not a decision, not an API
    // call, not an audit row, and not a re-armed lock.
    return;
  }

  ScanDecision decision;
  const Attempt how = attempt(asked);
  if (unlock_.relocking(asked)) {
    // THE LOCK HAS NOT FINISHED RELATCHING (round G4, A1). Refused here rather
    // than asked about, on exactly the debounce's precedent above: a scan this
    // board cannot honour is not a question for the API, and a 200 answering
    // `opened` would put a door opening in the server's trail that did not
    // happen. The member gets the WAIT pulse — one slow breath rather than the
    // refusal's stutter, because this is the lock relatching and not a decision
    // about them — and scans again.
    decision = refuseRelocking(how == Attempt::RosterOnly);
  } else if (how == Attempt::Online && knownReplay(token, asked)) {
    // A CODE THIS DOOR HAS ALREADY ACTED ON is not a question for the API
    // (refuted 2026-09-28). A door that opened OFFLINE for code C and whose link
    // came back inside C's window has not uploaded that open yet, so the server
    // has never heard of it and would open again for a photo of C. Decided from
    // the roster path instead, which refuses it as `replayed` — the same answer,
    // screen and record the offline path gives, with no call made.
    decision.fallbackToRoster = true;
  } else if (how == Attempt::Online && scanCallFloorAt_.remaining(asked) > 0U) {
    // THE FLOOR UNDER `/gate` CALLS (round G4, A2). The debounce bounds repeats
    // and cannot bound a stream of tokens it has never seen — a rotating
    // generator, or a reader pointed at a sheet of printed codes, drove a
    // measured eighteen POSTs a second. Refused rather than answered from the
    // roster: the roster does not know about a membership barred this morning,
    // so letting a throttle send a scan there would be this board's own rate
    // limiting opening a door the API would have refused.
    //
    // NOT QUEUED (the `false`): this branch only runs when the board is ONLINE,
    // and the queue is for decisions the API does not already know about. The
    // API knows nothing about this one either — but it is about this board's own
    // throttle rather than about the member, and a ring filling with a board's
    // notes to itself is the H1 eviction problem with a different cause.
    decision = refuseTooFast(false);
  } else if (how == Attempt::Online) {
    scanCallFloorAt_.arm(asked, kMinScanCallSpacingMs);
    beforeBlocking();
    decision = api_.scan(mac_, token, unlockMs_, kGateConfig.unlockHardCapMs);
    afterBlocking();
  } else {
    decision.fallbackToRoster = true;
  }

  // A FRESH read, on EVERY branch above — the online one because the call may
  // have just spent its whole worst case, and the other three so there is one
  // rule here rather than four that can drift apart.
  //
  // This instant is what the release window, the queued event and the debounce
  // are all stamped from. Reading it before the call is what made a 2.9-second
  // round trip on a three-second grant a 100-millisecond relay pulse: the door
  // did not open, and the server logged an entry.
  const uint32_t now = clock_.nowMs();
  if (decision.outOfService) {
    // The same authoritative word as on the heartbeat and the event drain, on
    // whichever of the three paths this board happened to speak on first.
    commitEmptyRoster();
  }
  memcode::Verdict member;
  if (decision.fallbackToRoster) {
    decision = decideFromRoster(token, now, member);
  }

  const uint32_t granted = apply(decision, now);
  recordCodeUse(decision, member, token, granted, now);
  // What the lock was ACTUALLY given, not what was asked for. The two differ
  // whenever the window bound bites, and an event claiming a release the cap
  // never allowed is a club reading an audit trail that is not true.
  queue(decision, token, now, granted);
  debounce_.decided(token, now);
  // LAST, after the door and the lamp are already driven and the event is
  // already queued. An observer that ran first would be an observer a reader
  // could mistake for a step.
  report(decision, token, now, granted);
}

ScanDecision GateApp::decideFromRoster(const char* token, uint32_t nowMs, memcode::Verdict& member) {
  if (!memcode::looksLikeV1(token)) {
    return fromRoster(roster_.decide(token, roster::CourtCount(1U), nowMs), unlockMs_,
                      kGateConfig.unlockHardCapMs);
  }
  // A SINGLE ROTATING MEMBER CODE is never in the roster — it changes every
  // thirty seconds — so it is VERIFIED rather than matched, and the member it
  // proves is looked up in the roster's REF lists. See fromMemberCode.
  const memcode::OfflineCodes<memcode::KeyRing<kGateKeyRingSlots>, memcode::ReplayRing<kGateReplaySlots>>
      codes = {stepClock_, codeKeys_, codeUses_, codeGuard_};
  const OfflineCodeDecision offline =
      decideOfflineMemberCode(token, codes, roster_, unlockMs_, kGateConfig.unlockHardCapMs, nowMs);
  member = offline.verdict;
  return offline.decision;
}

bool GateApp::knownReplay(const char* token, uint32_t nowMs) const {
  return memcode::knownReplay(token, stepClock_, codeKeys_, codeUses_, nowMs);
}

void GateApp::recordCodeUse(const ScanDecision& decision, const memcode::Verdict& member, const char* token,
                            uint32_t grantedMs, uint32_t nowMs) {
  if (!decision.released || grantedMs == 0U) {
    // A relocking refusal, or any refusal: nothing opened, and the member's
    // next scan with the same code must not be refused as a replay of an
    // opening that did not happen.
    return;
  }
  if (member.status == memcode::Status::Ok) {
    codeUses_.commit(member.token.ref, member.step);
  } else if (!decision.queueEvent) {
    // THE SERVER opened this door for this code. Record the use here too, or a
    // photo of the same v1 code could open it again offline inside its window
    // the moment the link drops. A legacy code records nothing.
    memcode::recordOnlineUse(token, stepClock_, codeKeys_, codeUses_, nowMs);
  }
}

void GateApp::report(const ScanDecision& decision, const char* token, uint32_t nowMs, uint32_t grantedMs) {
  if (log_ == nullptr) {
    // Every board. There is no console on an ESP32 door gate.
    return;
  }
  log_->decided(decision, token, grantedMs, nowMs);
}

uint32_t GateApp::apply(ScanDecision& decision, uint32_t nowMs) {
  if (!decision.released) {
    // "In a moment" and "no" are different answers and the lamp is the only
    // channel that can carry either. See ScanDecision::askedToWait.
    led_.cue(decision.askedToWait ? LedCue::Wait : LedCue::Denied, nowMs);
    return 0U;
  }
  switch (unlock_.request(nowMs, decision.unlockMs)) {
  case UnlockTimer::Grant::Opened:
    // The opening edge. A re-arm changes only when the door closes, and writing
    // the relay again for a door that is already open would be a click the
    // member reads as a second decision.
    lock_.set(true);
    break;
  case UnlockTimer::Grant::Extended:
    break;
  case UnlockTimer::Grant::Relocking:
    // A1's SECOND HALF, and the one that catches the measured case. `pass()`
    // pumps the lock out of `afterBlocking()` and applies this decision two
    // lines later, so a window can close inside the very call that granted
    // this — which is how a relay was measured writing OFF and ON at the same
    // millisecond, for ever. The decision is rewritten rather than dropped:
    // the lamp asks them to WAIT rather than denying them, the log says
    // `relocking`, and an offline record says a scan was refused rather than
    // that a door opened.
    markRelocking(decision);
    led_.cue(LedCue::Wait, nowMs);
    return 0U;
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
  const uint32_t now = clock_.nowMs();
  // READ BEFORE THE TICK, because the tick is what clears it. This is how long
  // the RELAY was actually energised for this window, which is a different
  // number from the deadline and is the only one a lock cares about.
  const uint32_t heldMs = unlock_.releasedForMs(now);
  const UnlockTimer::Close closed = unlock_.tick(now);
  if (closed == UnlockTimer::Close::None) {
    return;
  }
  lock_.set(false);
  led_.setReleased(false);

  // THE ARITHMETIC IN GateConfig.h, CHECKED AGAINST WHAT THE RELAY DID.
  //
  // `kMaxPhysicalReleaseMs` is the cap plus one worst-case blocking call plus
  // one pass tick — 42 010 ms — and it has been a sentence in three files and a
  // literal in one test while nothing on the board ever compared it to reality.
  // A release longer than it means the loop did not get back to its own lock
  // inside the budget the whole of that arithmetic is built on, and until now
  // the only surface that could have said so was a door standing open.
  //
  // NOT REACHABLE BY THE WATCHDOG CASE, and saying so matters: a peer that
  // dribbles headers is ended by GATE_WATCHDOG_SECONDS and the reset takes the
  // lock back in `beginOutputs()`, so nothing is running here to notice. That
  // one shows up as `wdt_reset` and `boot_reason_task_wdt` on the next boot.
  if (heldMs > kMaxPhysicalReleaseMs) {
    fault(kFaultRelockOverdue);
  }

  if (closed == UnlockTimer::Close::CapForced) {
    // A WINDOW THAT RAN THE WHOLE HARD CAP. Counted rather than queued, and
    // that is a stated limitation rather than an oversight: the event queue has
    // no kind for it, a new kind is a wire change needing a corpus vector and a
    // backend that tolerates it, and this lane already carries one. What exists
    // is this counter, the `relocking` refusals the dwell then produces — which
    // DO reach the queue offline — and the decision log the simulator prints.
    capForcedCloses_ = saturatingIncrement(capForcedCloses_);
  }
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
    //
    // `heartbeatFloorAt_` is what stops this being a hammer. A door at the edge
    // of the AP's range re-arms this on every pass, and without the floor that
    // was 179 999 calls in a simulated hour against a cadence of 120.
    heartbeatAt_.arm(clock_.nowMs(), 0U);
    return;
  }
  // THE RADIO WENT AWAY. The deferral debt goes with it: those passes were
  // spent deferring an upload that could not have run, and carrying them
  // forward makes the first pass after the link returns take the blocking call
  // from a member standing at the door.
  scanDeferrals_ = 0U;
}

void GateApp::pumpLed() {
  ledPin_.write(ledPinLevel(led_.on(clock_.nowMs()), ledActiveHigh_));
}

// --- the two uploads --------------------------------------------------------

bool GateApp::heartbeatReady(uint32_t nowMs) const {
  // THE FLOOR IS PART OF "READY", and it is here for a TESTABILITY reason
  // rather than a behavioural one — said plainly, because a comment claiming a
  // fix nothing can demonstrate is worse than no comment.
  //
  // Behaviourally it changes nothing: a forced branch that gives the pass to a
  // heartbeat the floor then refuses is a no-op, and the scan happens anyway
  // two lines later. What it changes is what `uploadWaiting` MEANS. A link-up
  // edge arms `heartbeatAt_` to "now" and `pumpHeartbeat` returns at the floor
  // without re-arming, so after any link edge `expired()` alone stays true for
  // up to kMinHeartbeatSpacingMs — which made `uploadWaiting` permanently true
  // in every scenario with a flapping radio, and therefore made the E3 bound on
  // the EVENT drain impossible to distinguish from the round-G2 code that did
  // not have it. A predicate that is always true proves nothing.
  return heartbeatAt_.expired(nowMs) && linkUp_ && heartbeatFloorAt_.remaining(nowMs) == 0U &&
         firstCallAt_.remaining(nowMs) == 0U;
}

bool GateApp::eventDrainReady(uint32_t nowMs) const {
  // Everything pumpEvents checks EXCEPT `blocked_`, which is about this pass
  // rather than about the drain: `pass()` asks this before anything has taken
  // the call, to decide whether a busy scanner is starving an upload.
  //
  // THE BACKOFF IS PART OF "READY". A drain that is backed off is not waiting
  // for the pass's call and must not make a member's scan wait for one.
  return linkUp_ && !queue_.empty() && !breaker_.open(nowMs) && eventsAt_.remaining(nowMs) == 0U &&
         firstCallAt_.remaining(nowMs) == 0U;
}

void GateApp::pumpEvents() {
  const uint32_t now = clock_.nowMs();
  // THE BACKOFF. Disarmed on a healthy board, so this costs nothing; armed by
  // the last post that left the head event exactly where it was. Without it,
  // an endpoint that refuses-and-keeps is a hot loop — which is what starved
  // the heartbeat, and what hammered the API.
  if (blocked_ || !eventDrainReady(now)) {
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
  if (devlink::renderEventBody(body, sizeof(body), mac_, bootId_, uptime_.value(), event) == 0U) {
    // Unrenderable. The caps make this unreachable, but KEEPING it would pin
    // every later event behind it forever and the board would stop reporting
    // anything at all.
    static_cast<void>(queue_.release());
    return;
  }

  char response[192] = {};
  const uint16_t held = queue_.size();
  // AN UPLOAD IS TAKING THE PASS, so the scanner owes nothing. Cleared here as
  // well as in pumpHeartbeat because the bound covers both uploads: counting
  // only the passes the HEARTBEAT lost is how the drain went a measured hour
  // without posting anything while the heartbeat kept its cadence.
  scanDeferrals_ = 0U;
  beforeBlocking();
  const uint16_t status = api_.uploadEvent(body, response, sizeof(response));
  afterBlocking();
  applyEventReaction(status, response);

  // DID THE QUEUE ACTUALLY MOVE? Not "what did the server say": a 200 whose
  // `accepted_through` does not reach the head leaves it exactly where a 429
  // does, and a drain that paced itself on the STATUS would have kept the one
  // healthy-looking hot loop that every board can reach from its own boot
  // event.
  armEventRetry(queue_.size() < held);
}

void GateApp::armEventRetry(bool queueMoved) {
  if (queueMoved) {
    // Progress. Back to the loop's own pace immediately, so a rate limiter
    // lifting does not leave a healthy board posting once every five minutes
    // for the rest of the evening.
    eventBackoffMs_ = 0U;
    eventsAt_.disarm();
    return;
  }

  eventBackoffMs_ = (eventBackoffMs_ == 0U)                      ? kEventRetryStartMs
                    : (eventBackoffMs_ >= kEventRetryMaxMs / 2U) ? kEventRetryMaxMs
                                                                 : eventBackoffMs_ * 2U;
  // A FRESH clock read, like every other instant on this side of a blocking
  // call: armed from before it, a backoff window starts a whole worst-case
  // call in the past and is that much shorter than it says.
  eventsAt_.arm(clock_.nowMs(), eventBackoffMs_);
}

void GateApp::applyEventReaction(uint16_t status, const char* response) {
  if (status == 403U) {
    // THE SAME AUTHORITATIVE WORD AS ON `/gate` AND ON THE HEARTBEAT: the club
    // took this board out of service. It is the one 4xx that is a statement
    // about the BOARD rather than about this request, and it arrives here
    // first on exactly the board this matters most for — one with something in
    // its ring, which after `begin()` is every board.
    //
    // The event is KEPT. This board did nothing wrong, the club may put it back
    // in service, and an evening of entries is not thrown away over a button
    // somebody pressed by mistake. The backoff above is what stops that being a
    // hot loop; it used to be one.
    commitEmptyRoster();
    return;
  }

  if (status == 404U) {
    // A 404 ON `/events` IS NOT A REJECTION, AND `devapi::react` SAYS IT IS.
    //
    // That mapping is right for the court box — a 4xx the box caused, drop it —
    // and it is shared, so it is not changed here. On THIS route a 404 has one
    // production meaning: the API did not recognise this MAC, because the
    // device row was deleted from the console. The board re-registers on its
    // next heartbeat and the very same event is accepted, so dropping it throws
    // away an evening of door entries to save twelve requests an hour.
    //
    // The other way to get one is a proxy path that does not reach the API at
    // all — a base URL with a trailing slash, a misconfigured route — which is
    // a fault a person fixes and in the meantime is an outage, not a refusal.
    // Both readings want the event KEPT, at the backoff's pace.
    return;
  }

  switch (devapi::react(status)) {
  case devapi::Reaction::Accepted: {
    uint32_t through = 0U;
    // TOP-LEVEL (round G4, B2). This number RELEASES RECORDS — everything at or
    // below it leaves the ring for ever — so it is read from the object the
    // server sent rather than from anywhere one happens to appear.
    if (devapi::json::topLevelUnsignedField(response, strlen(response), "accepted_through", through)) {
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

  // THE FLOOR, AND IT IS ABOUT THE PREVIOUS ATTEMPT RATHER THAN THE CADENCE.
  //
  // `pumpLink` re-arms `heartbeatAt_` to "now" on every link-UP edge, which is
  // right — the heartbeat is what fills the roster, and until it has, an
  // offline scan is refused. On a door at the edge of the AP's range it is also
  // one heartbeat per pass: 179 999 in a simulated hour against a cadence of
  // 120, an API the club would read as an attack.
  //
  // Armed from the ATTEMPT below, not from its success, because a call that
  // fails must not be retried faster than one that succeeds — a refusing host
  // is exactly the case a flapping radio produces.
  if (heartbeatFloorAt_.remaining(now) > 0U) {
    return;
  }

  // AND THE BOOT BACKOFF, which is the same shape of rule for a different
  // reason: the floor bounds how often this board speaks, and this bounds how
  // soon it speaks after the watchdog reset it. See BootRecovery.h.
  if (firstCallAt_.remaining(now) > 0U) {
    return;
  }

  // THE HEARTBEAT IGNORES THE BREAKER, DELIBERATELY, AND THIS IS WHAT IT COSTS.
  // It is the probe the breaker closes on: gated by it, a board that lost the
  // API once would never find out it was back. The price is that against a dead
  // host one pass every heartbeat interval spends a whole worst-case call, and
  // a member scanning during that pass waits for it. The alternative is a door
  // that stays offline-only until somebody power-cycles it.
  //
  // The scan-deferral count is cleared here rather than in pass(), so it counts
  // passes the heartbeat actually LOST rather than passes that went by.
  scanDeferrals_ = 0U;
  heartbeatBody_[0] = '\0';
  // THE FLOOR IS ARMED BEFORE THE CALL, from the instant of the ATTEMPT. It is
  // the one deadline on this board that is deliberately not sampled afterwards:
  // arming it from after a four-second call would make the spacing four seconds
  // longer than it says, and the spacing is a bound on request RATE rather than
  // a gap the board owes anybody.
  heartbeatFloorAt_.arm(clock_.nowMs(), kMinHeartbeatSpacingMs);
  beforeBlocking();
  const HttpOutcome outcome = api_.heartbeat(mac_, firmwareVersion_, uptime_.value(), diagnostics(),
                                             heartbeatBody_, heartbeatBodyCap_);
  afterBlocking();

  // ARMED AFTER THE CALL. Armed before it, the call's own duration comes out of
  // the interval: four seconds on a thirty-second cadence is a board
  // heartbeating every twenty-six, and against a dead host — where a call costs
  // its whole worst case — every twenty-two.
  heartbeatAt_.arm(clock_.nowMs(), heartbeatMs_);

  adoptHeartbeat(outcome);
}

void GateApp::commitEmptyRoster() {
  // THE CLUB TOOK THIS BOARD OUT OF SERVICE. An empty roster, committed, so
  // the offline fallback admits nobody — leaving the old one in place would
  // keep the door letting every rostered member in for the whole staleness
  // window after an admin pressed the button meant to stop exactly that.
  //
  // Committed rather than abandoned, so `everLoaded()` stays true and the
  // refusal is `not_recognised` rather than `roster_stale`.
  //
  // THE RESIDUAL, and it is narrower than it was but not closed: only a board
  // that cannot REACH the server never hears the 403. It keeps admitting
  // rostered bookings until its roster goes stale at ROSTER_MAX_AGE_MS, and no
  // firmware can close that window. A board that CAN reach the server now
  // hears it on whichever of the three paths it speaks on first.
  roster_.beginReplace(clock_.nowMs());
  roster_.commitReplace();
  // And the member-code keys with it: a board out of service verifies nobody.
  codeKeys_.clear();
  stepClock_.forget();
}

void GateApp::adoptGateSettings(const char* body, size_t len) {
  static_cast<void>(adoptUnlockMs(body, len, unlockMs_));

  // THE SERVER AND THIS BOARD DISAGREE ABOUT THIS DOOR. The clamp above is not
  // in dispute — the board must not trust the server to have clamped, and it
  // does not — but the clamp cannot say that it HAPPENED, so the door then runs
  // for a number no console shows while the server believes its own. This is
  // the first thing on this hardware that can say so.
  if (unlockSecondsWereClamped(body, len)) {
    fault(kFaultUnlockClamped);
  }

  // The two fault settings, adopted on the SAME rule as the release time: the
  // board's working values go in, whatever the body actually carried comes
  // back, and an absent key — or one of the wrong JSON type — leaves that value
  // exactly where it was. An older API that sends neither must not silence a
  // board a newer one configured.
  GateFaultSettings settings{faults_.reporting(), faults_.maxPerHour()};
  if (adoptFaultSettings(body, len, settings)) {
    faults_.setReporting(settings.reporting);
    faults_.setMaxPerHour(settings.maxPerHour);
  }
}

void GateApp::adoptHeartbeat(const HttpOutcome& outcome) {
  if (outcome.status == 403U) {
    commitEmptyRoster();
    // A REFUSAL OF THE HEARTBEAT SPECIFICALLY, and it is not the same fact as
    // the `http_4xx` `GateApi` already counted for this call. That one says a
    // 4xx happened somewhere; this one says THE HEARTBEAT was refused, which
    // means this board has no roster and, offline, will admit nobody. Two
    // codes, because a club reading the trail needs to tell "one scan was
    // refused" from "this door has been switched off".
    fault(kFaultHeartbeatRejected);
    return;
  }

  if (devapi::react(outcome.status) != devapi::Reaction::Accepted) {
    // A 401 with the wrong compiled-in key, a 400, a 404 on a proxied path:
    // every one of them is a board that is not being given a roster. A
    // transport failure is NOT counted here — `GateApi` already recorded it as
    // `http_timeout`, and a board whose WiFi is down has not been rejected by
    // anybody.
    if (devapi::react(outcome.peerStatus) == devapi::Reaction::Rejected) {
      fault(kFaultHeartbeatRejected);
    }
    // A BODY THAT DID NOT ARRIVE ON AN OTHERWISE-ACCEPTED HEARTBEAT IS A
    // NO-PUSH, AND ROUND G2 MADE IT THE QUIETEST PATH IN THE FIRMWARE.
    //
    // Before G2 an over-long body was truncated, `applyRoster` refused it, and
    // the counter below moved. After G2 it became status 0 — correctly, a
    // transport failure — and this early return skipped the count, so the one
    // diagnostic that exists to say "the roster is not being refreshed" went
    // silent in exactly the case it was built for. `peerStatus` is what tells
    // that apart from a host that never answered, which is not a no-push and
    // must not inflate the number an admin reads off the device row.
    if (bodyFailed(outcome) && devapi::react(outcome.peerStatus) == devapi::Reaction::Accepted) {
      noPushHeartbeats_ = saturatingIncrement(noPushHeartbeats_);
    }
    // Otherwise: transient, refused, or a key the tenant does not know. Nothing
    // to adopt and nothing to do but keep the cadence — the heartbeat IS the
    // probe the breaker closes on, and a board whose key is wrong is fixed by a
    // reflash.
    return;
  }

  const size_t len = strlen(heartbeatBody_);
  // The release time, whether this board's own clamp had to change it, and the
  // two fault settings — everything the `gate` object carries, in one place.
  adoptGateSettings(heartbeatBody_, len);
  // The roster's times are relative to the instant the server produced them,
  // so the roster is anchored to a FRESH read. Every accepted heartbeat
  // re-anchors it, which is what resets staleness; ROSTER_MAX_AGE_MS only
  // governs how long the last one survives offline.
  lastSync_ = devlink::applyRoster(heartbeatBody_, len, roster_, clock_.nowMs());
  // The member-code sync — step clock, day slots, per-day keys — anchored to a
  // fresh read like the roster, and wholesale like it: a server that has not
  // shipped member codes sends no `code_keys`, and nothing here changes.
  //
  // Refused and dropped keys are NOT recorded as faults, exactly as refused
  // roster elements are not: the gate's fault vocabulary is closed and the
  // server validates it, so a new code is a wire change of its own.
  static_cast<void>(devlink::applyCodeSync(heartbeatBody_, len, stepClock_, codeKeys_, clock_.nowMs()));
  if (!lastSync_.replaced) {
    // AN ACCEPTED HEARTBEAT THAT PUSHED NOTHING. A body cut short by a peer
    // that hung up, or one missing the `roster` key the contract says is
    // always present. The roster silently does not change and its age silently
    // keeps running, and the one feedback surface on this board is a lamp with
    // nothing to say about it — so the count goes out in the next request,
    // where an admin can read it off the device row. Counted rather than acted
    // on: it changes no decision here.
    noPushHeartbeats_ = saturatingIncrement(noPushHeartbeats_);
  }
  // Takes effect from the NEXT arm. The one above already used the old value,
  // which is a one-interval delay and not worth a re-arm that could shorten
  // this interval to nothing.
  static_cast<void>(devlink::parseHeartbeatInterval(heartbeatBody_, len, heartbeatMs_));
  // Unknown keys — anything a later contract adds — are ignored by
  // construction: every reader above looks up the key it wants.
}

} // namespace gatelogic

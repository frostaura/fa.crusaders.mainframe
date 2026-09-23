// The court box against the member-code corpus — every case in
// src/contracts/device-protocol/membercode/ whose `read_by` names
// `fw-court-box`, executed and counted — plus the box's own offline v1 path and
// its pay-for flow, which no corpus can reach because they are about the
// session, the event and the glass rather than about bytes.
//
// The primitives, the token, the roster's REF lists, the key ring and the
// verifier are proved in ../../shared/test/test_memcode against the same corpus;
// this suite proves what THIS box renders and how it reads what it is sent.

#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unity.h>

#include "bridgelogic/MemberScan.h"
#include "bridgelogic/PayFor.h"
#include "bridgelogic/RosterTokenFits.h"
#include "bridgelogic/ScanFlow.h"
#include "bridgelogic/ScreenScript.h"
#include "bridgelogic/StateReconcile.h"
#include "bridgelogic/WalkUp.h"
#include "court/Session.h"
#include "devapi/DeviceClient.h"
#include "devapi/Json.h"
#include "devlink/Cadence.h"
#include "devlink/CodeSync.h"
#include "devlink/EventUpload.h"
#include "devlink/LcdSettings.h"
#include "devlink/RosterSync.h"
#include "eventq/EventQueue.h"
#include "fakes/FakeStore.h"
#include "memcode/GuessGuard.h"
#include "memcode/KeyRing.h"
#include "memcode/ReplayRing.h"
#include "memcode/StepClock.h"
#include "memcode/Token.h"
#include "memcode/Totp.h"
#include "roster/Roster.h"
#include "support/CorpusJson.h"

void setUp(void) {
}

void tearDown(void) {
}

namespace {

constexpr char kFamily[] = "membercode";
constexpr char kFile[] = "http.json";

corpus::File g_http;
corpus::File g_manifest;
size_t g_requestsRun = 0U;
size_t g_responsesRun = 0U;

using Cache = roster::Roster<devlink::kMaxRosterEntries>;
using Queue = eventq::EventQueue<16U>;
using Keys = memcode::KeyRing<bridgelogic::kCourtKeyRingSlots>;

const char* array(const char* doc, const char* name) {
  const char* value = corpus::member(doc, name);
  TEST_ASSERT_NOT_NULL_MESSAGE(value, name);
  TEST_ASSERT_TRUE_MESSAGE(corpus::isArray(value), name);
  return value;
}

void text(const char* object, const char* name, char* out, size_t cap) {
  const char* value = corpus::member(object, name);
  TEST_ASSERT_NOT_NULL_MESSAGE(value, name);
  TEST_ASSERT_TRUE_MESSAGE(corpus::stringValue(value, out, cap, nullptr), name);
}

uint64_t number(const char* object, const char* name) {
  const char* value = corpus::member(object, name);
  TEST_ASSERT_NOT_NULL_MESSAGE(value, name);
  return corpus::unsignedValue(value);
}

bool has(const char* object, const char* name) {
  return corpus::member(object, name) != nullptr;
}

bool isNull(const char* object, const char* name) {
  const char* value = corpus::member(object, name);
  return value != nullptr && strncmp(corpus::skipWs(value), "null", 4) == 0;
}

bool flag(const char* object, const char* name) {
  const char* value = corpus::member(object, name);
  TEST_ASSERT_NOT_NULL_MESSAGE(value, name);
  return strncmp(corpus::skipWs(value), "true", 4) == 0;
}

const char* body(const char* object, size_t& len) {
  static uint8_t bytes[corpus::kMaxStringLen];
  static char out[corpus::kMaxStringLen + 1U];
  size_t n = 0U;
  TEST_ASSERT_TRUE_MESSAGE(corpus::hexField(object, "body_hex", bytes, sizeof(bytes), &n), "body_hex");
  memcpy(out, bytes, n);
  out[n] = '\0';
  len = n;
  return out;
}

const char* screenName(bridgelogic::ScreenId id) {
  switch (id) {
  case bridgelogic::ScreenId::PayForQuote:
    return "PayForQuote";
  case bridgelogic::ScreenId::PayForPaid:
    return "PayForPaid";
  case bridgelogic::ScreenId::PayForSplit:
    return "PayForSplit";
  case bridgelogic::ScreenId::PayForNothingToPay:
    return "PayForNothingToPay";
  case bridgelogic::ScreenId::PayForPriceChanged:
    return "PayForPriceChanged";
  case bridgelogic::ScreenId::InsufficientBalance:
    return "InsufficientBalance";
  case bridgelogic::ScreenId::NotRecognised:
    return "NotRecognised";
  case bridgelogic::ScreenId::SlotEnded:
    return "SlotEnded";
  case bridgelogic::ScreenId::SeeTheDesk:
    return "SeeTheDesk";
  case bridgelogic::ScreenId::NoConnection:
    return "NoConnection";
  case bridgelogic::ScreenId::ChooseTime:
    return "ChooseTime";
  default:
    return "?";
  }
}

const char* kindName(bridgelogic::PayForKind kind) {
  switch (kind) {
  case bridgelogic::PayForKind::Undecided:
    return "undecided";
  case bridgelogic::PayForKind::WalkUp:
    return "walkup";
  case bridgelogic::PayForKind::Quote:
    return "quote";
  case bridgelogic::PayForKind::Paid:
    return "paid";
  case bridgelogic::PayForKind::Refused:
    return "refused";
  }
  return "?";
}

// --- requests ---------------------------------------------------------------

void assertRendered(const char* expected, size_t expectedLen, const char* rendered, size_t renderedLen,
                    const char* id) {
  TEST_ASSERT_EQUAL_size_t_MESSAGE(expectedLen, renderedLen, id);
  TEST_ASSERT_EQUAL_STRING_MESSAGE(expected, rendered, id);
}

void runRequest(const char* c) {
  char id[64] = {};
  text(c, "id", id, sizeof(id));
  size_t len = 0U;
  const char* expected = body(c, len);
  const char* render = corpus::member(c, "render");
  TEST_ASSERT_NOT_NULL_MESSAGE(render, id);
  char mac[16] = {};
  text(render, "mac", mac, sizeof(mac));
  char out[512] = {};
  size_t n = 0U;

  if (strncmp(id, "heartbeat-request-caps", 22) == 0) {
    char version[16] = {};
    text(render, "firmware_version", version, sizeof(version));
    devlink::HeartbeatReport report;
    report.codesCapability = true;
    devlink::RelayState relays[devlink::kMaxRelayStateElements];
    if (has(render, "restored_relays")) {
      report.restoredRelays = static_cast<uint8_t>(number(render, "restored_relays"));
      corpus::ArrayIter it(array(render, "relay_state"));
      const char* pair = nullptr;
      uint8_t count = 0U;
      while (it.next(&pair)) {
        corpus::ArrayIter fields(pair);
        const char* f = nullptr;
        TEST_ASSERT_TRUE(fields.next(&f));
        relays[count].relay = static_cast<uint8_t>(corpus::unsignedValue(f));
        TEST_ASSERT_TRUE(fields.next(&f));
        relays[count].remainingSeconds = static_cast<uint32_t>(corpus::unsignedValue(f));
        ++count;
      }
      report.relayState = relays;
      report.relayStateCount = count;
    }
    n = devlink::renderHeartbeatBody(out, sizeof(out), mac, version, number(render, "uptime_ms"), report);
  } else if (strcmp(id, "activate-request-v1") == 0) {
    char token[32] = {};
    text(render, "token", token, sizeof(token));
    n = bridgelogic::renderActivateBody(out, sizeof(out), mac, token,
                                        static_cast<uint32_t>(number(render, "scan_age_ms")));
  } else if (strcmp(id, "walkup-request-v1") == 0) {
    char token[32] = {};
    char nonce[32] = {};
    text(render, "token", token, sizeof(token));
    text(render, "nonce", nonce, sizeof(nonce));
    bridgelogic::WalkUpRequest request;
    request.mac = mac;
    request.intent.minutes = static_cast<uint16_t>(number(render, "minutes"));
    request.courtNumber = static_cast<int16_t>(number(render, "court"));
    request.token = token;
    request.nonce = nonce;
    request.scanAgeMs = static_cast<uint32_t>(number(render, "scan_age_ms"));
    n = bridgelogic::renderWalkUpBody(out, sizeof(out), request);
  } else if (strncmp(id, "payfor-", 7) == 0) {
    char token[32] = {};
    char nonce[32] = {};
    char label[16] = {};
    text(render, "token", token, sizeof(token));
    text(render, "nonce", nonce, sizeof(nonce));
    bridgelogic::PayForRequest request;
    request.mac = mac;
    request.token = token;
    request.courtNumber = static_cast<int16_t>(number(render, "court"));
    request.nonce = nonce;
    request.confirm = flag(render, "confirm");
    if (has(render, "amount_label")) {
      text(render, "amount_label", label, sizeof(label));
      request.amountLabel = label;
    }
    if (has(render, "scan_age_ms")) {
      request.scanAgeMs = static_cast<uint32_t>(number(render, "scan_age_ms"));
    }
    n = bridgelogic::renderPayForBody(out, sizeof(out), request);
  } else if (strncmp(id, "events-request-v1", 17) == 0) {
    char subject[32] = {};
    text(render, "subject", subject, sizeof(subject));
    eventq::Event event;
    event.seq = static_cast<uint32_t>(number(render, "seq"));
    event.uptimeMs = static_cast<uint32_t>(number(render, "event_uptime_ms"));
    event.kind = eventq::Kind::Activation;
    event.court = static_cast<uint8_t>(number(render, "court"));
    event.method = eventq::Method::Qr;
    event.durationMs = static_cast<uint32_t>(number(render, "duration_ms"));
    TEST_ASSERT_TRUE(event.setSubject(subject));
    n = devlink::renderEventBody(out, sizeof(out), mac, static_cast<uint32_t>(number(render, "boot_id")),
                                 number(render, "uptime_ms"), event);
  } else {
    TEST_FAIL_MESSAGE(id);
  }
  assertRendered(expected, len, out, n, id);
  ++g_requestsRun;
}

// --- responses --------------------------------------------------------------

void runHeartbeat(const char* c, const char* id) {
  size_t len = 0U;
  const char* doc = body(c, len);
  const char* expect = corpus::member(c, "expect");
  Cache cache(21600000UL);
  memcode::StepClock clock(21600000UL);
  Keys keys;
  const uint32_t now = 1000U;
  const devlink::SyncResult roster = devlink::applyRoster(doc, len, cache, now);
  const devlink::CodeSyncResult codes = devlink::applyCodeSync(doc, len, clock, keys, now);
  TEST_ASSERT_TRUE_MESSAGE(roster.replaced, id);
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(0U, roster.rejected, id);

  if (has(expect, "max_bytes")) {
    // THE BUDGET: the widest body the contract allows fits the box's contract
    // ceiling, and every element of it is accepted, none dropped.
    TEST_ASSERT_TRUE_MESSAGE(len <= static_cast<size_t>(number(expect, "max_bytes")), id);
    TEST_ASSERT_EQUAL_size_t_MESSAGE(static_cast<size_t>(number(expect, "bytes")), len, id);
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(static_cast<uint8_t>(number(expect, "roster_count")), roster.accepted,
                                    id);
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(0U, roster.dropped, id);
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(static_cast<uint8_t>(number(expect, "keys_accepted")), codes.accepted,
                                    id);
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(0U, codes.rejected, id);
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(0U, codes.dropped, id);
    TEST_ASSERT_TRUE_MESSAGE(len < 2560U, "and the bridge's own response buffer holds it");
    return;
  }
  if (isNull(expect, "code_step")) {
    TEST_ASSERT_FALSE_MESSAGE(codes.clockSynced, id);
    TEST_ASSERT_FALSE_MESSAGE(codes.keysReplaced, id);
    return;
  }
  TEST_ASSERT_TRUE_MESSAGE(codes.clockSynced, id);
  TEST_ASSERT_EQUAL_UINT32_MESSAGE(static_cast<uint32_t>(number(expect, "code_step")), clock.stepAt(now), id);
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(static_cast<uint8_t>(number(expect, "keys_accepted")), codes.accepted, id);
  corpus::ArrayIter it(array(expect, "roster"));
  const char* e = nullptr;
  uint8_t count = 0U;
  while (it.next(&e)) {
    ++count;
  }
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(count, roster.accepted, id);
}

void checkRows(const char* expect, const bridgelogic::Screen& screen, const char* id) {
  if (!has(expect, "rows")) {
    return;
  }
  corpus::ArrayIter rows(array(expect, "rows"));
  const char* r = nullptr;
  size_t row = 0U;
  while (rows.next(&r)) {
    char wanted[32] = {};
    TEST_ASSERT_TRUE(corpus::stringValue(r, wanted, sizeof(wanted), nullptr));
    TEST_ASSERT_EQUAL_STRING_MESSAGE(wanted, screen.rows[row], id);
    ++row;
  }
}

void runPayFor(const char* c, const char* id, bool confirm) {
  size_t len = 0U;
  const char* doc = body(c, len);
  const char* expect = corpus::member(c, "expect");
  // The court the quote was asked about: every vector names it in its body.
  uint32_t court = 0U;
  TEST_ASSERT_TRUE(devapi::json::topLevelUnsignedField(doc, len, "court_number", court));
  const bridgelogic::PayForAnswer answer =
      confirm ? bridgelogic::onPayForConfirm(200U, doc, len, "50")
              : bridgelogic::onPayForQuote(200U, doc, len, static_cast<int16_t>(court));

  char outcome[16] = {};
  text(expect, "outcome", outcome, sizeof(outcome));
  TEST_ASSERT_EQUAL_STRING_MESSAGE(outcome, kindName(answer.kind), id);
  if (has(expect, "screen")) {
    char screen[32] = {};
    text(expect, "screen", screen, sizeof(screen));
    TEST_ASSERT_EQUAL_STRING_MESSAGE(screen, screenName(answer.screen), id);
  }
  if (has(expect, "amount_label")) {
    char label[16] = {};
    text(expect, "amount_label", label, sizeof(label));
    TEST_ASSERT_EQUAL_STRING_MESSAGE(label, answer.amountLabel, id);
  }
  if (has(expect, "granted_seconds")) {
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(static_cast<uint32_t>(number(expect, "granted_seconds")),
                                     answer.grantedSeconds, id);
  }
  // The glass, from the same facts the composition root builds.
  bridgelogic::ScreenFacts facts;
  facts.courtNumber = static_cast<int16_t>(court);
  snprintf(facts.amount, sizeof(facts.amount), "%s", answer.amountLabel);
  court::ButtonMap map;
  facts.buttons = &map;
  checkRows(expect, bridgelogic::screenFor(answer.screen, facts), id);
}

void checkLines(const char* expect, const court::Outcome& outcome, const char* id) {
  corpus::ArrayIter lines(array(expect, "lines"));
  const char* l = nullptr;
  char wanted[2][32] = {};
  size_t n = 0U;
  while (lines.next(&l) && n < 2U) {
    TEST_ASSERT_TRUE(corpus::stringValue(l, wanted[n], sizeof(wanted[n]), nullptr));
    ++n;
  }
  TEST_ASSERT_EQUAL_size_t_MESSAGE(2U, n, id);
  TEST_ASSERT_EQUAL_STRING_MESSAGE(wanted[0], outcome.line1, id);
  TEST_ASSERT_EQUAL_STRING_MESSAGE(wanted[1], outcome.line2, id);
  TEST_ASSERT_EQUAL_MESSAGE(flag(expect, "recognised"), outcome.recognised, id);
}

void runActivate(const char* c, const char* id) {
  size_t len = 0U;
  const char* doc = body(c, len);
  const char* expect = corpus::member(c, "expect");
  const int16_t courts[devlink::kMaxCourts] = {1, 2, 3, 4};
  const bridgelogic::ActivationResult r =
      bridgelogic::ScanFlow().onActivateResponse(200U, doc, len, courts, 4U);
  TEST_ASSERT_EQUAL_MESSAGE(flag(expect, "fallback"), r.fallbackToRoster, id);
  TEST_ASSERT_EQUAL_MESSAGE(court::Action::Refuse, r.outcome.action, id);
  checkLines(expect, r.outcome, id);
}

void runWalkUp(const char* c, const char* id) {
  size_t len = 0U;
  const char* doc = body(c, len);
  const char* expect = corpus::member(c, "expect");
  const bridgelogic::WalkUpResult r =
      bridgelogic::onWalkUpResponse(static_cast<uint16_t>(number(expect, "status")), doc, len, 1U, 60U);
  TEST_ASSERT_EQUAL_MESSAGE(flag(expect, "decided"), r.decided, id);
  TEST_ASSERT_EQUAL_MESSAGE(court::Action::Refuse, r.outcome.action, id);
  checkLines(expect, r.outcome, id);
}

void runResponse(const char* c) {
  char id[64] = {};
  char kind[32] = {};
  text(c, "id", id, sizeof(id));
  text(c, "kind", kind, sizeof(kind));
  if (strcmp(kind, "activate") == 0) {
    runActivate(c, id);
  } else if (strcmp(kind, "walkup") == 0) {
    runWalkUp(c, id);
  } else if (strcmp(kind, "heartbeat") == 0) {
    runHeartbeat(c, id);
  } else if (strcmp(kind, "payfor_quote") == 0) {
    runPayFor(c, id, false);
  } else if (strcmp(kind, "payfor_confirm") == 0) {
    runPayFor(c, id, true);
  } else {
    TEST_FAIL_MESSAGE(id);
  }
  ++g_responsesRun;
}

} // namespace

void test_every_request_renders_byte_for_byte(void) {
  TEST_ASSERT_TRUE_MESSAGE(g_http.load(kFamily, kFile), "membercode/http.json not found");
  corpus::ArrayIter it(array(g_http.root(), "requests"));
  const char* c = nullptr;
  while (it.next(&c)) {
    runRequest(c);
  }
}

void test_every_response_reads_as_the_contract_says(void) {
  TEST_ASSERT_TRUE_MESSAGE(g_http.load(kFamily, kFile), "membercode/http.json not found");
  corpus::ArrayIter it(array(g_http.root(), "responses"));
  const char* c = nullptr;
  while (it.next(&c)) {
    runResponse(c);
  }
}

void test_every_declared_court_box_case_was_executed(void) {
  TEST_ASSERT_TRUE(g_manifest.load(kFamily, "manifest.json"));
  const char* files = corpus::member(g_manifest.root(), "files");
  TEST_ASSERT_NOT_NULL(files);
  const char* mine = corpus::member(files, kFile);
  TEST_ASSERT_NOT_NULL(mine);
  corpus::ArrayIter readers(corpus::member(mine, "read_by"));
  const char* r = nullptr;
  bool named = false;
  while (readers.next(&r)) {
    char reader[24] = {};
    TEST_ASSERT_TRUE(corpus::stringValue(r, reader, sizeof(reader), nullptr));
    named = named || strcmp(reader, "fw-court-box") == 0;
  }
  TEST_ASSERT_TRUE_MESSAGE(named, "http.json must name this suite");
  const char* counts = corpus::member(mine, "case_count");
  TEST_ASSERT_EQUAL_size_t(static_cast<size_t>(corpus::unsignedValue(corpus::member(counts, "requests"))),
                           g_requestsRun);
  TEST_ASSERT_EQUAL_size_t(static_cast<size_t>(corpus::unsignedValue(corpus::member(counts, "responses"))),
                           g_responsesRun);
}

// ---------------------------------------------------------------------------
// The offline v1 path through the session — the event, the replay, the guard
// ---------------------------------------------------------------------------

namespace {

/// A fixture member: a 12-byte K_day for REF value 0x0A3C9 ("18Y9"), a clock
/// synced to step 1000 at ms 0, one day slot around it, and a booking on relay
/// 1 that names this member as the SECOND player.
struct Offline {
  Offline() : cache(21600000UL), queue(&store), session(cache, queue), clock(21600000UL) {
    queue.begin();
    for (uint8_t i = 0U; i < 12U; ++i) {
      key.key[i] = static_cast<uint8_t>(0x40U + i);
    }
    key.ref = 0x0A3C9U;
    key.slot = 0U;
    memcode::DaySlot day;
    day.firstStep = 900U;
    day.endStep = 1900U;
    day.valid = true;
    keys.beginReplace();
    TEST_ASSERT_TRUE(keys.setDay(0U, day));
    TEST_ASSERT_TRUE(keys.add(key));
    keys.commitReplace();
    TEST_ASSERT_TRUE(clock.sync(1000U, 0U, 0U));
    cache.beginReplace(0U);
    roster::Entry entry;
    TEST_ASSERT_TRUE(devlink::parseRosterElement("m0001"
                                                 "18Y9|1|0|3600",
                                                 entry));
    TEST_ASSERT_TRUE(cache.add(entry));
    cache.commitReplace();
    for (uint8_t i = 0U; i < bridgelogic::kStateCourts; ++i) {
      held[i] = bridgelogic::HeldState{0U, false};
    }
  }

  memcode::OfflineCodes<Keys, memcode::ReplayRing<bridgelogic::kCourtReplaySlots>> codes() {
    return {clock, keys, uses, guard};
  }

  bridgelogic::BoxCourts box() const { return {held, 4U}; }

  /// This member's token at `step`, with an ON the box never checks.
  void token(uint32_t step, char* out) {
    TEST_ASSERT_TRUE(
        memcode::format(0x0A3C9U, 12345678U, memcode::offCode(key.key, step), out, memcode::kTokenLen + 1U));
  }

  fakes::FakeStore store;
  Cache cache;
  Queue queue;
  court::Session<Cache, Queue> session;
  memcode::StepClock clock;
  Keys keys;
  memcode::ReplayRing<bridgelogic::kCourtReplaySlots> uses;
  memcode::GuessGuard guard;
  memcode::DayKey key;
  bridgelogic::HeldState held[bridgelogic::kStateCourts];
};

} // namespace

void test_offline_v1_code_lights_the_partners_court_and_records_the_scanned_token(void) {
  Offline f;
  char token[memcode::kTokenLen + 1U] = {};
  f.token(1000U, token);
  const bridgelogic::MemberScanResult r =
      bridgelogic::decideOfflineMemberCode(token, f.codes(), f.cache, f.session, f.box(), 10000U);
  TEST_ASSERT_EQUAL(memcode::Status::Ok, r.verdict.status);
  TEST_ASSERT_FALSE(r.alreadyOn);
  TEST_ASSERT_EQUAL(court::Action::TurnOn, r.outcome.action);
  TEST_ASSERT_EQUAL_UINT8(1U, r.outcome.court);
  TEST_ASSERT_TRUE(r.outcome.recognised);
  TEST_ASSERT_EQUAL_UINT32(3590000U, r.outcome.durationMs);

  // The evidence the server re-checks with ON is the SCANNED token — never the
  // roster's REF list, which proves nothing about who stood at the box.
  eventq::Event event;
  bool sawActivation = false;
  while (f.queue.peek(event)) {
    if (event.kind == eventq::Kind::Activation) {
      sawActivation = true;
      TEST_ASSERT_TRUE(event.subjectEquals(token));
      TEST_ASSERT_EQUAL_UINT8(1U, event.court);
    }
    TEST_ASSERT_TRUE(f.queue.release());
  }
  TEST_ASSERT_TRUE(sawActivation);
}

void test_offline_v1_code_used_once_is_refused_the_second_time_and_says_so(void) {
  Offline f;
  char token[memcode::kTokenLen + 1U] = {};
  f.token(1000U, token);
  bridgelogic::MemberScanResult r =
      bridgelogic::decideOfflineMemberCode(token, f.codes(), f.cache, f.session, f.box(), 10000U);
  TEST_ASSERT_EQUAL(court::Action::TurnOn, r.outcome.action);
  f.uses.commit(r.verdict.token.ref, r.verdict.step);

  r = bridgelogic::decideOfflineMemberCode(token, f.codes(), f.cache, f.session, f.box(), 12000U);
  TEST_ASSERT_EQUAL(memcode::Status::Replayed, r.verdict.status);
  TEST_ASSERT_EQUAL(court::Action::Refuse, r.outcome.action);
  TEST_ASSERT_EQUAL_STRING(bridgelogic::kCodeUsedLine1, r.outcome.line1);
  TEST_ASSERT_EQUAL_STRING(bridgelogic::kCodeUsedLine2, r.outcome.line2);
  TEST_ASSERT_TRUE(strlen(r.outcome.line1) <= court::kSafeSubsetCols);
  TEST_ASSERT_TRUE(strlen(r.outcome.line2) <= court::kSafeSubsetCols);
  // NOT recognised: a used code may be a photo of somebody else's screen, and a
  // recognised scan arms the buttons that buy and pay on that identity.
  TEST_ASSERT_FALSE(r.outcome.recognised);
}

void test_offline_v1_guessing_is_throttled_and_says_so(void) {
  Offline f;
  char wrong[memcode::kTokenLen + 1U] = {};
  TEST_ASSERT_TRUE(memcode::format(0x0A3C9U, 12345678U, (memcode::offCode(f.key.key, 1000U) + 1U) % 1000000U,
                                   wrong, sizeof(wrong)));
  for (uint8_t i = 0U; i < memcode::kGuessFailures; ++i) {
    TEST_ASSERT_EQUAL(memcode::Status::WrongCode, bridgelogic::decideOfflineMemberCode(
                                                      wrong, f.codes(), f.cache, f.session, f.box(), 10000U)
                                                      .verdict.status);
  }
  char token[memcode::kTokenLen + 1U] = {};
  f.token(1000U, token);
  const bridgelogic::MemberScanResult r =
      bridgelogic::decideOfflineMemberCode(token, f.codes(), f.cache, f.session, f.box(), 11000U);
  TEST_ASSERT_EQUAL(memcode::Status::Throttled, r.verdict.status);
  TEST_ASSERT_EQUAL(court::Action::Refuse, r.outcome.action);
  TEST_ASSERT_EQUAL_STRING(bridgelogic::kThrottledLine1, r.outcome.line1);
  TEST_ASSERT_EQUAL_STRING(bridgelogic::kThrottledLine2, r.outcome.line2);
  TEST_ASSERT_TRUE(strlen(r.outcome.line1) <= court::kSafeSubsetCols);
  TEST_ASSERT_TRUE(strlen(r.outcome.line2) <= court::kSafeSubsetCols);
  TEST_ASSERT_FALSE(r.outcome.recognised);
}

void test_offline_v1_rescan_on_a_lit_court_is_the_already_on_screen_and_records_nothing(void) {
  Offline f;
  f.held[1] = bridgelogic::HeldState{5000U, true};
  char token[memcode::kTokenLen + 1U] = {};
  f.token(1000U, token);
  const uint32_t before = f.queue.size();
  const bridgelogic::MemberScanResult r =
      bridgelogic::decideOfflineMemberCode(token, f.codes(), f.cache, f.session, f.box(), 10000U);
  TEST_ASSERT_TRUE(r.alreadyOn);
  TEST_ASSERT_EQUAL_UINT8(1U, r.outcome.court);
  TEST_ASSERT_EQUAL_UINT32(before, f.queue.size());
}

void test_offline_v1_code_with_no_clock_reads_as_the_stale_roster(void) {
  Offline f;
  char token[memcode::kTokenLen + 1U] = {};
  f.token(1000U, token);
  f.clock.forget();
  const bridgelogic::MemberScanResult r =
      bridgelogic::decideOfflineMemberCode(token, f.codes(), f.cache, f.session, f.box(), 10000U);
  TEST_ASSERT_EQUAL(memcode::Status::NoClock, r.verdict.status);
  TEST_ASSERT_EQUAL(court::Action::Refuse, r.outcome.action);
  TEST_ASSERT_FALSE(r.outcome.recognised);
}

void test_a_wrong_off_is_refused_as_not_recognised_and_arms_nothing(void) {
  Offline f;
  char token[memcode::kTokenLen + 1U] = {};
  TEST_ASSERT_TRUE(memcode::format(0x0A3C9U, 12345678U, (memcode::offCode(f.key.key, 1000U) + 1U) % 1000000U,
                                   token, sizeof(token)));
  const bridgelogic::MemberScanResult r =
      bridgelogic::decideOfflineMemberCode(token, f.codes(), f.cache, f.session, f.box(), 10000U);
  TEST_ASSERT_EQUAL(memcode::Status::WrongCode, r.verdict.status);
  TEST_ASSERT_EQUAL(court::Action::Refuse, r.outcome.action);
  TEST_ASSERT_FALSE(r.outcome.recognised);
}

// ---------------------------------------------------------------------------
// Pay-for: the parts that are not bytes
// ---------------------------------------------------------------------------

void test_pay_for_quote_answers_that_are_not_decisions_are_the_old_walk_up_choice(void) {
  // A server that never heard of pay-for, a dead link, a cut body: the court
  // press is exactly what it was before D10.
  const char ok[] = "{\"payable\":true,\"reason\":\"ok\",\"court_number\":2,\"amount_label\":\"50\"}";
  TEST_ASSERT_EQUAL(bridgelogic::PayForKind::WalkUp, bridgelogic::onPayForQuote(404U, "{}", 2U, 2).kind);
  TEST_ASSERT_EQUAL(bridgelogic::PayForKind::WalkUp, bridgelogic::onPayForQuote(0U, "", 0U, 2).kind);
  TEST_ASSERT_EQUAL(bridgelogic::PayForKind::WalkUp,
                    bridgelogic::onPayForQuote(200U, ok, strlen(ok) - 1U, 2).kind);
  // A price for a DIFFERENT court is not a question anybody can be asked here.
  TEST_ASSERT_EQUAL(bridgelogic::PayForKind::WalkUp,
                    bridgelogic::onPayForQuote(200U, ok, strlen(ok), 3).kind);
  TEST_ASSERT_EQUAL(bridgelogic::PayForKind::Quote, bridgelogic::onPayForQuote(200U, ok, strlen(ok), 2).kind);
}

void test_pay_for_confirm_that_got_no_decision_keeps_the_nonce(void) {
  TEST_ASSERT_EQUAL(bridgelogic::PayForKind::Undecided, bridgelogic::onPayForConfirm(0U, "", 0U, "50").kind);
  TEST_ASSERT_EQUAL(bridgelogic::ScreenId::NoConnection,
                    bridgelogic::onPayForConfirm(0U, "", 0U, "50").screen);
  TEST_ASSERT_EQUAL(bridgelogic::PayForKind::Undecided,
                    bridgelogic::onPayForConfirm(503U, "", 0U, "50").kind);
  TEST_ASSERT_EQUAL(bridgelogic::PayForKind::Undecided,
                    bridgelogic::onPayForConfirm(429U, "", 0U, "50").kind);
  // A 200 nobody can read MAY have paid: undecided, so a retry is the same nonce.
  TEST_ASSERT_EQUAL(bridgelogic::PayForKind::Undecided,
                    bridgelogic::onPayForConfirm(200U, "{\"paid\":tr", 10U, "50").kind);
  // A decided status with no decision in it is a refusal, and spends the nonce.
  TEST_ASSERT_EQUAL(bridgelogic::PayForKind::Refused, bridgelogic::onPayForConfirm(404U, "", 0U, "50").kind);
  // Paid with no label of its own shows what the member agreed to.
  const char paid[] = "{\"paid\":true,\"reason\":\"ok\",\"court_number\":2}";
  const bridgelogic::PayForAnswer a = bridgelogic::onPayForConfirm(200U, paid, strlen(paid), "32.5");
  TEST_ASSERT_EQUAL(bridgelogic::PayForKind::Paid, a.kind);
  TEST_ASSERT_EQUAL_STRING("32.5", a.amountLabel);
  TEST_ASSERT_EQUAL_UINT32(0U, a.grantedSeconds);
}

void test_pay_for_labels_are_refused_rather_than_cut(void) {
  TEST_ASSERT_TRUE(bridgelogic::validAmountLabel("50"));
  TEST_ASSERT_TRUE(bridgelogic::validAmountLabel("32.5"));
  TEST_ASSERT_TRUE(bridgelogic::validAmountLabel("9999.5"));
  TEST_ASSERT_TRUE(bridgelogic::validAmountLabel("0.25"));
  TEST_ASSERT_FALSE(bridgelogic::validAmountLabel(""));
  TEST_ASSERT_FALSE(bridgelogic::validAmountLabel("12345.5"));
  TEST_ASSERT_FALSE(bridgelogic::validAmountLabel(".5"));
  TEST_ASSERT_FALSE(bridgelogic::validAmountLabel("5."));
  TEST_ASSERT_FALSE(bridgelogic::validAmountLabel("1.2.3"));
  TEST_ASSERT_FALSE(bridgelogic::validAmountLabel("1.234"));
  TEST_ASSERT_FALSE(bridgelogic::validAmountLabel("-5"));
  TEST_ASSERT_FALSE(bridgelogic::validAmountLabel("5,0"));
  // A confirm cannot be rendered without a label the glass could have shown.
  bridgelogic::PayForRequest request;
  request.mac = "5ccf7f0a1b2c";
  request.token = "7Q3F9KM2XZ8B";
  request.nonce = "9f2a4c6e8b0d1f3a";
  request.confirm = true;
  request.amountLabel = "12345.5";
  char out[256] = {};
  TEST_ASSERT_EQUAL_size_t(0U, bridgelogic::renderPayForBody(out, sizeof(out), request));
  TEST_ASSERT_EQUAL_STRING("", out);
}

namespace {

class CountingEntropy final : public devapi::IEntropySource {
public:
  uint8_t nextByte() override { return next_++; }

private:
  uint8_t next_ = 0x10U;
};

} // namespace

void test_pay_for_flow_arms_one_court_lapses_and_keeps_its_nonce_for_the_confirm(void) {
  bridgelogic::PayForFlow flow;
  CountingEntropy entropy;
  const char* nonce = flow.quoteNonce(entropy);
  TEST_ASSERT_EQUAL_size_t(16U, strlen(nonce));
  char drawn[20] = {};
  snprintf(drawn, sizeof(drawn), "%s", nonce);
  flow.arm(1U, 2, "50", 20000U, 1000U);
  TEST_ASSERT_TRUE(flow.quoted(1U, 1000U));
  TEST_ASSERT_FALSE(flow.quoted(0U, 1000U));
  TEST_ASSERT_EQUAL_STRING(drawn, flow.nonce());
  TEST_ASSERT_EQUAL_STRING("50", flow.amountLabel());
  TEST_ASSERT_EQUAL_INT16(2, flow.courtNumber());
  TEST_ASSERT_FALSE(flow.tick(20999U));
  TEST_ASSERT_TRUE(flow.quoted(1U, 20999U));
  TEST_ASSERT_TRUE(flow.tick(21000U));
  TEST_ASSERT_FALSE(flow.quoted(1U, 21000U));
  TEST_ASSERT_FALSE(flow.tick(22000U)); // exactly once
  // A fresh quote draws a fresh nonce.
  TEST_ASSERT_TRUE(strcmp(drawn, flow.quoteNonce(entropy)) != 0);
}

void test_the_v1_token_fits_every_buffer_it_passes_through(void) {
  TEST_ASSERT_TRUE(memcode::kTokenLen <= proto::kMaxArgLen);
  TEST_ASSERT_TRUE(memcode::kTokenLen <= roster::kMaxTokenLen);
  TEST_ASSERT_TRUE(memcode::kTokenLen < eventq::kMaxSubjectLen);
  // A legacy code's activate body is untouched by the scan age.
  char out[128] = {};
  const size_t n = bridgelogic::renderActivateBody(out, sizeof(out), "5ccf7f0a1b2c", "7Q3F9KM2XZ8B", 4000U);
  TEST_ASSERT_TRUE(n > 0U);
  TEST_ASSERT_EQUAL_STRING("{\"mac\":\"5ccf7f0a1b2c\",\"method\":\"qr\",\"token\":\"7Q3F9KM2XZ8B\"}", out);
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_every_request_renders_byte_for_byte);
  RUN_TEST(test_every_response_reads_as_the_contract_says);
  RUN_TEST(test_every_declared_court_box_case_was_executed);
  RUN_TEST(test_offline_v1_code_lights_the_partners_court_and_records_the_scanned_token);
  RUN_TEST(test_offline_v1_code_used_once_is_refused_the_second_time_and_says_so);
  RUN_TEST(test_offline_v1_guessing_is_throttled_and_says_so);
  RUN_TEST(test_offline_v1_rescan_on_a_lit_court_is_the_already_on_screen_and_records_nothing);
  RUN_TEST(test_offline_v1_code_with_no_clock_reads_as_the_stale_roster);
  RUN_TEST(test_a_wrong_off_is_refused_as_not_recognised_and_arms_nothing);
  RUN_TEST(test_pay_for_quote_answers_that_are_not_decisions_are_the_old_walk_up_choice);
  RUN_TEST(test_pay_for_confirm_that_got_no_decision_keeps_the_nonce);
  RUN_TEST(test_pay_for_labels_are_refused_rather_than_cut);
  RUN_TEST(test_pay_for_flow_arms_one_court_lapses_and_keeps_its_nonce_for_the_confirm);
  RUN_TEST(test_the_v1_token_fits_every_buffer_it_passes_through);
  return UNITY_END();
}

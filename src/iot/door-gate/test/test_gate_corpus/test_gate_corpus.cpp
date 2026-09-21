// The door gate against the shared contract corpus — every case in
// src/contracts/device-protocol/gate/, executed, counted, and cross-checked
// against what the manifest declares.
//
// WHY THIS SUITE EXISTS
// ---------------------
// Two implementations have to agree on these bytes and cannot see each other's
// source: this firmware and the .NET API. The repository has already shipped
// one ESP32 sketch and one webhook sender that had never successfully talked to
// each other — each internally consistent, each tested against its own
// assumptions, and the mismatch invisible until somebody looked at a 401 nobody
// had noticed for months. A gate that renders one field differently from the way
// the server reads it is a door that refuses a member with a valid booking, in a
// car park, at night.
//
// WHY THE COUNTS ARE ASSERTED AND NOT JUST THE CASES
// --------------------------------------------------
// A side that skips what it cannot parse passes every assertion it runs. So
// this file counts what it actually executed and compares that with
// manifest.json's `case_count`, in both directions: a case added to the corpus
// and not handled here is red, a case declared and absent is red, and an
// unrecognised `kind` fails rather than continuing. That is the corpus README's
// rule and it is the only one with teeth.
//
// WHY IT IS A SEPARATE FAMILY FROM `http/`
// ----------------------------------------
// The court box's suite executes every case in the family it reads and asserts
// the count. A gate vector in `http/` would make that suite red on a board with
// no gate code in it at all. The two families share the roster element grammar
// deliberately — `TOKEN|relay|opens_in|closes_in`, relay always 0 on a gate — so
// `devlink::parseRosterElement` and `roster::Roster` are reused unchanged, and
// that reuse is what makes the shared grammar worth pinning twice.

#include <stdint.h>
#include <string.h>
#include <unity.h>

#include "devapi/DeviceClient.h"
#include "devapi/Json.h"
#include "devlink/Cadence.h"
#include "devlink/EventUpload.h"
#include "devlink/RosterSync.h"
#include "eventq/Event.h"
#include "gatelogic/GateConfig.h"
#include "gatelogic/GateFlow.h"
#include "gatelogic/GateHeartbeat.h"
#include "roster/Roster.h"
#include "support/CorpusJson.h"

namespace {

corpus::File g_cases;
corpus::File g_manifest;

using Cache = roster::Roster<gatelogic::kGateRosterEntries>;

/// The longest `gate_key` the admin console accepts, as a CORPUS fact — the
/// size of the buffer this suite reads one into, and nothing more.
///
/// It used to be `gatelogic::kMaxGateKeyLen`, a firmware constant that sized no
/// firmware buffer, because nothing in this firmware parses `gate_key` at all:
/// the board is identified by its MAC, the key is the admin's label for a door
/// and the board never needs to know it. A constant in a library, named for a
/// field the library does not read, is how "the board learns its name from the
/// heartbeat" survived in four documents for as long as it did.
constexpr size_t kMaxGateKeyLen = 64U;

/// The clock the roster is anchored to. A base with the 49.7-day wrap just
/// ahead, because a gate in a cupboard runs for months and the corpus's
/// six-digit relative seconds are exactly the values that cross it.
constexpr uint32_t kNow = 0xFFFFF000U;

void loadCorpus() {
  TEST_ASSERT_TRUE_MESSAGE(g_cases.load("gate", "cases.json"),
                           "gate corpus not found — a skipped corpus proves nothing");
  TEST_ASSERT_TRUE_MESSAGE(g_manifest.load("gate", "manifest.json"),
                           "src/contracts/device-protocol/gate/manifest.json not found above cwd");
}

size_t declaredCount(const char* section) {
  const char* counts = corpus::member(g_manifest.root(), "case_count");
  TEST_ASSERT_NOT_NULL_MESSAGE(counts, "manifest has no case_count");
  const char* value = corpus::member(counts, section);
  TEST_ASSERT_NOT_NULL_MESSAGE(value, section);
  return static_cast<size_t>(corpus::unsignedValue(value));
}

const char* section(const char* name) {
  const char* value = corpus::member(g_cases.root(), name);
  TEST_ASSERT_NOT_NULL_MESSAGE(value, name);
  TEST_ASSERT_TRUE_MESSAGE(corpus::isArray(value), name);
  return value;
}

/// A string member of a case, decoded into a caller buffer.
void text(const char* object, const char* name, char* out, size_t cap) {
  const char* value = corpus::member(object, name);
  TEST_ASSERT_NOT_NULL_MESSAGE(value, name);
  TEST_ASSERT_TRUE_MESSAGE(corpus::stringValue(value, out, cap, nullptr), name);
}

/// `body_hex` decoded into a NUL-terminated buffer, with its length.
///
/// Static, not stack: the widest response the contract allows is 4096 bytes and
/// this runs inside a Unity test frame.
const char* body(const char* object, size_t& len) {
  static uint8_t bytes[corpus::kMaxStringLen];
  static char out[corpus::kMaxStringLen + 1U];
  size_t n = 0U;
  TEST_ASSERT_TRUE_MESSAGE(corpus::hexField(object, "body_hex", bytes, sizeof(bytes), &n),
                           "body_hex is absent, odd-length or not hex");
  memcpy(out, bytes, n);
  out[n] = '\0';
  len = n;
  return out;
}

// ---------------------------------------------------------------------------
// Requests — the firmware renders, the server parses
// ---------------------------------------------------------------------------

/// The heartbeat body, with the ONE field the court box's does not carry.
///
/// `firmware_version` is read back out of the expected body with the firmware's
/// OWN scanner and handed to the renderer, rather than written here as a
/// literal: the version is a fact about an image, not a term of the contract,
/// and what this case has to pin is the shape — the key names, their order and
/// the quoting — which the byte comparison then proves exactly.
void executeHeartbeatRequest(const char* expected, size_t expectedLen, const char* mac) {
  char version[32] = {};
  TEST_ASSERT_TRUE(
      devapi::json::stringField(expected, expectedLen, "firmware_version", version, sizeof(version)));
  uint32_t uptime = 0U;
  TEST_ASSERT_TRUE(devapi::json::unsignedField(expected, expectedLen, "uptime_ms", uptime));

  // The diagnostic counters are read out of the vector rather than assumed: the
  // plain heartbeat vector has neither key (a healthy board omits both), and a
  // diagnostic vector carries the counts the board must render. One executor
  // for all of them, so the vectors differ by the corpus alone.
  gatelogic::GateDiagnostics diagnostics = gatelogic::quietDiagnostics();
  (void)devapi::json::unsignedField(expected, expectedLen, "no_push", diagnostics.noPush);
  (void)devapi::json::unsignedField(expected, expectedLen, "events_lost", diagnostics.eventsLost);

  char rendered[gatelogic::kGateHeartbeatBodyCap] = {};
  const size_t written =
      gatelogic::renderGateHeartbeatBody(rendered, sizeof(rendered), mac, version, uptime, diagnostics);
  TEST_ASSERT_EQUAL_size_t(expectedLen, written);
  TEST_ASSERT_EQUAL_STRING(expected, rendered);
}

/// The counters at values NO HONEST BOARD EMITS — and that is what this vector
/// asks the firmware side to prove.
///
/// It exists for the SERVER: `no_push` at INT32_MAX + 1 and a negative
/// `events_lost` must both be ignored and answered with a clean 200, because an
/// `int?` binding would answer 400 for the whole heartbeat — roster included —
/// and a diagnostic counter would then have taken a door out of service.
///
/// The firmware's half of the same contract is that it CANNOT PRODUCE either
/// value. Both counters saturate at kMaxDiagnosticCount and neither can go
/// negative, so this executor renders the vector's own numbers and asserts the
/// body that comes out is the SATURATED one rather than the vector's. Skipping
/// it would leave the corpus carrying a case this build says nothing about,
/// which the executor below refuses on principle.
void executeOutOfRangeCountersRequest(const char* expected, size_t expectedLen, const char* mac) {
  char version[32] = {};
  TEST_ASSERT_TRUE(
      devapi::json::stringField(expected, expectedLen, "firmware_version", version, sizeof(version)));
  uint32_t uptime = 0U;
  TEST_ASSERT_TRUE(devapi::json::unsignedField(expected, expectedLen, "uptime_ms", uptime));

  // INT32_MAX + 1, taken from the vector rather than written here so a change
  // to the corpus moves this with it. The negative `events_lost` is not read
  // back — an unsigned counter has no way to hold one, which IS the property.
  uint32_t noPush = 0U;
  TEST_ASSERT_TRUE(devapi::json::unsignedField(expected, expectedLen, "no_push", noPush));
  TEST_ASSERT_EQUAL_UINT32_MESSAGE(2147483648UL, noPush, "the vector is meant to be one past INT32_MAX");

  char rendered[gatelogic::kGateHeartbeatBodyCap] = {};
  const gatelogic::GateDiagnostics diagnostics = {noPush, 4294967295UL};
  TEST_ASSERT_TRUE(
      gatelogic::renderGateHeartbeatBody(rendered, sizeof(rendered), mac, version, uptime, diagnostics) > 0U);
  TEST_ASSERT_NOT_EQUAL_MESSAGE(0, strcmp(expected, rendered),
                                "this firmware must not be able to render the out-of-range body");
  TEST_ASSERT_NOT_NULL_MESSAGE(strstr(rendered, "\"no_push\":2147483647,\"events_lost\":2147483647}"),
                               "both counters saturate at the value the server can always bind");
}

/// The scan body: the same three fields as `/device/activate` minus `court`.
void executeScanRequest(const char* expected, size_t expectedLen, const char* mac) {
  char token[roster::kMaxTokenLen + 1U] = {};
  TEST_ASSERT_TRUE(devapi::json::stringField(expected, expectedLen, "token", token, sizeof(token)));
  char method[16] = {};
  TEST_ASSERT_TRUE(devapi::json::stringField(expected, expectedLen, "method", method, sizeof(method)));
  // The gate identifies by scanner and nothing else. A `code` scan is the same
  // bytes typed rather than shown, and the board cannot tell them apart.
  TEST_ASSERT_EQUAL_STRING("qr", method);

  char rendered[gatelogic::kScanBodyCap] = {};
  const size_t written = gatelogic::renderScanBody(rendered, sizeof(rendered), mac, token);
  TEST_ASSERT_EQUAL_size_t(expectedLen, written);
  TEST_ASSERT_EQUAL_STRING(expected, rendered);
}

/// An open the gate decided from its own roster while offline, as the events
/// endpoint's body — rendered by the SAME device-agnostic renderer the court
/// box uses, which is the point of it being device-agnostic.
void executeGateOpenEventRequest(const char* expected, size_t expectedLen, const char* mac,
                                 eventq::Kind kind) {
  uint32_t batchUptime = 0U;
  TEST_ASSERT_TRUE(devapi::json::topLevelUnsignedField(expected, expectedLen, "uptime_ms", batchUptime));

  // THE BOOT IDENTITY, read from the vector rather than invented (round G4,
  // C2). Absent means ZERO, and zero is what the renderer omits — which is the
  // whole of the compatibility story and is why one vector carries it and one
  // does not.
  uint32_t bootId = 0U;
  static_cast<void>(devapi::json::topLevelUnsignedField(expected, expectedLen, "boot_id", bootId));

  // Everything below is read from INSIDE the `events` array, so the batch's own
  // `uptime_ms` above cannot be mistaken for the event's.
  const size_t at = devapi::json::findKey(expected, expectedLen, "events");
  TEST_ASSERT_NOT_EQUAL(devapi::json::kNotFound, at);
  const char* inner = expected + at;
  const size_t innerLen = expectedLen - at;

  eventq::Event event;
  uint32_t value = 0U;
  TEST_ASSERT_TRUE(devapi::json::unsignedField(inner, innerLen, "seq", value));
  event.seq = value;
  TEST_ASSERT_TRUE(devapi::json::unsignedField(inner, innerLen, "uptime_ms", value));
  event.uptimeMs = value;
  TEST_ASSERT_TRUE(devapi::json::unsignedField(inner, innerLen, "duration_ms", value));
  event.durationMs = value;

  char kindName[24] = {};
  TEST_ASSERT_TRUE(devapi::json::stringField(inner, innerLen, "kind", kindName, sizeof(kindName)));
  TEST_ASSERT_EQUAL_STRING(eventq::kindName(kind), kindName);
  event.kind = kind;

  char method[16] = {};
  TEST_ASSERT_TRUE(devapi::json::stringField(inner, innerLen, "method", method, sizeof(method)));
  TEST_ASSERT_EQUAL_STRING(eventq::methodName(eventq::Method::Qr), method);
  event.method = eventq::Method::Qr;

  // DECODED, because `devapi::json` is a SCANNER and copies escape pairs
  // verbatim — it says so, and half-decoding is how a value that differs from
  // what the server sent gets acted on as fact. The corpus's own writer escaped
  // these bytes (round G4, B1), so an executor that wants the bytes a member
  // actually scanned has to undo exactly that. Two escapes are all this corpus
  // can contain, and anything else is a vector nobody has agreed to.
  char escaped[(eventq::kMaxSubjectLen * 2U) + 1U] = {};
  TEST_ASSERT_TRUE(devapi::json::stringField(inner, innerLen, "subject", escaped, sizeof(escaped)));
  char subject[eventq::kMaxSubjectLen + 1U] = {};
  size_t out = 0U;
  for (size_t i = 0U; escaped[i] != '\0'; ++i) {
    if (escaped[i] == '\\') {
      ++i;
      TEST_ASSERT_TRUE_MESSAGE(escaped[i] == '"' || escaped[i] == '\\',
                               "this corpus only ever escapes a quote or a backslash");
    }
    TEST_ASSERT_TRUE(out < eventq::kMaxSubjectLen);
    subject[out] = escaped[i];
    ++out;
  }
  subject[out] = '\0';
  TEST_ASSERT_TRUE(event.setSubject(subject));

  // A door is not on a court, so the court field is the queue's "not one court"
  // sentinel and goes out as -1. Nothing here sets it: the default IS the
  // assertion, and a gate that set a court would render a 0 the server would
  // file against relay A of a box that does not exist.
  TEST_ASSERT_EQUAL_UINT8(eventq::Event::kNoCourt, event.court);

  char rendered[devlink::kEventBodyCap] = {};
  const size_t written =
      devlink::renderEventBody(rendered, sizeof(rendered), mac, bootId, batchUptime, event);
  TEST_ASSERT_EQUAL_size_t(expectedLen, written);
  TEST_ASSERT_EQUAL_STRING(expected, rendered);
}

/// Every request vector: the body this firmware renders, byte for byte, plus
/// the path it posts to and the one header every call carries.
void test_every_request_vector_is_rendered_byte_for_byte() {
  loadCorpus();

  char mac[devapi::kMacHexLen + 1U] = {};
  text(g_cases.root(), "device_mac", mac, sizeof(mac));
  char apiKey[devapi::kMaxApiKeyLen + 1U] = {};
  text(g_cases.root(), "device_api_key", apiKey, sizeof(apiKey));

  corpus::ArrayIter it(section("requests"));
  const char* element = nullptr;
  size_t executed = 0U;

  while (it.next(&element)) {
    char id[corpus::kMaxNameLen] = {};
    text(element, "id", id, sizeof(id));

    char method[8] = {};
    text(element, "method", method, sizeof(method));
    TEST_ASSERT_EQUAL_STRING_MESSAGE("POST", method, id);

    // The bearer header, rendered by the same function the composition root
    // calls at boot. A correct key under a wrong header value is a 401 nobody
    // can explain from a desk.
    char authorization[128] = {};
    text(element, "authorization", authorization, sizeof(authorization));
    char header[devapi::kAuthorizationBufSize] = {};
    TEST_ASSERT_TRUE(devapi::renderAuthorization(header, sizeof(header), apiKey) > 0U);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(authorization, header, id);

    char path[64] = {};
    text(element, "path_and_query", path, sizeof(path));

    size_t expectedLen = 0U;
    const char* expected = body(element, expectedLen);

    if (strcmp(id, "gate-heartbeat-request") == 0 || strcmp(id, "gate-heartbeat-request-no-push") == 0 ||
        strcmp(id, "gate-heartbeat-request-events-lost") == 0) {
      TEST_ASSERT_EQUAL_STRING(gatelogic::kPathHeartbeat, path);
      executeHeartbeatRequest(expected, expectedLen, mac);
    } else if (strcmp(id, "gate-heartbeat-request-counters-out-of-range") == 0) {
      TEST_ASSERT_EQUAL_STRING(gatelogic::kPathHeartbeat, path);
      executeOutOfRangeCountersRequest(expected, expectedLen, mac);
    } else if (strcmp(id, "gate-scan-request") == 0) {
      TEST_ASSERT_EQUAL_STRING(gatelogic::kPathGate, path);
      executeScanRequest(expected, expectedLen, mac);
    } else if (strcmp(id, "gate-events-request-gate-open") == 0) {
      TEST_ASSERT_EQUAL_STRING(gatelogic::kPathEvents, path);
      executeGateOpenEventRequest(expected, expectedLen, mac, eventq::Kind::GateOpen);
    } else if (strcmp(id, "gate-events-request-no-boot-id") == 0) {
      // THE COMPATIBILITY SHAPE (round G4, C2). A boot id of 0 omits the field
      // entirely, and the server reads an absent one as 0 — which is exactly
      // what (device, seq) always meant. That is what lets the court box, whose
      // composition root passes 0, keep rendering the body it always has, and
      // what lets a gate flashed before this change keep working. The vector
      // also carries a `"` in its subject, so the escaping round G4's B1 added
      // is pinned on the wire rather than only in a fuzz loop.
      TEST_ASSERT_EQUAL_STRING(gatelogic::kPathEvents, path);
      executeGateOpenEventRequest(expected, expectedLen, mac, eventq::Kind::UnknownScan);
    } else {
      // Never a skip. A vector this build does not recognise is a contract this
      // build does not implement, and saying so is the whole point.
      TEST_FAIL_MESSAGE("corpus carries a request id this firmware does not execute");
    }
    ++executed;
  }

  TEST_ASSERT_EQUAL_size_t(declaredCount("requests"), executed);
}

// ---------------------------------------------------------------------------
// Responses — the server renders, the firmware parses
// ---------------------------------------------------------------------------

/// The third field of a `TOKEN|relay|opens_in|closes_in` element, as text.
///
/// Read straight out of the expected string rather than through
/// devlink::parseRosterElement, so the expectation is independent of the parser
/// it is checking: a firmware that read `opens_in` unsigned would turn -900
/// into an enormous wait and lock out somebody whose court starts in five
/// minutes, and an expectation derived from the same parser would agree with it.
bool elementWindowIsAlreadyOpen(const char* element) {
  const char* p = element;
  for (int field = 0; field < 2; ++field) {
    p = strchr(p, '|');
    TEST_ASSERT_NOT_NULL(p);
    ++p;
  }
  return *p == '-';
}

void executeHeartbeatResponse(const char* id, const char* payload, size_t len, const char* expect) {
  // `kind` is what tells a board which shape it is looking at. A gate that
  // adopted a court box's answer would drive a lock off a court roster.
  char kind[16] = {};
  TEST_ASSERT_TRUE_MESSAGE(devapi::json::stringField(payload, len, "kind", kind, sizeof(kind)), id);
  char expectedKind[16] = {};
  text(expect, "kind", expectedKind, sizeof(expectedKind));
  TEST_ASSERT_EQUAL_STRING_MESSAGE(expectedKind, kind, id);

  // gate_key: PRESENT as null for a door nobody has named yet. Absent and null
  // are different facts and a firmware that collapsed them would diverge here.
  const char* expectedGateKey = corpus::member(expect, "gate_key");
  if (expectedGateKey != nullptr) {
    char gateKey[kMaxGateKeyLen + 1U] = {};
    const bool read = devapi::json::stringField(payload, len, "gate_key", gateKey, sizeof(gateKey));
    TEST_ASSERT_NOT_EQUAL_MESSAGE(devapi::json::kNotFound, devapi::json::findKey(payload, len, "gate_key"),
                                  id);
    if (corpus::skipWs(expectedGateKey)[0] == 'n') {
      TEST_ASSERT_FALSE_MESSAGE(read, id);
    } else {
      char wanted[kMaxGateKeyLen + 1U] = {};
      TEST_ASSERT_TRUE(corpus::stringValue(expectedGateKey, wanted, sizeof(wanted), nullptr));
      TEST_ASSERT_TRUE_MESSAGE(read, id);
      TEST_ASSERT_EQUAL_STRING_MESSAGE(wanted, gateKey, id);
    }
  }

  const char* expectedSeconds = corpus::member(expect, "heartbeat_seconds");
  if (expectedSeconds != nullptr) {
    uint32_t intervalMs = 0U;
    TEST_ASSERT_TRUE_MESSAGE(devlink::parseHeartbeatInterval(payload, len, intervalMs), id);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(corpus::unsignedValue(expectedSeconds) * 1000U, intervalMs, id);
  }

  const char* expectedGate = corpus::member(expect, "gate");
  if (expectedGate != nullptr) {
    uint32_t unlockMs = 0U;
    TEST_ASSERT_TRUE_MESSAGE(gatelogic::adoptUnlockMs(payload, len, unlockMs), id);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(
        corpus::unsignedValue(corpus::member(expectedGate, "unlock_seconds")) * 1000U, unlockMs, id);
  }

  // The roster, applied exactly as the heartbeat handler applies one, and then
  // ASKED — the decision is what the door actually runs on, and a roster that
  // parsed and admitted nobody would pass a field-by-field comparison.
  const char* expectedRoster = corpus::member(expect, "roster");
  TEST_ASSERT_NOT_NULL_MESSAGE(expectedRoster, id);
  Cache cache(gatelogic::kGateConfig.rosterMaxAgeMs);
  const devlink::SyncResult sync = devlink::applyRoster(payload, len, cache, kNow);
  TEST_ASSERT_TRUE_MESSAGE(sync.replaced, id);
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(0U, sync.rejected, id);
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(0U, sync.dropped, id);

  corpus::ArrayIter entries(expectedRoster);
  const char* entry = nullptr;
  uint8_t counted = 0U;
  while (entries.next(&entry)) {
    char element[roster::kMaxTokenLen + 32U] = {};
    TEST_ASSERT_TRUE(corpus::stringValue(entry, element, sizeof(element), nullptr));
    char token[roster::kMaxTokenLen + 1U] = {};
    const char* bar = strchr(element, '|');
    TEST_ASSERT_NOT_NULL(bar);
    memcpy(token, element, static_cast<size_t>(bar - element));

    // One scanner, one door: the gate is the CourtCount(1) case of the same
    // shared decide() the court box uses with four.
    const roster::Decision decision = cache.decide(token, roster::CourtCount(1U), kNow);
    if (elementWindowIsAlreadyOpen(element)) {
      TEST_ASSERT_TRUE_MESSAGE(decision.verdict == roster::Verdict::Allow, element);
    } else {
      TEST_ASSERT_TRUE_MESSAGE(decision.verdict == roster::Verdict::TooEarly, element);
    }
    ++counted;
  }
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(counted, cache.size(), id);
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(counted, sync.accepted, id);

  // The byte budget. `max_bytes` is the whole body, and it has to fit the
  // static buffer this firmware holds a response in — a budget the board cannot
  // hold is a roster silently truncated mid-element.
  const char* maxBytes = corpus::member(expect, "max_bytes");
  if (maxBytes != nullptr) {
    const size_t budget = static_cast<size_t>(corpus::unsignedValue(maxBytes));
    TEST_ASSERT_TRUE_MESSAGE(len <= budget, id);
    TEST_ASSERT_TRUE_MESSAGE(budget < gatelogic::kGateResponseCap, id);
  }
}

void executeGateResponse(const char* id, const char* payload, size_t len, const char* expect) {
  // 200 for every decision, refusals included. The clamp bounds come from the
  // build flags the board actually carries.
  const gatelogic::ScanDecision decision = gatelogic::onGateResponse(
      200U, payload, len, gatelogic::kGateConfig.unlockDefaultMs, gatelogic::kGateConfig.unlockHardCapMs);

  // A 200 is a DECISION. Falling back to the roster after one would let a
  // member the club has barred in through a booking the club has not cancelled.
  TEST_ASSERT_FALSE_MESSAGE(decision.fallbackToRoster, id);

  const bool expectedOpened = corpus::skipWs(corpus::member(expect, "opened"))[0] == 't';
  TEST_ASSERT_EQUAL_MESSAGE(expectedOpened, decision.released, id);

  char expectedReason[gatelogic::kMaxReasonLen + 1U] = {};
  text(expect, "reason", expectedReason, sizeof(expectedReason));
  TEST_ASSERT_EQUAL_STRING_MESSAGE(expectedReason, decision.reason, id);

  const uint32_t expectedSeconds =
      static_cast<uint32_t>(corpus::unsignedValue(corpus::member(expect, "unlock_seconds")));
  if (expectedOpened) {
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(expectedSeconds * 1000U, decision.unlockMs, id);
  } else {
    // A refusal releases nothing, whatever number came with it.
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(0U, expectedSeconds, id);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(0U, decision.unlockMs, id);
  }

  // An online decision is the API's own record. Queueing it would file every
  // open twice.
  TEST_ASSERT_FALSE_MESSAGE(decision.queueEvent, id);
}

void test_every_response_vector_is_read_the_way_the_server_wrote_it() {
  loadCorpus();

  corpus::ArrayIter it(section("responses"));
  const char* element = nullptr;
  size_t executed = 0U;

  while (it.next(&element)) {
    char id[corpus::kMaxNameLen] = {};
    text(element, "id", id, sizeof(id));
    char kind[corpus::kMaxNameLen] = {};
    text(element, "kind", kind, sizeof(kind));

    const char* expect = corpus::member(element, "expect");
    TEST_ASSERT_NOT_NULL_MESSAGE(expect, id);

    size_t len = 0U;
    const char* payload = body(element, len);

    if (strcmp(kind, "heartbeat") == 0) {
      executeHeartbeatResponse(id, payload, len, expect);
    } else if (strcmp(kind, "gate") == 0) {
      executeGateResponse(id, payload, len, expect);
    } else {
      TEST_FAIL_MESSAGE("corpus carries a response kind this firmware does not execute");
    }
    ++executed;
  }

  TEST_ASSERT_EQUAL_size_t(declaredCount("responses"), executed);
}

/// Both directions, over the file rather than over the cases: every array in
/// cases.json is declared in the manifest, and every section the manifest
/// declares exists in cases.json. A section added to one and not the other is
/// how a family quietly grows a half nobody runs.
void test_every_corpus_section_is_declared_and_executed() {
  loadCorpus();

  char name[corpus::kMaxNameLen] = {};
  const char* value = nullptr;
  size_t seen = 0U;

  corpus::ObjectIter cases(g_cases.root());
  while (cases.next(name, sizeof(name), &value)) {
    if (!corpus::isArray(value)) {
      continue;
    }
    TEST_ASSERT_TRUE_MESSAGE(strcmp(name, "requests") == 0 || strcmp(name, "responses") == 0,
                             "corpus section was not executed by any test in this suite");
    ++seen;
  }

  const char* counts = corpus::member(g_manifest.root(), "case_count");
  TEST_ASSERT_NOT_NULL(counts);
  corpus::ObjectIter declared(counts);
  size_t sectionsDeclared = 0U;
  while (declared.next(name, sizeof(name), &value)) {
    TEST_ASSERT_NOT_NULL_MESSAGE(corpus::member(g_cases.root(), name),
                                 "manifest declares a section cases.json does not contain");
    ++sectionsDeclared;
  }

  TEST_ASSERT_EQUAL_size_t(seen, sectionsDeclared);
  TEST_ASSERT_EQUAL_size_t(2U, seen);
}

} // namespace

void setUp() {
}

void tearDown() {
}

int main(int, char**) {
  UNITY_BEGIN();

  RUN_TEST(test_every_request_vector_is_rendered_byte_for_byte);
  RUN_TEST(test_every_response_vector_is_read_the_way_the_server_wrote_it);
  RUN_TEST(test_every_corpus_section_is_declared_and_executed);

  return UNITY_END();
}

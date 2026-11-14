// Bridge 3.1.0's lifeline, host-tested: the flash records, the device key
// ring, the runtime network, the lifeline settings, the stall watchdog, the
// setup chord and portal form, signed OTA with its probation and rollback, and
// what a boot restores after a power cut with no network
// (docs/specs/device-api.md §4, §6–§8, §11.1; BR-01, BR-06, BR-07, FSF-09,
// HW-8).
//
// Reboots are simulated the way the board has them: a NEW object over the SAME
// flash. Nothing a test asserts about "after a reset" may survive in RAM.

#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unity.h>

#include <map>
#include <string>
#include <vector>

#include "bridgelogic/BridgeOta.h"
#include "bridgelogic/Lifeline.h"
#include "bridgelogic/Persist.h"
#include "bridgelogic/Records.h"
#include "bridgelogic/V3Heartbeat.h"
#include "devapi/Json.h"
#include "devcrypto/Hex.h"
#include "devcrypto/Sha256.h"
#include "eventq/EventQueue.h"
#include "support/CorpusJson.h"

namespace {

// --- the fakes --------------------------------------------------------------------

/// RAM files with the port's atomic rule, and two failure dials.
class FakeFiles final : public bridgelogic::IFiles {
public:
  bool write(const char* path, const bridgelogic::Part* parts, uint8_t count) override {
    if (failWrites) {
      return false;
    }
    std::string all;
    for (uint8_t i = 0U; i < count; ++i) {
      all.append(static_cast<const char*>(parts[i].data), parts[i].len);
    }
    files[path] = all;
    ++writes;
    return true;
  }

  size_t read(const char* path, uint32_t offset, void* out, size_t cap) override {
    const auto it = files.find(path);
    if (it == files.end() || offset >= it->second.size()) {
      return 0U;
    }
    const size_t n = (it->second.size() - offset) < cap ? (it->second.size() - offset) : cap;
    memcpy(out, it->second.data() + offset, n);
    return n;
  }

  uint32_t size(const char* path) override {
    const auto it = files.find(path);
    return it == files.end() ? 0U : static_cast<uint32_t>(it->second.size());
  }

  void remove(const char* path) override { files.erase(path); }

  bool begin(const char* path) override {
    if (failWrites || streaming) {
      return false;
    }
    streaming = true;
    streamPath = path;
    stream.clear();
    return true;
  }

  bool append(const void* data, size_t len) override {
    if (!streaming || (failAfter > 0U && stream.size() + len > failAfter)) {
      return false;
    }
    stream.append(static_cast<const char*>(data), len);
    return true;
  }

  bool end(bool keep) override {
    if (!streaming) {
      return false;
    }
    streaming = false;
    if (keep) {
      files[streamPath] = stream;
      ++writes;
    }
    return true;
  }

  std::map<std::string, std::string> files;
  bool failWrites = false;
  size_t failAfter = 0U;
  bool streaming = false;
  std::string streamPath;
  std::string stream;
  uint32_t writes = 0U;
};

/// The ESP8266's flash: a running image, a staging area, the eboot copy at
/// the next "boot" (apply()).
class FakeFlash final : public bridgelogic::IImageFlash {
public:
  uint32_t runningSize() override { return static_cast<uint32_t>(running.size()); }

  bool readRunning(uint32_t offset, uint8_t* out, size_t len) override {
    if (offset % 4U != 0U || len % 4U != 0U) {
      return false; // the real flashRead's rule
    }
    for (size_t i = 0U; i < len; ++i) {
      out[i] = offset + i < running.size() ? running[offset + i] : 0xFFU;
    }
    return true;
  }

  uint32_t capacity() override { return cap; }

  bool begin(uint32_t size) override {
    if (size > cap) {
      return false;
    }
    staged.clear();
    stagedSize = size;
    open = true;
    return true;
  }

  bool write(const uint8_t* data, size_t len) override {
    if (!open || staged.size() + len > stagedSize) {
      return false;
    }
    staged.insert(staged.end(), data, data + len);
    if (corruptStagedAt >= 0 && static_cast<size_t>(corruptStagedAt) < staged.size()) {
      staged[static_cast<size_t>(corruptStagedAt)] ^= 0x40U; // a flash bit that did not take
      corruptStagedAt = -1;
    }
    return true;
  }

  bool commit(bridgelogic::IStagedCheck& check) override {
    if (!open || staged.size() != stagedSize) {
      open = false;
      return false;
    }
    open = false;
    uint8_t digest[32];
    dc::sha256(staged.data(), staged.size(), digest); // READ BACK, as the core does
    if (!check.accept(digest, static_cast<uint32_t>(staged.size()))) {
      return false;
    }
    armed = true;
    return true;
  }

  void abort() override {
    open = false;
    staged.clear();
  }

  /// The reboot: eboot copies an armed image over the running one.
  void reboot() {
    if (armed) {
      running = staged;
      armed = false;
    }
  }

  std::vector<uint8_t> running;
  std::vector<uint8_t> staged;
  uint32_t stagedSize = 0U;
  uint32_t cap = 600000U;
  bool open = false;
  bool armed = false;
  int corruptStagedAt = -1;
};

class FakeDownload final : public bridgelogic::IDownload {
public:
  uint16_t get(const char* path, uint32_t expectBytes, bridgelogic::IChunkSink& sink) override {
    ++calls;
    lastPath = path;
    if (status != 200U) {
      return status;
    }
    if (body.size() != expectBytes && !sendAnyway) {
      return 0U; // Content-Length disagrees: refused before a byte
    }
    const size_t total = cutAt > 0U && cutAt < body.size() ? cutAt : body.size();
    for (size_t at = 0U; at < total; at += chunk) {
      const size_t take = (total - at) < chunk ? (total - at) : chunk;
      if (!sink.chunk(body.data() + at, take)) {
        return 200U;
      }
    }
    return 200U;
  }

  std::vector<uint8_t> body;
  uint16_t status = 200U;
  size_t chunk = 300U;
  size_t cutAt = 0U;
  bool sendAnyway = false;
  uint32_t calls = 0U;
  std::string lastPath;
};

struct CountingHooks final : public bridgelogic::BridgeOta::Hooks {
  void during() override { ++calls; }

  uint32_t calls = 0U;
};

// --- the corpus ---------------------------------------------------------------------

corpus::File g_ota;
corpus::File g_http;

void loadOta() {
  TEST_ASSERT_TRUE_MESSAGE(g_ota.load("ota", "cases.json"), "ota corpus not found");
}

void loadHttp() {
  TEST_ASSERT_TRUE_MESSAGE(g_http.load("http", "cases.json"), "http corpus not found");
}

void modulusOf(const char* keyName, uint8_t out[dc::kRsa2048Bytes]) {
  const char* key = corpus::member(g_ota.root(), keyName);
  TEST_ASSERT_NOT_NULL(key);
  char hex[600] = {};
  TEST_ASSERT_TRUE(corpus::stringValue(corpus::member(key, "n_hex"), hex, sizeof(hex), nullptr));
  TEST_ASSERT_TRUE(devota::parseModulusHex(hex, out));
}

/// The bridge image vector: its bytes and its offer's JSON.
struct BridgeImage {
  std::vector<uint8_t> bytes;
  std::string offer;
};

BridgeImage bridgeImage() {
  loadOta();
  corpus::ArrayIter it(corpus::member(g_ota.root(), "images"));
  const char* c = nullptr;
  while (it.next(&c)) {
    char id[64] = {};
    TEST_ASSERT_TRUE(corpus::stringValue(corpus::member(c, "id"), id, sizeof(id), nullptr));
    if (strcmp(id, "image-bridge") != 0) {
      continue;
    }
    BridgeImage image;
    static uint8_t raw[8192];
    size_t len = 0U;
    TEST_ASSERT_TRUE(corpus::hexField(c, "image_hex", raw, sizeof(raw), &len));
    image.bytes.assign(raw, raw + len);
    const char* offer = corpus::member(c, "offer");
    const char* end = corpus::skipValue(offer);
    image.offer.assign(offer, static_cast<size_t>(end - offer));
    return image;
  }
  TEST_FAIL_MESSAGE("image-bridge missing from ota/");
  return BridgeImage();
}

/// The response body of http/ vector `id`.
std::string httpBody(const char* id) {
  loadHttp();
  corpus::ArrayIter it(corpus::member(g_http.root(), "responses"));
  const char* c = nullptr;
  while (it.next(&c)) {
    char got[96] = {};
    TEST_ASSERT_TRUE(corpus::stringValue(corpus::member(c, "id"), got, sizeof(got), nullptr));
    if (strcmp(got, id) != 0) {
      continue;
    }
    static uint8_t raw[6000];
    size_t len = 0U;
    TEST_ASSERT_TRUE(corpus::hexField(c, "body_hex", raw, sizeof(raw), &len));
    return std::string(reinterpret_cast<const char*>(raw), len);
  }
  TEST_FAIL_MESSAGE(id);
  return std::string();
}

/// The text of the top-level object `key` in `body`, braces included.
std::string objectIn(const std::string& body, const char* key) {
  size_t objLen = 0U;
  const size_t at = devapi::json::findTopLevelObject(body.data(), body.size(), key, objLen);
  TEST_ASSERT_NOT_EQUAL_MESSAGE(devapi::json::kNotFound, at, key);
  return body.substr(at - 1U, objLen + 2U);
}

/// A running image that is not the new one: 4 KB of a pattern, length not a
/// multiple of four (the copy must round its reads, never its file).
std::vector<uint8_t> oldImage() {
  std::vector<uint8_t> v(4099U);
  for (size_t i = 0U; i < v.size(); ++i) {
    v[i] = static_cast<uint8_t>((i * 31U) ^ 0x5AU);
  }
  return v;
}

dc::RsaWorkspace g_work;
alignas(4) uint8_t g_buffer[1024];

// --- records -------------------------------------------------------------------------

void test_a_sealed_record_reads_back_and_a_damaged_one_reads_as_absent() {
  FakeFiles files;

  struct Rec {
    uint32_t a;
    char b[8];
  } in = {7U, "court"};

  TEST_ASSERT_TRUE(bridgelogic::sealedPut(files, "/r", 3U, in));
  Rec out = {};
  TEST_ASSERT_TRUE(bridgelogic::sealedGet(files, "/r", 3U, out));
  TEST_ASSERT_EQUAL_UINT32(7U, out.a);
  TEST_ASSERT_EQUAL_STRING("court", out.b);
  // Another layout, a torn tail, a flipped bit, a blank part: absent, and the
  // output reset rather than half-filled.
  TEST_ASSERT_FALSE(bridgelogic::sealedGet(files, "/r", 4U, out));
  TEST_ASSERT_EQUAL_UINT32(0U, out.a);
  std::string whole = files.files["/r"];
  files.files["/r"] = whole.substr(0U, whole.size() - 1U);
  TEST_ASSERT_FALSE(bridgelogic::sealedGet(files, "/r", 3U, out));
  files.files["/r"] = whole;
  files.files["/r"][whole.size() - 2U] ^= 0x01;
  TEST_ASSERT_FALSE(bridgelogic::sealedGet(files, "/r", 3U, out));
  files.files["/r"] = std::string(whole.size(), '\xff');
  TEST_ASSERT_FALSE(bridgelogic::sealedGet(files, "/r", 3U, out));
  files.files.erase("/r");
  TEST_ASSERT_FALSE(bridgelogic::sealedGet(files, "/r", 3U, out));
}

// --- the device keys (§6) ------------------------------------------------------------

std::string authOf(const char* key) {
  return std::string("Bearer ") + key;
}

void test_key_next_is_persisted_before_use_and_survives_a_reset() {
  FakeFiles files;
  const char* compiled = "compiled-first-boot-key";
  bridgelogic::BridgeKeys keys;
  keys.begin(compiled, &files);
  TEST_ASSERT_EQUAL_STRING(authOf(compiled).c_str(), keys.header());
  TEST_ASSERT_EQUAL_STRING("k0", keys.activeId());

  const std::string body = httpBody("v3-heartbeat-response-key-next");
  const std::string next = objectIn(body, "key_next");
  TEST_ASSERT_EQUAL_STRING("ok", devnet::refusalName(keys.adopt(next.data(), next.size())));
  TEST_ASSERT_EQUAL_STRING(authOf("Zq7Hn2Vb5Rt8Wy1Lp4Mk6Xc9Ds3Fg0Jh_a-QeUoIiEr").c_str(), keys.header());
  TEST_ASSERT_EQUAL_STRING("k2", keys.activeId());
  // The same key again is `current`, never a second adoption.
  TEST_ASSERT_EQUAL_STRING("current", devnet::refusalName(keys.adopt(next.data(), next.size())));

  // Reset: a new ring over the same flash holds the new key.
  bridgelogic::BridgeKeys after;
  after.begin(compiled, &files);
  TEST_ASSERT_EQUAL_STRING("k2", after.activeId());
  // A 401: one retry on the previous (the compiled k0), both kept; the retry
  // failing goes back. Neither is ever erased.
  TEST_ASSERT_TRUE(after.switchForRetry());
  TEST_ASSERT_EQUAL_STRING(authOf(compiled).c_str(), after.header());
  after.retryFailed();
  TEST_ASSERT_EQUAL_STRING("k2", after.activeId());
  // A server restored to the old key: the retry works and stays first.
  TEST_ASSERT_TRUE(after.switchForRetry());
  TEST_ASSERT_EQUAL_STRING("k0", after.activeId());
}

void test_a_key_that_cannot_be_persisted_is_not_used() {
  FakeFiles files;
  bridgelogic::BridgeKeys keys;
  keys.begin("compiled", &files);
  files.failWrites = true;
  const std::string next = objectIn(httpBody("v3-heartbeat-response-key-next"), "key_next");
  TEST_ASSERT_NOT_EQUAL(static_cast<int>(devnet::Refusal::Ok),
                        static_cast<int>(keys.adopt(next.data(), next.size())));
  TEST_ASSERT_EQUAL_STRING("k0", keys.activeId());
  TEST_ASSERT_EQUAL_STRING("Bearer compiled", keys.header());
  // And a malformed one, with flash working, changes nothing either.
  files.failWrites = false;
  const char bad[] = "{\"id\":\"k2\",\"key\":\"short\"}";
  TEST_ASSERT_EQUAL_STRING("key", devnet::refusalName(keys.adopt(bad, strlen(bad))));
  TEST_ASSERT_EQUAL_STRING("k0", keys.activeId());
}

void test_a_portal_key_becomes_current_and_keeps_the_previous() {
  FakeFiles files;
  bridgelogic::BridgeKeys keys;
  keys.begin("compiled", &files);
  TEST_ASSERT_FALSE(keys.adoptLocal("k0", "Zq7Hn2Vb5Rt8Wy1Lp4Mk6Xc9Ds3Fg0Jh_a-QeUoIiEr"));
  TEST_ASSERT_FALSE(keys.adoptLocal("k3", "not-43-characters"));
  TEST_ASSERT_TRUE(keys.adoptLocal("k3", "Zq7Hn2Vb5Rt8Wy1Lp4Mk6Xc9Ds3Fg0Jh_a-QeUoIiEr"));
  TEST_ASSERT_EQUAL_STRING("k3", keys.activeId());
  TEST_ASSERT_TRUE(keys.ring().hasPrevious);
  TEST_ASSERT_EQUAL_STRING("k0", keys.ring().previousId);
}

// --- the network (§8) ----------------------------------------------------------------

void test_a_server_net_is_adopted_whole_and_the_previous_set_is_the_fallback() {
  FakeFiles files;
  bridgelogic::BridgeNet net;
  net.begin("COMPILED", "compiled-pass", "http://192.168.1.10:8088", &files);
  TEST_ASSERT_EQUAL_STRING("http://192.168.1.10:8088", net.baseUrl());
  TEST_ASSERT_EQUAL_UINT8(1U, net.profileCount());
  TEST_ASSERT_EQUAL_UINT32(0U, net.version());
  TEST_ASSERT_EQUAL_STRING("compiled", bridgelogic::netSourceName(net.source()));

  const std::string obj = objectIn(httpBody("v3-heartbeat-response-net"), "net");
  TEST_ASSERT_TRUE(net.adopt(obj.data(), obj.size(), 1000U).adopted());
  TEST_ASSERT_EQUAL_STRING("http://192.168.1.20:8088", net.baseUrl());
  TEST_ASSERT_EQUAL_UINT32(4U, net.version());
  TEST_ASSERT_EQUAL_STRING("server", bridgelogic::netSourceName(net.source()));
  // New first, then the compiled one: three profiles, in that order.
  TEST_ASSERT_EQUAL_UINT8(3U, net.profileCount());
  TEST_ASSERT_EQUAL_STRING("CRUSADERS", net.ssid(0U));
  TEST_ASSERT_EQUAL_STRING("CRUSADERS-NEW", net.ssid(1U));
  TEST_ASSERT_EQUAL_STRING("COMPILED", net.ssid(2U));
  TEST_ASSERT_EQUAL_STRING("compiled-pass", net.psk(2U));
  TEST_ASSERT_EQUAL_UINT8(1U, net.advanceProfile());
  TEST_ASSERT_EQUAL_UINT8(2U, net.advanceProfile());
  TEST_ASSERT_EQUAL_UINT8(0U, net.advanceProfile());
  // Not newer: nothing rewritten, no flash wear.
  const uint32_t writes = files.writes;
  TEST_ASSERT_EQUAL_STRING("not_newer", devnet::refusalName(net.adopt(obj.data(), obj.size(), 2000U).reason));
  TEST_ASSERT_EQUAL_UINT32(writes, files.writes);

  // Reset: the set is in flash.
  bridgelogic::BridgeNet after;
  after.begin("COMPILED", "compiled-pass", "http://192.168.1.10:8088", &files);
  TEST_ASSERT_EQUAL_STRING("http://192.168.1.20:8088", after.baseUrl());
  TEST_ASSERT_EQUAL_UINT32(4U, after.version());
}

void test_one_bad_field_adopts_nothing() {
  FakeFiles files;
  bridgelogic::BridgeNet net;
  net.begin("COMPILED", "compiled-pass", "http://192.168.1.10:8088", &files);
  static const char* const kBad[] = {
      "{\"ver\":5,\"base\":\"https://192.168.1.20\",\"wifi0_ssid\":\"A\",\"wifi0_psk\":\"long-enough\"}",
      "{\"ver\":5,\"base\":\"http://192.168.1.20\",\"wifi0_ssid\":\"A\",\"wifi0_psk\":\"short\"}",
      "{\"ver\":5,\"base\":\"http://192.168.1.20/path\",\"wifi0_ssid\":\"A\",\"wifi0_psk\":\"long-enough\"}",
      "{\"ver\":\"5\",\"base\":\"http://192.168.1.20\"}",
  };
  for (const char* bad : kBad) {
    TEST_ASSERT_FALSE_MESSAGE(net.adopt(bad, strlen(bad), 0U).adopted(), bad);
    TEST_ASSERT_EQUAL_STRING_MESSAGE("http://192.168.1.10:8088", net.baseUrl(), bad);
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(1U, net.profileCount(), bad);
  }
  TEST_ASSERT_EQUAL_UINT32(0U, files.writes);
}

void test_a_new_base_that_never_answers_is_abandoned_and_never_readopted() {
  FakeFiles files;
  bridgelogic::BridgeNet net;
  net.begin("COMPILED", "compiled-pass", "http://192.168.1.10:8088", &files);
  const char typo[] = "{\"ver\":7,\"base\":\"http://192.168.1.99:8088\"}";
  TEST_ASSERT_TRUE(net.adopt(typo, strlen(typo), 0U).adopted());
  TEST_ASSERT_EQUAL_STRING("http://192.168.1.99:8088", net.baseUrl());
  TEST_ASSERT_FALSE(net.tick(9UL * 60000UL, 10U));
  TEST_ASSERT_TRUE(net.tick(10UL * 60000UL, 10U));
  TEST_ASSERT_EQUAL_STRING("http://192.168.1.10:8088", net.baseUrl());
  TEST_ASSERT_FALSE(net.tick(20UL * 60000UL, 10U)); // once
  TEST_ASSERT_EQUAL_STRING("not_newer", devnet::refusalName(net.adopt(typo, strlen(typo), 0U).reason));
  // A base that DID answer is never abandoned.
  const char good[] = "{\"ver\":8,\"base\":\"http://192.168.1.30:8088\"}";
  TEST_ASSERT_TRUE(net.adopt(good, strlen(good), 0U).adopted());
  net.heartbeatAccepted();
  TEST_ASSERT_FALSE(net.tick(60UL * 60000UL, 10U));
  TEST_ASSERT_EQUAL_STRING("http://192.168.1.30:8088", net.baseUrl());
  // ... and a reset keeps it proven.
  bridgelogic::BridgeNet after;
  after.begin("COMPILED", "compiled-pass", "http://192.168.1.10:8088", &files);
  after.startClock(0U);
  TEST_ASSERT_FALSE(after.tick(60UL * 60000UL, 10U));
}

void test_the_setup_portal_saves_a_local_set_by_the_server_rules() {
  static char scratch[1536];
  bridgelogic::PortalForm form;
  form.ssid = "CLUB WIFI";
  form.psk = "squash+court&1";
  form.base = "http://192.168.1.40:8088";
  devnet::NetSet set;
  TEST_ASSERT_EQUAL_STRING(
      "ok", devnet::refusalName(bridgelogic::validatePortalForm(form, set, scratch, sizeof(scratch))));
  TEST_ASSERT_EQUAL_STRING("squash+court&1", set.wifi[0].psk);
  FakeFiles files;
  bridgelogic::BridgeNet net;
  net.begin("COMPILED", "compiled-pass", "http://192.168.1.10:8088", &files);
  TEST_ASSERT_TRUE(net.adoptLocal(set));
  TEST_ASSERT_EQUAL_STRING("local", bridgelogic::netSourceName(net.source()));
  TEST_ASSERT_EQUAL_UINT32(0U, net.version());
  TEST_ASSERT_EQUAL_STRING("http://192.168.1.40:8088", net.baseUrl());
  TEST_ASSERT_FALSE(net.tick(120UL * 60000UL, 10U)); // typed at the box: trusted
  // The refusals a technician sees are the console's words.
  form.base = "https://192.168.1.40";
  TEST_ASSERT_EQUAL_STRING("base_https", devnet::refusalName(bridgelogic::validatePortalForm(
                                             form, set, scratch, sizeof(scratch))));
  form.base = "http://192.168.1.40:8088";
  form.psk = "short";
  TEST_ASSERT_EQUAL_STRING(
      "wifi0_psk", devnet::refusalName(bridgelogic::validatePortalForm(form, set, scratch, sizeof(scratch))));
  char decoded[32];
  TEST_ASSERT_TRUE(bridgelogic::urlDecode("squash%2Bcourt+1", 16U, decoded, sizeof(decoded)));
  TEST_ASSERT_EQUAL_STRING("squash+court 1", decoded);
  TEST_ASSERT_FALSE(bridgelogic::urlDecode("bad%zz", 6U, decoded, sizeof(decoded)));
  TEST_ASSERT_FALSE(bridgelogic::urlDecode("nul%00", 6U, decoded, sizeof(decoded)));
  char ap[32];
  TEST_ASSERT_TRUE(bridgelogic::setupApName("5ccf7f1a2b3c", ap, sizeof(ap)));
  TEST_ASSERT_EQUAL_STRING("CRUSADERS-SETUP-2B3C", ap);
}

void test_the_setup_chord_opens_the_portal_only_inside_the_window() {
  bridgelogic::SetupChord chord;
  chord.begin(1000U);
  TEST_ASSERT_FALSE(chord.held("09", "4", 6000U)); // not five seconds yet
  TEST_ASSERT_FALSE(chord.held("01", "5", 7000U)); // court A alone
  TEST_ASSERT_FALSE(chord.held("0B", "5", 7000U)); // A, B and D
  TEST_ASSERT_TRUE(chord.held("09", "5", 7000U));  // A + D for five seconds
  TEST_ASSERT_FALSE(chord.held("09", "5", 9000U)); // once
  bridgelogic::SetupChord late;
  late.begin(1000U);
  // The hold began at 61 s + 1 s after boot: outside the window.
  TEST_ASSERT_FALSE(late.held("09", "5", 1000U + 67000U));
  bridgelogic::SetupChord edge;
  edge.begin(1000U);
  TEST_ASSERT_TRUE(edge.held("09", "6", 1000U + 66000U)); // began at exactly 60 s
}

// --- the lifeline settings, the stall watchdog -------------------------------------

void test_the_lifeline_settings_are_read_from_config_by_exact_kind_and_clamped() {
  bridgelogic::LifelineSettings s;
  bridgelogic::Drift drift;
  const char body[] = "{\"device_power_restore_trust_minutes\":99,\"config\":{\"device_power_restore_"
                      "trust_minutes\":500,\"device_net_fallback_minutes\":1,\"device_ota_probation_"
                      "minutes\":12.5,\"relay_reconcile_min_seconds\":90}}";
  bridgelogic::readLifelineSettings(body, strlen(body), s, &drift);
  TEST_ASSERT_EQUAL_UINT32(120U, s.trustMinutes);  // clamped; the top-level decoy ignored
  TEST_ASSERT_EQUAL_UINT32(3U, s.fallbackMinutes); // clamped up
  TEST_ASSERT_EQUAL_UINT32(10U, s.probationMinutes);
  TEST_ASSERT_EQUAL_UINT32(90U, s.reconcileMinSeconds);
  TEST_ASSERT_EQUAL_UINT8(1U, drift.count);
  TEST_ASSERT_EQUAL_STRING("config.device_ota_probation_minutes", drift.names[0]);
  // The corpus snapshot body carries all four at their defaults.
  const std::string snap = httpBody("v3-heartbeat-response-snapshot");
  bridgelogic::LifelineSettings c;
  c.trustMinutes = 1U;
  bridgelogic::readLifelineSettings(snap.data(), snap.size(), c, nullptr);
  TEST_ASSERT_EQUAL_UINT32(20U, c.trustMinutes);
  TEST_ASSERT_EQUAL_UINT32(10U, c.fallbackMinutes);
  TEST_ASSERT_EQUAL_UINT32(10U, c.probationMinutes);
}

void test_the_stall_watchdog_fires_after_six_hours_up_with_nothing_accepted() {
  bridgelogic::StallWatch w;
  w.begin(0U);
  TEST_ASSERT_FALSE(w.stalled(5UL * 3600000UL, true));
  w.reset(5UL * 3600000UL); // an accepted beat
  TEST_ASSERT_FALSE(w.stalled(10UL * 3600000UL, true));
  TEST_ASSERT_TRUE(w.stalled(11UL * 3600000UL, true));
  // A link that went DOWN is the supervisor's; the stall clock restarts.
  TEST_ASSERT_FALSE(w.stalled(11UL * 3600000UL + 1U, false));
  TEST_ASSERT_FALSE(w.stalled(16UL * 3600000UL, true));
  TEST_ASSERT_TRUE(w.stalled(17UL * 3600000UL + 2U, true));
}

// --- signed OTA (§7) -----------------------------------------------------------------

struct OtaRig {
  FakeFiles files;
  FakeFlash flash;
  FakeDownload download;
  CountingHooks hooks;
  BridgeImage image;
  uint8_t modulus[dc::kRsa2048Bytes];

  OtaRig() {
    image = bridgeImage();
    modulusOf("public_key", modulus);
    flash.running = oldImage();
    download.body = image.bytes;
  }

  /// One boot's worth: begin, offer, verify, run.
  bool updateFrom(const char* running) {
    bridgelogic::BridgeOta ota;
    ota.begin(&files, running);
    ota.offer(image.offer.data(), image.offer.size(), 1000U);
    if (ota.verifyDue()) {
      ota.verifyOffer(modulus, g_work);
    }
    if (!ota.ready()) {
      return false;
    }
    return ota.run(download, flash, modulus, g_work, g_buffer, sizeof(g_buffer), hooks, 2000U);
  }
};

void test_ota_a_good_image_is_backed_up_staged_verified_switched_and_committed() {
  OtaRig rig;
  const std::vector<uint8_t> before = rig.flash.running;
  TEST_ASSERT_TRUE(rig.updateFrom("3.0.0"));
  TEST_ASSERT_EQUAL_STRING("/api/v1/device/firmware/r1b2c3d4", rig.download.lastPath.c_str());
  TEST_ASSERT_TRUE(rig.flash.armed);
  // The running image is in LittleFS, byte for byte, before anything was staged.
  const std::string& prev = rig.files.files[bridgelogic::kFilePrevImage];
  TEST_ASSERT_EQUAL_size_t(before.size(), prev.size());
  TEST_ASSERT_EQUAL_MEMORY(before.data(), prev.data(), before.size());
  TEST_ASSERT_TRUE(rig.hooks.calls > 0U);

  rig.flash.reboot(); // eboot copies it in
  bridgelogic::BridgeOta boot;
  TEST_ASSERT_EQUAL(bridgelogic::BridgeOta::Boot::Normal, boot.begin(&rig.files, "3.0.1"));
  TEST_ASSERT_EQUAL_STRING("probation", bridgelogic::fwStateName(boot.state()));
  boot.heartbeatAccepted(false); // the Mega not heard: not proven
  TEST_ASSERT_TRUE(boot.inProbation());
  boot.heartbeatAccepted(true);
  TEST_ASSERT_EQUAL_STRING("committed", bridgelogic::fwStateName(boot.state()));
  bridgelogic::BridgeOta again;
  again.begin(&rig.files, "3.0.1");
  TEST_ASSERT_EQUAL_STRING("committed", bridgelogic::fwStateName(again.state()));
  // The same offer to the new image: not newer, nothing fetched.
  again.offer(rig.image.offer.data(), rig.image.offer.size(), 5000U);
  TEST_ASSERT_FALSE(again.verifyDue());
}

void test_ota_an_image_nobody_signed_is_never_fetched() {
  OtaRig rig;
  modulusOf("other_public_key", rig.modulus); // the board trusts another key
  TEST_ASSERT_FALSE(rig.updateFrom("3.0.0"));
  TEST_ASSERT_EQUAL_UINT32(0U, rig.download.calls);
  TEST_ASSERT_FALSE(rig.flash.armed);
  bridgelogic::BridgeOta boot;
  boot.begin(&rig.files, "3.0.0");
  TEST_ASSERT_EQUAL_STRING("failed", bridgelogic::fwStateName(boot.state()));
  TEST_ASSERT_EQUAL_STRING("sig", boot.error());
  TEST_ASSERT_EQUAL_STRING("3.0.1", boot.failedVersion());
  TEST_ASSERT_TRUE(boot.record().failed.contains("3.0.1"));
}

void test_ota_a_tampered_or_short_image_is_refused_and_the_running_one_kept() {
  {
    OtaRig rig;
    rig.download.body[700] ^= 0x01U; // one byte on the wire
    TEST_ASSERT_FALSE(rig.updateFrom("3.0.0"));
    TEST_ASSERT_FALSE(rig.flash.armed);
    bridgelogic::BridgeOta boot;
    boot.begin(&rig.files, "3.0.0");
    TEST_ASSERT_EQUAL_STRING("sha256", boot.error());
    TEST_ASSERT_TRUE(boot.record().failed.contains("3.0.1")); // never again
  }
  {
    OtaRig rig;
    rig.flash.corruptStagedAt = 1000; // the bytes in FLASH are not what arrived
    TEST_ASSERT_FALSE(rig.updateFrom("3.0.0"));
    TEST_ASSERT_FALSE(rig.flash.armed);
  }
  {
    OtaRig rig;
    rig.download.cutAt = 900U; // cut in transit: retried later, not failed for good
    TEST_ASSERT_FALSE(rig.updateFrom("3.0.0"));
    bridgelogic::BridgeOta boot;
    boot.begin(&rig.files, "3.0.0");
    TEST_ASSERT_EQUAL_STRING("http", boot.error());
    TEST_ASSERT_FALSE(boot.record().failed.contains("3.0.1"));
  }
  {
    OtaRig rig;
    rig.flash.cap = 1000U; // no room to stage it
    TEST_ASSERT_FALSE(rig.updateFrom("3.0.0"));
    bridgelogic::BridgeOta boot;
    boot.begin(&rig.files, "3.0.0");
    TEST_ASSERT_EQUAL_STRING("space", boot.error());
    TEST_ASSERT_EQUAL_UINT32(0U, rig.download.calls);
  }
  {
    OtaRig rig;
    rig.files.failAfter = 100U; // LittleFS full: no way back, so nothing is fetched
    TEST_ASSERT_FALSE(rig.updateFrom("3.0.0"));
    TEST_ASSERT_EQUAL_UINT32(0U, rig.download.calls);
  }
}

void test_ota_an_older_or_foreign_offer_is_refused_before_anything() {
  OtaRig rig;
  TEST_ASSERT_FALSE(rig.updateFrom("3.0.1")); // equal
  TEST_ASSERT_FALSE(rig.updateFrom("3.1.0")); // older
  TEST_ASSERT_EQUAL_UINT32(0U, rig.download.calls);
  std::string gate = rig.image.offer;
  const size_t at = gate.find("court_bridge");
  gate.replace(at, strlen("court_bridge"), "door_gate");
  bridgelogic::BridgeOta ota;
  ota.begin(&rig.files, "3.0.0");
  ota.offer(gate.data(), gate.size(), 1000U);
  TEST_ASSERT_FALSE(ota.verifyDue());
  TEST_ASSERT_EQUAL_STRING("target", ota.error());
  const char absolute[] = "{\"target\":\"court_bridge\",\"version\":\"9.9.9\",\"size\":10,\"sha256\":\"x\","
                          "\"sig\":\"y\",\"path\":\"http://evil/firmware\"}";
  ota.offer(absolute, strlen(absolute), 1000U);
  TEST_ASSERT_FALSE(ota.verifyDue());
}

void test_ota_probation_rolls_back_on_the_fourth_boot_and_never_retakes_the_version() {
  OtaRig rig;
  const std::vector<uint8_t> old = rig.flash.running;
  TEST_ASSERT_TRUE(rig.updateFrom("3.0.0"));
  rig.flash.reboot();
  // Three boots that never reach an accepted beat (crash, crash, crash) ...
  for (int i = 0; i < 3; ++i) {
    bridgelogic::BridgeOta boot;
    TEST_ASSERT_EQUAL(bridgelogic::BridgeOta::Boot::Normal, boot.begin(&rig.files, "3.0.1"));
  }
  // ... and the fourth rolls back from LittleFS, verified.
  bridgelogic::BridgeOta fourth;
  TEST_ASSERT_EQUAL(bridgelogic::BridgeOta::Boot::RollBack, fourth.begin(&rig.files, "3.0.1"));
  TEST_ASSERT_TRUE(fourth.rollBack(rig.flash, g_buffer, sizeof(g_buffer), rig.hooks, "probation"));
  rig.flash.reboot();
  TEST_ASSERT_EQUAL_size_t(old.size(), rig.flash.running.size());
  TEST_ASSERT_EQUAL_MEMORY(old.data(), rig.flash.running.data(), old.size());
  bridgelogic::BridgeOta back;
  TEST_ASSERT_EQUAL(bridgelogic::BridgeOta::Boot::Normal, back.begin(&rig.files, "3.0.0"));
  TEST_ASSERT_EQUAL_STRING("rolled_back", bridgelogic::fwStateName(back.state()));
  TEST_ASSERT_EQUAL_STRING("3.0.1", back.failedVersion());
  TEST_ASSERT_EQUAL_STRING("probation", back.error());
  back.offer(rig.image.offer.data(), rig.image.offer.size(), 1000U);
  TEST_ASSERT_FALSE(back.verifyDue()); // never that version again
}

void test_ota_probation_rolls_back_when_the_window_passes() {
  OtaRig rig;
  TEST_ASSERT_TRUE(rig.updateFrom("3.0.0"));
  rig.flash.reboot();
  bridgelogic::BridgeOta boot;
  boot.begin(&rig.files, "3.0.1");
  TEST_ASSERT_FALSE(boot.tick(0U, 10U));
  TEST_ASSERT_FALSE(boot.tick(9UL * 60000UL, 10U));
  TEST_ASSERT_TRUE(boot.tick(10UL * 60000UL, 10U));
  // A damaged copy of the old image is never flashed back: the new image,
  // which boots, is kept and reported.
  rig.files.files[bridgelogic::kFilePrevImage][10] ^= 0x01;
  TEST_ASSERT_FALSE(boot.rollBack(rig.flash, g_buffer, sizeof(g_buffer), rig.hooks, "probation"));
  TEST_ASSERT_FALSE(rig.flash.armed);
  TEST_ASSERT_EQUAL_STRING("failed", bridgelogic::fwStateName(boot.state()));
  TEST_ASSERT_EQUAL_STRING("flash", boot.error());
}

// --- persistence (§4) ------------------------------------------------------------------

void test_the_last_answer_is_written_at_most_once_a_minute_and_at_once_when_a_court_lights() {
  FakeFiles files;
  bridgelogic::BodyStore store;
  store.begin(&files);
  const std::string body = httpBody("v3-heartbeat-response-snapshot");
  bridgelogic::Snapshot snap;
  TEST_ASSERT_EQUAL(bridgelogic::ReadResult::Adopted,
                    bridgelogic::readSnapshot(body.data(), body.size(), snap, 0U));
  store.accepted(snap, 5000U, 0U);
  TEST_ASSERT_TRUE(store.flush(body.data(), body.size(), 0U));
  store.accepted(snap, 35000U, 30000U); // same courts lit, 30 s on
  TEST_ASSERT_FALSE(store.due());
  store.accepted(snap, 65000U, 60000U);
  TEST_ASSERT_TRUE(store.due());
  TEST_ASSERT_TRUE(store.flush(body.data(), body.size(), 60000U));
  snap.courts[1].lit = true; // relay 1 lit since
  snap.courts[1].seconds = 600U;
  memcpy(snap.courts[1].ref, "0badc0de", 9U);
  store.accepted(snap, 66000U, 61000U);
  TEST_ASSERT_TRUE(store.due());
  TEST_ASSERT_TRUE(store.flush(body.data(), body.size(), 61000U));

  static char back[bridgelogic::kHeartbeatResponseCap];
  bridgelogic::BodyMeta meta;
  bridgelogic::BodyStore reboot;
  reboot.begin(&files);
  TEST_ASSERT_EQUAL_size_t(body.size(), reboot.load(back, sizeof(back), meta));
  TEST_ASSERT_EQUAL_MEMORY(body.data(), back, body.size());
  TEST_ASSERT_EQUAL_UINT64(66000U, meta.epochMs);
  files.files[bridgelogic::kFileBody][40] ^= 0x10;
  TEST_ASSERT_EQUAL_size_t(0U, reboot.load(back, sizeof(back), meta));
}

/// FSF-09 / BR-06: a power cut with the server down. The box boots cold with
/// the last answer in flash: every court it owed is lit PROVISIONALLY for at
/// most the trust window, the court map and settings come back, and the first
/// accepted snapshot switches off what it no longer lists.
void test_a_power_cut_with_the_server_down_restores_paid_courts_for_the_trust_window_only() {
  const std::string body = httpBody("v3-heartbeat-response-snapshot");
  bridgelogic::LifelineSettings life;
  bridgelogic::readLifelineSettings(body.data(), body.size(), life, nullptr);
  TEST_ASSERT_EQUAL(bridgelogic::RestoreKind::Cold,
                    bridgelogic::classifyRestore(false, true, life.trustMinutes));
  TEST_ASSERT_EQUAL(bridgelogic::RestoreKind::Warm, bridgelogic::classifyRestore(true, true, 0U));
  TEST_ASSERT_EQUAL(bridgelogic::RestoreKind::None, bridgelogic::classifyRestore(false, true, 0U));
  TEST_ASSERT_EQUAL(bridgelogic::RestoreKind::None, bridgelogic::classifyRestore(true, false, 20U));

  bridgelogic::Snapshot snap;
  TEST_ASSERT_EQUAL(bridgelogic::ReadResult::Adopted,
                    bridgelogic::readSnapshot(body.data(), body.size(), snap, 100U));
  // The vector: relay 0 lit 2700 s, relay 2 lit 7140 s (an extension).
  const uint8_t provisional = bridgelogic::capColdSnapshot(snap, life.trustMinutes);
  TEST_ASSERT_EQUAL_HEX8(0x05U, provisional);
  TEST_ASSERT_EQUAL_UINT32(1200U, snap.courts[0].seconds);
  TEST_ASSERT_EQUAL_UINT32(1200U, snap.courts[2].seconds);

  // The reconcile asks the Mega for exactly that, and nothing for dark courts.
  bridgelogic::Reconciler reconciler;
  bridgelogic::RelayView view[bridgelogic::kSnapshotRelays];
  bridgelogic::ReconcileSettings set;
  int32_t want[bridgelogic::kSnapshotRelays];
  TEST_ASSERT_TRUE(reconciler.plan(snap, view, set, 100U, true, want));
  TEST_ASSERT_EQUAL_INT32(1200, want[0]);
  TEST_ASSERT_EQUAL_INT32(-1, want[1]);
  TEST_ASSERT_EQUAL_INT32(1200, want[2]);
  TEST_ASSERT_EQUAL_INT32(-1, want[3]);

  // The first accepted snapshot: court 0 still lit (confirmed), court 2 over.
  bridgelogic::Snapshot live = snap;
  live.courts[2].lit = false;
  live.courts[2].seconds = 0U;
  TEST_ASSERT_EQUAL_HEX8(0x04U, bridgelogic::provisionalToRelease(provisional, live));
  bridgelogic::Snapshot none;
  TEST_ASSERT_EQUAL_HEX8(0x00U, bridgelogic::provisionalToRelease(provisional, none));
}

/// BR-07: every undelivered event survives the cut and is uploaded first, one
/// per call, under the boot it was queued in.
void test_queued_attendance_survives_a_power_cut_under_its_own_boot() {
  FakeFiles files;
  eventq::EventQueue<8U> queue;
  queue.begin();
  for (uint8_t i = 0U; i < 3U; ++i) {
    eventq::Event e;
    e.kind = i == 1U ? eventq::Kind::Fault : eventq::Kind::Activation;
    e.court = i;
    e.uptimeMs = 1000U * i;
    TEST_ASSERT_TRUE(queue.push(e) != eventq::PushResult::Rejected);
  }
  TEST_ASSERT_TRUE(bridgelogic::writeLiveEvents(files, queue, 0xB007A1U, 9000U));

  // The cut. The next boot carries them.
  bridgelogic::CarriedEvents carried;
  carried.begin(&files);
  TEST_ASSERT_EQUAL_UINT16(3U, carried.size());
  TEST_ASSERT_EQUAL_UINT32(0U, files.size(bridgelogic::kFileEvents));
  TEST_ASSERT_EQUAL_UINT32(0xB007A1U, carried.headBootId());
  TEST_ASSERT_EQUAL_UINT64(9000U, carried.headUptimeMs());
  eventq::Event head;
  TEST_ASSERT_TRUE(carried.peek(head));
  TEST_ASSERT_EQUAL_UINT32(1U, head.seq);
  TEST_ASSERT_EQUAL_UINT16(0U, carried.releaseThrough(0U));
  TEST_ASSERT_EQUAL_UINT16(1U, carried.releaseThrough(1U));
  TEST_ASSERT_EQUAL_UINT16(2U, carried.size());

  // Another cut before they were all delivered: nothing new, so the carried
  // list is read again from the start (a re-upload is the server's no-op).
  bridgelogic::CarriedEvents again;
  again.begin(&files);
  TEST_ASSERT_EQUAL_UINT16(3U, again.size());
  while (!again.empty()) {
    TEST_ASSERT_TRUE(again.release());
  }
  TEST_ASSERT_EQUAL_UINT32(0U, files.size(bridgelogic::kFileCarried));

  // A damaged entry costs that one entry only.
  TEST_ASSERT_TRUE(bridgelogic::writeLiveEvents(files, queue, 7U, 100U));
  files.files[bridgelogic::kFileEvents][sizeof(bridgelogic::StoredEvent) + 20U] ^= 0x01;
  bridgelogic::CarriedEvents torn;
  torn.begin(&files);
  TEST_ASSERT_EQUAL_UINT16(2U, torn.size());
}

void test_past_the_carried_cap_faults_are_shed_before_attendance() {
  FakeFiles files;
  // A carried list already at the cap: 64 activations ...
  eventq::EventQueue<64U> full;
  full.begin();
  for (uint8_t i = 0U; i < 64U; ++i) {
    eventq::Event e;
    e.kind = (i % 4U == 0U) ? eventq::Kind::Fault : eventq::Kind::Activation;
    TEST_ASSERT_TRUE(full.push(e) != eventq::PushResult::Rejected);
  }
  TEST_ASSERT_TRUE(bridgelogic::writeLiveEvents(files, full, 1U, 1U));
  bridgelogic::CarriedEvents first;
  first.begin(&files);
  TEST_ASSERT_EQUAL_UINT16(64U, first.size());
  // ... and ten more activations from the next boot.
  eventq::EventQueue<16U> next;
  next.begin();
  for (uint8_t i = 0U; i < 10U; ++i) {
    eventq::Event e;
    e.kind = eventq::Kind::Activation;
    TEST_ASSERT_TRUE(next.push(e) != eventq::PushResult::Rejected);
  }
  TEST_ASSERT_TRUE(bridgelogic::writeLiveEvents(files, next, 2U, 1U));
  bridgelogic::CarriedEvents merged;
  merged.begin(&files);
  TEST_ASSERT_EQUAL_UINT16(64U, merged.size());
  uint16_t faults = 0U;
  uint16_t fromSecond = 0U;
  while (!merged.empty()) {
    eventq::Event e;
    TEST_ASSERT_TRUE(merged.peek(e));
    faults = static_cast<uint16_t>(faults + (e.kind == eventq::Kind::Fault ? 1U : 0U));
    fromSecond = static_cast<uint16_t>(fromSecond + (merged.headBootId() == 2U ? 1U : 0U));
    TEST_ASSERT_TRUE(merged.release());
  }
  TEST_ASSERT_EQUAL_UINT16(6U, faults);      // 16 faults, 10 shed
  TEST_ASSERT_EQUAL_UINT16(10U, fromSecond); // every new activation kept
}

} // namespace

void setUp(void) {
}

void tearDown(void) {
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_a_sealed_record_reads_back_and_a_damaged_one_reads_as_absent);
  RUN_TEST(test_key_next_is_persisted_before_use_and_survives_a_reset);
  RUN_TEST(test_a_key_that_cannot_be_persisted_is_not_used);
  RUN_TEST(test_a_portal_key_becomes_current_and_keeps_the_previous);
  RUN_TEST(test_a_server_net_is_adopted_whole_and_the_previous_set_is_the_fallback);
  RUN_TEST(test_one_bad_field_adopts_nothing);
  RUN_TEST(test_a_new_base_that_never_answers_is_abandoned_and_never_readopted);
  RUN_TEST(test_the_setup_portal_saves_a_local_set_by_the_server_rules);
  RUN_TEST(test_the_setup_chord_opens_the_portal_only_inside_the_window);
  RUN_TEST(test_the_lifeline_settings_are_read_from_config_by_exact_kind_and_clamped);
  RUN_TEST(test_the_stall_watchdog_fires_after_six_hours_up_with_nothing_accepted);
  RUN_TEST(test_ota_a_good_image_is_backed_up_staged_verified_switched_and_committed);
  RUN_TEST(test_ota_an_image_nobody_signed_is_never_fetched);
  RUN_TEST(test_ota_a_tampered_or_short_image_is_refused_and_the_running_one_kept);
  RUN_TEST(test_ota_an_older_or_foreign_offer_is_refused_before_anything);
  RUN_TEST(test_ota_probation_rolls_back_on_the_fourth_boot_and_never_retakes_the_version);
  RUN_TEST(test_ota_probation_rolls_back_when_the_window_passes);
  RUN_TEST(test_the_last_answer_is_written_at_most_once_a_minute_and_at_once_when_a_court_lights);
  RUN_TEST(test_a_power_cut_with_the_server_down_restores_paid_courts_for_the_trust_window_only);
  RUN_TEST(test_queued_attendance_survives_a_power_cut_under_its_own_boot);
  RUN_TEST(test_past_the_carried_cap_faults_are_shed_before_attendance);
  return UNITY_END();
}

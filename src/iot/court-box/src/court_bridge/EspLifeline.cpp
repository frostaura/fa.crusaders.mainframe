#include "EspLifeline.h"

#ifdef TARGET_COURT_BRIDGE

#include <Arduino.h>
#include <ESP8266HTTPClient.h>
#include <ESP8266WebServer.h>
#include <ESP8266WiFi.h>

#include <LittleFS.h>
#include <Updater.h>
#include <stdio.h>
#include <string.h>

#include "devcrypto/Sha256.h"

namespace arduino_hal {

namespace {

constexpr size_t kPathCap = 40U;

bool tmpPath(const char* path, char* out, size_t cap) {
  const int n = snprintf(out, cap, "%s.tmp", path);
  return n > 0 && static_cast<size_t>(n) < cap;
}

/// Replaces `path` with `tmp`: LittleFS's rename replaces an existing file
/// atomically; a core that refuses is given the remove first.
bool commitTmp(const char* tmp, const char* path) {
  if (LittleFS.rename(tmp, path)) {
    return true;
  }
  LittleFS.remove(path);
  return LittleFS.rename(tmp, path);
}

File gStream;
char gStreamPath[kPathCap] = {};
char gStreamTmp[kPathCap] = {};

} // namespace

void LittleFsFiles::prepare() {
  LittleFS.mkdir("/st");
  LittleFS.mkdir("/ota");
}

bool LittleFsFiles::write(const char* path, const bridgelogic::Part* parts, uint8_t count) {
  char tmp[kPathCap];
  if (!tmpPath(path, tmp, sizeof(tmp))) {
    return false;
  }
  File f = LittleFS.open(tmp, "w");
  if (!f) {
    return false;
  }
  bool ok = true;
  for (uint8_t i = 0U; i < count && ok; ++i) {
    ok = parts[i].len == 0U ||
         f.write(static_cast<const uint8_t*>(parts[i].data), parts[i].len) == parts[i].len;
  }
  f.close();
  if (!ok) {
    LittleFS.remove(tmp);
    return false;
  }
  return commitTmp(tmp, path);
}

size_t LittleFsFiles::read(const char* path, uint32_t offset, void* out, size_t cap) {
  File f = LittleFS.open(path, "r");
  if (!f) {
    return 0U;
  }
  size_t n = 0U;
  if (offset < f.size() && f.seek(offset, SeekSet)) {
    n = f.read(static_cast<uint8_t*>(out), cap);
  }
  f.close();
  return n;
}

uint32_t LittleFsFiles::size(const char* path) {
  File f = LittleFS.open(path, "r");
  if (!f) {
    return 0U;
  }
  const uint32_t n = static_cast<uint32_t>(f.size());
  f.close();
  return n;
}

void LittleFsFiles::remove(const char* path) {
  LittleFS.remove(path);
}

bool LittleFsFiles::begin(const char* path) {
  if (gStream || !tmpPath(path, gStreamTmp, sizeof(gStreamTmp))) {
    return false;
  }
  snprintf(gStreamPath, sizeof(gStreamPath), "%s", path);
  gStream = LittleFS.open(gStreamTmp, "w");
  return static_cast<bool>(gStream);
}

bool LittleFsFiles::append(const void* data, size_t len) {
  return gStream && gStream.write(static_cast<const uint8_t*>(data), len) == len;
}

bool LittleFsFiles::end(bool keep) {
  if (!gStream) {
    return false;
  }
  gStream.close();
  if (!keep) {
    LittleFS.remove(gStreamTmp);
    return true;
  }
  return commitTmp(gStreamTmp, gStreamPath);
}

// --- the OTA staging area -----------------------------------------------------------

namespace {

/// SHA-256 for the Updater's read-back pass.
class Sha256Hash final : public UpdaterHashClass {
public:
  void begin() override { hash_.reset(); }

  void add(const void* data, uint32_t len) override { hash_.update(static_cast<const uint8_t*>(data), len); }

  void end() override { hash_.finish(digest_); }

  int len() override { return 32; }

  const void* hash() override { return digest_; }

  const unsigned char* oid() override { return nullptr; }

private:
  dc::Sha256 hash_;
  uint8_t digest_[32] = {};
};

/// No signature in the image (length 0): the decision is ours, over the
/// read-back digest.
class StagedVerify final : public UpdaterVerifyClass {
public:
  StagedVerify(bridgelogic::IStagedCheck& check, uint32_t size) : check_(check), size_(size) {}

  uint32_t length() override { return 0U; }

  bool verify(UpdaterHashClass* hash, const void*, uint32_t) override {
    return hash != nullptr && check_.accept(static_cast<const uint8_t*>(hash->hash()), size_);
  }

private:
  bridgelogic::IStagedCheck& check_;
  uint32_t size_;
};

uint32_t gStagedSize = 0U;

} // namespace

uint32_t EspImageFlash::runningSize() {
  return ESP.getSketchSize();
}

bool EspImageFlash::readRunning(uint32_t offset, uint8_t* out, size_t len) {
  // The running image starts at flash address 0 (eboot copies it there).
  return ESP.flashRead(offset, reinterpret_cast<uint32_t*>(out), len);
}

uint32_t EspImageFlash::capacity() {
  return ESP.getFreeSketchSpace();
}

bool EspImageFlash::begin(uint32_t size) {
  gStagedSize = size;
  return Update.begin(size, U_FLASH);
}

bool EspImageFlash::write(const uint8_t* data, size_t len) {
  return Update.write(const_cast<uint8_t*>(data), len) == len;
}

bool EspImageFlash::commit(bridgelogic::IStagedCheck& check) {
  Sha256Hash hash;
  StagedVerify verify(check, gStagedSize);
  Update.installSignature(&hash, &verify);
  const bool ok = Update.end(false);
  Update.installSignature(nullptr, nullptr);
  return ok;
}

void EspImageFlash::abort() {
  // Not finished: end() resets without arming anything.
  Update.installSignature(nullptr, nullptr);
  static_cast<void>(Update.end(false));
}

// --- the download ----------------------------------------------------------------------

uint16_t EspDownload::get(const char* path, uint32_t expectBytes, bridgelogic::IChunkSink& sink) {
  char url[devnet::kBaseUrlMax + devota::kPathCap + 2U];
  const int n = snprintf(url, sizeof(url), "%s%s", baseUrl_(), path);
  if (n <= 0 || static_cast<size_t>(n) >= sizeof(url)) {
    return 0U;
  }
  WiFiClient client;
  HTTPClient http;
  if (!http.begin(client, url)) {
    return 0U;
  }
  http.useHTTP10(true);
  http.setReuse(false);
  http.setTimeout(4000U);
  http.addHeader("Authorization", authHeader_());
  const int status = http.GET();
  if (status != 200) {
    http.end();
    return status > 0 ? static_cast<uint16_t>(status) : 0U;
  }
  if (http.getSize() != static_cast<int>(expectBytes)) {
    // A length that disagrees with the signed size: nothing is read.
    http.end();
    return 0U;
  }
  WiFiClient* stream = http.getStreamPtr();
  uint32_t left = expectBytes;
  uint32_t quietSince = millis();
  while (left > 0U && stream != nullptr && (stream->connected() || stream->available() > 0)) {
    const size_t avail = static_cast<size_t>(stream->available());
    if (avail == 0U) {
      if (!sink.chunk(nullptr, 0U) || millis() - quietSince > 10000UL) {
        break;
      }
      delay(1);
      continue;
    }
    const size_t want = avail < cap_ ? avail : cap_;
    const size_t take = want < left ? want : left;
    const int got = stream->read(buffer_, take);
    if (got <= 0) {
      continue;
    }
    quietSince = millis();
    if (!sink.chunk(buffer_, static_cast<size_t>(got))) {
      break;
    }
    left -= static_cast<uint32_t>(got);
  }
  http.end();
  return 200U;
}

// --- the warm epoch ----------------------------------------------------------------------

namespace {

/// Above eboot's command words (user words 64..95): the last four of 128.
constexpr uint32_t kRtcWord = 124U;
constexpr uint32_t kEpochMagic = 0x45504F43UL; // "EPOC"

struct RtcEpochImage {
  uint32_t magic;
  uint32_t lo;
  uint32_t hi;
  uint32_t check;
};

uint32_t checkOf(const RtcEpochImage& i) {
  return i.magic ^ i.lo ^ (i.hi * 2654435761UL) ^ 0xA5A5A5A5UL;
}

} // namespace

bool RtcEpoch::begin(bool powerOn, uint32_t nowMs) {
  bootMs_ = nowMs;
  base_ = 0U;
  RtcEpochImage image = {};
  if (!powerOn && ESP.rtcUserMemoryRead(kRtcWord, reinterpret_cast<uint32_t*>(&image), sizeof(image)) &&
      image.magic == kEpochMagic && image.check == checkOf(image)) {
    // Carried: plus the boot itself, which the last write could not see.
    base_ = ((static_cast<uint64_t>(image.hi) << 32) | image.lo) + 1000U;
    return true;
  }
  return false;
}

uint64_t RtcEpoch::tick(uint32_t nowMs) {
  const uint64_t epoch = now(nowMs);
  if (!written_ || nowMs - writtenAtMs_ >= 1000UL) {
    RtcEpochImage image = {kEpochMagic, static_cast<uint32_t>(epoch), static_cast<uint32_t>(epoch >> 32), 0U};
    image.check = checkOf(image);
    static_cast<void>(ESP.rtcUserMemoryWrite(kRtcWord, reinterpret_cast<uint32_t*>(&image), sizeof(image)));
    written_ = true;
    writtenAtMs_ = nowMs;
  }
  return epoch;
}

// --- the setup portal ------------------------------------------------------------------------

namespace {

ESP8266WebServer* gServer = nullptr;
SetupPortal::Save gSave = nullptr;
char* gScratch = nullptr;
size_t gScratchCap = 0U;
bool gSaved = false;

const char kPage[] PROGMEM =
    "<!doctype html><meta name=viewport content='width=device-width'><title>Court box setup</title>"
    "<h1>Court box setup</h1><form method=post action=/save>"
    "<p>WiFi name<br><input name=ssid maxlength=32 required>"
    "<p>WiFi password<br><input name=psk type=password maxlength=63>"
    "<p>Second WiFi name (optional)<br><input name=ssid2 maxlength=32>"
    "<p>Second WiFi password<br><input name=psk2 type=password maxlength=63>"
    "<p>Server address<br><input name=base maxlength=96 placeholder='http://192.168.1.10:8088' required>"
    "<p>Device key id and key (optional)<br><input name=key_id maxlength=7 placeholder=k2>"
    "<input name=key maxlength=43>"
    "<p><button>Save and restart</button></form>";

void sendPage(int status, const char* note) {
  String body = FPSTR(kPage);
  if (note != nullptr) {
    body += "<p><b>";
    body += note;
    body += "</b>";
  }
  gServer->send(status, "text/html", body);
}

void handleSave() {
  const String ssid = gServer->arg("ssid");
  const String psk = gServer->arg("psk");
  const String ssid2 = gServer->arg("ssid2");
  const String psk2 = gServer->arg("psk2");
  const String base = gServer->arg("base");
  const String keyId = gServer->arg("key_id");
  const String key = gServer->arg("key");
  bridgelogic::PortalForm form;
  form.ssid = ssid.c_str();
  form.psk = psk.c_str();
  form.ssid2 = ssid2.c_str();
  form.psk2 = psk2.c_str();
  form.base = base.c_str();
  devnet::NetSet net;
  const devnet::Refusal r = bridgelogic::validatePortalForm(form, net, gScratch, gScratchCap);
  if (r != devnet::Refusal::Ok) {
    char note[64];
    snprintf(note, sizeof(note), "Not saved: %s", devnet::refusalName(r));
    sendPage(400, note);
    return;
  }
  const char* id = keyId.length() > 0U ? keyId.c_str() : nullptr;
  if (gSave == nullptr || !gSave(net, id, key.c_str())) {
    sendPage(500, "Not saved: the box could not store it, or the key is not 43 characters");
    return;
  }
  sendPage(200, "Saved. The box restarts now.");
  gSaved = true;
}

} // namespace

bool SetupPortal::open(const char* apName, const char* apPassword, Save save, char* scratch,
                       size_t scratchCap) {
  if (open_) {
    return true;
  }
  gSave = save;
  gScratch = scratch;
  gScratchCap = scratchCap;
  gSaved = false;
  WiFi.mode(WIFI_AP);
  if (!WiFi.softAP(apName, apPassword)) {
    return false;
  }
  gServer = new ESP8266WebServer(80);
  gServer->on("/", HTTP_GET, []() { sendPage(200, nullptr); });
  gServer->on("/save", HTTP_POST, handleSave);
  gServer->onNotFound([]() { sendPage(200, nullptr); });
  gServer->begin();
  open_ = true;
  return true;
}

bool SetupPortal::pump() {
  if (!open_ || gServer == nullptr) {
    return false;
  }
  gServer->handleClient();
  saved_ = saved_ || gSaved;
  return saved_;
}

void SetupPortal::close() {
  if (gServer != nullptr) {
    gServer->stop();
    delete gServer;
    gServer = nullptr;
  }
  WiFi.softAPdisconnect(true);
  open_ = false;
}

} // namespace arduino_hal

#endif // TARGET_COURT_BRIDGE

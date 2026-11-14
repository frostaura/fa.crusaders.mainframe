#include "EspLifeline.h"

#ifdef TARGET_COURT_BRIDGE

#include <Arduino.h>
#include <ESP8266WiFi.h>

#include <LittleFS.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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
//
// A WiFiServer and one bounded parse, not ESP8266WebServer: that server's form
// parser has an unbounded (VLA) frame, which the stack gate refuses on a 4 KB
// continuation stack, and its templates cost RAM the heap floor does not have.
// One request at a time, read into the caller's scratch, fields decoded by
// bridgelogic::urlDecode and validated by the provision/ rules.

namespace {

WiFiServer* gServer = nullptr;
SetupPortal::Save gSave = nullptr;
char* gScratch = nullptr;
size_t gScratchCap = 0U;
bool gSaved = false;

constexpr size_t kRequestCap = 1536U;
constexpr size_t kFieldCap = 100U;
constexpr uint8_t kFields = 7U;
constexpr size_t kValidateAt = kRequestCap + kFieldCap * kFields;

const char kPageHead[] PROGMEM =
    "HTTP/1.0 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n"
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

void sendPage(WiFiClient& client, const char* note) {
  client.write_P(kPageHead, sizeof(kPageHead) - 1U);
  if (note != nullptr) {
    client.print("<p><b>");
    client.print(note);
    client.print("</b>");
  }
  client.flush();
}

/// The value of `name` in an x-www-form-urlencoded body, decoded into `out`.
bool formField(const char* body, size_t len, const char* name, char* out, size_t cap) {
  out[0] = '\0';
  const size_t nameLen = strlen(name);
  size_t at = 0U;
  while (at < len) {
    size_t end = at;
    while (end < len && body[end] != '&') {
      ++end;
    }
    if (end - at > nameLen && memcmp(body + at, name, nameLen) == 0 && body[at + nameLen] == '=') {
      const size_t from = at + nameLen + 1U;
      return bridgelogic::urlDecode(body + from, end - from, out, cap);
    }
    at = end + 1U;
  }
  return true; // absent is empty
}

/// Reads one request into the scratch: true with the body located.
bool readRequest(WiFiClient& client, size_t& bodyAt, size_t& bodyLen, bool& isPost) {
  size_t got = 0U;
  const uint32_t started = millis();
  size_t headEnd = 0U;
  long contentLength = 0;
  while (client.connected() && millis() - started < 3000UL && got + 1U < kRequestCap) {
    if (client.available() <= 0) {
      delay(1);
      continue;
    }
    gScratch[got] = static_cast<char>(client.read());
    ++got;
    gScratch[got] = '\0';
    if (headEnd == 0U && got >= 4U && memcmp(gScratch + got - 4U, "\r\n\r\n", 4U) == 0) {
      headEnd = got;
      const char* cl = strstr(gScratch, "Content-Length:");
      contentLength = cl != nullptr ? atol(cl + 15) : 0;
      if (contentLength < 0 || headEnd + static_cast<size_t>(contentLength) + 1U >= kRequestCap) {
        return false;
      }
    }
    if (headEnd > 0U && got >= headEnd + static_cast<size_t>(contentLength)) {
      break;
    }
  }
  if (headEnd == 0U) {
    return false;
  }
  isPost = strncmp(gScratch, "POST /save", 10) == 0;
  bodyAt = headEnd;
  bodyLen = got - headEnd;
  return true;
}

void handle(WiFiClient& client) {
  size_t bodyAt = 0U;
  size_t bodyLen = 0U;
  bool isPost = false;
  if (!readRequest(client, bodyAt, bodyLen, isPost)) {
    client.stop();
    return;
  }
  if (!isPost) {
    sendPage(client, nullptr);
    client.stop();
    return;
  }
  static const char* const kNames[kFields] = {"ssid", "psk", "ssid2", "psk2", "base", "key_id", "key"};
  char* field[kFields];
  bool ok = true;
  for (uint8_t i = 0U; i < kFields; ++i) {
    field[i] = gScratch + kRequestCap + kFieldCap * i;
    ok = ok && formField(gScratch + bodyAt, bodyLen, kNames[i], field[i], kFieldCap);
  }
  if (!ok) {
    sendPage(client, "Not saved: a field could not be read");
    client.stop();
    return;
  }
  bridgelogic::PortalForm form;
  form.ssid = field[0];
  form.psk = field[1];
  form.ssid2 = field[2];
  form.psk2 = field[3];
  form.base = field[4];
  devnet::NetSet net;
  const devnet::Refusal r =
      bridgelogic::validatePortalForm(form, net, gScratch + kValidateAt, gScratchCap - kValidateAt);
  if (r != devnet::Refusal::Ok) {
    char note[48];
    snprintf(note, sizeof(note), "Not saved: %s", devnet::refusalName(r));
    sendPage(client, note);
    client.stop();
    return;
  }
  const char* id = field[5][0] != '\0' ? field[5] : nullptr;
  if (gSave == nullptr || !gSave(net, id, field[6])) {
    sendPage(client, "Not saved: the box could not store it, or the key is not 43 characters");
    client.stop();
    return;
  }
  sendPage(client, "Saved. The box restarts now.");
  client.stop();
  gSaved = true;
}

} // namespace

bool SetupPortal::open(const char* apName, const char* apPassword, Save save, char* scratch,
                       size_t scratchCap) {
  if (open_) {
    return true;
  }
  if (scratch == nullptr || scratchCap < kValidateAt + 1536U) {
    return false;
  }
  gSave = save;
  gScratch = scratch;
  gScratchCap = scratchCap;
  gSaved = false;
  WiFi.mode(WIFI_AP);
  if (!WiFi.softAP(apName, apPassword)) {
    return false;
  }
  gServer = new WiFiServer(80);
  gServer->begin();
  open_ = true;
  return true;
}

bool SetupPortal::pump() {
  if (!open_ || gServer == nullptr) {
    return false;
  }
  WiFiClient client = gServer->accept();
  if (client) {
    handle(client);
  }
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

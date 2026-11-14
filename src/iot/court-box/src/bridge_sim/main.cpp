// Crusaders Mainframe — the court box BRIDGE's lifeline as a host process, for
// proving signed OTA end to end against a real backend (device-api.md §6-§8).
//
// WHAT IS REAL AND WHAT IS PLAYED
// -------------------------------
// Real: every decision — bridgelogic::BridgeOta (offer grammar, version gate,
// RSA before a byte is fetched, the copy of the running image, staging, the
// read-back verification, probation, rollback), BridgeKeys (key_next, the 401
// retry), BridgeNet (`net`), the v3 heartbeat request renderer and the
// lifeline readers — against the API over a real socket, HTTP/1.0 as the
// board speaks it.
//
// Played: the ESP8266's flash, as files in `--state DIR` (running.bin, the
// staging area, LittleFS's records), and its restart: the process exits 75 to
// ask for one, and the driver (test/e2e-device/ota_e2e.py) starts it again,
// which is when an armed staging area is copied over running.bin — eboot's
// job. A "crash" is exit 76 (`--crash-on VERSION`): an image that never
// reaches an accepted heartbeat, which is what probation exists for.
//
// The image's version is its first line: `CRUSADERS-SIM-IMAGE <version>`.

#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#include <string>

#include "bridgelogic/BridgeOta.h"
#include "bridgelogic/Lifeline.h"
#include "bridgelogic/Records.h"
#include "bridgelogic/V3Heartbeat.h"
#include "devapi/DeviceClient.h"
#include "devapi/Json.h"
#include "devcrypto/Sha256.h"
#include "devlink/Cadence.h"
#include "devnet/JsonMember.h"

namespace {

constexpr int kExitRestart = 75;
constexpr int kExitCrash = 76;

std::string gDir;

std::string pathFor(const char* path) {
  std::string flat = path;
  for (char& c : flat) {
    if (c == '/') {
      c = '_';
    }
  }
  return gDir + "/" + flat;
}

bool readFile(const std::string& path, std::string& out) {
  FILE* f = fopen(path.c_str(), "rb");
  if (f == nullptr) {
    return false;
  }
  out.clear();
  char buf[4096];
  size_t n = 0U;
  while ((n = fread(buf, 1U, sizeof(buf), f)) > 0U) {
    out.append(buf, n);
  }
  fclose(f);
  return true;
}

bool writeFile(const std::string& path, const std::string& data) {
  const std::string tmp = path + ".tmp";
  FILE* f = fopen(tmp.c_str(), "wb");
  if (f == nullptr) {
    return false;
  }
  const bool ok = fwrite(data.data(), 1U, data.size(), f) == data.size();
  fclose(f);
  return ok && rename(tmp.c_str(), path.c_str()) == 0;
}

/// bridgelogic::IFiles over a directory: the board's LittleFS.
class DirFiles final : public bridgelogic::IFiles {
public:
  bool write(const char* path, const bridgelogic::Part* parts, uint8_t count) override {
    std::string all;
    for (uint8_t i = 0U; i < count; ++i) {
      all.append(static_cast<const char*>(parts[i].data), parts[i].len);
    }
    return writeFile(pathFor(path), all);
  }

  size_t read(const char* path, uint32_t offset, void* out, size_t cap) override {
    std::string all;
    if (!readFile(pathFor(path), all) || offset >= all.size()) {
      return 0U;
    }
    const size_t n = (all.size() - offset) < cap ? (all.size() - offset) : cap;
    memcpy(out, all.data() + offset, n);
    return n;
  }

  uint32_t size(const char* path) override {
    struct stat st = {};
    return stat(pathFor(path).c_str(), &st) == 0 ? static_cast<uint32_t>(st.st_size) : 0U;
  }

  void remove(const char* path) override { unlink(pathFor(path).c_str()); }

  bool begin(const char* path) override {
    streamPath_ = pathFor(path);
    stream_.clear();
    return true;
  }

  bool append(const void* data, size_t len) override {
    stream_.append(static_cast<const char*>(data), len);
    return true;
  }

  bool end(bool keep) override { return !keep || writeFile(streamPath_, stream_); }

private:
  std::string streamPath_;
  std::string stream_;
};

/// The flash: running.bin, staged.bin, and an `armed` marker eboot honours at
/// the next start.
class SimFlash final : public bridgelogic::IImageFlash {
public:
  uint32_t runningSize() override {
    std::string img;
    return readFile(gDir + "/running.bin", img) ? static_cast<uint32_t>(img.size()) : 0U;
  }

  bool readRunning(uint32_t offset, uint8_t* out, size_t len) override {
    std::string img;
    if (offset % 4U != 0U || len % 4U != 0U || !readFile(gDir + "/running.bin", img)) {
      return false;
    }
    for (size_t i = 0U; i < len; ++i) {
      out[i] = offset + i < img.size() ? static_cast<uint8_t>(img[offset + i]) : 0xFFU;
    }
    return true;
  }

  uint32_t capacity() override { return 1044464U; }

  bool begin(uint32_t size) override {
    staged_.clear();
    size_ = size;
    return true;
  }

  bool write(const uint8_t* data, size_t len) override {
    if (staged_.size() + len > size_) {
      return false;
    }
    staged_.append(reinterpret_cast<const char*>(data), len);
    return true;
  }

  bool commit(bridgelogic::IStagedCheck& check) override {
    // Written to "flash", then READ BACK and hashed, as the core's Updater does.
    if (staged_.size() != size_ || !writeFile(gDir + "/staged.bin", staged_)) {
      return false;
    }
    std::string back;
    if (!readFile(gDir + "/staged.bin", back)) {
      return false;
    }
    uint8_t digest[32];
    dc::sha256(reinterpret_cast<const uint8_t*>(back.data()), back.size(), digest);
    if (!check.accept(digest, static_cast<uint32_t>(back.size()))) {
      unlink((gDir + "/staged.bin").c_str());
      return false;
    }
    return writeFile(gDir + "/armed", "1");
  }

  void abort() override { staged_.clear(); }

private:
  std::string staged_;
  uint32_t size_ = 0U;
};

// --- HTTP/1.0 over a socket, as the board speaks it ------------------------------

struct Url {
  std::string host;
  int port = 80;
};

bool parseBase(const char* base, Url& out) {
  const char* p = strstr(base, "://");
  if (p == nullptr) {
    return false;
  }
  p += 3;
  const char* colon = strchr(p, ':');
  out.host = colon == nullptr ? std::string(p) : std::string(p, static_cast<size_t>(colon - p));
  out.port = colon == nullptr ? 80 : atoi(colon + 1);
  return !out.host.empty();
}

int connectTo(const Url& url) {
  addrinfo hints = {};
  hints.ai_family = AF_INET;
  hints.ai_socktype = SOCK_STREAM;
  addrinfo* res = nullptr;
  char port[8];
  snprintf(port, sizeof(port), "%d", url.port);
  if (getaddrinfo(url.host.c_str(), port, &hints, &res) != 0 || res == nullptr) {
    return -1;
  }
  const int fd = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
  timeval tv = {8, 0};
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
  if (fd < 0 || connect(fd, res->ai_addr, res->ai_addrlen) != 0) {
    freeaddrinfo(res);
    if (fd >= 0) {
      close(fd);
    }
    return -1;
  }
  freeaddrinfo(res);
  return fd;
}

/// Sends `request`, returns the status and the body (or 0).
int exchange(const Url& url, const std::string& request, std::string& body, long& contentLength) {
  const int fd = connectTo(url);
  if (fd < 0) {
    return 0;
  }
  if (send(fd, request.data(), request.size(), 0) != static_cast<ssize_t>(request.size())) {
    close(fd);
    return 0;
  }
  std::string all;
  char buf[4096];
  ssize_t n = 0;
  while ((n = recv(fd, buf, sizeof(buf), 0)) > 0) {
    all.append(buf, static_cast<size_t>(n));
  }
  close(fd);
  const size_t split = all.find("\r\n\r\n");
  if (split == std::string::npos || all.compare(0, 5, "HTTP/") != 0) {
    return 0;
  }
  const int status = atoi(all.c_str() + all.find(' ') + 1);
  contentLength = -1;
  const std::string head = all.substr(0, split);
  const size_t cl = head.find("Content-Length:");
  if (cl != std::string::npos) {
    contentLength = atol(head.c_str() + cl + 15);
  }
  body = all.substr(split + 4);
  return status;
}

class Http {
public:
  explicit Http(bridgelogic::BridgeNet& net, bridgelogic::BridgeKeys& keys) : net_(net), keys_(keys) {}

  int post(const char* path, const char* json, std::string& body) {
    int status = once(path, json, body);
    if (status == 401 && keys_.switchForRetry()) {
      status = once(path, json, body);
      if (status == 401) {
        keys_.retryFailed();
      }
    }
    return status;
  }

  int get(const char* path, std::string& body, long& contentLength) {
    Url url;
    if (!parseBase(net_.baseUrl(), url)) {
      return 0;
    }
    std::string req = std::string("GET ") + path + " HTTP/1.0\r\nHost: " + url.host +
                      "\r\nAuthorization: " + keys_.header() + "\r\nConnection: close\r\n\r\n";
    return exchange(url, req, body, contentLength);
  }

private:
  int once(const char* path, const char* json, std::string& body) {
    Url url;
    if (!parseBase(net_.baseUrl(), url)) {
      return 0;
    }
    char len[16];
    snprintf(len, sizeof(len), "%zu", strlen(json));
    std::string req = std::string("POST ") + path + " HTTP/1.0\r\nHost: " + url.host +
                      "\r\nContent-Type: application/json\r\nAuthorization: " + keys_.header() +
                      "\r\nContent-Length: " + len + "\r\nConnection: close\r\n\r\n" + json;
    long cl = -1;
    return exchange(url, req, body, cl);
  }

  bridgelogic::BridgeNet& net_;
  bridgelogic::BridgeKeys& keys_;
};

/// The firmware download through the same socket, chunked into the sink as
/// TCP would hand it over.
class SimDownload final : public bridgelogic::IDownload {
public:
  explicit SimDownload(Http& http) : http_(http) {}

  uint16_t get(const char* path, uint32_t expectBytes, bridgelogic::IChunkSink& sink) override {
    std::string body;
    long cl = -1;
    const int status = http_.get(path, body, cl);
    printf("[sim] GET %s -> %d, %ld bytes declared\n", path, status, cl);
    if (status != 200) {
      return status > 0 ? static_cast<uint16_t>(status) : 0U;
    }
    if (cl != static_cast<long>(expectBytes)) {
      return 0U;
    }
    for (size_t at = 0U; at < body.size(); at += 1460U) {
      const size_t take = (body.size() - at) < 1460U ? (body.size() - at) : 1460U;
      if (!sink.chunk(reinterpret_cast<const uint8_t*>(body.data()) + at, take)) {
        break;
      }
    }
    return 200U;
  }

private:
  Http& http_;
};

struct NoHooks final : public bridgelogic::BridgeOta::Hooks {
  void during() override {}
};

std::string runningVersion() {
  std::string img;
  if (!readFile(gDir + "/running.bin", img)) {
    return "";
  }
  const char kMagic[] = "CRUSADERS-SIM-IMAGE ";
  if (img.compare(0, sizeof(kMagic) - 1U, kMagic) != 0) {
    return "";
  }
  const size_t eol = img.find('\n');
  return img.substr(sizeof(kMagic) - 1U, eol - (sizeof(kMagic) - 1U));
}

/// eboot: an armed staging area replaces the running image at boot.
void eboot() {
  struct stat st = {};
  if (stat((gDir + "/armed").c_str(), &st) != 0) {
    return;
  }
  std::string staged;
  if (readFile(gDir + "/staged.bin", staged) && writeFile(gDir + "/running.bin", staged)) {
    printf("[sim] eboot copied the staged image over the running one\n");
  }
  unlink((gDir + "/armed").c_str());
  unlink((gDir + "/staged.bin").c_str());
}

const char* arg(int argc, char** argv, const char* name, const char* fallback) {
  for (int i = 1; i + 1 < argc; ++i) {
    if (strcmp(argv[i], name) == 0) {
      return argv[i + 1];
    }
  }
  return fallback;
}

uint32_t nowMs() {
  timespec ts = {};
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<uint32_t>(ts.tv_sec * 1000ULL + ts.tv_nsec / 1000000ULL);
}

alignas(4) uint8_t gBuffer[2048];
dc::RsaWorkspace gWork;
char gResponse[bridgelogic::kHeartbeatResponseCap];
char gRequest[1536];

/// The board's lifeline state, as setup() and loop() hold it.
struct SimBox {
  DirFiles files;
  SimFlash flash;
  NoHooks hooks;
  bridgelogic::BridgeOta ota;
  bridgelogic::BridgeKeys keys;
  bridgelogic::BridgeNet net;
  bridgelogic::LifelineSettings life;
  uint8_t modulus[dc::kRsa2048Bytes] = {};
  bool haveKey = false;
};

/// Not an exit: the board keeps running.
constexpr int kKeepRunning = -1;

/// First thing, as setup() does: probation counts this boot, and the fourth
/// boot in probation rolls back.
int bootOta(SimBox& box, const std::string& version, const char* crashOn) {
  if (box.ota.begin(&box.files, version.c_str()) == bridgelogic::BridgeOta::Boot::RollBack) {
    printf("[sim] %s: fourth boot in probation, rolling back\n", version.c_str());
    if (box.ota.rollBack(box.flash, gBuffer, sizeof(gBuffer), box.hooks, "probation")) {
      printf("[sim] rollback armed\n");
      return kExitRestart;
    }
    printf("[sim] rollback impossible: %s\n", box.ota.error() == nullptr ? "-" : box.ota.error());
  }
  printf("[sim] running %s fw_state=%s\n", version.c_str(), bridgelogic::fwStateName(box.ota.state()));
  if (crashOn[0] != '\0' && version == crashOn) {
    printf("[sim] %s crashes before its first heartbeat\n", version.c_str());
    return kExitCrash;
  }
  return kKeepRunning;
}

/// The beat's request into gRequest, as fillHeartbeatV3 renders it. False when
/// it does not render.
bool renderBeat(SimBox& box, const char* mac, const std::string& version, uint64_t uptimeMs,
                devlink::HeartbeatV3& v3) {
  v3.caps = devlink::kCapCodes | devlink::kCapHb3 | devlink::kCapLcd2 | devlink::kCapOta | devlink::kCapKey |
            devlink::kCapNet;
  v3.megaVersion = "3.0.0";
  v3.fwState = bridgelogic::fwStateName(box.ota.state());
  v3.fwFailed = box.ota.failedVersion();
  v3.fwError = box.ota.error();
  v3.netReported = true;
  v3.netVer = box.net.version();
  v3.netSrc = bridgelogic::netSourceName(box.net.source());
  devlink::HeartbeatReport report;
  report.v3 = &v3;
  return devlink::renderHeartbeatBody(gRequest, sizeof(gRequest), mac, version.c_str(), uptimeMs, report) !=
         0U;
}

/// One accepted answer, through the readers court_bridge's loop() uses.
void adoptAnswer(SimBox& box, const std::string& body) {
  if (body.size() >= sizeof(gResponse)) {
    return;
  }
  memcpy(gResponse, body.data(), body.size());
  gResponse[body.size()] = '\0';
  const size_t len = body.size();
  if (!devapi::json::isCompleteObject(gResponse, len)) {
    return;
  }
  box.ota.heartbeatAccepted(true);
  box.net.heartbeatAccepted();
  bridgelogic::readLifelineSettings(gResponse, len, box.life, nullptr);
  const char* object = nullptr;
  size_t objectLen = 0U;
  if (devnet::json::topLevelObjectText(gResponse, len, "key_next", object, objectLen)) {
    printf("[sim] key_next: %s\n", devnet::refusalName(box.keys.adopt(object, objectLen)));
  }
  if (devnet::json::topLevelObjectText(gResponse, len, "net", object, objectLen)) {
    printf("[sim] net: %s\n", devnet::refusalName(box.net.adopt(object, objectLen, nowMs()).reason));
  }
  if (devnet::json::topLevelObjectText(gResponse, len, "ota", object, objectLen)) {
    box.ota.offer(object, objectLen, nowMs());
    printf("[sim] ota offer %s\n", box.ota.verifyDue() ? box.ota.pendingOffer().version : "not taken");
  }
}

/// After a beat, as loop() does: verify a pending offer, run a verified one,
/// and count probation's window.
int otaPass(SimBox& box, SimDownload& download) {
  if (box.ota.verifyDue() && box.haveKey) {
    box.ota.verifyOffer(box.modulus, gWork);
    printf("[sim] signature %s\n",
           box.ota.ready() ? "verified" : (box.ota.error() == nullptr ? "-" : box.ota.error()));
  }
  if (box.ota.ready()) {
    if (box.ota.run(download, box.flash, box.modulus, {gWork, gBuffer, sizeof(gBuffer)}, box.hooks,
                    nowMs())) {
      printf("[sim] staged, verified and armed %s; restarting\n", box.ota.record().version);
      return kExitRestart;
    }
    printf("[sim] update failed: %s\n", box.ota.error() == nullptr ? "-" : box.ota.error());
  }
  if (box.ota.tick(nowMs(), box.life.probationMinutes) &&
      box.ota.rollBack(box.flash, gBuffer, sizeof(gBuffer), box.hooks, "probation")) {
    return kExitRestart;
  }
  return kKeepRunning;
}

SimBox gBox;

} // namespace

int main(int argc, char** argv) {
  setvbuf(stdout, nullptr, _IOLBF, 0);
  gDir = arg(argc, argv, "--state", ".");
  const char* base = arg(argc, argv, "--base", "http://127.0.0.1:8088");
  const char* key = arg(argc, argv, "--key", "");
  const char* mac = arg(argc, argv, "--mac", "5ccf7f0a1b2c");
  const char* keyHex = arg(argc, argv, "--ota-key", "");
  const char* crashOn = arg(argc, argv, "--crash-on", "");
  const int beats = atoi(arg(argc, argv, "--beats", "3"));
  const int gapMs = atoi(arg(argc, argv, "--gap-ms", "300"));

  eboot();
  const std::string version = runningVersion();
  if (version.empty()) {
    fprintf(stderr, "no running image in %s\n", gDir.c_str());
    return 2;
  }
  SimBox& box = gBox;
  const int booted = bootOta(box, version, crashOn);
  if (booted != kKeepRunning) {
    return booted;
  }
  box.haveKey = devota::parseModulusHex(keyHex, box.modulus);
  box.keys.begin(key, &box.files);
  box.net.begin("SIM", "sim-password", base, &box.files);
  Http http(box.net, box.keys);
  SimDownload download(http);

  const uint32_t started = nowMs();
  for (int beat = 0; beat < beats; ++beat) {
    devlink::HeartbeatV3 v3;
    if (!renderBeat(box, mac, version, static_cast<uint64_t>(nowMs() - started), v3)) {
      fprintf(stderr, "heartbeat did not render\n");
      return 2;
    }
    std::string body;
    const int status = http.post("/api/v1/device/heartbeat", gRequest, body);
    printf("[sim] heartbeat %d fw_state=%s key=%s\n", status, v3.fwState, box.keys.activeId());
    if (status >= 200 && status < 300) {
      adoptAnswer(box, body);
    }
    const int exitCode = otaPass(box, download);
    if (exitCode != kKeepRunning) {
      return exitCode;
    }
    usleep(static_cast<useconds_t>(gapMs) * 1000U);
  }
  printf("[sim] done: running %s fw_state=%s\n", version.c_str(), bridgelogic::fwStateName(box.ota.state()));
  return 0;
}

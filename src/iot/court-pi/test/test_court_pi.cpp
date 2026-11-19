// Crusaders Mainframe — court-pi host tests (`ctest`). No board: the pin table
// rules, the compat HTTP client against a real socket, the URL and MAC
// grammars, and the Unix-socket link end to end.
//
// The court box's LOGIC is not re-tested here — it is the same courtlogic /
// bridgelogic source `pio test -e native` already proves. This proves only
// what court-pi adds.

#include <netinet/in.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include <thread>

#include "ESP8266HTTPClient.h"
#include "compat/BrainConfig.h"
#include "linux_hal/PiPins.h"
#include "linux_hal/UnixLink.h"

namespace {

int gFailures = 0;

void check(bool ok, const char* what) {
  if (!ok) {
    ++gFailures;
    fprintf(stderr, "FAIL: %s\n", what);
  }
}

void testPinTable() {
  uint8_t all[hal::kRelayChannelCount + hal::kButtonCount + 1U];
  uint8_t n = 0U;
  for (uint8_t g : linux_hal::kRelayGpio) {
    all[n++] = g;
    check(linux_hal::resetPullsDown(g), "every relay GPIO is pulled down from SoC reset");
  }
  for (uint8_t g : linux_hal::kButtonGpio) {
    all[n++] = g;
  }
  all[n++] = linux_hal::kStatusLedGpio;
  for (uint8_t i = 0U; i < n; ++i) {
    check(!linux_hal::reservedGpio(all[i]), "no pin claims I2C1, UART0, SPI0, 1-wire or the ID EEPROM");
    check(linux_hal::physicalPinOf(all[i]) != 0U, "every pin is on the 40-pin header");
    for (uint8_t j = static_cast<uint8_t>(i + 1U); j < n; ++j) {
      check(all[i] != all[j], "no GPIO is used twice");
    }
  }
  check(linux_hal::physicalPinOf(17U) == 11U && linux_hal::physicalPinOf(21U) == 40U,
        "physical pin map spot-check");
}

void testUrl() {
  char host[96];
  char path[160];
  uint16_t port = 0U;
  check(HTTPClient::parseUrl("http://192.168.1.10:8088/api/v1/device/heartbeat", host, sizeof(host), port,
                             path, sizeof(path)) &&
            strcmp(host, "192.168.1.10") == 0 && port == 8088U &&
            strcmp(path, "/api/v1/device/heartbeat") == 0,
        "host:port/path");
  check(HTTPClient::parseUrl("http://court.local/x", host, sizeof(host), port, path, sizeof(path)) &&
            port == 80U,
        "default port 80");
  check(HTTPClient::parseUrl("http://[fd00::1]:81/y", host, sizeof(host), port, path, sizeof(path)) &&
            strcmp(host, "fd00::1") == 0 && port == 81U,
        "IPv6 literal");
  check(!HTTPClient::parseUrl("https://x/y", host, sizeof(host), port, path, sizeof(path)), "https refused");
  check(!HTTPClient::parseUrl("http://x:0/y", host, sizeof(host), port, path, sizeof(path)),
        "port 0 refused");
}

void testMac() {
  uint8_t mac[6] = {};
  check(compat::parseMac("24:6F:28:aa:bb:cc", mac) && mac[0] == 0x24U && mac[5] == 0xCCU, "colon MAC");
  check(compat::parseMac("246f28aabbcc", mac) && mac[3] == 0xAAU, "bare MAC");
  check(!compat::parseMac("24:6f:28:aa:bb", mac), "short MAC refused");
  check(!compat::parseMac("24:6f:28:aa:bb:cc:dd", mac), "long MAC refused");
  check(!compat::parseMac("2:46f:28:aa:bb:cc", mac), "odd grouping refused");
}

/// One canned HTTP answer on a loopback port, for exactly one connection.
uint16_t serveOnce(const char* reply, int& listenFd) {
  listenFd = socket(AF_INET, SOCK_STREAM, 0);
  sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  bind(listenFd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr));
  socklen_t len = sizeof(addr);
  getsockname(listenFd, reinterpret_cast<sockaddr*>(&addr), &len);
  listen(listenFd, 1);
  const int fd = listenFd;
  std::thread([fd, reply]() {
    const int c = accept(fd, nullptr, nullptr);
    char buf[2048];
    static_cast<void>(recv(c, buf, sizeof(buf), 0));
    static_cast<void>(send(c, reply, strlen(reply), 0));
    close(c);
  }).detach();
  return ntohs(addr.sin_port);
}

void testHttp() {
  int fd = -1;
  const uint16_t port = serveOnce(
      "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\ncontent-length: 11\r\n\r\n{\"ok\":true}", fd);
  char url[64];
  snprintf(url, sizeof(url), "http://127.0.0.1:%u/api/v1/device/heartbeat", static_cast<unsigned>(port));
  WiFiClient client;
  HTTPClient http;
  check(http.begin(client, url), "begin");
  http.setTimeout(2000U);
  http.addHeader("Authorization", "Bearer k");
  const char body[] = "{\"mac\":\"x\"}";
  const int status = http.POST(reinterpret_cast<const uint8_t*>(body), strlen(body));
  check(status == 200, "status line read");
  check(http.getSize() == 11, "Content-Length read, case-insensitively");
  char out[32] = {};
  int got = 0;
  for (int spins = 0; spins < 2000 && got < 11; ++spins) {
    got += http.getStreamPtr()->read(reinterpret_cast<uint8_t*>(out) + got,
                                     sizeof(out) - 1U - static_cast<size_t>(got));
    usleep(500);
  }
  check(got == 11 && strcmp(out, "{\"ok\":true}") == 0,
        "body is the bytes after the headers, and only those");
  http.end();
  close(fd);

  WiFiClient refused;
  HTTPClient nobody;
  check(nobody.begin(refused, "http://127.0.0.1:1/x"), "begin on a closed port");
  nobody.setTimeout(500U);
  check(nobody.POST(reinterpret_cast<const uint8_t*>("{}"), 2U) < 0,
        "a refused connection is a negative status");
}

void testLink() {
  const char* path = "test-link.sock";
  linux_hal::UnixLinkServer server;
  check(server.listen(path), "listen");
  linux_hal::UnixLinkClient client;
  client.configure(path, 256U);
  client.pump();
  server.acceptPending();
  check(server.connected() && client.connected(), "both ends connected");
  const uint8_t frame[] = "!PING,1\n";
  check(client.write(frame, sizeof(frame) - 1U) == sizeof(frame) - 1U, "client write");
  uint8_t got[16] = {};
  size_t n = 0U;
  for (int spins = 0; spins < 1000 && n < sizeof(frame) - 1U; ++spins) {
    uint8_t b = 0U;
    if (server.read(b)) {
      got[n++] = b;
    } else {
      client.pump();
      usleep(100);
    }
  }
  check(n == sizeof(frame) - 1U && memcmp(got, frame, n) == 0, "bytes arrive unchanged, in order");
  const uint8_t reply[] = "!PONG\n";
  check(server.write(reply, sizeof(reply) - 1U) == sizeof(reply) - 1U, "server write");
  int first = -1;
  for (int spins = 0; spins < 1000 && first < 0; ++spins) {
    first = client.read();
    usleep(100);
  }
  check(first == '!', "the bridge reads what the Mega side wrote");
  unlink(path);
}

} // namespace

int main() {
  testPinTable();
  testUrl();
  testMac();
  testHttp();
  testLink();
  if (gFailures == 0) {
    printf("court-pi: all checks passed\n");
    return 0;
  }
  fprintf(stderr, "court-pi: %d check(s) failed\n", gFailures);
  return 1;
}

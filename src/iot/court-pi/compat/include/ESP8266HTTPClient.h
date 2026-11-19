// Crusaders Mainframe — court-pi compat: the ESP8266HTTPClient calls the bridge
// makes (one HTTP/1.0 POST per call, no reuse), over a POSIX socket.
//
// The contract the bridge's postOnce() depends on is kept exactly: POST()
// returns the status code (> 0) or a negative error with nothing read;
// getSize() is the declared Content-Length or -1; getStreamPtr() yields the
// body bytes and nothing of the headers; setTimeout() bounds each phase.

#ifndef CRUSADERS_COURT_PI_COMPAT_ESP8266HTTPCLIENT_H
#define CRUSADERS_COURT_PI_COMPAT_ESP8266HTTPCLIENT_H

#include <stddef.h>
#include <stdint.h>

#include "ESP8266WiFi.h"

inline constexpr int HTTPC_ERROR_CONNECTION_FAILED = -1;
inline constexpr int HTTPC_ERROR_SEND_FAILED = -3;
inline constexpr int HTTPC_ERROR_READ_TIMEOUT = -11;
inline constexpr int HTTPC_ERROR_BAD_URL = -12;

class HTTPClient {
public:
  bool begin(WiFiClient& client, const char* url);

  void useHTTP10(bool on) { static_cast<void>(on); } // always HTTP/1.0: no chunked bodies

  void setReuse(bool reuse) { static_cast<void>(reuse); }

  void setTimeout(uint16_t timeoutMs) { timeoutMs_ = timeoutMs == 0U ? 1U : timeoutMs; }

  void addHeader(const char* name, const char* value);
  int POST(const uint8_t* body, size_t len);

  int getSize() const { return size_; }

  WiFiClient* getStreamPtr() { return client_; }

  void end();

  /// Exposed for the host test: "http://host[:port]/path" -> parts.
  static bool parseUrl(const char* url, char* host, size_t hostCap, uint16_t& port, char* path,
                       size_t pathCap);

private:
  WiFiClient* client_ = nullptr;
  char host_[96] = {};
  char path_[160] = {};
  uint16_t port_ = 80U;
  uint16_t timeoutMs_ = 5000U;
  char headers_[512] = {};
  size_t headersLen_ = 0U;
  int size_ = -1;
};

#endif // CRUSADERS_COURT_PI_COMPAT_ESP8266HTTPCLIENT_H

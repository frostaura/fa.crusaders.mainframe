// court-pi compat — the ESP8266HTTPClient POST the bridge makes, on a socket.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "ESP8266HTTPClient.h"

namespace {

uint64_t monoMs() {
  timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<uint64_t>(ts.tv_sec) * 1000ULL + static_cast<uint64_t>(ts.tv_nsec) / 1000000ULL;
}

bool startsWithNoCase(const char* text, const char* prefix) {
  for (; *prefix != '\0'; ++text, ++prefix) {
    const char a = (*text >= 'A' && *text <= 'Z') ? static_cast<char>(*text - 'A' + 'a') : *text;
    if (a != *prefix) {
      return false;
    }
  }
  return true;
}

} // namespace

bool HTTPClient::parseUrl(const char* url, char* host, size_t hostCap, uint16_t& port, char* path,
                          size_t pathCap) {
  static const char kScheme[] = "http://";
  if (url == nullptr || strncmp(url, kScheme, sizeof(kScheme) - 1U) != 0) {
    return false; // https is refused by the base URL grammar before it gets here
  }
  const char* p = url + sizeof(kScheme) - 1U;
  const char* hostEnd = p;
  if (*p == '[') { // an IPv6 literal
    hostEnd = strchr(p, ']');
    if (hostEnd == nullptr) {
      return false;
    }
    ++p;
  } else {
    while (*hostEnd != '\0' && *hostEnd != ':' && *hostEnd != '/') {
      ++hostEnd;
    }
  }
  const size_t hostLen = static_cast<size_t>(hostEnd - p);
  if (hostLen == 0U || hostLen >= hostCap) {
    return false;
  }
  memcpy(host, p, hostLen);
  host[hostLen] = '\0';
  const char* q = *hostEnd == ']' ? hostEnd + 1 : hostEnd;
  port = 80U;
  if (*q == ':') {
    char* end = nullptr;
    const unsigned long v = strtoul(q + 1, &end, 10);
    if (end == q + 1 || v == 0UL || v > 65535UL) {
      return false;
    }
    port = static_cast<uint16_t>(v);
    q = end;
  }
  const char* rest = *q == '\0' ? "/" : q;
  if (*rest != '/' || strlen(rest) >= pathCap) {
    return false;
  }
  strcpy(path, rest);
  return true;
}

bool HTTPClient::begin(WiFiClient& client, const char* url) {
  client_ = &client;
  headersLen_ = 0U;
  headers_[0] = '\0';
  size_ = -1;
  return parseUrl(url, host_, sizeof(host_), port_, path_, sizeof(path_));
}

void HTTPClient::addHeader(const char* name, const char* value) {
  if (name == nullptr || value == nullptr) {
    return;
  }
  const int n = snprintf(headers_ + headersLen_, sizeof(headers_) - headersLen_, "%s: %s\r\n", name, value);
  if (n > 0 && headersLen_ + static_cast<size_t>(n) < sizeof(headers_)) {
    headersLen_ += static_cast<size_t>(n);
  } else {
    headers_[headersLen_] = '\0'; // a header that does not fit is dropped whole
  }
}

int HTTPClient::POST(const uint8_t* body, size_t len) {
  if (client_ == nullptr) {
    return HTTPC_ERROR_BAD_URL;
  }
  if (!client_->connect(host_, port_, timeoutMs_)) {
    return HTTPC_ERROR_CONNECTION_FAILED;
  }
  char head[900];
  const int n = snprintf(head, sizeof(head),
                         "POST %s HTTP/1.0\r\nHost: %s:%u\r\nUser-Agent: court-pi\r\nConnection: close\r\n"
                         "Content-Length: %zu\r\n%s\r\n",
                         path_, host_, static_cast<unsigned>(port_), len, headers_);
  if (n <= 0 || static_cast<size_t>(n) >= sizeof(head)) {
    client_->stop();
    return HTTPC_ERROR_SEND_FAILED;
  }
  if (!client_->sendAll(head, static_cast<size_t>(n), timeoutMs_) ||
      (len > 0U && !client_->sendAll(reinterpret_cast<const char*>(body), len, timeoutMs_))) {
    client_->stop();
    return HTTPC_ERROR_SEND_FAILED;
  }
  const uint64_t deadline = monoMs() + timeoutMs_;
  char line[512];
  if (!client_->readLine(line, sizeof(line), deadline)) {
    client_->stop();
    return HTTPC_ERROR_READ_TIMEOUT;
  }
  int status = 0;
  if (sscanf(line, "HTTP/%*d.%*d %d", &status) != 1 || status <= 0) {
    client_->stop();
    return HTTPC_ERROR_READ_TIMEOUT;
  }
  size_ = -1;
  for (;;) {
    if (!client_->readLine(line, sizeof(line), deadline)) {
      client_->stop();
      return HTTPC_ERROR_READ_TIMEOUT;
    }
    if (line[0] == '\0') {
      break; // end of headers: what follows is the body
    }
    if (startsWithNoCase(line, "content-length:")) {
      const long v = strtol(line + 15, nullptr, 10);
      size_ = v >= 0L && v <= 0x7FFFFFFFL ? static_cast<int>(v) : -1;
    }
  }
  return status;
}

void HTTPClient::end() {
  if (client_ != nullptr) {
    client_->stop();
  }
}

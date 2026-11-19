#include "compat/BrainConfig.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

namespace compat {

namespace {

BrainConfig gConfig;

int hexValue(char c) {
  if (c >= '0' && c <= '9') {
    return c - '0';
  }
  if (c >= 'a' && c <= 'f') {
    return c - 'a' + 10;
  }
  if (c >= 'A' && c <= 'F') {
    return c - 'A' + 10;
  }
  return -1;
}

bool copyEnv(const char* name, char* out, size_t cap) {
  const char* v = getenv(name);
  if (v == nullptr || v[0] == '\0') {
    return true;
  }
  if (strlen(v) >= cap) {
    fprintf(stderr, "[court-brain] %s is longer than %zu characters\n", name, cap - 1U);
    return false;
  }
  strcpy(out, v);
  return true;
}

} // namespace

BrainConfig& config() {
  return gConfig;
}

bool parseMac(const char* text, uint8_t out[6]) {
  if (text == nullptr) {
    return false;
  }
  uint8_t bytes[6] = {};
  size_t nibbles = 0U;
  for (const char* p = text; *p != '\0'; ++p) {
    if (*p == ':' || *p == '-') {
      if (nibbles % 2U != 0U) {
        return false;
      }
      continue;
    }
    const int v = hexValue(*p);
    if (v < 0 || nibbles >= 12U) {
      return false;
    }
    bytes[nibbles / 2U] = static_cast<uint8_t>((bytes[nibbles / 2U] << 4U) | static_cast<uint8_t>(v));
    ++nibbles;
  }
  if (nibbles != 12U) {
    return false;
  }
  memcpy(out, bytes, sizeof(bytes));
  return true;
}

bool loadConfig() {
  BrainConfig& c = gConfig;
  bool ok = copyEnv("COURT_BRAIN_LINK", c.link, sizeof(c.link)) &&
            copyEnv("COURT_BRAIN_DATA", c.data, sizeof(c.data)) &&
            copyEnv("COURT_BRAIN_RUN", c.run, sizeof(c.run)) &&
            copyEnv("COURT_BRAIN_IFACE", c.iface, sizeof(c.iface));
  const char* mac = getenv("COURT_BRAIN_MAC");
  if (mac != nullptr && mac[0] != '\0') {
    if (!parseMac(mac, c.mac)) {
      fprintf(stderr, "[court-brain] COURT_BRAIN_MAC is not a MAC address\n");
      ok = false;
    } else {
      c.macSet = true;
    }
  }
  const char* manage = getenv("COURT_BRAIN_MANAGE_WIFI");
  if (manage != nullptr && manage[0] != '\0') {
    c.manageWifi = strcmp(manage, "0") != 0;
  } else {
    c.manageWifi = strncmp(c.iface, "wl", 2U) == 0;
  }
  return ok;
}

} // namespace compat

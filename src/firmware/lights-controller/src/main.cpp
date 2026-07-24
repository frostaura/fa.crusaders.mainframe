// Crusaders Mainframe — Lights Controller firmware (ESP32 + 6-channel relay).
//
// HTTP API (matches docs/specs/lights-controller.md):
//   POST /court/{n}/turn/on   { duration_seconds, booking_id, ts, secret }
//   POST /court/{n}/turn/off  { booking_id, ts, secret }
//   GET  /court/{n}/status
//   GET  /health
//
// Fail-safe: each channel has a local timer; lights auto-off when the timer expires
// even if no off call arrives. A duplicate /on extends the timer (smooth back-to-back).
//
// To flash:
//   1. Copy src/secrets.h.example to src/secrets.h and fill WIFI/SHARED_SECRET.
//   2. pio run -t upload
//   3. Watch with `pio device monitor`.

#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoJson.h>
#include "secrets.h"

#ifndef NUM_CHANNELS
#define NUM_CHANNELS 6
#endif

static const uint8_t RELAY_PINS[NUM_CHANNELS] = { 16, 17, 18, 19, 21, 22 };

struct ChannelState {
  bool on = false;
  unsigned long expiresAtMs = 0;  // millis() value when local timer expires
  unsigned long sinceMs = 0;
};

ChannelState channels[NUM_CHANNELS];
WebServer server(80);
unsigned long startedAtMs = 0;

void writeRelay(int idx, bool on) {
  // Most cheap relay boards are active-low; flip if your board is active-high.
  digitalWrite(RELAY_PINS[idx], on ? LOW : HIGH);
}

bool secretOk(const JsonDocument& body) {
  const char* s = body["secret"];
  return s != nullptr && strcmp(s, SHARED_SECRET) == 0;
}

int courtNumberFromUri(const String& uri) {
  // /court/{n}/turn/on  → returns n, or -1 if malformed.
  int slash1 = uri.indexOf('/', 1);
  int slash2 = uri.indexOf('/', slash1 + 1);
  if (slash1 < 0 || slash2 < 0) return -1;
  return uri.substring(slash1 + 1, slash2).toInt();
}

void handleTurnOn() {
  int courtNumber = courtNumberFromUri(server.uri());
  int idx = courtNumber - 1;
  if (idx < 0 || idx >= NUM_CHANNELS) { server.send(404, "application/json", "{\"error\":\"unknown_court\"}"); return; }

  JsonDocument body;
  DeserializationError err = deserializeJson(body, server.arg("plain"));
  if (err) { server.send(400, "application/json", "{\"error\":\"bad_json\"}"); return; }
  if (!secretOk(body)) { server.send(401, "application/json", "{\"error\":\"unauthorized\"}"); return; }

  unsigned long durationSec = body["duration_seconds"] | 1800;
  unsigned long now = millis();
  channels[idx].on = true;
  channels[idx].sinceMs = now;
  channels[idx].expiresAtMs = now + durationSec * 1000UL;
  writeRelay(idx, true);

  JsonDocument res;
  res["court"] = courtNumber;
  res["on"] = true;
  res["duration_seconds"] = durationSec;
  String out;
  serializeJson(res, out);
  server.send(200, "application/json", out);
}

void handleTurnOff() {
  int courtNumber = courtNumberFromUri(server.uri());
  int idx = courtNumber - 1;
  if (idx < 0 || idx >= NUM_CHANNELS) { server.send(404, "application/json", "{\"error\":\"unknown_court\"}"); return; }

  JsonDocument body;
  deserializeJson(body, server.arg("plain"));
  if (!secretOk(body)) { server.send(401, "application/json", "{\"error\":\"unauthorized\"}"); return; }

  channels[idx].on = false;
  channels[idx].expiresAtMs = 0;
  writeRelay(idx, false);
  server.send(200, "application/json", "{\"off\":true}");
}

void handleStatus() {
  int courtNumber = courtNumberFromUri(server.uri());
  int idx = courtNumber - 1;
  if (idx < 0 || idx >= NUM_CHANNELS) { server.send(404, "application/json", "{\"error\":\"unknown_court\"}"); return; }

  JsonDocument res;
  res["court"] = courtNumber;
  res["on"] = channels[idx].on;
  res["since_ms"] = channels[idx].sinceMs;
  res["expires_at_ms"] = channels[idx].expiresAtMs;
  res["now_ms"] = millis();
  String out;
  serializeJson(res, out);
  server.send(200, "application/json", out);
}

void handleHealth() {
  JsonDocument res;
  res["status"] = "ok";
  res["uptime_ms"] = millis() - startedAtMs;
  res["firmware"] = "crusaders-lights-1.0.0";
  res["channels"] = NUM_CHANNELS;
  String out;
  serializeJson(res, out);
  server.send(200, "application/json", out);
}

void setupRoutes() {
  // Wildcard-style: WebServer doesn't do route patterns, so we re-dispatch on the URI.
  server.onNotFound([]() {
    String uri = server.uri();
    if (uri == "/health") { handleHealth(); return; }
    if (uri.startsWith("/court/")) {
      if (uri.endsWith("/turn/on") && server.method() == HTTP_POST) { handleTurnOn(); return; }
      if (uri.endsWith("/turn/off") && server.method() == HTTP_POST) { handleTurnOff(); return; }
      if (uri.endsWith("/status") && server.method() == HTTP_GET) { handleStatus(); return; }
    }
    server.send(404, "application/json", "{\"error\":\"not_found\"}");
  });
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < NUM_CHANNELS; i++) {
    pinMode(RELAY_PINS[i], OUTPUT);
    writeRelay(i, false);
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("WiFi");
  while (WiFi.status() != WL_CONNECTED) { delay(250); Serial.print('.'); }
  Serial.print(" connected — IP "); Serial.println(WiFi.localIP());

  setupRoutes();
  server.begin();
  startedAtMs = millis();
  Serial.println("Crusaders Lights Controller online.");
}

void loop() {
  server.handleClient();

  unsigned long now = millis();
  for (int i = 0; i < NUM_CHANNELS; i++) {
    if (channels[i].on && channels[i].expiresAtMs != 0 && now >= channels[i].expiresAtMs) {
      channels[i].on = false;
      channels[i].expiresAtMs = 0;
      writeRelay(i, false);
      Serial.print("Channel "); Serial.print(i + 1); Serial.println(" auto-off (timer expired).");
    }
  }
}

---
name: crusaders-mainframe-decisions-court-box-extend
description: "Court box 2026-10-11: scan-first landing, greeting with balance, minutes-left and scan-to-extend on a lit court, active-high relays for NO SSRs (Mega 2.1.0, bridge 2.3.0), and the plain-http member-code fallback."
type: decision
last_verified: 2026-10-11
---

# Decisions — scan-first box, extend a lit court, active-high relays (2026-10-11)

Founder-directed, shipped to `main` in `4ac90a67`, `be903b60`, `0d92f5f4`, `6f62f3c8`.

- **The landing screen is "scan your code"**, and every overlay reverts to it on its own
  (`kRevertSeconds` 10, choices 20). **Why:** the LCD sat on the last payment screen and the next
  players had nothing to act on.
- **A recognised scan greets by first name with the spendable balance.** `/activate` returns
  `greeting_name` (accent-folded, printable ASCII, ≤16, empty not null) and `balance_minutes`, read
  from the ledger, for a recognised member only. Above 9999 the box shows WELCOME rather than a
  cut unit.
- **Pressing a lit court shows its minutes left; after a scan it extends.** Founder's choices:
  **any member who scans may extend** any lit court, pressing your own lit court after a scan is
  extend-only, and an unscanned press shows minutes left plus a scan hint. `POST /extend` sells a
  NEW walk-up-shaped booking from the end of play (never a longer `EndsAt` on someone else's
  row), cut at the next booking and at closing, debited as `LightsPurchase` under
  `extend:{device}:{nonce}`; a replayed nonce returns the first purchase. `court.extended` is
  `NotAPersonsNight` because the walk-up twin already puts it on the scanner's night.
- **A cut or field-less 200 from `/extend` is undecided, not refused.** The box shows BUSY / PRESS
  AGAIN and keeps the nonce. **Why:** the server has probably charged; dropping the nonce made the
  retry a second purchase.
- **Relays are active-high (`RELAY_ACTIVE_LOW=0`)** because the club moved to normally-open
  solid-state relays. Polarity lives in the shared HAL (`RelayPolarity`, `relayLevelFor`); boot
  still writes the off level before `pinMode(OUTPUT)`. Flash the **Mega first**, then the bridge —
  a mismatched pair lights courts when they should be dark. This does not answer
  `safety-relays.md`.
- **The member code works on plain http.** `crypto.subtle` exists only on https or localhost, so
  the club LAN (`http://<server IP>`) showed no code. Without WebCrypto the key is a `SoftHmacKey`
  signed by `sha256.ts`, pinned to WebCrypto by vectors and an equality sweep. The bytes are then
  readable by the page — accepted, because production is https and never takes that path.
- **The LAN browser origin is opt-in** through `CORS_ALLOWED_ORIGIN_LAN` in `.env`
  (`Cors__AllowedOrigins__2`).
- **ESP32 watchdog compiles on core 2.x and 3.x**: on 3.x `esp_task_wdt_reconfigure` with a
  config struct, falling back to `esp_task_wdt_init`. CI pins esp32 2.0.17; 3.3.11 was checked by hand.

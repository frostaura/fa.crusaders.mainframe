# Lights Controller (Arduino + 6-channel relay)

> **Superseded — read [`src/iot/README.md`](../../src/iot/README.md) instead.**
>
> This spec describes a greenfield ESP32 relay box driven entirely through the
> outbound webhook system. The hardware actually installed at Crusaders is a
> WeMos Mega 2560 + ESP8266 court box with an LCD, an eight-button panel and a QR
> scanner, and its wiring cannot change.
>
> Two conclusions here proved wrong in practice and are corrected in `src/iot`:
> the sketch this spec produced authenticated on a `secret` field in the body
> while the webhook worker sends an HMAC header, so **every delivery would have
> 401'd**; and relay commands cannot ride the webhook bus at all, because that
> bus is a single serial dispatcher with a 10s per-endpoint timeout and no
> working retry. Actuation is a direct client on the request path instead.
>
> The parts that held up — the local auto-off timer, `/health`, `/status`, and
> the observation that a controller credential is compiled in and rotated by
> reflashing — are carried into `src/iot`. What replaced the `secret`-in-body
> and the optional HMAC is one static per-tenant key in an
> `Authorization: Bearer` header, on requests the box makes *outbound*; nothing
> calls the box. Kept for the design rationale and the fail-safe discussion.

[Superseded design] The court lights are switched by an **Arduino** on the club LAN. The Arduino runs a small HTTP server exposing endpoints that drive a **6-channel relay board** (one channel per court, up to 6 courts per Arduino). The mainframe drives the lights by **calling those endpoints via the existing outbound webhook system** — the Arduino is, architecturally, just another webhook consumer.

## Why this shape
- **No new abstraction.** The mainframe already has a webhook delivery worker with signing, retries, and per-endpoint queues. The Arduino is registered as a webhook endpoint per tenant; lights events fire to it like any other consumer.
- **Hardware decoupled.** The mainframe knows nothing about Arduino-vs-PLC-vs-Shelly. If a tenant later swaps to a different controller, they re-register the endpoint URL.
- **LAN-local.** The Arduino sits on the same network as the on-prem mainframe machine. Calls are local (single-digit ms), so retries are rare in practice.

## Wiring it via templated webhooks (no per-court mapping needed)
Each court has a stable numeric identifier within its tenant — `court_number` (1, 2, 3, 4 for the Crusaders default of 4 courts). The Arduino's HTTP routes use that number directly, so the tenant admin registers **two** templated webhook endpoints (see `webhooks.md` § URL templating) and the system handles every court without any per-court mapping table:

| Webhook | Event filter | URL template |
| --- | --- | --- |
| Lights on | `booking.lights_on` | `http://arduino.local/court/{court_number}/turn/on` |
| Lights off | `booking.lights_off` | `http://arduino.local/court/{court_number}/turn/off` |

`{court_number}` is substituted from the event payload at delivery time. Adding a 5th court is a database operation, not a webhook change. Multiple Arduinos (e.g. clubs with >6 courts) are supported by mapping different court-number ranges to different controllers — currently expressed as separate webhook endpoints with hostname differences (`arduino-bank-a.local` for courts 1–6, `arduino-bank-b.local` for 7–12); a future "controller pool" UI can hide that detail if it's worth building.

## Arduino HTTP API
Minimal surface — the Arduino is dumb on purpose.

| Method | Path | Purpose | Body |
| --- | --- | --- | --- |
| `POST` | `/court/{court_number}/turn/on` | Turn court on | `{ "duration_seconds": 1800, "booking_id": "<uuid>", "ts": <unix>, "secret": "<shared>" }` |
| `POST` | `/court/{court_number}/turn/off` | Turn court off immediately | `{ "booking_id": "<uuid>", "ts": <unix>, "secret": "<shared>" }` |
| `GET`  | `/court/{court_number}/status` | Current state | — (returns `{ "on": true, "since": <unix>, "expires_at": <unix> }`) |
| `GET`  | `/health` | Heartbeat + uptime + firmware | — |

The Arduino maps `court_number → relay channel` internally (a small array in firmware: `courts[court_number] = relay_channel`). For the standard Crusaders config it's a 1:1 identity mapping — court 1 → channel 1, etc. — but the indirection is deliberate so a re-cabling at the relay board doesn't require a database change.

`duration_seconds` is the booking's remaining time. The Arduino sets a local timer and **auto-turns-off when the timer expires**, even if it never receives the explicit `off` call. This is the safety net for "the mainframe died mid-session" — lights still go off when the booking ends.

If a new `on` call arrives for a channel that's already on, the Arduino **extends** the timer (back-to-back bookings flow through cleanly without flicker).

## Authentication
LAN-only is not sufficient by itself — the Arduino is on the same network as anything else the club plugs in. Two layers:
1. **Shared secret in body.** The mainframe includes a per-tenant `controller_secret` in every request body; the Arduino rejects requests whose secret doesn't match its compiled-in value.
2. **HMAC signature** (optional, if compute budget allows). The mainframe's standard `X-Crusaders-Signature` header (HMAC-SHA256 of the body) is also sent. An Arduino with an ESP32 can validate this; an Uno R3 cannot — fall back to shared-secret-only on weaker boards.

The shared secret is set when the Arduino is flashed; rotation requires a re-flash. Document this clearly so admins know rotation is not a UI operation.

## Fail-safe behavior — TBD, decision required
Three possible behaviors when the Arduino loses network connectivity to the mainframe:
- **A. Maintain.** Lights stay in their current state until the local timer expires. Players in the middle of a session keep playing. Players whose booking *should* start during the outage get nothing — they call an admin.
- **B. Auto-off after timeout.** Same as A, but if the Arduino sees no traffic for >N minutes it forces all channels off. Conservative; risks switching lights off mid-game during a transient network blip.
- **C. Local override pad.** A physical button at the court can force lights on for one slice-length, manually, with the override logged and reconciled when the mainframe is back.

Recommendation is **A + C** — timer-based auto-off is the safety net for "the mainframe is gone," and the override pad lets an admin or a player rescue an in-progress session if the network drops. (Decision pending — see `CLAUDE.md` working notes.)

## Flow at booking time
1. Player identifies at the court (biometric / PIN / QR — see `biometric-abstraction.md` § Identification triple-stack, per blueprint B.1).
2. **If a different player presses "I'll pay"** at the touchpad and identifies (blueprint B.2), the mainframe records `paid_by_user_id` on the booking and debits *that* user's account instead.
3. Mainframe **posts the `booking_charge` ledger entry** (charge happens at lights-on per blueprint A.9, not at booking creation), writes a `LightsOn` event, computes `duration_seconds = booking.ends_at - now`.
4. Mainframe fires `booking.lights_on` webhook to the configured controller URL for the matched court (court_number flowing through the URL template).
5. Arduino receives, flips relay, starts local timer, returns 200.
6. Mainframe records the response (status + latency) for observability.
7. On 200: nothing further. On non-200 / timeout: webhook system retries per the standard backoff. **If the webhook ultimately fails, the ledger entry is not rolled back** — the player paid for an attempt that didn't reach the relay; admin gets paged for manual intervention.

## End-of-booking cleanup
- The Arduino's local timer is the primary off-switch (works without mainframe).
- The mainframe ALSO fires a `booking.lights_off` webhook at booking end, as a belt-and-braces.
- [Superseded, and never built — R16] ~~If the mainframe knows a booking has ended early (cancellation), it fires an immediate `off` call with the cancelled booking's id.~~ No cancellation fires an immediate off. A cancelled booking that was lit gets its `booking.lights_off` at its `EndsAt`, from the lights-cue sweep (recent ones only, R14 D14-2); a cancelled booking that was never lit gets none. A no-show reversal that re-lit the court and was then cancelled at the desk is swept the same way (R16 D16-4). The box's own timer is what actually turns the relays off. Current rules: `webhooks.md` (`booking.lights_off` and *Ordering the lights events*); `Webhooks/LightsCueWorker.cs`.

## Observability
- Mainframe records every request to the Arduino: timestamp, channel, action, response status, latency. Visible in the admin "Peripheral health" view.
- Mainframe polls each Arduino's `/health` endpoint every 60s; on 3 consecutive failures, fires `peripheral.unhealthy` event and pages the admin.
- The Arduino itself emits no logs — it's a relay with HTTP. Diagnostics live mainframe-side.

## Hardware notes
- **Recommended starting board:** ESP32 — has WiFi out of the box, enough RAM for HMAC validation, ~R150 in South Africa.
- **Relay board:** any common 6-channel 5V/12V relay module. Watch the relay coil current — ESP32 GPIO can't drive most relay coils directly; use a board with on-board transistor drivers (most cheap modules do).
- **Power:** Arduino on 5V (USB or wall wart); relay coils on whatever the relay board expects (usually 5V or 12V); switched circuits at mains voltage. **Mains wiring must be done by a qualified electrician.** Document this in the install runbook.
- **Physical placement:** electrical cupboard, on the existing lights circuit. Arduino on the LAN side via WiFi or wired ethernet (wired is more reliable; ESP32 + W5500 ethernet module is the robust path).
- **Per-court switch override:** if A+C fail-safe is chosen, wire a normally-open momentary switch into a spare GPIO per channel so a player can press it to force-on locally.

## What this means for the project
- No `ILightsController` interface in the .NET code is needed. The lights consumer is the existing `WebhookDeliveryService`.
- One new tenant-admin UI screen: "Lights controllers" — add controller URL + secret + court→channel mapping.
- Two new event types added to the webhook catalogue (already specced): `booking.lights_on`, `booking.lights_off`, plus `peripheral.unhealthy` (already in the catalogue).
- The Arduino firmware is its own deliverable — keep the source in `src/firmware/lights-controller/` once the project is scaffolded. Versioned. OTA updates out of scope for v1; flash via USB.

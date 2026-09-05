# Outbound Webhooks

User- and admin-configurable HTTP callbacks fired on system events. Lets external systems (other club tools, members' personal automations, accounting systems) react to what's happening.

## Configuration
- A tenant admin (or a player, scoped to their own events only) can register an endpoint:
  - `url` — HTTPS by default; **HTTP allowed for LAN / RFC1918 hosts** on the private-network allow-list (a scoreboard, an accounting box, any LAN consumer the club points a webhook at — never the court box, which is pull-only). Supports template variables (see "URL templating" below).
  - `event_filter` — array of event names, or `["*"]` for all
  - `secret` — auto-generated, used to sign payloads (HMAC-SHA256)
  - `enabled` — bool
  - `description` — free text
- A user can register up to 5 endpoints; an admin up to 20 per tenant.
- Endpoints can be tested via a "Send test ping" button — sends a `webhook.test` event.

## URL templating
The webhook URL supports **single-brace placeholder substitution** — `{variable_name}` — resolved per-event from the event payload at delivery time. This lets one webhook config target many resources without registering N separate endpoints. Example: a club scoreboard on a DHCP reservation, allow-listed as `10.0.40.7/32`, with a single config `url = http://10.0.40.7/court/{court_number}/lit` filtered to `booking.lights_on` covers every court. **Do not template a URL at the court box** — it has no HTTP listener and switches its own relays (see below).

**Available variables** (always present, regardless of event):
- `{tenant_id}`, `{tenant_slug}`
- `{event_id}`, `{event_type}`
- `{occurred_at}` (ISO8601), `{occurred_at_unix}`

**Event-specific variables** are flattened from `data` — every key in the event's `data` object is available as `{key}`. For booking events that means `{court_id}`, `{court_number}`, `{court_name}`, `{user_id}`, `{user_name}`, `{booking_id}`, `{starts_at}`, `{ends_at}`, `{slice_count}`, `{amount_charged_zar}`, `{balance_after_zar}`, etc.

**Resolution rules**:
- Missing variable at delivery time → delivery fails with a clear error in the delivery log; endpoint owner is emailed; not retried (a missing variable is a config bug, not a transient failure).
- Values are URL-encoded automatically. `{user_name}` containing spaces becomes `%20` etc.
- Literal `{` and `}` in the URL must be percent-encoded (`%7B` / `%7D`) — placeholder syntax has priority.
- Template is validated at save-time: parsed for variable references, each referenced variable is checked against the events the endpoint is filtered to. Unresolvable references block save with a clear error.

**Body templating** uses the same syntax inside string fields of the JSON body. Default body remains the standard event payload; templating is opt-in via a "custom body" field in the endpoint config (advanced users only).

## The court box is not a webhook consumer
The court lights are switched by the court box itself — an ESP8266 bridge and a Mega with its own relay bank and independent auto-off timer — which decides locally from an online activation or its cached heartbeat roster and **pulls** everything it needs from the API (`docs/specs/device-discovery.md`, `docs/specs/device-serial-protocol.md`). It has no inbound HTTP listener, no `arduino.local` name, and nothing in the delivery worker targets it. `docs/specs/lights-controller.md`, which described a webhook-driven Arduino at `http://arduino.local/court/{court_number}/turn/...`, is superseded and must not be used as a templating example.

`booking.lights_on` and `booking.lights_off` are therefore what they are for every other event: a programmatic **mirror** of something that already happened at the court, for whatever external consumer wants to know.

## Event catalogue
| Event | Triggered when |
| --- | --- |
| `member.registered` | A new registration is submitted |
| `member.approved` | Admin approves a pending member |
| `member.rejected` | Admin rejects a pending member |
| `member.suspended` | Admin suspends a member |
| `booking.created` | A booking is committed |
| `booking.cancelled` | A booking is cancelled (free) |
| `booking.late_cancellation` | A booking is cancelled inside the penalty window |
| `booking.no_show` | No-show penalty applied after grace expires |
| `booking.lights_on` | A court was activated (online activation, roster fallback uploaded later, or a walk-up) |
| `booking.lights_off` | The lights-off cue fires at the end of a slot |
| `booking.no_show_reversed` | Late attendance evidence from a box reversed a settled no-show |
| `booking.displaced` | A booking sold into a released tail was cancelled and refunded by a no-show reversal (`ResoldTailRefunded`) |
| `booking.cancelled_lights_charged` | A cancelled booking was lit from an offline box's roster and charged pro rata for the lit minutes |
| `booking.completed` | A booking's slice ends naturally |
| `credit.topped_up` | PayFast confirms a top-up (ITN) |
| `credit.refunded` | A cancellation/no-show ledger entry is written |
| `credit.penalty_applied` | A penalty ledger entry is written |
| `credit.adjusted` | An admin issues a manual adjustment |
| `peripheral.unhealthy` | A biometric device's `State` becomes `Faulted` |
| `webhook.test` | The "send test ping" button is clicked |

## Payload shape
All payloads are JSON, structured:

```json
{
  "id": "evt_<uuid>",
  "type": "booking.created",
  "tenant_id": "<uuid>",
  "occurred_at": "2026-05-06T18:30:00Z",
  "data": { /* event-specific fields */ },
  "actor": {
    "user_id": "<uuid-or-null>",
    "is_admin": false,
    "is_platform_admin": false
  }
}
```

`data` for `booking.created`:
```json
{
  "booking_id": "<uuid>",
  "user_id": "<uuid>",
  "court_id": "<uuid>",
  "court_name": "Court 2",
  "starts_at": "2026-05-08T18:00:00Z",
  "ends_at": "2026-05-08T18:30:00Z",
  "slice_count": 1,
  "amount_charged_zar": 50.00,
  "balance_after_zar": 350.00
}
```

(Exact per-event payloads documented in code via JSON Schema; out of spec scope to enumerate every one here.)

## Delivery semantics
- **At-least-once.** Receivers must be idempotent on `id`.
- **Signed.** `X-Crusaders-Signature: sha256=<hex>` header — HMAC-SHA256 of the raw body using the endpoint's secret.
- **Timestamped.** `X-Crusaders-Timestamp: <unix-seconds>` — receivers should reject events older than 5 minutes to mitigate replay.
- **Retry policy.** On any non-2xx response (or timeout >10s): retry with exponential backoff at 1m, 5m, 30m, 2h, 12h, 24h. After 6 failures the endpoint is auto-disabled and the owner is emailed. Driven by `WebhookRetryWorker`, which sweeps due deliveries every 30s in batches of 50. A blocked destination is exempt and is abandoned on the first attempt.
- **Per-endpoint queue.** Slow / failing endpoints don't block others. Each endpoint has its own delivery worker.
- **Retention.** Each event keeps its delivery log (status code, response time, retry count) for 30 days, viewable in admin UI.

## Player-scoped vs tenant-wide
- A **player-registered** endpoint receives only events where the player is the subject (`data.user_id == player.id`) or actor.
- A **tenant-admin-registered** endpoint receives all events for that tenant.
- A **platform-admin-registered** endpoint can receive all events across all tenants (the `tenant_id` field disambiguates). Used for the platform observability stack.

## Security posture

### SSRF guard — as built

Implemented in `Security/Outbound/OutboundAddressGuard.cs` and wired into the
`webhooks` HttpClient by `GuardedHttpClient.cs`.

**The decision is made in the socket's `ConnectCallback`, against the address about to
be dialled — not when the URL is registered.** Registration-time validation is a
usability courtesy: the host is resolved minutes or months later and can point
somewhere else by then, so a pre-flight check is not a boundary. A name that answers
publicly for the validation lookup and `169.254.169.254` for the delivery lookup —
DNS rebinding — defeats any check that happens before the connection.

Refused, unless allow-listed:

- loopback, `0.0.0.0`, `::`
- RFC1918 (`10/8`, `172.16/12`, `192.168/16`)
- link-local `169.254/16` — **including the cloud metadata endpoint**, which is
  link-local rather than private and which an RFC1918-only guard therefore misses
- carrier NAT `100.64/10`, multicast and reserved (`224/4` upward)
- IPv6 link-local, site-local, unique-local, multicast
- IPv4-mapped IPv6 (`::ffff:10.0.0.1`), unwrapped before classification

Also:

- **every** resolved address must pass, not merely one — a name answering with both a
  public and a private address is the rebinding case, and picking the good one is the bug
- **redirects are not followed.** A public URL answering `302` to the metadata endpoint
  is the cheapest way past a guard that inspects only the first hop, and a webhook
  receiver has no legitimate reason to redirect
- a template variable in the **host** is refused at registration. Variables are
  substituted from event-payload fields, which carry member-supplied values; a host
  assembled from those is a destination nobody chose. Variables in the path and query
  stay allowed — they cannot change where the request goes
- a blocked destination is **abandoned immediately**, not retried. It is a configuration
  error, and re-running an unchangeable decision six times over 41 hours buries the reason

### The LAN carve-out

`Webhooks:PrivateNetworkAllowList` is a list of CIDRs, so
`"10.0.40.7/32"` admits one LAN consumer rather than the entire private internet.
`Webhooks:AllowPrivateNetworks` disables the guard wholesale and defaults to **on in
Development only** — the dev loop runs against MailHog, a local API and a simulator on
localhost.

`CLAUDE.md` states this carve-out must not be closed. It exists for legitimate LAN
consumers a club points a webhook at — reached by DHCP reservation, since the network is
DHCP everywhere. The court box is **not** one of them: it is pull-only, has no inbound
HTTP listener, and can never be a webhook destination.

### Other

- HTTPS preferred; HTTP permitted so an allow-listed LAN device can be reached.
- The secret is shown to the user only once at creation; thereafter it's masked. They can rotate it any time.

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
- `{id}`, `{type}` — the envelope's own field names, and what a delivered body carries. `{event_id}` and `{event_type}` are accepted as aliases: this document promised those two names while the envelope only ever had `id` and `type`, so a template written against it was refused at delivery as a missing variable — a config error, deliberately not retried, so the endpoint just stopped (review A2-16). Both spellings work now; the short ones are canonical.
- `{occurred_at}` (ISO8601), `{occurred_at_unix}`

**Event-specific variables** are flattened from `data` — every key in the event's `data` object is available as `{key}`. For booking events that means `{court_id}`, `{court_number}`, `{court_name}`, `{user_id}`, `{user_name}`, `{booking_id}`, `{starts_at}`, `{ends_at}`, `{slice_count}`, `{minutes}`, `{amount_minutes}`, `{balance_after_minutes}`, etc. Every amount of court time is a whole number of minutes (P13, `minutes-and-packages.md` §5); rand appears only as `*_zar` on `minutes.purchased`.

`actor` and `subject` are **objects** in the envelope and are not flattened, so `{user_id}` resolves only from `data`, on the events that carry one — not from `actor.user_id` or `subject.user_id`. There is no alias for it: two different user ids in one envelope have no single right answer.

**Resolution rules**:
- Missing variable at delivery time → delivery fails with a clear error in the delivery log; endpoint owner is emailed; not retried (a missing variable is a config bug, not a transient failure).
- Values are URL-encoded automatically. `{user_name}` containing spaces becomes `%20` etc.
- Literal `{` and `}` in the URL must be percent-encoded (`%7B` / `%7D`) — placeholder syntax has priority.
- Template is validated at save-time: parsed for variable references, each referenced variable is checked against the events the endpoint is filtered to. Unresolvable references block save with a clear error.

**Body templating** uses the same syntax inside string fields of the JSON body. Default body remains the standard event payload; templating is opt-in via a "custom body" field in the endpoint config (advanced users only).

## The court box is not a webhook consumer
The court lights are switched by the court box itself — an ESP8266 bridge and a Mega with its own relay bank and independent auto-off timer — which decides locally from an online activation or its cached heartbeat roster and **pulls** everything it needs from the API (`docs/specs/deployment.md`, `docs/specs/device-serial-protocol.md`). It has no inbound HTTP listener, no `arduino.local` name, and nothing in the delivery worker targets it. `docs/specs/lights-controller.md`, which described a webhook-driven Arduino at `http://arduino.local/court/{court_number}/turn/...`, is superseded and must not be used as a templating example.

`booking.lights_on` and `booking.lights_off` are therefore what they are for every other event: a programmatic **mirror** of something that already happened at the court, for whatever external consumer wants to know.

## Event catalogue
| Event | Triggered when |
| --- | --- |
| `member.registered` | A new registration is submitted |
| `member.approved` | Admin approves a pending member |
| `member.rejected` | Admin rejects a pending member |
| `member.suspended` | Admin suspends a member |
| `member.reactivated` | Admin lifts a suspension |
| `booking.created` | A booking is committed |
| `booking.cancelled` | A booking is cancelled (free) |
| `booking.late_cancellation` | A booking is cancelled inside the penalty window |
| `booking.no_show` | No-show penalty applied after grace expires |
| `booking.lights_on` | A court was activated (online activation, roster fallback uploaded later, or a walk-up). The envelope's **actor is the member whose code lit the court** — the organiser, an accepted partner or a pay-for payer — and `data.identified_user_id` names the same member; `data.user_id` stays the booking's owner (the subject) and `data.paid_by_user_id` is who actually paid (the pay-for payer after a pay-for). Additive since review round 10 (E10-2). Also emitted when a box's uploaded activation reverses a settled no-show or outage refund (R11 E11-3) — the roster fallback uploaded later; actor and `identified_user_id` are the scanner. On that late upload `occurred_at` is the **scan** instant and `duration_seconds` runs from the scan to the restored end, never from the upload (R12 E12-3). It is sent under the court's cue lock after the check-in commits, so it never precedes an off decided without it (settlement-model I12, R13). `Services/CourtActivationService.cs`; `Endpoints/DeviceEventEndpoints.cs` (reversal branch, via `CourtActivationService.EmitReversedLightsOnAsync`) |
| `booking.lights_off` | The lights-off cue fires at the end of a slot. A late check-in that reverses a no-show or outage refund after the cue has fired gets one more `lights_off` at the restored end, so every `lights_on` is followed by an off (settlement-model I12, R12 E12-3). `occurred_at` is when the court is next free — the slot's (restored) end, or the end of a lit booking that held it after — never the instant the cue was sent; a slot followed by an already-lit, still-running session on the same court gets **no** `lights_off` of its own, because that session's off closes the court (settlement-model I12, R13 E13-1). A booking holds the court from the earlier of its start and its check-in, so an early scan across a gap counts (R14 D14-1). A lit booking that is then cancelled still gets its off at its end — recent ones only, so a deploy never replays history (R14 D14-2) |
| `booking.no_show_reversed` | Late attendance evidence from a box reversed a settled no-show. The envelope's actor is the member the box identified, and `data.identified_user_id` names them (R11 E11-3); null when no scan made the reversal. |
| `booking.displaced` | A booking sold into a released tail was cancelled and refunded by a no-show reversal (`ResoldTailRefunded`) |
| `booking.cancelled_lights_charged` | A cancelled booking was lit from an offline box's roster and charged pro rata for the lit minutes |
| `booking.displacement_reversed` | The box's own `release` proved the earlier court went dark before a displaced booking's slot, so it was reinstated and re-charged (settlement model I9) |
| `booking.completed` | A booking's slice ends naturally |
| `booking.payer_changed` | Somebody took a booking's charge over — D10's pay-for at the box, or a payer override at the court. **Subject and `data.user_id` are the NEW payer**, so a member-registered endpoint hears that its member paid; `data` also carries `booker_user_id`, `previous_payer_user_id`, `amount_minutes`, `court_id`, `court_number`, `starts_at`, `ends_at` (sold end). The previous payer's refund is its own `minutes.refunded` (review round 6, E6-4). `Webhooks/BookingEvents.cs` |
| `minutes.purchased` | PayFast confirms a package purchase (ITN). Was `credit.topped_up` |
| `minutes.sold_at_desk` | The desk sells a member a package (an `AdminTopUp` ledger row). Was `credit.topped_up_by_admin` |
| `minutes.refunded` | A cancellation/no-show refund ledger entry is written. Was `credit.refunded` |
| `minutes.penalty_applied` | A no-show or late-cancellation penalty ledger entry is written. Was `credit.penalty_applied` |
| `minutes.adjusted` | An admin adjusts a member's minutes by hand (goodwill, a correction). Was `credit.adjusted` |
| `minutes.refund_reversed` | A NEGATIVE refund row is written — a refund taken back, e.g. by the late-evidence reversal of a no-show. It went out as `minutes.refunded` with a negative figure until review round 6 (E6-11) |
| `minutes.penalty_returned` | A POSITIVE penalty row is written — a penalty given back, e.g. by the same reversal. It went out as `minutes.penalty_applied` with a positive figure until review round 6 (E6-11) |
| `peripheral.unhealthy` | A court box has not heart-beaten for longer than `offline_after_seconds`. Fires **once per outage**, from `PeripheralHealthWorker`. It means "the box is not reporting" — never "the reader is faulty": `BiometricDeviceState.Faulted` is still set by no driver, so a fingerprint reader failing behind a healthy box remains invisible. See `feature-spec.md` §6a and §9. |
| `peripheral.recovered` | The same box called in again; carries how long the outage lasted |
| `webhook.test` | The "send test ping" button is clicked |

**Ordering the lights events (R14 E14-4).** Consumers order `booking.lights_on` / `booking.lights_off` by `occurred_at`, not by arrival. An off never precedes the on it closes: an off that arrives before the same booking's on does not close that on. A reversal's `lights_on` carries the scan instant and may arrive after later events. **Mirror the court, not the booking (R15 E15-6, D15-4):** the lights are a per-court state, and the on/off pairing is per court, not per booking. A court is lit from an on until the next off for that court by `occurred_at`. Per booking, three shapes are normal:
- a no-show gets an off and no on;
- a booking followed by an already-lit session on the same court gets an on and no off of its own, because the follower's off closes the court;
- a reversed no-show can get two offs (the sweep's, then one at the restored end).

A consumer that pairs ons and offs per booking will keep courts lit forever. A reversal's `lights_on` is suppressed only when a booking that lit the court at or before the scan instant still holds it. When the survivor lit **after** the scan, the reversal's on goes out at the scan instant and the survivor's off closes the court (R15 D15-2).

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

`actor.is_admin` is the acting user's **real** role at the moment of the event, never inferred
from "the actor is not the subject": a member paying for a friend's court at the box, or a partner
moving minutes on a split booking, is not an admin (R13 E13-2; `LedgerService.ActorOf`).

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
  "minutes": 45,
  "amount_minutes": 45,
  "balance_after_minutes": 255,
  "walk_up": false
}
```

**Minutes replaced credits (P13, 2026-10-01).** The unit of account is whole minutes; every `*_credits`
key in every event's `data` became `*_minutes` with an integer value (`booking.no_show` `penalty_minutes` /
`refund_minutes`, `booking.lights_*` `amount_charged_minutes`, …), and the five money events were renamed
(table above). The renamed events are new names, not aliases: an endpoint filtered to `credit.*` receives
nothing until it is re-filtered. The constants are in `Webhooks/MinutesEvents.cs` and pinned by
`WebhookEventCoverageTests`.

`data` for `minutes.purchased`:
```json
{
  "purchase_id": "<uuid>",
  "package_id": "<uuid>",
  "package_name": "5 hours",
  "minutes": 300,
  "list_price_zar": 550.00,
  "discount_bps": 1000,
  "zar_paid": 495.00,
  "discount_group_id": "<uuid-or-null>",
  "groups": [{ "id": "<uuid>", "name": "League members", "system_key": "league" }],
  "external_reference": "<pf_payment_id>"
}
```
`topup_id` became `purchase_id`, `credits` became `minutes` and `rate_group_id` became `discount_group_id`
(the group whose package discount was locked at checkout; null when none applied). `conversion_rate` and
`member_class` are gone: there is no rate, and the renamed event has no template naming `{member_class}`
to protect.

`data` for the six ledger mirrors (`minutes.sold_at_desk`, `minutes.refunded`, `minutes.penalty_applied`,
`minutes.adjusted`, `minutes.refund_reversed`, `minutes.penalty_returned` — the event is chosen by the row's type
AND its sign, `LedgerService.MirrorTypeOf`). Their envelope actor is the person whose act wrote the row: the scanner on a late check-in's reversal legs and re-collected shares, the organiser, partner or admin on share moves — no longer null or the system (R14 E14-2, E14-3):
```json
{ "entry_id": "<uuid>", "user_id": "<uuid>", "entry_type": "AdminAdjustment",
  "amount_minutes": -45, "booking_id": "<uuid-or-null>", "reason": "Goodwill — lights failed" }
```
`minutes.sold_at_desk` also carries `zar_received` (rand; `0` on a give) and `given` (true when the desk recorded no rand — the one "given" rule reports, the Night and the desk mail use), so a consumer can tell a give from a sale (R15 E15-5).

`topup.failed` is **not** a webhook: it is an admin-notice kind (`AdminEventCatalogue.TopUpFailed`) and keeps its
code, because admins' stored opt-outs and the outbox dedupe keys name it. Its display name is "Package purchases
that need looking at", and its payload carries `package_name` and `minutes` beside the rand amount.

**Groups replaced the member class (D2, 2026-09-23).** Two payloads carried `member_class`:

- `member.approved` / `member.rejected` / `member.suspended` / `member.reactivated` — `data` now carries
  `groups`: an array of the member's ACTIVE groups, `[{"id": "<uuid>", "name": "League members", "system_key": "league"}]`
  (`system_key` is null for any group an admin made).
- The purchase event (then `credit.topped_up`, now `minutes.purchased`) carried a rate group and the same
  `groups` array; since P13 it carries `discount_group_id` and `groups`, and no `member_class` (above).

The `member.*` events keep **`member_class` for ONE release, deprecated**: `"LeagueOrSenior"` when the
member is in the league group, otherwise `"Regular"`. It is kept so a URL template naming `{member_class}` does not start failing as a missing
variable — a config error, never retried — the day the class is removed. `groups` is an array and is
not flattened, so a URL template cannot name it; a body consumer reads it. Remove `member_class` in the
release after the Groups page ships.

(Exact per-event payloads documented in code via JSON Schema; out of spec scope to enumerate every one here.)

## Delivery semantics
- **At-least-once.** Receivers must be idempotent on `id`.
- **Signed.** `X-Crusaders-Signature: sha256=<hex>` header — HMAC-SHA256 of the raw body using the endpoint's secret.
- **Timestamped.** `X-Crusaders-Timestamp: <unix-seconds>` — receivers should reject events older than 5 minutes to mitigate replay.
- **Retry policy.** On any non-2xx response (or timeout >10s): retry with exponential backoff at 1m, 5m, 30m, 2h, 12h, 24h. After 6 failures the endpoint is auto-disabled and the owner is emailed. Driven by `WebhookRetryWorker`, which sweeps due deliveries every 30s in batches of 50. A blocked destination is exempt and is abandoned on the first attempt — and is disabled on that attempt, with the same email. **For a club endpoint the owner is the club, so the email is the `webhook.auto_disabled` admin notice to every administrator** (R23, non-optional), staged in the same save as the disable and naming the destination by scheme and host only. **A member-registered endpoint's owner is not yet emailed** — that mail is still owed.
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

**The allow-list is deployment configuration and there is no admin surface for it — by
decision, not by omission.** `OutboundAddressGuard` is a singleton that parses
`Webhooks:PrivateNetworkAllowList` once, at construction, from `IConfiguration`; it has
no tenant in scope, and the address it judges is the one being dialled inside a socket's
`ConnectCallback`, long after any request context. So the list is **process-wide**: one
entry admits that address for every tenant the deployment serves. A club admin who could
add to it would be moving an SSRF boundary for every *other* club on the same host, which
is the cross-tenant escalation this repo classes as a P0 — an admin-only, validated,
audited screen would not change that, because the blast radius is the problem, not the
authorisation.

Making it tenant-scoped instead is a larger change than it looks and is **not** in v1: the
guard would have to carry the owning tenant from registration through to the connect
callback of a delivery attempt that runs on a background queue.

What an admin gets instead is a refusal that says so. `destination_not_permitted` names
the setting and says plainly that no screen can change it and who can, so the request to
whoever runs the deployment is actionable — see `CREATE_REFUSAL` in
`src/frontend/src/pages/AdminWebhooks.tsx`, pinned by `AdminWebhooks.test.tsx` ("says the
LAN carve-out is deployment configuration, not a screen that is missing"). Operator
instructions, including the DHCP reservation, are in `docs/go-live-checklist.md`.

### Other

- HTTPS preferred; HTTP permitted so an allow-listed LAN device can be reached.
- The secret is shown to the user only once at creation; thereafter it's masked. They can rotate it any time.

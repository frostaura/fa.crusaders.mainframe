# Device discovery and board claiming

How a court box on DHCP is found by the mainframe, and how an admin connects it
to a tenant without typing an IP address.

## The problem

Carl's ESP8266 hardcodes its address:

```cpp
IPAddress local_IP(192, 168, 68, 150);
WiFi.config(local_IP, gateway, subnet);
```

That works exactly as long as nobody changes the router, the subnet, or plugs in
a second board. It is also invisible to the API: nothing announces itself, so
"connecting a board" means an admin reading an IP off a sticker.

The requirement is DHCP everywhere and no static addresses on either side.

## The constraint that shapes everything

**The API runs in a Docker container on a bridge network** (`docker-compose.yml`
gives the backend `expose: 5000` and no `network_mode`). Broadcast and multicast
frames from the club LAN do not cross a bridge. An mDNS browser or a UDP
listener inside that container hears nothing at all — not intermittently,
*never*.

This is the detail that makes naive discovery designs fail after they are
written, so it is stated first rather than in a footnote. Two consequences:

1. The discovery listener must run with **host networking**. Shipped as
   `docker-compose.onprem.yml`, an override applied at the club.
2. Because host networking is an operational choice someone can get wrong,
   **discovery must degrade rather than break.** Every automatic path has a
   manual equivalent that always works.

## Layered discovery

Tried in order. Later layers exist because earlier ones fail in ways a squash
club will actually produce.

| # | Mechanism | Why it is here |
|---|---|---|
| 1 | **Remembered address** — a claimed box persists the API URL and uses it | Covers the steady state completely. Discovery is a *first-run* and *recovery* problem, not a per-boot one |
| 2 | **UDP broadcast beacon** — box broadcasts, API answers unicast | Primary. One exchange solves both directions at once: the API learns where the box is and the box learns where the API is |
| 3 | **mDNS advertisement** — box advertises `_crusaders-box._tcp` | Interop. A laptop with any Bonjour browser sees the board, which is the difference between "the network is broken" and "the board is fine, the API cannot hear it" |
| 4 | **Subnet sweep** — box probes `/healthz` across its own /24 | Last resort, ~12s. Ugly, and the only layer that survives an access point with multicast filtering switched on — which consumer routers ship enabled |
| 5 | **Manual entry** — admin types the address | Always available. An automatic path that sometimes works is worse than a manual one that always does, if the automatic one is the only path |

Layer 4 deserves defending: it is the one that works when the AP filters
broadcast *and* multicast, which is a checkbox on the router in the clubhouse
and not something anyone will think to look at.

## Wire format

Deliberately the same shape as the serial protocol, so one mental model covers
both links:

```
CRSDR1 <VERB> key=value key=value ... *CC\n
```

- `CRSDR1` — magic and protocol version. A packet not starting with it is
  ignored without parsing.
- Fields are `key=value`, space-separated, order-independent on receipt.
- `*CC` — two uppercase hex digits, XOR of every byte between the space after
  the verb and the `*`, **exclusive of that space and inclusive of the spaces
  between fields**. UDP's own checksum is optional on IPv4 and is sometimes
  zero; this one is not.
- UDP port **48653**, both directions.

### Limits

Both implementations must agree on these or a packet one side considers valid is
garbage to the other — and nothing would go red, because a corpus only covers
the cases it contains.

| Limit | Value |
|---|---|
| Fields per packet | 12 |
| Key length | 8 |
| Value length | 64 |
| Datagram length | 320 bytes |

Exceeding any of them is `bad_frame`. An **empty value** (`mega=`) is also
`bad_frame`: absent and blank are not the same statement, and silently treating
them alike hides a firmware bug that failed to fill a field in.

### Error taxonomy and its precedence

Order matters, because more than one rule can be broken at once and the two
implementations must name the same failure.

1. `bad_frame` — shorter than the minimum, no `*CC`, malformed field, empty
   value, or any limit above exceeded. Checked **before** the magic, so an empty
   datagram is `bad_frame` rather than `bad_magic`.
2. `bad_magic` — does not begin `CRSDR1 `. Discarded without further parsing;
   port 48653 will receive unrelated traffic on a club LAN.
3. `bad_checksum` — including a *lowercase* checksum, which is `bad_checksum`
   and not `bad_frame`: it is a well-formed field carrying a value this protocol
   does not accept, for the reason given in the serial spec.
4. `bad_verb` — reachable only once the checksum has passed.
5. `duplicate_key` — a repeated key is refused rather than last-wins. Two values
   for `st` is not a packet anyone meant to send.

### `ANNOUNCE` — box → 255.255.255.255:48653

Every 5s while unclaimed, every 60s while claimed, and immediately on link-up.

| Key | Meaning |
|---|---|
| `v` | Protocol version, `1` |
| `mac` | MAC address, lowercase hex, no separators. The board's stable identity |
| `hw` | `esp8266` \| `esp32` |
| `fw` | Firmware version |
| `mega` | ATmega firmware version, omitted if not yet known |
| `st` | `unclaimed` \| `claimed` |
| `n` | 8-byte nonce, hex. Regenerated each boot |
| `cch` | Claim commitment — see below. Present only when `st=unclaimed` |
| `dev` | Device id. Present only when `st=claimed` |
| `ten` | Tenant slug. Present only when `st=claimed` |
| `up` | Uptime in seconds |
| `sig` | HMAC-SHA256 over the canonical form. Present only when `st=claimed` |

### `OFFER` — API → box, unicast to the announcing address

| Key | Meaning |
|---|---|
| `v` | Protocol version, `1` |
| `url` | Base URL of the mainframe, e.g. `http://192.168.68.20:8088` |
| `t` | Unix seconds, for the box's clock |
| `n` | Echo of the box's nonce, so an OFFER cannot be replayed at a later boot |
| `sig` | HMAC. Present only when answering a claimed box |

**A claimed box MUST refuse an unsigned `OFFER`, and one whose signature does
not verify.** This is the rule the whole OFFER signature exists for — without it
anyone on the club LAN redirects a claimed board to their own mainframe by
answering an announce faster than the real one. It was implied by "present only
when answering a claimed box" and is now stated, because an implementer reading
only the field table would have built the vulnerable version and passed every
test.

`t` is optional on receipt: a box treats an absent or unparseable value as "no
clock update" rather than rejecting the packet, since the URL is the part it
actually needs. A verified OFFER's `t` is adopted only to **bootstrap** a box
that has no clock yet, or to move a known clock **forward within the skew
window**; a value behind the box's clock, or further ahead than the window, is
counted and ignored (`DeviceClient::adoptOfferTime`). It never feeds the
reprovision strike counter, so a replayed OFFER cannot rewind a box into
re-claiming.

### Canonical form for signing

Fields other than `sig`, sorted by key, joined with `\n` as `key=value`, with
the verb prepended. Same discipline as the HTTP request signer and for the same
reason: a canonicalisation that lets two different packets produce one signing
string is a signature-reuse hole.

## Claiming a board

The security question is: an admin clicks "connect this board" in a list. How
does the API know the key it is about to issue goes to the physical board in the
cupboard, rather than to a laptop on the club WiFi that also announced?

**The board commits to a claim code it displays on its own LCD.**

1. At boot, an unclaimed box generates an 8-character claim code from the
   alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — no `I`, `O`, `0` or `1`,
   because someone reads this off a 16×2 display in an electrical cupboard and
   types it on a phone.
2. It displays the code and broadcasts
   `cch = SHA256(code || ":" || n)`, truncated to 16 lowercase hex characters
   (i.e. the first 8 digest bytes). **The code itself is never on the wire.**

   `n` here is **the ASCII text of the `n` field**, not the 8 bytes it decodes
   to. Both readings are defensible from the sentence above, they produce
   different digests, and the disagreement would surface as a claim that never
   matches — with nothing to point at. The corpus settles it; the spec now says
   it out loud.
3. The admin sees the board in the UI — by MAC, hardware and firmware — and
   types the code from the LCD.
4. The API computes the commitment for each announcer and claims the one that
   matches.

An impostor that announced a fabricated `cch` never matches. An impostor that
*copies* a real board's `n` and `cch` produces two announcers with the same
commitment, and the API then **refuses the claim and says why** — the residual
attack is denial of service, not key theft, and it is loud rather than silent.

32⁸ ≈ 1.1 × 10¹² codes, and the commitment changes every boot, so guessing is
not a path.

### After a match — the board fetches, the API does not push

The API creates the `Device` row (or re-keys the one it already has — below),
derives the key, and issues a **provisioning grant**: single-use, ten minutes,
keyed on the board's MAC and holding a hash of the claim code. The board then
collects its own key with `POST /api/v1/device/provision {mac, claim_code}`.

**The direction is inverted deliberately.** The obvious design has the API POST
the key to the address the board announced from — and that address arrived in an
unauthenticated UDP datagram from the club LAN. Dialling it is precisely what
`OutboundAddressGuard` exists to prevent, and a discovered RFC1918 address is by
definition not on its allow-list. Building a push would have carved a
member-reachable hole through the SSRF guard. Having the board fetch means
nothing dials anything and the API's outbound posture is unchanged.

The claim code is what authenticates the fetch: the board generated it, is
displaying it, and it has never been on the wire. The endpoint is anonymous by
necessity — a board collecting its first key has no credential — so its
refusals are deliberately uniform: a wrong code, an unknown MAC and an expired
grant are indistinguishable, or it becomes an oracle for which boards are
mid-claim. A wrong guess burns the grant rather than granting another turn.

The key is **also** returned to the admin and shown once (copy, dismiss, never
stored by the UI). That is a record for the operator, not a delivery path:
nothing in the firmware ingests a hand-typed key — the only credential path a
box has is `/provision`. A board that missed its grant (power-cycled between
Connect and collection, the API redeployed inside the window) is recovered by
**connecting it again**, which the next section makes possible.

The board then persists the key and switches to `claimed`. Three wrong codes lock claiming until reboot.

### Re-claiming a board the club already owns

A board that was reflashed, revoked, or that lost its key announces
`st=unclaimed` with a fresh claim code — indistinguishable from a new board
except by its MAC. The old answer to a MAC match was a refusal ("rotate that
device's key"), and since revoking left `RevokedAt` set for ever and rotation
issued no grant, a revoked box was permanently unregistrable from any product
surface. There is no `board_already_registered` refusal any more.

**A claim against a MAC this club already holds re-keys that row**
(`DeviceRegistryService.ReclaimAsync`): `KeyVersion` is bumped, `RevokedAt` is
cleared and the device re-enabled, the row takes the claim's device code, name,
court numbers and button-map override, keeps its id and its history, and a fresh
provisioning grant is issued exactly as for a new board. Audited as
`device.reclaimed` (with `was_revoked` and both key versions); the claim
endpoint's response carries `reclaimed: true`. The justification is that the
claim code read off the board's own LCD is proof of physical presence — whoever
can present it could reflash the board anyway.

This is also **how key rotation is delivered.** `POST
/admin/devices/{id}/rotate-key` bumps `KeyVersion` and shows the admin the new
key once, but the board cannot be handed it: its next signed call is refused,
the 401 strikes drop it to `CLAIM CODE`, it announces unclaimed, and the admin
connects it again from the discovered-boards list — which re-keys the same row
and issues the grant it collects. Revoke → Re-claim is the same loop; the
Devices screen offers **Re-claim** on a revoked row, pre-filling the claim form.

`board_already_claimed` still exists and means something narrower: the board is
announcing `st=claimed` with a key that still works. Rotate or revoke it, reboot
it, and it will show a new claim code.

## What is deliberately not authenticated

`ANNOUNCE` from an unclaimed board carries no signature, because an unclaimed
board has no key. It leaks a MAC, a firmware version and an uptime. That is the
same information anyone on the WiFi gets from ARP, so it is not a new exposure.

`Device.LastIpAddress` remains observability only and is never an authorisation
input, so a spoofed announce cannot escalate anything by claiming to be at a
different address.

## Failure modes worth naming

- **The AP filters broadcast.** Layers 2 and 3 die silently. Layer 4 recovers
  it; the admin sees the board appear a few seconds late rather than not at all.
- **The API is not on host networking.** Nothing is discovered, ever. The
  discovery status endpoint reports whether the listener bound successfully and
  how many packets it has seen, so this diagnoses itself instead of looking like
  a firmware fault.
- **Two boards, one claim code collision.** Astronomically unlikely by chance;
  treated as a spoof and refused either way.
- **A box shows `CLAIM CODE` after a revoke, a key rotation, or a missed
  grant.** Not a fault: connect it again. The row is re-keyed, not duplicated.
- **DHCP moves the box mid-session.** The relay auto-off timer on the Mega is
  independent of the network, so lights still release. The box re-announces on
  link-up and the API updates `LastIpAddress` on the next heartbeat.

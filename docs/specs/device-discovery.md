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
  the verb and the `*`. UDP's own checksum is optional on IPv4 and is sometimes
  zero; this one is not.
- UDP port **48653**, both directions.

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
   `cch = SHA256(code || ":" || nonce)`, truncated to 16 hex characters.
   **The code itself is never on the wire.**
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

### After a match

The API creates the `Device` row, derives the key, and POSTs it to the board's
address along with the claim code. The board checks the code against the one it
is displaying — belt and braces, because the commitment already proved it — then
persists and switches to `claimed`. Three wrong codes lock claiming until reboot.

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
- **DHCP moves the box mid-session.** The relay auto-off timer on the Mega is
  independent of the network, so lights still release. The box re-announces on
  link-up and the API updates `LastIpAddress` on the next heartbeat.

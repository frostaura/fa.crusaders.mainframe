# Court box serial protocol (ATmega2560 ↔ ESP8266)

**Link:** Mega `Serial3` (TX 14 / RX 15) ↔ ESP8266 `Serial`, 9600 8N1, line-terminated.
The DIP block routes them; **the wiring cannot change**.

## Why there is a v2 at all

Carl's protocol works and is in daily use. Two things about it cannot survive
being driven by a server rather than by a person watching a spreadsheet:

1. **`ON` has no duration.** `A` closes relay A and nothing in the firmware ever
   opens it. The off command is scheduled inside a VBA macro on a Windows PC. If
   that PC sleeps, loses the network, or the macro is stopped, **the court lights
   stay on indefinitely** — there is no timer anywhere in the device. This is the
   single most expensive failure the system can have and it is a protocol defect,
   not an implementation one: the message has nowhere to put a duration.

2. **No integrity.** 9600 baud over jumper wires next to four switching relay
   coils. A corrupted `a` that arrives as `A` turns lights on and leaves them on.
   A corrupted `A` that arrives as `a` is merely a wasted booking. There is no way
   to tell either from a legitimate command.

v2 was additive: the codec still speaks every legacy verb in both directions, and
the simulator and bench still accept them. **The production Mega does not.** It
constructs its decoder with `LegacyDialect::Refuse`, so a downlink line that does
not begin with `!` is reported as `!EVT,BADFRAME,RX` and never acted on — see
*Legacy compatibility* for why.

## Frame format

```
!VERB,arg1,arg2*CC\n
```

- `!` — sentinel. No legacy message in either direction begins with it.
- `VERB` — uppercase, 2–5 chars.
- `,` — argument separator. A literal comma inside an argument is `%2C`;
  a literal `%` is `%25`. (Only `LCD` text can contain either.)
- `*CC` — two uppercase hex digits: XOR of every byte between `!` and `*`,
  exclusive. NMEA 0183's convention, for the same reason NMEA has one.
- `\n` — terminator. A bare `\r` is also accepted; `\r\n` is one frame, not two.

A frame that fails its checksum is dropped silently and counted. It is never
guessed at: a half-understood relay command is worse than a missing one.

## Downlink — bridge → Mega

| Frame | Meaning |
|---|---|
| `!ON,<court>,<seconds>` | Close the relay for **at most** `seconds`. Duration is **mandatory**. |
| `!OFF,<court>` | Open the relay now. |
| `!EXT,<court>,<seconds>` | Extend the deadline to now + `seconds`. Refused if the relay is open. The bridge emits it itself: for a lit court whose booking outlasts the relay deadline, `bridgelogic::Relight` sends `!EXT` **60 s before each cap expiry** (`kExtLeadMs`), so a two-hour booking stays lit while the ESP lives and still fails open at the next cap when it dies. |
| `!LCD,<line1>,<line2>` | Display. Truncated to 16 columns; the panel is physically 20×4 and driven as 16×2. |
| `!AUTH,<seconds>` | Accept button input for this long. `0` disarms. When the bridge sends it is `bridgelogic::AuthPolicy`'s decision — see safety rule 2. |
| `!RST` | Relays open, buttons disarmed, default screen. |
| `!PING` | Answered with `!PONG`. |

`<court>` is `A`–`D`. `<seconds>` is 1–5400 and is clamped, never rejected: a
clamped light is a wrong-length game, a rejected one is a dark court.

## Uplink — Mega → bridge

| Frame | Meaning |
|---|---|
| `!BTN,<key>` | A debounced press. `key` ∈ `A`–`D`, `1`–`4`. |
| `!SCAN,<code>` | A complete line from the QR scanner on Serial2. |
| `!STATE,<mask>,<remA>,<remB>,<remC>,<remD>` | Relay bitmask and per-relay seconds remaining. Sent on change and every 10s. |
| `!PONG,<version>,<uptime_s>` | Answer to `!PING`. |
| `!EVT,<name>,<detail>` | `AUTOOFF,<court>` (the Mega's own timer opened the relay), `OFF,<court>` (a commanded `!OFF` opened it — emitted on **every** commanded release, so an early release is accounted for as the time actually used rather than the time booked), `AUTHEXPIRED`, `BADFRAME,RX` (also raised for any non-`!` line on the production Mega), `OVERRUN,TX`. |
| `!ERR,<code>` | `BADCRC`, `BADVERB`, `BADARG`, `NOCOURT`. |

## The two safety rules

Both live on the **Mega**, not the ESP, and hold regardless of what the ESP, the
network or the backend believe.

1. **Every `ON` carries a deadline.** There is no way to express an
   indefinite-on in v2. `RELAY_HARD_CAP_MS` (90 minutes) caps it even if a frame
   asks for more. A Mega whose bridge has been unplugged still opens its relays.

2. **Authorisation expires.** `!AUTH` arms buttons for a bounded window;
   `AUTH_TTL_MS` (30s) is the default and a lapse emits `!EVT,AUTHEXPIRED`.
   Carl's `authenticated` flag has no expiry at all, so a button pressed hours
   after someone else's scan still fires a relay on their credit.

   *Who the window is for* is the bridge's rule (`bridgelogic::AuthPolicy`), and
   it matters as much as the expiry: the window is armed **only for a recognised
   scan** — the API answered with a verdict about a known member, or the roster
   matched an entry. An unknown barcode arms nothing. A grant does not close the
   window; it **binds** it to the court it just lit, and an `OFF` press is
   honoured for that court and refused for every other (`NOT YOUR COURT /
   SCAN TO START`). Before this a scan nobody recognised opened thirty seconds
   of buttons, and the paying member's own grant closed theirs.

## Legacy compatibility

The codec (`lib/protocol`) still speaks the legacy dialect in both directions,
so the table below is what it translates — but **who opts in is per link**:

- **Production Mega (`court_mega`): `LegacyDialect::Refuse`.** The legacy `A`
  is the one message that closes a relay with no checksum, and the Mega's
  Serial3 receives the ESP8266's 74880-baud boot banner at every ESP reset, next
  to four relay coils. A bare `A` between two terminators would have been ninety
  minutes of lights with no booking, no member and no ledger row. So a downlink
  line that does not start with `!` is `!EVT,BADFRAME,RX`, never a relay change.
- **Simulator and bench: `LegacyDialect::Accept`**, explicitly, so the corpus
  and the old sketch's messages still exercise the translation.
- **The bridge's uplink decoder still accepts legacy uplink** (`A`…`D`,
  `1`…`4`, `CHECK:<code>`), which costs nothing: no uplink message can close a
  relay.

| Legacy | v2 equivalent |
|---|---|
| `A`…`D` (downlink) | `!ON,<court>,<RELAY_HARD_CAP_S>` — a legacy on gets the hard cap, because the alternative is forever |
| `a`…`d` (downlink) | `!OFF,<court>` |
| `RESET`, `ENTER CODE` | `!RST` |
| `INVALID CODE` | `!LCD,INVALID CODE,TRY AGAIN` |
| `LOW BALANCE` | `!LCD,LOW BALANCE,TOP UP` |
| `DENIED` | `!LCD,ACCESS DENIED,` |
| `<line1>\|<line2>` | `!LCD,<line1>,<line2>` plus `!AUTH,30` |
| `A`…`D`, `1`…`4` (uplink) | `!BTN,<key>` |
| `CHECK:<code>` (uplink) | `!SCAN,<code>` |

The legacy uplink/downlink collision — `A` means *button A pressed* going up and
*relay A on* coming down — is preserved rather than fixed. It is unambiguous in
practice because each end only reads one direction, and changing it would break
the compatibility this table exists to provide where it is still accepted.

## The `!WIFI` line — not a Mega verb

```
!WIFI,<ssid>,<password>[*CC]\n
```

This looks like a v2 frame and is deliberately shaped like one, but **the Mega
never sends or parses it**: it is not in the verb table, and no plausible
corruption of a Mega frame produces the prefix. It is the ESP-side USB
provisioning line. With DIP 5 and 6 ON the ESP's UART is on the USB socket
instead of the Mega, and the bridge watches the *same byte stream* it reads Mega
frames from (`bridgelogic::WifiLineAssembler`, fed byte-by-byte ahead of the
uplink decoder) for one complete `!WIFI,...` line. Values are `%`-escaped
(`,` `*` `%` as `%2C` `%2A` `%25`) and bounded by 802.11 (SSID ≤ 32, passphrase
≤ 63); the `*CC` XOR trailer is optional and verified when present. A parsed
line is written to the flash store at once and joined; the answer is on the LCD
(`WIFI SAVED / JOINING...`, `WIFI LINE BAD`, or `WIFI NOT SAVED / STORE
REFUSED`). This is what lets a box that was flashed with the credential-free CI
image be given the club's WiFi without a machine holding `secrets.h`.

## Screens the bridge paints

The Mega only ever displays what `!LCD` tells it to. These lines are the
bridge's, listed here because a technician reads them off the glass and the
spec is where their meaning is pinned:

| Line 1 / Line 2 | When |
|---|---|
| `NOT YOUR COURT / SCAN TO START` | An `OFF` press named a court the current button window does not own (safety rule 2). |
| `SLOT ENDED / SEE THE DESK` | The API activated with `granted_seconds` 0 — a rescan inside the post-slot grace window. Treated as a refusal rather than a one-second relay pulse. |
| `TRY AGAIN / SCAN TO START` | The grant was painted but the `!ON` could not be sent (full TX ring, dead cable); the court is left dark in the bridge's books so the next `!STATE` does not synthesise a Release for a session that never started. |
| `API URL TOO LONG / SEE THE DESK` | A discovered or provisioned API base URL is longer than `bridgelogic::kMaxApiUrlLen` (120). Refused rather than truncated — half a URL is a request to somewhere else. |
| `NO WIFI SET / !WIFI,SSID,PASS` | No credential from any source (no `secrets.h` at build, nothing in the store). Says what to type over USB. |
| `WIFI SAVED / JOINING...` | A `!WIFI` line parsed and persisted. |
| `WIFI LINE BAD / !WIFI,SSID,PASS` | A `!WIFI` line that did not parse (bad escape, over-long value, trailer mismatch). |
| `WIFI NOT SAVED / STORE REFUSED` | The line parsed but the flash store refused the write. |

## Points the first draft left open

Each was resolved while implementing `lib/protocol` and is recorded here so the
spec, not the code, remains the contract.

**The three refusal messages carry fixed second lines, taken from the sketch.**
They are not derivable from the command name — `DENIED` displays
`ACCESS DENIED`, and two of the three tell the player what to do about it. An
implementation that decoded these to the command text alone would show a member
*less* than the hardware shows them today, in the one place the system speaks to
someone standing at a locked court.

**`AUTH` clamps to 0..5400; `ON` and `EXT` clamp to 1..5400.** Zero seconds is
not a legal relay duration — it is an `OFF` wearing an `ON`'s clothes — but zero
is exactly how `AUTH` disarms. The lower bound is therefore per-verb.

**Clamping saturates rather than wraps.** `!ON,A,99999999999` becomes the hard
cap. A duration that wrapped to a small number would be a short game; one that
wrapped to a large number would be the failure this protocol exists to prevent.

**The checksum is uppercase-only on receipt.** The spec said uppercase and the
decoder now *enforces* it, rejecting `*4a` as a bad frame. Accepting both cases
would widen the set of byte sequences that count as a valid frame, and `a`
differs from `A` by a single bit — the exact corruption the checksum is there
to catch.

**`NOCOURT` is the decoder's to raise.** Court letters are validated during
decode, so all four `!ERR` codes are producible by the codec rather than three
of them being reserved for a layer above it.

**Argument and frame lengths are bounded**: `kMaxArgLen` 24, `kMaxFrameLen` 192.
An over-long LCD line is **truncated** — the panel is 16 columns, so the text
was going to be cut anyway. An over-long `SCAN` code is **refused**, because a
truncated member code does not fail, it identifies a *different member*.

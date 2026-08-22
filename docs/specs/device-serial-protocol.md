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

v2 is additive. Every legacy verb still works, in both directions, and a v2 Mega
paired with a legacy bridge behaves exactly as today.

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
| `!EXT,<court>,<seconds>` | Extend the deadline to now + `seconds`. Refused if the relay is open. |
| `!LCD,<line1>,<line2>` | Display. Truncated to 16 columns; the panel is physically 20×4 and driven as 16×2. |
| `!AUTH,<seconds>` | Accept button input for this long. `0` disarms. |
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
| `!EVT,<name>,<detail>` | `AUTOOFF`, `AUTHEXPIRED`, `BADFRAME`, `OVERRUN`. |
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

## Legacy compatibility

Accepted, and emitted when talking to a legacy peer:

| Legacy | v2 equivalent |
|---|---|
| `A`…`D` (downlink) | `!ON,<court>,<RELAY_HARD_CAP_S>` — a legacy on gets the hard cap, because the alternative is forever |
| `a`…`d` (downlink) | `!OFF,<court>` |
| `RESET`, `ENTER CODE` | `!RST` |
| `INVALID CODE` / `LOW BALANCE` / `DENIED` | `!LCD` with the same two lines |
| `<line1>\|<line2>` | `!LCD,<line1>,<line2>` plus `!AUTH,30` |
| `A`…`D`, `1`…`4` (uplink) | `!BTN,<key>` |
| `CHECK:<code>` (uplink) | `!SCAN,<code>` |

The legacy uplink/downlink collision — `A` means *button A pressed* going up and
*relay A on* coming down — is preserved rather than fixed. It is unambiguous in
practice because each end only reads one direction, and changing it would break
the compatibility this table exists to provide.

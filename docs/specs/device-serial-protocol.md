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
  a literal `%` is `%25`. (Only display text — `LCD` and `ROW` — and the
  scanner's `SCAN`, `EVT` and `ERR` arguments can contain either; every other
  argument on this wire is numeric or a single letter and never escapes.)
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
| `!EXT,<court>,<seconds>` | Extend the deadline to now + `seconds`. Refused with `!ERR,BADARG` if the relay is open — which the bridge reads as "that court is already dark", forgetting the extension rather than re-sending it. The bridge emits `!EXT` itself: for a lit court whose booking outlasts the relay deadline, `bridgelogic::Relight` sends one **60 s before each cap expiry** (`kExtLeadMs`), so a two-hour booking stays lit while the ESP lives and still fails open at the next cap when it dies. A lost `!EXT` is re-sent once by `bridgelogic::OnRetry`, on the same rule as a lost `!ON`. |
| `!LCD,<line1>,<line2>` | The two-row form, kept. Stages rows 0 and 1 and commits them with the default hold, so it is an overlay with a deadline like every other screen. Text is truncated at `court::kLineLen` — **20** columns, not 16; see *Screens, and who owns the glass*. |
| `!ROW,<row>,<text>` | Stage one row of the pending overlay. **Paints nothing**; `!SHOW` commits. `<row>` is `0`–`3`, and a row index the protocol does not have is **`!ERR,BADARG`** — never folded onto the last row. |
| `!SHOW,<seconds>,<flags>` | Commit the staged rows **atomically** and arm their revert deadline. `<seconds>` is clamped into **[1, 120]**. `<flags>` bit0 = countdown in the action row's right-hand cells; bit1 = replace the action row only, leaving rows 0–2 untouched. |
| `!IDLE,<flags>,<hhmm>` | What the Mega-rendered landing screen's status row says. `<flags>` bit0 WiFi up, bit1 API reachable, bit2 clock trusted, bit3 a power-dip restore still pending. `<hhmm>` is four digits of club-local wall time, or `----` when the box does not trust its clock. |
| `!MAP,<n0>,<n1>,<n2>,<n3>` | The club's court number behind each relay index; `0` is unmapped, and an unmapped relay renders **blank** rather than as a dark court — the box does not drive it and should not claim to. Values clamp to `[0, 9999]`: a label that will not fit four columns of a character LCD is a label this glass cannot show whatever it does. |
| `!AUTH,<seconds>` | Accept button input for this long. `0` disarms. When the bridge sends it is `bridgelogic::AuthPolicy`'s decision — see safety rule 2. |
| `!RST` | Relays open, buttons disarmed, landing screen. |
| `!PING` | Answered with `!PONG`. |

`<court>` is `A`–`D`. A relay `<seconds>` is 1–5400 and is clamped, never
rejected: a clamped light is a wrong-length game, a rejected one is a dark
court. **A `!SHOW` hold is clamped to a different pair of bounds**, [1, 120] —
see *Safety rule 3*, which is what makes the two ranges separate fields in
`kVerbSpecs` rather than one global constant.

## Uplink — Mega → bridge

| Frame | Meaning |
|---|---|
| `!BTN,<key>` | A debounced press. `key` ∈ `A`–`D`, `1`–`4`. |
| `!SCAN,<code>` | A complete line from the QR scanner on Serial2. |
| `!STATE,<mask>,<remA>,<remB>,<remC>,<remD>` | Relay bitmask and per-relay seconds remaining. Sent on change and every 10s. **The Mega is the authority on the relay deadline and the bridge consumes both fields:** the mask reconciles held state (`bridgelogic::reconcile`), and the per-court seconds correct the deadline `bridgelogic::Relight` only *believes* it moved when it sent an `!EXT` — so an extension lost on the wire is detected within one `!STATE` and re-sent, instead of the court going dark half an hour later. |
| `!PONG,<version>,<uptime_s>` · `!PONG,<version>,<uptime_s>,<tx_dropped>,<rx_errors>,<unauthorised>` | Answer to `!PING`. **Two arguments or five**, and the three counters are additive: a bridge flashed ahead of the Mega it is wired to must still read the answer, and the Mega is the half that cannot be reflashed over the air, so the two-argument form still decodes. The counters are the Mega's own since-boot totals (`courtlogic::CourtBox`), which existed already and which nothing off the board could read — so a climbing "presses thrown away because the window was shut", from a stuck button or a bridge that stopped sending `!AUTH`, was invisible from the office. The contract on the bridge side is a **per-heartbeat diff reported as a fault**, which is what `bridgelogic::FaultLog::noteMany` is for: a diff of zero notes nothing at all, so a quiet link never opens a window. |
| `!EVT,<name>,<detail>` | `AUTOOFF,<court>` (the Mega's own timer opened the relay), `OFF,<court>` (a commanded `!OFF` opened it — emitted on **every** commanded release, so an early release is accounted for as the time actually used rather than the time booked), `AUTHEXPIRED`, `BADFRAME,RX` (also raised for any non-`!` line on the production Mega), `OVERRUN,TX`. |
| `!ERR,<code>` | `BADCRC`, `BADVERB`, `BADARG`, `NOCOURT`. `BADCRC` — and the `!EVT` reports `OVERRUN,RX` and `BADFRAME,RX` — all mean "your last line did not decode", and the bridge re-sends the last relay-affecting frame (`!ON` or `!EXT`) once if one is inside its 1.5 s window. **`BADFRAME,RX` is the commonest of the three**, not the rarest: the production Mega refuses the legacy dialect and classifies a line by its first byte, so a glitch byte landing on an idle line ahead of an `!ON` produces `BADFRAME`, not `BADCRC`. |

## The three safety rules

All three live on the **Mega**, not the ESP, and hold regardless of what the ESP, the
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

3. **Every screen expires, and the clamp is on the way IN.** `!SHOW`'s hold is
   clamped by the **decoder**, into `[kShowHoldMinSeconds, kShowHoldMaxSeconds]`
   = [1, 120] seconds, before any `Frame` exists. That is the argument, and it
   is worth stating as a property rather than as a number: **no screen a bridge
   paints can persist past two minutes** — not one from a confused firmware, not
   one from a firmware that does not exist yet, and not one from a bridge that
   has stopped running at all, because the deadline is held by the half that
   does not go away. A screen added next year inherits it without anybody
   remembering to add a timeout, which is what makes this structural rather than
   a timeout written into each screen.

   The lower bound exists for the same reason `ON`'s does: zero is a permanent
   screen wearing a timeout's clothes if any consumer reads it as "no limit". A
   hold is **clamped, never refused** — a refused hold is a screen with no
   deadline at all, which is the bug.

   **The two clamps are different fields, not one constant.** `VerbSpec` carries
   `minSeconds` / `maxSeconds` per verb because the two durations on this wire
   bound different things: a relay duration is bounded by the ninety-minute hard
   cap that stops an unattended court burning, and a screen hold by the two
   minutes that stop a screen becoming permanent. One constant serving both
   would have let a `!SHOW,5400` stand on the glass for an hour and a half.
   `static_assert`s in `protocol/Protocol.h` hold `SHOW`'s clamped argument, its
   upper bound and its non-zero lower bound, so widening it is a build failure
   rather than a refusal screen standing all evening with every button dead
   behind it.

   **This is why `!LCD` was kept rather than replaced.** It stages rows 0 and 1
   and commits them with the default hold, so the fix holds for a bridge that has
   **not** been reflashed: an un-upgraded bridge sending only `!LCD` can no
   longer produce a screen that never leaves.

## The verb table is append-only, and that is load-bearing

`kVerbCount` went from 14 to 18 by **appending** `ROW`, `SHOW`, `IDLE` and `MAP`
to the end of `proto::Verb` — after the uplink block rather than beside the
other downlink verbs, because direction is `kVerbSpecs`'s business and the
decoder's, not the enum's ordering.

**`kVerbSpecs` is indexed by the verb's value.** A row in the wrong place would
silently give every verb someone else's grammar — `ON` would inherit `OFF`'s
arity and lose the mandatory duration that is the whole reason v2 exists.
`verbSpecsAreInEnumOrder()` is a `constexpr` check that fails the build instead.
It is written recursively, with one return statement, on purpose: the header has
to be valid **C++11** as well as C++17, because the Arduino AVR core hard-codes
`-std=gnu++11` and the generated sketch is the route a box is actually flashed
by. Do not simplify it back to a loop — the PlatformIO build will stay green and
`make arduino-check`'s compile will not.

So: **never reorder, never insert, only append.**

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

## Screens, and who owns the glass

**The Mega owns the glass; the bridge owns the words.** That split is new and it
is the same argument as the relay auto-off timer's — the ESP is the half that
goes away, so a revert timer living on it is a timer that stops the moment the
thing it was going to rescue you from happens. What lives on the Mega
(`courtlogic::ScreenBuffer`) is the **landing screen**, the **overlay
deadline**, the **hint row** and the **live court row**; the Mega also already
holds the truth worth showing, because `RelayGuard` is the authority on every
court's remaining time and rendering it locally costs zero link bandwidth. What
stays on the bridge is the **copy**: verdict wording is exactly the thing a club
changes its mind about, and the Mega is the half that cannot be reflashed
without a screwdriver.

Two screens are therefore the Mega's own and arrive from no frame at all: the
landing screen (`CRUSADERS COURTS / SCAN YOUR CODE`), painted at power-on and
on `!RST`; and the scan feedback (`CHECKING YOUR CODE … Please wait`), painted
the instant a scan completes, before any answer exists. The second exists
because v2 moved every scan-path LCD write to the ESP, so with the bridge
crashed, rebooting or mid-failed-flash a scan produced **no visible change** and
members re-scanned until they reported the scanner as broken. It is local
feedback only — no decision moves onto the Mega — and the bridge's own answer
replaces it within a second when the bridge is alive.

The lines below are the **bridge's**, listed here because a technician reads
them off the glass and the spec is where their meaning is pinned:

| Line 1 / Line 2 | When |
|---|---|
| `NOT YOUR COURT / SCAN TO START` | An `OFF` press named a court the current button window does not own (safety rule 2). |
| `SLOT ENDED / SEE THE DESK` | The API activated with `granted_seconds` 0 — a rescan inside the post-slot grace window. Treated as a refusal rather than a one-second relay pulse. |
| `TRY AGAIN / SCAN TO START` | The grant was painted but the `!ON` could not be sent (full TX ring, dead cable); the court is left dark in the bridge's books so the next `!STATE` does not synthesise a Release for a session that never started. |
| `CONNECTED / SCAN TO START` | The box is on the club WiFi. Painted once at the end of `setup()` and again on the first `!PONG` of the boot, so it appears in the **run** DIP position — including after a USB flash of the ESP, where the Mega was not on the other end of the UART to receive it. |
| `CRUSADERS COURTS / SCAN TO START` | The box is **not** on the WiFi. Deliberately the same words the Mega paints when it is idle: the court still works offline from the roster cache, so the glass does not shout an error at a member who can simply scan. Same two paint points as the line above. |
| `CODE USED / WAIT 30 SECONDS` | A single rotating member code (bridge 2.1.0) that this box, offline, or the server (`code_used`) has already acted on. The member's next code, thirty seconds later, works. Since bridge 2.2.1 the same code rescanned on the court it lit here, while that court is still on, reads `COURT B IS ON / ALREADY LIT` instead, with the OFF bound to that court — the re-scan guard's screen — and buys nothing. |

The D10 pay-for screens (`CT2 BOOKED / PAY 50 MIN? / PRESS CT2 TO PAY` and its answers) are
staged with `!ROW`/`!SHOW` like every other multi-row screen; their exact text and the proof that
each fits the safe subset are in [`member-code.md`](member-code.md) §9.3. **Member codes add no
verb, no frame and no argument to this protocol**: a v1 code is 19 characters and travels in the
`!SCAN` argument the Mega already bounds at 24.

Those are the only two identity screens, and there are no others to add. There
is no claim-code screen, because there is nothing to claim: the API base URL and
the device API key are compiled into the image alongside the WiFi credential
(`secrets.h`, four values, all mandatory) and a change to any of them is a
reflash. There is no WiFi-provisioning screen either, so there is no line for a
technician to type — `!WIFI` was a verb of this protocol until firmware 1.2.0
and is not one now.

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
An over-long row of text is **truncated** — the panel is 20 columns, so the text
was going to be cut anyway. An over-long `SCAN` code is **refused**, because a
truncated member code does not fail, it identifies a *different member*. **A
`!ROW` index is refused rather than truncated or clamped**, and that is the
third behaviour rather than a variant of one of the first two: a wrong row index
is the one argument whose being wrong puts the text *somewhere the sender did
not mean*, silently. `!ROW,4` on a four-row protocol is a peer that disagrees
with this one about the hardware, and folding it onto row 3 would hide that
disagreement behind a screen that merely looks odd.

**`proto::kMaxRows` is a PROTOCOL constant, not a display one.** The wire means
the same thing whatever panel is fitted, so `!ROW,3` is a well-formed frame on a
box built for a 1602 and the **display layer** is what drops a row it does not
have. The two are held together by a `static_assert` on the device side
(`courtlogic/CourtBox.cpp`), which is where a header that knows about both
belongs — the same rule `bridgelogic/RosterTokenFits.h` follows.

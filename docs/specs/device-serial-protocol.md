# Court box serial protocol (ATmega2560 ↔ ESP8266)

**Link:** Mega `Serial3` (TX 14 / RX 15) ↔ ESP8266 `Serial`, 9600 8N1, line-terminated.
The DIP block routes them; **the wiring cannot change**.

> **This document specifies v3: court_mega 3.0.0 with court_bridge 3.0.0.** No board has a remote
> firmware update ([`device-api.md`](device-api.md) §7), and the Mega is the half of the box that is
> hardest to reach — so the 3.0.0 Mega image is meant to be its **last**, and everything the bridge
> may one day need the Mega to do is in this chapter or it does not exist. The v2 sections below stay normative wherever [v3](#v3--court_mega-300-and-court_bridge-300)
> does not override them, and every v2 frame is still accepted by a v3 Mega, because the two chips are
> flashed one after the other and a 2.3.0 bridge talks to a 3.0.0 Mega in between. Where a v2 sentence
> below is no longer true it says so in place. The fixtures are `serial/` (frames) and `display/`
> (landing, marquee, screen CRC) in `src/contracts/device-protocol`.

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
| `!EXT,<court>,<seconds>` | Extend the deadline to now + `seconds`. Refused with `!ERR,BADARG` if the relay is open — which the bridge reads as "that court is already dark", forgetting the extension rather than re-sending it. The bridge emits `!EXT` itself: for a lit court whose booking outlasts the relay deadline, `bridgelogic::Relight` sends one **60 s before each cap expiry** (`kExtLeadMs`), so a two-hour booking stays lit while the ESP lives and still fails open at the next cap when it dies. A lost `!EXT` is re-sent once by `bridgelogic::OnRetry`, on the same rule as a lost `!ON`. Since bridge 2.3.0 it is also how a paid **extension at the panel** reaches the relay (`min(5400, remaining + extended_minutes × 60)`), and since Mega 2.1.0 an accepted `!EXT` is followed at once by a `!STATE` carrying the new deadline. |
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
| `!BTN,<key>` | A debounced press. `key` ∈ `A`–`D`, `1`–`4`. **Court keys `A`–`D` are sent whether or not the window is armed** (Mega 2.1.0) — the bridge answers an unscanned court press with the court's minutes left (`SCAN TO EXTEND`) or `SCAN YOUR CODE`. **Duration keys `1`–`4` are sent only while armed**; outside the window they are dropped, counted (`unauthorised`) and answered on the Mega's own glass. |
| `!SCAN,<code>` | A complete line from the QR scanner on Serial2. |
| `!STATE,<mask>,<remA>,<remB>,<remC>,<remD>` | Relay bitmask and per-relay seconds remaining. Sent on change and every 10s. **The Mega is the authority on the relay deadline and the bridge consumes both fields:** the mask reconciles held state (`bridgelogic::reconcile`), and the per-court seconds correct the deadline `bridgelogic::Relight` only *believes* it moved when it sent an `!EXT` — so an extension lost on the wire is detected within one `!STATE` and re-sent, instead of the court going dark half an hour later. |
| `!PONG,<version>,<uptime_s>` · `!PONG,<version>,<uptime_s>,<tx_dropped>,<rx_errors>,<unauthorised>` | Answer to `!PING`. **Two arguments or five**, and the three counters are additive: a bridge flashed ahead of the Mega it is wired to must still read the answer, and the Mega is the half that is hardest to reflash, so the two-argument form still decodes. The counters are the Mega's own since-boot totals (`courtlogic::CourtBox`), which existed already and which nothing off the board could read — so a climbing "presses thrown away because the window was shut", from a stuck button or a bridge that stopped sending `!AUTH`, was invisible from the office. The contract on the bridge side is a **per-heartbeat diff reported as a fault**, which is what `bridgelogic::FaultLog::noteMany` is for: a diff of zero notes nothing at all, so a quiet link never opens a window. |
| `!EVT,<name>,<detail>` | `AUTOOFF,<court>` (the Mega's own timer opened the relay), `OFF,<court>` (a commanded `!OFF` opened it — emitted on **every** commanded release, so an early release is accounted for as the time actually used rather than the time booked), `AUTHEXPIRED`, `BADFRAME,RX` (also raised for any non-`!` line on the production Mega), `OVERRUN,TX`. |
| `!ERR,<code>` | `BADCRC`, `BADVERB`, `BADARG`, `NOCOURT`. `BADCRC` — and the `!EVT` reports `OVERRUN,RX` and `BADFRAME,RX` — all mean "your last line did not decode", and the bridge re-sends the last relay-affecting frame (`!ON` or `!EXT`) once if one is inside its 1.5 s window. **`BADFRAME,RX` is the commonest of the three**, not the rarest: the production Mega refuses the legacy dialect and classifies a line by its first byte, so a glitch byte landing on an idle line ahead of an `!ON` produces `BADFRAME`, not `BADCRC`. |

## The three safety rules

All three live on the **Mega**, not the ESP, and hold regardless of what the ESP, the
network or the backend believe.

1. **Every `ON` carries a deadline.** There is no way to express an
   indefinite-on in v2. `RELAY_HARD_CAP_MS` (90 minutes) caps it even if a frame
   asks for more. A Mega whose bridge has been unplugged still opens its relays.

2. **Authorisation expires.** `!AUTH` arms the DURATION keys for a bounded
   window; `AUTH_TTL_MS` (30s) is the default and a lapse emits
   `!EVT,AUTHEXPIRED`. Carl's `authenticated` flag has no expiry at all, so a
   button pressed hours after someone else's scan still fires a relay on their
   credit.

   Since Mega 2.1.0 the window gates **duration keys only**. Court keys are
   forwarded with the window shut, because a court key on its own buys nothing
   and lights nothing — every purchase and every extension needs a duration
   press, and that is still dropped outside the window, so no press can be
   held over to the next member's scan. The bridge decides what an unscanned
   court press means: a lit court reads `COURT A 45 MIN / SCAN TO EXTEND`, a
   dark one `SCAN YOUR CODE`. If the bridge paints nothing within 1.5 s (dead,
   rebooting, mid-flash) the Mega paints `SCAN CODE FIRST` on row 1 itself.
   The `!PONG` `unauthorised` counter counts **dropped duration presses only**,
   so it still means "a press thrown away" — a stuck contact, or a bridge that
   stopped sending `!AUTH`. A court key the link itself could not carry (the
   bridge is unplugged, the TX ring is full) is answered with the hint at once —
   there is no bridge to wait for — and counted as a dropped frame (`tx_dropped`),
   not as unauthorised. Host-tested in `test_courtlogic`
   (`test_box_a_court_key_with_the_window_shut_is_forwarded_and_not_counted`,
   `test_box_the_mega_paints_its_own_hint_when_the_bridge_does_not_answer`,
   `test_box_a_court_key_the_link_cannot_carry_is_hinted_at_once`) and end to end
   by `test/e2e-device` step E-BTN-2.

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
   is worth stating as a property rather than as a number: **no single frame a bridge
   paints can hold the glass past two minutes** — not one from a confused firmware, not
   one from a firmware that does not exist yet, and not one from a bridge that
   has stopped running at all, because the deadline is held by the half that
   does not go away. A screen added next year inherits it without anybody
   remembering to add a timeout, which is what makes this structural rather than
   a timeout written into each screen.

   **v2 bounded the frame, not the screen** — and that was the gap. Every new `!SHOW`/`!LCD`
   re-armed the hold from now, and so did every debounced press, so a flapping WiFi link repainting
   the identity overlay every few seconds, or a chattering button, kept the glass off the landing
   screen indefinitely (reproduced: 10–12 minutes, FWM-02/03, DL-08). **v3 adds the absolute screen
   ceiling** ([v3 — the screen ceiling](#the-screen-ceiling-and-the-return-to-landing)): a total
   life for any non-landing state, measured on the Mega from the moment the glass left landing,
   that no frame and no press can extend.

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
landing screen, painted at power-on and on `!RST`; and the scan feedback, painted
the instant a scan completes, before any answer exists. (The words quoted here
by v2 were never what the code painted. Since v3 the landing is composed by the
rules in [v3 — the landing screen](#the-landing-screen-composed-on-the-mega), and
the scan feedback is `CHECKING CODE` / `PLEASE WAIT` from a buffer of its own.) The second exists
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
| `CODE USED / WAIT 30 SECONDS` | A single rotating member code (bridge 2.1.0) that this box, offline, or the server (`code_used`) has already acted on. The member's next code, thirty seconds later, works. Since bridge 2.2.1 the same code rescanned on the member's own court here, while that court is still on, reads `COURT B IS ON / ALREADY LIT` instead, with the OFF bound to that court — the re-scan guard's screen — and buys nothing; since 2.2.2 that includes a court the box lit online for that member (a walk-up, a pay-for, or an activation the roster does not name yet). It arms no buttons, and since 2.2.3 the bridge also forgets the scan, so a photo of a code cannot buy a walk-up or a pay-for; the server answers `code_used`, not `no_booking`, for a code already acted on at another box. Since 2.2.4 a pay-for refused `code_used` reads these same two lines (it read `CODE NOT KNOWN`), and a walk-up forgets the scan only for `code_used` or `not_recognised` — `TOO LONG / TRY LESS TIME` keeps it, so the shorter press it asks for still buys. |
| `ONE MOMENT / Checking code` | An online activation is in flight (bridge 2.2.3; six seconds at most). `ONE MOMENT / Buying your time` is the walk-up's wait and is never painted for an activation. |
| `NO CONNECTION / SEE THE DESK` | The roster is stale — no heartbeat for `ROSTER_MAX_AGE_MS` (six hours) — and the backend could not be asked. A code the box simply does not hold reads `NOT RECOGNISED / SEE THE DESK`. |

**The D10 pay-for screens are gone from the image** (bridge 3.0.0, founder 2026-11-13): the flow
had been unreachable from the panel since 2.3.0, and dead code in an image is debt. The server
still serves `/api/v1/device/pay-for` ([`member-code.md`](member-code.md) §9) and v3 needs nothing
new from the Mega to bring it back, so D10 can return by a bridge flash alone. **Member codes add no
verb, no frame and no argument to this protocol**: a v1 code is 19 characters and travels in the
`!SCAN` argument the Mega already bounds at 24.

**Superseded by v3.** The two identity overlays above are not painted by a 3.0.0 bridge: they were
painted on every WiFi edge as a bare `!LCD` held for the Mega's fixed 10 s, so a marginal access
point kept them up instead of the landing screen (DL-08, BR-10). The landing's status item
(`READY` / `NO WIFI` / `NO SERVER` / `STARTING UP`) says the same thing without leaving landing.
And the compiled values are no longer the only ones: WiFi credentials, the server URL and the
device key are runtime-changeable without a cable ([`device-api.md`](device-api.md) §5, §6 and
§8), and the setup portal is entered by a button gesture the Mega reports as `!HELD`. There is
still no `!WIFI` verb: credentials never cross this link, because the Mega has no business
holding them.

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

## v3 — court_mega 3.0.0 and court_bridge 3.0.0

### Why v3, and the one rule that shapes it

The 2026-11-13 analysis (fourteen lanes, two whole-box harnesses running the real Mega and the
real bridge over a modelled UART) found that the link loses frames in ordinary operation and
that nothing on the Mega bounds a screen's total life. The worst of it, reproduced: a fast
server makes the bridge silently refuse the `!ON` of an online activation because the ESP8266's
128-byte hardware TX FIFO still holds the wait screen (DL-01, FSF-01); a full-screen paint
blocks the Mega for 110–150 ms while its 64-byte RX ring overflows and eats the `!ON` of a
walk-up (DL-02, FSF-02); a Mega-only reset darkens every lit court and nothing relights it
(FWM-01, DL-03, FSF-03); one I2C timeout blanks the landing's call to action for good (DL-04,
FSF-07); and repeated frames or a chattering button keep the glass off landing indefinitely
(FWM-02, FWM-03, DL-08).

**3.0.0 is meant to be the last Mega image.** Neither chip is updated over the air
([`device-api.md`](device-api.md) §7), and the Mega never could be — its ESP sits on Serial3,
not the bootloader port, and no GPIO reaches RESET — so a Mega change is always the full DIP
procedure at the box, while a bridge change is one upload. So v3 turns the Mega into a **generic
renderer and relay guard whose behaviour the bridge steers, with every timeout bounded on the
Mega itself**: anything a future bridge might want from it is a frame defined here, every
setting is a bounded `!CFG` key, and no frame from any bridge, present or future, can stop the
Mega returning to landing, opening a relay at its deadline, or noticing that the bridge died.

### Versions, and which dialect each side speaks

| Mega | Bridge | What happens |
|---|---|---|
| 3.0.0 | 3.0.0 | v3 throughout. |
| 3.0.0 | 2.3.0 | The flash window (Mega first, then bridge). The v3 Mega accepts every v2 frame: untagged relay frames, `!ROW`/`!SHOW`, `!LCD`, `!IDLE`, `!MAP`. The v3 rules that need no bridge cooperation still hold — the screen ceiling, presses never re-arming a hold, staging cleared after each commit, the self-healing glass, the authorisation cap, `!ON` never shortening — and the bridge-liveness verdict uses the **legacy timeout** (330 s, longer than the widest heartbeat cadence) because a 2.3.0 bridge sends no `!LIVE`. The 2.3.0 bridge decodes `!BOOT`, `!ACK`, `!DIAG` and `!HELD` as `BADVERB` and ignores them, which is harmless. |
| 2.1.0 | 3.0.0 | A bridge flashed first, or a Mega flash that failed. The bridge reads the Mega's version from `!PONG` (2.1.0 sends no `!BOOT`) and speaks **v2 only** to a Mega older than 3.0.0: no tags, `!ROW`/`!SHOW` instead of `!RW`/`!CMT`, no `!WANT` (one `!ON` per relay instead), no `%21` (a 2.1.0 decoder refuses any escape but `%2C` and `%25`, so the bridge replaces `!` in text before encoding). Until it has heard a version it speaks the v2 subset and **sends no relay frame at all** (BR-05). |
| 2.1.0 | 2.3.0 | Today's pair; unchanged. |

Dialect is decided per Mega boot: a `!BOOT` or a `!PONG` naming `3.x` switches the bridge to
v3, and a `!PONG` naming anything older switches it back. Versions compare as three numbers.

### The new frames

Verbs are **appended** to `proto::Verb` in this order — `RW CMT WANT CFG LAND NOTE LIVE ACK BOOT
HELD DIAG HW` — so `kVerbCount` becomes 30 and the append-only rule above holds (`HW` is the
2026-11-13 addendum's, *Hardware facts* below). No frame grows
past `kMaxArgs` (5) or `kMaxArgLen` (24), so `Frame` keeps its size on an 8 KB chip.

**Downlink — bridge → Mega**

| Frame | Grammar and meaning |
|---|---|
| `!ON,<court>,<seconds>[,<tag>]` · `!OFF,<court>[,<tag>]` · `!EXT,<court>,<seconds>[,<tag>]` · `!AUTH,<seconds>[,<tag>]` | The v2 verbs with an **optional tag**, a decimal 1–255 with no leading zero. A tagged frame is answered `!ACK,<tag>,<code>`; an untagged one is v2 exactly. `!ON` and `!EXT` on a lit relay set the deadline to the **later** of the current one and now + `seconds` — **neither ever shortens a lit court**; only `!OFF` (or the Mega's own deadline or cap) opens one (FSF-12). `!ON` also restarts that relay's authorisation clock (below); `!EXT` does not. `!EXT` on a dark relay is refused (`!ACK,<tag>,2`; untagged, `!ERR,BADARG` as in v2). |
| `!RW,<seq>,<row>,<off>,<text>` | Stage `text` into `row` (0–3) of screen `seq` (0–255) starting at column `off` (**0 or 24** only), so a row holds up to 48 characters in two segments. Paints nothing. |
| `!CMT,<seq>,<mask>,<hold>,<flags>,<crc>` | Commit screen `seq` atomically — see *Screens* below. `mask` 1–15 names the rows; `hold` clamps into [1, 120] like `!SHOW`; `flags` 0–255; `crc` four uppercase hex digits. |
| `!WANT,<tag>,<a>,<b>,<c>,<d>` | **The relay reconcile.** For each relay A–D, `-` (no opinion) or seconds 1–5400 (clamped, never 0): *ensure this relay is lit for at least this long*. A dark relay is closed for that long; a lit one whose deadline is sooner is extended to it; **nothing is ever opened**. It does not restart the authorisation clock, and a relay locked by the cap refuses it. Always all four relays: a reconcile is a whole snapshot, not a delta. Answered `!ACK,<tag>,0` when every opinion is now satisfied, `!ACK,<tag>,2` when any relay refused, and always followed by `!STATE`. |
| `!CFG,<tag>,<key>,<value>` | Set one Mega setting — table below. `key` is 1–6 uppercase letters, `value` 0–65535; the decoder takes any key, and the Mega answers `!ACK,<tag>,0` with the value **clamped** into the key's bounds and applied, or `!ACK,<tag>,2` for a key it does not know or a value outside an enumerated key's set, changing nothing. |
| `!LAND,<a>,<b>,<c>,<d>` | Per relay, the seconds of **paid** light left as the server's snapshot has it — chained extensions included, so it can exceed the 90-minute relay cap — or `-` for no figure. 0–86400, clamped. The Mega counts each figure down from receipt and shows the **larger** of it and its own deadline while the relay is closed; an open relay reads `OFF` whatever this says. Discarded when the bridge is declared dead. |
| `!NOTE,<ttl>,<text>` | A landing note: `text` (≤ 24) replaces the landing's status item for `ttl` seconds (0–3600, clamped; 0 clears). For the setup portal's name, an update in progress, or anything a future bridge wants a passer-by to read. Cleared when the bridge is declared dead and at Mega boot. |
| `!LIVE,<period>` | Bridge liveness: the next downlink frame will arrive within `period` seconds (1–120, clamped). A 3.0.0 bridge sends `!LIVE,5` every five seconds and, before anything that blocks it, `!LIVE` with the longer period it needs, up to `!LIVE,120`. |
| `!RST` · `!PING` · `!LCD` · `!ROW` · `!SHOW` · `!IDLE` · `!MAP` | Unchanged from v2. `!IDLE` stays the status source; a 3.0.0 bridge sends it on **every** accepted heartbeat and every 30 s rather than only on change, and records it as sent only when it was queued (DL-13, FSF-10). |

**Uplink — Mega → bridge**

| Frame | Grammar and meaning |
|---|---|
| `!ACK,<id>,<code>` | `id` is a tag 1–255, or `S<seq>` for a screen commit. `code`: **0** applied · **1** duplicate (that tag was already applied; nothing changed) · **2** refused (an `!EXT` on a dark relay, a `!WANT` relay locked by the cap, an unknown `!CFG` key) · **3** incomplete (a commit whose rows did not all arrive or whose CRC did not match; nothing painted) · **4** busy (a commit inside the landing dwell; nothing painted). |
| `!BOOT,<version>,<cause>,<held>` | The Mega's **first frame after every reset**, before the LCD is initialised: its version, the reset cause (`MCUSR`, two uppercase hex digits — bit0 power-on, bit1 external, bit2 brown-out, bit3 watchdog), and the keys held at that instant (two hex digits: bit0–3 courts A–D, bit4–7 durations 1–4). Followed at once by `!STATE`. `MCUSR` is copied to a `.noinit` variable before `.init3` clears it (FWM-12). |
| `!HELD,<mask>,<seconds>` | A set of keys held together continuously for `seconds` (5–60, clamped) by a hold that began within **60 s of Mega boot**: the setup gesture (court A + court D = `09` opens the setup portal, [`device-api.md`](device-api.md) §8). Sent once per boot when a hold first reaches 5 s. Other masks are reserved for gestures a later bridge may define; the Mega reports, the bridge decides. |
| `!DIAG,<lcd_errors>,<lcd_reinits>,<rx_overruns>,<ceilings>,<cap_offs>` | Since-boot counters, sent right after every `!PONG`: LCD bus errors — I2C timeouts **and** NACKs, so a backpack that stopped answering is counted, not silent (HW-2) — controller re-initialisations (periodic and recovery), Serial3 RX overruns, screen ceilings that forced landing, and relays opened by the authorisation cap. The bridge reports per-heartbeat rises as faults (FSF-07). |
| `!EVT,CAPOFF,<court>` · `!EVT,CEIL,` · `!EVT,LIVE,1` | New `!EVT` names: the authorisation cap opened this relay; the screen ceiling forced landing; the Mega revived a bridge it had declared dead (the bridge then re-sends the settings and landing figures). |
| `!HW,<lcd>,<rpol>,<sbaud>,<ssuf>,<keys>` | The hardware facts the Mega is **actually running with** (*Hardware facts* below): the LCD backpack address that answered, two uppercase hex digits (`00` = none answered); the relay drive level (`0` active-high, `1` active-low); the scanner baud code (`0` auto, not yet locked; `1` 9600, `2` 19200, `3` 38400, `4` 57600, `5` 115200); the scanner line end (`0` auto, `1` CR/LF only); the unarmed-forward key mask, two uppercase hex digits. Sent once the LCD is initialised, after every `!DIAG`, and whenever one of them changes. Any other value is `BADARG`. |
| `!PONG` | Unchanged; a 3.0.0 Mega always sends the five-argument form. |

Direction is part of the grammar: the Mega's decoder refuses an uplink verb and the bridge's a
downlink one (`BADVERB`), so a relay verb echoed back by a wiring fault is never acted on.

### Escaping and resynchronisation

v3 reserves `!` as the frame sentinel on **both** links. An encoder escapes `,` → `%2C`, `%` →
`%25` and `!` → `%21` in every text argument; a v3 decoder also accepts `%2A` for `*` (never
required: the checksum is the **last** `*` of the line). A v3 decoder that sees a bare `!` in
the middle of a line **abandons that line** — reported once as `BADFRAME` — and starts a new
frame there. Under v2 it waited for `\n`, so a line cut short by a lost byte swallowed the
intact `!ON` that followed it (DL-02). The checksum, the bounds and the clamp rules are
otherwise v2's.

### Acknowledgement and retry

A 3.0.0 bridge tags every `!ON`, `!OFF`, `!EXT`, `!AUTH`, `!WANT` and `!CFG` it sends a v3
Mega, from a counter that skips 0. **A frame stays pending until its `!ACK` arrives**: re-sent
after 400 ms with the **same** tag, at most three times, then reported as the fault
`mega_unacked` and, for a relay frame, painted as `TRY AGAIN` exactly as an unsendable `!ON` is
today. Unrelated frames never clear a pending one — v2's `OnRetry` was cleared by the `!AUTH`
sent right after every `!ON`, so a corrupted `!ON` was never re-sent (DL-06). The Mega keeps
the last tag applied per relay and for `!AUTH`, and answers a repeat with code 1 without
applying it again, so a retry whose first copy did arrive is harmless. The `!STATE` that
follows every relay change remains the evidence of what is actually closed; an `!ACK` only says
the frame was taken.

### The paced sender, and the Mega's pass budget

**The bridge never drops a link frame.** `sendToMega` queues into a software TX queue of at
least 1024 bytes drained into the UART FIFO each pass, never more than `availableForWrite()`
at a time and never a partial frame ahead of another frame's bytes. v2 refused any frame that
did not fit the 128-byte FIFO at that instant, which is how a fast server lost the `!ON`
(DL-01, FSF-01). Relay, `!AUTH`, `!WANT`, `!CFG` and `!ACK`-able frames go ahead of queued
screen frames but never inside one; 128 bytes of the queue are reserved for them; when the
queue is full a **screen** is dropped whole, oldest first, and counted (`screen_dropped`) — a
relay frame never is. At most **one screen is in flight** at a time: the next `!RW` series
starts after the previous `!CMT` is acknowledged or has timed out (600 ms, then re-sent once
with a new `seq`).

**The Mega drains Serial3 at least every 10 ms**, so at 9600 baud (0.96 bytes/ms) fewer than 10
bytes ever wait and the 64-byte ring cannot overflow. That bound is a property of the Mega's
loop and is what makes the line rate safe to use in full: painting is time-budgeted to **at
most 8 ms of blocking per pass** (I2C at 400 kHz, `Wire.setClock(400000)`, where the backpack
allows it; diff-painting only the cells that changed), and the decoder runs between rows and
between budgeted segments. v2 painted a whole screen synchronously, 110–150 ms at the 100 kHz
default. **The buttons are sampled inside the paint** (DL-15): the LCD driver samples the panel
between bus transactions and through every wait, at most every 0.5 ms, and a press the 80 ms
debounce completes there is latched for the next pass — so no tap held 83 ms or more is lost to
an 8 ms paint or a 10 ms re-init. The debounce rule itself is unchanged.

### Screens, staged by sequence and committed atomically

A 3.0.0 bridge paints with `!RW` and `!CMT` only. The Mega keeps one staging area tagged with
one `seq`:

- `!RW` for a `seq` other than the staging area's **clears the whole staging area** and adopts
  the new `seq`. Offset 0 sets the row's text; offset 24 pads the row with spaces to 24 and
  appends. A row never staged for this `seq` is *missing*, not blank.
- `!CMT` paints only if its `seq` is the staging area's, **every row in `mask` was staged**, and
  the CRC matches: CRC-16/CCITT-FALSE over, for each row in `mask` in ascending order, the row
  index as one byte, the row's staged text exactly as unescaped, then one `0x00` (vectors in
  `display/cases.json`, `screen_crc`). Otherwise nothing is painted and the answer is
  `!ACK,S<seq>,3`; the bridge re-sends the whole screen once under a new `seq`.
- **After every commit, good or refused, the staging area is cleared.** v2 kept it, so a lost
  `!ROW` showed the previous screen's text under the next verdict (`TOO FEW MINUTES / BALANCE 120
  MIN`, FWM-06, DL-09). The v2 `!ROW`/`!SHOW` pair from a 2.3.0 bridge also clears staging after
  each `!SHOW`.
- The Mega's own scan feedback is painted from a constant buffer of its own and never touches
  the staging area, so a scan completing mid-stage cannot tear the bridge's screen (FWM-07).
- `flags`: bit0 **countdown** in the action cells (compact: row 1, columns 13–15; expanded: row
  3, columns 17–19); bit1 **keep** — rows outside `mask` keep the current overlay's text instead
  of going blank (the v2 action-row-only update, generalised); bit2 **chain** — when this screen's
  hold ends, wait up to 500 ms for the next commit before painting landing, so a greeting
  followed by its outcome does not flash the landing between them (DL-14). Bits 3–7 must be 0
  from a 3.0.0 bridge and are ignored by the Mega.
- A row longer than the layout's width scrolls as a marquee (below) when the marquee is on, and
  is cut at the width when it is off. **Only one row of a screen scrolls**: the lowest-numbered
  over-width row; any other over-width row is cut.
- The layout decides the glass, not the frame: in **compact** only rows 0–1 and columns 0–15
  are drawn; in **expanded** rows 0–3 and columns 0–19. The bridge composes each screen for the
  layout the Mega has acknowledged.

### The screen ceiling, and the return to landing

These hold on the Mega whatever any bridge sends, so a bridge defect found next year cannot
reintroduce a stuck screen.

1. **The ceiling.** From the moment the glass leaves landing, the total time off landing is
   counted. When it reaches `CEIL` seconds the Mega paints landing, sends `!EVT,CEIL,`, counts
   it in `!DIAG`, and holds landing for `DWELL` seconds, answering any commit in that time
   `!ACK,S<seq>,4` — **unless** the Mega has forwarded a `!SCAN` or `!BTN` since the ceiling
   fired, because then the commit is the answer to a member standing there. New frames do not
   extend the ceiling; **only a completed scan restarts it**, because a scan is a new member
   interaction and nothing else is.
2. **Presses never re-arm a hold** (FWM-03, DL-07, BR-21). A press is forwarded or dropped; it
   does not touch the overlay's deadline. A duration press dropped because the window is shut
   **ends** the overlay — landing, with the hint — rather than extending it.
3. **After the lights go on, landing within `AFTON` seconds.** A relay that goes from open to
   closed (by `!ON` or `!WANT`) caps whatever overlay is up, and any committed in the next
   `AFTON` seconds, to end by then.
4. **A forwarded press the bridge does not answer within 1.5 s gets the Mega's own hint**,
   whether or not the window was armed (FWM-15): `ONE MOMENT` while the bridge is alive,
   `NO CONNECTION` when it is dead. A hint asked for inside the 2 s rate limit is **deferred** to
   the limit's end, never dropped, unless a bridge screen arrives first or the same hint is already on the glass, which is never extended (FSF-11, E-BTN-1). The hint's
   rate-limit deadline is disarmed once it expires,
   so it cannot go silent for 24.8 days after a 2³¹ ms quiet spell (FWM-13).
5. **The scan feedback** (`CHECKING CODE` / `PLEASE WAIT`) holds `SCANH` seconds, under the
   ceiling; with the bridge dead it is `NO CONNECTION` / `SEE THE DESK` instead, because there
   is nobody to check the code (FWM-08, DL-10).
6. **The scanner assembler ends a line on CR, LF or an idle gap** of `SGAP` ms (default 150).
   At the gap, a partial line of at least 8 printable characters is a scan (a scanner configured
   with no suffix still works, HW-5) and anything shorter is discarded, so one stray byte is never
   glued onto the next member's code (FWM-14). With `SSUF` 1 the gap only discards. A 9600-baud
   scanner streams a whole 19-character code in about 20 ms with no gap inside it.

### The landing screen, composed on the Mega

The Mega composes the landing from what it holds — `RelayGuard`'s deadlines, `!MAP`'s court
numbers, `!LAND`'s paid seconds, `!IDLE`'s status, `!NOTE` — at zero link cost. The reference
composition, every rule below as code, is `display/gen_cases.py`; its 19 `landing` vectors are
what the Mega and the console's preview are tested against.

- **Row 0, the call to action**, centred: `SCAN YOUR QR CODE` (expanded) or `SCAN YOUR QR`
  (compact: the full sentence is 17 characters and a scrolling call to action cannot be read at
  a glance). `OUT OF SERVICE` when the bridge is dead.
- **The courts**: every mapped relay, in relay order — an unmapped one is never drawn, and before
  the first `!MAP` there are none. Lit reads `COURT 3   ON 45 MIN` (expanded) or `COURT 3   45 MIN`
  (compact), dark reads `COURT 3 … OFF`; the label shortens to `CT 1234` only when it would not
  fit beside the state. Minutes are rounded **up** (20 s of light is `1 MIN`) and capped at 999
  shown; the seconds are the larger of the Mega's own deadline and the `!LAND` figure.
- **The status item**: the `!NOTE` if one is live, else `READY 18:05` (or `READY` with no trusted
  clock), `STARTING UP` (from Mega boot until the first `!IDLE`, and while `!IDLE` bit3 says a
  restore is pending), `NO WIFI`, `NO SERVER`; `SEE THE DESK` when the bridge is dead.
- **Expanded (20×4)**: rows 1–3 show the court rows followed by the status item, three at a time,
  turning a page every `PAGE` seconds counted from landing entry.
- **Compact (16×2)**: row 1 is either a **marquee** (marquee on) of every court and the status
  joined by three spaces — static if it fits — or (marquee off) **one court per page**, then the
  status, turning every `PAGE` seconds.
- **The glass heals itself** (FWM-04, DL-04, DL-05, FSF-07). The Mega keeps a shadow of what it
  believes is on the glass and diff-paints toward it every pass within the paint budget; after
  any I2C resync it marks every cell dirty and repaints all rows; and on landing it re-runs the
  HD44780 initialisation and a full repaint every `REINIT` seconds and on every return to
  landing, so a nibble desync that no bus timeout reports is corrected within a minute. During a
  bus holdoff the Mega's notion of the glass is "unknown", never "landing". At boot it probes
  the backpack (`LCDA`, *Hardware facts* below) and reports the address that answered (FWM-10,
  HW-2).

### The marquee

Software, one row, never the HD44780 display shift — that shifts every line together, and on a
1602 driven with 20×4 offsets it scrolls off-glass rows into view (BR-20, FSF-13). The visible
window is the text, three spaces, the text again, advancing one character every `STEP`
milliseconds from the moment the row was committed (`display/cases.json`, `marquee`). Each step
repaints only the cells that changed, inside the paint budget; at 400 ms a step costs a few
milliseconds of I2C a second. A marquee pauses while an overlay covers its row.

### The Mega's settings

Each is held in RAM, set by `!CFG`, clamped into the Mega's own compile-time bounds, and reset
to its boot default when the Mega restarts. A 3.0.0 bridge re-sends the whole set at every Mega
boot and after every accepted heartbeat; it is idempotent. **Layout falls back to compact on any
doubt**: at boot, while the bridge is dead, and for any `LAYOUT` value but 0 or 1.

| Key | Meaning | Bounds | Boot default | From (`tenant_settings.<key>`, delivered in the heartbeat `config`) |
|---|---|---|---|---|
| `LAYOUT` | 0 compact (16×2), 1 expanded (20×4) | {0, 1} | 0 | `lcd_layout`, with a per-board override |
| `MARQ` | marquee on long rows | {0, 1} | 1 | `lcd_marquee_enabled`, with a per-board override |
| `STEP` | marquee step, ms | 250–1000 | 400 | `lcd_marquee_step_ms` |
| `PAGE` | landing page turn, s | 2–15 | 4 | `lcd_landing_page_seconds` |
| `CEIL` | screen ceiling, s | 15–120 | 60 | `lcd_screen_ceiling_seconds` |
| `DWELL` | landing hold after a ceiling, s | 0–10 | 3 | `lcd_landing_dwell_seconds` |
| `AFTON` | back to landing after lights on, s | 5–60 | 15 | `lcd_after_lights_on_seconds` |
| `REINIT` | controller re-init on landing, s | 30–600 | 60 | `lcd_reinit_seconds` |
| `HINT` | the Mega's own hint, s | 1–10 | 3 | `lcd_hint_seconds` (BR-15: the setting finally reaches the glass) |
| `SCANH` | scan feedback hold, s | 3–60 | 10 | `lcd_revert_seconds` (FWM-16) |
| `CAP` | relay authorisation cap, minutes | 90–720 | 240 | `relay_authorisation_cap_minutes` |
| `RPOL` | relay drive level: 0 active-high, 1 active-low | {0, 1} | the compiled `RELAY_ACTIVE_LOW` (0) | `hw_relay_active_level`, per-board override |
| `LCDA` | LCD backpack address: 0 probe, else the address | {0, 32–39, 56–63} | 0 | `hw_lcd_i2c_address`, per-board override |
| `SBAUD` | scanner baud: 0 auto, 1–5 as `!HW` | {0–5} | 0 | `hw_scanner_baud`, per-board override |
| `SSUF` | scanner line end: 0 CR/LF or gap, 1 CR/LF only | {0, 1} | 0 | `hw_scanner_line_end`, per-board override |
| `SGAP` | scanner idle gap, ms | 50–500 | 150 | `hw_scanner_gap_ms`, per-board override |
| `KEYS` | keys forwarded as `!BTN` while the button window is shut, bit *i* = key *i* | 0–255 | 15 (`0x0F`) | derived by the bridge from `button_map` |

`CEIL`'s upper bound is `kShowHoldMaxSeconds` and a `static_assert` holds the two together. A
value outside an **enumerated** key's set (`LAYOUT`, `MARQ`, `RPOL`, `LCDA`, `SBAUD`, `SSUF`) is
refused (`!ACK,<tag>,2`) and changes nothing; every other key clamps.

### Hardware facts the Mega must never have compiled in (addendum, 2026-11-13)

A late analysis (`HW-1`…`HW-11`) found that every hardware fact the court box fixed at build
time was evidenced by a sentence, an old sketch or a photo nobody can find, and that the one
that matters most — the relay drive level — was a single constant whose failure mode was every
court lit all night. On the last Mega image each becomes a `!CFG` key with a safe boot default,
delivered by the backend per board ([`device-api.md`](device-api.md) §12), and each effective
value is reported back in `!HW`.

- **A relay is released by making its pin an input, never by driving it** (HW-1). Off is
  `DDR = 0` first, then `PORT = 0` (at worst a momentary weak pull-up, which is off for either
  module); on is `PORT = <level>`, then `DDR = 1`. A high-Z input is **off for both** a
  low-trigger module (input pulled to VCC) and a high-trigger one (an LED or transistor to GND),
  so **a wrong `RPOL` fails dark, never lit**: "on" drives the module's own idle level. This is
  why `RPOL` can be changed remotely and at any time: on a change the Mega re-drives every closed
  relay at the new level, and an open relay stays an input. It also removes the need for the
  pull-down the 2.1.0 notes asked an installer to fit, which the wiring rule forbids. `RPOL` is
  RAM, reset to the compiled default at boot like every `!CFG` key; the bridge persists the
  board's value and re-sends the whole set before any relay frame after every `!BOOT`.
- **The LCD address is probed, not assumed** (HW-2). With `LCDA` 0 the Mega tries 0x27, then
  0x3F, then 0x20–0x26 and 0x38–0x3E, in that order, at boot and on every re-init after a bus
  error, and drives the first that ACKs. Each probe is bounded by the bus timeout, so the worst
  case (sixteen timeouts) stays inside the 8 s boot watchdog. `00` in `!HW` means nothing
  answered: the console shows a dead glass instead of a blank one nobody reports. A non-zero
  `LCDA` drives that address only. Geometry has no readback on an HD44780, so it stays the
  `LAYOUT` setting, compact on any doubt.
- **The scanner's baud is found, not assumed** (HW-5). With `SBAUD` 0 the Mega starts at 9600
  and, **only while idle** (no overlay, no bridge-pending press), moves to the next rate in the
  order 9600 → 115200 → 57600 → 38400 → 19200 → 9600 after three consecutive bursts that are
  garbage (any byte outside 0x20–0x7E other than CR and LF, or a framing error); it **locks** at
  the first rate that yields a clean scan, until reboot or a `!CFG,SBAUD`. A non-zero `SBAUD` is
  that rate only. The line end is `SSUF`/`SGAP` (rule 6 above). The Mega never writes to the
  scanner (TX16 may not be wired), so it cannot configure one.
- **Which keys are court keys is the bridge's decision** (HW-7). 2.1.0 dropped every press of
  pins 30–36 while the window was shut, a compiled split the backend's `button_map` could not
  reach. 3.0.0 forwards an unarmed press as `!BTN` exactly when its bit is set in `KEYS`; an
  unarmed press of any other key is dropped and ends the overlay with the hint (rule 2 above). The
  bridge sets `KEYS` from `button_map`: every key whose meaning is not `minutes:N`. An armed press
  is always forwarded. Nothing the Mega does with a press depends on what the press means.

**The serial grammar is frozen with the Mega, and the bridge adapts.** No future bridge can add a
verb, an argument or a key the 3.0.0 Mega understands; everything a later bridge may want from
this Mega is the frames above and the bounded `!CFG` keys in the table. A later bridge that
needs something else does it on the ESP side, or not at all.

### Bridge liveness

The Mega stamps every valid downlink frame. After a `!LIVE` has been seen since boot, the bridge
is **dead** when no valid frame arrives for three times the last announced period plus one
second; before any `!LIVE`, after 330 s of silence (a 2.3.0 bridge pings once per heartbeat). A
dead bridge means: status `SEE THE DESK`, call to action `OUT OF SERVICE`, no clock, layout
compact, `!NOTE` and `!LAND` discarded, scans answered `NO CONNECTION` (FWM-08, DL-10). The relay
deadlines, the cap and the ceiling run regardless — they never depended on the bridge. The first
valid frame afterwards revives it; the bridge, seeing the Mega's `!EVT,LIVE,1` (sent on that
revival), re-sends the settings and the landing figures.

### Relay reconcile, and the authorisation cap

The bridge owns the decision and the Mega owns the safety, as in v2. What v3 adds:

- **`!WANT` is how the snapshot reaches the relays** — on every accepted heartbeat, on every Mega
  boot, and when a `!STATE` contradicts the snapshot. It can only light or lengthen. The bridge's
  application rules (when a court counts as owed light, the member-release suppression, the
  provisional power-restore lights) are in [`device-api.md`](device-api.md) §4.
- **The authorisation cap.** A relay closed continuously for `CAP` minutes since its last `!ON`
  opens, `!EVT,CAPOFF,<court>`, and refuses `!WANT` and `!EXT` until the next `!ON`. The 90-minute
  per-frame cap bounds a **dead** bridge; this bounds a **confused live** one looping `!EXT`s or
  `!WANT`s, which v2 could not (FWM-20). A member's grant or paid extension at the panel is an
  `!ON`, so real play is never capped; only the bridge's own re-lighting can be.
- **No relay state is persisted on the Mega.** A Mega-only reset is recovered by the bridge
  re-applying its snapshot within seconds of `!BOOT`; a power cut takes both chips, and the
  bridge's persisted snapshot covers it. A second, EEPROM-held copy would be a second source of
  truth that could disagree with the server and wear a cell the chip cannot afford to lose.

### What each side must do, by finding

**Mega 3.0.0** — FWM-01 (`!BOOT` + immediate `!STATE`), FWM-02/03 (ceiling; presses never
re-arm), FWM-04, DL-04, DL-05, FSF-07 (self-healing glass), FWM-05, DL-02, DL-15, FSF-02 (pass
budget, 400 kHz, diff paint, drain between segments), FWM-06, DL-09 (staging cleared, `!CMT`
mask + CRC), FWM-07 (scan feedback from its own buffer), FWM-08, DL-10 (liveness), FWM-09,
FWM-10, FWM-19, BD-7 (layouts, compact fallback, 0x27/0x3F), FWM-12 (`MCUSR` in `!BOOT`),
FWM-13 (hint deadline disarmed), FWM-14 (scanner idle timeout), FWM-15 (armed-press fallback),
FWM-16 (`SCANH`), FWM-17 (no dead `LCD_PHYSICAL_*` flags; comments true), FWM-18, BR-20 (software
marquee), FWM-20 (authorisation cap), FSF-12 (`!ON` never shortens), DL-14 (chain flag); and from
the addendum HW-1 (relay released as an input, `RPOL`), HW-2 (address probe, `LCDA`, NACKs
counted), HW-5 (`SBAUD` auto-detect, gap-terminated lines), HW-6 (`MCUSR` kept, `!HW`), HW-7
(`KEYS`).
FWM-11 (bootloader survives a watchdog reset) is a **bench** check before the flash, not code.

**Bridge 3.0.0, on this link** — DL-01, FSF-01 (software TX queue, never drop), DL-06 (tagged
acknowledgement), DL-02 (relay frames ahead of screens, `%21`), BR-05 (no relay frame before
the Mega is heard), DL-08, BR-10 (no identity overlays), DL-13, FSF-10 (`!IDLE` every beat),
BR-15 (`HINT`), FWM-01, DL-03, FSF-03, BR-03 (Mega boot is a reconcile trigger); from the
addendum, the hardware `!CFG` set before any relay frame after every `!BOOT`, `KEYS` derived from
`button_map`, and `!BOOT`/`!HW`/`!DIAG` forwarded in the heartbeat's `mega` object (HW-3, HW-6). The bridge's
behaviour off this link is [`device-api.md`](device-api.md) §4 and
[`lights-controller.md`](lights-controller.md).

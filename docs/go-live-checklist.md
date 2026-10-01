# Go-live checklist

The 2026-08-24 adversarial E2E review ([`reviews/adversarial-e2e-review.md`](reviews/adversarial-e2e-review.md))
found the end-to-end path unbuilt; this checklist is valid only at the tip of the fix
programme's branch/PR, and the code-complete claim returns only when a closing re-review
passes. **Nothing here is code.** Each item
needs physical access, a live credential, or a person's decision — and each one, left
undone, breaks the club in a specific way that is written next to it.

Ordered by what stops go-live first.

---

## 1. Safety — the relay question

> **This gates everything else and no software decision touches it.**

The relay module is rated **10A at 250VAC**. That is plausible for one bank of modern LED
court lights and inadequate for older metal-halide. Standard practice is for relays like
these to switch a **contactor coil**, with the contactor carrying the lighting load.

**Nobody has confirmed which is the case on the installed board.**

- [ ] A qualified electrician inspects the installation and confirms the relays switch a
      contactor, not the lighting load directly.
- [ ] If they switch the load directly: the load is measured and the relays are either
      confirmed adequate or a contactor is fitted.
- [ ] The answer is recorded in `src/iot/README.md`, replacing the open question there.

**If skipped:** a relay run beyond its rating welds closed. A welded contact is a court
whose lights cannot be switched off by anything — not the Mega's timer, not the ESP, not
the API. The box has no readback and cannot even detect it.

**This got MORE urgent, not less.** The box now restores the courts a power dip took out:
on its first accepted heartbeat after boot it re-energises, unattended, whatever the API
says should still be on. Nobody is standing next to the box when that happens. An
installation that was inside its rating while a human was pressing the buttons is the same
installation re-closing contacts by itself at three in the morning after a brownout.

---

## 2. The publish chain is unproven, and the redeploy is manual

CI builds multi-arch images and pushes them to Docker Hub. **It stops there** — the
Portainer deploy job was removed by decision, so nothing in the pipeline touches the club
stack. Only a real push to `main` builds anything; `workflow_dispatch` does not.

- [x] `DOCKERHUB_USERNAME` — set 2026-09-05
- [x] `DOCKERHUB_TOKEN` — set 2026-09-05
- [ ] One real push to `main` completed, with the six image jobs green and three `:latest`
      manifests visible on Docker Hub.
- [ ] A manual redeploy of the club stack performed once, end to end, and written down.

Delete any `PORTAINER_URL`, `PORTAINER_TOKEN`, `PORTAINER_STACK_ID`, `PORTAINER_ENDPOINT_ID`
or `OTA_PRIVATE_KEY` still set on the repository — nothing reads them, and a secret nothing
reads is a credential nobody is watching.

**Before each manual redeploy, check the stack names `<user>/crusaders-mainframe-gateway`
and does not bind-mount `./nginx/nginx.conf`.** CI used to refuse a stack in either state;
it no longer can. A stack in either state keeps its old gateway config — every LAN member
back in one rate-limit bucket — while reporting a successful deploy.

**If skipped:** the club never gets a build, or gets one behind a stale gateway. **The
chain stays unproven until one real push to `main` has completed and one manual redeploy
has been done** — a green CI run on a branch says nothing about either.

---

## 2a. The money reset — minutes replace credits (P13)

Migration `MinutesReplaceCredits` (`docs/specs/minutes-and-packages.md` §2.4) makes whole
minutes the unit of account. Converting old credits into minutes has no meaning, so it
**refuses to run on any database that has money history**: any row in `ledger_entries`,
`pending_topups` or `device_pay_fors`, any booking with a non-zero charge, or any seat with a
non-zero share. It fails the deploy with
`MinutesReplaceCredits: pre-launch reset required — money history exists (<table>)` and leaves
the schema exactly as it was (the refusal runs first, inside the migration's transaction).

- [ ] Before the first deploy that carries P13, check every club database:
      `SELECT (SELECT count(*) FROM ledger_entries) + (SELECT count(*) FROM pending_topups)
      + (SELECT count(*) FROM device_pay_fors);` — and charged bookings or shares if it is
      not 0. Zero everywhere: nothing to do.
- [ ] Otherwise, reset that club's database **before** deploying: take a dump for the record,
      then recreate the database empty (on the compose stack, the Postgres volume) and let
      `ProductionBootstrap` seed the club again. Pre-launch there is no real money to keep;
      the dump is the only copy of what was there.
- [ ] After the deploy, confirm `__EFMigrationsHistory` names `MinutesReplaceCredits` and the
      club's shelf shows its three seeded packages.

Development stacks reset with `make down-reset`, which drops every volume.

**If skipped:** the API container stops at start-up on the refusal and the club has no
booking system until the reset is done. Deleting money rows by hand to get past it instead
erases balances members believe they hold.

---

## 3. PayFast — production credentials and the first real transaction

The provider is implemented against the published specification and pinned by a fixture
corpus generated by an independent implementation. There is a mountebank imposter for the
callback cases that are hard to provoke on purpose. **None of that is a live transaction.**

- [ ] Merchant ID, merchant key and passphrase entered as tenant payment settings — **not
      committed anywhere**.
- [ ] The ITN callback URL registered with PayFast points at the deployed API.
- [ ] One real R100 top-up, end to end, by a real person, and the ledger checked.
- [ ] One deliberate ITN replay confirmed refused — PayFast retries ITNs by design and the
      filtered unique index on `ExternalReference` is the only database-level guarantee.

**If skipped:** members cannot top up, or worse, a top-up is charged and not credited.

---

## 4. Committee sign-off — charge at booking

The build debits the member **when the booking is made**. Client blueprint A.9 says the
account is debited "on putting lights on". The deviation is the founder's decision and is
recorded in [`client-blueprint-deltas.md`](specs/client-blueprint-deltas.md) as **D-1**.

- [ ] The committee is shown D-1 and signs off, or asks for the reversal.

**If skipped:** the club is running economics its own written brief does not describe. The
practical difference members will see: cancelling in good time produces two ledger rows, a
charge and a refund, where the blueprint promised none. Their balance is unchanged; their
statement is busier.

**If they say no:** the reversal is `BookingService.CreateAsync` and `CancelAsync` plus the
tests that pin them. The ledger types, the activation path and the court box are all
indifferent to which end the debit is taken from.

---

## 5. Flash both halves and see the box come up

Both halves are flashed over USB, by DIP switch. No adapter, no soldering, no pad access,
and no network path — the whole procedure is the **Arduino IDE 2**: open the sketch, pick
the board and the port, press Upload. `src/iot/court-box/arduino/README.md` is the page, and it needs
no terminal, no `make` and nothing from the Library Manager. The `make flash-*` targets do
the same two uploads from PlatformIO and are the developer alternative.

**Everything the box needs is compiled in — four values, all mandatory.** `secrets.h` is
gitignored and lives on the flashing machine only; `court_bridge` `#error`s on a missing
value and `static_assert`s on an empty one, so there is no way to produce an image with a
blank in it — and therefore no way to hand a box to the wall believing a credential landed
when it did not. There is nothing to claim, nothing to discover and nothing to provision: a
flashed box joins, heartbeats, and appears on the admin Devices screen by itself.

- [ ] Arduino IDE 2 installed, with `https://arduino.esp8266.com/stable/package_esp8266com_index.json`
      added under *Preferences → Additional boards manager URLs*, and both cores installed
      from Boards Manager: **Arduino AVR Boards 1.8.6** and **esp8266 3.1.2**. Those are the
      versions CI compiles the sketches against and the ones `src/iot/court-box/platformio.ini` pins.
- [ ] `cp src/iot/court-box/arduino/court_bridge/secrets.h.example src/iot/court-box/arduino/court_bridge/secrets.h`
      on the flashing machine and fill in all four, then do not commit it:
      `WIFI_SSID`, `WIFI_PASSWORD`, `API_BASE_URL` (the backend's **LAN** address and port,
      no trailing slash — the box and the backend are on the same club network), and
      `DEVICE_API_KEY` (copy it from the admin Devices page).
- [ ] Open `src/iot/court-box/arduino/court_mega/court_mega.ino`, board **Arduino Mega or Mega 2560**,
      processor **ATmega2560**, pick the port, **Upload** — with DIP
      **1 OFF, 2 OFF, 3 ON, 4 ON**, 5–8 OFF.
- [ ] Open `src/iot/court-box/arduino/court_bridge/court_bridge.ino`, board **Generic ESP8266 Module**,
      flash size **4MB (FS:2MB OTA:~1019KB)**, CPU **80 MHz**, upload speed **115200**, pick
      the port, **Upload** — with DIP **1–4 OFF, 5 ON, 6 ON, 7 ON**, 8 OFF. Then move DIP 7
      OFF and open the **Serial Monitor at 9600** — **watch the monitor, not the glass**: in
      that DIP position the ESP's UART is on the USB socket and the Mega is not on the other
      end of it, so the LCD cannot change.
- [ ] Restore the run positions (**1, 2, 3, 4 ON**, 5–8 OFF) and confirm the LCD now shows
      `CONNECTED / SCAN TO START`. That repaint is the proof the ESP and the Mega are
      talking again, and it is the only positive confirmation the box gives. If it reads
      `CRUSADERS COURTS / SCAN TO START` instead, the two halves are talking and the box is
      **not** on the WiFi — check the SSID and password in `secrets.h`.
- [ ] Confirm the box appears on the admin Devices page within one heartbeat (30 s by
      default) with four court numbers against it. That is the whole of registration.

**If skipped:** the box has no firmware. Nothing here needs a second visit: everything is
in the image, so a box that flashed and painted `CONNECTED` is a box that will join the
network and register itself.

---

## 6. Rotate the club WiFi password

The password is in Carl's original sketch, in plain text, in a file that has been on more
than one machine.

- [ ] Rotate it on the access point.
- [ ] Edit `secrets.h` on the flashing machine and upload `court_bridge` again from the
      Arduino IDE (item 5; `make flash-bridge` does the same thing). That is
      the whole delivery mechanism: every credential is compiled into the image, so there is
      no store to go stale, no precedence rule between two credentials, and nothing to
      power-cycle to prove. The same is true of the device API key — pressing
      "Regenerate" on the admin Devices page invalidates the old one immediately, so a
      regeneration is a reflash and must be planned as one.
- [ ] Confirm the box rejoins — the LCD returns to `CONNECTED / SCAN TO START` once the run
      DIPs are restored, and the box shows as heartbeating on the admin Devices screen.

**If skipped:** the club's WiFi credential is known to everyone who has seen that file.

---

## 7. Power — measure both rails under load

The supply is a Mean Well PSU feeding two fused LM2596 bucks: a **5V rail** carrying the
relay coils, the LCD backlight and the scanner, and a **9V rail** into the Mega's VIN,
whose onboard regulators feed the ESP8266 half of the WeMos board. An ESP8266 draws
~350 mA in transmit bursts and a browning-out rail produces exactly the intermittent
faults that get blamed on software.

- [ ] Measure the 5V rail under full load: all four relays energised, LCD lit, scanner
      active.
- [ ] Measure the Mega's VIN/5V during ESP WiFi transmit bursts — the ESP hangs off the
      Mega's onboard regulators, not the LM2596 5V rail.
- [ ] If either sags below ~4.7V at the 5V point, split the load or fit a larger regulator.
These are **two separate checks and they prove different things.** They used to be one
bullet, and once the `Wire` bus timeout was added that one bullet could no longer fire: the
short is absorbed, so a technician either ticked a box that tested nothing or read the
absence of a reset as a fault and started replacing bootloaders.

- [ ] **(a) The bus timeout and the hold-off.** With a court lit, short SDA to ground for a
      few seconds. **Expected: no reset.** Each LCD write gives up in ~25 ms
      (`Wire.setWireTimeout`), the next 20 writes are skipped (`courtlogic::DisplayHoldoff`),
      `loop()` keeps returning and the watchdog keeps being kicked — so the court stays lit
      to its own deadline and `!PING` is still answered. The LCD freezes on its last
      message; on removing the short it must resume rendering **legibly** within a
      handful of writes (the driver re-syncs the controller before the first write after a
      hold-off run — that is the check for garbled characters). A reset here is a fault.
- [ ] **(b) The watchdog itself, and the bootloader behind it.** This needs the bench
      build, because nothing in a production image can stall a pass:
      `pio run -e court_mega_bench -t upload`. Sixty seconds after boot the firmware stops
      returning from `loop()` on purpose. **Expected: a hardware reset within 2 s, and the
      box back with every relay open** (`ArduinoRelay::begin` drives the released level
      before `pinMode`). Light a court first, so "relays open" is observable. Do it once
      with the ESP plugged in and once without.
      A board that stays dark or loops on reset has a bootloader that does not survive a
      WDT reset (older Mega2560 stk500v2 bootloaders); that is a bootloader replacement, not
      a firmware fix, and it is out of software's reach.
- [ ] **Reflash `-e court_mega` before the box goes to site.** `court_mega_bench` is a bench
      environment and nothing else; a club box running it dies sixty seconds after every
      power-up.

**If skipped:** the rail faults go undetected and boards reset at random. The ESP hangs off
the Mega's onboard regulators, so a sagging rail resets **it** too — and an ESP that
reboots mid-evening loses the per-court booking ends `!EXT` needs, so a two-hour court
adopted from the next `!STATE` darkens at the ninety-minute cap, mid-game. Separately, the
Mega's one hard-safety property — that a stall ends in a reset with every contact open —
goes to site unverified on every unit, because (b) is the only thing in the tree that
exercises it.

---

## 8. Event-queue durability, accepted knowingly

Queued events live in RAM. They survive the WiFi going away, a router reboot and a two-day
outage — the API now believes a scan up to 30 days old (`DeviceEventEndpoints.MaxEventAge`)
and keeps booking codes resolvable that long, so a long outage's attendance still lands and
reverses the sweep; they do not survive a power cut. `hal::IStore` is a key/value port for
short identifiers (128-byte values) with no ring semantics — an `Event` is 48 bytes and
would fit in one record, so this is unbuilt work rather than a hard limit, and the half-right
version of it (a torn ring that replays a stale activation) charges a member twice.

- [ ] Somebody accepts this, or schedules the work.

**If accepted:** a court lit during an offline window that ended in a power cut is never
reported, so the sweep concludes nobody played.

**What that costs changed direction when §6a shipped, and the change is the reason to read this
item again.** It used to cost the *member*: the sweep refunded the booking less a 30% penalty
they had not earned. That was wrong, but it was wrong on the member's own ledger, and a member
who is charged for a game they played complains. Under `settlement-model.md` S5a the same
booking is refunded **in full** — `Owed(b) = 0` — and stamped `peripheral_outage`, so the cost
falls on the *club*, silently: a court whose lights ran is free, the ledger shows a refund that
looks correct, and nobody has a reason to raise it. It is the one I2 exception in the system and
`settlement-model.md` I2 names it.

Two things follow, and both are already true rather than planned:

- The unhealthy-box alert no longer opens by telling an admin to check the box's power. A
  power-cycle is precisely the action that discards the queued activations, so the alert that
  reports the outage used to instruct the step that converts it into free courts.
- The recovery mail no longer promises that everything recorded during the outage uploads. It
  says what is true: it uploads if the box stayed powered.

Making the loss positively detectable is the work this item is really asking for, it is not
scheduled, and **the route this item used to name for it does not work.** It said the box
persists its sequence number across reboots and the API stores a `DeviceEventReceipt` per
`(device, seq)`, so a gap after a reconnect is derivable. Both halves are true and the inference
is not. `EventQueue` reserves sequence numbers in blocks of `kSeqCheckpointStride` = 64 and
`begin()` resumes at `mark + 1` — the header says outright that "the previous boot may have issued
any number inside that block, and there is no way to know which" — so every unclean reboot skips
up to 63 numbers whether or not anything was lost, and a power cut *is* an unclean reboot.
Compiled against the real header, a box that pushed three events and then lost power reports its
next event as seq 65: a 61-number gap with zero events lost. A gap cannot distinguish "the queue
lost N activations" from "the checkpoint skipped N numbers", so detection needs something new from
the box — a boot record naming what it discarded, or a durable ring — not a query over the
receipts. Item 7 makes the whole failure rarer.

---

## 9. Offline identification — the decided design, verified once

The design is decided: each booking mints a **short access code**, scoped to that booking
and expiring with it. The box works **online-first** — a scan hits the activation endpoint
when the network is up — and falls back to the **heartbeat roster** of those codes when it
is not. A permanent identity is never cached on the box, by construction.

The accepted trade: a stolen box caches only booking-scoped, expiring codes — nothing in
its memory opens a court beyond the bookings it was already holding, and nothing it holds
is a member's identity.

- [ ] One activation confirmed through the online path.
- [ ] One activation confirmed from the roster fallback with the WAN deliberately down.
- [ ] The roster confirmed to age out (`ROSTER_MAX_AGE_MS`) and refuse rather than guess.
- [ ] `heartbeat_seconds` confirmed honoured by the box: change it in tenant settings and
      watch the heartbeat cadence follow on the next accepted heartbeat. The API accepts
      10–3600; the box clamps what it is sent into **15–300 s** (`bridgelogic::Cadence`)
      and keeps its previous interval when the field is absent.

**If skipped:** the fallback path goes live unproven, and the first WiFi outage is the
first test of the exact regression the local-decision design was built to avoid.

---

## 10. Real hardware, once

Everything below the API is proven on the host with no board attached, which is what makes
CI meaningful. It is not the same as having been run.

- [ ] One board flashed, seen to register itself on the Devices screen, and seen to heartbeat.
- [ ] One member scanned at a real court, lights confirmed on, ledger checked.
- [ ] The Mega's auto-off timer confirmed with the ESP **unplugged** — that is the whole
      point of it being independent.
- [ ] One no-show left to expire and the refund-less-penalty checked in the ledger.

The 2026-08-24 review's §4 adds seven checks that no software answer can close — eyes and
a multimeter on the actual box:

- [ ] Power topology confirmed: which LM2596 output feeds the ESP8266 side, and that rail
      measured during WiFi transmit bursts (item 7).
- [ ] The physical 8-way DIP verified against the wiring sheet for all four modes — Mega
      upload, ESP upload, ESP USB monitor, run.
- [ ] All firmware screens confirmed legible on the physical 20×4 glass — which the
      firmware now drives as 20×4 rather than as 16×2. No wrapped or orphaned half-lines,
      and rows 2 and 3 landing where they should. See §10a, which gates this.
- [ ] A real minted **12-character access code** QR fed to the physical scanner and its TX
      output captured: the terminator, and that the whole code arrives intact. (This bullet
      used to describe a ~200-character JWT payload and ask where it truncates; the system
      has not minted those since the resolver was narrowed to booking- and member-scoped
      codes, so the length question it was written for no longer exists.)
- [ ] Scanner confirmed factory-set to 9600 baud on both fixed links. **Every UART in the
      box is 9600 8N1** — the Mega↔ESP link, the scanner, and the ESP's USB monitor (DIP 5
      and 6 ON, which is what `make monitor-bridge` opens). The only 115200 in
      `platformio.ini` is the Mega's `upload_speed` for avrdude during a USB flash; no UART
      runs at it in service, and the Mega has no monitor at all (it never opens Serial0). A
      monitor opened at the wrong rate shows framing garbage that looks like a broken box
      and is not one.
- [ ] Item 7's check **(b)** done with the ESP plugged in as well as unplugged: the
      `court_mega_bench` build stalled with a court lit, box back within 2 s with relays
      open — and the production `-e court_mega` image reflashed afterwards.
- [ ] Relay board JD-VCC jumper confirmed (which 5V feeds coil vs logic), and active-LOW
      behaviour re-confirmed end to end on all four channels.
- [ ] Physical A/B/C/D and 15/30/45/60 buttons confirmed on pins 22/24/26/28 and
      30/32/34/36 in that order — a swapped pair sells the wrong duration or court.

---

## 10a. The panel, the countdown and the fifteen-second lock

Four things the firmware changes in this programme cannot settle from the host, in the
order that matters.

**Somebody must LOOK at the fitted panel before a club box is flashed.**

The wiring sheet records a 2004A — twenty columns by four rows — and the firmware drove it
as sixteen by two by decision, so a swapped display would degrade rather than produce
garbage. It now drives all twenty columns and all four rows. Everything about that is right
for a 2004A and silently wrong for a 1602, where rows 2-3 and columns 17-20 write into
DDRAM that is off-glass.

The **safe-subset contract** is what makes shipping it reasonable rather than a reason to
skip the look: rows 0 and 1, truncated at column 16, are a complete and correct message on
every screen, enforced by a table-driven test over all of them. A 1602 fitted by mistake
therefore degrades to exactly the old behaviour instead of to half a sentence.

- [ ] Somebody has read the part number off the panel, or counted the character cells, and
      confirmed it is 20×4.
- [ ] If it is a 1602: `-DLCD_COLS`/`-DLCD_ROWS` in `court-box/platformio.ini`'s `[lcd]`
      block go back to 16/2 before flashing, and the box is confirmed to show the same two
      rows it always did.

**If skipped:** four rows of text written to a panel that has two. Half of every screen
lands nowhere and the member reads the remaining half as the whole message.

**Bench the four-row atomic repaint against a wedged I²C bus.**

`!SHOW` commits four rows in one go, which is what removed the torn
`CRUSADERS COURTS / 45 MIN` intermediate a member could see. Four `setCursor` calls plus
eighty character writes is roughly 84 I²C transactions where the old two-row paint was
about 42. The `Wire` timeout is armed per transaction and the watchdog is two seconds, so a
healthy paint is far inside both — but a bus wedged MID-paint is bounded by
`courtlogic::DisplayHoldoff`, which skips a fixed number of writes, and with four rows that
is now **less than one full screen** where it used to be more than one.

- [ ] SDA shorted mid-paint on the bench: the re-sync recovers, the watchdog does not fire,
      and the screen after recovery is a whole screen rather than two rows of one and two
      of another.
- [ ] The numbers re-read off `arduino_hal/LcdDisplay.cpp` and `courtlogic/DisplayHoldoff.h`
      rather than from this page, and this page corrected if they have moved.

**Is the countdown legible at arm's length?**

The design deliberately uses **no custom glyphs**. A progress bar would cost CGRAM that the
I²C re-sync path has to restore after every bus wedge, and it carries no information the
digits do not.

- [ ] Plain digits confirmed readable at 1.5 m in the corridor's own light, by somebody who
      did not write them.

**The physical unlock time at fifteen seconds.**

The door release default moves from three seconds to fifteen (GOAL item 2). That is five
times the duty cycle the strike coil has been seeing.

- [ ] The coil and the PSU measured comfortable at 15 s, repeatedly, back to back.
- [ ] The club asked, in words, whether a fifteen-second open door is what they want at the
      front of the building.
- [ ] The consequence confirmed with whoever staffs the door: the 30 s hard cap bounds the
      TOTAL release across re-arms, so at 3 s it allowed nine extensions and at 15 s it
      allows **one**. A second member scanning at t = 14 s gets fifteen seconds more; a
      third at t = 29 s gets one.

**If skipped:** an overheated strike, or a front door a club did not agree to leave open
for a quarter of a minute.

---

## 10b. The first week's fault numbers will be surprising

The boards now report their own faults, aggregated — one event per code per window, the
count riding `duration_ms`. Several of the counters behind them have existed since the
first firmware with nothing off the board able to read them, so **there is no baseline for
any of this and the first readings are data, not alarms.**

The one to watch is `serial_badcrc`: the real-world CRC error rate on a 9600 baud link
running beside four switching relay coils, measured for the first time. `D1-3`'s severity —
the retry that replayed the wrong court's `!ON` — is a function of that rate, and until now
it has only ever been reasoned about.

- [ ] A week of `device_faults` read before anybody concludes anything from it.
- [ ] `scanner_uart_error` and `scan_oversize` checked specifically: both were counted by
      the Mega and readable by nothing, so a scanner that has been dropping lines has been
      doing so silently for as long as the box has existed.
- [ ] `button_unauthorised` checked: a climbing count is a stuck contact or a bridge that
      stopped sending `!AUTH`, and it is invisible any other way.
- [ ] A `device.relay_restore_failed` row treated as urgent rather than informational — it
      means a court is dark that should not be.

---

## 11. LAN webhook consumers — the private-network allow-list

Production rejects RFC1918 webhook destinations unless the endpoint is on
`Webhooks:PrivateNetworkAllowList` (a CIDR list), with `Webhooks:AllowPrivateNetworks` as
the master switch. The court box is **not** a webhook destination — it is pull-only, with
no inbound HTTP listener — so nothing about the box needs this. The allow-list exists for
any *other* legitimate LAN consumer the club points a webhook at.

- [ ] For each legitimate LAN consumer: give it a DHCP reservation (the network is DHCP
      everywhere — no static addresses), and add its address as a CIDR entry, e.g.
      `Webhooks:PrivateNetworkAllowList:0 = 10.0.40.7/32`.
- [ ] Leave `Webhooks:AllowPrivateNetworks` false unless a consumer genuinely needs it.

**If skipped:** any webhook pointed at a LAN address is refused by the SSRF guard — which
is the correct default, and only wrong if the club actually has such a consumer.

---

## 12. Door gates — the lock, the wiring, and what a power cut does

The door-gate firmware (`src/iot/door-gate`) is new and **has never run on hardware**.
Everything it decides is proven on the host — the two polarity flags in all four
combinations, the release window and its hard cap, the online-first flow and its roster
fallback, the whole loop including its watchdog and blocking-call budget, all fifteen
contract vectors — and none of that is the same as a board on a wall with a lock on the
other end of it. Every item below needs the board, the lock and a person.

**The owner's stated expectation is that the door is released when there is no power.**
Two different failures hide inside that sentence. A **power cut** takes the lock's own
supply with it, and what the door does then is decided by the LOCK — a fail-safe lock
(held shut by current) releases, a fail-secure one stays shut — whatever the firmware
flags say. A **dead or resetting board with the lock's supply still up** only
de-energises the relay coil, and `GATE_UNLOCK_ENERGISES_RELAY` decides that case alone.
The firmware defaults are Carl's own sketch, which he has run on the real door. Which
lock is fitted and which relay contact feeds it are **not recorded anywhere**, so this
list measures instead of assuming. The wiring is fixed; nothing here asks for a rewire.
`src/iot/door-gate/README.md` carries the truth table.

- [ ] Carl has said which lock is fitted (fail-safe or fail-secure) and which relay contact
      (NO or NC) feeds it, and it is written into `MEMORY.md`, not left in a chat.
- [ ] **Mains pulled, door locked:** the door does what the owner expects — released. If it
      does not, that is the owner's and Carl's conversation about the lock; record the
      outcome either way.
- [ ] **Board power pulled only, lock supply left on:** record what the door does. This is
      the truth table's last column for the flags as built.
- [ ] **Bench-proved with a meter and the real lock, before the board goes on the wall**:
      power the board, confirm the door is LOCKED at idle; pull the board's power with the
      door locked and confirm the door does what the row above says it should.
- [ ] **Boot-glitch check, ten times**: with the lock connected and audible, power-cycle the
      board and confirm the lock does **not** click or release on the way up. The firmware
      writes the locked level into the pin's output register before `pinMode(OUTPUT)`
      precisely for this, and it is the one safety property no host test can confirm against
      real hardware.
- [ ] The same check after a **watchdog** reset, not just a power cycle.
- [ ] **The pre-`setup()` window, measured rather than assumed.** From the reset release
      until `setup()`'s first instruction — the ROM bootloader and the second-stage loader,
      roughly 0.3–0.7 s — GPIO 26 is an **input with no drive**, and what the relay module
      does with a floating input is decided by **that module's own input bias**. Nothing in
      the firmware reaches this window and no test can. With a meter on the relay input and
      an audible lock, power-cycle and watch what the door does during that half second, on
      the module the club actually bought.
- [ ] **The truth table's last column, on the real module.** `README.md`'s "dead or
      rebooting board" column is a statement about the relay coil and the lock, not about
      software, and it has never been measured on this hardware. Pull the board's power with
      a meter on the relay contacts and confirm each of the two wirings in use does what the
      table says.
- [ ] **Watchdog TRIP check — the API host unplugged at boot.** Unplug the machine the
      backend runs on (or block its address at the router), then power-cycle the gate and
      **watch the serial monitor at 115200 for two minutes**. Expect: one boot line, then a
      quiet board with a slow-blinking LED. A board that reprints its boot line every ten or
      twenty seconds is **reset-looping**, which means it is admitting nobody and will keep
      doing so until the network comes back. That is exactly what an 8-second watchdog
      against an 8-second worst-case HTTP call used to do; the period is **15 s** now — a
      call is three phases (connect, headers, body) of 4 s each, not two — the relation is
      `static_assert`ed, and this is the check that says the assert is about the real
      timeout.
- [ ] While the API host is still unreachable, **scan a rostered member** and confirm they
      still get in from the roster. The board must decide the door while it is failing to
      reach the server, not instead of it.

**If skipped:** a door that is unlocked whenever the software believes it is locked, or one
that pulses open on every reset. There is no readback on this board — nothing in the
software can detect either, and nobody will find out until somebody walks in.

### Fire egress is mechanical and is not this board's job

- [ ] Confirmed with the club — and, where the door is on an escape route, with whoever
      signs off the building's fire compliance — that **every** door this board controls
      opens from the inside by pushing it, with no power, no relay and no firmware
      involved: a panic bar or a mechanical handle.

**If skipped:** people could be shut inside a building by a failed relay, a dead board or a
flat supply. Nothing in this repository is a life-safety device, nothing here is rated or
certified as one, and no combination of the build flags turns it into one.

### The board, the network and the roster

- [ ] **The technician's copy is `src/iot/door-gate/arduino/door_gate/secrets.h` — beside
      the `.ino`, in the sketch folder that gets opened — not the PlatformIO one.** Both
      exist and neither is read by the other route: `src/iot/door-gate/src/common/secrets.h`
      is the developer's, for `pio run`. Copy `secrets.h.example` from whichever folder is
      being built and fill in all four values. Both are gitignored.
- [ ] **All four values actually replaced.** Every value in the `.example` is a placeholder
      and **every placeholder is a compile error** — `WIFI_SSID`, `WIFI_PASSWORD` and
      `DEVICE_API_KEY` against their own literal, and `API_BASE_URL` against the reserved
      host `0.0.0.0` that the `.example` ships. The build also `#error`s on a missing value
      and `static_assert`s on an empty one, so there is no way to produce an image with a
      blank *or* a placeholder in it. The file used to ship plausible values (`"ClubWiFi"`,
      a real-looking LAN address), which compile and flash and produce a board that joins
      nothing — indistinguishable at the door from a board whose server is down.
- [ ] Flashed **from the Arduino IDE**, out of `src/iot/door-gate/arduino/door_gate/` — board
      *ESP32 Dev Module*, pick the port, Upload — with `secrets.h` copied from the `.example`
      beside the `.ino` and filled in. That folder is generated, carries its own README written
      for the person doing the flashing, and vendors every library it needs, so the technician
      needs no terminal and no PlatformIO. `pio run -d src/iot/door-gate -e door_gate -t upload`
      remains the developer route and is what the tests and gates run against.
- [ ] **The `esp32` core installed from the Boards Manager is exactly 2.0.17**, added through
      the `package_esp32_index.json` URL in the sketch folder's README. Only one version of a
      core installs at a time, and 3.x is not a small difference — the sketch is not expected to
      compile against it. It is the version CI compiles this sketch with, and it matches the
      `espressif32@6.9.0` platform `platformio.ini` pins.
- [ ] The board appears on the admin **Devices** page by itself within one heartbeat, as
      `Kind=Gate`, with `DeviceCode` `gate-<last six of MAC>` — auto-registered, nothing
      claimed or provisioned.
- [ ] A `gate_key` set on it in the admin console. Until it has one the row is a door nobody
      has named, which is legal and reads as `null` on the wire.
- [ ] **Scan a real member's code and watch the LED**: solid while the lock is released,
      three fast blinks on a refusal, slow 1 Hz while the radio is down. That lamp is the
      board's entire user interface and the only feedback a member gets.
- [ ] **Expect no lamp change for a refusal while the door is already open**, and do not
      report it as a fault. Solid outranks the refusal blinks by design, so the second
      member of a pair — refused while the first one's window is still running — sees a
      steady lamp. The door is open in front of them, which is the more useful thing for the
      lamp to be saying. **A release window also runs to its end**: taking the door out of
      service, or pulling the AP, while somebody's window is open does not cut it short.
- [ ] **A 4 Hz blink — four times the offline rate — means the task watchdog refused to
      arm**, three times over. The board still works and still opens doors; it is running
      under the core's own 5 s watchdog instead of the 15 s this firmware asks for, which
      makes a slow API host a possible reset loop. Note the board and read the boot line at
      115200, which says the same thing. It is not a member-facing pattern and never
      outranks one.
- [ ] **Take the door out of service in the admin console and scan again.** What you can
      verify at the door is that the board **refuses**, and — the part that matters — that it
      **does not fall back to its roster**: pull the AP first, then scan a member who has a
      rostered booking and confirm they are refused too. **You cannot observe the reason.**
      `out_of_service` is a string that exists only inside the firmware; it goes nowhere,
      and the lamp gives three blinks for every refusal whatever caused it. Do not expect
      the door to tell you why, and do not report the absence of a distinct pattern as a
      fault. Then put the board back in service and confirm the next scan works.
      **Known and accepted:** only a board that cannot *reach* the server at the moment you
      press the button fails to hear about it — every path it speaks on carries the 403 now,
      not just the heartbeat — and such a board keeps admitting rostered bookings until its
      roster goes stale (6 h). Nothing in the firmware can close that window; if a door has
      to be shut immediately, shut it mechanically.
- [ ] **Offline test, done deliberately**: pull the AP, wait for the slow blink, and confirm
      a member **with a rostered booking** still gets in and a member **without one** does
      not. That is the stated degraded mode and it is narrower than the court box's — a
      walk-up member's 60-second code can never be in a roster.
- [ ] **Stale-roster test**: leave the board offline past `ROSTER_MAX_AGE_MS` (6 h) and
      confirm it then admits **nobody**, including the member who got in an hour earlier.
- [ ] After the link comes back, the offline opens appear in the audit trail as
      `device.gate_open` — and **no** booking shows a `CheckedInAt` from them. Walking
      through a door is not attendance, and a gate that posted attendance would let somebody
      lose their refund by walking past a door.
- [ ] **A single spurious 403 — a proxy, a WAF, a rule somebody added — costs the offline
      fallback ONE heartbeat interval.** The roster is committed empty the moment the board
      hears one and the next accepted heartbeat refills it, so the window is 30 s at the
      default cadence and up to 5 minutes at the longest the server may push. A member
      arriving inside that window with the link **also** down is refused. Nothing at the
      door shows it; the recovery is automatic and needs no intervention.
- [ ] **The lamp stays dark and the board never appears on the Devices page.** Not a
      separate pattern — it is the *absence* of one, and it is the most likely thing a
      technician actually meets. In order: board powered, and is `GATE_LED_PIN` the pin the
      lamp is on? Then **open the serial monitor at 115200 and press RESET**: one line with
      the firmware version, the MAC and the API address should appear. No line at all means
      the Upload did not take or the sketch is not running; a line but nothing on the
      Devices page means the MAC is reaching no server — check the `api=` address on that
      line and that the board and the backend are on the same LAN.
- [ ] **If the IDE Upload fails with hundreds of `redefinition of …` errors, it is iCloud
      Drive**, not the firmware. A synced folder fabricates numbered duplicates (`Json
      2.cpp`, `GateApp 2.h`) and the IDE compiles every `.cpp` under `src/` recursively, so
      each one is a second definition. They are invisible in Finder's default view and are
      never committed. From the repository root: `make sweep-icloud`. From the sketch
      folder by hand: `find . -name '* [0-9].*' -print -delete` and then
      `find . -name '* [0-9]' -print -delete`. Then Upload again.
- [ ] **Read `no_push` and `events_lost` off the device row after a week.** Both are
      since-boot totals the board sends in its heartbeat and neither has any other observer:
      `no_push` counts heartbeats the server accepted from which no roster could be adopted
      (a cut body, bad framing, a missing key) and `events_lost` counts door entries the
      64-slot ring discarded while the board could not reach the API. A zero on both is a
      healthy board. A rising `no_push` is a roster that is not being refreshed even though
      the board looks online; a rising `events_lost` is entries the club has permanently
      lost. Both saturate rather than wrapping, so a very large number means "at least
      this many".

**If skipped:** a door that works on the bench and refuses every member the first time the
WiFi drops, or one that keeps admitting people from a roster a week out of date.

### One firmware, many doors

- [ ] A second board flashed with the **same image**, given its own `gate_key` in the admin
      console, and confirmed to behave as its own door. Nothing per-gate is compiled in, and
      a spare board must be a spare board rather than a board for one particular door.

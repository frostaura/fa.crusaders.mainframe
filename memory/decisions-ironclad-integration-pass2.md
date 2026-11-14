---
name: crusaders-mainframe-decisions-ironclad-integration-pass2
description: "Ironclad pass 2 integration (2026-11-14, fix/ironclad): bridge-ota and app-rest merged, no new migrations, nine lizard splits held RAM-neutral, the device harness rewritten for the Mega 3.0.0 glass."
type: decision
last_verified: 2026-11-14
---

# The ironclad pass, second integration (`fix/ironclad`)

Pass 1 is [`decisions-ironclad-integration.md`](decisions-ironclad-integration.md). Pass 2 merged
`fix/bridge-ota` (bridge 3.1.0) then `fix/app-rest`, both `--no-ff`. Neither touched a file the
other did. Neither added a migration. `has-pending-model-changes` is clean. A fresh database and
one migrated at `a77a1d72` and then upgraded reach identical `pg_dump --schema-only` schemas.

**Found only by running the gates on the merged tree:**
- **`make complexity` failed on nine bridge-ota functions** (that lane never ran it). They were
  split behaviour for behaviour (the OTA ones, with `BridgeOta` and its `Lent`, left on 2026-11-14).
  - *Trap, measured:* a first split passed constant `{key, lo, hi}` aggregates, which the ESP8266
    keeps in DRAM `.rodata`. That cost 48 B of a heap 72 B above the 24,576 B floor. It was
    bisected by file and replaced by a run-time `ConfigObject`.
  - Static RAM was then 57,288 B (pio), a heap 56 B above the floor. *Superseded:* the OTA
    removal took it to 55,384 B, a heap of 26,536 B, 1,960 B over (`decisions-bridge-3-1.md`).
  - *Why split rather than whitelist:* `whitelizard.txt` is a ratchet that needs a reviewer.
- **`scenario.py`'s glass steps never ran.** E-LCD-3 asserted the Mega 2.1.0 screen and aborted,
  and `glass_steps` stopped there at both clock bases. So "148/150" hid E-LCD-2/4, E-BTN-1/2,
  E-RETRY-1 and E-EXT-1.
  - They are rewritten on the display/ composer and the v3 rules: a 60 s CEIL plus `!EVT,CEIL,`
    and DWELL, AFTON (new E-LCD-5), the compact marquee and `!CFG,LAYOUT,1/0`, `SCAN CODE FIRST`,
    and `ONE MOMENT`.
  - *Trap:* a 16-cell marquee window that does not cover the court in question matches any figure
    for it. The predicate now requires that item wholly in view.
- The widest heartbeat vector is 4086 B now (app-rest); the court box's comments were corrected.

**Tests project formatted** (`dotnet format whitespace`, its own commit).
- *Proof:* every file is byte-identical to HEAD with whitespace stripped, no raw or verbatim
  string was touched, and `--list-tests` gives the same 4,501 names.
- *Trap:* a connection string carrying `Maximum Pool Size` reds `TestWebAppFactoryIsolationTests`
  and the R18 pool storms. The API caps the pool only when the string does not. Give the suite a
  bare string.

**Left, with reasons** (in the lanes' own topics): `test_compat`, the BR-08/09 bridge halves and
the dead PayFor source. With OTA gone the bridge ones need a cable flash, so they are done
before the first flash or cost a visit; deleting PayFor shifts ScreenScript ids for no image gain. FM-8 per-host shell (gateway SSI), BM-9, FC-8 and
BA-17/BA-21 wait on a decision.

**The `crusaders-int` stack** (`:8098`, MailHog `:8035`) runs this tree in place on its own
database volume. Its override pins subnet `172.29.93.0/24`, tags the gateway
`crusaders-int-gateway:local` (pass 1 retagged the shared `crusaders-mainframe-gateway:local`)
and stamps `BUILD_SHA`. Its env was rebuilt from the running containers' own environment, by key.

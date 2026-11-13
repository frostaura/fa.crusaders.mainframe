---
name: crusaders-mainframe-gotchas-json-scanner
description: "devapi's heapless JSON scanner treated any quoted string as a key until it was fixed; every server-controlled string is a decoy for a key name, and v3 callers must bound nested reads with findObject."
type: gotcha
last_verified: 2026-11-13
---

# Gotchas — the shared JSON scanner

`devapi::json` is compiled into every firmware here, so a defect in it is as
wide as this tree gets. The toolchain traps around it are in
[`gotchas-build.md`](gotchas-build.md).

- **`findKey` matched a quoted key ANYWHERE, including where it was a VALUE — FIXED 2026-09-19.**
  A gate heartbeat opens `{"kind":"gate",…}` and carries a `"gate":{…}` object later, so the first
  `"gate"` in every response was the value of `kind`. Reading from there passed all fourteen
  contract vectors, because the only `unlock_seconds` in those documents is the right one, and
  would have driven a lock for somebody else's number the moment a field was added between the
  two. **Found by a one-field probe, not by the corpus** — the corpus cannot find this class of
  bug by construction.
- **A key is now a quoted string followed by optional whitespace and a colon.** Values and array
  elements are skipped whole, and `\`-escapes are honoured when deciding where a string ends so a
  quote inside a value cannot put the scan out of phase. `endOfString` is the single authority on
  where a string ends and `copyQuoted` uses it too, so the library cannot hold two ideas about one
  document. The door gate's local colon-requiring workaround is gone: one implementation, proven
  in `src/iot/shared/test/test_devapi/`.
- **`findKey` still finds keys at ANY DEPTH, by a flat scan — and from v3 no caller may rely on
  it for a key that lives inside an object.** 2.3.0 read `button_map` that way, and a future
  object placed before `config` carrying its own `button_map` hijacked the panel (FC-7, reproduced
  2026-11-13). v3 callers read config keys through `findObject("config")` and a bounded read, and
  the gate's settings as scalars of `gate` (`device-api.md` §11.2). Narrowing `findKey` itself
  would still break the 2.x callers, so the rule is on the callers. `findObject` bounds the read at
  BOTH ends — `findKey` plus a read from there bounds only the start, and would adopt a key added
  after the object closed.
- **Every server-controlled string is a decoy for a key name, and three of them are typed by an
  admin.** A tenant slugged `roster` loses its roster; a door named `heartbeat_seconds` pins every
  box to its compiled-in cadence; a `reason` of `court_number` or `granted_seconds` sends a member
  with a valid booking to the desk. Each failure reads as "the key was absent", and every caller
  treats absence as "learned nothing", so **none of them would ever have been reported** — the
  club would have concluded the hardware was unreliable. Held by the scanner now and pinned at
  each caller as well as in the shared suite.
- **`isCompleteObject` COUNTED braces and brackets rather than matching them — FIXED 2026-09-19
  (round G2).** `{` and `[` both raised a depth, `}` and `]` both lowered it, so `{"a":1]` reached
  zero and was declared a whole document. The wrong thing that admits is not a misparse — nothing
  downstream reads a bracket as a brace — it is exactly **the cut body this function exists to
  refuse**, arriving with a stray closer at the end of a buffer and being committed as a whole
  roster. The opener KINDS are remembered now, one bit per level, and nesting past 32 levels is
  refused on the same grounds. Both firmwares ask this before replacing a roster, so the tests are
  in the shared suite.
- **The escaped-quote cases could not be red before the fix, and their fixtures are load-bearing.**
  A properly escaped inner quote always leaves a backslash adjacent to the text, so it can never
  form the `"key"` byte sequence the old scan looked for — those two tests are regression guards on
  the NEW implementation and are proven by mutation. An EVEN number of escaped quotes lets a
  scanner with no escape handling resynchronise and pass by luck; one escaped quote is what puts
  it permanently out of phase, and a separate fixture ending in `\\` is what catches a scanner
  that only skips two bytes on `\"`. The first draft of both fixtures was even-quoted and proved
  nothing until a probe said so.

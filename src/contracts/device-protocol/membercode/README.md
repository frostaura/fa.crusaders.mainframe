# `membercode/` — the single rotating member code

The contract behind D1: one code per member, rotating every 30 s, verified offline by devices and
online by the server. The behaviour oracle is [`docs/specs/member-code.md`](../../../../docs/specs/member-code.md).

**Every file here except this README is GENERATED** by
[`src/iot/tools/membercode_vectors.py`](../../../iot/tools/membercode_vectors.py), the reference
implementation, written with Python's own `hmac`, `hashlib` and `zoneinfo`. Edit the generator and
run it; `make corpus-check` regenerates the directory and fails on any diff. A hand-edited vector
is a hand-edited byte string, which is the class of mistake this corpus exists to catch.

The master key in `derivation.json` is a **fixture** — SHA-256 of a sentence that says so. It
authenticates nothing anywhere, and neither does anything derived from it.

## Who reads what — `manifest.json`

`manifest.json` lists every file with `read_by` and `case_count` (per section). Each reader
executes every case of every file that names it and asserts **executed == declared**, per section
(the corpus README's anti-drift rule, one level up).

| File | `read_by` | Sections |
|---|---|---|
| `sha256.json` | fw-shared, csharp, vitest | `cases` |
| `hmac.json` | fw-shared, csharp, vitest | `cases` |
| `hkdf.json` | fw-shared, csharp | `cases` |
| `totp.json` | fw-shared, csharp, vitest | `cases` |
| `derivation.json` | fw-shared, csharp, vitest | `cases` |
| `clubday.json` | csharp, vitest | `cases` |
| `token.json` | fw-shared, csharp, vitest | `encode`, `decode` |
| `verify.json` | fw-shared | `scenarios` |
| `roster.json` | fw-shared, csharp | `elements`, `decide` |
| `codesync.json` | fw-shared, csharp | `key_elements`, `day_elements`, `apply` |
| `http.json` | fw-court-box, csharp | `requests`, `responses` |
| `gate.json` | fw-door-gate, csharp | `requests`, `responses`, `offline` |

`fw-shared` is `src/iot/shared/test/test_memcode`, `fw-court-box` is
`src/iot/court-box/test/test_membercode`, `fw-door-gate` is
`src/iot/door-gate/test/test_gate_membercode`. `csharp` and `vitest` are the backend and PWA
lanes' suites.

## Conventions

- Bytes are lower-case hex in `*_hex` fields; `body_hex` is the exact UTF-8 bytes of an HTTP
  body. HTTP bodies are compact JSON in **declaration order** — the order System.Text.Json emits
  for the server's records, and the order the firmware renders. A server whose record declares
  fields in another order fails the byte comparison, deliberately.
- Codes are strings of digits (`"on": "00000123"` keeps its zeros).
- Steps are integers (`floor(unix / 30)`); `unix` is seconds; device times (`at_ms`,
  `received_at_ms`) are a device's `millis()` and may wrap past 2^32.

## Schemas

**`sha256.json`** — `{id, note, message_hex, repeat, digest_hex[, message_ascii]}`: digest of
`message × repeat` (`repeat` is 1 000 000 for FIPS B.3).

**`hmac.json`** — `{id, key_hex, data_hex, mac_hex[, truncate_bytes]}`: RFC 4231 1–7 (case 5
truncated to 16 bytes), then the two message shapes this contract feeds HMAC.

**`hkdf.json`** — `{id, ikm_hex, salt_hex, info_hex, length, okm_hex}`: RFC 5869 A.1–A.3.

**`totp.json`** — `{id, key_hex, unix, step, digits, code}`: RFC 6238 B's SHA-256 column (8
digits), the same instants at 6, and the contract's two key shapes (a 32-byte member secret, a
12-byte K_day).

**`derivation.json`** — top level `fixture_master_key_hex`, `hkdf_salt_ascii`,
`kday_label_prefix_ascii`; each case `{id, tenant_id, user_id, generation, hkdf_info_ascii,
member_secret_hex, ref, ref_value, tz, steps: [{label, unix, step, club_day, kday_hex,
kday_b64url, on, off, token}]}`. Generation 2 is the same member after a rotation.

**`clubday.json`** — `{id, note, tz, unix, step, club_day, day_first_step, day_end_step,
day_steps}`, including both 2026 Europe/London transitions (2760- and 3000-step days).

**`token.json`** — `token_len`; `encode: {id, ref_value, ref, on, off, token}`;
`decode: {id, note, input, ok, ref?, ref_value?, on?, off?, why?}` with `why` ∈ `length`,
`version`, `ref`, `digits`.

**`verify.json`** — top level `step_ms`, `window`, `default_max_age_ms`, `status_order`; each
scenario `{id, note, sync: {step, step_ms, at_ms}, days: ["first|end"], keys: [key element],
replay_capacity, max_age_ms?, unsynced_scans?, scans: [{at_ms, token, expect, ref?, step?,
commit, note?}]}`. Run `unsynced_scans` before applying `sync`, then `scans` in order; `expect` is
a status (`ok`, `malformed`, `no_clock`, `no_key`, `wrong_code`, `replayed`); when `commit` is
true the caller records `(ref, step)` in its replay ring, as a device does after it acted.

**`roster.json`** — `marker`; `elements: {id, note, element, ok, token?, refs?, relay?,
opens_ms?, closes_ms?}`; `decide: {id, note, roster: [element], accepted_at_ms, max_age_ms,
courts, at_ms, verdict, ref? | token?, court?, grant_ms?}`. `ref` decides a PROVED member against
REF lists; `token` decides a scanned string against legacy entries. Verdicts: `allow`,
`unknown`, `too_early`, `too_late`, `wrong_court`, `stale`.

**`codesync.json`** — `key_len`; `key_elements: {id, note, element, ok, ref?, slot?, key_hex?}`;
`day_elements: {id, note, element, ok, first_step?, end_step?}`; `apply: {id, note, body_hex,
received_at_ms, key_capacity, expect: {clock: {synced, step?, step_ms?}, keys: {replaced,
accepted?, rejected?, dropped?, entries?: [{ref, slot, key_hex}], days?: [{first_step, end_step}
| null]}}}`.

**`http.json`** (court box) — `requests: {id, note, method, path_and_query, render, body_hex}`
where `render` is the inputs the firmware renders the body from; `responses: {id, kind, note,
body_hex, expect}` with `kind` ∈ `heartbeat`, `payfor_quote`, `payfor_confirm`. For a pay-for
response `expect.outcome` ∈ `quote`, `walkup`, `refused`, `paid` and `expect.screen` names the
firmware screen (`PayForQuote`, `PayForSplit`, …) with `rows` its exact first rows. A `heartbeat`
with `max_bytes` is a budget vector: the body is `bytes` long and must be ≤ `max_bytes`.

**`gate.json`** (door) — `requests` and `responses` as above (`kind: gate_heartbeat`);
`offline: {id, note, heartbeat_body_hex, received_at_ms, scans: [{at_ms, token, released,
reason}]}`: apply the heartbeat, then decide each scan offline; a released scan is recorded as
used.

## Adding a case

Add it to the generator, run it, and commit the regenerated directory. Every reader goes red on
its count check until it executes the new case — which is the point.

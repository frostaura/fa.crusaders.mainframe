# Device protocol contract

Neutral ground. Owned by neither the firmware nor the backend.

Two implementations have to agree on these bytes and cannot see each other's
source: C++ on an 8-bit micro and an ESP8266, and C# on the server. Under
`src/iot/` the .NET tests would have to reach into firmware; under
`src/backend/` the firmware would have to reach into .NET. So the fixtures live
here and both sides read them.

This is not decoration. The repository already shipped one ESP32 sketch and one
webhook sender that had never successfully talked to each other — each was
internally consistent, each was tested against its own assumptions, and the
mismatch was invisible until someone looked at a 401 nobody had noticed for
months. A shared corpus is the cheapest thing that would have caught it.

## Families

| Directory | Speaks | Read by |
|---|---|---|
| `serial/` | the line protocol between the ATmega2560 and the ESP8266 over Serial3 @ 9600 | C++ only — both ends of that link are firmware |
| `http/` | the canonical signing string and HMAC of a device API request | **C++ and C#** — the firmware signs, the server verifies |

`http/` is the one that matters most. A canonical string the firmware builds
one byte differently from the server produces a 401 with no diagnostic, on a
board in an electrical cupboard, and costs a trip to the club to discover.

## Anti-drift: executed counts, not checksums

Each `manifest.json` declares `case_count` per file. Both sides assert that the
number of cases they **executed** equals the number declared, and that none was
skipped as an unrecognised kind.

A checksum over the corpus was considered and rejected: it detects that a file
changed, but not that a side quietly ignored the cases it did not understand.
A side that skips what it cannot parse passes a checksum test and fails in the
field. Counting what actually ran is the assertion with teeth.

## Adding a case

1. Add it to the relevant `*.json`.
2. Increment `case_count` in that directory's `manifest.json`.
3. Run both suites. Both must go red before either implementation is changed —
   if a new case passes immediately on both sides, it was not testing anything.

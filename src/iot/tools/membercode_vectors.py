#!/usr/bin/env python3
"""The reference implementation of the single rotating member code, and the
generator of every vector in src/contracts/device-protocol/membercode/.

Run it from anywhere in the repository:

    python3 src/iot/tools/membercode_vectors.py

`make corpus-check` runs it and fails when the committed corpus differs from
what this file writes, exactly as it does for the gate family.

WHY THIS FILE IS THE REFERENCE AND NOT A COPY OF ONE
----------------------------------------------------
Four implementations have to agree on these bytes and cannot see each other's
source: the ESP8266 court bridge and the ESP32 door gate (C++), the server
(C#), and the member's phone (TypeScript over WebCrypto). A corpus written by
hand is a corpus one of the four was written from; this file is written from
docs/specs/member-code.md, with the standard library's own `hmac`, `hashlib`
and `zoneinfo` doing the arithmetic, so every other implementation is checked
against something none of them wrote.

EVERYTHING HERE IS DETERMINISTIC
--------------------------------
No randomness, no wall clock. Every key, identity and instant is derived from a
fixed label, so a regeneration is a byte-identical no-op and a diff means a
definition changed. The master key below is a FIXTURE — SHA-256 of a sentence
that says so — and authenticates nothing anywhere.

Standard library only (Python 3.9+): `zoneinfo` needs the system tz database,
which macOS and the CI runner both have. A missing zone is a hard failure, never
a silently different corpus.
"""
import base64
import datetime
import hashlib
import hmac
import json
import pathlib
import struct
import sys
from zoneinfo import ZoneInfo

ROOT = pathlib.Path(__file__).resolve().parents[3]
OUT = ROOT / "src" / "contracts" / "device-protocol" / "membercode"

# --------------------------------------------------------------------------
# The definitions. Each one is a sentence in docs/specs/member-code.md §3.
# --------------------------------------------------------------------------

CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
STEP_SECONDS = 30
STEP_MS = STEP_SECONDS * 1000
WINDOW = 1
ON_DIGITS = 8
OFF_DIGITS = 6
REF_LEN = 4
TOKEN_LEN = 1 + REF_LEN + ON_DIGITS + OFF_DIGITS
VERSION = "1"
KDAY_BYTES = 12
HKDF_SALT = b"crusaders/member-code/v1"
KDAY_LABEL = "crusaders/kday/v1|"
ROSTER_MARKER = "m"
CAP_CODES = "codes:m1"
MAX_DAY_STEPS = 3120  # a 26-hour day: DST's usual hour makes 25, Antarctica/Troll shifts by two

COURT_KEY_CAP = 24
GATE_KEY_CAP = 72
COURT_ROSTER_CAP = 16
GATE_ROSTER_CAP = 48
COURT_MAX_BYTES = 2048
GATE_MAX_BYTES = 4096


def sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def hmac_sha256(key: bytes, data: bytes) -> bytes:
    return hmac.new(key, data, hashlib.sha256).digest()


def hkdf_sha256(salt: bytes, ikm: bytes, info: bytes, length: int) -> bytes:
    """RFC 5869, with SHA-256."""
    prk = hmac_sha256(salt if salt else bytes(32), ikm)
    okm = b""
    block = b""
    counter = 1
    while len(okm) < length:
        block = hmac_sha256(prk, block + info + bytes([counter]))
        okm += block
        counter += 1
    return okm[:length]


def member_secret(master: bytes, tenant_id: str, user_id: str, generation: int) -> bytes:
    info = f"member-secret|{tenant_id}|{user_id}|{generation}".encode("ascii")
    return hkdf_sha256(HKDF_SALT, master, info, 32)


def hotp(key: bytes, counter: int, digits: int) -> int:
    """RFC 4226 dynamic truncation over HMAC-SHA256, which is what RFC 6238 does
    for its SHA-256 mode: the offset is the low nibble of the LAST byte (31)."""
    mac = hmac_sha256(key, struct.pack(">Q", counter))
    offset = mac[-1] & 0x0F
    binary = int.from_bytes(mac[offset:offset + 4], "big") & 0x7FFFFFFF
    return binary % (10 ** digits)


def step_of(unix_seconds: int) -> int:
    return unix_seconds // STEP_SECONDS


def club_day(step: int, tz: str) -> str:
    """The club-local calendar date of the step's FIRST instant."""
    instant = datetime.datetime.fromtimestamp(step * STEP_SECONDS, tz=ZoneInfo(tz))
    return instant.date().isoformat()


def day_steps(day: str, tz: str):
    """[first, end) of `day` in steps — local midnight to local midnight."""
    zone = ZoneInfo(tz)
    d = datetime.date.fromisoformat(day)
    start = datetime.datetime(d.year, d.month, d.day, tzinfo=zone)
    nxt = d + datetime.timedelta(days=1)
    end = datetime.datetime(nxt.year, nxt.month, nxt.day, tzinfo=zone)
    s, e = int(start.timestamp()), int(end.timestamp())
    if s % STEP_SECONDS or e % STEP_SECONDS:
        raise SystemExit(f"{tz} {day}: a midnight that is not on a step boundary")
    return s // STEP_SECONDS, e // STEP_SECONDS


def kday(secret: bytes, day: str) -> bytes:
    return hmac_sha256(secret, (KDAY_LABEL + day).encode("ascii"))[:KDAY_BYTES]


def on_code(secret: bytes, step: int) -> int:
    return hotp(secret, step, ON_DIGITS)


def off_code(secret: bytes, step: int, tz: str) -> int:
    return hotp(kday(secret, club_day(step, tz)), step, OFF_DIGITS)


def ref_encode(value: int) -> str:
    if not 0 < value < 32 ** REF_LEN:
        raise ValueError(value)
    return "".join(CROCKFORD[(value >> (5 * (REF_LEN - 1 - i))) & 31] for i in range(REF_LEN))


def ref_decode(text: str):
    """Normalising Crockford decode of exactly four characters: case-folded,
    I and L read as 1, O read as 0, U refused, anything else refused. Returns
    (value, canonical) or None. Value 0 ("0000") is reserved and refused."""
    if len(text) != REF_LEN or not text.isascii():
        # ASCII first: str.upper() folds 'ı' to 'I', 'ſ' to 'S', the Kelvin sign
        # to 'K', and 'ß' to two letters — none of which a device will ever read.
        return None
    value = 0
    for ch in text.upper():
        if ch in "IL":
            ch = "1"
        elif ch == "O":
            ch = "0"
        if ch not in CROCKFORD:
            return None
        value = value * 32 + CROCKFORD.index(ch)
    if value == 0:
        return None
    return value, ref_encode(value)


def token(ref: str, on: int, off: int) -> str:
    return f"{VERSION}{ref}{on:0{ON_DIGITS}d}{off:0{OFF_DIGITS}d}"


def parse_token(text: str):
    """The device's and the server's parse. Returns a dict or the refusal reason."""
    if len(text) != TOKEN_LEN:
        return "length"
    if text[0] != VERSION:
        return "version"
    decoded = ref_decode(text[1:1 + REF_LEN])
    if decoded is None:
        return "ref"
    digits = text[1 + REF_LEN:]
    if not all("0" <= c <= "9" for c in digits):
        return "digits"
    return {
        "ref": decoded[1],
        "ref_value": decoded[0],
        "on": digits[:ON_DIGITS],
        "off": digits[ON_DIGITS:],
    }


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def key_element(ref: str, slot: int, key: bytes) -> str:
    return f"{ref}{slot}{b64url(key)}"


def compact(obj) -> str:
    """System.Text.Json's default output: no whitespace, declaration order."""
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def hexof(obj) -> str:
    return (obj if isinstance(obj, str) else compact(obj)).encode("utf-8").hex()


# --------------------------------------------------------------------------
# Fixtures. Every one of them is derived from a label, never typed.
# --------------------------------------------------------------------------

MASTER = sha256(b"crusaders-mainframe member-code corpus FIXTURE master key - authenticates nothing")
TENANT = "7b0c7a52-3f1e-4c7e-9a51-0c2d6e4b8f10"
TZ = "Africa/Johannesburg"
MAC = "5ccf7f0a1b2c"
SERVER_TIME = "2026-09-23T16:00:17+00:00"

# 2026-09-23 18:00:17 SAST — seventeen seconds into a step, so the phase is real.
ANCHOR_UNIX = 1790179217
ANCHOR_STEP = step_of(ANCHOR_UNIX)
ANCHOR_STEP_MS = (ANCHOR_UNIX % STEP_SECONDS) * 1000
TODAY = club_day(ANCHOR_STEP, TZ)
YESTERDAY = (datetime.date.fromisoformat(TODAY) - datetime.timedelta(days=1)).isoformat()
TOMORROW = (datetime.date.fromisoformat(TODAY) + datetime.timedelta(days=1)).isoformat()


class Member:
    def __init__(self, name: str, user_id: str, ref_value: int, generation: int = 1):
        self.name = name
        self.user_id = user_id
        self.ref = ref_encode(ref_value)
        self.ref_value = ref_value
        self.generation = generation
        self.secret = member_secret(MASTER, TENANT, user_id, generation)

    def token(self, step: int, tz: str = TZ) -> str:
        return token(self.ref, on_code(self.secret, step), off_code(self.secret, step, tz))

    def kday(self, day: str) -> bytes:
        return kday(self.secret, day)


def uuid_for(label: str) -> str:
    h = sha256(label.encode()).hex()
    return f"{h[0:8]}-{h[8:12]}-4{h[13:16]}-a{h[17:20]}-{h[20:32]}"


DEAN = Member("dean", uuid_for("member dean"), 0x0A3C9)
SAM = Member("sam", uuid_for("member sam"), 0x5F1B2)
ALEX = Member("alex", uuid_for("member alex"), 0x8D4E7)
JO = Member("jo", uuid_for("member jo"), 0xC2217)
KIM = Member("kim", uuid_for("member kim"), 0x31F0A)
PAT = Member("pat", uuid_for("member pat"), 0x6B2D4)
DEAN_ROTATED = Member("dean", DEAN.user_id, DEAN.ref_value, generation=2)

MEMBERS = [DEAN, SAM, ALEX, JO, KIM, PAT]


# --------------------------------------------------------------------------
# Families.
# --------------------------------------------------------------------------

def sha256_cases():
    cases = []

    def add(cid, note, message: bytes, repeat: int = 1, ascii_text=None):
        case = {"id": cid, "note": note}
        if ascii_text is not None:
            case["message_ascii"] = ascii_text
        case["message_hex"] = message.hex()
        case["repeat"] = repeat
        case["digest_hex"] = sha256(message * repeat).hex()
        cases.append(case)

    add("fips-empty", "the empty message: padding alone fills one block", b"", ascii_text="")
    add("fips-abc", "FIPS 180-2 B.1", b"abc", ascii_text="abc")
    two = b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
    add("fips-two-block", "FIPS 180-2 B.2: 448 bits, so the length no longer fits the first block",
        two, ascii_text=two.decode())
    add("fips-million-a", "FIPS 180-2 B.3: one million 'a' — `repeat` copies of the message, fed in any split",
        b"a", repeat=1000000, ascii_text="a")
    for n in (55, 56, 63, 64, 65, 119, 120, 128):
        msg = bytes((i * 7 + 3) & 0xFF for i in range(n))
        add(f"boundary-{n}", f"{n} bytes: a padding edge — 55 is the last length whose length field fits the "
            "same block, 56 the first that needs a second, 64 a whole block of message", msg)
    return {"description": "SHA-256 (FIPS 180-4). The primitive under everything else.", "cases": cases}


def hmac_cases():
    # RFC 4231 §4.2-4.8, HMAC-SHA-256 column. Case 5 is truncated to 128 bits.
    rfc = [
        ("rfc4231-1", "0b" * 20, b"Hi There".hex(), None),
        ("rfc4231-2", b"Jefe".hex(), b"what do ya want for nothing?".hex(), None),
        ("rfc4231-3", "aa" * 20, "dd" * 50, None),
        ("rfc4231-4", bytes(range(1, 26)).hex(), "cd" * 50, None),
        ("rfc4231-5", "0c" * 20, b"Test With Truncation".hex(), 16),
        ("rfc4231-6", "aa" * 131, b"Test Using Larger Than Block-Size Key - Hash Key First".hex(), None),
        ("rfc4231-7", "aa" * 131,
         b"This is a test using a larger than block-size key and a larger than block-size data. "
         b"The key needs to be hashed before being used by the HMAC algorithm.".hex(), None),
    ]
    known = {
        "rfc4231-1": "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
        "rfc4231-2": "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
        "rfc4231-3": "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe",
        "rfc4231-4": "82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b",
        "rfc4231-5": "a3b6167473100ee06e0c796c2955552b",
        "rfc4231-6": "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
        "rfc4231-7": "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2",
    }
    cases = []
    for cid, key, data, trunc in rfc:
        mac = hmac_sha256(bytes.fromhex(key), bytes.fromhex(data))
        mac = mac[:trunc] if trunc else mac
        if mac.hex() != known[cid]:
            raise SystemExit(f"{cid}: hashlib disagrees with RFC 4231")
        case = {"id": cid, "key_hex": key, "data_hex": data, "mac_hex": mac.hex()}
        if trunc:
            case["truncate_bytes"] = trunc
        cases.append(case)
    # The two shapes this contract actually feeds HMAC: an 8-byte counter under a
    # 32-byte member secret (ON), and the K_day label under the same secret.
    cases.append({"id": "counter-under-member-secret", "key_hex": DEAN.secret.hex(),
                  "data_hex": struct.pack(">Q", ANCHOR_STEP).hex(),
                  "mac_hex": hmac_sha256(DEAN.secret, struct.pack(">Q", ANCHOR_STEP)).hex()})
    label = (KDAY_LABEL + TODAY).encode()
    cases.append({"id": "kday-label-under-member-secret", "key_hex": DEAN.secret.hex(), "data_hex": label.hex(),
                  "mac_hex": hmac_sha256(DEAN.secret, label).hex()})
    return {"description": "HMAC-SHA-256 (RFC 2104). RFC 4231's seven vectors, then the two message shapes "
            "this contract uses.", "cases": cases}


def hkdf_cases():
    rfc = [
        ("rfc5869-a1", "0b" * 22, "000102030405060708090a0b0c", "f0f1f2f3f4f5f6f7f8f9", 42,
         "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"),
        ("rfc5869-a2", bytes(range(0x00, 0x50)).hex(), bytes(range(0x60, 0xb0)).hex(),
         bytes(range(0xb0, 0x100)).hex(), 82,
         "b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c59045a99cac7827271cb41c65e590e09"
         "da3275600c2f09b8367793a9aca3db71cc30c58179ec3e87c14c01d5c1f3434f1d87"),
        ("rfc5869-a3", "0b" * 22, "", "", 42,
         "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8"),
    ]
    cases = []
    for cid, ikm, salt, info, length, okm in rfc:
        got = hkdf_sha256(bytes.fromhex(salt), bytes.fromhex(ikm), bytes.fromhex(info), length)
        if got.hex() != okm:
            raise SystemExit(f"{cid}: hkdf disagrees with RFC 5869")
        cases.append({"id": cid, "ikm_hex": ikm, "salt_hex": salt, "info_hex": info, "length": length,
                      "okm_hex": okm})
    return {"description": "HKDF-SHA-256 (RFC 5869). Only the server derives member secrets; the firmware "
            "proves the same chain in its host suite so the corpus is checked by two implementations.",
            "cases": cases}


def totp_cases():
    seed = b"12345678901234567890123456789012"
    rfc = [(59, 46119246), (1111111109, 68084774), (1111111111, 67062674), (1234567890, 91819424),
           (2000000000, 90698825), (20000000000, 77737706)]
    cases = []
    for unix, expected in rfc:
        got = hotp(seed, step_of(unix), 8)
        if got != expected:
            raise SystemExit(f"RFC 6238 {unix}: {got} != {expected}")
        cases.append({"id": f"rfc6238-sha256-{unix}", "key_hex": seed.hex(), "unix": unix, "step": step_of(unix),
                      "digits": 8, "code": f"{expected:08d}"})
    for unix, _ in rfc:
        code = hotp(seed, step_of(unix), 6)
        cases.append({"id": f"sha256-6digit-{unix}", "key_hex": seed.hex(), "unix": unix, "step": step_of(unix),
                      "digits": 6, "code": f"{code:06d}"})
    # The two key shapes this contract uses: a 32-byte member secret (ON) and a
    # 12-byte K_day (OFF), across a step boundary.
    k = DEAN.kday(TODAY)
    for delta in (-1, 0, 1):
        s = ANCHOR_STEP + delta
        cases.append({"id": f"member-secret-on-{delta:+d}", "key_hex": DEAN.secret.hex(), "unix": s * 30,
                      "step": s, "digits": ON_DIGITS, "code": f"{on_code(DEAN.secret, s):08d}"})
        cases.append({"id": f"kday-off-{delta:+d}", "key_hex": k.hex(), "unix": s * 30, "step": s,
                      "digits": OFF_DIGITS, "code": f"{hotp(k, s, OFF_DIGITS):06d}"})
    return {"description": "TOTP over HMAC-SHA-256 (RFC 6238 SHA-256 mode, RFC 4226 truncation, 30 s step, "
            "T0 = 0). RFC 6238 Appendix B's SHA-256 column, the same six instants at 6 digits, then the "
            "contract's own two key shapes.", "cases": cases}


def derivation_cases():
    cases = []
    for m in MEMBERS + [DEAN_ROTATED]:
        steps = []
        for label, unix in (("anchor", ANCHOR_UNIX), ("anchor+30s", ANCHOR_UNIX + 30),
                            ("anchor+90s", ANCHOR_UNIX + 90)):
            s = step_of(unix)
            day = club_day(s, TZ)
            k = m.kday(day)
            steps.append({"label": label, "unix": unix, "step": s, "club_day": day, "kday_hex": k.hex(),
                          "kday_b64url": b64url(k), "on": f"{on_code(m.secret, s):08d}",
                          "off": f"{off_code(m.secret, s, TZ):06d}", "token": m.token(s)})
        cases.append({"id": f"{m.name}-gen{m.generation}", "tenant_id": TENANT, "user_id": m.user_id,
                      "generation": m.generation, "hkdf_info_ascii": f"member-secret|{TENANT}|{m.user_id}|"
                      f"{m.generation}", "member_secret_hex": m.secret.hex(), "ref": m.ref, "ref_value": m.ref_value,
                      "tz": TZ, "steps": steps})
    # Across local midnight: the last step of one club day and the first of the
    # next use DIFFERENT K_day keys, and the ON code does not care.
    first, _ = day_steps(TOMORROW, TZ)
    edge = []
    for s in (first - 1, first):
        day = club_day(s, TZ)
        edge.append({"label": "last step of the day" if s < first else "first step of the next day", "unix": s * 30,
                     "step": s, "club_day": day, "kday_hex": DEAN.kday(day).hex(), "kday_b64url": b64url(DEAN.kday(day)),
                     "on": f"{on_code(DEAN.secret, s):08d}", "off": f"{off_code(DEAN.secret, s, TZ):06d}",
                     "token": DEAN.token(s)})
    cases.append({"id": "dean-gen1-across-midnight", "tenant_id": TENANT, "user_id": DEAN.user_id, "generation": 1,
                  "hkdf_info_ascii": f"member-secret|{TENANT}|{DEAN.user_id}|1", "member_secret_hex": DEAN.secret.hex(),
                  "ref": DEAN.ref, "ref_value": DEAN.ref_value, "tz": TZ, "steps": edge})
    return {"description": "The whole chain: master key -> member secret (HKDF) -> ON (TOTP-8 under the secret) "
            "and K_day (HMAC of the day label, first 12 bytes) -> OFF (TOTP-6 under K_day) -> token. Generation 2 "
            "is the same member after a rotation: a different secret, the same REF.",
            "fixture_master_key_hex": MASTER.hex(), "hkdf_salt_ascii": HKDF_SALT.decode(),
            "kday_label_prefix_ascii": KDAY_LABEL, "cases": cases}


def clubday_cases():
    rows = []

    def add(cid, tz, unix, note):
        s = step_of(unix)
        day = club_day(s, tz)
        first, end = day_steps(day, tz)
        rows.append({"id": cid, "note": note, "tz": tz, "unix": unix, "step": s, "club_day": day,
                     "day_first_step": first, "day_end_step": end, "day_steps": end - first})

    first, _ = day_steps(TOMORROW, TZ)
    add("sast-anchor", TZ, ANCHOR_UNIX, "the corpus anchor: 18:00:17 local")
    add("sast-last-step", TZ, (first - 1) * 30 + 29, "23:59:59 local is still today")
    add("sast-midnight", TZ, first * 30, "00:00:00 local is tomorrow")
    # Europe/London across both 2026 transitions: a 23-hour and a 25-hour day.
    for cid, when, note in (("london-spring-forward", datetime.datetime(2026, 3, 29, 12, tzinfo=ZoneInfo("Europe/London")),
                             "the 23-hour day: 2760 steps"),
                            ("london-fall-back", datetime.datetime(2026, 10, 25, 12, tzinfo=ZoneInfo("Europe/London")),
                             "the 25-hour day: 3000 steps, the most a day slot may span"),
                            ("utc", datetime.datetime(2026, 9, 23, 0, 0, tzinfo=ZoneInfo("UTC")), "UTC midnight")):
        add(cid, str(when.tzinfo), int(when.timestamp()), note)
    return {"description": "The club day of a step: the tenant-local calendar date of the step's first instant, "
            "and that day's [first, end) step range. The SERVER computes these (and the PHONE, for K_day); a "
            "device never does — it is handed the ranges.", "cases": rows}


def token_cases():
    encode = []
    for m in MEMBERS:
        on, off = on_code(m.secret, ANCHOR_STEP), off_code(m.secret, ANCHOR_STEP, TZ)
        encode.append({"id": f"encode-{m.name}", "ref_value": m.ref_value, "ref": m.ref, "on": f"{on:08d}",
                       "off": f"{off:06d}", "token": token(m.ref, on, off)})
    for value, cid in ((1, "ref-min"), (32 ** 4 - 1, "ref-max"), (0x08421, "ref-0x08421")):
        encode.append({"id": f"encode-{cid}", "ref_value": value, "ref": ref_encode(value), "on": "00000000",
                       "off": "000000", "token": token(ref_encode(value), 0, 0)})

    good = DEAN.token(ANCHOR_STEP)
    decode = []

    def dec(cid, text, note):
        parsed = parse_token(text)
        case = {"id": cid, "note": note, "input": text}
        if isinstance(parsed, dict):
            case.update({"ok": True, "ref": parsed["ref"], "ref_value": parsed["ref_value"], "on": parsed["on"],
                         "off": parsed["off"]})
        else:
            case.update({"ok": False, "why": parsed})
        decode.append(case)

    dec("canonical", good, "a token as a phone renders it")
    ref = DEAN.ref
    dec("lowercase-ref", good[0] + ref.lower() + good[5:], "a lower-case REF is the same REF")
    # Build REFs that exercise each normalisation on purpose.
    zero_ref = ref_encode(0x00421)  # "0121" — has a 0 and 1s to substitute
    base = token(zero_ref, 12345678, 123456)
    dec("o-reads-as-zero", "1" + zero_ref.replace("0", "O") + base[5:], "O is read as 0")
    dec("i-reads-as-one", "1" + zero_ref.replace("1", "I") + base[5:], "I is read as 1")
    dec("l-reads-as-one", "1" + zero_ref.replace("1", "l") + base[5:], "l (lower-case L) is read as 1")
    dec("u-refused", "1" + "U" + zero_ref[1:] + base[5:], "U is not in the alphabet in either case")
    dec("reserved-zero-ref", token("0000", 12345678, 123456), "REF 0000 is reserved and never assigned")
    dec("too-short", good[:-1], "18 characters")
    dec("too-long", good + "0", "20 characters")
    dec("wrong-version", "2" + good[1:], "a version this build does not speak")
    dec("letter-in-on", good[:7] + "A" + good[8:], "ON is digits only")
    dec("letter-in-off", good[:-1] + "B", "OFF is digits only")
    dec("hyphenated", good[:3] + "-" + good[4:], "Crockford's optional hyphen is not accepted: the token is fixed-width")
    dec("space", good[:7] + " " + good[8:], "whitespace inside the token")
    dec("legacy-booking-code", "7Q3F9KM2XZ8B", "a twelve-character legacy code is not a v1 token and must never "
        "be parsed as one — length alone separates the two")
    dec("roster-ref-list", "m" + DEAN.ref, "a roster REF list presented as a scan is not a token")
    dec("non-ascii-dotless-i", good[0] + "\u0131" + good[2:], "a dotless i is not I: only ASCII is normalised "
        "(19 characters, 20 UTF-8 bytes — refused either way)")
    dec("non-ascii-sharp-s", good[0] + "\u00df" + good[2:], "sharp s would upper-case to two letters: refused")
    return {"description": "The token: '1' + REF (4 Crockford) + ON (8 digits) + OFF (6 digits) = 19 characters. "
            "Canonical output is upper-case; the REF alone is decoded with Crockford normalisation.",
            "token_len": TOKEN_LEN, "encode": encode, "decode": decode}


def verify_cases():
    """Device-side offline verification scenarios. See the spec §6."""
    sync_at = 1_000_000

    def days_for(*days):
        return [f"{a}|{b}" for a, b in (day_steps(d, TZ) for d in days)]

    def keys_for(pairs):
        return [key_element(m.ref, slot, m.kday(day)) for m, slot, day in pairs]

    def at(step):
        """A device millis at which the StepClock reads `step` (>= the anchor step):
        five seconds after the sync's own phase, so it is never before the sync."""
        return sync_at + (step - ANCHOR_STEP) * STEP_MS + 5000

    def first_ms(step):
        """The first device millisecond of `step` (> the anchor step)."""
        return sync_at + (step - ANCHOR_STEP) * STEP_MS - ANCHOR_STEP_MS

    scenarios = []
    base_days = days_for(TODAY)
    base_keys = keys_for([(DEAN, 0, TODAY), (SAM, 0, TODAY)])

    def scan(ms, tok, expect, ref=None, step=None, commit=False, note=None):
        s = {"at_ms": ms, "token": tok, "expect": expect}
        if ref:
            s["ref"] = ref
        if step is not None:
            s["step"] = step
        s["commit"] = commit
        if note:
            s["note"] = note
        return s

    t = ANCHOR_STEP
    scenarios.append({"id": "accept-then-replay", "note": "a code is accepted once; a second presentation of the "
                      "same step, or of an earlier one, is a replay — the ring keeps the highest step per REF",
                      "sync": {"step": ANCHOR_STEP, "step_ms": ANCHOR_STEP_MS, "at_ms": sync_at},
                      "days": base_days, "keys": base_keys, "replay_capacity": 4,
                      "scans": [scan(at(t), DEAN.token(t), "ok", DEAN.ref, t, True),
                                scan(at(t) + 5000, DEAN.token(t), "replayed", DEAN.ref, t),
                                scan(at(t) + 5000, DEAN.token(t - 1), "replayed", DEAN.ref, t - 1),
                                scan(at(t) + 5000, DEAN.token(t + 1), "ok", DEAN.ref, t + 1, True,
                                     "a phone one step fast, inside the window"),
                                scan(at(t) + 6000, SAM.token(t), "ok", SAM.ref, t, True,
                                     "another member's use is independent")]})
    scenarios.append({"id": "window-edges", "note": "±1 step around the device's step; nothing is committed, so "
                      "every scan is judged on its own",
                      "sync": {"step": ANCHOR_STEP, "step_ms": ANCHOR_STEP_MS, "at_ms": sync_at},
                      "days": base_days, "keys": base_keys, "replay_capacity": 4,
                      "scans": [scan(at(t), DEAN.token(t - 1), "ok", DEAN.ref, t - 1),
                                scan(at(t), DEAN.token(t), "ok", DEAN.ref, t),
                                scan(at(t), DEAN.token(t + 1), "ok", DEAN.ref, t + 1),
                                scan(at(t), DEAN.token(t - 2), "wrong_code", DEAN.ref),
                                scan(at(t), DEAN.token(t + 2), "wrong_code", DEAN.ref),
                                scan(first_ms(t + 1), DEAN.token(t), "ok", DEAN.ref, t,
                                     note="the first millisecond of step t+1: t is one behind"),
                                scan(first_ms(t + 1) - 1, DEAN.token(t + 2), "wrong_code", DEAN.ref,
                                     note="the last millisecond of step t: t+2 is two ahead"),
                                scan(first_ms(t + 1), DEAN.token(t + 2), "ok", DEAN.ref, t + 2,
                                     note="one millisecond later t+2 is one ahead")]})
    wrong_ref = token(SAM.ref, on_code(DEAN.secret, t), off_code(DEAN.secret, t, TZ))
    unknown = token(KIM.ref, on_code(KIM.secret, t), off_code(KIM.secret, t, TZ))
    scenarios.append({"id": "wrong-ref-and-no-key", "note": "Dean's digits under Sam's REF are Sam's key's problem; "
                      "a REF the ring has no key for cannot be verified offline at all",
                      "sync": {"step": ANCHOR_STEP, "step_ms": ANCHOR_STEP_MS, "at_ms": sync_at},
                      "days": base_days, "keys": base_keys, "replay_capacity": 4,
                      "scans": [scan(at(t), wrong_ref, "wrong_code", SAM.ref),
                                scan(at(t), unknown, "no_key", KIM.ref)]})
    yesterdays = token(DEAN.ref, on_code(DEAN.secret, t), hotp(DEAN.kday(YESTERDAY), t, OFF_DIGITS))
    scenarios.append({"id": "wrong-day", "note": "OFF computed under YESTERDAY's K_day at today's step: a stolen "
                      "roster's key forges nothing the day after",
                      "sync": {"step": ANCHOR_STEP, "step_ms": ANCHOR_STEP_MS, "at_ms": sync_at},
                      "days": days_for(TODAY),
                      "keys": keys_for([(DEAN, 0, TODAY)]), "replay_capacity": 4,
                      "scans": [scan(at(t), yesterdays, "wrong_code", DEAN.ref),
                                scan(at(t), DEAN.token(t), "ok", DEAN.ref, t)]})
    first_tomorrow_step, _ = day_steps(TOMORROW, TZ)
    past = first_tomorrow_step + 2
    late = sync_at + (past - ANCHOR_STEP) * STEP_MS - ANCHOR_STEP_MS + 5000
    scenarios.append({"id": "step-outside-every-day", "note": "the ring holds today only; two steps past "
                      "midnight (with a clock trusted a little past six hours) no candidate step falls in a day the "
                      "ring holds — there is no key to try",
                      "sync": {"step": ANCHOR_STEP, "step_ms": ANCHOR_STEP_MS, "at_ms": sync_at},
                      "days": base_days, "keys": base_keys, "replay_capacity": 4, "max_age_ms": 21700000,
                      "scans": [scan(late, DEAN.token(past), "no_key", DEAN.ref)]})
    # Midnight: sync a few steps before, scan at the first step of tomorrow.
    first_tomorrow, _ = day_steps(TOMORROW, TZ)
    ms0 = 2_000_000
    sync_step = first_tomorrow - 4

    def at_mid(step):
        return ms0 + (step - sync_step) * STEP_MS + 1000

    scenarios.append({"id": "across-midnight", "note": "the code from the last step of the day, verified in the "
                      "first step of the next, is checked under the OLD day's key; the new day's code under the new",
                      "sync": {"step": sync_step, "step_ms": 0, "at_ms": ms0},
                      "days": days_for(TODAY, TOMORROW),
                      "keys": keys_for([(DEAN, 0, TODAY), (DEAN, 1, TOMORROW)]), "replay_capacity": 4,
                      "scans": [scan(at_mid(first_tomorrow), DEAN.token(first_tomorrow - 1), "ok", DEAN.ref,
                                     first_tomorrow - 1, True),
                                scan(at_mid(first_tomorrow), DEAN.token(first_tomorrow), "ok", DEAN.ref,
                                     first_tomorrow, True)]})
    scenarios.append({"id": "no-clock", "note": "before any sync, and once the sync is older than max_age_ms, the "
                      "device has no step to verify against and admits nobody offline",
                      "sync": {"step": ANCHOR_STEP, "step_ms": ANCHOR_STEP_MS, "at_ms": sync_at},
                      "days": days_for(TODAY, TOMORROW),
                      "keys": keys_for([(DEAN, 0, TODAY), (DEAN, 1, TOMORROW)]), "replay_capacity": 4,
                      "max_age_ms": 21600000,
                      "unsynced_scans": [scan(sync_at, DEAN.token(t), "no_clock", DEAN.ref)],
                      "scans": [scan(sync_at + 21600000, DEAN.token(step_of_ms(sync_at + 21600000, sync_at)),
                                     "ok", DEAN.ref, step_of_ms(sync_at + 21600000, sync_at), note="exactly max age"),
                                scan(sync_at + 21600001, DEAN.token(step_of_ms(sync_at + 21600001, sync_at)),
                                     "no_clock", DEAN.ref, note="one millisecond past it")]})
    garbage_on = token(DEAN.ref, 0, off_code(DEAN.secret, t, TZ))
    scenarios.append({"id": "off-right-on-garbage", "note": "a device checks OFF only: this is ACCEPTED offline, "
                      "and it is exactly the evidence the server rejects when the upload is re-checked with ON "
                      "(code.forgery_suspected)",
                      "sync": {"step": ANCHOR_STEP, "step_ms": ANCHOR_STEP_MS, "at_ms": sync_at},
                      "days": base_days, "keys": base_keys, "replay_capacity": 4,
                      "scans": [scan(at(t), garbage_on, "ok", DEAN.ref, t)]})
    scenarios.append({"id": "malformed", "note": "nothing that is not a well-formed v1 token reaches a key",
                      "sync": {"step": ANCHOR_STEP, "step_ms": ANCHOR_STEP_MS, "at_ms": sync_at},
                      "days": base_days, "keys": base_keys, "replay_capacity": 4,
                      "scans": [scan(at(t), DEAN.token(t)[:-1], "malformed"),
                                scan(at(t), "7Q3F9KM2XZ8B", "malformed"),
                                scan(at(t), "2" + DEAN.token(t)[1:], "malformed"),
                                scan(at(t), DEAN.token(t)[:5] + "X" + DEAN.token(t)[6:], "malformed"),
                                scan(at(t), "", "malformed")]})
    # The millis() wrap: sync just before it, scan just after.
    wrap_sync = 4294960000

    def at_wrap(step):
        return (wrap_sync + (step - ANCHOR_STEP) * STEP_MS + 5000) % (1 << 32)

    scenarios.append({"id": "across-the-millis-wrap", "note": "a sync 7.3 s before millis() wraps; the scan after "
                      "the wrap must still read the right step (tb::since, never subtraction of raw readings)",
                      "sync": {"step": ANCHOR_STEP, "step_ms": ANCHOR_STEP_MS, "at_ms": wrap_sync},
                      "days": base_days, "keys": base_keys, "replay_capacity": 4,
                      "scans": [scan(at_wrap(t + 1), DEAN.token(t + 1), "ok", DEAN.ref, t + 1, True),
                                scan(at_wrap(t + 2), DEAN.token(t + 2), "ok", DEAN.ref, t + 2, True)]})
    scenarios.append({"id": "replay-ring-eviction", "note": "a ring of two: committing a third REF evicts the "
                      "OLDEST, after which that REF's used code is accepted again. The stated residual — the "
                      "firmware sizes the ring so eviction inside a ±1 window needs more distinct members than "
                      "a door or a box sees in ninety seconds",
                      "sync": {"step": ANCHOR_STEP, "step_ms": ANCHOR_STEP_MS, "at_ms": sync_at},
                      "days": base_days,
                      "keys": keys_for([(DEAN, 0, TODAY), (SAM, 0, TODAY), (ALEX, 0, TODAY)]),
                      "replay_capacity": 2,
                      "scans": [scan(at(t), DEAN.token(t), "ok", DEAN.ref, t, True),
                                scan(at(t), SAM.token(t), "ok", SAM.ref, t, True),
                                scan(at(t), DEAN.token(t), "replayed", DEAN.ref, t),
                                scan(at(t), ALEX.token(t), "ok", ALEX.ref, t, True),
                                scan(at(t), DEAN.token(t), "ok", DEAN.ref, t, False, "evicted: accepted again")]})
    scenarios.append({"id": "rotated-secret", "note": "after a rotation the phone's new secret derives a new "
                      "K_day; a box still holding the old key refuses it until its next heartbeat",
                      "sync": {"step": ANCHOR_STEP, "step_ms": ANCHOR_STEP_MS, "at_ms": sync_at},
                      "days": base_days, "keys": base_keys, "replay_capacity": 4,
                      "scans": [scan(at(t), DEAN_ROTATED.token(t), "wrong_code", DEAN.ref)]})
    return {"description": "Offline verification as a device performs it: StepClock from the sync, the day "
            "slots and keys as a heartbeat delivered them, then scans in order. `commit` says whether the "
            "caller then acted (lit a court, released a door) and recorded the use in the replay ring.",
            "step_ms": STEP_MS, "window": WINDOW, "default_max_age_ms": 21600000, "scenarios": scenarios,
            "status_order": ["malformed", "no_clock", "no_key", "wrong_code", "replayed", "ok"]}


def step_of_ms(now_ms, sync_at):
    return ANCHOR_STEP + (ANCHOR_STEP_MS + (now_ms - sync_at)) // STEP_MS


def roster_element(refs, relay, opens_in, closes_in):
    return f"{ROSTER_MARKER}{''.join(refs)}|{relay}|{opens_in}|{closes_in}"


def roster_cases():
    elements = []

    def el(cid, text, ok, note, refs=None, relay=None, opens_ms=None, closes_ms=None):
        c = {"id": cid, "note": note, "element": text, "ok": ok}
        if ok:
            c.update({"token": text.split("|")[0], "refs": refs, "relay": relay, "opens_ms": opens_ms,
                      "closes_ms": closes_ms})
        elements.append(c)

    four = [DEAN.ref, SAM.ref, ALEX.ref, JO.ref]
    for n in range(1, 5):
        el(f"refs-{n}", roster_element(four[:n], 2, -120, 2580), True, f"{n} member REF(s): organiser first",
           four[:n], 2, 0, 2580000)
    el("legacy-token-still-parses", "7Q3F9KM2XZ8B|0|60|900", True, "a legacy booking code in the same roster is "
       "untouched", None, 0, 60000, 900000)
    el("marker-alone", "m|0|0|900", False, "a REF list with no REF")
    el("partial-ref", f"m{DEAN.ref}{SAM.ref[:3]}|0|0|900", False, "7 characters after the marker: not whole REFs")
    el("five-refs", "m" + "".join(four) + KIM.ref + "|0|0|900", False, "five REFs is 21 characters, past the "
       "token cap — and past the four players a booking may have")
    el("lowercase-ref", f"m{DEAN.ref.lower()}|0|0|900", False, "server data is canonical: no normalisation on a "
       "roster REF")
    el("u-in-ref", "mU" + DEAN.ref[1:] + "|0|0|900", False, "U is not Crockford")
    el("reserved-ref", "m0000|0|0|900", False, "REF 0000 is reserved")
    zero_one = ref_encode(0x00421)  # "0111"
    el("o-for-zero-in-ref", "m" + zero_one.replace("0", "O") + "|0|0|900", False, "an O where the canonical REF has "
       "0 is a server bug, refused rather than normalised")
    el("i-for-one-in-ref", "m" + zero_one.replace("1", "I") + "|0|0|900", False, "likewise an I for a 1")
    el("capital-marker", f"M{DEAN.ref}|0|0|900", True, "a capital M is NOT the marker: this is an ordinary "
       "five-character token and matches only those exact bytes", None, 0, 0, 900000)

    decide = []
    roster = [roster_element([DEAN.ref, SAM.ref], 1, -300, 2400),
              roster_element([ALEX.ref, JO.ref, KIM.ref, PAT.ref], 3, 1800, 4500),
              "7Q3F9KM2XZ8B|0|-60|1200"]

    def d(cid, note, ref, courts, at_ms, verdict, court=None, grant_ms=None, token_scan=None):
        c = {"id": cid, "note": note, "roster": roster, "accepted_at_ms": 0, "max_age_ms": 21600000,
             "courts": courts, "at_ms": at_ms, "verdict": verdict}
        if ref is not None:
            c["ref"] = ref
        if token_scan is not None:
            c["token"] = token_scan
        if court is not None:
            c["court"] = court
        if grant_ms is not None:
            c["grant_ms"] = grant_ms
        decide.append(c)

    d("organiser", "the organiser's REF lights the booking's court for what is left of it", DEAN.ref, 4, 60000,
      "allow", 1, 2340000)
    d("partner", "an accepted partner's REF lights the same court", SAM.ref, 4, 60000, "allow", 1, 2340000)
    d("fourth-player", "the fourth REF of a full booking", PAT.ref, 4, 1900000, "allow", 3, 2600000)
    d("too-early", "Alex's booking opens in thirty minutes", ALEX.ref, 4, 60000, "too_early", 3)
    d("too-late", "Sam's booking closed", SAM.ref, 4, 2400000, "too_late", 1)
    d("wrong-court", "a box driving two courts holds a booking on relay 3", ALEX.ref, 2, 1900000, "wrong_court", 3)
    d("partner-in-a-later-booking", "Kim is the third player of a booking that has not opened", KIM.ref, 4, 60000,
      "too_early", 3)
    d("absent-ref", "a REF the roster does not name at all", "ZZZZ", 4, 60000, "unknown")
    d("stale", "a roster past its maximum age admits nobody", DEAN.ref, 4, 21600001, "stale")
    d("ref-list-never-matches-as-a-token", "presenting the roster's own bytes as a scan must not match: a REF "
      "is not secret, so 'm' + a REF would otherwise be a key to the court", None, 4, 60000, "unknown",
      token_scan=roster[0].split("|")[0])
    d("legacy-token-path", "a legacy code still matches its own entry by bytes", None, 4, 60000, "allow", 0,
      1140000, token_scan="7Q3F9KM2XZ8B")
    return {"description": "The roster element grammar for a v1 booking, TOKEN = 'm' + one to four REFs "
            "(organiser first, then accepted partners), 5 to 17 characters, inside the unchanged "
            "TOKEN|relay|opens_in|closes_in element. Then how a device decides a VERIFIED REF against it.",
            "marker": ROSTER_MARKER, "elements": elements, "decide": decide}


def code_sync_doc(extra: dict, roster=None):
    body = {"server_time": SERVER_TIME, "tenant_slug": "crusaders", "device_code": "court-box-1",
            "court_numbers": [1, 2, 3, 4], "heartbeat_seconds": 60, "roster": roster or []}
    body.update(extra)
    return body


def codesync_cases():
    key_elements = []

    def ke(cid, text, ok, note, ref=None, slot=None, key=None):
        c = {"id": cid, "note": note, "element": text, "ok": ok}
        if ok:
            c.update({"ref": ref, "slot": slot, "key_hex": key.hex()})
        key_elements.append(c)

    k = DEAN.kday(TODAY)
    ke("slot-0", key_element(DEAN.ref, 0, k), True, "REF + slot + 16 base64url characters", DEAN.ref, 0, k)
    ke("slot-1", key_element(DEAN.ref, 1, k), True, "the second day slot", DEAN.ref, 1, k)
    odd = bytes([0xFB, 0xFF, 0xBF] * 4)
    ke("url-alphabet", key_element(SAM.ref, 0, odd), True, "the base64url '-' and '_' characters", SAM.ref, 0, odd)
    ke("slot-2", f"{DEAN.ref}2{b64url(k)}", False, "at most two day slots")
    ke("short-key", f"{DEAN.ref}0{b64url(k)[:-1]}", False, "15 key characters")
    ke("long-key", f"{DEAN.ref}0{b64url(k)}A", False, "17 key characters")
    ke("plus-sign", f"{DEAN.ref}0" + b64url(k)[:-1] + "+", False, "standard base64's '+' is not base64url")
    ke("padding", f"{DEAN.ref}0" + b64url(k)[:-1] + "=", False, "no padding")
    ke("lowercase-ref", f"{DEAN.ref.lower()}0{b64url(k)}", False, "server data is canonical")
    ke("reserved-ref", f"00000{b64url(k)}", False, "REF 0000 is reserved")
    zero_one = ref_encode(0x00421)
    ke("l-for-one-in-ref", f"{zero_one.replace('1', 'L')}0{b64url(k)}", False, "an L for a 1: server data is "
       "canonical, never normalised")

    day_elements = []

    def de(cid, text, ok, note, first=None, end=None):
        c = {"id": cid, "note": note, "element": text, "ok": ok}
        if ok:
            c.update({"first_step": first, "end_step": end})
        day_elements.append(c)

    f0, e0 = day_steps(TODAY, TZ)
    de("today", f"{f0}|{e0}", True, "a 24-hour day is 2880 steps", f0, e0)
    fl, el_ = day_steps("2026-10-25", "Europe/London")
    de("25-hour-day", f"{fl}|{el_}", True, "3000 steps is the longest a day slot may be", fl, el_)
    de("26-hour-day", f"{f0}|{f0 + 3120}", True, "Antarctica/Troll's two-hour shift: the longest real day",
       f0, f0 + 3120)
    de("27-hour-day", f"{f0}|{f0 + 3121}", False, "past the longest real day")
    de("eleven-digits", f"{f0}|12345678901", False, "more digits than a step has")
    de("past-uint32", "4294967000|4294967296", False, "a step past 2^32 - 1")
    de("leading-zeros", f"0{f0}|0{e0}", True, "leading zeros are digits: the same range", f0, e0)
    de("empty", f"{f0}|{f0}", False, "a day of no steps")
    de("backwards", f"{e0}|{f0}", False, "ends before it starts")
    de("negative", f"-1|{f0}", False, "steps are unsigned")
    de("three-fields", f"{f0}|{e0}|0", False, "exactly two fields")
    de("not-numbers", "today|tomorrow", False, "digits only")

    applies = []

    def ap(cid, note, body, expect, capacity=COURT_KEY_CAP, received_at_ms=5000):
        applies.append({"id": cid, "note": note, "body_hex": hexof(body), "received_at_ms": received_at_ms,
                        "key_capacity": capacity, "expect": expect})

    days = [f"{f0}|{e0}"]
    keys = [key_element(DEAN.ref, 0, DEAN.kday(TODAY)), key_element(SAM.ref, 0, SAM.kday(TODAY))]
    full = code_sync_doc({"code_step": ANCHOR_STEP, "code_step_ms": ANCHOR_STEP_MS, "code_days": days,
                          "code_keys": keys})
    ap("full", "a clock, one day and two keys", full,
       {"clock": {"synced": True, "step": ANCHOR_STEP, "step_ms": ANCHOR_STEP_MS},
        "keys": {"replaced": True, "accepted": 2, "rejected": 0, "dropped": 0,
                 "entries": [{"ref": DEAN.ref, "slot": 0, "key_hex": DEAN.kday(TODAY).hex()},
                             {"ref": SAM.ref, "slot": 0, "key_hex": SAM.kday(TODAY).hex()}],
                 "days": [{"first_step": f0, "end_step": e0}]}})
    ap("absent", "an API that sends no code_* key at all leaves both the clock and the ring exactly as they were",
       code_sync_doc({}), {"clock": {"synced": False}, "keys": {"replaced": False}})
    ap("clock-only", "the clock without keys: synced, ring untouched",
       code_sync_doc({"code_step": ANCHOR_STEP, "code_step_ms": 0}),
       {"clock": {"synced": True, "step": ANCHOR_STEP, "step_ms": 0}, "keys": {"replaced": False}})
    ap("empty-keys", "an empty array commits an EMPTY ring: 'nobody can be verified offline' has to be sayable",
       code_sync_doc({"code_step": ANCHOR_STEP, "code_step_ms": 0, "code_days": days, "code_keys": []}),
       {"clock": {"synced": True, "step": ANCHOR_STEP, "step_ms": 0},
        "keys": {"replaced": True, "accepted": 0, "rejected": 0, "dropped": 0, "entries": [],
                 "days": [{"first_step": f0, "end_step": e0}]}})
    ap("step-ms-out-of-range", "a phase of 30000 ms is not inside a 30 s step: the clock is not synced",
       code_sync_doc({"code_step": ANCHOR_STEP, "code_step_ms": 30000}), {"clock": {"synced": False},
                                                                          "keys": {"replaced": False}})
    ap("step-without-phase", "code_step without code_step_ms syncs nothing — both or neither",
       code_sync_doc({"code_step": ANCHOR_STEP}), {"clock": {"synced": False}, "keys": {"replaced": False}})
    bad = keys + [f"{JO.ref}1{b64url(JO.kday(TODAY))}", "garbage"]
    ap("bad-elements-counted", "a key naming a slot the day list does not have, and one that is not a key at "
       "all, are refused and counted; the good ones are still committed",
       code_sync_doc({"code_step": ANCHOR_STEP, "code_step_ms": 0, "code_days": days, "code_keys": bad}),
       {"clock": {"synced": True, "step": ANCHOR_STEP, "step_ms": 0},
        "keys": {"replaced": True, "accepted": 2, "rejected": 2, "dropped": 0,
                 "entries": [{"ref": DEAN.ref, "slot": 0, "key_hex": DEAN.kday(TODAY).hex()},
                             {"ref": SAM.ref, "slot": 0, "key_hex": SAM.kday(TODAY).hex()}],
                 "days": [{"first_step": f0, "end_step": e0}]}})
    over = [key_element(m.ref, 0, m.kday(TODAY)) for m in MEMBERS[:5]]
    ap("over-capacity", "five keys into a ring of three: three kept in order, two dropped and counted",
       code_sync_doc({"code_step": ANCHOR_STEP, "code_step_ms": 0, "code_days": days, "code_keys": over}),
       {"clock": {"synced": True, "step": ANCHOR_STEP, "step_ms": 0},
        "keys": {"replaced": True, "accepted": 3, "rejected": 0, "dropped": 2,
                 "entries": [{"ref": m.ref, "slot": 0, "key_hex": m.kday(TODAY).hex()} for m in MEMBERS[:3]],
                 "days": [{"first_step": f0, "end_step": e0}]}}, capacity=3)
    decoy = code_sync_doc({"config": {"code_keys": [key_element(KIM.ref, 0, KIM.kday(TODAY))]}})
    ap("nested-decoy", "a code_keys array nested inside another object is not the ring: top level only",
       decoy, {"clock": {"synced": False}, "keys": {"replaced": False}})
    text = compact(full)
    ap("truncated", "a body cut short is not a document: nothing is adopted, not even the clock", text[:-40],
       {"clock": {"synced": False}, "keys": {"replaced": False}})
    ap("withdrawn", "a device that is no longer entitled to keys is sent EMPTY arrays, never an omission: the "
       "ring it held is emptied (an omission would leave it verifying members for up to two days)",
       code_sync_doc({"code_step": ANCHOR_STEP, "code_step_ms": 0, "code_days": [], "code_keys": []}),
       {"clock": {"synced": True, "step": ANCHOR_STEP, "step_ms": 0},
        "keys": {"replaced": True, "accepted": 0, "rejected": 0, "dropped": 0, "entries": [], "days": []}})
    ap("third-day-ignored", "a ring has two day slots; a third day element is ignored, and a key naming slot 2 is "
       "refused by the grammar",
       code_sync_doc({"code_step": ANCHOR_STEP, "code_step_ms": 0,
                      "code_days": [f"{f0}|{e0}", f"{e0}|{e0 + 2880}", f"{e0 + 2880}|{e0 + 5760}"],
                      "code_keys": [key_element(DEAN.ref, 0, DEAN.kday(TODAY)), f"{DEAN.ref}2{b64url(k)}"]}),
       {"clock": {"synced": True, "step": ANCHOR_STEP, "step_ms": 0},
        "keys": {"replaced": True, "accepted": 1, "rejected": 1, "dropped": 0,
                 "entries": [{"ref": DEAN.ref, "slot": 0, "key_hex": DEAN.kday(TODAY).hex()}],
                 "days": [{"first_step": f0, "end_step": e0}, {"first_step": e0, "end_step": e0 + 2880}]}})
    ap("non-string-elements", "a value that is not a string keeps its POSITION — `null` leaves day slot 0 empty "
       "rather than renumbering slot 1 — and a string inside an object in code_keys is not a key",
       code_sync_doc({"code_step": ANCHOR_STEP, "code_step_ms": 0, "code_days": [None, f"{f0}|{e0}"],
                      "code_keys": [{"k": key_element(DEAN.ref, 1, DEAN.kday(TODAY))},
                                    key_element(DEAN.ref, 1, DEAN.kday(TODAY))]}),
       {"clock": {"synced": True, "step": ANCHOR_STEP, "step_ms": 0},
        "keys": {"replaced": True, "accepted": 1, "rejected": 1, "dropped": 0,
                 "entries": [{"ref": DEAN.ref, "slot": 1, "key_hex": DEAN.kday(TODAY).hex()}],
                 "days": [None, {"first_step": f0, "end_step": e0}]}})
    ap("bad-day-slot", "a malformed day element leaves that slot empty; keys naming it are refused",
       code_sync_doc({"code_step": ANCHOR_STEP, "code_step_ms": 0, "code_days": ["bad", f"{f0}|{e0}"],
                      "code_keys": [key_element(DEAN.ref, 0, DEAN.kday(TODAY)),
                                    key_element(DEAN.ref, 1, DEAN.kday(TODAY))]}),
       {"clock": {"synced": True, "step": ANCHOR_STEP, "step_ms": 0},
        "keys": {"replaced": True, "accepted": 1, "rejected": 1, "dropped": 0,
                 "entries": [{"ref": DEAN.ref, "slot": 1, "key_hex": DEAN.kday(TODAY).hex()}],
                 "days": [None, {"first_step": f0, "end_step": e0}]}})
    return {"description": "What a heartbeat response carries for the code (top-level `code_step`, "
            "`code_step_ms`, `code_days`, `code_keys`), the grammar of one key and one day element, and what a "
            "device does with a whole body.", "key_len": 21, "key_elements": key_elements,
            "day_elements": day_elements, "apply": applies}


# --------------------------------------------------------------------------
# HTTP — the court box.
# --------------------------------------------------------------------------

LCD_CONFIG = {"slice_minutes": 15, "grace_window_minutes": 5, "walk_up_max_minutes": 60, "lcd_revert_seconds": 10,
              "lcd_choice_seconds": 20, "lcd_card_seconds": 2, "lcd_hint_seconds": 4, "scan_memory_seconds": 300,
              "clock_trust_minutes": 1440, "relay_restore_enabled": True, "device_fault_reporting": True,
              "device_fault_max_per_hour": 1000,
              "button_map": ["court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45",
                             "minutes:60"]}

NONCE = "9f2a4c6e8b0d1f3a"


def fake_ref(i: int) -> str:
    return ref_encode(0x10000 + i * 4099)


def fake_key(i: int) -> bytes:
    return sha256(f"fake key {i}".encode())[:KDAY_BYTES]


def court_heartbeat(extra_roster, keys, days, slug="crusaders", device_code="court-box-1", relays=None,
                    config=None):
    body = {"server_time": SERVER_TIME, "tenant_slug": slug, "device_code": device_code,
            "court_numbers": [1, 2, 3, 4], "heartbeat_seconds": 60,
            "config": config or {"slice_minutes": 15, "grace_window_minutes": 5, "walk_up_max_minutes": 60,
                                 "button_map": LCD_CONFIG["button_map"]}}
    if relays is not None:
        body["relays"] = relays
    body["roster"] = extra_roster
    body["code_step"] = ANCHOR_STEP
    body["code_step_ms"] = ANCHOR_STEP_MS
    body["code_days"] = days
    body["code_keys"] = keys
    return body


def payfor_request(tok, court, confirm, scan_age=None, label=None):
    body = {"mac": MAC, "method": "qr", "token": tok, "court": court, "nonce": NONCE, "confirm": confirm}
    if label is not None:
        body["amount_label"] = label
    if scan_age is not None:
        body["scan_age_ms"] = scan_age
    return body


def _court_box_http_all():
    v1 = DEAN.token(ANCHOR_STEP)
    reqs = []

    def rq(cid, note, path, body, render):
        reqs.append({"id": cid, "note": note, "method": "POST", "path_and_query": path, "render": render,
                     "body_hex": hexof(body)})

    rq("heartbeat-request-caps", "an m1 court box names its capability on EVERY heartbeat; the server keys "
       "the rollout on the latest one it saw. `caps` is last, after the diagnostics",
       "/api/v1/device/heartbeat",
       {"mac": MAC, "firmware_version": "2.1.0", "uptime_ms": 86400000, "caps": [CAP_CODES]},
       {"mac": MAC, "firmware_version": "2.1.0", "uptime_ms": 86400000, "caps": [CAP_CODES]})
    rq("heartbeat-request-caps-with-diagnostics", "the same capability behind restored_relays and relay_state",
       "/api/v1/device/heartbeat",
       {"mac": MAC, "firmware_version": "2.1.0", "uptime_ms": 86400000, "restored_relays": 2,
        "relay_state": ["0|1834", "2|600"], "caps": [CAP_CODES]},
       {"mac": MAC, "firmware_version": "2.1.0", "uptime_ms": 86400000, "restored_relays": 2,
        "relay_state": [[0, 1834], [2, 600]], "caps": [CAP_CODES]})
    rq("activate-request-v1", "a v1 token carries scan_age_ms: how long ago the scanner read it. The server "
       "verifies ON at (now - scan_age_ms), ±1 step. A legacy token's body is unchanged, byte for byte",
       "/api/v1/device/activate", {"mac": MAC, "method": "qr", "token": v1, "scan_age_ms": 350},
       {"mac": MAC, "token": v1, "scan_age_ms": 350})
    rq("walkup-request-v1", "the walk-up body plus scan_age_ms — the member pressed two buttons after scanning, "
       "so the code on the wire can be several steps old by now", "/api/v1/device/walkup",
       {"mac": MAC, "minutes": 60, "method": "qr", "token": v1, "court": 3, "nonce": NONCE, "scan_age_ms": 21400},
       {"mac": MAC, "minutes": 60, "token": v1, "court": 3, "nonce": NONCE, "scan_age_ms": 21400})
    rq("payfor-quote-request", "D10 step one: the member pressed a BOOKED court. confirm:false moves no money; "
       "the answer is what the glass will ask them to agree to", "/api/v1/device/pay-for",
       payfor_request(v1, 2, False, scan_age=4200),
       {"mac": MAC, "token": v1, "court": 2, "nonce": NONCE, "confirm": False, "scan_age_ms": 4200})
    rq("payfor-confirm-request", "D10 step two: pressed again. amount_label echoes EXACTLY what the glass showed, "
       "so the member paid what they agreed to or nothing (price_changed). Same nonce as the quote: a retry of "
       "an undecided confirm is answered with the first payment", "/api/v1/device/pay-for",
       payfor_request(v1, 2, True, scan_age=9100, label="50"),
       {"mac": MAC, "token": v1, "court": 2, "nonce": NONCE, "confirm": True, "amount_label": "50",
        "scan_age_ms": 9100})
    rq("payfor-quote-request-legacy", "a legacy code carries no scan_age_ms, exactly as on every other path",
       "/api/v1/device/pay-for", payfor_request("7Q3F9KM2XZ8B", 2, False),
       {"mac": MAC, "token": "7Q3F9KM2XZ8B", "court": 2, "nonce": NONCE, "confirm": False})
    rq("events-request-v1-activation", "an OFFLINE activation decided on a v1 code: the subject is the SCANNED "
       "token — the evidence the server re-checks with ON — never the roster's REF list",
       "/api/v1/device/events",
       {"mac": MAC, "boot_id": 2596069104, "uptime_ms": 86400000,
        "events": [{"seq": 42, "uptime_ms": 86390000, "kind": "activation", "court": 1, "method": "qr",
                    "subject": v1, "duration_ms": 2340000}]},
       {"mac": MAC, "boot_id": 2596069104, "uptime_ms": 86400000, "seq": 42, "event_uptime_ms": 86390000,
        "kind": "activation", "court": 1, "subject": v1, "duration_ms": 2340000})

    resps = []

    def rs(cid, kind, note, body, expect):
        resps.append({"id": cid, "kind": kind, "note": note, "body_hex": hexof(body), "expect": expect})

    f0, e0 = day_steps(TODAY, TZ)
    f1, e1 = day_steps(TOMORROW, TZ)
    roster = [roster_element([DEAN.ref, SAM.ref], 1, -300, 2400), "7Q3F9KM2XZ8B|0|-60|1200"]
    keys = [key_element(DEAN.ref, 0, DEAN.kday(TODAY)), key_element(SAM.ref, 0, SAM.kday(TODAY))]
    rs("heartbeat-response-codes", "heartbeat", "an m1 box after cut-over: a v1 roster entry for a booking with a "
       "partner, a legacy entry beside it, the step clock, one day and both players' keys",
       court_heartbeat(roster, keys, [f"{f0}|{e0}"]),
       {"roster": roster, "code_step": ANCHOR_STEP, "code_step_ms": ANCHOR_STEP_MS,
        "code_days": [f"{f0}|{e0}"], "keys_accepted": 2})
    # The widest body the contract lets a server send a court box.
    full_roster = []
    for i in range(COURT_ROSTER_CAP):
        refs = [fake_ref(i * 4 + j) for j in range(4)]
        full_roster.append(roster_element(refs, i % 4, -86400 + i * 137, 899000 + i * 137))
    full_keys = []
    for i in range(COURT_KEY_CAP):
        full_keys.append(key_element(fake_ref(i), i % 2, fake_key(i)))
    full_body = court_heartbeat(full_roster, full_keys, [f"{f0}|{e0}", f"{f1}|{e1}"], slug="w" * 64,
                                device_code="box-5ccf7f0a1b2c",
                                relays=["0|5400|3fa85f64", "1|5400|9c1d0e22", "2|5400|0b1c2d3e", "3|5400|4f5a6b7c"],
                                config=LCD_CONFIG)
    size = len(compact(full_body).encode())
    if size > COURT_MAX_BYTES:
        raise SystemExit(f"the widest court heartbeat is {size} bytes, past {COURT_MAX_BYTES}")
    rs("heartbeat-response-codes-full", "heartbeat", f"THE BUDGET: sixteen four-player v1 entries at six-digit "
       f"seconds, twenty-four keys over two day slots, a 64-character slug, all four restores and every LCD "
       f"setting — {size} bytes against the 2048-byte contract", full_body,
       {"roster_count": COURT_ROSTER_CAP, "keys_accepted": COURT_KEY_CAP, "max_bytes": COURT_MAX_BYTES,
        "bytes": size})
    legacy = court_heartbeat([], [], [])
    for k in ("code_step", "code_step_ms", "code_days", "code_keys"):
        del legacy[k]
    rs("heartbeat-response-no-codes", "heartbeat", "a server that has not shipped member codes: no code_* keys, "
       "so an m1 box keeps whatever clock and ring it had (none, after a boot) and decides legacy codes exactly "
       "as before", legacy, {"code_step": None, "keys_accepted": None})

    rs("activate-response-code-used", "activate", "a single rotating code the server already acted on (§4.4): a "
       "decision, not an outage — the roster must not get a second opinion — and it arms nothing: NOT "
       "recognised, so no button window and the scan is spent. The code may be a photo of the screen of the "
       "member whose court it just lit, and an armed window would let it buy a walk-up or a pay-for on their "
       "minutes (review round 8, D8-1)",
       {"activated": False, "reason": "code_used", "court_number": 2, "granted_seconds": 0},
       {"fallback": False, "lines": ["CODE USED", "WAIT 30 SECONDS"], "recognised": False})
    # WHICH REFUSALS ARM THE BUTTONS. A refusal about a member the server identified and whose code it has
    # not acted on arms the window, unbound — that member may still buy time or pay for a court. Everything
    # else arms nothing: a used code, a code nobody owns, and a reason this build cannot name (fail closed —
    # a refusal the box cannot read is not one it can vouch for). The server answers code_used, never these,
    # for a code it has already acted on for a court or for money, so a photo of a code that lit a court at
    # another box cannot arrive here as an arming no_booking.
    rs("activate-response-no-booking", "activate", "a known member with no booking on this box: the walk-up and "
       "pay-for starting point (§9.1), so it arms the buttons, unbound",
       {"activated": False, "reason": "no_booking", "granted_seconds": 0},
       {"fallback": False, "lines": ["NO BOOKING", "SEE THE DESK"], "recognised": True})
    rs("activate-response-wrong-court", "activate", "a known member whose booking is on a court this box does not "
       "drive: they may still buy time here, so it arms",
       {"activated": False, "reason": "wrong_court", "court_number": 7, "granted_seconds": 0},
       {"fallback": False, "lines": ["WRONG COURT", "SEE THE DESK"], "recognised": True})
    rs("activate-response-not-recognised", "activate", "a code the server cannot tie to a member of this club "
       "(another club's, an old generation, a failed ON): nobody to arm the buttons for",
       {"activated": False, "reason": "not_recognised", "granted_seconds": 0},
       {"fallback": False, "lines": ["NOT RECOGNISED", "SEE THE DESK"], "recognised": False})
    rs("activate-response-unknown-reason", "activate", "a reason this build does not know: still a decision (no "
       "second opinion from the roster), told as SEE THE DESK, and it arms nothing — fail closed",
       {"activated": False, "reason": "some_future_reason", "granted_seconds": 0},
       {"fallback": False, "lines": ["SEE THE DESK", ""], "recognised": False})
    rs("walkup-response-code-used", "walkup", "the walk-up's own shape: 409 with error code_used; decided, and not "
       "recognised — a used code may be a photo — and the scan is forgotten: of every walk-up refusal only this "
       "and not_recognised forget it (review round 9, D9-1)", {"error": "code_used"},
       {"status": 409, "decided": True, "lines": ["CODE USED", "WAIT 30 SECONDS"], "recognised": False,
        "forgets_scan": True})

    def pq(cid, note, body, expect):
        rs(cid, "payfor_quote", note, body, expect)

    pq("payfor-quote-ok", "payable: the glass asks CT2 BOOKED / PAY 50 MIN? / PRESS CT2 TO PAY",
       {"payable": True, "reason": "ok", "court_number": 2, "amount_minutes": 50, "amount_label": "50"},
       {"outcome": "quote", "court_number": 2, "amount_label": "50", "screen": "PayForQuote",
        "rows": ["CT2 BOOKED", "PAY 50 MIN?", "PRESS CT2 TO PAY", "A   B   C   D"]})
    pq("payfor-quote-widest", "the widest quote the contract allows: a four-digit court and a four-digit label "
       "of whole minutes — PAY 9999 MIN? is thirteen columns",
       {"payable": True, "reason": "ok", "court_number": 9999, "amount_minutes": 9999, "amount_label": "9999"},
       {"outcome": "quote", "court_number": 9999, "amount_label": "9999", "screen": "PayForQuote",
        "rows": ["CT9999 BOOKED", "PAY 9999 MIN?", "PRESS CT9999 TO PAY", "A   B   C   D"]})
    pq("payfor-quote-split", "a split booking is refused at the box: each player's share is theirs to pay in the "
       "app; the payer's scan stays theirs", {"payable": False, "reason": "split_booking", "court_number": 2},
       {"outcome": "refused", "screen": "PayForSplit", "rows": ["SPLIT BOOKING", "PAY IN APP"],
        "spends_scan": False})
    pq("payfor-quote-not-booked", "the court is free after all: the press is an ordinary walk-up court choice",
       {"payable": False, "reason": "not_booked", "court_number": 2}, {"outcome": "walkup"})
    pq("payfor-quote-own-booking", "their own booking: nothing to pay",
       {"payable": False, "reason": "own_booking", "court_number": 2},
       {"outcome": "refused", "screen": "PayForNothingToPay", "rows": ["NOTHING TO PAY", "Already paid for"]})
    pq("payfor-quote-already-paid", "somebody paid for it already",
       {"payable": False, "reason": "already_paid", "court_number": 2},
       {"outcome": "refused", "screen": "PayForNothingToPay", "rows": ["NOTHING TO PAY", "Already paid for"]})
    pq("payfor-quote-insufficient", "the payer cannot cover it",
       {"payable": False, "reason": "insufficient_balance", "court_number": 2},
       {"outcome": "refused", "screen": "InsufficientBalance"})
    pq("payfor-quote-not-recognised", "the code is not a member's: refused, and the scan is forgotten",
       {"payable": False, "reason": "not_recognised", "court_number": 2},
       {"outcome": "refused", "screen": "NotRecognised", "spends_scan": True})
    pq("payfor-quote-code-used", "a code the server already acted on — for money, or for a court (a photo of the "
       "code that just lit one): refused, and the scan is forgotten, so the next press cannot try a walk-up on "
       "it (review round 8, D8-1). The glass reads CODE USED / WAIT 30 SECONDS, as on every other path (D9-2)",
       {"payable": False, "reason": "code_used", "court_number": 2},
       {"outcome": "refused", "screen": "CodeUsed", "rows": ["CODE USED", "WAIT 30 SECONDS"],
        "spends_scan": True})
    pq("payfor-quote-ended", "the booking is over", {"payable": False, "reason": "ended", "court_number": 2},
       {"outcome": "refused", "screen": "SlotEnded"})
    pq("payfor-quote-unknown-reason", "a reason this build does not know is still a refusal",
       {"payable": False, "reason": "some_future_reason", "court_number": 2},
       {"outcome": "refused", "screen": "SeeTheDesk"})
    pq("payfor-quote-bad-label", "a label the glass cannot show honestly (five digits) is no decision: the box "
       "falls back to the walk-up choice rather than asking a member to agree to a number it cut. The server "
       "never sends one — it refuses such a price as amount_unshowable first",
       {"payable": True, "reason": "ok", "court_number": 2, "amount_minutes": 12345, "amount_label": "12345"},
       {"outcome": "walkup"})
    pq("payfor-quote-unshowable", "the server's own refusal of a price above 9999 minutes: a reason the box does "
       "not know by name, so SEE THE DESK — which is where such a court is settled",
       {"payable": False, "reason": "amount_unshowable", "court_number": 2},
       {"outcome": "refused", "screen": "SeeTheDesk"})

    def pc(cid, note, body, expect):
        rs(cid, "payfor_confirm", note, body, expect)

    pc("payfor-confirm-paid", "paid: the booker is refunded and both are emailed server-side; the court is "
       "already lit, so granted_seconds is 0 and nothing is switched",
       {"paid": True, "reason": "ok", "court_number": 2, "amount_minutes": 50, "amount_label": "50",
        "balance_after_minutes": 118, "replayed": False, "granted_seconds": 0},
       {"outcome": "paid", "granted_seconds": 0, "screen": "PayForPaid",
        "rows": ["PAID FOR CT2", "50 MIN PAID"]})
    pc("payfor-confirm-paid-lights", "paid for a booking nobody has started: the server grants the remainder and "
       "the box lights the court as it would for an activation",
       {"paid": True, "reason": "ok", "court_number": 2, "amount_minutes": 50, "amount_label": "50",
        "balance_after_minutes": 118, "replayed": False, "granted_seconds": 2700},
       {"outcome": "paid", "granted_seconds": 2700, "screen": "PayForPaid"})
    pc("payfor-confirm-replayed", "the same nonce again after a lost answer: the FIRST payment, never a second",
       {"paid": True, "reason": "ok", "court_number": 2, "amount_minutes": 50, "amount_label": "50",
        "balance_after_minutes": 118, "replayed": True, "granted_seconds": 0},
       {"outcome": "paid", "granted_seconds": 0, "screen": "PayForPaid"})
    pc("payfor-confirm-price-changed", "the price moved between the two presses: nothing is charged and the next "
       "press asks again", {"paid": False, "reason": "price_changed", "court_number": 2, "amount_label": "55"},
       {"outcome": "refused", "screen": "PayForPriceChanged", "rows": ["PRICE CHANGED", "Nothing charged"]})
    pc("payfor-confirm-split", "split since the quote",
       {"paid": False, "reason": "split_booking", "court_number": 2},
       {"outcome": "refused", "screen": "PayForSplit"})
    pc("payfor-confirm-insufficient", "the balance moved since the quote",
       {"paid": False, "reason": "insufficient_balance", "court_number": 2},
       {"outcome": "refused", "screen": "InsufficientBalance"})
    pc("payfor-confirm-code-used", "the code was acted on since the quote — or before it, for a court: refused, "
       "nothing charged, and the scan is forgotten",
       {"paid": False, "reason": "code_used", "court_number": 2},
       {"outcome": "refused", "screen": "CodeUsed", "rows": ["CODE USED", "WAIT 30 SECONDS"],
        "spends_scan": True})
    return {"device_mac": MAC, "requests": reqs, "responses": resps}


def _is_payfor(case):
    return case["id"].startswith("payfor-") or case.get("kind", "").startswith("payfor_")


def http_cases():
    """The court box's member-code bodies. D10 pay-for is NOT here: the court-box image stopped
    implementing it at bridge 3.0.0 (founder, 2026-11-13 — it had been unreachable from the panel
    since 2.3.0), so its vectors moved to payfor.json, which only the server reads. A vector the box
    can no longer execute is one its executed == declared count would have to skip."""
    doc = _court_box_http_all()
    return {"description": "The court box's HTTP bodies for member codes: the capability on the heartbeat, "
            "the code sync in its answer, and scan_age_ms on the paths that carry a scan.",
            "device_mac": doc["device_mac"],
            "requests": [c for c in doc["requests"] if not _is_payfor(c)],
            "responses": [c for c in doc["responses"] if not _is_payfor(c)]}


def payfor_cases():
    """D10 pay-for at the box (member-code.md section 9): the server still serves /api/v1/device/pay-for and
    is held to these bodies; no shipped court-box image after 2.3.0 sends them. Kept, not deleted, because the
    flow can return by a bridge OTA alone — it needs nothing from the Mega that v3 does not already render."""
    doc = _court_box_http_all()
    return {"description": "D10 pay-for at the box: the two-step quote and confirm, held by the server only.",
            "device_mac": doc["device_mac"],
            "requests": [c for c in doc["requests"] if _is_payfor(c)],
            "responses": [c for c in doc["responses"] if _is_payfor(c)]}


# --------------------------------------------------------------------------
# The door gate.
# --------------------------------------------------------------------------

def gate_heartbeat(roster, keys, days, slug="crusaders", gate_key="front-door", device_code="gate-0a1b2c"):
    return {"server_time": SERVER_TIME, "tenant_slug": slug, "device_code": device_code, "kind": "gate",
            "gate_key": gate_key, "heartbeat_seconds": 60, "gate": {"unlock_seconds": 15}, "roster": roster,
            "code_step": ANCHOR_STEP, "code_step_ms": ANCHOR_STEP_MS, "code_days": days, "code_keys": keys}


def gate_cases():
    v1 = DEAN.token(ANCHOR_STEP)
    reqs = []

    def rq(cid, note, path, body, render):
        reqs.append({"id": cid, "note": note, "method": "POST", "path_and_query": path, "render": render,
                     "body_hex": hexof(body)})

    rq("gate-heartbeat-request-caps", "the gate's capability, after `kind`", "/api/v1/device/heartbeat",
       {"mac": MAC, "firmware_version": "1.1.0", "uptime_ms": 86400000, "kind": "gate", "caps": [CAP_CODES]},
       {"firmware_version": "1.1.0", "uptime_ms": 86400000, "no_push": 0, "events_lost": 0})
    rq("gate-heartbeat-request-caps-with-counters", "after the two counters when they are non-zero",
       "/api/v1/device/heartbeat",
       {"mac": MAC, "firmware_version": "1.1.0", "uptime_ms": 86400000, "kind": "gate", "no_push": 4,
        "events_lost": 2, "caps": [CAP_CODES]},
       {"firmware_version": "1.1.0", "uptime_ms": 86400000, "no_push": 4, "events_lost": 2})
    rq("gate-scan-request-v1", "a door asks the moment it reads, so it sends no scan_age_ms (absent means 0): the "
       "body is the legacy shape with a 19-character token", "/api/v1/device/gate",
       {"mac": MAC, "method": "qr", "token": v1}, {"token": v1})
    rq("gate-events-request-v1-open", "an offline open decided on a v1 code: the scanned token is the subject",
       "/api/v1/device/events",
       {"mac": MAC, "boot_id": 2596069104, "uptime_ms": 86400000,
        "events": [{"seq": 7, "uptime_ms": 86390000, "kind": "gate_open", "court": -1, "method": "qr",
                    "subject": v1, "duration_ms": 3000}]},
       {"boot_id": 2596069104, "uptime_ms": 86400000, "seq": 7, "event_uptime_ms": 86390000, "subject": v1,
        "duration_ms": 3000})

    resps = []

    def rs(cid, note, body, expect):
        resps.append({"id": cid, "kind": "gate_heartbeat", "note": note, "body_hex": hexof(body), "expect": expect})

    f0, e0 = day_steps(TODAY, TZ)
    f1, e1 = day_steps(TOMORROW, TZ)
    roster = [roster_element([DEAN.ref, SAM.ref], 0, -300, 2400)]
    keys = [key_element(DEAN.ref, 0, DEAN.kday(TODAY)), key_element(SAM.ref, 0, SAM.kday(TODAY))]
    rs("gate-heartbeat-response-codes", "a named door after cut-over: one partnered booking and both keys",
       gate_heartbeat(roster, keys, [f"{f0}|{e0}"]),
       {"roster": roster, "code_step": ANCHOR_STEP, "code_step_ms": ANCHOR_STEP_MS, "keys_accepted": 2})
    full_roster = [roster_element([fake_ref(i * 4 + j) for j in range(4)], 0, -86400 + i * 137, 899000 + i * 137)
                   for i in range(GATE_ROSTER_CAP)]
    full_keys = [key_element(fake_ref(i), i % 2, fake_key(i)) for i in range(GATE_KEY_CAP)]
    full = gate_heartbeat(full_roster, full_keys, [f"{f0}|{e0}", f"{f1}|{e1}"], slug="w" * 64, gate_key="g" * 64,
                          device_code="gate-5ccf7f0a1b2c")
    size = len(compact(full).encode())
    if size > GATE_MAX_BYTES:
        raise SystemExit(f"the widest gate heartbeat is {size} bytes, past {GATE_MAX_BYTES}")
    rs("gate-heartbeat-response-codes-full", f"THE BUDGET: forty-eight four-player entries, seventy-two keys over "
       f"two day slots, 64-character slug and gate key — {size} bytes against the 4096-byte contract",
       full, {"roster_count": GATE_ROSTER_CAP, "keys_accepted": GATE_KEY_CAP, "max_bytes": GATE_MAX_BYTES,
              "bytes": size})

    # Offline door scenarios: the heartbeat above, then the network goes away.
    t = ANCHOR_STEP
    offline = []
    sync_at = 50000

    def at(step):
        return sync_at + (step - ANCHOR_STEP) * STEP_MS + 5000

    body = gate_heartbeat(roster, keys, [f"{f0}|{e0}"])
    offline.append({"id": "partner-opens-offline", "note": "the organiser and the partner each open the door "
                    "with their own code; a replay of the organiser's is refused; a stranger's is not recognised",
                    "heartbeat_body_hex": hexof(body), "received_at_ms": sync_at,
                    "scans": [{"at_ms": at(t), "token": DEAN.token(t), "released": True, "reason": "ok"},
                              {"at_ms": at(t) + 4000, "token": SAM.token(t), "released": True, "reason": "ok"},
                              {"at_ms": at(t) + 8000, "token": DEAN.token(t), "released": False,
                               "reason": "replayed"},
                              {"at_ms": at(t) + 9000, "token": KIM.token(t), "released": False,
                               "reason": "not_recognised"}]})
    early = gate_heartbeat([roster_element([ALEX.ref], 0, 3600, 7200)], [key_element(ALEX.ref, 0,
                                                                                     ALEX.kday(TODAY))],
                           [f"{f0}|{e0}"])
    offline.append({"id": "verified-but-too-early", "note": "a good code for a booking that has not opened is "
                    "too_early, exactly as a legacy code would be", "heartbeat_body_hex": hexof(early),
                    "received_at_ms": sync_at,
                    "scans": [{"at_ms": at(t), "token": ALEX.token(t), "released": False, "reason": "too_early"}]})
    offline.append({"id": "stale-sync", "note": "past the roster's maximum age the clock is not trusted either: "
                    "nobody is admitted offline", "heartbeat_body_hex": hexof(body), "received_at_ms": sync_at,
                    "scans": [{"at_ms": sync_at + 21600001, "token": DEAN.token(step_of_ms(sync_at + 21600001,
                                                                                             sync_at)),
                               "released": False, "reason": "roster_stale"}]})
    return {"description": "The door gate's bodies for member codes and what it does offline with them.",
            "device_mac": MAC, "requests": reqs, "responses": resps, "offline": offline}


# --------------------------------------------------------------------------

FILES = [
    ("sha256.json", sha256_cases, ["fw-shared", "csharp", "vitest"]),
    ("hmac.json", hmac_cases, ["fw-shared", "csharp", "vitest"]),
    ("hkdf.json", hkdf_cases, ["fw-shared", "csharp"]),
    ("totp.json", totp_cases, ["fw-shared", "csharp", "vitest"]),
    ("derivation.json", derivation_cases, ["fw-shared", "csharp", "vitest"]),
    ("clubday.json", clubday_cases, ["csharp", "vitest"]),
    ("token.json", token_cases, ["fw-shared", "csharp", "vitest"]),
    ("verify.json", verify_cases, ["fw-shared"]),
    ("roster.json", roster_cases, ["fw-shared", "csharp"]),
    ("codesync.json", codesync_cases, ["fw-shared", "csharp"]),
    ("http.json", http_cases, ["fw-court-box", "csharp"]),
    ("payfor.json", payfor_cases, ["csharp"]),
    ("gate.json", gate_cases, ["fw-door-gate", "csharp"]),
]


def counts(doc: dict) -> dict:
    return {k: len(v) for k, v in doc.items() if isinstance(v, list) and v and isinstance(v[0], dict)}


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = {
        "description": "The single rotating member code (D1): its primitives, its derivations, its token, how a "
                       "device verifies one offline, the roster and sync shapes that carry it, and the HTTP "
                       "bodies of the court box and the door gate. Generated by src/iot/tools/membercode_vectors.py "
                       "— never edit a file here by hand.",
        "authority": "docs/specs/member-code.md",
        "generator": "src/iot/tools/membercode_vectors.py",
        "files": {},
    }
    for name, build, readers in FILES:
        doc = build()
        (OUT / name).write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        manifest["files"][name] = {"read_by": readers, "case_count": counts(doc)}
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())

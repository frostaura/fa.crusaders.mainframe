#!/usr/bin/env python3
"""ota_sign.py — the club's firmware release key, and the signature every OTA image carries.

device-api.md section 7. A board boots an image only when RSASSA-PKCS1-v1_5 / SHA-256 / RSA-2048
over the canonical manifest text

    crusaders-ota/1\\n<target>\\n<version>\\n<size>\\n<sha256 of the image, lowercase hex>\\n

verifies against the modulus compiled into it (secrets.h OTA_PUBLIC_KEY_N) and configured on the
server (DeviceOta__PublicKeyModulus). This tool makes that key pair once and signs every release.

    ota_sign.py keygen --out ~/secure/crusaders-ota.key
        Writes the PRIVATE key (mode 600; it goes in the password manager and nowhere else) and prints
        the public modulus, 512 hex characters, for secrets.h and the server.
    ota_sign.py modulus --key ~/secure/crusaders-ota.key
        Prints the modulus of an existing key.
    ota_sign.py sign --key ~/secure/crusaders-ota.key --target court_bridge --version 3.0.1 firmware.bin
        Verifies its own signature, then writes firmware.bin.manifest.json beside the image: the
        {target, version, size, sha256, sig} the console's Firmware upload takes with the image.

Standard library only (secrets, hashlib), so it runs anywhere the founder has Python 3.9+. It refuses
the device-protocol corpus's TEST keys — their private halves are in the repository — in either
direction: it will neither sign with one nor print one as a release modulus.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import pathlib
import re
import secrets
import sys

MANIFEST_MAGIC = "crusaders-ota/1"
E = 65537
BITS = 2048
SIG_BYTES = BITS // 8
TARGETS = {"court_bridge": 1044464, "door_gate": 1310720}  # device-api.md §7: the largest image each board can stage
VERSION_RE = re.compile(r"^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$")
DIGEST_INFO_SHA256 = bytes.fromhex("3031300d060960864801650304020105000420")
KEY_FORMAT = "crusaders-ota-key/1"


# --- RSA, standard library only -------------------------------------------------------------

_SMALL_PRIMES = [p for p in range(3, 2000, 2) if all(p % q for q in range(3, int(p ** 0.5) + 1, 2))]


def _probably_prime(n: int, rounds: int = 64) -> bool:
    if n < 2:
        return False
    for p in _SMALL_PRIMES:
        if n % p == 0:
            return n == p
    d, r = n - 1, 0
    while d % 2 == 0:
        d //= 2
        r += 1
    for _ in range(rounds):
        a = secrets.randbelow(n - 3) + 2
        x = pow(a, d, n)
        if x in (1, n - 1):
            continue
        for _ in range(r - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _prime(bits: int) -> int:
    while True:
        # Top two bits set so p*q is a full 2048 bits; odd.
        candidate = secrets.randbits(bits) | (0b11 << (bits - 2)) | 1
        if (candidate - 1) % E != 0 and _probably_prime(candidate):
            return candidate


def generate() -> tuple[int, int]:
    """(n, d) of a fresh RSA-2048 key with e = 65537."""
    while True:
        p, q = _prime(BITS // 2), _prime(BITS // 2)
        if p == q:
            continue
        n = p * q
        if n.bit_length() != BITS:
            continue
        phi = (p - 1) * (q - 1)
        d = pow(E, -1, phi)
        return n, d


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def manifest_text(target: str, version: str, size: int, sha256: str) -> str:
    return f"{MANIFEST_MAGIC}\n{target}\n{version}\n{size}\n{sha256}\n"


def _encoded(text: str) -> int:
    digest = hashlib.sha256(text.encode("ascii")).digest()
    t = DIGEST_INFO_SHA256 + digest
    return int.from_bytes(b"\x00\x01" + b"\xff" * (SIG_BYTES - len(t) - 3) + b"\x00" + t, "big")


def sign_text(text: str, n: int, d: int) -> str:
    return b64url(pow(_encoded(text), d, n).to_bytes(SIG_BYTES, "big"))


def verify_text(text: str, sig: str, n: int) -> bool:
    """Strict: the recovered block must EQUAL the expected encoding, as every board checks it."""
    raw = b64url_decode(sig)
    if len(raw) != SIG_BYTES:
        return False
    s = int.from_bytes(raw, "big")
    return s < n and pow(s, E, n) == _encoded(text)


# --- The corpus's test keys -----------------------------------------------------------------

def corpus_test_moduli() -> set[int]:
    """Every modulus in ota/gen_cases.py: TEST keys, whose private halves are committed."""
    path = pathlib.Path(__file__).resolve().parents[2] / "contracts" / "device-protocol" / "ota" / "gen_cases.py"
    if not path.exists():
        return set()
    source = path.read_text()
    moduli = set()
    for name in ("_N_HEX", "_N2_HEX"):
        m = re.search(name + r" = \((.*?)\)", source, re.S)
        if m:
            moduli.add(int("".join(re.findall(r'"([0-9a-fA-F]+)"', m.group(1))), 16))
    return moduli


def refuse_test_key(n: int) -> None:
    if n in corpus_test_moduli():
        raise SystemExit("refused: that is a device-protocol corpus TEST key, whose private half is in the "
                         "repository. Make the club's own with `ota_sign.py keygen`.")


# --- Key files ------------------------------------------------------------------------------

def write_key(path: pathlib.Path, n: int, d: int) -> None:
    if path.exists():
        raise SystemExit(f"refused: {path} exists. A release key is made once; move the old one aside yourself.")
    body = json.dumps({"format": KEY_FORMAT, "e": E, "n": f"{n:0512x}", "d": f"{d:0512x}"}, indent=2) + "\n"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(body)


def read_key(path: pathlib.Path) -> tuple[int, int]:
    data = json.loads(path.read_text())
    if data.get("format") != KEY_FORMAT or data.get("e") != E:
        raise SystemExit(f"refused: {path} is not a {KEY_FORMAT} key file.")
    n, d = int(data["n"], 16), int(data["d"], 16)
    if n.bit_length() != BITS:
        raise SystemExit(f"refused: {path} does not hold a {BITS}-bit modulus.")
    refuse_test_key(n)
    if not verify_text("crusaders-ota-self-test\n", sign_text("crusaders-ota-self-test\n", n, d), n):
        raise SystemExit(f"refused: {path}'s private and public halves do not belong together.")
    return n, d


# --- Commands -------------------------------------------------------------------------------

def cmd_keygen(args: argparse.Namespace) -> int:
    n, d = generate()
    write_key(pathlib.Path(args.out).expanduser(), n, d)
    print(f"Private key written to {args.out} (mode 600). Put it in the password manager; never in the repository.")
    print("Public modulus — OTA_PUBLIC_KEY_N in each board's secrets.h, and DeviceOta__PublicKeyModulus on the server:")
    print(f"{n:0512x}")
    return 0


def cmd_modulus(args: argparse.Namespace) -> int:
    n, _ = read_key(pathlib.Path(args.key).expanduser())
    print(f"{n:0512x}")
    return 0


def build_manifest(image: bytes, target: str, version: str, n: int, d: int) -> dict:
    if target not in TARGETS:
        raise SystemExit(f"refused: target must be one of {', '.join(sorted(TARGETS))} (the Mega is never updated over WiFi).")
    if not VERSION_RE.match(version):
        raise SystemExit("refused: version must be major.minor.patch, each 0-999 without leading zeros.")
    if not 0 < len(image) <= TARGETS[target]:
        raise SystemExit(f"refused: a {target} image must be 1 to {TARGETS[target]} bytes; this one is {len(image)}.")
    sha = hashlib.sha256(image).hexdigest()
    sig = sign_text(manifest_text(target, version, len(image), sha), n, d)
    if not verify_text(manifest_text(target, version, len(image), sha), sig, n):
        raise SystemExit("refused: the signature did not verify against its own key.")
    return {"target": target, "version": version, "size": len(image), "sha256": sha, "sig": sig}


def cmd_sign(args: argparse.Namespace) -> int:
    n, d = read_key(pathlib.Path(args.key).expanduser())
    image_path = pathlib.Path(args.image)
    manifest = build_manifest(image_path.read_bytes(), args.target, args.version, n, d)
    out = pathlib.Path(args.out) if args.out else image_path.with_name(image_path.name + ".manifest.json")
    out.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"{args.target} {args.version}: {manifest['size']} bytes, sha256 {manifest['sha256']}")
    print(f"Manifest written to {out}. Upload it with the image under Boards › Firmware.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    k = sub.add_parser("keygen", help="make the club's release key pair (once)")
    k.add_argument("--out", required=True, help="where to write the PRIVATE key (must not exist)")
    m = sub.add_parser("modulus", help="print the public modulus of a key")
    m.add_argument("--key", required=True)
    s = sub.add_parser("sign", help="sign a firmware image and write its manifest")
    s.add_argument("--key", required=True)
    s.add_argument("--target", required=True, choices=sorted(TARGETS))
    s.add_argument("--version", required=True)
    s.add_argument("--out", help="manifest path (default: <image>.manifest.json)")
    s.add_argument("image")
    args = parser.parse_args(argv)
    return {"keygen": cmd_keygen, "modulus": cmd_modulus, "sign": cmd_sign}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())

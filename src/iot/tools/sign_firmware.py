#!/usr/bin/env python3
"""Sign a court-box firmware image for signed OTA.

WHAT THIS PRODUCES
------------------
The ESP8266 Arduino core verifies a signed update by reading a trailer appended
to the firmware image:

    [firmware bytes] [signature] [uint32 little-endian: len(signature)]

The signature is an RSA PKCS#1 v1.5 signature over SHA-256 of the firmware bytes
(everything before the signature). The running firmware verifies it with the
PUBLIC key compiled into it (src/iot/lib/otacore/include/otacore/OtaPublicKey.h);
this script produces the matching image using the PRIVATE key, which is NOT in
the repository and lives with whoever cuts releases.

WHY openssl RATHER THAN A PYTHON CRYPTO LIBRARY
-----------------------------------------------
openssl is on every developer machine and CI runner already, and this repo's iot
venv deliberately carries no crypto dependency. Shelling out keeps the signer's
own trust surface to a tool the operator already trusts, and matches the scheme
the ESP8266 core documents.

USAGE
-----
    python3 sign_firmware.py <firmware.bin> <private_key.pem> [-o <out.bin>]
    python3 sign_firmware.py --selftest

Exit status is non-zero on any failure, so a release pipeline stops rather than
shipping an unsigned or wrongly-signed image.
"""

from __future__ import annotations

import argparse
import os
import struct
import subprocess
import sys
import tempfile

# RSA-2048 produces a 256-byte signature. A different modulus would change this,
# and the board's public key is 2048-bit, so anything else is a mismatch worth
# refusing rather than silently shipping.
EXPECTED_SIG_LEN = 256


def _run(cmd: list[str]) -> None:
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"{cmd[0]} failed: {result.stderr.decode('utf-8', 'replace').strip()}"
        )


def sign_image(firmware: bytes, private_key_path: str) -> bytes:
    """Return the firmware with the signed-OTA trailer appended."""
    with tempfile.TemporaryDirectory() as tmp:
        fw_path = os.path.join(tmp, "fw.bin")
        sig_path = os.path.join(tmp, "fw.sig")
        with open(fw_path, "wb") as f:
            f.write(firmware)

        _run([
            "openssl", "dgst", "-sha256",
            "-sign", private_key_path,
            "-out", sig_path,
            fw_path,
        ])

        with open(sig_path, "rb") as f:
            signature = f.read()

    if len(signature) != EXPECTED_SIG_LEN:
        raise RuntimeError(
            f"signature is {len(signature)} bytes, expected {EXPECTED_SIG_LEN} "
            f"(is the key RSA-2048?)"
        )

    # The trailer the core reads: signature, then its length. Appending rather
    # than replacing so the firmware bytes the signature covers are exactly the
    # image that gets flashed.
    return firmware + signature + struct.pack("<I", len(signature))


def verify_image(signed: bytes, public_key_path: str) -> bool:
    """True when the trailer verifies against the public key. Mirrors the board."""
    if len(signed) < 4:
        return False
    sig_len = struct.unpack("<I", signed[-4:])[0]
    if sig_len != EXPECTED_SIG_LEN or len(signed) < 4 + sig_len:
        return False

    firmware = signed[: -(4 + sig_len)]
    signature = signed[-(4 + sig_len): -4]

    with tempfile.TemporaryDirectory() as tmp:
        fw_path = os.path.join(tmp, "fw.bin")
        sig_path = os.path.join(tmp, "fw.sig")
        with open(fw_path, "wb") as f:
            f.write(firmware)
        with open(sig_path, "wb") as f:
            f.write(signature)
        result = subprocess.run(
            ["openssl", "dgst", "-sha256", "-verify", public_key_path,
             "-signature", sig_path, fw_path],
            capture_output=True,
        )
        return result.returncode == 0


def _selftest() -> int:
    """Generate a throwaway pair, sign a sample, and prove the trailer verifies.

    This is what makes the release-signing step trustworthy without a board: it
    proves the image this script produces is exactly what the ESP8266 core's
    verifier accepts, and that a tampered image is rejected.
    """
    with tempfile.TemporaryDirectory() as tmp:
        priv = os.path.join(tmp, "priv.pem")
        pub = os.path.join(tmp, "pub.pem")
        _run(["openssl", "genrsa", "-out", priv, "2048"])
        _run(["openssl", "rsa", "-in", priv, "-pubout", "-out", pub])

        firmware = b"\xE9\x00\x00\x00" + bytes(range(256)) * 40  # a plausible image
        signed = sign_image(firmware, priv)

        # The trailer is exactly signature + 4-byte length.
        assert len(signed) == len(firmware) + EXPECTED_SIG_LEN + 4, "trailer size wrong"
        assert struct.unpack("<I", signed[-4:])[0] == EXPECTED_SIG_LEN, "length field wrong"

        # The image the board would accept.
        assert verify_image(signed, pub), "a freshly signed image did not verify"

        # A single flipped firmware byte must fail — the whole point.
        tampered = bytearray(signed)
        tampered[10] ^= 0x01
        assert not verify_image(bytes(tampered), pub), "a tampered image verified"

        # The wrong key must fail too.
        other = os.path.join(tmp, "other.pem")
        other_pub = os.path.join(tmp, "other_pub.pem")
        _run(["openssl", "genrsa", "-out", other, "2048"])
        _run(["openssl", "rsa", "-in", other, "-pubout", "-out", other_pub])
        assert not verify_image(signed, other_pub), "verified against the wrong key"

    print("sign_firmware selftest: OK")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Sign a firmware image for signed OTA.")
    parser.add_argument("firmware", nargs="?", help="the firmware .bin to sign")
    parser.add_argument("private_key", nargs="?", help="RSA-2048 private key PEM")
    parser.add_argument("-o", "--out", help="output path (default: <firmware>.signed.bin)")
    parser.add_argument("--selftest", action="store_true", help="prove the sign/verify roundtrip")
    args = parser.parse_args(argv)

    if args.selftest:
        return _selftest()

    if not args.firmware or not args.private_key:
        parser.error("firmware and private_key are required unless --selftest")

    with open(args.firmware, "rb") as f:
        firmware = f.read()
    signed = sign_image(firmware, args.private_key)
    out = args.out or (args.firmware.rsplit(".", 1)[0] + ".signed.bin")
    with open(out, "wb") as f:
        f.write(signed)
    print(f"signed {args.firmware} -> {out} (+{len(signed) - len(firmware)} bytes of trailer)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

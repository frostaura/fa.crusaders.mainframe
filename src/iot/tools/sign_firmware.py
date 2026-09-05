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
    python3 sign_firmware.py --verify <signed.bin> <OtaPublicKey.h>
    python3 sign_firmware.py --selftest

Exit status is non-zero on any failure, so a release pipeline stops rather than
shipping an unsigned or wrongly-signed image.

WHY --verify EXISTS
-------------------
Signing with the wrong private key produces a perfectly valid image that every
board on earth rejects. CI checked only that $OTA_PRIVATE_KEY parsed as a key,
never that it was the OTHER HALF of the public key committed in
lib/otacore/include/otacore/OtaPublicKey.h — and the checklist prescribes the
two acts that produce a mismatch separately (set the secret; commit the
regenerated header). A mismatched pair ships a CI-green release that makes every
box paint UPDATING / DO NOT POWER OFF, download ~400 KB, fail the BearSSL
verify, paint UPDATE FAILED, and do it again on every heartbeat, for ever, until
someone reverts the image (round-3 finding 5). So --verify runs the board's own
check against the committed header, and the release job fails on a mismatch
before anything is published.
"""

from __future__ import annotations

import argparse
import os
import re
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


class PublicKeyHeaderError(Exception):
    """The committed public-key header is missing, empty, or not a usable PEM."""


# Matches the C string-literal continuation the header is generated as:
#     "-----BEGIN PUBLIC KEY-----\n"
#     "MIIBIjANBgkq...\n"
_HEADER_LINE = re.compile(r'"([^"\\]*(?:\\.[^"\\]*)*)"')


def public_key_from_header(header_path: str) -> str:
    """The PEM out of OtaPublicKey.h, as openssl wants it.

    The header holds the key as a C string literal split one line per line of
    PEM, each ending in an escaped \\n. Rebuilt rather than pattern-matched
    loosely, so a header that has been emptied, stubbed or half-edited raises
    here instead of producing a PEM that fails verification for the wrong reason.
    """
    if not os.path.isfile(header_path):
        raise PublicKeyHeaderError(
            f"{header_path} does not exist. Signed OTA is only enforced when this header "
            f"is committed; generate a pair with src/iot/tools/generate_ota_keys.sh."
        )

    with open(header_path, "r", encoding="utf-8") as f:
        source = f.read()

    # Only the literal that follows kOtaPublicKeyPem — a comment elsewhere in the
    # file that happens to contain a quoted string must not be mistaken for it.
    marker = source.find("kOtaPublicKeyPem")
    if marker < 0:
        raise PublicKeyHeaderError(f"{header_path} does not define kOtaPublicKeyPem")

    pem = "".join(
        piece.encode().decode("unicode_escape")
        for piece in _HEADER_LINE.findall(source[marker:])
    )

    if "BEGIN PUBLIC KEY" not in pem or "END PUBLIC KEY" not in pem:
        raise PublicKeyHeaderError(
            f"{header_path} carries no PEM public key — it looks like a placeholder. "
            f"Generate a real pair with src/iot/tools/generate_ota_keys.sh and commit the header."
        )

    return pem if pem.endswith("\n") else pem + "\n"


def verify_against_header(signed: bytes, header_path: str) -> bool:
    """The board's own check: does this image verify against the COMMITTED public key?"""
    pem = public_key_from_header(header_path)
    with tempfile.TemporaryDirectory() as tmp:
        pub = os.path.join(tmp, "committed_pub.pem")
        with open(pub, "w", encoding="utf-8") as f:
            f.write(pem)

        # A header that parses as text but not as a key is a placeholder too.
        if subprocess.run(
            ["openssl", "pkey", "-pubin", "-in", pub, "-noout"], capture_output=True
        ).returncode != 0:
            raise PublicKeyHeaderError(
                f"{header_path} does not contain a public key openssl can parse."
            )

        return verify_image(signed, pub)


def _verify(signed_path: str, header_path: str) -> int:
    with open(signed_path, "rb") as f:
        signed = f.read()

    try:
        ok = verify_against_header(signed, header_path)
    except PublicKeyHeaderError as ex:
        print(f"sign_firmware --verify: {ex}", file=sys.stderr)
        return 2

    if not ok:
        print(
            f"sign_firmware --verify: {signed_path} does NOT verify against the public key "
            f"committed in {header_path}.\n"
            f"The signing key and the committed public key are not a pair. Every board would "
            f"reject this image on every heartbeat, for ever. Either OTA_PRIVATE_KEY holds the "
            f"wrong key, or the header was regenerated without the secret being updated to match "
            f"(they are separate acts — see go-live checklist item 6).",
            file=sys.stderr,
        )
        return 1

    print(f"sign_firmware --verify: {signed_path} verifies against {header_path} — OK")
    return 0


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

        # ---- the same three answers, read out of a committed header ------------
        #
        # This is what CI actually runs, so proving verify_image alone is not
        # enough: the header parser is the part that can silently produce a PEM
        # for a key nobody has, and a --verify that passed on a placeholder would
        # be worse than no check at all.
        matching = os.path.join(tmp, "OtaPublicKey.h")
        _write_header(matching, _read(pub))
        assert verify_against_header(signed, matching), "did not verify against its own committed key"

        mismatched = os.path.join(tmp, "OtaPublicKeyOther.h")
        _write_header(mismatched, _read(other_pub))
        assert not verify_against_header(signed, mismatched), "verified against a mismatched committed key"

        # A placeholder, an empty literal and a missing file are all refusals
        # rather than a pass or a crash.
        for name, contents in [
            ("Placeholder.h", 'inline constexpr char kOtaPublicKeyPem[] = "REPLACE ME\\n";\n'),
            ("Empty.h", 'inline constexpr char kOtaPublicKeyPem[] = "";\n'),
            ("NoSymbol.h", '// nothing here\n'),
        ]:
            path = os.path.join(tmp, name)
            with open(path, "w", encoding="utf-8") as f:
                f.write(contents)
            try:
                verify_against_header(signed, path)
            except PublicKeyHeaderError:
                pass
            else:
                raise AssertionError(f"{name} was accepted as a real public-key header")

        try:
            verify_against_header(signed, os.path.join(tmp, "does-not-exist.h"))
        except PublicKeyHeaderError:
            pass
        else:
            raise AssertionError("a missing header was accepted")

    print("sign_firmware selftest: OK")
    return 0


def _read(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _write_header(path: str, pem: str) -> None:
    """A header in exactly the shape generate_ota_keys.sh emits."""
    body = "".join(f'    "{line}\\n"\n' for line in pem.strip("\n").split("\n"))
    with open(path, "w", encoding="utf-8") as f:
        f.write(
            "// GENERATED — the public half of the OTA firmware signing key.\n\n"
            "namespace otacore {\n\n"
            "inline constexpr char kOtaPublicKeyPem[] =\n" + body + ";\n\n"
            "} // namespace otacore\n"
        )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Sign a firmware image for signed OTA.")
    parser.add_argument("firmware", nargs="?", help="the firmware .bin to sign")
    parser.add_argument("private_key", nargs="?", help="RSA-2048 private key PEM")
    parser.add_argument("-o", "--out", help="output path (default: <firmware>.signed.bin)")
    parser.add_argument("--selftest", action="store_true", help="prove the sign/verify roundtrip")
    parser.add_argument(
        "--verify",
        nargs=2,
        metavar=("SIGNED_BIN", "PUBLIC_KEY_HEADER"),
        help="check a signed image against the committed OtaPublicKey.h, as a board would",
    )
    args = parser.parse_args(argv)

    if args.selftest:
        return _selftest()

    if args.verify:
        return _verify(args.verify[0], args.verify[1])

    if not args.firmware or not args.private_key:
        parser.error("firmware and private_key are required unless --selftest or --verify")

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

#!/usr/bin/env bash
# Generate the OTA firmware signing keypair.
#
# Run this ONCE (or to rotate). It writes the private key where you tell it and
# regenerates the committed public-key header the firmware is built against.
#
#   src/iot/tools/generate_ota_keys.sh /secure/path/ota_private_key.pem
#
# The PRIVATE key is a secret: keep it off this repository and off shared disks.
# Whoever cuts releases needs it (sign_firmware.py reads it); nobody else does.
# The PUBLIC key is written into the tree and committed — it can only verify.
#
# Rotating invalidates every board built against the old key: a board only trusts
# images signed by the key it was flashed with, so after rotating you must re-flash
# every box once over USB with the new firmware before any OTA. That is the cost of
# the property, not a bug.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <output-path-for-private-key.pem>" >&2
  exit 2
fi

PRIVATE_OUT="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEADER="${SCRIPT_DIR}/../lib/otacore/include/otacore/OtaPublicKey.h"

if [[ -e "$PRIVATE_OUT" ]]; then
  echo "refusing to overwrite an existing private key at $PRIVATE_OUT" >&2
  echo "delete it deliberately first if you really mean to rotate" >&2
  exit 1
fi

umask 077
openssl genrsa -out "$PRIVATE_OUT" 2048
PUBLIC_PEM="$(openssl rsa -in "$PRIVATE_OUT" -pubout 2>/dev/null)"

python3 - "$HEADER" <<PYEOF
import sys
pem = """${PUBLIC_PEM}""".strip("\n").split("\n")
body = "".join(f'    "{line}\\\\n"\n' for line in pem)
open(sys.argv[1], "w").write('''// GENERATED — the public half of the OTA firmware signing key.
//
// This file's PRESENCE is what enables signed-OTA enforcement: main.cpp includes
// it when it exists and refuses every update when it does not. Committing the
// PUBLIC key is correct and safe — it can only verify, never sign. The PRIVATE
// key is NOT in this repository and must never be; it lives with whoever cuts
// releases, and src/iot/tools/sign_firmware.py signs each image with it.
//
// To rotate: generate a new pair (src/iot/tools/generate_ota_keys.sh), replace
// this file, and re-flash every board once over USB with the new public key
// before any OTA — a board only trusts images signed by the key it was built
// with, which is the whole point.
//
// Scheme: RSA-2048 + SHA-256, PKCS#1 v1.5 — the ESP8266 Arduino core's signed
// update format, verified here by BearSSL::PublicKey + SigningVerifier.

#ifndef CRUSADERS_OTACORE_OTA_PUBLIC_KEY_H
#define CRUSADERS_OTACORE_OTA_PUBLIC_KEY_H

namespace otacore {

inline constexpr char kOtaPublicKeyPem[] =
''' + body + ''';

} // namespace otacore

#endif // CRUSADERS_OTACORE_OTA_PUBLIC_KEY_H
''')
PYEOF

echo "private key written to $PRIVATE_OUT (mode 600) — keep it secret, keep it off this repo"
echo "public-key header regenerated at $HEADER — commit it"
echo "next: rebuild and re-flash every board over USB before relying on OTA"

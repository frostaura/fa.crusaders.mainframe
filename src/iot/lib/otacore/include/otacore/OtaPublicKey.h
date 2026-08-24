// GENERATED — the public half of the OTA firmware signing key.
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
    "-----BEGIN PUBLIC KEY-----\n"
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuijApKSB3TZQuOY76Qiq\n"
    "+SSHwp3eNN/Za9JT2Y8YU0UNFjMd09hds96nYwM7VrmcaIkDANBcgFmAG+52WHES\n"
    "NGKizESOZdoiys+2LmjmFcl69OIgM+RuqUe2lgizS0SIHiBKoBjCbxrPQADRnK0/\n"
    "hgYf5RCMBk1c0U7hYHogMVpyaWni90VFfPwzp9le7+HPS67Cm+arnPfNaZAvlWSv\n"
    "PKg0oZUnuhXieOvbxw0Lh24toXNjKlKE2rWUdCtF0BPW9hk3oaae3e36pIOX7ENQ\n"
    "eJRMUzhCUbW5N/XxyIKcOgrYHOVc2XSXf2Pbxos0wH7RSCWAel8hDR2gXW6nEci/\n"
    "vwIDAQAB\n"
    "-----END PUBLIC KEY-----\n";

} // namespace otacore

#endif // CRUSADERS_OTACORE_OTA_PUBLIC_KEY_H

// GENERATED FILE - DO NOT EDIT.
//
// Transcribed from src/contracts/device-protocol/discovery/cases.json and
// manifest.json by src/iot/tools/gen_discovery_corpus.py. The JSON is the
// source of truth and is shared ground: neither the firmware nor the backend
// owns it, and the .NET discovery listener reads the same file.
//
// Regenerate with:
//     src/iot/.venv/bin/python src/iot/tools/gen_discovery_corpus.py
//
// kDeclared*Cases below is copied from manifest.json verbatim. The suite
// asserts that it equals the number of cases it actually EXECUTED, and that
// none was skipped as an unrecognised kind. A checksum over the corpus would
// notice the file changed; only counting what ran notices a side quietly
// ignoring the cases it does not understand.

#ifndef CRUSADERS_TEST_DISCOVERY_CORPUS_GENERATED_H
#define CRUSADERS_TEST_DISCOVERY_CORPUS_GENERATED_H

#include <stddef.h>

namespace corpus {

constexpr size_t kMaxCaseFields = 12;

struct FieldSpec {
  const char* key;
  const char* value;
};

struct EncodeCase {
  const char* id;
  const char* kind;
  const char* verb;
  FieldSpec fields[kMaxCaseFields];
  size_t fieldCount;
  const char* wire;
  const char* canonical;
};

/// A decode case expects either a verb plus fields, or an error name.
struct DecodeCase {
  const char* id;
  const char* kind;
  const char* wire;
  bool ok;
  const char* verb;
  FieldSpec fields[kMaxCaseFields];
  size_t fieldCount;
  const char* error;
};

struct ClaimExample {
  const char* code;
  const char* nonce;
  const char* commitment;
};

// The key the corpus's signatures were produced with. A test fixture, not a
// credential: every device key is derived per device at claim time.
constexpr const char* kSigningKeyHex = "00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f";

// Claim parameters, so the suite can assert the firmware's constants against
// the corpus rather than against themselves.
constexpr const char* kClaimAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
constexpr size_t kClaimCodeLength = 8;
constexpr size_t kCommitmentHexLength = 16;

// Declared in src/contracts/device-protocol/discovery/manifest.json.
constexpr size_t kDeclaredEncodeCases = 5;
constexpr size_t kDeclaredDecodeCases = 16;
constexpr size_t kDeclaredClaimExamples = 3;

const EncodeCase kEncodeCases[] = {
    {"enc-announce-unclaimed",
     "encode",
     "ANNOUNCE",
     {{"v", "1"},
      {"mac", "5ccf7f1a2b3c"},
      {"hw", "esp8266"},
      {"fw", "1.0.0"},
      {"st", "unclaimed"},
      {"n", "a1b2c3d4e5f60718"},
      {"cch", "a13aa6c2c45e1b1c"},
      {"up", "42"},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr}},
     8,
     "CRSDR1 ANNOUNCE v=1 mac=5ccf7f1a2b3c hw=esp8266 fw=1.0.0 st=unclaimed n=a1b2c3d4e5f60718 "
     "cch=a13aa6c2c45e1b1c up=42*77\n",
     "ANNOUNCE\ncch=a13aa6c2c45e1b1c\nfw=1.0.0\nhw=esp8266\nmac=5ccf7f1a2b3c\nn=a1b2c3d4e5f60718\nst="
     "unclaimed\nup=42\nv=1"},
    {"enc-announce-claimed",
     "encode",
     "ANNOUNCE",
     {{"v", "1"},
      {"mac", "5ccf7f1a2b3c"},
      {"hw", "esp8266"},
      {"fw", "1.0.0"},
      {"mega", "0.9.1"},
      {"st", "claimed"},
      {"n", "a1b2c3d4e5f60718"},
      {"dev", "3fa85f64-5717-4562-b3fc-2c963f66afa6"},
      {"ten", "crusaders"},
      {"up", "86400"},
      {"sig", "47f850306320a76f69d4f0230a8a3ac4c53baa239059252e517cf3aaf5644c56"},
      {nullptr, nullptr}},
     11,
     "CRSDR1 ANNOUNCE v=1 mac=5ccf7f1a2b3c hw=esp8266 fw=1.0.0 mega=0.9.1 st=claimed n=a1b2c3d4e5f60718 "
     "dev=3fa85f64-5717-4562-b3fc-2c963f66afa6 ten=crusaders up=86400 "
     "sig=47f850306320a76f69d4f0230a8a3ac4c53baa239059252e517cf3aaf5644c56*4D\n",
     "ANNOUNCE\ndev=3fa85f64-5717-4562-b3fc-2c963f66afa6\nfw=1.0.0\nhw=esp8266\nmac=5ccf7f1a2b3c\nmega=0.9."
     "1\nn=a1b2c3d4e5f60718\nst=claimed\nten=crusaders\nup=86400\nv=1"},
    {"enc-offer-unsigned",
     "encode",
     "OFFER",
     {{"v", "1"},
      {"url", "http://192.168.68.20:8088"},
      {"t", "1755900000"},
      {"n", "a1b2c3d4e5f60718"},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr}},
     4,
     "CRSDR1 OFFER v=1 url=http://192.168.68.20:8088 t=1755900000 n=a1b2c3d4e5f60718*20\n",
     "OFFER\nn=a1b2c3d4e5f60718\nt=1755900000\nurl=http://192.168.68.20:8088\nv=1"},
    {"enc-offer-signed",
     "encode",
     "OFFER",
     {{"v", "1"},
      {"url", "http://192.168.68.20:8088"},
      {"t", "1755900000"},
      {"n", "a1b2c3d4e5f60718"},
      {"sig", "3cdaeca2f6fff8ad7f919b4db2efec613665072b2148e46fdef97ba44500d48c"},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr}},
     5,
     "CRSDR1 OFFER v=1 url=http://192.168.68.20:8088 t=1755900000 n=a1b2c3d4e5f60718 "
     "sig=3cdaeca2f6fff8ad7f919b4db2efec613665072b2148e46fdef97ba44500d48c*40\n",
     "OFFER\nn=a1b2c3d4e5f60718\nt=1755900000\nurl=http://192.168.68.20:8088\nv=1"},
    {"enc-announce-no-mega",
     "encode",
     "ANNOUNCE",
     {{"v", "1"},
      {"mac", "001122334455"},
      {"hw", "esp32"},
      {"fw", "2.0.0"},
      {"st", "unclaimed"},
      {"n", "0000000000000000"},
      {"cch", "1f0a7dc05a65cec5"},
      {"up", "0"},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr}},
     8,
     "CRSDR1 ANNOUNCE v=1 mac=001122334455 hw=esp32 fw=2.0.0 st=unclaimed n=0000000000000000 "
     "cch=1f0a7dc05a65cec5 up=0*16\n",
     "ANNOUNCE\ncch=1f0a7dc05a65cec5\nfw=2.0.0\nhw=esp32\nmac=001122334455\nn=0000000000000000\nst="
     "unclaimed\nup=0\nv=1"},
};

constexpr size_t kEncodeCaseCount = sizeof(kEncodeCases) / sizeof(kEncodeCases[0]);

const DecodeCase kDecodeCases[] = {
    {"dec-announce-unclaimed",
     "decode",
     "CRSDR1 ANNOUNCE v=1 mac=5ccf7f1a2b3c hw=esp8266 fw=1.0.0 st=unclaimed n=a1b2c3d4e5f60718 "
     "cch=a13aa6c2c45e1b1c up=42*77\n",
     true,
     "ANNOUNCE",
     {{"v", "1"},
      {"mac", "5ccf7f1a2b3c"},
      {"hw", "esp8266"},
      {"fw", "1.0.0"},
      {"st", "unclaimed"},
      {"n", "a1b2c3d4e5f60718"},
      {"cch", "a13aa6c2c45e1b1c"},
      {"up", "42"},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr}},
     8,
     ""},
    {"dec-announce-claimed",
     "decode",
     "CRSDR1 ANNOUNCE v=1 mac=5ccf7f1a2b3c hw=esp8266 fw=1.0.0 mega=0.9.1 st=claimed n=a1b2c3d4e5f60718 "
     "dev=3fa85f64-5717-4562-b3fc-2c963f66afa6 ten=crusaders up=86400 "
     "sig=47f850306320a76f69d4f0230a8a3ac4c53baa239059252e517cf3aaf5644c56*4D\n",
     true,
     "ANNOUNCE",
     {{"v", "1"},
      {"mac", "5ccf7f1a2b3c"},
      {"hw", "esp8266"},
      {"fw", "1.0.0"},
      {"mega", "0.9.1"},
      {"st", "claimed"},
      {"n", "a1b2c3d4e5f60718"},
      {"dev", "3fa85f64-5717-4562-b3fc-2c963f66afa6"},
      {"ten", "crusaders"},
      {"up", "86400"},
      {"sig", "47f850306320a76f69d4f0230a8a3ac4c53baa239059252e517cf3aaf5644c56"},
      {nullptr, nullptr}},
     11,
     ""},
    {"dec-offer-unsigned",
     "decode",
     "CRSDR1 OFFER v=1 url=http://192.168.68.20:8088 t=1755900000 n=a1b2c3d4e5f60718*20\n",
     true,
     "OFFER",
     {{"v", "1"},
      {"url", "http://192.168.68.20:8088"},
      {"t", "1755900000"},
      {"n", "a1b2c3d4e5f60718"},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr}},
     4,
     ""},
    {"dec-offer-signed",
     "decode",
     "CRSDR1 OFFER v=1 url=http://192.168.68.20:8088 t=1755900000 n=a1b2c3d4e5f60718 "
     "sig=3cdaeca2f6fff8ad7f919b4db2efec613665072b2148e46fdef97ba44500d48c*40\n",
     true,
     "OFFER",
     {{"v", "1"},
      {"url", "http://192.168.68.20:8088"},
      {"t", "1755900000"},
      {"n", "a1b2c3d4e5f60718"},
      {"sig", "3cdaeca2f6fff8ad7f919b4db2efec613665072b2148e46fdef97ba44500d48c"},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr}},
     5,
     ""},
    {"dec-announce-no-mega",
     "decode",
     "CRSDR1 ANNOUNCE v=1 mac=001122334455 hw=esp32 fw=2.0.0 st=unclaimed n=0000000000000000 "
     "cch=1f0a7dc05a65cec5 up=0*16\n",
     true,
     "ANNOUNCE",
     {{"v", "1"},
      {"mac", "001122334455"},
      {"hw", "esp32"},
      {"fw", "2.0.0"},
      {"st", "unclaimed"},
      {"n", "0000000000000000"},
      {"cch", "1f0a7dc05a65cec5"},
      {"up", "0"},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr}},
     8,
     ""},
    {"dec-bad-magic",
     "decode",
     "NOTUS1 ANNOUNCE v=1*00\n",
     false,
     "",
     {{nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr}},
     0,
     "bad_magic"},
    {"dec-bad-checksum",
     "decode",
     "CRSDR1 ANNOUNCE v=1 mac=5ccf7f1a2b3c*00\n",
     false,
     "",
     {{nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr}},
     0,
     "bad_checksum"},
    {"dec-lowercase-checksum",
     "decode",
     "CRSDR1 ANNOUNCE v=1 mac=5ccf7f1a2b3c*5a\n",
     false,
     "",
     {{nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr}},
     0,
     "bad_checksum"},
    {"dec-no-checksum",
     "decode",
     "CRSDR1 ANNOUNCE v=1 mac=5ccf7f1a2b3c\n",
     false,
     "",
     {{nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr}},
     0,
     "bad_frame"},
    {"dec-unknown-verb",
     "decode",
     "CRSDR1 SHOUT v=1*7A\n",
     false,
     "",
     {{nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr}},
     0,
     "bad_verb"},
    {"dec-empty-body",
     "decode",
     "CRSDR1 ANNOUNCE *00\n",
     false,
     "",
     {{nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr}},
     0,
     "bad_frame"},
    {"dec-field-without-equals",
     "decode",
     "CRSDR1 ANNOUNCE v=1 orphan*50\n",
     false,
     "",
     {{nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr}},
     0,
     "bad_frame"},
    {"dec-duplicate-key",
     "decode",
     "CRSDR1 ANNOUNCE v=1 st=claimed st=unclaimed*61\n",
     false,
     "",
     {{nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr}},
     0,
     "duplicate_key"},
    {"dec-truncated",
     "decode",
     "CRSDR1 ANNO",
     false,
     "",
     {{nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr}},
     0,
     "bad_frame"},
    {"dec-empty-packet",
     "decode",
     "",
     false,
     "",
     {{nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr}},
     0,
     "bad_frame"},
    {"dec-single-bit-flip",
     "decode",
     "CRSDR1 ANNOUNCE v=1 Mac=5ccf7f1a2b3c st=unclaimed*30\n",
     false,
     "",
     {{nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr},
      {nullptr, nullptr}},
     0,
     "bad_checksum"},
};

constexpr size_t kDecodeCaseCount = sizeof(kDecodeCases) / sizeof(kDecodeCases[0]);

const ClaimExample kClaimExamples[] = {
    {"K7RM4XPT", "a1b2c3d4e5f60718", "a13aa6c2c45e1b1c"},
    {"AAAAAAAA", "0000000000000000", "1f0a7dc05a65cec5"},
    {"99999999", "ffffffffffffffff", "65d9283c05645737"},
};

constexpr size_t kClaimExampleCount = sizeof(kClaimExamples) / sizeof(kClaimExamples[0]);

} // namespace corpus

#endif // CRUSADERS_TEST_DISCOVERY_CORPUS_GENERATED_H

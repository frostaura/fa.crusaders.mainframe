#!/usr/bin/env python3
"""Turn the shared discovery corpus into a C++ header the Unity suite can read.

WHY THIS EXISTS
---------------
src/contracts/device-protocol/discovery/cases.json is the source of truth,
shared ground that neither the firmware nor the backend owns. The Unity suite
runs on the host, but the code under test has no heap and no JSON parser, and
pulling one into the test binary would mean a parser whose own bugs surface as
protocol failures.

So the JSON is compiled to a header instead. The JSON stays authoritative: this
script only transcribes it, never edits it, and in particular it does NOT
reconcile cases.json against manifest.json. The declared case_count is copied
across verbatim, so adding a case without bumping the manifest makes the suite
go red — the anti-drift rule in src/contracts/device-protocol/README.md.

Idempotent: running it twice produces byte-identical output, clang-format
included, so a stale checkout is a diff and not a mystery.

    src/iot/.venv/bin/python src/iot/tools/gen_discovery_corpus.py
"""

from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import sys
from typing import Any

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
CORPUS_DIR = REPO_ROOT / "src" / "contracts" / "device-protocol" / "discovery"
OUT_PATH = REPO_ROOT / "src" / "iot" / "test" / "test_discovery" / "corpus_generated.h"
# Prefer the per-checkout pinned binary; CI installs the same pinned version
# onto PATH instead of into a venv, and both must format identically.
_VENV_CLANG_FORMAT = REPO_ROOT / "src" / "iot" / ".venv" / "bin" / "clang-format"
CLANG_FORMAT = _VENV_CLANG_FORMAT if _VENV_CLANG_FORMAT.exists() else shutil.which("clang-format")

# The signed claimed ANNOUNCE is the widest packet in the protocol at 11 fields.
MAX_FIELDS = 12

_ESCAPES = {
    "\\": "\\\\",
    '"': '\\"',
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}


def c_string(s: str) -> str:
    out = ['"']
    for ch in s:
        if ch in _ESCAPES:
            out.append(_ESCAPES[ch])
        elif " " <= ch <= "~":
            out.append(ch)
        else:
            raise SystemExit(f"gen_discovery_corpus: non-ASCII byte {ch!r}; the wire is ASCII")
    out.append('"')
    return "".join(out)


def field_array(fields: list[dict[str, str]], what: str) -> str:
    if len(fields) > MAX_FIELDS:
        raise SystemExit(f"gen_discovery_corpus: {what} holds {len(fields)} fields, header allows {MAX_FIELDS}")
    items = ["{%s, %s}" % (c_string(f["key"]), c_string(f["value"])) for f in fields]
    items += ["{nullptr, nullptr}"] * (MAX_FIELDS - len(fields))
    return "{" + ", ".join(items) + "}"


def encode_case(case: dict[str, Any]) -> str:
    fields = list(case["fields"])
    return "{%s, %s, %s, %s, %d, %s, %s}" % (
        c_string(case["id"]),
        c_string(case["kind"]),
        c_string(case["verb"]),
        field_array(fields, case["id"]),
        len(fields),
        c_string(case["wire"]),
        c_string(case["canonical"]),
    )


def decode_case(case: dict[str, Any]) -> str:
    expect = case["expect"]
    ok = bool(expect["ok"])
    fields = list(expect.get("fields", []))
    return "{%s, %s, %s, %s, %s, %s, %d, %s}" % (
        c_string(case["id"]),
        c_string(case["kind"]),
        c_string(case["wire"]),
        "true" if ok else "false",
        c_string(expect.get("verb", "")),
        field_array(fields, case["id"]),
        len(fields),
        c_string(expect.get("error", "")),
    )


def claim_example(example: dict[str, str]) -> str:
    return "{%s, %s, %s}" % (
        c_string(example["code"]),
        c_string(example["nonce"]),
        c_string(example["commitment"]),
    )


def main() -> int:
    cases = json.loads((CORPUS_DIR / "cases.json").read_text())
    manifest = json.loads((CORPUS_DIR / "manifest.json").read_text())
    declared = manifest["case_count"]
    claim = cases["claim"]

    lines: list[str] = []
    add = lines.append
    add("// GENERATED FILE - DO NOT EDIT.")
    add("//")
    add("// Transcribed from src/contracts/device-protocol/discovery/cases.json and")
    add("// manifest.json by src/iot/tools/gen_discovery_corpus.py. The JSON is the")
    add("// source of truth and is shared ground: neither the firmware nor the backend")
    add("// owns it, and the .NET discovery listener reads the same file.")
    add("//")
    add("// Regenerate with:")
    add("//     src/iot/.venv/bin/python src/iot/tools/gen_discovery_corpus.py")
    add("//")
    add("// kDeclared*Cases below is copied from manifest.json verbatim. The suite")
    add("// asserts that it equals the number of cases it actually EXECUTED, and that")
    add("// none was skipped as an unrecognised kind. A checksum over the corpus would")
    add("// notice the file changed; only counting what ran notices a side quietly")
    add("// ignoring the cases it does not understand.")
    add("")
    add("#ifndef CRUSADERS_TEST_DISCOVERY_CORPUS_GENERATED_H")
    add("#define CRUSADERS_TEST_DISCOVERY_CORPUS_GENERATED_H")
    add("")
    add("#include <stddef.h>")
    add("")
    add("namespace corpus {")
    add("")
    add(f"constexpr size_t kMaxCaseFields = {MAX_FIELDS};")
    add("")
    add("struct FieldSpec {")
    add("  const char* key;")
    add("  const char* value;")
    add("};")
    add("")
    add("struct EncodeCase {")
    add("  const char* id;")
    add("  const char* kind;")
    add("  const char* verb;")
    add("  FieldSpec fields[kMaxCaseFields];")
    add("  size_t fieldCount;")
    add("  const char* wire;")
    add("  const char* canonical;")
    add("};")
    add("")
    add("/// A decode case expects either a verb plus fields, or an error name.")
    add("struct DecodeCase {")
    add("  const char* id;")
    add("  const char* kind;")
    add("  const char* wire;")
    add("  bool ok;")
    add("  const char* verb;")
    add("  FieldSpec fields[kMaxCaseFields];")
    add("  size_t fieldCount;")
    add("  const char* error;")
    add("};")
    add("")
    add("struct ClaimExample {")
    add("  const char* code;")
    add("  const char* nonce;")
    add("  const char* commitment;")
    add("};")
    add("")
    add("// The key the corpus's signatures were produced with. A test fixture, not a")
    add("// credential: every device key is derived per device at claim time.")
    add(f"constexpr const char* kSigningKeyHex = {c_string(cases['signing_key_hex'])};")
    add("")
    add("// Claim parameters, so the suite can assert the firmware's constants against")
    add("// the corpus rather than against themselves.")
    add(f"constexpr const char* kClaimAlphabet = {c_string(claim['alphabet'])};")
    add(f"constexpr size_t kClaimCodeLength = {int(claim['code_length'])};")
    add(f"constexpr size_t kCommitmentHexLength = {int(claim['commitment_hex_length'])};")
    add("")
    add("// Declared in src/contracts/device-protocol/discovery/manifest.json.")
    add(f"constexpr size_t kDeclaredEncodeCases = {int(declared['encode'])};")
    add(f"constexpr size_t kDeclaredDecodeCases = {int(declared['decode'])};")
    add(f"constexpr size_t kDeclaredClaimExamples = {int(declared['claim_examples'])};")
    add("")
    add("const EncodeCase kEncodeCases[] = {")
    for case in cases["encode"]:
        add("    " + encode_case(case) + ",")
    add("};")
    add("")
    add("constexpr size_t kEncodeCaseCount = sizeof(kEncodeCases) / sizeof(kEncodeCases[0]);")
    add("")
    add("const DecodeCase kDecodeCases[] = {")
    for case in cases["decode"]:
        add("    " + decode_case(case) + ",")
    add("};")
    add("")
    add("constexpr size_t kDecodeCaseCount = sizeof(kDecodeCases) / sizeof(kDecodeCases[0]);")
    add("")
    add("const ClaimExample kClaimExamples[] = {")
    for example in claim["examples"]:
        add("    " + claim_example(example) + ",")
    add("};")
    add("")
    add("constexpr size_t kClaimExampleCount = sizeof(kClaimExamples) / sizeof(kClaimExamples[0]);")
    add("")
    add("} // namespace corpus")
    add("")
    add("#endif // CRUSADERS_TEST_DISCOVERY_CORPUS_GENERATED_H")

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text("\n".join(lines) + "\n")

    if CLANG_FORMAT:
        subprocess.run([str(CLANG_FORMAT), "-i", str(OUT_PATH)], check=True)
    else:
        print("gen_discovery_corpus: clang-format not found; output written unformatted", file=sys.stderr)

    print(
        f"gen_discovery_corpus: {len(cases['encode'])} encode + {len(cases['decode'])} decode"
        f" + {len(claim['examples'])} claim -> {OUT_PATH}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

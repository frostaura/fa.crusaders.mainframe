#!/usr/bin/env python3
"""Turn the shared serial-protocol corpus into a C++ header the Unity suite can read.

WHY THIS EXISTS
---------------
src/contracts/device-protocol/serial/cases.json is the source of truth, shared
ground that neither the firmware nor the backend owns. The Unity suite runs on
the host but the code under test is written for an ATmega2560 with 8 KB of SRAM
and no heap, so pulling a JSON parser into the test binary would mean either
linking one the firmware may not use, or hand-rolling one whose own bugs would
show up as protocol failures.

So the JSON is compiled to a header instead. The JSON stays authoritative: this
script only transcribes it, never edits it, and in particular it does NOT
reconcile cases.json against manifest.json. The declared case_count is copied
across verbatim, so adding a case without bumping the manifest makes the suite
go red — which is the anti-drift rule in src/contracts/device-protocol/README.md.

Idempotent: running it twice produces byte-identical output, clang-format
included, so a stale checkout is a diff and not a mystery.

    src/iot/.venv/bin/python src/iot/tools/gen_corpus.py
"""

from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import sys
from typing import Any

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
CORPUS_DIR = REPO_ROOT / "src" / "contracts" / "device-protocol" / "serial"
OUT_PATH = REPO_ROOT / "src" / "iot" / "test" / "test_protocol" / "corpus_generated.h"
# Prefer the per-checkout pinned binary; CI installs the same pinned version
# onto PATH instead of into a venv, and both must format identically.
_VENV_CLANG_FORMAT = REPO_ROOT / "src" / "iot" / ".venv" / "bin" / "clang-format"
CLANG_FORMAT = _VENV_CLANG_FORMAT if _VENV_CLANG_FORMAT.exists() else shutil.which("clang-format")

MAX_ARGS = 5     # !STATE is the widest frame in the protocol.
MAX_CHUNKS = 8   # A decode case may deliver its bytes in several UART reads.
MAX_EXPECTS = 4  # A legacy two-line prompt yields two frames; nothing yields more.

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
            raise SystemExit(f"gen_corpus: non-ASCII byte {ch!r} in the corpus; the wire is 8N1 ASCII")
    out.append('"')
    return "".join(out)


def c_string_array(values: list[str], size: int, what: str) -> str:
    if len(values) > size:
        raise SystemExit(f"gen_corpus: {what} holds {len(values)} entries, header allows {size}")
    items = [c_string(v) for v in values] + ["nullptr"] * (size - len(values))
    return "{" + ", ".join(items) + "}"


def frame_spec(frame: dict[str, Any]) -> str:
    args = list(frame.get("args", []))
    return "{%s, %s, %d}" % (c_string(frame["verb"]), c_string_array(args, MAX_ARGS, "frame args"), len(args))


def encode_case(case: dict[str, Any]) -> str:
    return "{%s, %s, %s, %d, %s}" % (
        c_string(case["id"]),
        c_string(case["kind"]),
        frame_spec(case["frame"]),
        int(case["cap"]),
        c_string(case["bytes"]),
    )


def expect_spec(expect: dict[str, Any]) -> str:
    if "error" in expect:
        return "{%s, %s}" % (c_string(expect["error"]), '{nullptr, {nullptr, nullptr, nullptr, nullptr, nullptr}, 0}')
    return '{"", %s}' % frame_spec(expect["frame"])


def decode_case(case: dict[str, Any]) -> str:
    expects = list(case["expect"])
    if len(expects) > MAX_EXPECTS:
        raise SystemExit(f"gen_corpus: {case['id']} expects {len(expects)} results, header allows {MAX_EXPECTS}")
    padded = [expect_spec(e) for e in expects]
    padded += ['{nullptr, {nullptr, {nullptr, nullptr, nullptr, nullptr, nullptr}, 0}}'] * (MAX_EXPECTS - len(expects))
    return "{%s, %s, %s, %s, %d, {%s}, %d}" % (
        c_string(case["id"]),
        c_string(case["kind"]),
        c_string(case["link"]),
        c_string_array(list(case["chunks"]), MAX_CHUNKS, f"{case['id']} chunks"),
        len(case["chunks"]),
        ", ".join(padded),
        len(expects),
    )


def main() -> int:
    cases = json.loads((CORPUS_DIR / "cases.json").read_text())
    manifest = json.loads((CORPUS_DIR / "manifest.json").read_text())
    declared = manifest["case_count"]

    lines: list[str] = []
    add = lines.append
    add("// GENERATED FILE - DO NOT EDIT.")
    add("//")
    add("// Transcribed from src/contracts/device-protocol/serial/cases.json and")
    add("// manifest.json by src/iot/tools/gen_corpus.py. The JSON is the source of")
    add("// truth and is shared ground: neither the firmware nor the backend owns it.")
    add("//")
    add("// Regenerate with:")
    add("//     src/iot/.venv/bin/python src/iot/tools/gen_corpus.py")
    add("//")
    add("// kDeclared*Cases below is copied from manifest.json verbatim. The suite")
    add("// asserts that it equals the number of cases it actually EXECUTED, and that")
    add("// none was skipped as an unrecognised kind. A checksum over the corpus would")
    add("// notice the file changed; only counting what ran notices a side quietly")
    add("// ignoring the cases it does not understand.")
    add("")
    add("#ifndef CRUSADERS_TEST_CORPUS_GENERATED_H")
    add("#define CRUSADERS_TEST_CORPUS_GENERATED_H")
    add("")
    add("#include <stddef.h>")
    add("")
    add("namespace corpus {")
    add("")
    add(f"constexpr size_t kMaxCaseArgs = {MAX_ARGS};")
    add(f"constexpr size_t kMaxCaseChunks = {MAX_CHUNKS};")
    add(f"constexpr size_t kMaxCaseExpects = {MAX_EXPECTS};")
    add("")
    add("struct FrameSpec {")
    add("  const char* verb;")
    add("  const char* args[kMaxCaseArgs];")
    add("  size_t argCount;")
    add("};")
    add("")
    add("struct EncodeCase {")
    add("  const char* id;")
    add("  const char* kind;")
    add("  FrameSpec frame;")
    add("  size_t cap;")
    add("  const char* bytes;")
    add("};")
    add("")
    add("/// One expected decoder result: an error name, or a frame when error is \"\".")
    add("struct ExpectSpec {")
    add("  const char* error;")
    add("  FrameSpec frame;")
    add("};")
    add("")
    add("struct DecodeCase {")
    add("  const char* id;")
    add("  const char* kind;")
    add("  const char* link;")
    add("  const char* chunks[kMaxCaseChunks];")
    add("  size_t chunkCount;")
    add("  ExpectSpec expect[kMaxCaseExpects];")
    add("  size_t expectCount;")
    add("};")
    add("")
    add("// Declared in src/contracts/device-protocol/serial/manifest.json.")
    add(f"constexpr size_t kDeclaredEncodeCases = {int(declared['encode'])};")
    add(f"constexpr size_t kDeclaredDecodeCases = {int(declared['decode'])};")
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
    add("} // namespace corpus")
    add("")
    add("#endif // CRUSADERS_TEST_CORPUS_GENERATED_H")

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text("\n".join(lines) + "\n")

    if CLANG_FORMAT:
        subprocess.run([str(CLANG_FORMAT), "-i", str(OUT_PATH)], check=True)
    else:
        print("gen_corpus: clang-format not found; output written unformatted", file=sys.stderr)

    print(f"gen_corpus: {len(cases['encode'])} encode + {len(cases['decode'])} decode -> {OUT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Generate the Arduino IDE 2 sketch folders from a PlatformIO project.

WHY THIS EXISTS
---------------
PlatformIO is the tested build and stays the tested build: `make build-iot`,
`make test-iot`, the strict-compile gate and CI all run against `platformio.ini`
and nothing here changes that. But the people who flash boards at the club do
not have PlatformIO — "open the sketch, pick the board, Upload" is a deployment
route the Arduino IDE gives for free — so this script renders the same sources
into ready-to-open sketch folders that need nothing from the Library Manager and
no terminal.

Two builds of the same firmware only stay the same firmware if the second one is
DERIVED. Everything this script emits — the sources, the third-party libraries,
and every `-D` the PlatformIO environments set — is read out of the tree at
generation time. `make arduino-check` regenerates and fails on `git diff`, so a
change to `platformio.ini` or to any source that is not mirrored here is a red
build rather than a box running firmware nobody wrote.

WHY IT IS PROJECT-NEUTRAL AND LIVES HERE
----------------------------------------
It used to be `court-box/tools/arduino_export.py`, with the project hard-coded
as its own grandparent directory, a hard-coded two-entry target list, one
hard-coded rewrite table and a `render_readme()` that was 135 lines of
court-box prose. That was fine while the court box was the only board anybody
flashed — and it made "the gate can only be flashed from PlatformIO" a go-live
blocker, because generalising it was a day's work nobody had done.

Everything project-specific now lives in PROJECTS below, one entry per firmware,
and everything mechanical — the ini reader, the `#include` closure across both
library roots, the include rewriting, the `lib_deps` vendoring, the
`build_config.h` emitter, the iCloud duplicate sweep — is shared and did not
need to change to gain a second project.

WHAT IT DOES NOT MIRROR, AND WHY THAT IS SAFE
---------------------------------------------
  * `-Wall -Wextra` and the strict-compile gate. Warnings are not behaviour, and
    the real gate is `make lint-iot` on the PlatformIO build.
  * `-std=gnu++17`. Both the Arduino AVR core and the ESP32 one hard-code
    `-std=gnu++11` in their `platform.txt` and a sketch cannot override it, so
    EVERY project's `lib/` has to be valid C++11 as well as C++17 — the gate's
    as much as the court box's. `[env:door_gate]`'s `build_unflags =
    -std=gnu++11` buys nothing here, because that is a PlatformIO mechanism and
    the IDE never sees it. `inline constexpr` variables survive as a GCC
    extension; a multi-statement `constexpr` function does not, and one in
    `LockDriver.h` was green under `pio run` and red under `arduino-cli`.
    The arduino-cli compile in CI is the only gate for this.

BUILD FLAGS ARE UNFLAGGED, NOT JUST COLLECTED
---------------------------------------------
`build_unflags` is applied by exact token, exactly as PlatformIO applies it, and
the result is checked for a name defined twice. That is what makes the gate's
`FW_VERSION_*` right in the sketch: `[common]` pins the court box's 2.0.0 and is
kept byte-identical across all three projects, so `[env:door_gate]` unflags
those three and sets 1.0.0 in their place. Collecting flags without unflagging
would emit both, and the sketch would report a version the PlatformIO build
never produces.

WHERE IT READS lib/ FROM
------------------------
Two roots, not one: the project's own `lib/` and the device-agnostic
`../shared/lib` that `platformio.ini` reaches with `lib_extra_dirs`. The sketch
has no such notion — every namespace lands as one flat directory under `src/` —
but the closure has to look in both or the export silently emits a sketch
missing half its sources. A namespace defined in two roots at once is refused
rather than picked between.

LAYOUT IT PRODUCES
------------------
    <project>/arduino/<sketch>/<sketch>.ino      <- src/<dir>/main.cpp
    <project>/arduino/<sketch>/src/build_config.h  <- the -D flags, unflagged
    <project>/arduino/<sketch>/src/<ns>/...      <- one directory per lib/ namespace
    <project>/arduino/<sketch>/src/<ThirdParty>/...  <- vendored from .pio/libdeps

The Arduino IDE compiles a sketch's `src/` recursively but adds no include root,
so every `#include "<ns>/X.h"` is rewritten to a path that resolves relative to
the including file: `../<ns>/X.h` from inside `src/`, `src/<ns>/X.h` from the
`.ino`. Nothing else about the sources is touched.

Run it with the venv python: `make arduino-export`.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

# src/iot — the parent of every firmware project.
IOT = Path(__file__).resolve().parent.parent
REPO = IOT.parent.parent

# How this script names itself in every file it writes. Derived rather than
# spelled out, so moving the tool again cannot leave 200 generated files
# pointing at a path that no longer exists.
TOOL = os.path.relpath(Path(__file__).resolve(), REPO)

# Libraries that must never reach a board. posix_hal and posix_gate_hal are the
# two simulators' host HALs; hal_fakes is test infrastructure. All three compile
# for the host only, and a closure that reaches any of them means an #include
# went the wrong way.
FORBIDDEN_LIBS = {"posix_hal", "posix_gate_hal", "hal_fakes"}


def forbidden_namespaces() -> set[str]:
    """The include namespaces of FORBIDDEN_LIBS, ACROSS EVERY PROJECT under src/iot.

    Deliberately not scoped to the project being exported. posix_hal used to
    live in court-box/lib, so the door gate's library roots could not see it —
    which meant a `#include "posix_hal/PosixClock.h"` in the gate's composition
    root was not refused by the closure at all, just silently not vendored, and
    the failure arrived later as a missing header from arduino-cli. A rule that
    only fires in the project that happens to own the forbidden library is not
    the rule anybody thinks it is. It still is not scoped: posix_hal is in
    shared/lib now and posix_gate_hal is in door-gate/lib, so the same rule has
    to fire in both directions.

    Derived from the tree rather than listed, so a rename of the namespace
    directory cannot leave this looking for one that no longer exists.
    """
    out: set[str] = set()
    for project in sorted(IOT.iterdir()):
        for lib in FORBIDDEN_LIBS:
            inc = project / "lib" / lib / "include"
            if inc.is_dir():
                out.update(d.name for d in inc.iterdir() if d.is_dir())
    if not out:
        raise SystemExit(
            "no namespace found for any of " + ", ".join(sorted(FORBIDDEN_LIBS)) +
            " — this guard has stopped guarding anything"
        )
    return out


@dataclass
class Project:
    """One firmware project, resolved."""

    name: str
    config: dict

    @property
    def root(self) -> Path:
        return IOT / self.name

    @property
    def out(self) -> Path:
        return self.root / "arduino"

    @property
    def ini_path(self) -> str:
        return os.path.relpath(self.root / "platformio.ini", REPO)


# ---------------------------------------------------------------------------
# platformio.ini
# ---------------------------------------------------------------------------


def parse_ini(path: Path) -> dict[str, dict[str, str]]:
    """Minimal PlatformIO ini reader.

    Not configparser: PlatformIO indents `;` comment lines inside multi-line
    values, and configparser keeps those as part of the value.
    """
    sections: dict[str, dict[str, str]] = {}
    section: dict[str, str] | None = None
    key: str | None = None
    for raw in path.read_text(encoding="utf-8").splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith(";"):
            continue
        if stripped.startswith("[") and stripped.endswith("]"):
            section = sections.setdefault(stripped[1:-1], {})
            key = None
            continue
        if section is None:
            continue
        if raw[:1] in (" ", "\t") and key is not None:
            section[key] += "\n" + stripped
            continue
        if "=" in stripped:
            key, _, value = stripped.partition("=")
            key = key.strip()
            section[key] = value.strip()
    return sections


def expand(value: str, ini: dict[str, dict[str, str]], depth: int = 0) -> str:
    if depth > 8:
        raise SystemExit("platformio.ini: ${} interpolation is looping")

    def sub(match: re.Match[str]) -> str:
        sec, _, k = match.group(1).partition(".")
        if sec not in ini or k not in ini[sec]:
            raise SystemExit(f"platformio.ini: ${{{match.group(1)}}} does not resolve")
        return expand(ini[sec][k], ini, depth + 1)

    return re.sub(r"\$\{([^}]+)\}", sub, value)


def tokens(value: str) -> list[str]:
    out: list[str] = []
    for line in value.splitlines():
        line = line.strip()
        if not line or line.startswith(";"):
            continue
        out.extend(line.split())
    return out


def defines_for(env: str, ini: dict[str, dict[str, str]]) -> list[str]:
    """Every -D the environment sets, in platformio.ini order, AFTER unflagging.

    `build_unflags` is applied by exact token, which is what PlatformIO does and
    is the whole reason it works: `[env:door_gate]` unflags
    `-DFW_VERSION_MAJOR=2` (the court box's, inherited from the byte-identical
    `[common]` block) and adds `-DFW_VERSION_MAJOR=1`. The unflag token names
    the OLD value, so the new one survives.
    """
    key = f"env:{env}"
    if key not in ini:
        raise SystemExit(f"platformio.ini has no [{key}]")

    flags = tokens(expand(ini[key].get("build_flags", ""), ini))
    unflags = set(tokens(expand(ini[key].get("build_unflags", ""), ini)))
    kept = [t[2:] for t in flags if t.startswith("-D") and t not in unflags]

    # A name defined twice is either a missing unflag or an unflag whose token
    # no longer matches the flag it was written for. Both produce a sketch that
    # disagrees with the PlatformIO build about something — the gate's firmware
    # version, first of all — so this is a failed export, not a warning.
    seen: dict[str, str] = {}
    for d in kept:
        name, _, value = d.partition("=")
        if name in seen and seen[name] != value:
            raise SystemExit(
                f"[{key}] defines {name} twice, as {seen[name]!r} and {value!r}. "
                f"A build_unflags entry must name the flag EXACTLY as it appears "
                f"(including its value) to remove it."
            )
        seen[name] = value
    return kept


def lib_deps_for(env: str, ini: dict[str, dict[str, str]]) -> list[str]:
    """The `owner/Name@version` coordinates the environment declares."""
    return tokens(expand(ini[f"env:{env}"].get("lib_deps", ""), ini))


def lib_roots(project: Project, ini: dict[str, dict[str, str]]) -> list[Path]:
    """Every directory PlatformIO resolves a library from, in LDF order.

    This project's own lib/ first, then whatever `lib_extra_dirs` names. Read
    from the ini rather than hardcoded, so the export cannot drift from what the
    tested build actually compiles.
    """
    roots = [project.root / "lib"]
    for section in ("env", "platformio"):
        raw = ini.get(section, {}).get("lib_extra_dirs", "")
        for token in tokens(expand(raw, ini)):
            root = (project.root / token).resolve()
            if not root.is_dir():
                raise SystemExit(f"platformio.ini: lib_extra_dirs names {token}, which is not a directory")
            if root not in roots:
                roots.append(root)
    return roots


# ---------------------------------------------------------------------------
# lib/ closure
# ---------------------------------------------------------------------------


def namespaces(roots: list[Path]) -> tuple[dict[str, str], dict[str, Path]]:
    """include-namespace -> lib directory name, plus where each lib lives.

    Across every root, because a project library includes a shared one by the
    same `<ns>/X.h` path either way. A namespace claimed by two roots is an
    error, not a precedence question: PlatformIO's own LDF would pick one and
    the sketch would carry the other.
    """
    out: dict[str, str] = {}
    where: dict[str, Path] = {}
    for root in roots:
        for lib in sorted(root.iterdir()):
            inc = lib / "include"
            if not inc.is_dir():
                continue
            dirs = [d.name for d in sorted(inc.iterdir()) if d.is_dir()]
            if len(dirs) != 1:
                raise SystemExit(f"{lib}/include must hold exactly one namespace dir, found {dirs}")
            if lib.name in where and where[lib.name] != lib:
                raise SystemExit(f"library {lib.name} exists in both {where[lib.name].parent} and {root}")
            out[dirs[0]] = lib.name
            where[lib.name] = lib
    return out, where


INCLUDE_RE = re.compile(r'^\s*#\s*include\s*(?:"([^"]+)"|<([^>]+)>)')
REWRITE_RE = re.compile(r'^([ \t]*#[ \t]*include[ \t]*)(?:"([^"]+)"|<([^>]+)>)', re.M)


def scan_includes(path: Path) -> list[str]:
    found: list[str] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        m = INCLUDE_RE.match(line)
        if m:
            found.append(m.group(1) or m.group(2))
    return found


def lib_files(lib: str, where: dict[str, Path]) -> list[Path]:
    root = where[lib]
    files = list((root / "include").rglob("*.h")) if (root / "include").is_dir() else []
    if (root / "src").is_dir():
        files += list((root / "src").rglob("*.cpp")) + list((root / "src").rglob("*.c"))
    return sorted(files)


def closure(seeds: list[Path], ns_map: dict[str, str], where: dict[str, Path]) -> list[str]:
    """Every lib/ directory reachable by #include from the target's sources."""
    forbidden_ns = forbidden_namespaces()
    needed: set[str] = set()
    queue = list(seeds)
    seen: set[Path] = set()
    while queue:
        path = queue.pop()
        if path in seen:
            continue
        seen.add(path)
        for inc in scan_includes(path):
            ns = inc.split("/")[0]
            if ns in forbidden_ns:
                raise SystemExit(
                    f"{path} includes <{inc}>, which is host-only and must never be compiled "
                    f"for a board"
                )
            if ns not in ns_map:
                continue
            lib = ns_map[ns]
            if lib in FORBIDDEN_LIBS:
                raise SystemExit(f"{path} reaches lib/{lib}, which must never be compiled for a board")
            if lib not in needed:
                needed.add(lib)
                queue.extend(lib_files(lib, where))
    return sorted(needed)


# ---------------------------------------------------------------------------
# Rewriting
# ---------------------------------------------------------------------------

GENERATED_BANNER = f"// GENERATED by {TOOL} — edit the PlatformIO sources, not this copy.\n"


def rewrite(text: str, prefix: str, ns_map: dict[str, str], vendor_headers: dict[str, str]) -> str:
    """Point every project and vendored include at a path that resolves here.

    `prefix` is what turns a PlatformIO include root into a relative path:
    `../` for a file inside `src/<ns>/`, `src/` for the `.ino` at sketch root.
    """

    def fix(match: re.Match[str]) -> str:
        lead, quoted, angled = match.group(1), match.group(2), match.group(3)
        target = quoted or angled
        if target.split("/")[0] in ns_map:
            return f'{lead}"{prefix}{target}"'
        if angled and target in vendor_headers:
            return f'{lead}"{prefix}{vendor_headers[target]}"'
        return match.group(0)

    return REWRITE_RE.sub(fix, text)


def emit(src: Path, dst: Path, prefix: str, ns_map: dict[str, str], vendor_headers: dict[str, str],
         extra_subs: list[tuple[str, str]] | None = None) -> None:
    text = src.read_text(encoding="utf-8")
    for old, new in extra_subs or []:
        if old not in text:
            raise SystemExit(f"{src}: expected to rewrite {old!r} and it is not there — the source moved")
        text = text.replace(old, new)
    text = rewrite(text, prefix, ns_map, vendor_headers)
    # build_config.h carries the -D flags the IDE cannot pass on the command
    # line, so it has to be first in EVERY translation unit, not just the .ino:
    # a target guard like `#ifdef TARGET_COURT_MEGA` sits at the top of files
    # the .ino never includes.
    text = GENERATED_BANNER + f'#include "{prefix}build_config.h"\n' + text
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(text, encoding="utf-8")


# ---------------------------------------------------------------------------
# Vendoring
# ---------------------------------------------------------------------------

VENDOR_SKIP_DIRS = {"examples", "extras", ".github", "test", "tests"}


def vendor(project: Project, dep: str, env: str, sketch_src: Path) -> tuple[str, str]:
    """Copy a lib_deps package out of .pio/libdeps into the sketch.

    Returns (name, version). The package must already be resolved, which is
    what `make build-iot` does — this script never reaches the network.
    """
    name = dep.split("/")[-1].split("@")[0]
    src = project.root / ".pio" / "libdeps" / env / name
    if not src.is_dir():
        raise SystemExit(
            f"{src} is missing — run `make build-iot` first so PlatformIO resolves {dep}"
        )
    dst = sketch_src / name
    for path in sorted(src.rglob("*")):
        rel = path.relative_to(src)
        if any(part in VENDOR_SKIP_DIRS for part in rel.parts):
            continue
        if not path.is_file():
            continue
        out = dst / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, out)
    version = ""
    props = src / "library.properties"
    if props.is_file():
        for line in props.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("version="):
                version = line.split("=", 1)[1].strip()
    if not version and "@" in dep:
        version = dep.split("@")[-1]
    return name, version


def vendor_root_headers(sketch_src: Path, name: str) -> dict[str, str]:
    """Root-level headers of a vendored package, so `<X.h>` can be redirected."""
    out: dict[str, str] = {}
    for path in sorted((sketch_src / name).glob("*")):
        if path.suffix in (".h", ".hpp") and path.is_file():
            out[path.name] = f"{name}/{path.name}"
    return out


# ---------------------------------------------------------------------------
# Per-project configuration — the ONLY project-specific data in this file
# ---------------------------------------------------------------------------

# The court bridge's composition root names secrets.h by its PlatformIO path,
# which does not exist in a sketch folder: there, secrets.h sits next to the
# .ino. Each pair is asserted to apply, so a reworded #error fails the export
# instead of silently shipping an instruction that points at nothing.
COURT_BRIDGE_SUBS = [
    ('__has_include("common/secrets.h")', '__has_include("secrets.h")'),
    ('#include "common/secrets.h"', '#include "secrets.h"'),
    (
        '"src/iot/court-box/src/common/secrets.h is missing — copy secrets.h.example to secrets.h and fill in',
        '"secrets.h is missing from this sketch folder — copy secrets.h.example to secrets.h and fill in',
    ),
    ("see src/iot/court-box/src/common/secrets.h.example", "see secrets.h.example, next to court_bridge.ino"),
    ("compiled in from src/common/secrets.h", "compiled in from secrets.h, next to this sketch"),
    ("them is `make flash-bridge`, which is a two-minute job",
     "them is another Upload from the Arduino IDE, which is a two-minute job"),
]

DOOR_GATE_SUBS = [
    ('__has_include("common/secrets.h")', '__has_include("secrets.h")'),
    ('#include "common/secrets.h"', '#include "secrets.h"'),
    (
        '"src/iot/door-gate/src/common/secrets.h is missing — copy secrets.h.example to secrets.h and fill in',
        '"secrets.h is missing from this sketch folder — copy secrets.h.example to secrets.h and fill in',
    ),
    ("see src/iot/door-gate/src/common/secrets.h.example", "see secrets.h.example, next to door_gate.ino"),
]

COURT_BOX_SECRETS_EXAMPLE_SUBS = [
    ("// Copy to secrets.h and fill in all four values before flashing. secrets.h is",
     "// Copy to secrets.h — in THIS folder, beside court_bridge.ino — and fill in all\n"
     "// four values before flashing. secrets.h is"),
    ("`make flash-bridge`. See src/iot/court-box/README.md's Flashing section.",
     "Upload again from the Arduino IDE. See\n// src/iot/court-box/arduino/README.md."),
]

DOOR_GATE_SECRETS_EXAMPLE_SUBS = [
    ("// Copy to secrets.h and fill in all four values before flashing. secrets.h is",
     "// Copy to secrets.h — in THIS folder, beside door_gate.ino — and fill in all\n"
     "// four values before flashing. secrets.h is"),
    ("To change any of these: edit the value and reflash. See\n"
     "// src/iot/door-gate/README.md's Flashing section.",
     "To change any of these: edit the value and Upload again from\n"
     "// the Arduino IDE. See src/iot/door-gate/arduino/README.md."),
]

ESP8266_INDEX = "https://arduino.esp8266.com/stable/package_esp8266com_index.json"
ESP32_INDEX = "https://espressif.github.io/arduino-esp32/package_esp32_index.json"


def project_configs() -> dict[str, dict]:
    """One entry per firmware project.

    `cores` is the pair that makes "both builds are the same firmware" a claim
    rather than a hope: the Boards Manager core and, beside it, the PlatformIO
    package `platformio.ini` pins. Bump both halves together or not at all.
    """
    return {
        "court-box": {
            "targets": [
                {"env": "court_mega", "src": "court_mega", "sketch": "court_mega", "secrets": None,
                 "fqbn": "arduino:avr:mega:cpu=atmega2560"},
                {"env": "court_bridge", "src": "court_bridge", "sketch": "court_bridge",
                 "secrets": COURT_BRIDGE_SUBS,
                 "secrets_example_subs": COURT_BOX_SECRETS_EXAMPLE_SUBS,
                 "fqbn": "esp8266:esp8266:generic:eesz=4M2M,xtal=80,baud=115200"},
            ],
            "cores": [
                ("arduino:avr", "1.8.6", "atmelavr@5.0.0 / framework-arduino-avr 5.2.0"),
                ("esp8266:esp8266", "3.1.2", "espressif8266@4.2.1 / framework-arduinoespressif8266 3.30102.0"),
            ],
            "board_urls": [ESP8266_INDEX],
            "readme": lambda project, results: render_court_box_readme(project, results),
        },
        "door-gate": {
            "targets": [
                {"env": "door_gate", "src": "gate", "sketch": "door_gate",
                 "secrets": DOOR_GATE_SUBS,
                 "secrets_example_subs": DOOR_GATE_SECRETS_EXAMPLE_SUBS,
                 "fqbn": "esp32:esp32:esp32"},
            ],
            "cores": [
                ("esp32:esp32", "2.0.17", "espressif32@6.9.0 / framework-arduinoespressif32 3.20017"),
            ],
            "board_urls": [ESP32_INDEX],
            "readme": lambda project, results: render_door_gate_readme(project, results),
        },
    }


# ---------------------------------------------------------------------------
# Targets
# ---------------------------------------------------------------------------


def build_config(project: Project, defines: list[str], env: str) -> str:
    lines = [
        f"// GENERATED by {TOOL} — do not edit.",
        "//",
        f"// Every -D that `[env:{env}]` in {project.ini_path} sets, in its order.",
        "// The Arduino IDE cannot pass build flags, so they arrive as #defines here and",
        "// this header is included first in every file of the sketch. The two builds",
        "// must produce the same behaviour; `make arduino-check` is what enforces it.",
        "#pragma once",
        "",
    ]
    for d in defines:
        name, sep, value = d.partition("=")
        lines.append(f"#define {name} {value}" if sep else f"#define {name} 1")
    lines.append("")
    return "\n".join(lines)


def export_target(project: Project, target: dict, ini: dict[str, dict[str, str]],
                  ns_map: dict[str, str], where: dict[str, Path]) -> dict:
    env, sketch_name = target["env"], target["sketch"]
    sketch = project.out / sketch_name
    sketch_src = sketch / "src"

    # Wipe src/ and the .ino only. secrets.h is the technician's and is never
    # ours to delete.
    if sketch_src.exists():
        shutil.rmtree(sketch_src)
    sketch_src.mkdir(parents=True)

    main = project.root / "src" / target["src"] / "main.cpp"
    if not main.is_file():
        raise SystemExit(f"{main} is missing")

    libs = closure([main], ns_map, where)
    defines = defines_for(env, ini)
    deps = lib_deps_for(env, ini)

    vendored: list[tuple[str, str]] = []
    vendor_headers: dict[str, str] = {}
    for dep in deps:
        name, version = vendor(project, dep, env, sketch_src)
        vendored.append((name, version))
        vendor_headers.update(vendor_root_headers(sketch_src, name))

    ns_by_lib = {lib: ns for ns, lib in ns_map.items()}
    for lib in libs:
        ns = ns_by_lib[lib]
        for path in lib_files(lib, where):
            emit(path, sketch_src / ns / path.name, "../", ns_map, vendor_headers)

    emit(main, sketch / f"{sketch_name}.ino", "src/", ns_map, vendor_headers, target["secrets"])

    (sketch_src / "build_config.h").write_text(build_config(project, defines, env), encoding="utf-8")

    # Is each vendored package actually included by anything? A lib_deps entry
    # that nothing includes is dead weight in the sketch folder, and the honest
    # place to say so is the README rather than a comment nobody reads.
    ours = [p for p in sorted(sketch_src.rglob("*")) if p.is_file() and p.suffix in (".h", ".cpp")
            and p.parts[len(sketch_src.parts)] not in {n for n, _ in vendored}]
    ours.append(sketch / f"{sketch_name}.ino")
    used = {name for name in {n for n, _ in vendored}
            for f in ours if f"{name}/" in f.read_text(encoding="utf-8", errors="replace")}
    unused = sorted({n for n, _ in vendored} - used)

    if target["secrets"] is not None:
        example = project.root / "src" / "common" / "secrets.h.example"
        text = example.read_text(encoding="utf-8")
        for old, new in target["secrets_example_subs"]:
            if old not in text:
                raise SystemExit(f"{example}: expected to rewrite {old!r} and it is not there")
            text = text.replace(old, new)
        (sketch / "secrets.h.example").write_text(text, encoding="utf-8")

    return {"env": env, "sketch": sketch_name, "libs": libs, "defines": defines,
            "vendored": vendored, "unused": unused, "fqbn": target["fqbn"]}


# ---------------------------------------------------------------------------
# READMEs — one per project, because a flashing instruction is not generic
# ---------------------------------------------------------------------------


def unused_note(results: list[dict]) -> str:
    """Vendored packages nothing in the firmware actually includes."""
    lines = []
    for r in results:
        for name in r["unused"]:
            lines.append(
                f"\n`{name}` is vendored because `[env:{r['env']}]` declares it in `lib_deps`, "
                f"but **nothing in the firmware includes it** — it costs nothing to compile "
                f"(header-only, and no translation unit pulls it in) and it is here so the two "
                f"builds resolve the same dependency set. Deleting the `lib_deps` line is what "
                f"would remove it from both."
            )
    return "".join(lines)


def vendor_rows(project: Project, r: dict) -> str:
    rows = []
    for name, version in r["vendored"]:
        licences = sorted(p.name for p in (project.out / r["sketch"] / "src" / name).glob("LICENSE*"))
        note = ", ".join(f"`{lic}`" for lic in licences) or "none shipped upstream"
        rows.append(f"| `{name}` | {version} | `{r['sketch']}/src/{name}/` | {note} |")
    return "\n".join(rows) or "| _(none)_ | | | |"


def render_court_box_readme(project: Project, results: list[dict]) -> str:
    cores = project.config["cores"]
    by_env = {r["env"]: r for r in results}
    mega, bridge = by_env["court_mega"], by_env["court_bridge"]

    return f"""# Flashing the court box from the Arduino IDE

**This is the deployment route.** Open the sketch, pick the board and the port,
press Upload. No terminal, no `make`, and nothing to install from the Library
Manager — every library either half needs is vendored inside its own `src/`.

These two folders are **generated**. Edit the PlatformIO sources under
`src/iot/court-box/` (and the shared libraries in `src/iot/shared/lib/`), then run
`make arduino-export`; `make arduino-check` regenerates and
fails if the committed copies have gone stale. Editing a file in here is a
change that the next export deletes.

## Once per machine

1. Install the **Arduino IDE 2** (2.3 or newer).
2. **Preferences → Additional boards manager URLs**, add:
   `{ESP8266_INDEX}`
3. **Boards Manager**, install both:
   - **Arduino AVR Boards** {cores[0][1]} (for the Mega)
   - **esp8266** by ESP8266 Community {cores[1][1]} (for the bridge)

Those two versions are what this export is compiled against in CI. They match
the platforms `src/iot/court-box/platformio.ini` pins ({cores[0][2]}; {cores[1][2]}), which
is what makes the IDE build and the PlatformIO build the same firmware.

No USB-serial driver is needed on current macOS. Only if **no** port ever
appears: `brew install --cask wch-ch34x-usb-serial-driver`, then replug.

## Once per checkout

Copy `court_bridge/secrets.h.example` to `court_bridge/secrets.h` — in the same
folder as `court_bridge.ino` — and fill in all four values. It is gitignored, and
the bridge **refuses to compile without it**.

| Value | What it is |
|---|---|
| `WIFI_SSID` / `WIFI_PASSWORD` | The club WiFi. The box takes a DHCP lease. |
| `API_BASE_URL` | The backend's **LAN** address and port, no trailing slash — e.g. `http://192.168.1.10:8088`. |
| `DEVICE_API_KEY` | The tenant's device API key, from the admin Devices page. Goes out as `Authorization: Bearer <key>`. |

Regenerating the key on the Devices page invalidates the old one **immediately**,
so a regeneration is a reflash and has to be planned as one.

## Flash, in this order

The box has one USB socket and a DIP block that routes it to one of the two
chips, so every upload is a switch change first. **Set the switches before you
press Upload**, and leave the box powered throughout.

### 1 — the Mega

| DIP | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| Mega upload | OFF | OFF | **ON** | **ON** | OFF | OFF | OFF | OFF |

- Open `court_mega/court_mega.ino`
- **Tools → Board → Arduino AVR Boards → Arduino Mega or Mega 2560**
- **Tools → Processor → ATmega2560 (Mega 2560)**
- **Tools → Port** — the `/dev/cu.usbserial-*` (macOS) or `COM*` (Windows) that
  appears when the box is plugged in
- **Upload**

### 2 — the bridge

| DIP | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| Bridge upload | OFF | OFF | OFF | OFF | **ON** | **ON** | **ON** | OFF |
| Bridge monitor | OFF | OFF | OFF | OFF | **ON** | **ON** | OFF | OFF |

- Open `court_bridge/court_bridge.ino` (it opens `secrets.h` in a second tab)
- **Tools → Board → esp8266 → Generic ESP8266 Module**
- **Tools → Flash Size → 4MB (FS:2MB OTA:~1019KB)**
- **Tools → CPU Frequency → 80 MHz**
- **Tools → Upload Speed → 115200**
- **Tools → Port**, then **Upload**

To watch it boot, move DIP 7 to OFF and open **Tools → Serial Monitor at 9600**.
Not 115200: that UART *is* the Mega link and its baud is fixed by the wiring, so
a monitor at the wrong speed shows framing garbage that reads as a dead board.

### 3 — run

| DIP | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| **Run** | **ON** | **ON** | **ON** | **ON** | OFF | OFF | OFF | OFF |

Set those, then **power-cycle the box**.

## What the LCD should show

| When | Glass |
|---|---|
| After the Mega upload, run DIPs | `SCAN YOUR QR` / `STARTING UP` — Mega 3.0.0 is alive. `CRUSADERS COURTS / SCAN YOUR CODE` means the Mega upload did NOT land (that is the 2.1.0 image) |
| During the bridge upload and monitor | **Nothing new.** DIP 1 and 2 are off, so the Mega is not on the other end of that UART. Watch the monitor, not the glass. |
| Run DIPs restored, box on the WiFi | `SCAN YOUR QR` / `READY` — and the box appears on the admin **Devices** page by itself within one heartbeat, with its court numbers and `mega_version` 3.0.0 against it |
| Run DIPs restored, box **not** on the WiFi | `SCAN YOUR QR` / `NO WIFI` — the two halves are talking and the radio is not. Check the SSID and password in `secrets.h`. `OUT OF SERVICE` means they are not talking: check DIP 1 and 2. |

If nothing ever appears, the two halves are not talking: check DIP 1 and 2.

## What is inside each sketch

| | `court_mega` | `court_bridge` |
|---|---|---|
| PlatformIO environment | `[env:court_mega]` | `[env:court_bridge]` |
| `lib/` modules | {", ".join(f"`{lib}`" for lib in mega["libs"])} | {", ".join(f"`{lib}`" for lib in bridge["libs"])} |
| Build flags in `src/build_config.h` | {len(mega["defines"])} | {len(bridge["defines"])} |

Vendored third-party libraries — copied out of `src/iot/court-box/.pio/libdeps/<env>/`,
which is what PlatformIO resolved from `lib_deps`, so the Library Manager is
never consulted and the two builds cannot get different versions. Each package
is copied whole apart from its `examples/` (the IDE would try to compile them):

| Library | Version | Where | Licence file |
|---|---|---|---|
{vendor_rows(project, mega)}
{vendor_rows(project, bridge)}
{unused_note(results)}

`src/build_config.h` carries every `-D` its PlatformIO environment sets and is
included first in every file of the sketch, because the IDE cannot pass a build
flag and a target guard like `#ifdef TARGET_COURT_MEGA` has to be true in files
the `.ino` never includes.

Two flags are deliberately **not** mirrored: `-Wall -Wextra` (warnings are not
behaviour; `make lint-iot` is the gate) and `-std=gnu++17` (the Arduino AVR core
hard-codes `-std=gnu++11` and a sketch cannot override it, which is why `lib/`
is kept C++11-clean).

## The developer route

`make flash-mega` and `make flash-bridge` do the same two uploads from
PlatformIO, print the DIP positions and wait for the port. They need
`make install-iot` and a filled-in `src/iot/court-box/src/common/secrets.h`. Everything
else about the firmware — the wiring, the DIP block, why the logic lives on the
ESP8266, the rollover rule — is in [`../README.md`](../README.md).
"""


def render_door_gate_readme(project: Project, results: list[dict]) -> str:
    core_id, core_version, core_pin = project.config["cores"][0]
    gate = results[0]

    def define(name: str) -> str:
        for d in gate["defines"]:
            key, _, value = d.partition("=")
            if key == name:
                return value or "1"
        raise SystemExit(f"[env:{gate['env']}] does not define {name}; the README template expects it")

    def version_part(name: str) -> str:
        """A FW_VERSION_* part, which must now be PRESENT.

        It used to be allowed to be absent. `[env:door_gate]` inherited
        `[common]`'s 2.0.0 and unflagged it — and `build_unflags` deletes EVERY
        token that matches, including the environment's own, so
        `-DFW_VERSION_MINOR=0` was added and then removed and the define reached
        the compiler on neither build route. The image reported 1.0.0 only
        because `fwversion/Version.h`'s `#ifndef` fallback is also 0.

        The environment sets all three directly now and inherits `[common]` not
        at all, so a missing one is a real defect — a sketch that would report a
        version the PlatformIO build does not — and this raises rather than
        quietly substituting a zero that happens to be right.
        """
        return define(name)

    return f"""# Flashing a door gate from the Arduino IDE

**This is the deployment route.** Open the sketch, pick the board and the port,
press Upload. No terminal, no `make`, nothing to install from the Library
Manager — every library this firmware needs is vendored inside `src/`.

This folder is **generated**. Edit the PlatformIO sources under
`src/iot/door-gate/` (and the shared libraries in `src/iot/shared/lib/`), then
run `make arduino-export`; `make arduino-check` regenerates and fails if the
committed copy has gone stale. Editing a file in here is a change that the next
export deletes.

## Once per machine

1. Install the **Arduino IDE 2** (2.3 or newer).
2. **Preferences → Additional boards manager URLs**, add:
   `{ESP32_INDEX}`
3. **Boards Manager**, install **esp32** by Espressif Systems **{core_version}**.

That version is what this export is compiled against in CI, and it matches the
platform `src/iot/door-gate/platformio.ini` pins ({core_pin}) — which is what
makes the IDE build and the PlatformIO build the same firmware. Installing a
different major version is not a small difference: 3.x renamed and reorganised
enough of the core that this sketch is not expected to compile against it.

No USB-serial driver is needed on current macOS. Only if **no** port ever
appears: `brew install --cask wch-ch34x-usb-serial-driver`, then replug.

## Once per board

Copy `secrets.h.example` to `secrets.h` — in **this** folder, beside
`door_gate.ino` — and fill in all four values. It is gitignored, and the gate
**refuses to compile without it**.

| Value | What it is |
|---|---|
| `WIFI_SSID` / `WIFI_PASSWORD` | The club WiFi. The board takes a DHCP lease; there is no static-IP option. |
| `API_BASE_URL` | The backend's **LAN IPv4 ADDRESS** and port, `http://` only, no trailing slash — e.g. `http://192.168.1.10:8088`. The sketch `static_assert`s all of that and will not compile otherwise. A **hostname** is an unbounded DNS wait (16 s, then 15 s) that no HTTP timeout covers, so every heartbeat would reset the board; `https://` is accepted by the HTTP client and then sent in **cleartext** to port 443; a trailing slash produces `//api/v1/...` and a 404 that reads at the door as an outage; `0.0.0.0` is the example file's own placeholder and `255.255.255.255` is the broadcast address, and both are refused. Not the public tunnel hostname either: that sends every scan out to Cloudflare and back while somebody stands at the door. |
| `DEVICE_API_KEY` | The tenant's device API key, from the admin Devices page. Goes out as `Authorization: Bearer <key>`. |

**Every value in `secrets.h.example` is a placeholder, and every placeholder is
a compile error.** The file used to ship plausible values — a real-looking SSID
and LAN address — which compile, flash, and produce a board that joins nothing
and posts to a machine that is not the club's. There is one LED on this
hardware, so that board and a board whose server is down look identical from the
bottom of the ladder. If the Upload fails with `static assertion failed: …
placeholder`, that is this guard: fill the value in.

Regenerating the key on the Devices page invalidates the old one
**immediately**, so a regeneration is a reflash of **every** board that carries
it and has to be planned as one.

**The same four values go on every door.** Nothing per-gate is compiled in: a
door is named in the admin console (`gate_key`), the API keys that name to the
board's MAC, and the board never needs to know it — it does not read `gate_key`
and has no field to keep one in. Two doors run byte-identical images and a spare
board is a spare board rather than a board for one particular door.

## Flash

- Open `door_gate/door_gate.ino` (it opens `secrets.h` in a second tab)
- **Tools → Board → esp32 → ESP32 Dev Module**
- Leave every other **Tools** setting at its default. Flash size, partition
  scheme, PSRAM and CPU frequency are all the board's defaults and none of them
  is load-bearing for this firmware.
- **Tools → Port** — the `/dev/cu.usbserial-*` or `/dev/cu.wchusbserial-*`
  (macOS) or `COM*` (Windows) that appears when the board is plugged in
- **Upload**

To watch it boot: **Tools → Serial Monitor at 115200**. On this board UART0 is
the USB console and nothing else — unlike the court bridge, whose UART0 *is* its
link to the Mega. The scanner is on `Serial2`.

## The flags you may change, and what each one is

They are all in `src/build_config.h`, and **the defaults below are the values
measured on the board that is already on the wall** — Carl's wiring, tested.
Changing one here changes it for the IDE build only; the PlatformIO build reads
`src/iot/door-gate/platformio.ini`, and `make arduino-check` will fail until the
two agree again. **If a change is meant to stick, make it in `platformio.ini`
and re-run `make arduino-export`.**

| Flag | Default | What it is |
|---|---|---|
| `GATE_SCANNER_RX_PIN` | {define("GATE_SCANNER_RX_PIN")} | The scanner's TX into the ESP32, on `Serial2`. |
| `GATE_SCANNER_TX_PIN` | {define("GATE_SCANNER_TX_PIN")} | The ESP32's TX to the scanner. Wired and unused — the scanner only talks. |
| `GATE_SCANNER_BAUD` | {define("GATE_SCANNER_BAUD")} | 8N1. |
| `GATE_RELAY_PIN` | {define("GATE_RELAY_PIN")} | Drives the door lock through the relay module. |
| `GATE_RELAY_ACTIVE_HIGH` | {define("GATE_RELAY_ACTIVE_HIGH")} | **The relay MODULE.** 1 if driving its input HIGH energises the coil. Cheap opto-isolated boards are usually active LOW; Carl's is active HIGH. |
| `GATE_UNLOCK_ENERGISES_RELAY` | {define("GATE_UNLOCK_ENERGISES_RELAY")} | **The LOCK's wiring.** 1 if an energised coil *releases* the lock. See the truth table below before touching this one. |
| `GATE_LED_PIN` | {define("GATE_LED_PIN")} | The lamp — the board's entire user interface. |
| `GATE_LED_ACTIVE_HIGH` | {define("GATE_LED_ACTIVE_HIGH")} | 1 if HIGH lights it. |
| `GATE_UNLOCK_DEFAULT_MS` | {define("GATE_UNLOCK_DEFAULT_MS")} | Release time until the first heartbeat tells the board the club's own. |
| `GATE_UNLOCK_HARD_CAP_MS` | {define("GATE_UNLOCK_HARD_CAP_MS")} | A safety bound, not a default: the longest ONE release window may last, whatever the server answers and however often somebody scans. On its own it bounds the WINDOW and not the door — the two dwells below are what make it bound the door. |
| `GATE_RELOCK_DWELL_MS` | {define("GATE_RELOCK_DWELL_MS")} | After a window the hard cap ended, the lock stays locked for at least this long and no grant may energise the relay inside it. Without it the cap closed a window and the very next scan opened a fresh one in the same pass — relay OFF and ON at the same millisecond, so the strike never dropped and the door never relatched. |
| `GATE_MIN_RELOCK_MS` | {define("GATE_MIN_RELOCK_MS")} | The same floor after ANY close, so two back-to-back members are two openings rather than one continuous one. Long enough for a strike to drop or a maglock to re-magnetise; short enough that the second member does not notice it. |
| `GATE_WATCHDOG_SECONDS` | {define("GATE_WATCHDOG_SECONDS")} | Task watchdog period. |
| `HEARTBEAT_INTERVAL_MS` | {define("HEARTBEAT_INTERVAL_MS")} | Starting cadence. The tenant's own is adopted from the first response. |
| `ROSTER_MAX_AGE_MS` | {define("ROSTER_MAX_AGE_MS")} | 6 h. A roster older than this admits **nobody**, however good the match looks. |

Leave alone: `FW_VERSION_*` (the heartbeat reports it, and the sketch `#error`s
unless all three parts are present and are the gate's), `TARGET_DOOR_GATE`,
`GATE_MAX_TOKEN_LEN` (asserted equal to the roster's) and `EVENTQ_SLOTS`.

`GATE_WATCHDOG_SECONDS` is in the table above but is **not** a free choice: the
sketch `static_assert`s that it exceeds one worst-case blocking HTTP call —
connect **plus** response, which a single call can spend both of — with room for
a whole pass on top. Lower it and the build fails, which is the point: a
watchdog no longer than the call it is timing resets the board before the call
can return, every time the API host goes quiet, so the board reset-loops and
admits nobody.

A value outside its range is a **compile error**, not a surprise on a wall. The
sketch asserts that the pins are output-capable (GPIO 34–39 on an ESP32 are
input-only, and a relay on one of them is a lock that never opens), that the
lock does not share a pin with the LED or the scanner, and that the hard cap is
inside the contract's 1–30 s.

## The two polarity flags, and what a dead board does to the door

`GATE_RELAY_ACTIVE_HIGH` is a fact about the **relay module**.
`GATE_UNLOCK_ENERGISES_RELAY` is a fact about **the lock's own wiring** — which
contact of the relay the lock is fed through. They are independent, and only
their composition says anything about the door.

| `ACTIVE_HIGH` | `UNLOCK_ENERGISES` | pin when **locked** | pin when **released** | dead or rebooting board |
|:---:|:---:|:---:|:---:|---|
| 1 | 1 | LOW | HIGH | coil de-energised → **locked** |
| 1 | 0 | HIGH | LOW | coil de-energised → **released** |
| 0 | 1 | HIGH | LOW | coil de-energised → **locked** |
| 0 | 0 | LOW | HIGH | coil de-energised → **released** |

Read the last column as: with no power, or with the board held in reset, the
relay coil is de-energised whatever the pin was doing. What the door then does
is decided by `GATE_UNLOCK_ENERGISES_RELAY` alone — **`0` means a de-energised
coil releases the door.**

**Carl's board is wired `GATE_UNLOCK_ENERGISES_RELAY=1`**: the coil is energised
to release, so a power cut leaves the door **locked**. That is the default
because it is what is on the wall today. Changing it is a lock change and a
rewire, not a flag change — flipping the flag alone, on hardware wired for `1`,
inverts the firmware's whole idea of the door.

> **Fire egress must be mechanical and independent of this board.** A door on an
> escape route has to open from the inside by pushing it — a panic bar, a
> mechanical handle — with no power, no relay and no firmware involved. Nothing
> in this repository is a life-safety device, nothing here is rated or certified
> as one, and no combination of the flags above turns it into one.

## What the LED means

| Pattern | Meaning |
|---|---|
| Solid | the lock is released — push the door |
| 3 fast blinks | refused |
| Slow 1 Hz blink | the radio is not associated; the board is deciding from its roster |
| 2 quick blinks | the board has just booted |

After an Upload with the board on the club WiFi, expect two quick blinks and
then a dark lamp, and the board appears on the admin **Devices** page by itself
within one heartbeat as `Kind=Gate`.

## When something is wrong

| What you see | What it is |
|---|---|
| A slow 1 Hz blink that never stops | The radio never associated. Check `WIFI_SSID` and `WIFI_PASSWORD` in `secrets.h`. The door still opens for a member with a rostered booking until the roster goes stale. |
| A fast 4 Hz blink | The task watchdog refused to arm after three tries. The door is unaffected and still opens; the board is running on the core's 5 s watchdog instead of its own. Report it. |
| **The lamp stays dark and the board never appears on the Devices page** | Nothing is running. In order: is the board powered and is `GATE_LED_PIN` the pin the lamp is actually on? Open **Tools → Serial Monitor at 115200** and press the board's RESET — one line naming the firmware version, the MAC and the API address should appear. **No line at all** means the Upload did not take (wrong **Port**, or a board that needs BOOT held) or the sketch is not running. **A line, but nothing on the Devices page** means the MAC is reaching no server: check the `api=` address on that line against where the backend actually is, and that the board and the backend are on the same LAN. |
| The Upload fails on `static assertion failed` | A value in `secrets.h` is still the example file's placeholder, or `API_BASE_URL` is not `http://` + an IPv4 address. The message names which. |
| The Upload fails with hundreds of `redefinition of …` errors | **iCloud Drive.** A synced folder fabricates numbered duplicates — `Json 2.cpp`, `GateApp 2.h` — and the IDE compiles **every** `.cpp` under `src/` recursively, so each duplicate is a second definition. They are invisible in Finder's default view and are never committed. From the repository root: `make sweep-icloud`. By hand, from this sketch folder: `find . -name '* [0-9].*' -print -delete` and then `find . -name '* [0-9]' -print -delete`. Then Upload again. |

## What is inside this sketch

| | `{gate["sketch"]}` |
|---|---|
| PlatformIO environment | `[env:{gate["env"]}]` |
| Board | `{core_id}` {core_version}, FQBN `{gate["fqbn"]}` |
| `lib/` modules | {", ".join(f"`{lib}`" for lib in gate["libs"])} |
| Build flags in `src/build_config.h` | {len(gate["defines"])} |

| Library | Version | Where | Licence file |
|---|---|---|---|
{vendor_rows(project, gate)}
{unused_note(results)}
`src/build_config.h` carries every `-D` its PlatformIO environment sets — with
`build_unflags` applied by exact token, exactly as PlatformIO applies it. That
is what makes the firmware version in here
**{version_part("FW_VERSION_MAJOR")}.{version_part("FW_VERSION_MINOR")}.{version_part("FW_VERSION_PATCH")}** rather than the 2.0.0 that `[common]` pins for the
court box — this environment does not inherit `[common]` at all and spells its
own version out, which is what stopped `build_unflags` deleting the tokens it
had just been given. `build_config.h` is included first in every file of the sketch,
because the IDE cannot pass a build flag and a target guard like
`#ifdef TARGET_DOOR_GATE` has to be true in files the `.ino` never includes.

> All three of `FW_VERSION_MAJOR`, `FW_VERSION_MINOR` and `FW_VERSION_PATCH`
> are in `build_config.h`, and the sketch `#error`s unless all three are
> defined **and** are the gate's. They used not to be: `[env:door_gate]`
> inherited `[common]`'s 2.0.0 and unflagged it, and `build_unflags` removes
> **every** token that matches — including the environment's own — so
> `-DFW_VERSION_MINOR=0` was added and then deleted, on both build routes, and
> `src/fwversion/Version.h`'s `#ifndef` fallback of 0 supplied the value. The
> image reported 1.0.0 by luck. The environment no longer inherits `[common]`
> at all; it spells out `-std=gnu++17` and sets its own version.

Two flags are deliberately **not** mirrored: `-Wall -Wextra` (warnings are not
behaviour; `make lint-iot` is the gate) and `-std=gnu++17` (the ESP32 core
appends `-std=gnu++11` and a sketch cannot override it).

> **So everything this sketch links must be valid C++11 as well as C++17**, and
> that is not a detail — it is the constraint that decides how several of these
> headers are written. `-std=gnu++11` is hard-coded in the core's `platform.txt`
> and the IDE has no mechanism to override it; `build_unflags` is a PlatformIO
> mechanism the IDE never sees, so the PlatformIO build gets C++17 and this one
> does not. A multi-statement `constexpr` function is green under `pio run` and
> red here — it has happened once already, in `LockDriver.h` — while `inline
> constexpr` *variables* survive as a GCC extension. Only the `arduino-cli
> compile` step in CI catches the difference.

## The developer route

`pio run -d src/iot/door-gate -e door_gate -t upload` does the same upload from
PlatformIO. It needs `make install-iot` and a filled-in
`src/iot/door-gate/src/common/secrets.h`. Everything else about this firmware —
the wiring, how a scan is decided, the offline degraded mode, the rollover rule
— is in [`../README.md`](../README.md).
"""


def write_cli_config(project: Project) -> None:
    cores = project.config["cores"]
    urls = project.config["board_urls"]
    compiles = "".join(
        f"# arduino-cli compile --fqbn {t['fqbn']} \\\n"
        f"#     {os.path.relpath(project.out / t['sketch'], REPO)}\n"
        for t in project.config["targets"]
    )
    (project.out / "arduino-cli.yaml").write_text(
        f"# GENERATED by {TOOL} — do not edit.\n"
        "#\n"
        "# For CI and for anyone reproducing the compile without the IDE. The core\n"
        "# VERSIONS are not expressible here, so they are pinned in the install\n"
        f"# commands and must match these, which are what {project.ini_path} pins:\n"
        + "".join(f"#   arduino-cli core install {n}@{v}   # PlatformIO: {p}\n" for n, v, p in cores)
        + "#\n"
        + compiles
        + "board_manager:\n"
        "  additional_urls:\n"
        + "".join(f"    - {u}\n" for u in urls),
        encoding="utf-8",
    )


# ---------------------------------------------------------------------------


ICLOUD_DUPLICATE_RE = re.compile(r" \d+$")


def strip_icloud_duplicates(project: Project) -> list[Path]:
    """Delete iCloud's fabricated `Name 2.h` / `Name 3.cpp` copies from the export.

    This tree lives on an iCloud Drive path, and iCloud invents numbered
    duplicates of files it has just seen written — the repo has already been
    bitten by them under bin/ and obj/. Here they are worse than noise: they sit
    inside a sketch's src/, so the Arduino IDE COMPILES them, and 27 of them
    were committed once before this swept them (2026-09-05). The export owns
    this directory outright, so removing them is unambiguous.

    The repo-wide equivalent — which does NOT own what it is deleting, and so
    refuses to touch a tracked file — is tools/sweep_icloud_duplicates.py.
    """
    removed = []
    for path in sorted(project.out.rglob("*")):
        if path.is_file() and ICLOUD_DUPLICATE_RE.search(path.stem):
            path.unlink()
            removed.append(path)
    return removed


def export(project: Project) -> None:
    ini = parse_ini(project.root / "platformio.ini")
    roots = lib_roots(project, ini)
    ns_map, where = namespaces(roots)

    common = sorted(p.name for p in (project.root / "src" / "common").iterdir() if p.is_file())
    if common != ["secrets.h", "secrets.h.example"] and common != ["secrets.h.example"]:
        raise SystemExit(
            f"{project.name}: src/common now holds {common}; this exporter only knows how to place "
            "secrets.h next to the .ino — teach it about the new file before shipping it"
        )

    project.out.mkdir(parents=True, exist_ok=True)
    results = [export_target(project, t, ini, ns_map, where) for t in project.config["targets"]]
    (project.out / "README.md").write_text(project.config["readme"](project, results), encoding="utf-8")
    write_cli_config(project)

    for path in strip_icloud_duplicates(project):
        print(f"removed iCloud duplicate: {path.relative_to(project.out)}")

    for r in results:
        print(
            f"{project.name}/{r['sketch']}: {len(r['libs'])} lib modules, {len(r['defines'])} defines, "
            f"{len(r['vendored'])} vendored ({', '.join(n for n, _ in r['vendored']) or 'none'})"
        )
    print(f"wrote {os.path.relpath(project.out, Path.cwd())}")


def main() -> int:
    configs = project_configs()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--project", action="append", choices=sorted(configs), metavar="NAME",
        help="firmware project to export; repeatable. Default: every project with a sketch. "
             f"One of: {', '.join(sorted(configs))}",
    )
    args = parser.parse_args()

    for name in args.project or sorted(configs):
        export(Project(name=name, config=configs[name]))
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Generate the Arduino IDE 2 sketch folders from the PlatformIO project.

WHY THIS EXISTS
---------------
PlatformIO is the tested build and stays the tested build: `make build-iot`,
`make test-iot`, the strict-compile gate and CI all run against `platformio.ini`
and nothing here changes that. But the person who flashes the box is the founder
with a screwdriver, and "open the sketch, pick the board, Upload" is a deployment
route the Arduino IDE gives for free while PlatformIO does not. So this script
renders the same sources into two ready-to-open sketch folders that need nothing
from the Library Manager and no terminal.

Two builds of the same firmware only stay the same firmware if the second one is
DERIVED. Everything this script emits — the sources, the third-party libraries,
and every `-D` the PlatformIO environments set — is read out of the tree at
generation time. `make arduino-check` regenerates and fails on `git diff`, so a
change to `platformio.ini` or to any source that is not mirrored here is a red
build rather than a box running firmware nobody wrote.

WHAT IT DOES NOT MIRROR, AND WHY THAT IS SAFE
---------------------------------------------
  * `-Wall -Wextra` and the strict-compile gate. Warnings are not behaviour, and
    the real gate is `make lint-iot` on the PlatformIO build.
  * `-std=gnu++17`. The Arduino AVR core hard-codes `-std=gnu++11` in its
    `platform.txt` and a sketch cannot override it — which is why `lib/` is kept
    C++11-clean and `platformio.ini` carries `build_unflags = -std=gnu++11` for
    the same reason from the other side. The ESP8266 core is C++17 already.

LAYOUT IT PRODUCES
------------------
    arduino/court_mega/court_mega.ino        <- src/court_mega/main.cpp
    arduino/court_mega/src/build_config.h    <- the -D flags from platformio.ini
    arduino/court_mega/src/<ns>/...          <- one directory per lib/ namespace
    arduino/court_mega/src/<ThirdParty>/...  <- vendored from .pio/libdeps

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
from pathlib import Path

IOT = Path(__file__).resolve().parent.parent
OUT = IOT / "arduino"

# Libraries that must never reach a board. posix_hal is the simulator's host
# HAL; hal_fakes is test infrastructure. Both compile for the host only, and a
# closure that reaches either means an #include went the wrong way.
FORBIDDEN_LIBS = {"posix_hal", "hal_fakes"}

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
    """Every -D the environment sets, in platformio.ini order."""
    key = f"env:{env}"
    if key not in ini:
        raise SystemExit(f"platformio.ini has no [{key}]")
    flags = tokens(expand(ini[key].get("build_flags", ""), ini))
    return [t[2:] for t in flags if t.startswith("-D")]


def lib_deps_for(env: str, ini: dict[str, dict[str, str]]) -> list[str]:
    """The `owner/Name@version` coordinates the environment declares."""
    return tokens(expand(ini[f"env:{env}"].get("lib_deps", ""), ini))


# ---------------------------------------------------------------------------
# lib/ closure
# ---------------------------------------------------------------------------


def namespaces() -> dict[str, str]:
    """include-namespace -> lib directory name, e.g. {"timebase": "timebase"}."""
    out: dict[str, str] = {}
    for lib in sorted((IOT / "lib").iterdir()):
        inc = lib / "include"
        if not inc.is_dir():
            continue
        dirs = [d.name for d in sorted(inc.iterdir()) if d.is_dir()]
        if len(dirs) != 1:
            raise SystemExit(f"lib/{lib.name}/include must hold exactly one namespace dir, found {dirs}")
        out[dirs[0]] = lib.name
    return out


INCLUDE_RE = re.compile(r'^\s*#\s*include\s*(?:"([^"]+)"|<([^>]+)>)')
REWRITE_RE = re.compile(r'^([ \t]*#[ \t]*include[ \t]*)(?:"([^"]+)"|<([^>]+)>)', re.M)


def scan_includes(path: Path) -> list[str]:
    found: list[str] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        m = INCLUDE_RE.match(line)
        if m:
            found.append(m.group(1) or m.group(2))
    return found


def lib_files(lib: str) -> list[Path]:
    root = IOT / "lib" / lib
    files = list((root / "include").rglob("*.h")) if (root / "include").is_dir() else []
    if (root / "src").is_dir():
        files += list((root / "src").rglob("*.cpp")) + list((root / "src").rglob("*.c"))
    return sorted(files)


def closure(seeds: list[Path], ns_map: dict[str, str]) -> list[str]:
    """Every lib/ directory reachable by #include from the target's sources."""
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
            if ns not in ns_map:
                continue
            lib = ns_map[ns]
            if lib in FORBIDDEN_LIBS:
                raise SystemExit(f"{path} reaches lib/{lib}, which must never be compiled for a board")
            if lib not in needed:
                needed.add(lib)
                queue.extend(lib_files(lib))
    return sorted(needed)


# ---------------------------------------------------------------------------
# Rewriting
# ---------------------------------------------------------------------------

GENERATED_BANNER = "// GENERATED by src/iot/tools/arduino_export.py — edit the PlatformIO sources, not this copy.\n"


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


def vendor(dep: str, env: str, sketch_src: Path) -> tuple[str, str]:
    """Copy a lib_deps package out of .pio/libdeps into the sketch.

    Returns (name, version). The package must already be resolved, which is
    what `make build-iot` does — this script never reaches the network.
    """
    name = dep.split("/")[-1].split("@")[0]
    src = IOT / ".pio" / "libdeps" / env / name
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
# Targets
# ---------------------------------------------------------------------------

# The bridge's composition root names secrets.h by its PlatformIO path, which
# does not exist in a sketch folder: there, secrets.h sits next to the .ino.
# Each pair is asserted to apply, so a reworded #error fails the export instead
# of silently shipping an instruction that points at nothing.
BRIDGE_SUBS = [
    ('__has_include("common/secrets.h")', '__has_include("secrets.h")'),
    ('#include "common/secrets.h"', '#include "secrets.h"'),
    (
        '"src/iot/src/common/secrets.h is missing — copy secrets.h.example to secrets.h and fill in',
        '"secrets.h is missing from this sketch folder — copy secrets.h.example to secrets.h and fill in',
    ),
    ("see src/iot/src/common/secrets.h.example", "see secrets.h.example, next to court_bridge.ino"),
    ("compiled in from src/common/secrets.h", "compiled in from secrets.h, next to this sketch"),
    ("them is `make flash-bridge`, which is a two-minute job",
     "them is another Upload from the Arduino IDE, which is a two-minute job"),
]

TARGETS = [
    {"env": "court_mega", "sketch": "court_mega", "secrets": False},
    {"env": "court_bridge", "sketch": "court_bridge", "secrets": True},
]


def build_config(defines: list[str], env: str) -> str:
    lines = [
        "// GENERATED by src/iot/tools/arduino_export.py — do not edit.",
        "//",
        f"// Every -D that `[env:{env}]` in src/iot/platformio.ini sets, in its order.",
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


def export_target(target: dict, ini: dict[str, dict[str, str]], ns_map: dict[str, str]) -> dict:
    env, sketch_name = target["env"], target["sketch"]
    sketch = OUT / sketch_name
    sketch_src = sketch / "src"

    # Wipe src/ and the .ino only. secrets.h is the technician's and is never
    # ours to delete.
    if sketch_src.exists():
        shutil.rmtree(sketch_src)
    sketch_src.mkdir(parents=True)

    main = IOT / "src" / env / "main.cpp"
    if not main.is_file():
        raise SystemExit(f"{main} is missing")

    libs = closure([main], ns_map)
    defines = defines_for(env, ini)
    deps = lib_deps_for(env, ini)

    vendored: list[tuple[str, str]] = []
    vendor_headers: dict[str, str] = {}
    for dep in deps:
        name, version = vendor(dep, env, sketch_src)
        vendored.append((name, version))
        vendor_headers.update(vendor_root_headers(sketch_src, name))

    ns_by_lib = {lib: ns for ns, lib in ns_map.items()}
    for lib in libs:
        ns = ns_by_lib[lib]
        for path in lib_files(lib):
            emit(path, sketch_src / ns / path.name, "../", ns_map, vendor_headers)

    subs = BRIDGE_SUBS if target["secrets"] else None
    emit(main, sketch / f"{sketch_name}.ino", "src/", ns_map, vendor_headers, subs)

    (sketch_src / "build_config.h").write_text(build_config(defines, env), encoding="utf-8")

    # Is each vendored package actually included by anything? A lib_deps entry
    # that nothing includes is dead weight in the sketch folder, and the honest
    # place to say so is the README rather than a comment nobody reads.
    ours = [p for p in sorted(sketch_src.rglob("*")) if p.is_file() and p.suffix in (".h", ".cpp")
            and p.parts[len(sketch_src.parts)] not in {n for n, _ in vendored}]
    ours.append(sketch / f"{sketch_name}.ino")
    used = {name for name in {n for n, _ in vendored}
            for f in ours if f"{name}/" in f.read_text(encoding="utf-8", errors="replace")}
    unused = sorted({n for n, _ in vendored} - used)

    if target["secrets"]:
        example = IOT / "src" / "common" / "secrets.h.example"
        text = example.read_text(encoding="utf-8")
        for old, new in [
            ("// Copy to secrets.h and fill in all four values before flashing. secrets.h is",
             "// Copy to secrets.h — in THIS folder, beside court_bridge.ino — and fill in all\n"
             "// four values before flashing. secrets.h is"),
            ("`make flash-bridge`. See src/iot/README.md's Flashing section.",
             "Upload again from the Arduino IDE. See\n// src/iot/arduino/README.md."),
        ]:
            if old not in text:
                raise SystemExit(f"{example}: expected to rewrite {old!r} and it is not there")
            text = text.replace(old, new)
        (sketch / "secrets.h.example").write_text(text, encoding="utf-8")

    return {"env": env, "sketch": sketch_name, "libs": libs, "defines": defines,
            "vendored": vendored, "unused": unused}


# ---------------------------------------------------------------------------
# README
# ---------------------------------------------------------------------------

# The core versions this export is proven against. arduino:avr and esp8266 are
# what the Boards Manager installs; the PlatformIO packages beside them are the
# ones `platformio.ini` pins, and the pair is what makes "both builds" a claim
# rather than a hope. Bump both halves together or not at all.
CORES = [
    ("arduino:avr", "1.8.6", "atmelavr@5.0.0 / framework-arduino-avr 5.2.0"),
    ("esp8266:esp8266", "3.1.2", "espressif8266@4.2.1 / framework-arduinoespressif8266 3.30102.0"),
]
ESP8266_INDEX = "https://arduino.esp8266.com/stable/package_esp8266com_index.json"


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


def render_readme(results: list[dict]) -> str:
    by_env = {r["env"]: r for r in results}
    mega, bridge = by_env["court_mega"], by_env["court_bridge"]

    def vendor_rows(r: dict) -> str:
        rows = []
        for name, version in r["vendored"]:
            licences = sorted(p.name for p in (OUT / r["sketch"] / "src" / name).glob("LICENSE*"))
            note = ", ".join(f"`{lic}`" for lic in licences) or "none shipped upstream"
            rows.append(f"| `{name}` | {version} | `{r['sketch']}/src/{name}/` | {note} |")
        return "\n".join(rows) or "| _(none)_ | | | |"

    return f"""# Flashing the court box from the Arduino IDE

**This is the deployment route.** Open the sketch, pick the board and the port,
press Upload. No terminal, no `make`, and nothing to install from the Library
Manager — every library either half needs is vendored inside its own `src/`.

These two folders are **generated**. Edit the PlatformIO sources under
`src/iot/`, then run `make arduino-export`; `make arduino-check` regenerates and
fails if the committed copies have gone stale. Editing a file in here is a
change that the next export deletes.

## Once per machine

1. Install the **Arduino IDE 2** (2.3 or newer).
2. **Preferences → Additional boards manager URLs**, add:
   `{ESP8266_INDEX}`
3. **Boards Manager**, install both:
   - **Arduino AVR Boards** {CORES[0][1]} (for the Mega)
   - **esp8266** by ESP8266 Community {CORES[1][1]} (for the bridge)

Those two versions are what this export is compiled against in CI. They match
the platforms `src/iot/platformio.ini` pins ({CORES[0][2]}; {CORES[1][2]}), which
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
| After the Mega upload, run DIPs | `CRUSADERS COURTS / SCAN TO START` — the Mega is alive |
| During the bridge upload and monitor | **Nothing new.** DIP 1 and 2 are off, so the Mega is not on the other end of that UART. Watch the monitor, not the glass. |
| Run DIPs restored, box on the WiFi | `CONNECTED / SCAN TO START` — and the box appears on the admin **Devices** page by itself within one heartbeat, with its court numbers against it |
| Run DIPs restored, box **not** on the WiFi | `CRUSADERS COURTS / SCAN TO START` — the two halves are talking and the radio is not. Check the SSID and password in `secrets.h`. |

If nothing ever appears, the two halves are not talking: check DIP 1 and 2.

## What is inside each sketch

| | `court_mega` | `court_bridge` |
|---|---|---|
| PlatformIO environment | `[env:court_mega]` | `[env:court_bridge]` |
| `lib/` modules | {", ".join(f"`{lib}`" for lib in mega["libs"])} | {", ".join(f"`{lib}`" for lib in bridge["libs"])} |
| Build flags in `src/build_config.h` | {len(mega["defines"])} | {len(bridge["defines"])} |

Vendored third-party libraries — copied out of `src/iot/.pio/libdeps/<env>/`,
which is what PlatformIO resolved from `lib_deps`, so the Library Manager is
never consulted and the two builds cannot get different versions. Each package
is copied whole apart from its `examples/` (the IDE would try to compile them):

| Library | Version | Where | Licence file |
|---|---|---|---|
{vendor_rows(mega)}
{vendor_rows(bridge)}
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
`make install-iot` and a filled-in `src/iot/src/common/secrets.h`. Everything
else about the firmware — the wiring, the DIP block, why the logic lives on the
ESP8266, the rollover rule — is in [`../README.md`](../README.md).
"""


def write_cli_config() -> None:
    (OUT / "arduino-cli.yaml").write_text(
        "# GENERATED by src/iot/tools/arduino_export.py — do not edit.\n"
        "#\n"
        "# For CI and for anyone reproducing the compile without the IDE. The core\n"
        "# VERSIONS are not expressible here, so they are pinned in the install\n"
        "# commands and must match these, which are what src/iot/platformio.ini pins:\n"
        + "".join(f"#   arduino-cli core install {n}@{v}   # PlatformIO: {p}\n" for n, v, p in CORES)
        + "#\n"
        "# arduino-cli compile --fqbn arduino:avr:mega:cpu=atmega2560 src/iot/arduino/court_mega\n"
        "# arduino-cli compile --fqbn esp8266:esp8266:generic:eesz=4M2M,xtal=80,baud=115200 \\\n"
        "#     src/iot/arduino/court_bridge\n"
        "board_manager:\n"
        "  additional_urls:\n"
        f"    - {ESP8266_INDEX}\n",
        encoding="utf-8",
    )


# ---------------------------------------------------------------------------


ICLOUD_DUPLICATE_RE = re.compile(r" \d+$")


def strip_icloud_duplicates() -> list[Path]:
    """Delete iCloud's fabricated `Name 2.h` / `Name 3.cpp` copies from the export.

    This tree lives on an iCloud Drive path, and iCloud invents numbered
    duplicates of files it has just seen written — the repo has already been
    bitten by them under bin/ and obj/. Here they are worse than noise: they sit
    inside a sketch's src/, so the Arduino IDE COMPILES them, and 27 of them
    were committed once before this swept them (2026-09-05). The export owns
    this directory outright, so removing them is unambiguous.
    """
    removed = []
    for path in sorted(OUT.rglob("*")):
        if path.is_file() and ICLOUD_DUPLICATE_RE.search(path.stem):
            path.unlink()
            removed.append(path)
    return removed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()

    ini = parse_ini(IOT / "platformio.ini")
    ns_map = namespaces()

    common = sorted(p.name for p in (IOT / "src" / "common").iterdir() if p.is_file())
    if common != ["secrets.h", "secrets.h.example"] and common != ["secrets.h.example"]:
        raise SystemExit(
            f"src/common now holds {common}; this exporter only knows how to place secrets.h "
            "next to the .ino — teach it about the new file before shipping it"
        )

    OUT.mkdir(parents=True, exist_ok=True)
    results = [export_target(t, ini, ns_map) for t in TARGETS]
    (OUT / "README.md").write_text(render_readme(results), encoding="utf-8")
    write_cli_config()

    for path in strip_icloud_duplicates():
        print(f"removed iCloud duplicate: {path.relative_to(OUT)}")

    for r in results:
        print(
            f"{r['sketch']}: {len(r['libs'])} lib modules, {len(r['defines'])} defines, "
            f"{len(r['vendored'])} vendored ({', '.join(n for n, _ in r['vendored']) or 'none'})"
        )
    print(f"wrote {os.path.relpath(OUT, Path.cwd())}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

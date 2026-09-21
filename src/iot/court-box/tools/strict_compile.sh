#!/usr/bin/env bash
# Strict compile gate for EVERY firmware project under src/iot.
#
# PlatformIO applies build_flags to every translation unit it compiles, including
# vendored dependencies like the Unity test framework. Those do not survive
# -Wconversion -Werror, and globally suppressing the warnings they trip would
# defeat the gate for our own code as well.
#
# So strictness lives here instead: a syntax-only compile of OUR sources with the
# full pedantic set as errors. Nothing third-party is in scope, so nothing
# third-party can dilute it.
#
# SCOPE — why this one script covers several projects
# ---------------------------------------------------
# `src/iot` holds one directory per firmware project plus `shared/`, and every
# one of them has a `lib/` under the same purity rule. A gate that covered only
# the project it happens to live in would leave the shared libraries — the ones
# compiled into ALL of them, where a defect is widest — checked by nothing.
#
# Project directories are discovered, not listed: any sibling of this project
# that holds a `platformio.ini` and a `lib/` is in scope, so a firmware added
# tomorrow is covered the day it appears rather than the day somebody remembers
# this file. Pass explicit project directories (relative to src/iot) to narrow
# it; the Makefile does that from its own IOT_PROJECTS list.
#
#     tools/strict_compile.sh                 every project under src/iot
#     tools/strict_compile.sh shared court-box    just these two
set -euo pipefail

# src/iot — the parent of every firmware project, not this project's own root.
cd "$(dirname "$0")/../.."

# `mapfile` is NOT used anywhere in this file, deliberately. macOS ships bash
# 3.2 and has since 2007 — `mapfile` arrived in bash 4 — so a `mapfile` here is a
# gate that cannot run on the machine this firmware is developed on, which is
# how `make lint-iot` was red locally and green in CI at the same time. Plain
# `while read` loops work on both.
PROJECTS=()
if [ "$#" -gt 0 ]; then
  for p in "$@"; do PROJECTS+=("$p"); done
else
  while IFS= read -r d; do
    PROJECTS+=("$d")
  done < <(
    for d in */; do
      d="${d%/}"
      if [ -f "$d/platformio.ini" ] && [ -d "$d/lib" ]; then echo "$d"; fi
    done | sort
  )
fi

if [ ${#PROJECTS[@]} -eq 0 ]; then
  # Same rule as the empty-SOURCES check below: a gate that found nothing to
  # check has not passed, it has stopped being a gate.
  echo "strict_compile: FAILED — no project with a platformio.ini and a lib/ under src/iot." >&2
  exit 1
fi

LIB_ROOTS=()
for p in "${PROJECTS[@]}"; do
  if [ ! -d "$p/lib" ]; then
    echo "strict_compile: FAILED — $p has no lib/ directory." >&2
    exit 1
  fi
  LIB_ROOTS+=("$p/lib")
done
echo "strict_compile: projects: ${PROJECTS[*]}"

CXX="${CXX:-g++}"
STD="-std=gnu++17"
STRICT=(
  -fsyntax-only
  -Wall -Wextra -Werror
  -Wshadow -Wconversion -Wsign-conversion -Wdouble-promotion
  -Wcast-align -Wcast-qual -Wnon-virtual-dtor -Woverloaded-virtual
  -Wold-style-cast -Wswitch-enum -Wundef -Wpointer-arith
  -Wnull-dereference -Wformat=2
)

# Pure modules only. The HAL-IMPLEMENTATION directories need platform headers
# and are covered by `pio run` for their real targets instead. They are excluded
# BY NAME, one per board family plus one per SIMULATOR — arduino_hal (Mega +
# ESP8266), posix_hal (both simulators' shared host drivers), esp32_hal (the
# door gate's real drivers), posix_gate_hal (the door gate's simulator) — and a
# new firmware's HAL has to be added here, in the Makefile's purity grep and in
# ci.yml's. That three-place duplication is deliberate: each of the three runs
# in a context the others do not, and a shared list would have to live somewhere
# all three can read, which is a Makefile variable a shell script and a YAML
# file cannot see.
#
# The exclusion does two things here, not one: it keeps the HAL out of SOURCES
# and it keeps its `include` root off the include path. Both halves matter —
# a HAL left in SOURCES but off the path fails to find its own headers.
#
# The include roots are the UNION across every project in scope, because a
# court-box library includes a shared one by the same `<ns>/X.h` path
# PlatformIO's LDF gives it.
HAL_EXCLUDES=(-not -path '*/arduino_hal/*' -not -path '*/posix_hal/*' -not -path '*/esp32_hal/*'
              -not -path '*/posix_gate_hal/*')

INCLUDES=()
while IFS= read -r d; do
  INCLUDES+=("-I$d")
done < <(find "${LIB_ROOTS[@]}" -mindepth 2 -maxdepth 2 -type d -name include \
         "${HAL_EXCLUDES[@]}" | sort)

# hal_fakes/ IS in scope. It was excluded when this gate was written and should not
# have been: the fakes are pure host-compilable headers, and they are test
# infrastructure — a bug in a fake is silent and poisons every test that trusts it.
# The one place strictness matters most is the code nothing else checks.
SOURCES=()
while IFS= read -r f; do
  SOURCES+=("$f")
done < <(find "${LIB_ROOTS[@]}" -type f \( -name '*.cpp' -o -name '*.h' \) \
  "${HAL_EXCLUDES[@]}" | sort)

if [ ${#SOURCES[@]} -eq 0 ]; then
  # Not a pass. A gate that reports success when it found nothing to check is the
  # third silent-pass escape hatch this repo would have had, and the other two had
  # both rotted into gates that could not fail.
  echo "strict_compile: FAILED — no sources found under ${LIB_ROOTS[*]}." >&2
  echo "  Either the tree moved or the find filters are wrong. Either way this gate" >&2
  echo "  checked nothing, and reporting that as success is how it stops being a gate." >&2
  exit 1
fi

# A header compiled STANDALONE is the main file, and clang — which is what `g++` is on a
# Mac — then reports every namespace-scope constant in it as unused, because nothing in
# that one translation unit reads it. GCC does not, so CI was green and every Mac was red
# on the same four hal headers, which is how a local gate stops being run. Only that one
# diagnostic, only for headers, only under clang; a .cpp keeps it everywhere.
HEADER_ONLY=()
if "$CXX" --version 2>/dev/null | grep -qi clang; then
  HEADER_ONLY=(-Wno-unused-const-variable)
fi

echo "strict_compile: ${#SOURCES[@]} file(s), ${#INCLUDES[@]} include dir(s)"
fail=0
for f in "${SOURCES[@]}"; do
  extra=()
  case "$f" in *.h) extra=("${HEADER_ONLY[@]+"${HEADER_ONLY[@]}"}") ;; esac
  if ! "$CXX" "$STD" "${STRICT[@]}" "${extra[@]+"${extra[@]}"}" "${INCLUDES[@]}" -x c++ "$f" 2>&1; then
    echo "  FAIL $f"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "strict_compile: FAILED"
  exit 1
fi
echo "strict_compile: all clean"

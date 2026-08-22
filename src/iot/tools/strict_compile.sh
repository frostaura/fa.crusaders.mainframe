#!/usr/bin/env bash
# Strict compile gate for src/iot.
#
# PlatformIO applies build_flags to every translation unit it compiles, including
# vendored dependencies like the Unity test framework. Those do not survive
# -Wconversion -Werror, and globally suppressing the warnings they trip would
# defeat the gate for our own code as well.
#
# So strictness lives here instead: a syntax-only compile of OUR sources with the
# full pedantic set as errors. Nothing third-party is in scope, so nothing
# third-party can dilute it.
set -euo pipefail

cd "$(dirname "$0")/.."

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

# Pure modules only. arduino_hal/ and posix_hal/ need platform headers and are
# covered by `pio run` for their real targets instead.
INCLUDES=()
while IFS= read -r d; do
  INCLUDES+=("-I$d")
done < <(find lib -mindepth 2 -maxdepth 2 -type d -name include \
         -not -path 'lib/arduino_hal/*' -not -path 'lib/posix_hal/*' | sort)

# hal_fakes/ IS in scope. It was excluded when this gate was written and should not
# have been: the fakes are pure host-compilable headers, and they are test
# infrastructure — a bug in a fake is silent and poisons every test that trusts it.
# The one place strictness matters most is the code nothing else checks.
mapfile -t SOURCES < <(find lib -type f \( -name '*.cpp' -o -name '*.h' \) \
  -not -path 'lib/arduino_hal/*' \
  -not -path 'lib/posix_hal/*' | sort)

if [ ${#SOURCES[@]} -eq 0 ]; then
  # Not a pass. A gate that reports success when it found nothing to check is the
  # third silent-pass escape hatch this repo would have had, and the other two had
  # both rotted into gates that could not fail.
  echo "strict_compile: FAILED — no sources found under lib/." >&2
  echo "  Either the tree moved or the find filters are wrong. Either way this gate" >&2
  echo "  checked nothing, and reporting that as success is how it stops being a gate." >&2
  exit 1
fi

echo "strict_compile: ${#SOURCES[@]} file(s), ${#INCLUDES[@]} include dir(s)"
fail=0
for f in "${SOURCES[@]}"; do
  if ! "$CXX" "$STD" "${STRICT[@]}" "${INCLUDES[@]}" -x c++ "$f" 2>&1; then
    echo "  FAIL $f"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "strict_compile: FAILED"
  exit 1
fi
echo "strict_compile: all clean"

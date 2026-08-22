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

mapfile -t SOURCES < <(find lib -type f \( -name '*.cpp' -o -name '*.h' \) \
  -not -path 'lib/arduino_hal/*' \
  -not -path 'lib/posix_hal/*' \
  -not -path 'lib/hal_fakes/*' | sort)

if [ ${#SOURCES[@]} -eq 0 ]; then
  echo "strict_compile: no pure sources found under lib/ — nothing to check"
  exit 0
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

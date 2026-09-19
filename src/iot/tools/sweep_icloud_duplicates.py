#!/usr/bin/env python3
"""Delete iCloud's fabricated `Name 2.h` / `program 3` copies from under src/iot.

WHY THIS EXISTS
---------------
This checkout lives on an iCloud Drive path, and iCloud fabricates numbered
duplicates of files it has just seen written. Under `bin/` and `obj/` they are
gitignored noise. Under `src/iot` they are not noise at all:

  * inside a `.pio/build/<env>` directory they are extra object files and extra
    static libraries, and the linker links them — 564 of them accumulated once
    and every native suite failed to link on `duplicate symbol
    _unityOutputFlush`, which reads as a broken test harness rather than as a
    filesystem artefact;
  * inside a generated `arduino/` sketch they are extra `.cpp` files, and the
    Arduino IDE compiles a sketch's `src/` recursively, so a stale duplicate is
    a second definition of something. 27 of them were committed once.

The exporter already sweeps its own output, which it owns outright. This sweeps
the rest, which it does not own — so it is built to fail closed.

WHY IT CANNOT DELETE A TRACKED FILE
-----------------------------------
It asks git for the tracked set ONCE, up front, and deletes nothing that is in
it. If `git ls-files` cannot answer — not a repository, git missing, a non-zero
exit — it deletes NOTHING and says so, because a sweep that cannot tell tracked
from untracked has no business removing files. A candidate that IS tracked is
reported and the run fails: a committed `Foo 2.cpp` is a real problem for a
person to look at, not something to quietly delete.

That is the whole safety argument, and it is one `if`: the tracked set is
consulted for every single deletion, and the set is built from git rather than
from a pattern.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

# src/iot — the parent of every firmware project.
IOT = Path(__file__).resolve().parent.parent
REPO = IOT.parent.parent

# What iCloud makes: `program 3`, `Json 2.cpp`, `.sconsign312 3.dblite`. The
# number is always separated by one space and always comes last in the stem.
DUPLICATE_RE = re.compile(r" \d+$")

# Never walked. The venv holds a whole Python distribution and nothing in it is
# ours; walking it costs seconds and can only produce false positives.
SKIP_DIRS = {".venv", ".git"}


def tracked_paths() -> set[str]:
    """Every path git tracks under src/iot, repo-relative.

    Raises rather than returning an empty set: an empty set would make every
    candidate look untracked, which is exactly the failure this must not have.
    """
    result = subprocess.run(
        ["git", "ls-files", "-z", "--", "src/iot"],
        cwd=REPO, capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise SystemExit(
            "sweep: `git ls-files` failed, so tracked files cannot be told from untracked.\n"
            "Nothing was deleted.\n" + result.stderr.strip()
        )
    paths = {p for p in result.stdout.split("\0") if p}
    if not paths:
        raise SystemExit(
            "sweep: git reports NO tracked files under src/iot. That is either the wrong\n"
            "directory or a broken checkout; either way this cannot prove a file is safe to\n"
            "delete. Nothing was deleted."
        )
    return paths


def candidates() -> list[Path]:
    found: list[Path] = []
    for path in IOT.rglob("*"):
        if any(part in SKIP_DIRS for part in path.relative_to(IOT).parts):
            continue
        if path.is_file() and DUPLICATE_RE.search(path.stem):
            found.append(path)
    return sorted(found)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="list what would be deleted and delete nothing")
    args = parser.parse_args()

    tracked = tracked_paths()
    found = candidates()
    if not found:
        return 0

    doomed: list[Path] = []
    protected: list[Path] = []
    for path in found:
        rel = str(path.relative_to(REPO))
        (protected if rel in tracked else doomed).append(path)

    if protected:
        print("sweep: REFUSING — these match iCloud's duplicate pattern and are TRACKED:",
              file=sys.stderr)
        for path in protected:
            print(f"  {path.relative_to(REPO)}", file=sys.stderr)
        print("Nothing was deleted. A committed duplicate is a real problem: look at it,\n"
              "then `git rm` it deliberately.", file=sys.stderr)
        return 1

    for path in doomed:
        if not args.dry_run:
            path.unlink()
    verb = "would delete" if args.dry_run else "deleted"
    print(f"sweep: {verb} {len(doomed)} iCloud duplicate(s) under src/iot")
    if args.dry_run:
        for path in doomed:
            print(f"  {path.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

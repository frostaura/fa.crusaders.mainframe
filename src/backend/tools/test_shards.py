#!/usr/bin/env python3
"""Split the backend test assembly into balanced shards BY CLASS, and prove the shards cover it.

Why by class: xUnit runs the tests inside one class one after another (each Postgres-backed class
is its own collection with its own cloned database), so a class is the unit that can move between
processes without changing what any test sees. Shards are balanced by MEASURED class durations
(`test-timings.json`, regenerated from any full run's trx with `timings`).

A class missing from the timing file is never dropped: it goes to whichever shard is lightest
once the timed classes are placed. `verify` then proves, from the trx files the shards wrote,
that every class the assembly lists ran in exactly one shard — so a new class cannot be skipped
silently, and a filter that matched nothing cannot pass as green.

  test_shards.py list   --dll PATH                      > classes.txt   (every test class)
  test_shards.py plan   --classes classes.txt --shards N [--timings F] [--format filter|names|table] [--index I]
  test_shards.py verify --classes classes.txt --shards N [--timings F] TRX...
  test_shards.py timings TRX... > test-timings.json

Stdlib only; runs on the CI runner's python3 and on this Mac's.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict

TRX_NS = "{http://microsoft.com/schemas/VisualStudio/TeamTest/2010}"
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TIMINGS = os.path.join(HERE, "test-timings.json")


def class_of(test_name: str) -> str:
    """`Ns.Class.Method(args)` -> `Ns.Class`. Arguments may contain dots; a method name may not."""
    return test_name.split("(", 1)[0].rsplit(".", 1)[0]


def list_classes(dll: str) -> list[str]:
    env = dict(os.environ, MSBuildEnableWorkloadResolver="false")
    out = subprocess.run(["dotnet", "test", dll, "--list-tests"], capture_output=True, text=True, env=env, check=True).stdout
    names = [line.strip() for line in out.splitlines() if line.startswith("    ")]
    if not names:
        sys.exit(f"no tests listed from {dll}:\n{out}")
    return sorted({class_of(n) for n in names})


def read_classes(path: str) -> list[str]:
    with open(path, encoding="utf-8") as f:
        classes = sorted({line.strip() for line in f if line.strip()})
    if not classes:
        sys.exit(f"{path} lists no classes")
    return classes


def read_timings(path: str) -> dict[str, float]:
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return {k: float(v) for k, v in json.load(f)["classes"].items()}


def plan(classes: list[str], shards: int, timings: dict[str, float]) -> list[list[str]]:
    """Longest-processing-time-first over the timed classes, then every untimed class onto the
    lightest shard. Deterministic: ties break on name, so every shard job computes the same plan."""
    if shards < 1:
        sys.exit("--shards must be at least 1")
    load = [0.0] * shards
    buckets: list[list[str]] = [[] for _ in range(shards)]
    timed = sorted((c for c in classes if c in timings), key=lambda c: (-timings[c], c))
    for c in timed:
        i = min(range(shards), key=lambda k: (load[k], k))
        buckets[i].append(c)
        load[i] += timings[c]
    for c in sorted(c for c in classes if c not in timings):
        i = min(range(shards), key=lambda k: (load[k], k))
        buckets[i].append(c)
        # An untimed class costs roughly the median timed class, so several new classes spread
        # out rather than all landing on the same shard.
        load[i] += median(timings.values()) if timings else 1.0
    return [sorted(b) for b in buckets]


def median(values) -> float:
    v = sorted(values)
    return v[len(v) // 2] if v else 1.0


def as_filter(classes: list[str]) -> str:
    # The trailing dot keeps `Foo` from also matching `FooBar` (FullyQualifiedName is
    # `Ns.Class.Method`, and `~` is "contains").
    return "|".join(f"FullyQualifiedName~{c}." for c in classes)


def trx_classes(paths: list[str]) -> dict[str, dict[str, int]]:
    """class -> {trx path: number of results} across the given trx files."""
    seen: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for p in paths:
        root = ET.parse(p).getroot()
        ids = {ut.get("id"): ut.find(f"{TRX_NS}TestMethod").get("className") for ut in root.iter(f"{TRX_NS}UnitTest")}
        for r in root.iter(f"{TRX_NS}UnitTestResult"):
            seen[ids[r.get("testId")]][p] += 1
    return seen


def cmd_plan(a) -> None:
    buckets = plan(read_classes(a.classes), a.shards, read_timings(a.timings))
    timings = read_timings(a.timings)
    if a.format == "table":
        for i, b in enumerate(buckets):
            est = sum(timings.get(c, 0.0) for c in b)
            untimed = [c for c in b if c not in timings]
            print(f"shard {i + 1}/{a.shards}: {len(b)} classes, ~{est:.0f}s measured"
                  + (f", untimed: {', '.join(untimed)}" if untimed else ""))
        return
    chosen = buckets[a.index - 1]
    print(as_filter(chosen) if a.format == "filter" else "\n".join(chosen))


def cmd_verify(a) -> None:
    classes = read_classes(a.classes)
    buckets = plan(classes, a.shards, read_timings(a.timings))
    seen = trx_classes(a.trx)
    problems = []
    for c in classes:
        files = seen.get(c, {})
        if not files:
            problems.append(f"NOT RUN in any shard: {c}")
        elif len(files) > 1:
            problems.append(f"RAN IN {len(files)} shards: {c} ({', '.join(sorted(files))})")
    for c in sorted(set(seen) - set(classes)):
        problems.append(f"ran but is not in the class list: {c}")
    planned = sum(len(b) for b in buckets)
    if planned != len(classes) or len({c for b in buckets for c in b}) != len(classes):
        problems.append(f"the plan places {planned} classes for {len(classes)} listed")
    total = sum(n for files in seen.values() for n in files.values())
    if problems:
        print("\n".join(problems))
        sys.exit(f"shard coverage check FAILED: {len(problems)} problem(s)")
    print(f"shard coverage OK: {len(classes)} classes, {total} test results, each class in exactly one of {len(a.trx)} trx files")


def cmd_timings(a) -> None:
    per_class: dict[str, float] = defaultdict(float)
    for p in a.trx:
        root = ET.parse(p).getroot()
        ids = {ut.get("id"): ut.find(f"{TRX_NS}TestMethod").get("className") for ut in root.iter(f"{TRX_NS}UnitTest")}
        for r in root.iter(f"{TRX_NS}UnitTestResult"):
            h, m, s = r.get("duration", "0:0:0").split(":")
            per_class[ids[r.get("testId")]] += int(h) * 3600 + int(m) * 60 + float(s)
    json.dump({
        "_comment": "Summed per-class test durations in seconds from a full backend run; regenerate with "
                    "`python3 src/backend/tools/test_shards.py timings <trx>...`. Only the RATIOS matter: a class "
                    "missing here still runs, on the lightest shard.",
        "classes": {k: round(v, 1) for k, v in sorted(per_class.items())},
    }, sys.stdout, indent=1)
    print()


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("list"); s.add_argument("--dll", required=True)
    s = sub.add_parser("plan")
    s.add_argument("--classes", required=True); s.add_argument("--shards", type=int, required=True)
    s.add_argument("--index", type=int, default=1); s.add_argument("--timings", default=DEFAULT_TIMINGS)
    s.add_argument("--format", choices=["filter", "names", "table"], default="filter")
    s = sub.add_parser("verify")
    s.add_argument("--classes", required=True); s.add_argument("--shards", type=int, required=True)
    s.add_argument("--timings", default=DEFAULT_TIMINGS); s.add_argument("trx", nargs="+")
    s = sub.add_parser("timings"); s.add_argument("trx", nargs="+")
    a = p.parse_args()
    if a.cmd == "list":
        print("\n".join(list_classes(a.dll)))
    elif a.cmd == "plan":
        if not 1 <= a.index <= a.shards:
            sys.exit(f"--index must be 1..{a.shards}")
        cmd_plan(a)
    elif a.cmd == "verify":
        cmd_verify(a)
    else:
        cmd_timings(a)


if __name__ == "__main__":
    main()

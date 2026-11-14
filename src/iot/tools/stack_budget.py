#!/usr/bin/env python3
"""Stack budget gate for the ESP images: fail the build when a stack frame or the deepest call
path out of loop() grows past its recorded budget (ESPR-4).

The ESP8266 bridge runs loop() on a 4 KB `cont` stack, and the 2026-11-13 binary analysis put its
worst static path at 3,776-3,968 B before an interrupt adds at least 256 B more on the same stack.
Nothing in CI looked at stack use, so one more 320-byte local inlined into loop() -- exactly what
layout and landing work tends to produce -- would close that margin with nothing to flag it before
a box is flashed. This reads what GCC itself reports and compares it with
src/iot/tools/stack_budget.json:

* `-fstack-usage` writes a `.su` per translation unit: every function's frame and whether it is
  static, dynamic or bounded. Checked: the frame of `loop`, the largest frame of OUR code (not the
  core's or the SDK's), and that none of our frames is dynamic (a VLA or alloca has no bound).
* `-fcallgraph-info=su` (GCC 10+, so the ESP8266 toolchain; the ESP32's GCC 8 lacks it) writes a
  `.ci` call graph. Checked: the deepest path from `loop`, summing frames along it, through our
  code and every framework source compiled in the same build. Calls into precompiled SDK archives
  and through function pointers are not in that graph; those are counted and printed, and the
  budget carries the margin for them -- this is a ratchet against growth, not a proof of safety.

    pio run -d src/iot/court-box -e court_bridge   # with PLATFORMIO_BUILD_FLAGS set to the flags above
    python3 src/iot/tools/stack_budget.py --build src/iot/court-box/.pio/build/court_bridge --target court_bridge

Exit 0 within budget, 1 over budget (each excess named), 2 usage error or nothing to read.
A budget is lowered when the code shrinks and raised only deliberately, in the same commit as the
code that needs it, with the reason in that commit.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

BUDGETS = Path(__file__).with_name("stack_budget.json")
SU_LINE = re.compile(r"^(?P<where>.+):(?P<line>\d+):(?P<col>\d+):(?P<name>.+)\t(?P<bytes>\d+)\t(?P<kind>[a-z,]+)$")
CI_NODE = re.compile(r'^node: \{ title: "(?P<title>[^"]+)" label: "(?P<label>[^"]*)"')
CI_EDGE = re.compile(r'^edge: \{ sourcename: "(?P<src>[^"]+)" targetname: "(?P<dst>[^"]+)"')
CI_BYTES = re.compile(r"\\n(?P<bytes>\d+) bytes \((?P<kind>[a-z,]+)\)")
CI_WHERE = re.compile(r"\\n(?P<where>[^\\]+):\d+:\d+")
INDIRECT = "__indirect_call"


def our_libraries(build: Path) -> set[str]:
    """The library names that are ours: the project's lib/ and the shared lib/ it reaches.

    Decided by where the .su file sits in the build tree, never by the path GCC wrote into it:
    the ESP32's GCC 8 writes bare basenames (`main.cpp`, `WiFi.cpp`), so the core's main.cpp and
    ours are indistinguishable by that field. `.pio/build/<env>/src/` is the project's own source,
    `.pio/build/<env>/lib<hash>/<name>/` a library by its directory name.
    """
    project = build.resolve().parents[2]  # <project>/.pio/build/<env>
    names = set()
    for root in (project / "lib", project.parent / "shared" / "lib"):
        if root.is_dir():
            names |= {d.name for d in root.iterdir() if d.is_dir()}
    return names


def su_is_ours(su: Path, build: Path, libraries: set[str]) -> bool:
    parts = su.relative_to(build).parts
    if parts[0] == "src":
        return True
    return len(parts) > 2 and parts[0].startswith("lib") and parts[1] in libraries


def is_loop(name: str) -> bool:
    return name in ("loop", "void loop()")


@dataclass
class Frame:
    name: str
    where: str
    bytes: int
    kind: str
    ours: bool = False


@dataclass
class Graph:
    frames: dict[str, Frame] = field(default_factory=dict)
    calls: dict[str, set[str]] = field(default_factory=dict)


def read_su(build: Path) -> list[Frame]:
    libraries = our_libraries(build)
    frames = []
    for su in sorted(build.rglob("*.su")):
        ours = su_is_ours(su, build, libraries)
        for line in su.read_text(errors="replace").splitlines():
            match = SU_LINE.match(line)
            if match:
                frames.append(Frame(match["name"], match["where"], int(match["bytes"]), match["kind"], ours))
    return frames


def read_ci(build: Path) -> Graph:
    graph = Graph()
    for ci in sorted(build.rglob("*.ci")):
        for line in ci.read_text(errors="replace").splitlines():
            node = CI_NODE.match(line)
            if node:
                size = CI_BYTES.search(node["label"])
                if size:  # a definition; a bare reference to another unit carries no size
                    where = CI_WHERE.search(node["label"])
                    graph.frames[node["title"]] = Frame(node["title"], where["where"] if where else "",
                                                        int(size["bytes"]), size["kind"])
                continue
            edge = CI_EDGE.match(line)
            if edge:
                graph.calls.setdefault(edge["src"], set()).add(edge["dst"])
    return graph


def _resolve(graph: Graph, title: str) -> str | None:
    """A call names its target as the caller's unit saw it: `file:sym` for a local, `sym` otherwise."""
    if title in graph.frames:
        return title
    return None


def deepest_path(graph: Graph, entry: str) -> tuple[int, list[str], set[str], int]:
    """(bytes, path, callees with no frame in the graph, indirect call sites) from `entry`."""
    root = _resolve(graph, entry)
    if root is None:
        raise LookupError(f"{entry} is not defined in any .ci file of this build")
    unknown: set[str] = set()
    indirect = 0
    best: dict[str, tuple[int, list[str]]] = {}
    on_stack: set[str] = set()

    def walk(title: str) -> tuple[int, list[str]]:
        nonlocal indirect
        if title in best:
            return best[title]
        if title in on_stack:
            raise RecursionError(f"recursion through {title}: a cycle has no static stack bound")
        on_stack.add(title)
        deepest, path = 0, []
        for callee in sorted(graph.calls.get(title, ())):
            if callee == INDIRECT:
                indirect += 1
                continue
            target = _resolve(graph, callee)
            if target is None:
                unknown.add(callee)
                continue
            depth, below = walk(target)
            if depth > deepest:
                deepest, path = depth, below
        on_stack.discard(title)
        best[title] = (graph.frames[title].bytes + deepest, [title, *path])
        return best[title]

    total, path = walk(root)
    return total, path, unknown, indirect


def check(build: Path, budget: dict, out=sys.stdout) -> int:
    frames = read_su(build)
    if not frames:
        print(f"stack_budget: no .su files under {build} - was it built with -fstack-usage?", file=sys.stderr)
        return 2
    over = []

    loops = [f for f in frames if is_loop(f.name) and f.ours]
    if len(loops) != 1:
        print(f"stack_budget: expected one loop() of ours, found {len(loops)}", file=sys.stderr)
        return 2
    loop = loops[0]
    print(f"loop() frame: {loop.bytes} B (budget {budget['loop_frame']})", file=out)
    if loop.bytes > budget["loop_frame"]:
        over.append(f"loop() frame {loop.bytes} B > {budget['loop_frame']} B")

    ours = sorted((f for f in frames if f.ours), key=lambda f: -f.bytes)
    biggest = ours[0]
    print(f"largest frame of ours: {biggest.bytes} B, {biggest.name} ({biggest.where}) (budget {budget['max_frame']})", file=out)
    for frame in ours:
        if frame.bytes > budget["max_frame"]:
            over.append(f"{frame.name} ({frame.where}) frame {frame.bytes} B > {budget['max_frame']} B")
    for frame in ours:
        if frame.kind.startswith("dynamic") and frame.kind != "dynamic,bounded":
            over.append(f"{frame.name} ({frame.where}) has an unbounded dynamic frame")

    if "worst_path" in budget:
        graph = read_ci(build)
        if not graph.frames:
            print(f"stack_budget: the budget names worst_path but there are no .ci files under {build} "
                  "- build with -fcallgraph-info=su", file=sys.stderr)
            return 2
        total, path, unknown, indirect = deepest_path(graph, budget.get("entry", "loop"))
        print(f"deepest path from loop(): {total} B (budget {budget['worst_path']}; "
              f"{indirect} indirect call sites and {len(unknown)} precompiled callees not counted)", file=out)
        for title in path:
            frame = graph.frames[title]
            print(f"  {frame.bytes:5d}  {title}", file=out)
        if total > budget["worst_path"]:
            over.append(f"deepest path from loop() {total} B > {budget['worst_path']} B")

    for line in over:
        print(f"OVER BUDGET: {line}", file=out)
    return 1 if over else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--build", required=True, help="a PlatformIO build directory (.pio/build/<env>)")
    parser.add_argument("--target", required=True, help="the budget's key in stack_budget.json")
    parser.add_argument("--budgets", default=str(BUDGETS), help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    budgets = json.loads(Path(args.budgets).read_text())
    if args.target not in budgets["targets"]:
        print(f"stack_budget: no budget for {args.target}", file=sys.stderr)
        return 2
    build = Path(args.build)
    if not build.is_dir():
        print(f"stack_budget: {build} is not a directory", file=sys.stderr)
        return 2
    try:
        return check(build, budgets["targets"][args.target])
    except (LookupError, RecursionError) as error:
        print(f"stack_budget: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())

"""src/iot/tools/stack_budget.py — ESPR-4, the stack budget gate for the ESP images.

Synthetic PlatformIO build trees in GCC's own .su / .ci formats, varied one field at a time. The
real bridge and gate builds are gated in CI's iot-build job.
"""

from __future__ import annotations

import importlib.util
import io
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from infra_support import REPO

TOOL = REPO / "src" / "iot" / "tools" / "stack_budget.py"
spec = importlib.util.spec_from_file_location("stack_budget", TOOL)
sb = importlib.util.module_from_spec(spec)
sys.modules["stack_budget"] = sb
spec.loader.exec_module(sb)

BUDGET = {"loop_frame": 256, "max_frame": 512, "worst_path": 1000}


class Tree:
    """<tmp>/iot/<project>/.pio/build/<env>, beside <tmp>/iot/shared/lib, like src/iot."""

    def __init__(self, root: Path, project: str = "court-box", env: str = "court_bridge"):
        self.project = root / "iot" / project
        self.build = self.project / ".pio" / "build" / env
        self.build.mkdir(parents=True)
        (self.project / "lib" / "bridgelogic").mkdir(parents=True)
        (root / "iot" / "shared" / "lib" / "eventq").mkdir(parents=True)

    def su(self, rel: str, *rows: tuple[str, str, int, str]):
        path = self.build / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(f"{where}:10:6:{name}\t{size}\t{kind}\n" for where, name, size, kind in rows))

    def ci(self, rel: str, nodes: dict[str, int], edges: list[tuple[str, str]]):
        path = self.build / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        lines = [f'graph: {{ title: "{rel}"']
        for title, size in nodes.items():
            lines.append(f'node: {{ title: "{title}" label: "{title}\\nsrc/x.cpp:1:1\\n{size} bytes (static)" }}')
        for src, dst in edges:
            if dst not in nodes:
                lines.append(f'node: {{ title: "{dst}" label: "{dst}\\n<built-in>" shape : ellipse }}')
            lines.append(f'edge: {{ sourcename: "{src}" targetname: "{dst}" label: "src/x.cpp:2:2" }}')
        path.write_text("\n".join(lines + ["}"]) + "\n")


class StackBudgetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="stack-budget-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.tree = Tree(self.tmp)
        # A healthy build: ours small, the core's big (which must not count as ours).
        self.tree.su("src/court_bridge/main.cpp.su", ("src/court_bridge/main.cpp", "void loop()", 200, "static"))
        self.tree.su("lib1a2/bridgelogic/Screen.cpp.su", ("lib/bridgelogic/src/Screen.cpp", "void show()", 300, "static"))
        self.tree.su("lib3b4/eventq/EventQueue.cpp.su", ("/x/iot/shared/lib/eventq/src/EventQueue.cpp", "void push()", 48, "static"))
        self.tree.su("FrameworkArduino/core_esp8266_main.cpp.su", ("core_esp8266_main.cpp", "loop_wrapper", 16, "static"),
                     ("core_esp8266_main.cpp", "void loop()", 4000, "static"))
        self.tree.su("lib5c6/ESP8266WiFi/WiFiClient.cpp.su", ("WiFiClient.cpp", "int connect()", 2000, "dynamic"))
        self.tree.ci("src/court_bridge/main.cpp.ci", {"loop": 200, "src/court_bridge/main.cpp:show": 300, "push": 48},
                     [("loop", "src/court_bridge/main.cpp:show"), ("src/court_bridge/main.cpp:show", "push"),
                      ("loop", "__indirect_call"), ("push", "ets_printf")])

    def run_check(self, budget=None):
        out = io.StringIO()
        return sb.check(self.tree.build, budget or BUDGET, out), out.getvalue()

    def test_a_build_within_budget_passes_and_names_its_deepest_path(self):
        code, text = self.run_check()
        self.assertEqual(code, 0, text)
        self.assertIn("deepest path from loop(): 548 B", text)
        self.assertIn("1 indirect call sites and 1 precompiled callees not counted", text)

    def test_the_cores_frames_and_its_own_loop_are_not_ours(self):
        # A 4000 B "void loop()" in FrameworkArduino and a dynamic 2000 B WiFi frame: neither is ours.
        code, text = self.run_check()
        self.assertEqual(code, 0, text)
        self.assertIn("largest frame of ours: 300 B, void show()", text)

    def test_ours_is_decided_by_where_the_file_sits_not_by_the_path_gcc_wrote(self):
        # GCC 8 (the ESP32) writes bare basenames; a library of ours still counts.
        self.tree.su("lib3b4/eventq/Ring.cpp.su", ("Ring.cpp", "void ring()", 600, "static"))
        code, text = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("void ring() (Ring.cpp) frame 600 B > 512 B", text)

    def test_a_grown_loop_frame_fails(self):
        self.tree.su("src/court_bridge/main.cpp.su", ("src/court_bridge/main.cpp", "void loop()", 257, "static"))
        code, text = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("loop() frame 257 B > 256 B", text)

    def test_a_grown_path_fails_even_when_every_frame_is_inside_its_own_budget(self):
        self.tree.ci("src/court_bridge/main.cpp.ci", {"loop": 200, "a": 400, "b": 400, "c": 48},
                     [("loop", "a"), ("a", "b"), ("b", "c")])
        code, text = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("deepest path from loop() 1048 B > 1000 B", text)

    def test_the_deepest_branch_is_taken_not_the_first(self):
        self.tree.ci("src/court_bridge/main.cpp.ci", {"loop": 100, "shallow": 50, "deep": 300, "deeper": 200},
                     [("loop", "shallow"), ("loop", "deep"), ("deep", "deeper")])
        code, text = self.run_check()
        self.assertIn("deepest path from loop(): 600 B", text)

    def test_an_unbounded_dynamic_frame_of_ours_fails(self):
        self.tree.su("lib1a2/bridgelogic/Screen.cpp.su", ("lib/bridgelogic/src/Screen.cpp", "void show(int)", 64, "dynamic"))
        code, text = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("unbounded dynamic frame", text)

    def test_recursion_has_no_bound_and_is_an_error_not_a_pass(self):
        self.tree.ci("src/court_bridge/main.cpp.ci", {"loop": 100, "a": 10, "b": 10}, [("loop", "a"), ("a", "b"), ("b", "a")])
        with self.assertRaises(RecursionError):
            self.run_check()

    def test_a_target_with_no_path_budget_needs_no_call_graph(self):
        for ci in self.tree.build.rglob("*.ci"):
            ci.unlink()
        code, text = self.run_check({"loop_frame": 256, "max_frame": 512})
        self.assertEqual(code, 0, text)
        self.assertNotIn("deepest path", text)

    def test_a_build_without_stack_usage_is_a_usage_error(self):
        for su in self.tree.build.rglob("*.su"):
            su.unlink()
        self.assertEqual(self.run_check()[0], 2)

    def test_the_command_line_reads_the_shipped_budgets(self):
        budgets = json.loads((REPO / "src" / "iot" / "tools" / "stack_budget.json").read_text())["targets"]
        self.assertEqual(set(budgets), {"court_bridge", "door_gate"})
        self.assertIn("worst_path", budgets["court_bridge"])
        for target in budgets.values():
            for key in ("loop_frame", "max_frame"):
                self.assertIsInstance(target[key], int)
                # A budget at or under its goal is done; over it, the measured value must justify it.
                self.assertLessEqual(target[key], max(target["goal"][key], target["measured"][key]))
        done = subprocess.run([sys.executable, str(TOOL), "--build", str(self.tree.build), "--target", "nonexistent"],
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 2)


class WorkflowGateTests(unittest.TestCase):
    """The gate is wired into CI for both ESP images, with the flags the tool needs."""

    def test_iot_build_runs_the_gate_on_the_bridge_and_the_gate(self):
        import yaml
        job = yaml.safe_load((REPO / ".github" / "workflows" / "ci.yml").read_text())["jobs"]["iot-build"]
        step = next(s for s in job["steps"] if s.get("name", "").startswith("Stack budget"))
        script = step["run"]
        self.assertIn("-fstack-usage -fcallgraph-info=su", script)
        self.assertIn("--target court_bridge", script)
        self.assertIn("--target door_gate", script)


if __name__ == "__main__":
    unittest.main()

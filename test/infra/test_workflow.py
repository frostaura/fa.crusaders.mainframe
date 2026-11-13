"""The publish half of .github/workflows/ci.yml: what is tagged, when :latest moves, and in what order.

IO-05 (immutable release tags, revision labels) and IO-13 (no stale or mixed :latest). The last
class RUNS the shipped promote step, with `docker` stubbed and a real git history, so the
forward-only rule is tested as the bash CI executes, not as a reading of it.
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

import yaml

from infra_support import REPO

WORKFLOW = REPO / ".github" / "workflows" / "ci.yml"
IMAGES = ("backend", "frontend", "gateway")
ARCHES = ("amd64", "arm64")
BUILD_JOBS = [f"build-{i}-{a}" for i in IMAGES for a in ARCHES]


def load() -> dict:
    return yaml.safe_load(WORKFLOW.read_text())


def run_scripts(job: dict) -> str:
    return "\n".join(step.get("run", "") for step in job["steps"])


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.wf = load()
        self.jobs = self.wf["jobs"]

    def test_builds_push_only_immutable_per_commit_tags(self):
        for name in BUILD_JOBS:
            image, arch = name.split("-")[1:]
            with self.subTest(job=name):
                push = next(s for s in self.jobs[name]["steps"] if s.get("uses", "").startswith("docker/build-push-action"))
                tags = push["with"]["tags"].splitlines()
                self.assertEqual(tags, [f"${{{{ secrets.DOCKERHUB_USERNAME }}}}/crusaders-mainframe-{image}:sha-${{{{ github.sha }}}}-{arch}"])

    def test_every_image_is_labelled_with_its_commit(self):
        for name in BUILD_JOBS:
            with self.subTest(job=name):
                push = next(s for s in self.jobs[name]["steps"] if s.get("uses", "").startswith("docker/build-push-action"))
                self.assertIn("org.opencontainers.image.revision=${{ github.sha }}", push["with"]["labels"])
                self.assertIn("BUILD_SHA=${{ github.sha }}", push["with"]["build-args"])

    def test_only_promote_latest_writes_latest(self):
        writers = [name for name, job in self.jobs.items()
                   if "imagetools create" in run_scripts(job) and ":latest" in run_scripts(job)]
        self.assertEqual(writers, ["promote-latest"])

    def test_latest_moves_only_after_all_six_builds_and_the_release(self):
        self.assertEqual(sorted(self.jobs["publish-release"]["needs"]), sorted(BUILD_JOBS))
        self.assertEqual(self.jobs["promote-latest"]["needs"], ["publish-release"])
        release = run_scripts(self.jobs["publish-release"])
        self.assertIn("for image in backend frontend gateway", release)
        self.assertIn('sha-$GITHUB_SHA-amd64" "$repo:sha-$GITHUB_SHA-arm64"', release)

    def test_promotions_never_overlap_and_are_never_cancelled(self):
        concurrency = self.jobs["promote-latest"]["concurrency"]
        self.assertEqual(concurrency["group"], "promote-latest")
        self.assertIs(concurrency["cancel-in-progress"], False)

    def test_pull_request_runs_are_superseded_and_main_runs_are_not(self):
        concurrency = self.wf["concurrency"]
        self.assertEqual(concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}")
        self.assertIn("github.run_id", concurrency["group"], "a main push must key on its own run, never queue")
        self.assertIn("pull_request.number", concurrency["group"])

    def test_every_build_waits_for_every_gate_including_this_one(self):
        gates = {"backend", "frontend", "e2e", "e2e-device", "backend-integration", "iot", "iot-build", "security", "infra"}
        for name in BUILD_JOBS:
            with self.subTest(job=name):
                self.assertEqual(set(self.jobs[name]["needs"]), gates)
                self.assertEqual(self.jobs[name]["if"], "github.event_name == 'push' && github.ref == 'refs/heads/main'")

    def test_arduino_cli_is_pinned(self):
        script = run_scripts(self.jobs["iot-build"])
        self.assertNotIn("arduino-cli/master/", script)
        self.assertRegex(script, r"ARDUINO_CLI_VERSION=v\d+\.\d+\.\d+")
        self.assertIn('sh -s "$ARDUINO_CLI_VERSION"', script)


class PromoteStepBehaviourTests(unittest.TestCase):
    """The shipped `Move :latest forward` script, run against a stub registry and real commits."""

    @classmethod
    def setUpClass(cls):
        if shutil.which("bash") is None or shutil.which("git") is None:
            raise unittest.SkipTest("needs bash and git")
        job = load()["jobs"]["promote-latest"]
        cls.script = next(s["run"] for s in job["steps"] if s.get("name") == "Move :latest forward")

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="promote-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        git = lambda *a: subprocess.run(["git", "-C", str(self.repo), *a], check=True, capture_output=True, text=True).stdout.strip()
        git("init", "-q")
        git("config", "user.email", "ci@example.review.test")
        git("config", "user.name", "ci")
        self.commits = []
        for n in range(3):  # A -> B -> C on one line
            git("commit", "-q", "--allow-empty", "-m", f"c{n}")
            self.commits.append(git("rev-parse", "HEAD"))
        git("checkout", "-q", "-b", "side", self.commits[0])
        git("commit", "-q", "--allow-empty", "-m", "side")
        self.side = git("rev-parse", "HEAD")  # descends from A, unrelated to B and C
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.registry = self.tmp / "registry.json"
        self.created = self.tmp / "created.log"
        stub = self.bin / "docker"
        stub.write_text(textwrap.dedent(f"""\
            #!/usr/bin/env python3
            import json, sys
            args = sys.argv[1:]
            registry = json.load(open({str(self.registry)!r}))
            if args[:3] == ["buildx", "imagetools", "inspect"]:
                ref = args[3]
                if ref == "FAIL/crusaders-mainframe-backend:latest":
                    print("ERROR: unauthorized: authentication required", file=sys.stderr); sys.exit(1)
                if ref not in registry:
                    print(f"ERROR: docker.io/{{ref}}: not found", file=sys.stderr); sys.exit(1)
                labels = {{}} if registry[ref] is None else {{"org.opencontainers.image.revision": registry[ref]}}
                cfg = {{"config": {{"Labels": labels}}}}
                print(json.dumps({{"linux/amd64": cfg, "linux/arm64": cfg}}))
            elif args[:3] == ["buildx", "imagetools", "create"]:
                open({str(self.created)!r}, "a").write(" ".join(args[3:]) + "\\n")
            else:
                sys.exit(f"unexpected docker call: {{args}}")
            """))
        stub.chmod(stub.stat().st_mode | stat.S_IEXEC)

    def promote(self, sha: str, latest: dict, user: str = "frostaura") -> subprocess.CompletedProcess:
        self.registry.write_text(json.dumps({f"{user}/crusaders-mainframe-{i}:latest": rev
                                             for i, rev in latest.items()}))
        env = {"PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}", "GITHUB_SHA": sha,
               "REGISTRY_USER": user, "RUNNER_TEMP": str(self.tmp),
               "GITHUB_STEP_SUMMARY": str(self.tmp / "summary.md"), "HOME": os.environ.get("HOME", "")}
        return subprocess.run(["bash", "-c", self.script], cwd=self.repo, env=env, capture_output=True, text=True)

    def created_latest(self) -> list[str]:
        return self.created.read_text().splitlines() if self.created.exists() else []

    def assert_promoted(self, sha):
        self.assertEqual(self.created_latest(),
                         [f"-t frostaura/crusaders-mainframe-{i}:latest frostaura/crusaders-mainframe-{i}:sha-{sha}" for i in IMAGES])

    def test_latest_from_before_release_tagging_is_replaced(self):
        done = self.promote(self.commits[1], {i: None for i in IMAGES})
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assert_promoted(self.commits[1])

    def test_no_latest_at_all_is_created(self):
        done = self.promote(self.commits[0], {})
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assert_promoted(self.commits[0])

    def test_latest_moves_forward_to_a_descendant(self):
        done = self.promote(self.commits[2], {i: self.commits[0] for i in IMAGES})
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assert_promoted(self.commits[2])

    def test_an_older_run_finishing_late_leaves_latest_alone(self):
        done = self.promote(self.commits[1], {i: self.commits[2] for i in IMAGES})
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.created_latest(), [])
        self.assertIn("Not promoted", (self.tmp / "summary.md").read_text())

    def test_one_image_ahead_holds_back_all_three(self):
        latest = {"backend": self.commits[0], "frontend": self.commits[2], "gateway": self.commits[0]}
        done = self.promote(self.commits[1], latest)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.created_latest(), [], "a mixed :latest is what this step exists to prevent")

    def test_an_unrelated_history_is_not_forward(self):
        done = self.promote(self.side, {i: self.commits[2] for i in IMAGES})
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.created_latest(), [])

    def test_already_at_this_commit_rewrites_the_same_release(self):
        done = self.promote(self.commits[2], {i: self.commits[2] for i in IMAGES})
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assert_promoted(self.commits[2])

    def test_a_registry_error_fails_the_job_instead_of_guessing(self):
        done = self.promote(self.commits[2], {}, user="FAIL")
        self.assertNotEqual(done.returncode, 0)
        self.assertEqual(self.created_latest(), [])
        self.assertIn("unauthorized", done.stderr)


if __name__ == "__main__":
    unittest.main()

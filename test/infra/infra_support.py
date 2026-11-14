"""Shared helpers for the release & operations tests (`make test-infra`)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# Only what the docker CLI itself needs. Anything else in the caller's environment — a
# POSTGRES_PASSWORD, an SMTP_HOST exported in a shell — would be interpolated into the compose
# files and make the assertions depend on whoever ran them.
_PASS_THROUGH = ("PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT",
                 "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "XDG_RUNTIME_DIR", "USER", "LANG")


def docker_env(**overrides: str) -> dict[str, str]:
    env = {key: os.environ[key] for key in _PASS_THROUGH if key in os.environ}
    env.update(overrides)
    return env


def compose_config(*files: str, **env: str) -> dict:
    """The merged configuration `docker compose` would run, as JSON. Never reads a .env file."""
    if shutil.which("docker") is None:
        raise unittest_skip("the docker CLI is not installed")
    args = ["docker", "compose", "--env-file", os.devnull, "--project-directory", str(REPO)]
    for name in files:
        args += ["-f", str(REPO / name)]
    done = subprocess.run(args + ["config", "--format", "json"], capture_output=True, text=True,
                          env=docker_env(**env), cwd=REPO)
    if done.returncode != 0:
        raise AssertionError(f"docker compose config failed for {files}: {done.stderr}")
    return json.loads(done.stdout)


def unittest_skip(reason: str):
    import unittest
    return unittest.SkipTest(reason)


def docker_daemon_available() -> bool:
    if shutil.which("docker") is None:
        return False
    done = subprocess.run(["docker", "info", "--format", "{{.ServerVersion}}"], capture_output=True,
                          text=True, timeout=30)
    return done.returncode == 0


def require_docker_daemon():
    """Skip without a daemon — unless INFRA_REQUIRE_DOCKER=1 (CI), where a skip would be a pass."""
    import unittest
    if docker_daemon_available():
        return
    if os.environ.get("INFRA_REQUIRE_DOCKER") == "1":
        raise AssertionError("INFRA_REQUIRE_DOCKER=1 but no Docker daemon answers")
    raise unittest.SkipTest("no Docker daemon; set INFRA_REQUIRE_DOCKER=1 to make this a failure")

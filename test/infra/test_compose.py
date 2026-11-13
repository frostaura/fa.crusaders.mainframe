"""The compose files and Dockerfiles, as `docker compose config` and the build actually read them.

Each test names the finding it closes (the 2026-11-13 infra-ops analysis, IO-nn).
"""

from __future__ import annotations

import re
import unittest

from infra_support import REPO, compose_config

PROD = "docker-compose.prod.yml"
BASE = "docker-compose.yml"
ONPREM = "docker-compose.onprem.yml"
TEST = "docker-compose.test.yml"
OUR_IMAGES = ("backend", "frontend", "gateway")
DEV_ENV = {"POSTGRES_PASSWORD": "infra-test-pw", "JWT_SECRET": "infra-test-jwt"}


def services(config: dict) -> dict:
    return config["services"]


class ReleaseTagTests(unittest.TestCase):
    """IO-05: what production runs is one variable, and it names all three images at once."""

    def test_one_variable_pins_all_three_images_to_the_same_release(self):
        for tag in ("sha-0123456789abcdef0123456789abcdef01234567", "sha-fedcba9876543210fedcba9876543210fedcba98"):
            with self.subTest(tag=tag):
                svc = services(compose_config(PROD, CRUSADERS_IMAGE_TAG=tag))
                for name in OUR_IMAGES:
                    self.assertEqual(svc[name]["image"], f"frostaura/crusaders-mainframe-{name}:{tag}")

    def test_unset_it_falls_back_to_latest(self):
        svc = services(compose_config(PROD))
        for name in OUR_IMAGES:
            self.assertEqual(svc[name]["image"], f"frostaura/crusaders-mainframe-{name}:latest")


class PinnedImageTests(unittest.TestCase):
    """IO-17: nothing third-party floats. A redeploy changes only what this repository changed."""

    def assert_pinned(self, image: str, where: str):
        if image.startswith("frostaura/crusaders-mainframe-"):
            return  # ours: pinned by CRUSADERS_IMAGE_TAG (above)
        name, _, tag = image.rpartition(":")
        self.assertTrue(name and tag, f"{where}: {image} has no tag")
        self.assertNotIn(tag, ("latest", "alpine", "stable", "mainline"), f"{where}: {image} floats")

    def test_every_compose_image_is_pinned(self):
        for files, env in (((PROD,), {}), ((BASE,), DEV_ENV), ((BASE, ONPREM), DEV_ENV), ((TEST,), {})):
            for name, svc in services(compose_config(*files, **env)).items():
                if "image" in svc and "build" not in svc:
                    with self.subTest(files=files, service=name):
                        self.assert_pinned(svc["image"], f"{files}/{name}")

    def test_cloudflared_is_a_calver_release(self):
        image = services(compose_config(PROD))["cloudflared"]["image"]
        self.assertRegex(image, r"^cloudflare/cloudflared:\d{4}\.\d{1,2}\.\d+$")

    def test_every_dockerfile_base_is_pinned(self):
        for path in ("src/backend/Dockerfile", "src/frontend/Dockerfile", "nginx/Dockerfile"):
            for line in (REPO / path).read_text().splitlines():
                match = re.match(r"^FROM\s+(\S+)", line)
                if match:
                    with self.subTest(dockerfile=path, base=match[1]):
                        self.assert_pinned(match[1], path)


class LogRotationTests(unittest.TestCase):
    """IO-07: no container log grows without bound on the Pi's SD card."""

    def assert_rotated(self, files, env):
        for name, svc in services(compose_config(*files, **env)).items():
            with self.subTest(files=files, service=name):
                logging = svc.get("logging") or {}
                self.assertEqual(logging.get("driver"), "json-file")
                self.assertRegex(logging.get("options", {}).get("max-size", ""), r"^\d+m$")
                self.assertRegex(logging.get("options", {}).get("max-file", ""), r"^\d+$")

    def test_every_production_service_rotates_its_log(self):
        self.assert_rotated((PROD,), {})

    def test_every_onprem_service_rotates_its_log(self):
        self.assert_rotated((BASE, ONPREM), DEV_ENV)

    def test_production_does_not_log_every_ef_command(self):
        env = services(compose_config(PROD))["backend"]["environment"]
        self.assertEqual(env.get("Logging__LogLevel__Microsoft.EntityFrameworkCore"), "Warning")


class BackupServiceTests(unittest.TestCase):
    """IO-01: the stack that holds the ledger also backs it up (behaviour: test_backup_restore)."""

    def assert_backup(self, files, env, password):
        svc = services(compose_config(*files, **env))
        backup = svc["backup"]
        self.assertEqual(backup["image"], svc["postgres"]["image"], "pg_dump must match the server's major")
        self.assertEqual(backup["depends_on"]["postgres"]["condition"], "service_healthy")
        mounts = {m["target"]: m for m in backup["volumes"]}
        self.assertEqual(mounts["/backups"]["type"], "bind", "backups land on the HOST, for the offsite copy")
        self.assertEqual(mounts["/media"]["source"], "media_data", "the photos are backed up too")
        self.assertEqual(backup["environment"]["PGPASSWORD"], password)
        for key in ("BACKUP_HOUR_UTC", "BACKUP_KEEP_DAYS", "BACKUP_KEEP_MIN"):
            self.assertRegex(backup["environment"][key], r"^\d+$")
        self.assertIn("crusaders-restore", backup["command"][0])
        self.assertIn("healthcheck", backup)

    def test_production_has_a_backup_service(self):
        db_password = services(compose_config(PROD))["postgres"]["environment"]["POSTGRES_PASSWORD"]
        self.assert_backup((PROD,), {}, db_password)

    def test_onprem_backs_up_its_own_database(self):
        self.assert_backup((BASE, ONPREM), DEV_ENV, DEV_ENV["POSTGRES_PASSWORD"])

    def test_the_backup_directory_is_one_variable(self):
        backup = services(compose_config(PROD, CRUSADERS_BACKUP_DIR="/srv/elsewhere"))["backup"]
        self.assertIn("/srv/elsewhere", [m["source"] for m in backup["volumes"]])


class OnPremMailTests(unittest.TestCase):
    """IO-15: the on-prem overlay sends mail where .env says, and MailHog only listens on loopback."""

    def backend_env(self, **env):
        return services(compose_config(BASE, ONPREM, **DEV_ENV, **env))["backend"]["environment"]

    def test_a_real_relay_in_env_is_the_relay_the_api_uses(self):
        for host, port in (("smtp.example.test", "587"), ("relay.club.review.test", "2525")):
            with self.subTest(host=host):
                env = self.backend_env(SMTP_HOST=host, SMTP_PORT=port)
                self.assertEqual((env["Smtp__Host"], env["Smtp__Port"]), (host, port))
                # The flat names are read BEFORE Smtp__Host; their presence is what swallowed mail.
                self.assertNotIn("SMTP_HOST", env)
                self.assertNotIn("SMTP_PORT", env)

    def test_with_no_relay_mail_goes_to_mailhog_on_loopback(self):
        env = self.backend_env()
        self.assertEqual((env["Smtp__Host"], env["Smtp__Port"]), ("127.0.0.1", "11025"))

    def test_mailhog_is_published_on_loopback_only(self):
        ports = services(compose_config(BASE, ONPREM, **DEV_ENV))["mailhog"]["ports"]
        self.assertEqual(sorted(p["published"] for p in ports), ["11025", "8025"])
        for port in ports:
            self.assertEqual(port.get("host_ip"), "127.0.0.1", port)


class NonRootBackendTests(unittest.TestCase):
    """IO-17: the API does not run as root, and its volumes are handed over before it starts."""

    def test_the_backend_image_drops_root_before_its_entrypoint(self):
        lines = [l.strip() for l in (REPO / "src/backend/Dockerfile").read_text().splitlines()
                 if l.strip() and not l.strip().startswith("#")]
        runtime = lines[max(i for i, l in enumerate(lines) if l.startswith("FROM")):]
        users = [l for l in runtime if l.startswith("USER ")]
        self.assertTrue(users, "the runtime stage never leaves root")
        self.assertNotIn(users[-1].split()[1], ("root", "0"))
        self.assertLess(runtime.index(users[-1]), next(i for i, l in enumerate(runtime) if l.startswith("ENTRYPOINT")))

    def test_both_stacks_chown_the_volumes_before_the_backend_starts(self):
        for files, env in (((PROD,), {}), ((BASE,), DEV_ENV), ((BASE, ONPREM), DEV_ENV)):
            with self.subTest(files=files):
                svc = services(compose_config(*files, **env))
                self.assertEqual(svc["backend"]["depends_on"]["volume-init"]["condition"],
                                 "service_completed_successfully")
                init_targets = {m["source"]: m["target"] for m in svc["volume-init"]["volumes"]}
                backend_targets = {m["source"]: m["target"] for m in svc["backend"]["volumes"]}
                self.assertEqual(init_targets, backend_targets)
                self.assertIn("1654", " ".join(svc["volume-init"]["command"]))


class BuildShaTests(unittest.TestCase):
    """IO-05 / IO-17: every image records its commit; CI's BUILD_SHA reaches something now."""

    def test_every_dockerfile_declares_build_sha_and_labels_the_revision(self):
        for path in ("src/backend/Dockerfile", "src/frontend/Dockerfile", "nginx/Dockerfile"):
            text = (REPO / path).read_text()
            runtime = text[text.rindex("\nFROM "):]
            with self.subTest(dockerfile=path):
                self.assertRegex(runtime, r"\nARG BUILD_SHA=")
                self.assertRegex(runtime, r"\nLABEL org\.opencontainers\.image\.revision=\$BUILD_SHA")
                self.assertRegex(runtime, r"\nENV BUILD_SHA=\$BUILD_SHA")


if __name__ == "__main__":
    unittest.main()

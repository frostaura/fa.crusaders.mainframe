"""IO-01 and IO-06 against real containers: the production backup service backs up, prunes and
restores, and the pending-migrations check reads a real database.

This runs docker-compose.prod.yml's own `postgres` and `backup` services — the shipped scripts,
not a copy — as a throwaway compose project with its own volumes, network and backup directory,
then plays the runbook (docs/runbooks/backup-and-restore.md): a backup, a simulated total loss of
the database AND the photos, and the restore, checked row by row. Nothing here touches another
compose project; the shared `crusaders` stack is never named.

Skips without a Docker daemon unless INFRA_REQUIRE_DOCKER=1 (CI), where a skip would be a pass.
"""

from __future__ import annotations

import importlib.util
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from infra_support import REPO, docker_env, require_docker_daemon

PROD = REPO / "docker-compose.prod.yml"
DB = "crusaders_mainframe"
TOOL = REPO / "src" / "backend" / "tools" / "pending_migrations.py"

spec = importlib.util.spec_from_file_location("pending_migrations_rt", TOOL)
pm = importlib.util.module_from_spec(spec)
sys.modules["pending_migrations_rt"] = pm
spec.loader.exec_module(pm)

# A ledger the size of a real one is not the point; a ledger whose every row must come back is.
SEED_SQL = """
CREATE TABLE "__EFMigrationsHistory" ("MigrationId" varchar(150) PRIMARY KEY, "ProductVersion" varchar(32) NOT NULL);
CREATE TABLE ledger_entries (id serial PRIMARY KEY, tenant_id uuid NOT NULL, minutes int NOT NULL, reason text NOT NULL);
CREATE TABLE tenants (id uuid PRIMARY KEY, slug text NOT NULL, device_api_key text NOT NULL);
INSERT INTO tenants VALUES ('11111111-1111-1111-1111-111111111111', 'crusaders', 'the-key-every-box-carries');
INSERT INTO ledger_entries (tenant_id, minutes, reason)
  SELECT '11111111-1111-1111-1111-111111111111', g * 7 - 300, 'row ' || g FROM generate_series(1, 250) g;
"""
FINGERPRINT_SQL = ("select count(*), sum(minutes), (select device_api_key from tenants), "
                   "(select count(*) from \"__EFMigrationsHistory\") from ledger_entries;")


class Stack:
    """One throwaway compose project from the production file: postgres + backup only."""

    def __init__(self):
        self.project = f"crusaders-infra-{os.getpid()}-{random.randint(1000, 9999)}"
        self.tmp = Path(tempfile.mkdtemp(prefix="crusaders-backup-"))
        self.backups = self.tmp / "backups"
        self.backups.mkdir()
        # Its own subnet: the production file pins 10.83.29.0/24, and two projects cannot share one.
        self.override = self.tmp / "override.yml"
        self.override.write_text(
            "networks:\n  default:\n    ipam:\n      config: !override\n"
            f"        - subnet: 10.{random.randint(200, 250)}.{random.randint(0, 255)}.0/24\n")
        self.env = docker_env(CRUSADERS_BACKUP_DIR=str(self.backups))

    def compose(self, *args: str, check: bool = True, timeout: int = 180, stdin: str | None = None):
        argv = ["docker", "compose", "-p", self.project, "--env-file", os.devnull,
                "--project-directory", str(REPO), "-f", str(PROD), "-f", str(self.override), *args]
        done = subprocess.run(argv, capture_output=True, text=True, env=self.env, cwd=REPO,
                              timeout=timeout, input=stdin)
        if check and done.returncode != 0:
            raise AssertionError(f"{' '.join(args)} exited {done.returncode}:\n{done.stdout}\n{done.stderr}")
        return done

    def psql_command(self) -> str:
        return (f"docker compose -p {self.project} --env-file {os.devnull} --project-directory {REPO} "
                f"-f {PROD} -f {self.override} exec -T postgres psql -U crusaders -d {DB}")

    def psql(self, sql: str) -> str:
        return self.compose("exec", "-T", "postgres", "psql", "-U", "crusaders", "-d", DB,
                            "-v", "ON_ERROR_STOP=1", "-At", stdin=sql).stdout.strip()

    def backup_sh(self, script: str, check: bool = True):
        return self.compose("exec", "-T", "backup", "sh", "-c", script, check=check)

    def up_database(self):
        self.compose("up", "-d", "--wait", "postgres", timeout=300)

    def start_backup(self):
        self.compose("up", "-d", "--no-deps", "backup")

    def up(self):
        self.up_database()
        self.start_backup()

    def dumps(self) -> list[str]:
        return sorted(p.name for p in self.backups.glob("crusaders-*.dump"))

    def wait_for(self, predicate, what: str, seconds: int = 120):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(2)
        logs = self.compose("logs", "backup", check=False).stdout
        raise AssertionError(f"timed out after {seconds}s waiting for {what}\n{logs}")

    def destroy(self):
        self.compose("down", "-v", "--remove-orphans", check=False, timeout=180)
        # The container wrote as root; on a Linux runner the host cannot delete those files itself.
        subprocess.run(["docker", "run", "--rm", "-v", f"{self.backups}:/b", "postgres:16-alpine",
                        "sh", "-c", "rm -rf /b/* /b/.[!.]*"], capture_output=True, env=self.env, timeout=120)
        shutil.rmtree(self.tmp, ignore_errors=True)


class BackupRestoreTests(unittest.TestCase):
    """The runbook, end to end, in order. One stack for the class: Postgres start-up dominates."""

    @classmethod
    def setUpClass(cls):
        require_docker_daemon()
        cls.stack = Stack()
        try:
            # The database is seeded BEFORE the backup service starts: on a host with no backup it
            # dumps at once, and the first dump must be of this data.
            cls.stack.up_database()
            cls.stack.psql(SEED_SQL)
            ids = [m.id for m in pm.migrations_in_tree(REPO / pm.MIGRATIONS_DIR)]
            cls.migration_ids = ids
            # Applied up to all but the last three: a database one release behind.
            cls.stack.psql("".join(f"INSERT INTO \"__EFMigrationsHistory\" VALUES ('{i}', '10.0.0');\n" for i in ids[:-3]))
            cls.stack.compose("run", "--rm", "--no-deps", "--entrypoint", "sh", "backup", "-c",
                              "mkdir -p /media/profile && printf 'photo-bytes' > /media/profile/member-1.jpg")
            cls.stack.start_backup()
        except BaseException:
            cls.stack.destroy()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.stack.destroy()

    def test_1_a_host_with_no_backup_gets_one_at_once(self):
        self.stack.wait_for(lambda: any(n.startswith("crusaders-daily-") for n in self.stack.dumps()), "the first daily dump")
        daily = next(n for n in self.stack.dumps() if n.startswith("crusaders-daily-"))
        self.assertTrue((self.stack.backups / daily.replace(".dump", ".media.tar.gz")).exists(), "photos beside the dump")
        # And it is a real, readable dump of THIS database.
        listing = self.stack.backup_sh(f"pg_restore --list /backups/{daily}").stdout
        self.assertIn("TABLE DATA public ledger_entries", listing)
        self.assertEqual(list(self.stack.backups.glob(".*partial*")), [], "no half-written file is left behind")

    def test_2_a_predeploy_backup_on_demand_is_labelled(self):
        out = self.stack.backup_sh("crusaders-backup predeploy").stdout
        self.assertIn("wrote /backups/crusaders-predeploy-", out)
        self.assertTrue(any(n.startswith("crusaders-predeploy-") for n in self.stack.dumps()))
        refused = self.stack.backup_sh("crusaders-backup 'Bad Label'", check=False)
        self.assertEqual(refused.returncode, 2)

    def test_3_the_pending_migrations_check_reads_the_real_database(self):
        out = subprocess.run([sys.executable, str(TOOL), "--psql", self.stack.psql_command()],
                             capture_output=True, text=True, timeout=120, env=os.environ | {"COMPOSE_PROJECT_NAME": ""})
        self.assertEqual(out.returncode, pm.EXIT_PENDING, out.stdout + out.stderr)
        self.assertIn("3 pending", out.stdout)
        for migration_id in self.migration_ids[-3:]:
            self.assertIn(migration_id, out.stdout)
        self.assertNotIn(self.migration_ids[-4], out.stdout.split("pending", 1)[1])

    def test_4_total_loss_then_restore_brings_back_every_row_and_photo(self):
        before = self.stack.psql(FINGERPRINT_SQL)
        dump = next(n for n in self.stack.dumps() if n.startswith("crusaders-predeploy-"))

        # Total loss: the database volume AND the photos, as a dead SD card would take them. The
        # backup directory is on the host and survives — that is the whole design.
        self.stack.compose("down", "-v")
        self.assertIn(dump, self.stack.dumps())
        self.stack.up()
        empty = self.stack.psql("select count(*) from pg_tables where schemaname = 'public';")
        self.assertEqual(empty, "0", "the simulated loss did not lose anything")

        # The restore refuses without the database's name repeated...
        refused = self.stack.backup_sh(f"crusaders-restore {dump}", check=False)
        self.assertEqual(refused.returncode, 2, refused.stderr)
        self.assertIn("repeat its name", refused.stderr)
        # ...and while anything is connected (here: a backend that was not stopped).
        self.stack.compose("exec", "-d", "postgres", "psql", "-U", "crusaders", "-d", DB, "-c", "select pg_sleep(20);")
        self.stack.wait_for(lambda: self.stack.psql(
            f"select count(*) from pg_stat_activity where datname = '{DB}' and query like '%pg_sleep%' and pid <> pg_backend_pid();") == "1",
            "the stray connection", 30)
        busy = self.stack.backup_sh(f"crusaders-restore {dump} {DB}", check=False)
        self.assertEqual(busy.returncode, 3, busy.stdout + busy.stderr)
        self.stack.wait_for(lambda: self.stack.psql(
            f"select count(*) from pg_stat_activity where datname = '{DB}' and pid <> pg_backend_pid();") == "0",
            "the stray connection to end", 40)

        done = self.stack.backup_sh(f"crusaders-restore {dump} {DB}")
        self.assertIn("photos restored", done.stdout)
        self.assertIn(f"newest migration is {self.migration_ids[-4]}", done.stdout)
        self.assertEqual(self.stack.psql(FINGERPRINT_SQL), before)
        photo = self.stack.backup_sh("cat /media/profile/member-1.jpg").stdout
        self.assertEqual(photo, "photo-bytes")
        # The empty database it replaced was itself backed up first.
        self.assertTrue(any(n.startswith("crusaders-pre-restore-") for n in self.stack.dumps()))

    def old(self) -> list[str]:
        # Only the planted January files: the daily loop may write a fresh one at any moment.
        return [n for n in self.stack.dumps() if n.startswith("crusaders-daily-202601")]

    def test_5_retention_prunes_old_backups_but_never_the_newest_few(self):
        # A host whose job died a month ago: only old backups. None may go.
        self.stack.backup_sh(
            "mkdir -p /backups/keep && mv /backups/crusaders-*.dump /backups/crusaders-*.media.tar.gz /backups/keep/; "
            "for d in 01 02 03 04 05; do f=/backups/crusaders-daily-202601${d}T000000Z; "
            "  printf x > $f.dump; printf x > $f.media.tar.gz; touch -d \"2026-01-$d 00:00:00\" $f.dump $f.media.tar.gz; done; "
            "BACKUP_KEEP_MIN=5 crusaders-prune")
        self.assertEqual(self.old(), [f"crusaders-daily-202601{d}T000000Z.dump" for d in ("01", "02", "03", "04", "05")],
                         "a failed job must not prune away the last good copies")
        # The same host with a minimum of three: the two oldest go, dump and photos together.
        self.stack.backup_sh("BACKUP_KEEP_MIN=3 crusaders-prune")
        self.assertEqual(self.old(), [f"crusaders-daily-202601{d}T000000Z.dump" for d in ("03", "04", "05")])
        self.assertFalse((self.stack.backups / "crusaders-daily-20260101T000000Z.media.tar.gz").exists())
        # And fresh backups beside them: everything older than the window goes, the fresh stay.
        self.stack.backup_sh("mv /backups/keep/* /backups/ && rmdir /backups/keep && crusaders-prune")
        self.assertEqual(self.old(), [])
        self.assertGreaterEqual(len(self.stack.dumps()), 3)


if __name__ == "__main__":
    unittest.main()

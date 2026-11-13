"""src/backend/tools/pending_migrations.py — IO-06, the pre-deploy migration check.

The database half against a real Postgres lives in test_backup_restore.py, where one is running.
"""

from __future__ import annotations

import importlib.util
import io
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from infra_support import REPO

TOOL = REPO / "src" / "backend" / "tools" / "pending_migrations.py"
spec = importlib.util.spec_from_file_location("pending_migrations", TOOL)
pm = importlib.util.module_from_spec(spec)
sys.modules["pending_migrations"] = pm  # dataclasses resolve annotations through it
spec.loader.exec_module(pm)


def write_migration(directory: Path, migration_id: str, up: str = "", down: str = "", file_stem: str | None = None):
    stem = file_stem or migration_id
    (directory / f"{stem}.Designer.cs").write_text(textwrap.dedent(f"""\
        namespace Crusaders.Mainframe.Api.Migrations
        {{
            [DbContext(typeof(MainframeDbContext))]
            [Migration("{migration_id}")]
            partial class X {{ }}
        }}
        """))
    (directory / f"{stem}.cs").write_text(textwrap.dedent(f"""\
        public partial class X : Migration
        {{
            protected override void Up(MigrationBuilder migrationBuilder)
            {{
                {up}
            }}
            protected override void Down(MigrationBuilder migrationBuilder)
            {{
                {down}
            }}
        }}
        """))


class ClassifyTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="migrations-"))
        self.addCleanup(shutil.rmtree, self.dir, True)

    def known(self):
        return {m.id: m for m in pm.migrations_in_tree(self.dir)}

    def test_row_changing_sql_in_up_is_flagged(self):
        write_migration(self.dir, "20260101000000_Flip", up='migrationBuilder.Sql("UPDATE user_preferences SET \\"Findable\\" = TRUE;");')
        write_migration(self.dir, "20260101000001_Purge", up='migrationBuilder.Sql(@"DELETE FROM sessions WHERE expired");')
        write_migration(self.dir, "20260101000002_Seed", up='migrationBuilder.InsertData(table: "x", columns: new[] { "a" }, values: new object[] { 1 });')
        known = self.known()
        self.assertTrue(all(m.changes_data for m in known.values()), known)

    def test_schema_only_and_down_only_changes_are_not(self):
        write_migration(self.dir, "20260101000000_AddColumn", up='migrationBuilder.AddColumn<int>(name: "SeatShortfall", table: "bookings");')
        # Down() never runs on a redeploy, so an UPDATE there is not a reason to stop.
        write_migration(self.dir, "20260101000001_Reversible", up='migrationBuilder.AddColumn<int>(name: "x", table: "y");',
                        down='migrationBuilder.Sql("UPDATE y SET x = 0");')
        # A column NAMED like a keyword is not a statement.
        write_migration(self.dir, "20260101000002_UpdatedAt", up='migrationBuilder.AddColumn<DateTime>(name: "UpdatedAt", table: "z");')
        self.assertFalse(any(m.changes_data or m.can_refuse for m in self.known().values()))

    def test_a_refusing_migration_is_flagged(self):
        write_migration(self.dir, "20260101000000_Refuse", up='migrationBuilder.Sql("DO $$ BEGIN RAISE EXCEPTION \'pre-launch reset required\'; END $$;");')
        self.assertTrue(self.known()["20260101000000_Refuse"].can_refuse)

    def test_sql_built_by_a_helper_or_held_in_a_constant_is_read(self):
        # MinutesReplaceCredits' shape: the refusal is a helper's raw string, Up() passes the call.
        helper = textwrap.indent(textwrap.dedent('''\
            private static string Refusal(string column) => $"""
                DO $$ BEGIN
                    IF EXISTS (SELECT 1 FROM ledger_entries) THEN
                        RAISE EXCEPTION 'pre-launch reset required ({column})';
                    END IF;
                END $$;
                """;
            private const string Backfill = @"UPDATE member_groups SET ""Discount"" = 0";
            '''), "    ")
        for stem, up in (("Refuses", "migrationBuilder.Sql(Refusal(\"Minutes\"));"),
                         ("Backfills", "migrationBuilder.Sql(Backfill);")):
            write_migration(self.dir, f"20260101000000_{stem}", up=up)
            path = self.dir / f"20260101000000_{stem}.cs"
            path.write_text(path.read_text().replace("public partial class X : Migration\n{\n",
                                                     "public partial class X : Migration\n{\n" + helper, 1))
        known = self.known()
        self.assertTrue(known["20260101000000_Refuses"].can_refuse, "a RAISE from a helper method")
        self.assertTrue(known["20260101000000_Backfills"].changes_data, "an UPDATE held in a constant")

    def test_a_statement_word_in_a_comment_is_not_a_statement(self):
        write_migration(self.dir, "20260101000000_Commented",
                        up='// UPDATE nothing here; RAISE EXCEPTION is only mentioned\n'
                           '        /* DELETE FROM bookings would be wrong */\n'
                           '        migrationBuilder.AddColumn<int>(name: "x", table: "y");')
        migration = self.known()["20260101000000_Commented"]
        self.assertFalse(migration.changes_data or migration.can_refuse)

    def test_a_helper_after_down_still_counts_but_downs_own_body_does_not(self):
        write_migration(self.dir, "20260101000000_DownOnly", up='migrationBuilder.AddColumn<int>(name: "x", table: "y");',
                        down='migrationBuilder.Sql(@"DELETE FROM y WHERE ""x"" = 1");')
        path = self.dir / "20260101000000_DownOnly.cs"
        path.write_text(path.read_text().rstrip().rstrip("}") +
                        '    private const string Later = "INSERT INTO audit VALUES (1)";\n}\n')
        self.assertTrue(self.known()["20260101000000_DownOnly"].changes_data,
                        "a constant declared after Down() is still reachable from Up()")
        write_migration(self.dir, "20260101000001_DownOnlyNoHelper", up='migrationBuilder.AddColumn<int>(name: "x", table: "y");',
                        down='migrationBuilder.Sql(@"DELETE FROM y WHERE ""x"" = 1");')
        self.assertFalse(self.known()["20260101000001_DownOnlyNoHelper"].changes_data)

    def test_the_id_comes_from_the_attribute_not_the_file_name(self):
        write_migration(self.dir, "20260101000000_RealId", file_stem="20260101000000_Renamed")
        self.assertEqual(list(self.known()), ["20260101000000_RealId"])

    def test_the_real_repository_lists_every_migration_once_in_order(self):
        known = pm.migrations_in_tree(REPO / pm.MIGRATIONS_DIR)
        ids = [m.id for m in known]
        designers = list((REPO / pm.MIGRATIONS_DIR).glob("*.Designer.cs"))
        self.assertEqual(len(ids), len(designers))
        self.assertEqual(ids, sorted(set(ids)))
        flagged = {m.id.split("_", 1)[1] for m in known if m.changes_data}
        self.assertIn("FindableByDefault", flagged, "the one that turns every 'not findable' choice back on")
        self.assertIn("MinutesReplaceCredits", {m.id.split("_", 1)[1] for m in known if m.can_refuse})


class ReportTests(unittest.TestCase):
    known = [pm.Migration("20260101000000_A", False, False), pm.Migration("20260102000000_B", True, False),
             pm.Migration("20260103000000_C", False, True)]

    def run_report(self, applied):
        out = io.StringIO()
        return pm.report(self.known, applied, out), out.getvalue()

    def test_an_empty_database_has_everything_pending_in_order(self):
        code, text = self.run_report([])
        self.assertEqual(code, pm.EXIT_PENDING)
        self.assertLess(text.index("_A"), text.index("_B"))
        self.assertIn("20260102000000_B  [CHANGES ROWS", text)
        self.assertIn("20260103000000_C  [CAN REFUSE", text)

    def test_a_partly_migrated_database_lists_only_the_rest(self):
        code, text = self.run_report(["20260101000000_A", "20260102000000_B"])
        self.assertEqual(code, pm.EXIT_PENDING)
        self.assertNotIn("20260101000000_A", text.split("pending", 1)[1])
        self.assertIn("1 pending", text)

    def test_an_up_to_date_database_says_so(self):
        code, text = self.run_report([m.id for m in self.known])
        self.assertEqual(code, pm.EXIT_UP_TO_DATE)
        self.assertIn("Nothing pending", text)

    def test_a_database_ahead_of_the_code_is_a_downgrade(self):
        code, text = self.run_report([m.id for m in self.known] + ["20991231000000_FromANewerImage"])
        self.assertEqual(code, pm.EXIT_DATABASE_AHEAD)
        self.assertIn("DATABASE IS AHEAD", text)
        self.assertIn("20991231000000_FromANewerImage", text)


class CommandLineTests(unittest.TestCase):
    def run_tool(self, *args, stdin=""):
        return subprocess.run(["python3", str(TOOL), *args], input=stdin, capture_output=True, text=True, cwd=REPO)

    def test_applied_list_from_stdin_against_the_working_tree(self):
        every = [m.id for m in pm.migrations_in_tree(REPO / pm.MIGRATIONS_DIR)]
        done = self.run_tool("--applied", "-", stdin="\n".join(every[:-2]) + "\n")
        self.assertEqual(done.returncode, pm.EXIT_PENDING, done.stderr)
        self.assertIn(every[-1], done.stdout)
        self.assertIn(every[-2], done.stdout)
        self.assertNotIn(every[-3], done.stdout.split("pending", 1)[1])

    def test_at_a_git_ref_the_list_is_that_commits(self):
        if shutil.which("git") is None:
            self.skipTest("git")
        head = subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        at_head = pm.migrations_at_ref(REPO, head)
        self.assertTrue(at_head)
        done = self.run_tool("--ref", head, "--applied", "-", stdin="\n".join(m.id for m in at_head))
        self.assertEqual(done.returncode, pm.EXIT_UP_TO_DATE, done.stdout + done.stderr)

    def test_an_unreachable_database_is_a_usage_error_not_a_pass(self):
        done = self.run_tool("--psql", "false")
        self.assertEqual(done.returncode, pm.EXIT_USAGE)
        self.assertIn("psql failed", done.stderr)


if __name__ == "__main__":
    unittest.main()

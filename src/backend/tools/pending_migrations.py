#!/usr/bin/env python3
"""Which EF Core migrations would a redeploy apply to THIS database? Answer it before the redeploy.

The production backend migrates itself on start (Database__AutoMigrateOnStartup), forward-only, and
a migration that refuses or crash-loops takes the club's booking system down with it — the
2026-10-06 Pi redeploy crash-looped on MinutesReplaceCredits, and a failed Portainer update then
discards the stack edits. So the list of what is about to run is read first, against the real
database, from the migrations of the exact commit being deployed:

    # on a laptop with the repository; the database is reached through the Pi's postgres container
    python3 src/backend/tools/pending_migrations.py --ref <commit being deployed> \\
        --psql "ssh <pi> docker exec -i <stack>-postgres-1 psql -U crusaders -d crusaders_mainframe"

    make migrations-pending REF=<commit> PSQL="ssh <pi> docker exec -i ... psql -U crusaders -d crusaders_mainframe"

`--psql` is any command that runs psql against the target; the SQL goes to it on stdin, so it
survives ssh's argument re-quoting. `--applied FILE` (one MigrationId per line, `-` for stdin) is
the same check from a list somebody already pulled.

Every pending migration is listed in the order it will run, flagged when its Up() runs SQL that
changes rows (UPDATE / DELETE / INSERT, or EF's UpdateData / DeleteData / InsertData) or can refuse
(RAISE EXCEPTION). Those are the ones to read before deploying: FindableByDefault, for one, turns
every member's "not findable" choice back on.

Exit status: 0 nothing pending · 3 migrations pending (the normal case before a redeploy) ·
4 the database has migrations this commit does not know — it was migrated by a NEWER image, so
deploying this one is a downgrade the forward-only migrations cannot undo · 2 usage or connection
error.
"""

from __future__ import annotations

import argparse
import re
import shlex
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

MIGRATIONS_DIR = "src/backend/Crusaders.Mainframe.Api/Migrations"
HISTORY_TABLE = "__EFMigrationsHistory"
MIGRATION_ATTR = re.compile(r'\[Migration\("(?P<id>[^"]+)"\)\]')
DATA_SQL = re.compile(r"\b(UPDATE|DELETE\s+FROM|INSERT\s+INTO)\b", re.IGNORECASE)
DATA_API = re.compile(r"\b(UpdateData|DeleteData|InsertData)\s*\(")
REFUSAL = re.compile(r"RAISE\s+EXCEPTION", re.IGNORECASE)

EXIT_UP_TO_DATE = 0
EXIT_USAGE = 2
EXIT_PENDING = 3
EXIT_DATABASE_AHEAD = 4


@dataclass(frozen=True)
class Migration:
    id: str
    changes_data: bool
    can_refuse: bool

    def flags(self) -> str:
        notes = []
        if self.changes_data:
            notes.append("CHANGES ROWS")
        if self.can_refuse:
            notes.append("CAN REFUSE")
        return f"  [{', '.join(notes)} - read it before deploying]" if notes else ""


def _strip_method(source: str, signature: str) -> str:
    """`source` without the body of the method whose declaration contains `signature`."""
    at = source.find(signature)
    if at < 0:
        return source
    open_brace = source.find("{", at)
    if open_brace < 0:
        return source
    depth = 0
    for index, token, _ in _tokens(source[open_brace:]):
        if token == "{":
            depth += 1
        elif token == "}":
            depth -= 1
            if depth == 0:
                return source[:at] + source[open_brace + index + 1:]
    return source[:at]


def _tokens(source: str):
    """(offset, kind, text) for C#: kind is "string", "comment", "{", "}" or "code" (one char).

    Enough of the lexer to tell SQL in a string literal from a word in a comment or a column
    name: regular, verbatim (@"" with "" escapes), interpolated ($"", $@"", @$"") and raw
    (\"\"\"...\"\"\", any number of quotes, optionally $-prefixed) strings, char literals, and
    // and /* */ comments.
    """
    i, n = 0, len(source)
    while i < n:
        c = source[i]
        if source.startswith("//", i):
            end = source.find("\n", i)
            end = n if end < 0 else end
            yield i, "comment", source[i:end]
            i = end
            continue
        if source.startswith("/*", i):
            end = source.find("*/", i + 2)
            end = n if end < 0 else end + 2
            yield i, "comment", source[i:end]
            i = end
            continue
        j = i
        while j < n and source[j] in "$@":
            j += 1
        if j < n and source[j] == '"' and j - i <= 3:
            prefix = source[i:j]
            quotes = 0
            while j + quotes < n and source[j + quotes] == '"':
                quotes += 1
            if quotes >= 3:  # raw string literal: closes on the same run of quotes
                end = source.find('"' * quotes, j + quotes)
                end = n if end < 0 else end + quotes
            elif "@" in prefix:  # verbatim: "" is an escaped quote
                k = j + 1
                while k < n:
                    if source[k] == '"':
                        if k + 1 < n and source[k + 1] == '"':
                            k += 2
                            continue
                        break
                    k += 1
                end = min(k + 1, n)
            else:  # regular or interpolated: backslash escapes
                k = j + 1
                while k < n and source[k] != '"':
                    k += 2 if source[k] == "\\" else 1
                end = min(k + 1, n)
            yield i, "string", source[i:end]
            i = end
            continue
        if c == "'":
            k = i + 1
            while k < n and source[k] != "'":
                k += 2 if source[k] == "\\" else 1
            yield i, "code", source[i:k + 1]
            i = k + 1
            continue
        yield i, (c if c in "{}" else "code"), c
        i += 1


def _classify(migration_id: str, source: str) -> Migration:
    """Flags from everything a redeploy can run: the whole file except Down().

    Not just Up(): SQL is often built by a helper method or held in a constant beside it
    (MinutesReplaceCredits raises from a `Refusal(...)` helper), and a classifier that read only
    the Sql("...") calls inside Up() missed exactly the migration that crash-looped a redeploy.
    A helper used only by Down() is flagged too — a false alarm costs a read, a miss costs the club.
    """
    runs = _strip_method(source, "override void Down")
    strings = []
    code = []
    for _, kind, text in _tokens(runs):
        if kind == "string":
            strings.append(text)
        elif kind != "comment":
            code.append(text)
    sql = "\n".join(strings)
    return Migration(
        id=migration_id,
        changes_data=bool(DATA_SQL.search(sql) or DATA_API.search("".join(code))),
        can_refuse=bool(REFUSAL.search(sql)),
    )


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout


def migrations_in_tree(migrations_dir: Path) -> list[Migration]:
    """Every migration in a working-tree directory, ordered as EF orders them (by id)."""
    found = []
    for designer in sorted(migrations_dir.glob("*.Designer.cs")):
        match = MIGRATION_ATTR.search(designer.read_text(encoding="utf-8"))
        if not match:
            continue
        body = designer.with_name(designer.name.replace(".Designer.cs", ".cs"))
        found.append(_classify(match["id"], body.read_text(encoding="utf-8") if body.exists() else ""))
    return sorted(found, key=lambda m: m.id)


def migrations_at_ref(repo: Path, ref: str, migrations_dir: str = MIGRATIONS_DIR) -> list[Migration]:
    """The same list as the commit `ref` has it — the image being deployed, not the checkout."""
    names = _git(repo, "ls-tree", "-r", "--name-only", ref, "--", migrations_dir).splitlines()
    found = []
    for path in names:
        if not path.endswith(".Designer.cs"):
            continue
        match = MIGRATION_ATTR.search(_git(repo, "show", f"{ref}:{path}"))
        if not match:
            continue
        body_path = path.replace(".Designer.cs", ".cs")
        body = _git(repo, "show", f"{ref}:{body_path}") if body_path in names else ""
        found.append(_classify(match["id"], body))
    return sorted(found, key=lambda m: m.id)


def _psql(command: str, sql: str) -> str:
    argv = shlex.split(command) + ["-At", "-v", "ON_ERROR_STOP=1"]
    done = subprocess.run(argv, input=sql, capture_output=True, text=True)
    if done.returncode != 0:
        raise RuntimeError(f"psql failed ({done.returncode}): {done.stderr.strip()}")
    return done.stdout


def applied_from_database(command: str) -> list[str]:
    """MigrationIds recorded in the target database. A database with no history table has none."""
    exists = _psql(command, f"select to_regclass('public.\"{HISTORY_TABLE}\"') is not null;\n").strip()
    if exists != "t":
        return []
    rows = _psql(command, f'select "MigrationId" from "{HISTORY_TABLE}" order by 1;\n')
    return [line.strip() for line in rows.splitlines() if line.strip()]


def applied_from_file(path: str) -> list[str]:
    text = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
    return [line.strip() for line in text.splitlines() if line.strip() and not line.startswith("#")]


def report(known: list[Migration], applied: list[str], out=sys.stdout) -> int:
    known_ids = {m.id for m in known}
    applied_ids = set(applied)
    pending = [m for m in known if m.id not in applied_ids]
    unknown = sorted(applied_ids - known_ids)

    print(f"{len(known)} migrations in the code, {len(applied_ids)} applied to the database.", file=out)
    if unknown:
        print(f"\nThe DATABASE IS AHEAD: {len(unknown)} applied migration(s) this commit does not have.", file=out)
        print("It was migrated by a newer image. Deploying this one is a downgrade that forward-only", file=out)
        print("migrations cannot undo - restore the pre-upgrade backup instead (docs/runbooks/).", file=out)
        for migration_id in unknown:
            print(f"  {migration_id}", file=out)
    if pending:
        print(f"\n{len(pending)} pending, in the order the backend will apply them on start:", file=out)
        for migration in pending:
            print(f"  {migration.id}{migration.flags()}", file=out)
    elif not unknown:
        print("Nothing pending: the database is at this commit's newest migration.", file=out)

    if unknown:
        return EXIT_DATABASE_AHEAD
    return EXIT_PENDING if pending else EXIT_UP_TO_DATE


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--psql", help="command that runs psql against the target database (SQL arrives on stdin)")
    source.add_argument("--applied", help="file of applied MigrationIds, one per line; '-' reads stdin")
    parser.add_argument("--ref", help="git ref whose migrations are being deployed (default: the working tree)")
    parser.add_argument("--repo", default=str(Path(__file__).resolve().parents[3]), help=argparse.SUPPRESS)
    parser.add_argument("--migrations-dir", default=None, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    repo = Path(args.repo)
    try:
        if args.ref:
            known = migrations_at_ref(repo, args.ref, args.migrations_dir or MIGRATIONS_DIR)
        else:
            known = migrations_in_tree(Path(args.migrations_dir) if args.migrations_dir else repo / MIGRATIONS_DIR)
        if not known:
            print("no migrations found - wrong --ref or directory?", file=sys.stderr)
            return EXIT_USAGE
        applied = applied_from_database(args.psql) if args.psql else applied_from_file(args.applied)
    except (subprocess.CalledProcessError, RuntimeError, OSError) as error:
        detail = getattr(error, "stderr", None) or error
        print(f"pending_migrations: {str(detail).strip()}", file=sys.stderr)
        return EXIT_USAGE
    return report(known, applied)


if __name__ == "__main__":
    sys.exit(main())

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The two promises about <c>admin_change_log</c> that no runtime test can make, because they
/// are promises about code that does not exist.
///
/// <para>
/// <b>A posture test and a database trigger catch different things, and both are needed.</b> A
/// trigger cannot see a code review; a grep cannot see a hand-run <c>DELETE</c> against the
/// club's database. The triggers are pinned in <see cref="ApiBoundaryTests"/>; these two pin
/// the application side, so a future session that adds a delete path finds out here rather than
/// from a club that discovers its own records are gone.
/// </para>
///
/// <para>
/// Same shape as <c>RepositoryPostureTests</c> and <c>DeploymentPostureTests</c>: walk up to the
/// repository root and read the shipped sources rather than copies.
/// </para>
/// </summary>
public sealed class AdminChangeLogPostureTests
{
    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "whitelizard.txt"))
                && Directory.Exists(Path.Combine(dir.FullName, "docs")))
            {
                return dir.FullName;
            }
            dir = dir.Parent;
        }
        throw new DirectoryNotFoundException(
            "The repository root was not found above the test binary. This test reads the " +
            "shipped backend sources in place.");
    }

    private static IEnumerable<(string Path, string Text)> BackendSources()
    {
        var root = Path.Combine(RepoRoot(), "src", "backend", "Crusaders.Mainframe.Api");
        foreach (var file in Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories))
        {
            yield return (Path.GetRelativePath(root, file), File.ReadAllText(file));
        }
    }

    /// <summary>
    /// Nothing anywhere in the API removes an <see cref="Api.Domain.AdminChangeLog"/> row.
    ///
    /// <para>
    /// <b>The claim this table supports is "no role in the application can delete these rows".</b>
    /// One <c>RemoveRange</c> written in good faith — a cleanup, a tenant offboarding, a future
    /// retention feature — makes that sentence false everywhere it is printed, including on the
    /// admin screen that says "Nobody can delete these from the app, including admins."
    /// </para>
    /// </summary>
    [Theory]
    [InlineData("AdminChangeLogs.Remove")]
    [InlineData("AdminChangeLogs.RemoveRange")]
    [InlineData("AdminChangeLogs.ExecuteDelete")]
    [InlineData("AdminChangeLogs.ExecuteDeleteAsync")]
    [InlineData("Set<AdminChangeLog>().Remove")]
    [InlineData("DELETE FROM admin_change_log")]
    [InlineData("TRUNCATE admin_change_log")]
    public void No_code_path_deletes_an_admin_change_row(string forbidden)
    {
        var offenders = BackendSources()
            .Where(f => !f.Path.Contains("Migrations", StringComparison.Ordinal))
            .Where(f => f.Text.Contains(forbidden, StringComparison.Ordinal))
            .Select(f => f.Path)
            .ToList();

        Assert.True(
            offenders.Count == 0,
            $"`{forbidden}` appears in: {string.Join(", ", offenders)}. admin_change_log is " +
            "append-only — the club's own screen says nobody can delete these, including admins.");
    }

    /// <summary>
    /// The retention worker does not name this table, and a future retention feature cannot
    /// quietly acquire it.
    ///
    /// <para>
    /// This is the precise conflict that made the table separate from <c>audit_log</c> in the
    /// first place: <c>RetentionWorker</c> <c>RemoveRange</c>s door rows on a cutoff an admin
    /// controls through <c>door_log_retention_days</c>, and a record no role can delete cannot
    /// live in a table a worker deletes from on an admin-editable schedule.
    /// </para>
    /// </summary>
    [Fact]
    public void The_retention_worker_never_names_the_admin_change_log()
    {
        var worker = BackendSources().Single(f => f.Path.EndsWith("RetentionWorker.cs", StringComparison.Ordinal));

        Assert.DoesNotContain("AdminChangeLog", worker.Text, StringComparison.Ordinal);
        Assert.DoesNotContain("admin_change_log", worker.Text, StringComparison.Ordinal);
    }

    /// <summary>
    /// The immutability triggers are in a migration, not in a comment.
    ///
    /// <para>
    /// A promise about a table that exists only in prose is one a fresh deployment does not
    /// have. This asserts the shipped migration carries both triggers and the function, and
    /// that the function raises rather than silently doing nothing — <c>CREATE RULE … DO
    /// INSTEAD NOTHING</c> was the rejected alternative precisely because it makes a
    /// <c>DELETE</c> report zero rows and succeed.
    /// </para>
    /// </summary>
    [Fact]
    public void The_immutability_triggers_ship_as_a_migration()
    {
        // Doc comments stripped first, because this file's own prose NAMES the rejected
        // alternative in order to explain why it was rejected — and a posture test that
        // cannot tell an explanation from an implementation is a test that forbids writing
        // the explanation down.
        var migration = string.Join('\n', BackendSources()
            .Single(f => f.Path.EndsWith("_ProtectAdminChangeLog.cs", StringComparison.Ordinal))
            .Text
            .Split('\n')
            .Where(l => !l.TrimStart().StartsWith("///", StringComparison.Ordinal))
            .Where(l => !l.TrimStart().StartsWith("//", StringComparison.Ordinal)));

        Assert.Contains("CREATE OR REPLACE FUNCTION admin_change_log_immutable()", migration, StringComparison.Ordinal);
        Assert.Contains("RAISE EXCEPTION", migration, StringComparison.Ordinal);
        Assert.Contains("42501", migration, StringComparison.Ordinal);
        Assert.Contains("BEFORE DELETE OR UPDATE ON admin_change_log", migration, StringComparison.Ordinal);
        Assert.Contains("BEFORE TRUNCATE ON admin_change_log", migration, StringComparison.Ordinal);
        Assert.Contains("FOR EACH STATEMENT", migration, StringComparison.Ordinal);
        Assert.DoesNotContain("DO INSTEAD NOTHING", migration, StringComparison.Ordinal);
        Assert.DoesNotContain("CREATE RULE", migration, StringComparison.Ordinal);
    }
}

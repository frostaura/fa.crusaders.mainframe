using System.Text.RegularExpressions;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 9, X9-4 — the server's half of the spoken-minutes rule
/// (<c>memory/decisions-minutes-words.md</c>): a duration inside words is said long form. The
/// admin's Recent alerts read "Court box back online — box-…, after 6 min", which a screen reader
/// speaks as "6 min"; the frontend's guard scans its copy modules, and nothing scanned the
/// headlines, ledger lines and mail the server writes.
/// </summary>
public sealed class SpokenUnitsTests
{
    /// <summary>A number (or an interpolation) followed by a compact unit, as prose would carry it.</summary>
    private static readonly Regex CompactInText = new(@"\b\d+\s?(min|mins|h|hr|hrs|d)\b", RegexOptions.CultureInvariant);

    private static readonly Regex CompactInSource = new(@"\{[^{}\s][^{}]*\}\s?(min|mins|h|hr|hrs|d)\b", RegexOptions.CultureInvariant);

    [Theory]
    [InlineData(6, "after 6 minutes")]
    [InlineData(64, "after 1 hour 4 minutes")]
    [InlineData(1, "after 1 minute")]
    public void A_board_back_online_says_how_long_in_words(int minutes, string expected)
    {
        var box = new Device { DeviceCode = "box-a1b2c3", Name = "Box", Kind = DeviceKind.CourtBox, MacAddress = "a1b2c3d4e5f6", CourtNumbers = [1] };
        var notice = AdminNotices.DeviceOutage(Guid.NewGuid(), box, minutes, recovered: true);
        Assert.Equal($"Court box back online — box-a1b2c3, {expected}", notice.Headline);
    }

    [Fact]
    public void One_application_waiting_an_hour_is_one_hour()
    {
        var notice = AdminNotices.ApplicationsPending(new DateOnly(2026, 10, 3), 1, "Ada", 1);
        Assert.DoesNotContain("1 hours", notice.Headline, StringComparison.Ordinal);
        Assert.Contains("1 hour", notice.Headline, StringComparison.Ordinal);
    }

    /// <summary>Every message the product can send: no compact unit in its subject, preheader or either body.</summary>
    [Fact]
    public void No_message_says_a_duration_in_compact_units()
    {
        var offenders = EmailCatalogue.All(EmailCatalogue.Riverside)
            .SelectMany(m => new[] { m.Message.Subject, m.Message.PlainBody ?? "", m.Message.HtmlBody }
                .SelectMany(text => CompactInText.Matches(text).Select(x => $"{m.Name}: \"{x.Value}\"")))
            .Distinct().ToList();
        Assert.True(offenders.Count == 0, string.Join(Environment.NewLine, offenders));
    }

    /// <summary>
    /// The source: no interpolation followed by a compact unit in a server-built string — the
    /// "{minutes} min" shape a review found in a headline, two alert facts and two ledger lines.
    /// Comments are skipped, and so is <c>MoneyFormat</c>, which defines the compact form for the
    /// one figure that needs it (the PayFast item name).
    /// </summary>
    [Fact]
    public void No_server_string_interpolates_a_compact_unit()
    {
        var root = ApiSourceRoot();
        var offenders = new List<string>();
        foreach (var file in Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(root, file);
            if (rel.StartsWith("obj", StringComparison.Ordinal) || rel.StartsWith("bin", StringComparison.Ordinal)
                || rel.StartsWith("Migrations", StringComparison.Ordinal) || rel.EndsWith("MoneyFormat.cs", StringComparison.Ordinal))
            {
                continue;
            }
            var lines = File.ReadAllLines(file);
            for (var i = 0; i < lines.Length; i++)
            {
                var line = lines[i].TrimStart();
                if (line.StartsWith("//", StringComparison.Ordinal)) continue;
                if (CompactInSource.IsMatch(line)) offenders.Add($"{rel}:{i + 1}: {line}");
            }
        }
        Assert.True(offenders.Count == 0, string.Join(Environment.NewLine, offenders));
    }

    private static string ApiSourceRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "Crusaders.Mainframe.Api");
            if (Directory.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }
        throw new DirectoryNotFoundException("The API project was not found above the test binary.");
    }
}

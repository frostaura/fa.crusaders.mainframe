using System.Text.RegularExpressions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// P13 invariant 10 (<c>docs/specs/minutes-and-packages.md</c> §1.3): the club sells court TIME,
/// so no code in the API says "credit" outside the §2.5 allow-list. Comments are prose and are not
/// scanned; EF migrations are history and are not scanned. The frontend half is
/// <c>src/frontend/src/credit-scan.test.ts</c>.
/// </summary>
public sealed class MinutesSourceScanTests
{
    /// <summary>Each stays for the reason §2.5 gives.</summary>
    private static readonly Regex[] Allowed =
    [
        new(@"""credit\.(?:adjusted|topped_up)""", RegexOptions.None),   // stored change-record / audit codes
        new(@"""credit""", RegexOptions.None),                          // the stored change-record area code
        new(@"/api/v1/credit/topup/callback", RegexOptions.None),        // PayFast's notify_url, external
        new(@"\bAdminCreditReasons\b", RegexOptions.None),               // a class name only (§2.5)
        new(@"\b(?:slice_price_credits|credits_per_zar_regular|credits_per_zar_league|SlicePriceCredits|CreditsPerZarRegular|CreditsPerZarLeague)\b",
            RegexOptions.None),                                          // retired settings keys, bound and ignored
    ];

    private static readonly Regex BlockComment = new(@"/\*[\s\S]*?\*/", RegexOptions.Compiled);
    private static readonly Regex LineComment = new(@"(^|[^:""])//.*$", RegexOptions.Compiled | RegexOptions.Multiline);

    private static string ApiRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "whitelizard.txt"))) dir = dir.Parent;
        return dir is null
            ? throw new DirectoryNotFoundException("The repository root was not found above the test binary.")
            : Path.Combine(dir.FullName, "src", "backend", "Crusaders.Mainframe.Api");
    }

    [Fact]
    public void No_api_code_says_credit_outside_the_allow_list()
    {
        var root = ApiRoot();
        var sep = Path.DirectorySeparatorChar;
        var hits = new List<string>();
        foreach (var file in Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(root, file);
            if (rel.StartsWith("Migrations" + sep, StringComparison.Ordinal)
                || rel.StartsWith("bin" + sep, StringComparison.Ordinal)
                || rel.StartsWith("obj" + sep, StringComparison.Ordinal)) continue;

            var code = LineComment.Replace(BlockComment.Replace(File.ReadAllText(file), ""), "$1");
            code = Allowed.Aggregate(code, (c, token) => token.Replace(c, ""));
            var lines = code.Split('\n');
            for (var i = 0; i < lines.Length; i++)
            {
                if (lines[i].Contains("credit", StringComparison.OrdinalIgnoreCase)) hits.Add($"{rel}:{i + 1}: {lines[i].Trim()}");
            }
        }

        Assert.True(hits.Count == 0, "say it in minutes, or argue it onto §2.5 first:\n" + string.Join("\n", hits));
    }
}

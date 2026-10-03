using System.Text.RegularExpressions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The shipped files that are not code and are not tested by anything else: the ignore rules,
/// the complexity ratchet, and the two founder-facing HTML pages.
/// </summary>
/// <remarks>
/// <para>
/// These exist because each of them has already gone wrong silently. A session that believed
/// it had cleaned up left a Playwright <c>test-results/</c> directory inside the tree. A
/// tidy-up deleted one of two <c>whitelizard.txt</c> entries as redundant and turned the
/// complexity gate red on a file nobody had edited. And <c>docs/system-blueprint.html</c> —
/// the page the founder actually reads — has now been wrong about the webhook catalogue in
/// both directions: once claiming events that had no emitter, and once, in the correction,
/// asserting that events which DO have emitters are "emitted by no code path".
/// </para>
/// <para>
/// A document is not covered by the suite that covers the code it describes. That is the whole
/// argument for this file: the drift is invisible to every other gate, it is read by the person
/// least able to check it, and it is cheap to catch here.
/// </para>
/// <para>
/// Same shape as <see cref="DeploymentPostureTests"/>: walk up to the repository root and read
/// the shipped files rather than copies, because a copy is a second thing to keep in step.
/// </para>
/// </remarks>
public sealed class RepositoryPostureTests
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
            "The repository root was not found above the test binary. These tests read the " +
            "shipped ignore rules, complexity ratchet and founder-facing pages in place.");
    }

    private static string Read(params string[] parts) => File.ReadAllText(Path.Combine(RepoRoot(), Path.Combine(parts)));

    // ---------------------------------------------------------------- run residue

    /// <summary>
    /// Every directory a browser-driving round drops inside the tree is ignored.
    ///
    /// <para>
    /// <c>test-results/</c> is Playwright's default output directory and was the one actually
    /// left behind; the other three are the same class of artefact from the same kind of
    /// session, and three of the six were not covered until this test was written. The rule
    /// being asserted is that none of these is ever a deliberate commit, so an ignore entry
    /// costs nothing and its absence costs a polluted diff at the worst moment.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData("test-results/")]        // Playwright outputDir — traces, videos, .last-run.json
    [InlineData("playwright-report/")]   // Playwright HTML reporter
    [InlineData("blob-report/")]         // Playwright blob reporter, sharded CI
    [InlineData(".playwright-mcp/")]     // screenshots an agent takes driving the app over MCP
    [InlineData(".tmp/")]                // the tree-wide scratch directory
    [InlineData(".claude/worktrees/")]   // agent worktrees checked out inside this checkout
    public void The_ignore_rules_cover_every_directory_a_headed_round_leaves_behind(string pattern)
    {
        var entries = Read(".gitignore")
            .Split('\n')
            .Select(l => l.Trim())
            .Where(l => l.Length > 0 && !l.StartsWith('#'))
            .ToHashSet(StringComparer.Ordinal);

        Assert.True(
            entries.Contains(pattern),
            $".gitignore does not ignore `{pattern}`. It is run residue, never source: a headed " +
            "browser round or an agent worktree creates it inside the tree, and without the entry " +
            "it lands in `git status` and eventually in a commit.");
    }

    // ---------------------------------------------------------------- complexity ratchet

    /// <summary>
    /// Both of lizard's names for <c>MapTopUpEndpoints</c> stay in the ratchet.
    ///
    /// <para>
    /// lizard's C# parser scopes a method under the most recently DECLARED type, so the same
    /// function is reported as <c>TopUpEndpoints::MapTopUpEndpoints</c> or as
    /// <c>FailureCodes::MapTopUpEndpoints</c> depending on which side of the nested
    /// <c>FailureCodes</c> class it sits. Only one matches at a time, which makes the other
    /// look like dead weight — and deleting it restores exactly the failure the pair exists to
    /// prevent: one round moves the class, another edits the entry, each is green alone and
    /// the merge is red on a file nobody touched. That is not hypothetical; it happened.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData("TopUpEndpoints::MapTopUpEndpoints")]
    [InlineData("FailureCodes::MapTopUpEndpoints")]
    public void Both_lizard_scopings_of_the_top_up_map_method_stay_whitelisted(string name)
    {
        var lines = Read("whitelizard.txt")
            .Split('\n')
            .Select(l => l.Split('#')[0].Trim())
            .Where(l => l.Length > 0)
            .ToHashSet(StringComparer.Ordinal);

        Assert.True(
            lines.Contains(name),
            $"whitelizard.txt no longer lists `{name}`. Both scopings of MapTopUpEndpoints have to " +
            "stay: whichever one is not matching today is the one that catches the next time the " +
            "nested FailureCodes class moves relative to the map method.");
    }

    // ---------------------------------------------------------------- webhook catalogue

    /// <summary>
    /// Everything the bus emits, read off the emitters.
    ///
    /// <para>
    /// A heuristic, and deliberately a narrow one: the type is a literal at the
    /// <c>EmitAsync</c> call site for most producers, but three of them pass it in
    /// (<c>LedgerService</c> maps a ledger entry type through a switch,
    /// <c>MemberApprovalService</c> and <c>PeripheralHealthWorker</c> both funnel through a
    /// private helper), so the window is the enclosing method rather than the call itself.
    /// <c>Action = "…"</c> is excluded because an audit action uses the same
    /// <c>family.verb</c> shape and sits in the same methods — <c>court.activated</c> is one,
    /// and it is not an event.
    /// </para>
    /// <para>
    /// A type may also be named through a constant of an <c>*Events</c> class
    /// (<c>MinutesEvents.Purchased</c>, P13 §5) — declared once so an emitter cannot misspell it.
    /// Such a reference inside the window counts as the constant's value. Only <c>*Events</c>
    /// classes are resolved: <c>AdminChangeActions</c> and the notice catalogue hold the same
    /// <c>family.verb</c> shape for things that are not webhook events.
    /// </para>
    /// <para>
    /// If this ever mis-reads the tree the failure is loud and names what it found, which is
    /// the right failure mode for a heuristic. What it must never do is quietly agree.
    /// </para>
    /// </summary>
    private static HashSet<string> EmittedEventTypes()
    {
        var literal = new Regex(@"(?<!Action = )(?<!Action: )""(?<type>[a-z][a-z_]*\.[a-z][a-z_]*)""");
        var constant = new Regex(@"\b(?<cls>[A-Z]\w*Events)\.(?<name>[A-Z]\w*)\b");
        var starters = new[] { "\n    private ", "\n    public ", "\n    internal ", "\n    protected " };
        var types = new HashSet<string>(StringComparer.Ordinal);

        var api = Path.Combine(RepoRoot(), "src", "backend", "Crusaders.Mainframe.Api");
        var files = Directory.EnumerateFiles(api, "*.cs", SearchOption.AllDirectories).ToList();
        var named = EventConstants(files);
        foreach (var file in files)
        {
            var source = File.ReadAllText(file);
            foreach (Match call in Regex.Matches(source, @"EmitAsync\("))
            {
                var head = starters.Max(s => source.LastIndexOf(s, call.Index, StringComparison.Ordinal));
                var start = head > 0 ? head : Math.Max(0, call.Index - 1200);
                var end = Math.Min(source.Length, call.Index + 700);
                // *Events constants count from the emitting method AND every same-file helper it calls
                // (one level): LedgerService picks the minutes.* name in MirrorTypeOf, outside
                // MirrorAsync, and the six names it chooses read as never emitted (round 6, E6-11).
                // Literals only from the method itself: a helper's strings include audit actions.
                var own = source[start..end];
                foreach (Match hit in literal.Matches(own))
                {
                    types.Add(hit.Groups["type"].Value);
                }
                foreach (Match hit in constant.Matches(own + HelpersCalledIn(source, own, starters)))
                {
                    var key = $"{hit.Groups["cls"].Value}.{hit.Groups["name"].Value}";
                    Assert.True(named.TryGetValue(key, out var type) || hit.Groups["name"].Value == "All",
                        $"{Path.GetFileName(file)} emits {key}, which no *Events class declares as a constant.");
                    if (type is not null) types.Add(type);
                }
            }
        }
        return types;
    }

    /// <summary>
    /// The bodies of the same-file methods that <paramref name="window"/> calls, so an event name
    /// chosen in a helper (a switch on the row's type) counts as emitted by the method that emits it.
    /// </summary>
    private static string HelpersCalledIn(string source, string window, string[] starters)
    {
        var bodies = new System.Text.StringBuilder();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (Match call in Regex.Matches(window, @"\b(?<m>[A-Z]\w*)\("))
        {
            var name = call.Groups["m"].Value;
            if (!seen.Add(name)) continue;
            var decl = Regex.Match(source, $@"\n    (?:private|public|internal|protected)[^\n(]*\b{name}\(");
            if (!decl.Success) continue;
            var next = starters.Select(s => source.IndexOf(s, decl.Index + 1, StringComparison.Ordinal)).Where(i => i > 0).DefaultIfEmpty(source.Length).Min();
            bodies.Append(source[decl.Index..next]);
        }
        return bodies.ToString();
    }

    /// <summary><c>Class.Name</c> → value, for every <c>const string</c> event name in a <c>static class *Events</c>.</summary>
    private static Dictionary<string, string> EventConstants(IEnumerable<string> files)
    {
        var named = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var file in files)
        {
            var source = File.ReadAllText(file);
            foreach (Match cls in Regex.Matches(source, @"static class (?<cls>[A-Z]\w*Events)\b"))
            {
                foreach (Match c in Regex.Matches(source[cls.Index..], @"const string (?<name>[A-Z]\w*) = ""(?<type>[a-z][a-z_]*\.[a-z][a-z_]*)"";"))
                {
                    named[$"{cls.Groups["cls"].Value}.{c.Groups["name"].Value}"] = c.Groups["type"].Value;
                }
            }
        }
        return named;
    }

    /// <summary>Every event name the admin console offers in its subscription picker.</summary>
    private static HashSet<string> PickerEventTypes()
    {
        var source = Read("src", "frontend", "src", "pages", "AdminWebhooks.tsx");
        return Regex.Matches(source, @"name:\s*""(?<type>[a-z][a-z_]*\.[a-z][a-z_]*)""")
            .Select(m => m.Groups["type"].Value)
            .ToHashSet(StringComparer.Ordinal);
    }

    /// <summary>Every event name printed in the blueprint's own "Event catalogue" table.</summary>
    private static HashSet<string> BlueprintCatalogueTypes()
    {
        var page = Read("docs", "system-blueprint.html");
        var start = page.IndexOf("Event catalogue", StringComparison.Ordinal);
        Assert.True(start >= 0, "docs/system-blueprint.html no longer has an \"Event catalogue\" heading.");
        var end = page.IndexOf("</table>", start, StringComparison.Ordinal);
        Assert.True(end > start, "The blueprint's event catalogue heading is no longer followed by a table.");

        return Regex.Matches(page[start..end], @"(?<type>[a-z][a-z_]*\.[a-z][a-z_]*)")
            .Select(m => m.Groups["type"].Value)
            .ToHashSet(StringComparer.Ordinal);
    }

    /// <summary>
    /// The picker and the emitters are the same set — not the same count.
    ///
    /// <para>
    /// Both directions are real defects with different symptoms. An event offered here that
    /// nothing fires is a filter an admin selects and then waits on forever; an event fired
    /// that the picker never lists cannot be discovered or templated against at all. Nine
    /// classes were missing from the picker at once, including the whole member lifecycle.
    /// </para>
    /// </summary>
    [Fact]
    public void The_admin_picker_offers_exactly_the_events_the_api_emits()
    {
        var emitted = EmittedEventTypes();
        var offered = PickerEventTypes();

        Assert.True(emitted.Count > 0, "No emitted event types were found at all — the reader is broken, not the tree.");
        Assert.Equal(emitted.OrderBy(t => t, StringComparer.Ordinal), offered.OrderBy(t => t, StringComparer.Ordinal));
    }

    /// <summary>
    /// The founder-facing blueprint lists exactly those events too.
    ///
    /// <para>
    /// This is the one that has actually been wrong. The page has claimed eighteen types
    /// including several with no emitter, and then — correcting itself — claimed eleven and
    /// asserted that <c>member.*</c>, <c>credit.refunded</c> and <c>peripheral.unhealthy</c>
    /// were "emitted by no code path" while all three were being emitted. A count in prose
    /// cannot be checked by anything; a table can be.
    /// </para>
    /// </summary>
    [Fact]
    public void The_blueprints_event_catalogue_lists_exactly_the_events_the_api_emits()
    {
        var emitted = EmittedEventTypes();
        var printed = BlueprintCatalogueTypes();

        Assert.Equal(emitted.OrderBy(t => t, StringComparer.Ordinal), printed.OrderBy(t => t, StringComparer.Ordinal));
    }

    // ---------------------------------------------------------------- retracted claims

    /// <summary>
    /// Sentences the founder-facing pages carried, that the code refutes, and that must not
    /// come back.
    ///
    /// <para>
    /// Each of these was checked against the tree and found false rather than merely stale, so
    /// a plain "this string must not appear" is the right guard — the same shape as
    /// <see cref="DeploymentPostureTests"/> asserting a gateway directive is gone. They are
    /// listed with the fact that kills them, because a bare blacklist teaches nobody anything.
    /// </para>
    /// </summary>
    [Theory]
    // `EventQueue` reserves 64 sequence numbers per checkpoint and `begin()` resumes at
    // mark + 1, past the whole block — so EVERY reboot manufactures a gap of up to 63 whether
    // or not an event was lost, and a gap cannot evidence a lost queue.
    [InlineData("system-blueprint.html", "so a gap after a reconnect is derivable")]
    // `member.*`, `credit.refunded` and `peripheral.unhealthy` all have emitters.
    [InlineData("system-blueprint.html", "none of those is emitted by any code path")]
    // `DeviceRosterBuilder.BuildAsync` selects Booked bookings checked in or not, on purpose:
    // the relay cap is 90 minutes and a longer slot has to be re-lightable during an outage.
    [InlineData("system-blueprint.html", "not-yet-checked-in")]
    // `HeartbeatCadence.OfflineAfterSeconds` floors the threshold at 180 s, so three beats is
    // only the whole story at intervals of 60 s and above.
    [InlineData("court-lights-flows.html", "after three missed beats at the interval you set.")]
    public void A_retracted_claim_has_not_come_back(string page, string claim)
    {
        Assert.DoesNotContain(claim, Read("docs", page), StringComparison.Ordinal);
    }
}

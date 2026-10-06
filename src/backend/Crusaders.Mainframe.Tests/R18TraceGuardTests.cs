using System.Reflection;
using System.Text.RegularExpressions;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 18, lane BE18b — the Night's vocabulary against EVERY audit action the API writes.
///
/// <para>
/// <b>E18-3.</b> <c>court.lights_restored</c> (a box re-energising a relay after a power cut) read
/// "Something this club's records have no word for" four times on an organiser's Night and "no word
/// for (court.lights_restored)" in the CSV. <see cref="TraceKindsTests"/>' guard read four named
/// writer files, and the restore is written from a fifth. This guard reads the whole API: every
/// audit action constant (a <c>const string …Action</c>) and every action literal on an
/// <c>Action = …</c> line reaches a word, or a declared exclusion — never <c>unrecognised</c>.
/// </para>
/// </summary>
public sealed class R18TraceGuardTests
{
    private static string ApiRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var api = Path.Combine(dir.FullName, "src", "backend", "Crusaders.Mainframe.Api");
            if (File.Exists(Path.Combine(dir.FullName, "whitelizard.txt")) && Directory.Exists(api)) return api;
            dir = dir.Parent;
        }
        throw new DirectoryNotFoundException("The repository root was not found above the test binary.");
    }

    /// <summary>The API's source files, migrations and build output aside.</summary>
    private static IEnumerable<string> SourceFiles()
    {
        var root = ApiRoot();
        var sep = Path.DirectorySeparatorChar;
        return Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Contains($"{sep}Migrations{sep}", StringComparison.Ordinal)
                        && !f.Contains($"{sep}bin{sep}", StringComparison.Ordinal)
                        && !f.Contains($"{sep}obj{sep}", StringComparison.Ordinal));
    }

    private static readonly Regex AuditShape = new("^[a-z_]+\\.[a-z_]+(\\.[a-z_]+)*$", RegexOptions.CultureInvariant);

    /// <summary>
    /// Every action literal on a line that assigns <c>Action = …</c> — a ternary's two arms included —
    /// across the whole API, and the first argument of every lights-row write (<c>Lights.Audit(…)</c>).
    /// Lines writing the admin change log (<c>AdminChangeLog</c>, a different table) name constants, not literals.
    /// </summary>
    private static HashSet<string> WrittenLiterals()
    {
        var found = new HashSet<string>(StringComparer.Ordinal);
        var literal = new Regex("\"([a-z_]+\\.[a-z_.]+)\"", RegexOptions.CultureInvariant);
        foreach (var file in SourceFiles())
        {
            foreach (var line in File.ReadLines(file))
            {
                if (!line.Contains("Action = ", StringComparison.Ordinal) || line.TrimStart().StartsWith("//", StringComparison.Ordinal)) continue;
                foreach (Match m in literal.Matches(line)) found.Add(m.Groups[1].Value);
            }
        }
        return found;
    }

    /// <summary>
    /// Every audit action constant in the API assembly: a <c>const string</c> whose name ends in
    /// <c>Action</c> and whose value is an action's shape (<c>area.verb</c>). The restore's
    /// <c>CourtLightStateService.LightsRestoredAction</c> is one — the action E18-3 found unmapped.
    /// </summary>
    private static HashSet<string> ActionConstants()
    {
        var found = new HashSet<string>(StringComparer.Ordinal);
        foreach (var type in typeof(TraceKinds).Assembly.GetTypes())
        {
            foreach (var f in type.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static))
            {
                if (!f.IsLiteral || f.FieldType != typeof(string) || !f.Name.EndsWith("Action", StringComparison.Ordinal)) continue;
                if (f.GetRawConstantValue() is string value && AuditShape.IsMatch(value)) found.Add(value);
            }
        }
        return found;
    }

    [Fact]
    public void Every_audit_action_the_api_writes_has_a_word_or_a_declared_exclusion()
    {
        var constants = ActionConstants();
        var literals = WrittenLiterals();

        // The scans have to find something, or this test is green because it read nothing.
        Assert.Contains(CourtLightStateService.LightsRestoredAction, constants);
        Assert.True(constants.Count >= 25, $"Only {constants.Count} action constants found — the scan is broken, not the code.");
        Assert.True(literals.Count >= 15, $"Only {literals.Count} action literals found — the scan is broken, not the code.");

        var unworded = constants.Concat(literals).Distinct()
            .Where(a => TraceKinds.OfAudit(a, actorIsSubject: true) == TraceKinds.Unrecognised
                        || TraceKinds.OfAudit(a, actorIsSubject: false) == TraceKinds.Unrecognised)
            .OrderBy(a => a, StringComparer.Ordinal)
            .ToList();
        Assert.True(unworded.Count == 0,
            "These audit actions render as 'no word for' on a Night: " + string.Join(", ", unworded) +
            ". Give each a word in TraceKinds, or declare it in TraceKinds.NotAPersonsNight with the reason.");
    }

    // ---- E18-3: the restore has its word, on the organiser's Night and the partners' --------------

    [Fact]
    public void Lights_restored_after_a_power_cut_has_its_own_word_on_every_view()
    {
        Assert.Equal(TraceKinds.LightsRestored, TraceKinds.OfAudit(CourtLightStateService.LightsRestoredAction, actorIsSubject: false));
        Assert.Equal(TraceKinds.LightsRestored, TraceKinds.OfAudit(CourtLightStateService.LightsRestoredAction, actorIsSubject: false, TraceView.Partner));
        Assert.Contains(CourtLightStateService.LightsRestoredAction, TraceKinds.PartnersViewActions);
        Assert.Equal(TraceKinds.LightsStrand, TraceKinds.StrandOf(TraceKinds.LightsRestored));
        Assert.Equal("Court 3 lights came back on after a power cut",
            TraceKinds.Headline(TraceKinds.LightsRestored, new TraceFacts { CourtName = "Court 3" }));
    }

    // ---- E18-8: the member's own reversal is in their own voice -----------------------------------

    [Theory]
    [InlineData(false, "Their check-in reached the club late — no-show reversed")]
    [InlineData(true, "Their check-in reached the club late — outage refund reversed")]
    public void A_members_own_late_check_in_reads_in_their_voice(bool dark, string expected)
    {
        var own = new TraceFacts { ActorName = "Orla Organiser", ActorKind = TraceActors.Member, BySelf = true, CourtWasDark = dark };
        Assert.Equal(expected, TraceKinds.Headline(TraceKinds.BookingNoShowReversed, own));

        // Somebody else's scan on their booking still names them.
        var other = own with { ActorName = "Pons Partner", BySelf = false, ByOther = true };
        Assert.StartsWith("Pons Partner's check-in reached the club late", TraceKinds.Headline(TraceKinds.BookingNoShowReversed, other), StringComparison.Ordinal);
    }

    // ---- E18-8: a box's accepted verdict rows name their member, and are no refusal on the Night ----

    [Theory]
    [InlineData("device.activation_reversed_no_show")]
    [InlineData("device.activation_after_cancel")]
    [InlineData("device.activation_displaced_collision")]
    public void An_accepted_uploads_verdict_row_is_no_refusal_on_a_night(string action)
    {
        Assert.Null(TraceKinds.OfAudit(action, actorIsSubject: false));
        // A refusal verdict still reads as one.
        Assert.Equal(TraceKinds.CourtRefused, TraceKinds.OfAudit("device.activation_wrong_court", actorIsSubject: false));
    }
}

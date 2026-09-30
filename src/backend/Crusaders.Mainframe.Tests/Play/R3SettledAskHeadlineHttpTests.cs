using Crusaders.Mainframe.Api.Services;
using static Crusaders.Mainframe.Tests.Play.PlayKit;

namespace Crusaders.Mainframe.Tests.Play;

/// <summary>
/// Review round 3, M-5 (F2-5 partly): a result-to-confirm line was marked read and resolved once
/// the result it asked about was withdrawn, confirmed or disputed — but its headline still said
/// "… — confirm or dispute", an instruction nobody could follow. A settled ask now reads as what
/// happened: past tense, and the outcome in place of the instruction.
/// </summary>
public sealed class R3SettledAskHeadlineHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private TestWebAppFactory CreateFactory() => new() { ConnectionString = pg.ConnectionString };

    private static async Task<string> AskHeadlineAsync(Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<Program> f, Guid member) =>
        Assert.Single(await InboxAsync(f, member, MemberEventCatalogue.ResultToConfirm)).Headline;

    [SkippableTheory]
    [InlineData("withdraw", "withdrawn")]
    [InlineData("confirm", "confirmed")]
    [InlineData("dispute", "disputed")]
    public async Task A_settled_ask_says_what_happened_instead_of_confirm_or_dispute(string action, string outcome)
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, $"nt-{action}");
        var booking = await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-2).Storable(), club.Organiser, [club.Bystander]);
        var olive = club.Client(f, club.Organiser);
        var v = (await (await RecordAsync(olive, booking, [U(club.Organiser)], [U(club.Bystander)], G((11, 1), (11, 2), (11, 3)))).JsonAsync())
            .GetProperty("version").GetInt32();
        Assert.StartsWith("Olive says they won 3–0 — confirm or dispute (", await AskHeadlineAsync(f, club.Bystander));

        var actor = action == "withdraw" ? olive : club.Client(f, club.Bystander);
        var acted = await ActAsync(actor, booking, action, v, action == "dispute" ? "It was 3–2" : null);
        Assert.True(acted.IsSuccessStatusCode, await acted.Content.ReadAsStringAsync());

        var headline = await AskHeadlineAsync(f, club.Bystander);
        Assert.DoesNotContain("confirm or dispute", headline);
        Assert.StartsWith($"Olive said they won 3–0 — {outcome} (", headline);
    }
}

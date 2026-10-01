using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Workers;
using Microsoft.Extensions.DependencyInjection;
using static Crusaders.Mainframe.Tests.PurchaseKit;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 4, M4-1, as it stands after P13: PayFast sends no ITN when a member cancels on its
/// page or abandons it, so the row stayed <c>Pending</c>. The cap that made that a lock-out is gone
/// (Dean, 2026-10-01), but the closings stay, because they are what the member's screen reads.
///
/// <para>
/// Pinned here: the cancel return closes the member's own row (idempotently, never over a
/// completion); the shelf lists the member's open checkouts until they settle or expire; the sweep
/// closes a stale one; and in every case a signed COMPLETE arriving later STILL credits the locked
/// minutes, because money moved — only the gateway's own cancel or failure is terminal (D2-B04).
/// </para>
/// </summary>
public sealed class TopUpAbandonedTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private static async Task<JsonElement> CancelReturnAsync(HttpClient client, Guid purchaseId, HttpStatusCode expected = HttpStatusCode.OK)
    {
        var res = await client.PostAsync($"/api/v1/minutes/purchase/{purchaseId}/cancel", null);
        Assert.Equal(expected, res.StatusCode);
        return expected == HttpStatusCode.OK ? await res.Content.ReadFromJsonAsync<JsonElement>() : default;
    }

    private static async Task<List<Guid>> OpenAsync(HttpClient client)
        => (await ShelfAsync(client)).GetProperty("open_checkouts").EnumerateArray().Select(o => o.GetProperty("id").GetGuid()).ToList();

    [SkippableFact]
    public async Task The_cancel_return_closes_the_members_own_row_and_takes_it_off_the_list()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await SeedAsync(factory, "abn");
        var member = Member(factory, club);

        var reg = await BuyAsync(member, club.OneHour);
        Assert.Equal([reg.Id], await OpenAsync(member));

        // Somebody else's id is a stranger's: 404, and the row is untouched.
        await CancelReturnAsync(Client(factory, club, club.OtherUserId), reg.Id, HttpStatusCode.NotFound);
        Assert.Equal(TopUpStatus.Pending, (await RowAsync(factory, reg.Id)).Status);

        var body = await CancelReturnAsync(member, reg.Id);
        Assert.Equal("Cancelled", body.GetProperty("status").GetString());
        Assert.Equal("cancelled_at_return", body.GetProperty("failure_code").GetString());
        Assert.Equal("1 hour", body.GetProperty("package_name").GetString());
        Assert.Equal(60, body.GetProperty("minutes").GetInt32());

        // Idempotent: the second return answers the same thing.
        var again = await CancelReturnAsync(member, reg.Id);
        Assert.Equal("Cancelled", again.GetProperty("status").GetString());

        Assert.Empty(await OpenAsync(member));
        await BuyAsync(member, club.OneHour);
    }

    /// <summary>
    /// Review round 5, M5-2, kept: the shelf lists the member's OWN open checkouts, newest first,
    /// with when each started and when it expires (P13: <c>expires_at</c> replaced
    /// <c>counts_until</c>, because with no cap nothing "counts"); cancelling one takes it off.
    /// </summary>
    [SkippableFact]
    public async Task The_shelf_lists_the_members_open_checkouts_newest_first()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await SeedAsync(factory, "abo");
        var member = Member(factory, club);

        var paid = await BuyAsync(member, club.OneHour);
        Assert.Equal(HttpStatusCode.OK, (await PostItnAsync(factory, club, paid.CheckoutId, "120.00", "7340101")).StatusCode);
        var older = await BuyAsync(member, club.FiveHours);
        await BackdateAsync(factory, older.Id, TimeSpan.FromMinutes(5));
        var newer = await BuyAsync(member, club.OneHour);
        await BuyAsync(Client(factory, club, club.OtherUserId), club.TenHours);

        var open = (await ShelfAsync(member)).GetProperty("open_checkouts").EnumerateArray().ToList();
        Assert.Equal([newer.Id, older.Id], open.Select(o => o.GetProperty("id").GetGuid()).ToList());
        var started = open[1].GetProperty("created_at").GetDateTimeOffset();
        Assert.Equal((await RowAsync(factory, older.Id)).CreatedAt, started, TimeSpan.FromMilliseconds(1));
        Assert.Equal(started.AddMinutes(60), open[1].GetProperty("expires_at").GetDateTimeOffset());
        Assert.Equal(550m, open[1].GetProperty("amount_zar").GetDecimal());
        Assert.Equal("5 hours", open[1].GetProperty("package_name").GetString());
        Assert.Equal(300, open[1].GetProperty("minutes").GetInt32());
        Assert.False(open[1].TryGetProperty("counts_until", out _));

        var status = await member.GetFromJsonAsync<JsonElement>($"/api/v1/minutes/purchase/{older.Id}");
        Assert.Equal(started, status.GetProperty("created_at").GetDateTimeOffset());
        Assert.Equal(started.AddMinutes(60), status.GetProperty("expires_at").GetDateTimeOffset());

        await CancelReturnAsync(member, older.Id);
        Assert.Equal([newer.Id], await OpenAsync(member));
    }

    /// <summary>
    /// <b>The money test for the cancel return</b> (§10.3, non-negotiable): the member came back
    /// through the cancel URL, then PayFast's signed COMPLETE arrived after all. The money moved,
    /// so the row reopens and the LOCKED minutes are credited — once.
    /// </summary>
    [SkippableFact]
    public async Task A_complete_arriving_after_the_cancel_return_still_credits_the_member()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await SeedAsync(factory, "abc");
        var member = Member(factory, club);

        var reg = await BuyAsync(member, club.FiveHours);
        await CancelReturnAsync(member, reg.Id);

        var itn = await PostItnAsync(factory, club, reg.CheckoutId, "550.00", "7340001");
        Assert.Equal(HttpStatusCode.OK, itn.StatusCode);
        var answer = await itn.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(answer.GetProperty("ok").GetBoolean());
        Assert.Equal(300, answer.GetProperty("minutes").GetInt32());

        var row = await RowAsync(factory, reg.Id);
        Assert.Equal(TopUpStatus.Completed, row.Status);
        Assert.Null(row.FailureReason);
        Assert.Equal(300, Assert.Single(await LedgerAsync(factory, club, club.MemberUserId)).AmountMinutes);

        // A retry of the same notification credits nothing more.
        await PostItnAsync(factory, club, reg.CheckoutId, "550.00", "7340001");
        Assert.Single(await LedgerAsync(factory, club, club.MemberUserId));

        // And a cancel return after the completion does not undo it.
        var late = await CancelReturnAsync(member, reg.Id);
        Assert.Equal("Completed", late.GetProperty("status").GetString());
    }

    [SkippableFact]
    public async Task An_abandoned_checkout_leaves_the_list_after_its_lifetime_and_the_sweep_closes_it()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await SeedAsync(factory, "abx");
        var member = Member(factory, club);

        var abandoned = await BuyAsync(member, club.OneHour);
        await BackdateAsync(factory, abandoned.Id, TimeSpan.FromMinutes(59));
        Assert.Equal([abandoned.Id], await OpenAsync(member));

        // Past the lifetime it leaves the list at once — before any sweep has run.
        await BackdateAsync(factory, abandoned.Id, TimeSpan.FromMinutes(2));
        Assert.Empty(await OpenAsync(member));
        var fresh = await BuyAsync(member, club.OneHour);

        // The sweep closes the old row, not the fresh one.
        var worker = factory.Services.GetRequiredService<TopUpExpiryWorker>();
        Assert.True(await worker.TickAsync(DateTimeOffset.UtcNow, CancellationToken.None) >= 1);
        var closed = await RowAsync(factory, abandoned.Id);
        Assert.Equal(TopUpStatus.Cancelled, closed.Status);
        Assert.Equal("expired", closed.FailureReason);
        Assert.Equal(TopUpStatus.Pending, (await RowAsync(factory, fresh.Id)).Status);
        var status = await member.GetFromJsonAsync<JsonElement>($"/api/v1/minutes/purchase/{abandoned.Id}");
        Assert.Equal("Cancelled", status.GetProperty("status").GetString());
        Assert.Equal("expired", status.GetProperty("failure_code").GetString());

        // Money that moved after all is still credited.
        var itn = await PostItnAsync(factory, club, abandoned.CheckoutId, "120.00", "7340002");
        Assert.Equal(HttpStatusCode.OK, itn.StatusCode);
        Assert.Equal(TopUpStatus.Completed, (await RowAsync(factory, abandoned.Id)).Status);
        Assert.Equal(60, Assert.Single(await LedgerAsync(factory, club, club.MemberUserId)).AmountMinutes);
    }

    /// <summary>The gateway's own cancel stays terminal (D2-B04) — only OUR closings reopen.</summary>
    [SkippableFact]
    public async Task A_gateway_cancel_after_the_cancel_return_is_terminal()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await SeedAsync(factory, "abg");
        var member = Member(factory, club);

        var reg = await BuyAsync(member, club.OneHour);
        await CancelReturnAsync(member, reg.Id);
        var gatewayCancel = await PostItnAsync(factory, club, reg.CheckoutId, "120.00", "7340003", "CANCELLED");
        Assert.Equal(HttpStatusCode.OK, gatewayCancel.StatusCode);
        Assert.Equal("cancelled", (await RowAsync(factory, reg.Id)).FailureReason);

        var resurrect = await PostItnAsync(factory, club, reg.CheckoutId, "120.00", "7340004");
        Assert.Equal("already_settled", (await resurrect.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("reason").GetString());
        Assert.Empty(await LedgerAsync(factory, club, club.MemberUserId));
    }

    /// <summary>
    /// A cancel return racing the COMPLETE: whichever lands first, the member ends credited exactly
    /// once and the row reads Completed.
    /// </summary>
    [SkippableFact]
    public async Task A_cancel_return_racing_the_complete_always_ends_credited_once()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await SeedAsync(factory, "abr");
        var member = Member(factory, club);

        for (var i = 0; i < 8; i++)
        {
            var reg = await BuyAsync(member, club.OneHour);
            var cancel = member.PostAsync($"/api/v1/minutes/purchase/{reg.Id}/cancel", null);
            var itn = PostItnAsync(factory, club, reg.CheckoutId, "120.00", $"73401{i:00}");
            await Task.WhenAll(cancel, itn);
            Assert.Equal(HttpStatusCode.OK, (await cancel).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await itn).StatusCode);

            var row = await RowAsync(factory, reg.Id);
            Assert.Equal(TopUpStatus.Completed, row.Status);
            Assert.Null(row.FailureReason);
        }

        var ledger = await LedgerAsync(factory, club, club.MemberUserId);
        Assert.Equal(8, ledger.Count);
        Assert.Equal(8 * 60, ledger.Sum(l => l.AmountMinutes));
    }

    /// <summary>
    /// There is no cap (P13 §3.6): purchases sent together each lock their own row, and none is
    /// refused for what the others are worth.
    /// </summary>
    [SkippableFact]
    public async Task Purchases_sent_together_are_each_registered_with_no_ceiling()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await SeedAsync(factory, "abt");
        var member = Member(factory, club);

        var answers = await Task.WhenAll(Enumerable.Range(0, 8)
            .Select(_ => member.PostAsJsonAsync("/api/v1/minutes/purchase", new { packageId = club.TenHours, quotedPriceZar = 1000m })));

        Assert.All(answers, a => Assert.Equal(HttpStatusCode.OK, a.StatusCode));
        Assert.Equal(8, (await OpenAsync(member)).Count);
    }
}

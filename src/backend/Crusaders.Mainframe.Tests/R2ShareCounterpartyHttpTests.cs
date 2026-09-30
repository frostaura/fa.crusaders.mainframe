using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Endpoints;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 2, C5 (ADM-M): a share transfer read "Sam → Club treasury" on one side and
/// "Club treasury → Alice" on the other — as though the club had taken the money. Both the
/// member's ledger and the admin ledger now name the other member of the pair
/// (<c>counterparty_name</c>, <c>counterparty_user_id</c>) and read member to member.
/// </summary>
public sealed class R2ShareCounterpartyHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => pg.SharedHost;

    private static JsonElement ShareRow(IEnumerable<JsonElement> rows, Guid owner) =>
        rows.Single(r => r.GetProperty("type").GetString() == "ShareTransfer" && r.GetProperty("subjectUserId").GetGuid() == owner);

    [SkippableFact]
    public async Task A_share_reads_member_to_member_on_both_wallets_and_the_admin_ledger()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r2share");
        await club.CreditAsync(f, club.Organiser, 100m);
        await club.CreditAsync(f, club.Sam, 100m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }]);
        var seat = PlayersClub.SeatOf(body, 2);
        var accept = await club.Client(f, club.Sam).PostAsJsonAsync(
            $"/api/v1/bookings/{bookingId}/players/{seat}/accept", new { expectedShareCredits = 16m });
        Assert.True(accept.IsSuccessStatusCode, await accept.Content.ReadAsStringAsync());

        var olive = (await (await club.Client(f, club.Organiser).GetAsync("/api/v1/wallet")).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("entries").EnumerateArray().ToList();
        var received = ShareRow(olive, club.Organiser);
        Assert.Equal("Sam Partner", received.GetProperty("from").GetString());
        Assert.Equal("Olive Organiser", received.GetProperty("to").GetString());
        Assert.Equal("Sam Partner", received.GetProperty("counterparty_name").GetString());
        Assert.Equal(club.Sam, received.GetProperty("counterparty_user_id").GetGuid());
        // Every other row is untouched: no counterparty, the treasury where it always was.
        var charge = olive.Single(r => r.GetProperty("type").GetString() == "BookingCharge");
        Assert.Equal(JsonValueKind.Null, charge.GetProperty("counterparty_name").ValueKind);
        Assert.Equal(LedgerRowMapper.Treasury, charge.GetProperty("to").GetString());

        var sam = (await (await club.Client(f, club.Sam).GetAsync("/api/v1/wallet")).Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("entries").EnumerateArray().ToList();
        var paid = ShareRow(sam, club.Sam);
        Assert.Equal("Sam Partner", paid.GetProperty("from").GetString());
        Assert.Equal("Olive Organiser", paid.GetProperty("to").GetString());
        Assert.Equal(club.Organiser, paid.GetProperty("counterparty_user_id").GetGuid());

        var admin = (await (await club.Client(f, club.Admin, admin: true).GetAsync("/api/v1/admin/ledger")).Content.ReadFromJsonAsync<JsonElement>())
            .EnumerateArray().ToList();
        Assert.Equal("Sam Partner", ShareRow(admin, club.Organiser).GetProperty("counterparty_name").GetString());
        Assert.Equal("Olive Organiser", ShareRow(admin, club.Sam).GetProperty("counterparty_name").GetString());
        Assert.DoesNotContain(admin.Where(r => r.GetProperty("type").GetString() == "ShareTransfer"),
            r => r.GetProperty("from").GetString() == LedgerRowMapper.Treasury || r.GetProperty("to").GetString() == LedgerRowMapper.Treasury);
    }

    [Theory]
    [InlineData("share:3f2b:1:out", "share:3f2b:1:in")]
    [InlineData("share:3f2b:12:in", "share:3f2b:12:out")]
    [InlineData("topup:abc:out", null)]
    [InlineData("share:3f2b:1", null)]
    public void The_twin_of_a_share_reference_is_its_other_half(string reference, string? twin) =>
        Assert.Equal(twin, LedgerRowMapper.TwinOf(reference));
}

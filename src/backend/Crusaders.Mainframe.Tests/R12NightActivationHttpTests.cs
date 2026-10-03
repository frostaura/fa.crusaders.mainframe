using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 12, E12-1 and D12-2. An uploaded court-box <c>activation</c> the server REFUSED —
/// a forged code, a genuine code with no booking behind it, a replayed one — wrote its event row
/// and its verdict row about the member, and the Night read the event row as "Checked in at 0":
/// a check-in that never counted, at the relay INDEX, at the upload's instant. The refusal reads
/// as a refusal, once, at the court the relay maps to, at the scan. An offline refusal at no
/// court never prints the relay, and never says "refused" twice.
/// </summary>
public sealed class R12NightActivationHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    /// <summary>How long before the upload the box saw the scan — far enough to tell scan from upload.</summary>
    private const long ScanAgoMs = 20 * 60 * 1000;

    private static async Task<List<JsonElement>> NightAsync(MemberCodeClub club, WebApplicationFactory<Program> app, Guid user)
    {
        var body = await club.Member(app, club.AdminId, "admin").GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{user}/trace");
        return [.. body.GetProperty("events").EnumerateArray()];
    }

    private static List<JsonElement> CourtRows(List<JsonElement> night) =>
        [.. night.Where(e => e.GetProperty("strand").GetString() == TraceKinds.CourtStrand)];

    private static Task NameBoxAsync(MemberCodeClub club, WebApplicationFactory<Program> app, string name) => club.WriteAsync(app, async db =>
    {
        var box = db.Devices.IgnoreQueryFilters().Single(d => d.TenantId == club.TenantId && d.MacAddress == club.BoxMac);
        box.Name = name;
        await db.SaveChangesAsync();
    });

    private static string Headline(JsonElement e) => e.GetProperty("headline").GetString()!;

    /// <summary>The row prints at the scan, not at the upload twenty minutes later.</summary>
    private static void AtTheScan(JsonElement row, DateTimeOffset uploadedAt)
    {
        var at = row.GetProperty("at").GetDateTimeOffset();
        var expected = uploadedAt.AddMilliseconds(-ScanAgoMs);
        Assert.True((at - expected).Duration() < TimeSpan.FromMinutes(2), $"row at {at:O}, scan near {expected:O}");
    }

    private static void NeverCheckedIn(List<JsonElement> night)
    {
        Assert.DoesNotContain(night, e => e.GetProperty("kind").GetString() == TraceKinds.CourtCheckedIn);
        Assert.DoesNotContain(night, e => Headline(e).StartsWith("Checked in", StringComparison.Ordinal));
    }

    [SkippableFact]
    public async Task A_forged_code_uploaded_by_the_box_is_one_refusal_at_its_court_at_the_scan()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "r12forged");
        var uploadedAt = DateTimeOffset.UtcNow;
        var forged = club.ForgedOn(club.Olga, uploadedAt.AddMilliseconds(-ScanAgoMs));

        // Relay 1 of the box is Court 2.
        (await app.CreateClient().SendAsync(club.Events(club.BoxMac, 1, "activation", 1, forged, agoMs: ScanAgoMs))).EnsureSuccessStatusCode();

        var night = await NightAsync(club, app, club.Olga);
        NeverCheckedIn(night);
        var refused = Assert.Single(CourtRows(night));
        Assert.Equal(TraceKinds.CourtRefused, refused.GetProperty("kind").GetString());
        Assert.Equal("Was refused at Court 2 — the code could not be verified", Headline(refused));
        Assert.Equal("Court 2", refused.GetProperty("court").GetProperty("name").GetString());
        Assert.DoesNotContain(night, e => Headline(e).Contains(" at 1", StringComparison.Ordinal));
        AtTheScan(refused, uploadedAt);
    }

    [SkippableFact]
    public async Task A_genuine_code_with_no_booking_is_never_a_check_in()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "r12nobook");
        var uploadedAt = DateTimeOffset.UtcNow;
        var code = club.Code(club.Pam, uploadedAt.AddMilliseconds(-ScanAgoMs));

        // Relay 0 is Court 1; Pam has no booking anywhere.
        (await app.CreateClient().SendAsync(club.Events(club.BoxMac, 1, "activation", 0, code, agoMs: ScanAgoMs))).EnsureSuccessStatusCode();

        var night = await NightAsync(club, app, club.Pam);
        NeverCheckedIn(night);
        var refused = Assert.Single(CourtRows(night));
        Assert.Equal("Was refused at Court 1 — no booking of theirs on that court then", Headline(refused));
        AtTheScan(refused, uploadedAt);
    }

    [SkippableFact]
    public async Task A_replayed_code_after_a_real_check_in_is_one_check_in_and_one_refusal()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "r12replay");
        await club.BookAsync(app, club.Olga, courtIndex: 1, startsInMinutes: -2, minutes: 60);
        var code = club.Code(club.Olga);
        var device = app.CreateClient();

        // The box checks Olga in offline, then is shown the same code again (a photo of it).
        (await device.SendAsync(club.Events(club.BoxMac, 1, "activation", 1, code, agoMs: 2_000))).EnsureSuccessStatusCode();
        (await device.SendAsync(club.Events(club.BoxMac, 2, "activation", 1, code, agoMs: 1_000))).EnsureSuccessStatusCode();

        var night = await NightAsync(club, app, club.Olga);
        var checkedIn = Assert.Single(night, e => e.GetProperty("kind").GetString() == TraceKinds.CourtCheckedIn);
        Assert.Equal("Checked in at Court 2", Headline(checkedIn));
        var refused = Assert.Single(night, e => e.GetProperty("kind").GetString() == TraceKinds.CourtRefused);
        Assert.Equal("Was refused at Court 2 — the code could not be verified", Headline(refused));
    }

    /// <summary>D12-2: an offline refusal at no court (relay -1) names the box, never "-1", and says "refused" once.</summary>
    [SkippableFact]
    public async Task An_offline_refusal_at_no_court_names_the_box_and_says_refused_once()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "r12offbox");
        await NameBoxAsync(club, app, DeviceRegistryService.CourtBoxPlaceholderName);
        var uploadedAt = DateTimeOffset.UtcNow;
        var code = club.Code(club.Olga, uploadedAt.AddMilliseconds(-ScanAgoMs));

        (await app.CreateClient().SendAsync(club.Events(club.BoxMac, 1, "unknown_scan", -1, code, agoMs: ScanAgoMs))).EnsureSuccessStatusCode();

        var refused = Assert.Single(CourtRows(await NightAsync(club, app, club.Olga)));
        Assert.Equal("Was refused at the court box while it was offline", Headline(refused));
        Assert.Equal(JsonValueKind.Null, refused.GetProperty("court").ValueKind);
        Assert.False(refused.GetProperty("detail").TryGetProperty("court", out _), "the relay index is not a court");
        AtTheScan(refused, uploadedAt);

        // A box the club has named is named.
        await NameBoxAsync(club, app, "Back courts box");
        Assert.Equal("Was refused at Back courts box while it was offline", Headline(Assert.Single(CourtRows(await NightAsync(club, app, club.Olga)))));
    }

    /// <summary>D12-2: at a court the relay maps to, the court — and still one "refused".</summary>
    [SkippableFact]
    public async Task An_offline_refusal_at_a_court_names_the_court_and_says_refused_once()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "r12offcourt");
        var code = club.Code(club.Olga);

        (await app.CreateClient().SendAsync(club.Events(club.BoxMac, 1, "unknown_scan", 2, code))).EnsureSuccessStatusCode();

        var refused = Assert.Single(CourtRows(await NightAsync(club, app, club.Olga)));
        Assert.Equal("Was refused at Court 3 while its box was offline", Headline(refused));
    }
}

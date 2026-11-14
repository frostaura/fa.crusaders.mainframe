using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// BA-04, server half: lights on with nothing booked, and a check-in on a dark court, by the
/// box's CONFIRMED word and past the grace window — the tile's own rule, as pure function.
/// </summary>
public sealed class LightsMismatchClassifyTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 14, 19, 0, 0, TimeSpan.Zero);

    private static CourtLightState Confirmed(LightState said, DateTimeOffset at, LightState believed = LightState.Unknown, DateTimeOffset? onSince = null) => new()
    {
        CourtId = Guid.NewGuid(),
        State = believed,
        OnSince = onSince,
        ConfirmedAt = at,
        ConfirmedState = said,
        LastEventAt = at,
    };

    private static Booking Current(DateTimeOffset? checkedIn) => new()
    {
        CourtId = Guid.NewGuid(),
        StartsAt = Now.AddMinutes(-30),
        EndsAt = Now.AddMinutes(15),
        SliceMinutes = 15,
        SliceCount = 3,
        CheckedInAt = checkedIn,
    };

    [Fact]
    public void Lit_with_nothing_booked_past_the_grace_window_is_flagged_and_inside_it_is_not()
    {
        Assert.Equal(DeviceErrorCodes.LightsOnNothingBooked, LightsMismatch.Classify(Confirmed(LightState.On, Now.AddMinutes(-20)), null, Now, 5));
        Assert.Null(LightsMismatch.Classify(Confirmed(LightState.On, Now.AddMinutes(-3)), null, Now, 5));
        // The lit-since instant the server believes outranks the confirmation's: lit 2 minutes ago, confirmed just now.
        Assert.Null(LightsMismatch.Classify(Confirmed(LightState.On, Now, LightState.On, Now.AddMinutes(-2)), null, Now, 5));
        Assert.Equal(DeviceErrorCodes.LightsOnNothingBooked,
            LightsMismatch.Classify(Confirmed(LightState.On, Now, LightState.On, Now.AddMinutes(-40)), null, Now, 5));
    }

    [Fact]
    public void Lit_with_a_booking_on_the_court_is_not_flagged()
    {
        Assert.Null(LightsMismatch.Classify(Confirmed(LightState.On, Now.AddHours(-1)), Current(null), Now, 5));
    }

    [Fact]
    public void Checked_in_and_confirmed_dark_after_the_check_in_is_flagged_past_the_grace_window()
    {
        Assert.Equal(DeviceErrorCodes.CheckedInLightsOff,
            LightsMismatch.Classify(Confirmed(LightState.Off, Now.AddMinutes(-1)), Current(Now.AddMinutes(-25)), Now, 5));
        // Checked in two minutes ago: inside the grace window.
        Assert.Null(LightsMismatch.Classify(Confirmed(LightState.Off, Now.AddMinutes(-1)), Current(Now.AddMinutes(-2)), Now, 5));
        // Dark BEFORE the check-in is the box's old word, not a contradiction of it.
        Assert.Null(LightsMismatch.Classify(Confirmed(LightState.Off, Now.AddMinutes(-40)), Current(Now.AddMinutes(-25)), Now, 5));
        // Nobody checked in: a dark court is what an unclaimed booking looks like.
        Assert.Null(LightsMismatch.Classify(Confirmed(LightState.Off, Now.AddMinutes(-1)), Current(null), Now, 5));
    }

    [Fact]
    public void Nothing_the_box_has_not_confirmed_is_ever_flagged()
    {
        var unconfirmed = new CourtLightState { State = LightState.On, OnSince = Now.AddHours(-2), LastEventAt = Now };
        Assert.Null(LightsMismatch.Classify(unconfirmed, null, Now, 5));
        Assert.Null(LightsMismatch.Classify(null, Current(Now.AddMinutes(-30)), Now, 5));
    }
}

/// <summary>The sweep against a real club: filed on the box, counted on the summary, resolved when it clears, and kept to its club.</summary>
public sealed class LightsMismatchSweepTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private static async Task ConfirmAsync(TestWebAppFactory factory, Guid tenantId, Guid courtId, LightState said, DateTimeOffset at)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var row = await db.CourtLightStates.IgnoreQueryFilters().FirstOrDefaultAsync(l => l.CourtId == courtId);
        if (row is null)
        {
            row = new CourtLightState { TenantId = tenantId, CourtId = courtId };
            db.CourtLightStates.Add(row);
        }
        row.State = said;
        row.OnSince = said == LightState.On ? at.ToUniversalTime() : null;
        row.ConfirmedAt = at.ToUniversalTime();
        row.ConfirmedState = said;
        row.LastEventAt = at.ToUniversalTime();
        row.UpdatedAt = at.ToUniversalTime();
        await db.SaveChangesAsync();
    }

    private static async Task<List<DeviceError>> FaultsAsync(TestWebAppFactory factory, Guid tenantId)
    {
        using var scope = factory.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<MainframeDbContext>().DeviceErrors.IgnoreQueryFilters().AsNoTracking()
            .Where(e => e.TenantId == tenantId && LightsMismatch.Codes.Contains(e.Code)).ToListAsync();
    }

    private static Task SweepAsync(TestWebAppFactory factory, DateTimeOffset now) =>
        factory.Services.GetRequiredService<AdminNotificationSweep>().SweepAsync(now, default);

    [SkippableFact]
    public async Task Lights_on_with_nothing_booked_is_a_fault_on_the_box_that_reaches_the_summary_and_clears_itself()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await ControlBoardClub.SeedAsync(factory, "lit-empty");
        var now = DateTimeOffset.UtcNow;
        var court = await club.AddCourtAsync(factory, 2);
        var box = await club.AddBoxAsync(factory, "box-lit", [1, 2], lastSeenAt: now.AddSeconds(-20));
        await ConfirmAsync(factory, club.TenantId, court, LightState.On, now.AddMinutes(-30));

        await SweepAsync(factory, now);
        await SweepAsync(factory, now.AddSeconds(30));

        var filed = Assert.Single(await FaultsAsync(factory, club.TenantId));
        Assert.Equal(DeviceErrorCodes.LightsOnNothingBooked, filed.Code);
        Assert.Equal(box, filed.DeviceId);
        Assert.Equal(2, filed.Court);
        Assert.Equal(DeviceErrorSource.Server, filed.Source);
        Assert.Null(filed.ResolvedAt);
        Assert.Equal(2, filed.Count);

        // The Overview's "Needs attention" reads the summary's open counts: the fault is in them.
        var summary = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>("/api/v1/admin/monitoring/summary");
        Assert.Equal(1, summary.GetProperty("open").GetProperty("warning").GetInt32());

        // Somebody switched them off: the next sweep closes the fault, with nobody's name on it.
        await ConfirmAsync(factory, club.TenantId, court, LightState.Off, now.AddMinutes(1));
        await SweepAsync(factory, now.AddMinutes(2));
        var closed = Assert.Single(await FaultsAsync(factory, club.TenantId));
        Assert.NotNull(closed.ResolvedAt);
        Assert.Null(closed.ResolvedByUserId);
        Assert.Equal(LightsMismatch.ClearedNote, closed.ResolutionNote);
    }

    [SkippableFact]
    public async Task A_check_in_on_a_court_the_box_says_is_dark_is_a_fault_and_a_booked_lit_court_is_not()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await ControlBoardClub.SeedAsync(factory, "dark-in");
        var now = DateTimeOffset.UtcNow;
        var dark = await club.AddCourtAsync(factory, 1);
        var lit = await club.AddCourtAsync(factory, 3);
        await club.AddBoxAsync(factory, "box-dark", [1, 3], lastSeenAt: now.AddSeconds(-10));
        await club.AddBookingAsync(factory, dark, now.AddMinutes(-30), now.AddMinutes(15), club.MemberUserId, checkedInAt: now.AddMinutes(-28));
        await club.AddBookingAsync(factory, lit, now.AddMinutes(-30), now.AddMinutes(15), club.MemberUserId, checkedInAt: now.AddMinutes(-28));
        await ConfirmAsync(factory, club.TenantId, dark, LightState.Off, now.AddMinutes(-5));
        await ConfirmAsync(factory, club.TenantId, lit, LightState.On, now.AddMinutes(-27));

        await SweepAsync(factory, now);

        var filed = Assert.Single(await FaultsAsync(factory, club.TenantId));
        Assert.Equal(DeviceErrorCodes.CheckedInLightsOff, filed.Code);
        Assert.Equal(1, filed.Court);
        Assert.Equal(DeviceErrorSeverity.Error, filed.Severity);
    }

    [SkippableFact]
    public async Task Nothing_is_said_about_a_court_whose_box_is_offline_or_out_of_service()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await ControlBoardClub.SeedAsync(factory, "lit-quiet");
        var now = DateTimeOffset.UtcNow;
        var offline = await club.AddCourtAsync(factory, 1);
        var shut = await club.AddCourtAsync(factory, 2);
        await club.AddBoxAsync(factory, "box-gone", [1], lastSeenAt: now.AddHours(-2));
        await club.AddBoxAsync(factory, "box-shut", [2], lastSeenAt: now, outOfServiceSince: now.AddDays(-1));
        await ConfirmAsync(factory, club.TenantId, offline, LightState.On, now.AddHours(-3));
        await ConfirmAsync(factory, club.TenantId, shut, LightState.On, now.AddHours(-3));

        await SweepAsync(factory, now);

        Assert.Empty(await FaultsAsync(factory, club.TenantId));
    }

    /// <summary>Cross-tenant: one club's lit court is filed in that club only, against its own box.</summary>
    [SkippableFact]
    public async Task A_clubs_lit_court_is_filed_in_that_club_and_never_in_another()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var now = DateTimeOffset.UtcNow;
        var a = await ControlBoardClub.SeedAsync(factory, "lit-a");
        var b = await ControlBoardClub.SeedAsync(factory, "lit-b");
        var courtA = await a.AddCourtAsync(factory, 1);
        var boxA = await a.AddBoxAsync(factory, "box-a", [1], lastSeenAt: now);
        await b.AddCourtAsync(factory, 1);
        var boxB = await b.AddBoxAsync(factory, "box-b", [1], lastSeenAt: now);
        await ConfirmAsync(factory, a.TenantId, courtA, LightState.On, now.AddMinutes(-30));

        await SweepAsync(factory, now);

        Assert.Equal(boxA, Assert.Single(await FaultsAsync(factory, a.TenantId)).DeviceId);
        Assert.Empty(await FaultsAsync(factory, b.TenantId));
        var summaryB = await b.AdminClient(factory).GetFromJsonAsync<JsonElement>("/api/v1/admin/monitoring/summary");
        Assert.Equal(0, summaryB.GetProperty("open").GetProperty("warning").GetInt32());
        Assert.DoesNotContain(summaryB.GetProperty("by_device").EnumerateArray(), d => d.GetProperty("device_id").GetGuid() == boxA);
        Assert.NotEqual(boxA, boxB);
    }
}

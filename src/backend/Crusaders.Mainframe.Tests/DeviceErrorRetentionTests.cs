using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Workers;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The fault log's retention sweep — GOAL item 7's §7.6.
///
/// <para>
/// <b>The claim under test is the asymmetry, and it is a claim about honesty rather than about
/// disk.</b> A resolved row past the cutoff is deleted; an OPEN one is aged out and KEPT. A
/// sweep that deleted both would make the club's "open errors" number fall while the boards
/// stayed exactly as broken — and the one surface that would have said so is the one that
/// quietly stopped saying it. Every test here drives the REAL <see cref="RetentionWorker"/>
/// where it can, because a retention rule proved against a re-implementation proves nothing
/// about the rule that deletes rows in production.
/// </para>
/// </summary>
public sealed class DeviceErrorRetentionTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public DeviceErrorRetentionTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    /// <summary>A club that keeps its faults for a week, so a test's fixture is days rather than months.</summary>
    private const string ShortRetention =
        """{"slice_minutes":15,"timezone":"UTC","heartbeat_seconds":60,"device_error_retention_days":7}""";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    /// <summary>One whole sweep, through the worker the container actually hosts.</summary>
    private static Task TickAsync(TestWebAppFactory factory)
        => new RetentionWorker(factory.Services, NullLogger<RetentionWorker>.Instance)
            .TickAsync(CancellationToken.None);

    // ---- the asymmetry ---------------------------------------------------------------

    /// <summary>
    /// <b>A resolved row goes and an open one is aged out.</b> Both are past the same cutoff,
    /// and the mutant this kills is the obvious simplification: one <c>RemoveRange</c> over
    /// everything older than the cutoff, which reads as tidier and quietly deletes the club's
    /// evidence that four boards are broken.
    /// </summary>
    [SkippableFact]
    public async Task A_resolved_row_is_deleted_and_an_open_one_is_aged_out_and_kept()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "retmix", ShortRetention);
        var box = await club.AddBoxAsync(factory, "box-ret01", [1], lastSeenAt: DateTimeOffset.UtcNow);
        var now = DateTimeOffset.UtcNow;

        var closed = await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.LcdResync,
            new ErrorRow
            {
                DeviceId = box, FirstSeenAt = now.AddDays(-40), LastSeenAt = now.AddDays(-40),
                ResolvedAt = now.AddDays(-30), ResolvedByUserId = club.AdminUserId, ResolutionNote = "reseated it",
            });
        var forgotten = await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.MegaLinkLost,
            new ErrorRow { DeviceId = box, FirstSeenAt = now.AddDays(-40), LastSeenAt = now.AddDays(-30), Count = 900 });

        await TickAsync(factory);

        Assert.Null(await MonitoringFixture.ReadAsync(factory, closed));

        var aged = await MonitoringFixture.ReadAsync(factory, forgotten);
        Assert.NotNull(aged);
        Assert.NotNull(aged.ResolvedAt);
        Assert.Equal(MonitoringSettings.AgedOutNote, aged.ResolutionNote);

        // Nobody attended to it, so nobody's name is against it. A resolver here would make the
        // page assert that an admin dealt with a fault no admin ever saw.
        Assert.Null(aged.ResolvedByUserId);

        // And the history is intact: the count it reached is still the count it reached.
        Assert.Equal(900, aged.Count);
        Assert.Equal(now.AddDays(-40).UtcDateTime.Date, aged.FirstSeenAt.UtcDateTime.Date);
    }

    /// <summary>
    /// <b>The aged-out row survives the NEXT sweep too, and that is what "keeps the history"
    /// means.</b> It is resolved now, so a sweep ageing resolved rows off their LAST SIGHTING
    /// rather than their resolution would delete it on the following night — one day of history,
    /// in a file that claims to keep it. That mutant is a single column name.
    /// </summary>
    [SkippableFact]
    public async Task An_aged_out_row_is_not_deleted_by_the_next_nights_sweep()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "retkeep", ShortRetention);
        var box = await club.AddBoxAsync(factory, "box-ret02", [1], lastSeenAt: DateTimeOffset.UtcNow);
        var now = DateTimeOffset.UtcNow;

        var forgotten = await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.HttpTimeout,
            new ErrorRow { DeviceId = box, FirstSeenAt = now.AddDays(-60), LastSeenAt = now.AddDays(-50) });

        await TickAsync(factory);
        await TickAsync(factory);
        await TickAsync(factory);

        var aged = await MonitoringFixture.ReadAsync(factory, forgotten);
        Assert.NotNull(aged);
        Assert.Equal(MonitoringSettings.AgedOutNote, aged.ResolutionNote);
    }

    /// <summary>A fault inside the club's own window is untouched — the sweep is a horizon, not a tidy-up.</summary>
    [SkippableFact]
    public async Task A_fault_inside_the_window_is_left_exactly_as_it_was()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "retfresh", ShortRetention);
        var box = await club.AddBoxAsync(factory, "box-ret03", [1], lastSeenAt: DateTimeOffset.UtcNow);
        var now = DateTimeOffset.UtcNow;

        var open = await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.MegaLinkLost,
            new ErrorRow { DeviceId = box, FirstSeenAt = now.AddDays(-6), LastSeenAt = now.AddDays(-6) });
        var closed = await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.LcdResync,
            new ErrorRow
            {
                DeviceId = box, FirstSeenAt = now.AddDays(-6), LastSeenAt = now.AddDays(-6),
                ResolvedAt = now.AddDays(-6), ResolvedByUserId = club.AdminUserId,
            });

        await TickAsync(factory);

        Assert.Null((await MonitoringFixture.ReadAsync(factory, open))!.ResolvedAt);
        Assert.NotNull(await MonitoringFixture.ReadAsync(factory, closed));
    }

    /// <summary>
    /// <b>Ageing out FREES the fingerprint, which is the second half of why it is not a
    /// delete.</b> The unique index is filtered on open rows, so the moment the stale one is
    /// closed the same fault can open again — with its own first-seen, which is the honest
    /// answer to "how long has this been happening" for a board that came back.
    /// </summary>
    [SkippableFact]
    public async Task Ageing_out_frees_the_fingerprint_so_a_returning_fault_opens_a_fresh_row()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "retprint", ShortRetention);
        var box = await club.AddBoxAsync(factory, "box-ret04", [1], lastSeenAt: DateTimeOffset.UtcNow);
        var now = DateTimeOffset.UtcNow;

        var report = new DeviceErrorReport(
            Code: DeviceErrorCodes.SerialBadCrc, Source: DeviceErrorSource.Device,
            DeviceId: box, Detail: "crc mismatch");

        // Written through the real writer so the fingerprint is the production composition, then
        // dragged back beyond the cutoff — a board that failed two months ago and was ignored.
        await MonitoringFixture.RecordAsync(factory, club, report);
        await AgeAsync(factory, box, now.AddDays(-40));

        await TickAsync(factory);

        // The same fault, reported again today, by the same board.
        await MonitoringFixture.RecordAsync(factory, club, report);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var rows = await db.DeviceErrors.IgnoreQueryFilters().AsNoTracking()
            .Where(e => e.TenantId == club.TenantId).OrderBy(e => e.FirstSeenAt).ToListAsync();

        Assert.Equal(2, rows.Count);
        Assert.Equal(rows[0].Fingerprint, rows[1].Fingerprint);

        // The old one is closed and the new one is open with a TRUTHFUL first-seen — not the
        // stale row resurrected, which would tell an admin this has been failing since July.
        Assert.Equal(MonitoringSettings.AgedOutNote, rows[0].ResolutionNote);
        Assert.Null(rows[1].ResolvedAt);
        Assert.True(rows[1].FirstSeenAt > now.AddMinutes(-5));
    }

    /// <summary>
    /// Each club's own horizon. Two clubs in one database and one sweep: the seven-day club
    /// loses its old row and the ninety-day club does not — the mutant being a cutoff computed
    /// once outside the tenant loop, which is how one club's setting silently becomes every
    /// club's.
    /// </summary>
    [SkippableFact]
    public async Task Each_club_is_swept_on_its_own_retention_and_not_the_first_ones()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var brisk = await ControlBoardClub.SeedAsync(factory, "retbrisk", ShortRetention);
        var patient = await ControlBoardClub.SeedAsync(
            factory, "retpatient",
            """{"slice_minutes":15,"timezone":"UTC","heartbeat_seconds":60,"device_error_retention_days":365}""");
        var now = DateTimeOffset.UtcNow;

        var briskBox = await brisk.AddBoxAsync(factory, "box-ret05", [1], lastSeenAt: now);
        var patientBox = await patient.AddBoxAsync(factory, "box-ret06", [1], lastSeenAt: now);

        var swept = await MonitoringFixture.AddErrorAsync(
            factory, brisk, DeviceErrorCodes.MegaLinkLost,
            new ErrorRow { DeviceId = briskBox, FirstSeenAt = now.AddDays(-30), LastSeenAt = now.AddDays(-30) });
        var spared = await MonitoringFixture.AddErrorAsync(
            factory, patient, DeviceErrorCodes.MegaLinkLost,
            new ErrorRow { DeviceId = patientBox, FirstSeenAt = now.AddDays(-30), LastSeenAt = now.AddDays(-30) });

        await TickAsync(factory);

        Assert.Equal(MonitoringSettings.AgedOutNote, (await MonitoringFixture.ReadAsync(factory, swept))!.ResolutionNote);
        Assert.Null((await MonitoringFixture.ReadAsync(factory, spared))!.ResolvedAt);
    }

    /// <summary>
    /// A hand-edited settings document is not a PUT, and this is the reader whose number decides
    /// what is DELETED. A club whose stored retention is one day is swept on the seven-day floor.
    /// </summary>
    [SkippableFact]
    public async Task A_retention_below_the_floor_is_clamped_before_anything_is_deleted()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(
            factory, "retclamp",
            """{"slice_minutes":15,"timezone":"UTC","heartbeat_seconds":60,"device_error_retention_days":1}""");
        var box = await club.AddBoxAsync(factory, "box-ret07", [1], lastSeenAt: DateTimeOffset.UtcNow);
        var now = DateTimeOffset.UtcNow;

        // Three days old: past the stored 1-day number, inside the clamped 7-day floor.
        var recent = await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.HttpTimeout,
            new ErrorRow { DeviceId = box, FirstSeenAt = now.AddDays(-3), LastSeenAt = now.AddDays(-3) });

        await TickAsync(factory);

        Assert.Null((await MonitoringFixture.ReadAsync(factory, recent))!.ResolvedAt);
    }

    /// <summary>Drags a board's open rows back in time, which no sequence of live calls can do.</summary>
    private static async Task AgeAsync(TestWebAppFactory factory, Guid deviceId, DateTimeOffset to)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var rows = await db.DeviceErrors.IgnoreQueryFilters()
            .Where(e => e.DeviceId == deviceId && e.ResolvedAt == null).ToListAsync();
        foreach (var row in rows)
        {
            row.FirstSeenAt = to.ToUniversalTime();
            row.LastSeenAt = to.ToUniversalTime();
        }
        await db.SaveChangesAsync();
    }
}

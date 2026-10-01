using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// What a court box reports, and what it buys.
///
/// <para>
/// The box decides scans locally and queues what it decided; these two endpoints are where
/// that queue drains and where the one operation that genuinely needs the network — a
/// walk-up — happens. Over real HTTP with the club's API key and the box's MAC, because a
/// body the firmware writes one field differently is a 401 or a 404 with no diagnostic and
/// a trip to the club.
/// </para>
/// </summary>
public abstract partial class DeviceEventHttpTests
{
    private readonly PostgresFixture _pg;

    protected DeviceEventHttpTests(PostgresFixture pg) => _pg = pg;

    private const string EventsPath = "/api/v1/device/events";
    private const string WalkUpPath = "/api/v1/device/walkup";
    private const string ActivatePath = "/api/v1/device/activate";
    private const string Secret = "test-only-signing-key-not-used-in-any-real-environment";

    /// <param name="Timezone">
    /// The tzdb id <see cref="SeedAsync"/> put this club in. It is <b>not</b> UTC, so
    /// anything in this class that reasons about a minute-of-day has to convert through it
    /// rather than reading the runner's clock — <see cref="CloseTheClubAsync"/> is the one
    /// place that does, and it carries the measurement of how much that currently matters.
    /// </param>
    private sealed record Box(
        Guid DeviceId, string Mac, string ApiKey, Guid TenantId, string Slug, Guid CourtId, Guid MemberId,
        IReadOnlyDictionary<int, Guid> CourtIds, string Timezone);

    private TestWebAppFactory CreateFactory() => _pg.SharedHost;

    /// <summary>
    /// A tenant, a funded member, and a claimed box driving <paramref name="courtNumbers"/>
    /// (court 1 alone by default).
    ///
    /// <para>
    /// <b>The club is seeded into a zone where its own day still has room, not into UTC.</b>
    /// A walk-up is sold from <c>BookingService</c>'s own <c>UtcNow</c> and truncated at the
    /// club's closing time, which every fixture here puts at local midnight — so a club at
    /// UTC sells whatever is left of the UTC day instead of the thirty minutes asked for, and
    /// five tests in this class went red together at 23:50 UTC on 2026-09-07 on an untouched
    /// base commit (eight minutes granted for 4.27 credits, a minute later, against the 30
    /// and 16.00 they assert). Moving the club is the only lever: the purchase happens now and cannot
    /// be moved. <see cref="TestHost.DayZoneFor"/> picks a zone that leaves the whole relay
    /// hard cap plus an hour at each end, so no walk-up this class can ask for reaches
    /// closing time at any hour of any day.
    /// </para>
    ///
    /// <para>
    /// It is done <b>here</b>, in the one place every club in this class is built (the only
    /// <c>db.Tenants.Add</c> in the file), rather than test by test: <b>four of the five that
    /// failed never read a clock at all</b> — only
    /// <c>A_walk_up_is_truncated_at_the_next_booking_and_charged_pro_rata</c> names
    /// <c>UtcNow</c> — and the next walk-up test written would not have named one either.
    /// </para>
    /// </summary>
    private static async Task<Box> SeedAsync(TestWebAppFactory factory, int topUpMinutes = 200, int[]? courtNumbers = null)
    {
        courtNumbers ??= [1];
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        // No MigrateAsync: the database is a clone of the template PostgresFixture migrated once.
        var timezone = TestHost.DayZoneFor(DateTimeOffset.UtcNow, RelayHardCap.Minutes);

        var slug = $"box-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant
        {
            Slug = slug,
            DisplayName = "Box Club",
            DeviceApiKey = DeviceApiKey.Generate(),
            DeviceApiKeyRegeneratedAt = DateTimeOffset.UtcNow,
        };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings
        {
            TenantId = tenant.Id,
            SettingsJson = $$"""{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"slice_price_credits":8,"grace_window_minutes":5,"timezone":"{{timezone}}","peak_hours":"16:00-19:00"}""",
        });

        var courts = courtNumbers
            .Select(n => new Court { TenantId = tenant.Id, CourtNumber = n, Name = $"Court {n}" })
            .ToList();
        db.Courts.AddRange(courts);

        var member = new User { TenantId = tenant.Id, Email = $"{slug}@test.local", PasswordHash = "x", EmailVerified = true };
        db.Users.Add(member);
        db.Memberships.Add(new Membership
        {
            TenantId = tenant.Id,
            UserId = member.Id,
            FullName = "Walk Up",
            MembershipNumber = slug,
            Status = MembershipStatus.Active,
        });

        var mac = Guid.NewGuid().ToString("N")[..12];
        var device = new Device
        {
            TenantId = tenant.Id,
            DeviceCode = $"box-{mac[^6..]}",
            Name = "Court 1 box",
            Kind = DeviceKind.CourtBox,
            Hardware = DeviceHardware.Esp8266,
            MacAddress = mac,
            CourtNumbers = [.. courtNumbers],
        };
        db.Devices.Add(device);

        if (topUpMinutes > 0)
        {
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = tenant.Id,
                UserId = member.Id,
                Type = LedgerEntryType.TopUp,
                AmountMinutes = topUpMinutes,
                ActorUserId = member.Id,
                Reason = "seed",
            });
        }

        await db.SaveChangesAsync();

        return new Box(device.Id, mac, tenant.DeviceApiKey!, tenant.Id, slug, courts[0].Id, member.Id,
            courts.ToDictionary(c => c.CourtNumber, c => c.Id), timezone);
    }

    /// <summary>
    /// The request a correctly-implemented firmware sends: the club's key in the
    /// Authorization header and the board's MAC in the body.
    ///
    /// <para>
    /// The MAC is spliced into the payload here rather than written at each of the sixty-odd
    /// call sites, because it is not what any of them is about — every device request
    /// carries it, exactly the way every one used to carry a signature.
    /// </para>
    /// </summary>
    private static HttpRequestMessage FromBox(Box box, string path, object payload)
    {
        var body = JsonSerializer.SerializeToNode(payload)!.AsObject();
        body["mac"] = box.Mac;

        var req = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", box.ApiKey);
        return req;
    }

    /// <summary>
    /// The QR the member's app renders: a sixty-second member-ident access code, minted the
    /// way the API mints it. Twelve characters, because the box's scanner pipeline carries
    /// twenty-four bytes and a JWT never fitted (review H2).
    /// </summary>
    private static Task<string> QrCodeAsync(TestWebAppFactory factory, Box box)
        => TestAccessCodes.MintIdentAsync(factory.Services, box.TenantId, box.Slug, box.MemberId);

    private static object Batch(params object[] events) => BatchAt(600_000, events);

    /// <summary>A batch sent at the given box uptime, so an event's own uptime says how long ago it happened.</summary>
    private static object BatchAt(long uptimeMs, params object[] events) => new { uptime_ms = uptimeMs, events };

    /// <summary>
    /// A batch from a NAMED BOOT. Most tests here do not care and send none, which is the
    /// legacy shape and means boot 0 — see <see cref="DeviceEventBatch"/>. A test about the
    /// idempotency key does care, because that is the whole question.
    /// </summary>
    private static object BatchFromBoot(long bootId, params object[] events) =>
        new { boot_id = bootId, uptime_ms = 600_000L, events };

    /// <summary>
    /// The five-field walk-up body: the court NUMBER the member selected and the box's
    /// per-purchase nonce, the same on every retry of the same purchase.
    /// </summary>
    private static object WalkUp(string? token, int minutes = 30, int court = 1, string? method = "qr", string? nonce = null) => new
    {
        minutes,
        method,
        token,
        court,
        nonce = nonce ?? Guid.NewGuid().ToString("N")[..16],
    };

    /// <summary>
    /// <c>court</c> is the RELAY INDEX the box lit (0–3), as <c>eventq::Event::court</c>
    /// carries it. Against <see cref="Batch"/>'s uptime the default puts the scan five
    /// minutes before the upload.
    /// </summary>
    private static object Activation(
        long seq, string subject = "tok-alice", int court = 0, long uptimeMs = 300_000, long durationMs = 2_700_000) => new
    {
        seq,
        uptime_ms = uptimeMs,
        kind = "activation",
        court,
        method = "qr",
        subject,
        duration_ms = durationMs,
    };

    /// <summary>
    /// The event a box queues when a relay opened again: a relay index and how long it was
    /// actually closed, and nothing else — no member, no booking. Against
    /// <see cref="Batch"/>'s uptime the defaults put the release at the upload instant.
    /// </summary>
    private static object Release(long seq, int court = 0, long heldMs = 2_700_000, long uptimeMs = 600_000) => new
    {
        seq,
        uptime_ms = uptimeMs,
        kind = "release",
        court,
        method = (string?)null,
        subject = "",
        duration_ms = heldMs,
    };

    /// <summary>
    /// Shuts the club <paramref name="minutes"/> from now, measured on the CLUB's clock, and
    /// hands back the instant it will shut at.
    ///
    /// <para>
    /// Closing time is the lever rather than the timezone because it moves in whole minutes:
    /// a zone can only place the club on the hour, and the sub-minute distance to closing is
    /// exactly what the truncation arithmetic is about.
    /// </para>
    /// </summary>
    private static async Task<DateTimeOffset> CloseInAsync(TestWebAppFactory factory, Box box, int minutes)
    {
        var zone = TimeZoneInfo.FindSystemTimeZoneById(box.Timezone);
        var local = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, zone);
        var closeMinute = (local.Hour * 60) + local.Minute + minutes;
        Assert.InRange(closeMinute, 1, 24 * 60);   // SeedAsync's zone is what guarantees this

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var row = await db.TenantSettings.IgnoreQueryFilters().SingleAsync(t => t.TenantId == box.TenantId);
        var settings = JsonNode.Parse(row.SettingsJson)!.AsObject();
        settings["day_end_minute"] = closeMinute;
        row.SettingsJson = settings.ToJsonString();
        await db.SaveChangesAsync();

        var midnightUtc = TimeZoneInfo.ConvertTimeToUtc(
            DateTime.SpecifyKind(local.Date, DateTimeKind.Unspecified), zone);
        return new DateTimeOffset(midnightUtc, TimeSpan.Zero).AddMinutes(closeMinute);
    }

    /// <summary>A live code minted by a different club, for one of its own members.</summary>
    private static async Task<string> ForeignCodeAsync(TestWebAppFactory factory)
    {
        var other = await SeedAsync(factory, topUpMinutes: 0);
        return await TestAccessCodes.MintIdentAsync(factory.Services, other.TenantId, other.Slug, other.MemberId);
    }

    // ---- the roster the box decides against (review C2) ----------------------

    private const string HeartbeatPath = "/api/v1/device/heartbeat";

    private sealed record Booked(Guid BookingId, string Code);

    /// <summary>
    /// A charged booking for the box's member on <paramref name="courtNumber"/>, with the
    /// BookingCharge on the ledger so a no-show sweep would have something to refund — the
    /// shape the C6 finding is about.
    /// </summary>
    private static async Task<Booked> BookAsync(
        TestWebAppFactory factory, Box box, int courtNumber, double startsInMinutes, int minutes = 45, bool mintCode = true)
    {
        using var scope = factory.Services.CreateScope();
        scope.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Multitenancy.ITenantContext>().Set(box.TenantId, box.Slug);
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var startsAt = DateTimeOffset.UtcNow.AddMinutes(startsInMinutes);
        var booking = new Booking
        {
            TenantId = box.TenantId,
            CourtId = box.CourtIds[courtNumber],
            UserId = box.MemberId,
            BookedByUserId = box.MemberId,
            PaidByUserId = box.MemberId,
            ActorUserId = box.MemberId,
            StartsAt = startsAt,
            EndsAt = startsAt.AddMinutes(minutes),
            SliceMinutes = 15,
            SliceCount = Math.Max(1, minutes / 15),
            AmountChargedMinutes = 15 * Math.Max(1, minutes / 15),   // its length in minutes (§1.1)
            Status = BookingStatus.Booked,
            ChargedAt = DateTimeOffset.UtcNow,
        };
        db.Bookings.Add(booking);
        db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = box.TenantId,
            UserId = box.MemberId,
            Type = LedgerEntryType.BookingCharge,
            AmountMinutes = -booking.AmountChargedMinutes,
            ActorUserId = box.MemberId,
            RelatedBookingId = booking.Id,
            Reason = "seed charge",
        });
        await db.SaveChangesAsync();

        var code = mintCode
            ? (await scope.ServiceProvider.GetRequiredService<AccessCodeService>().MintForBookingAsync(booking, TimeSpan.FromMinutes(5), default)).Code
            : "";
        return new Booked(booking.Id, code);
    }

    private static async Task<Booking> BookingAsync(TestWebAppFactory factory, Guid bookingId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.Bookings.IgnoreQueryFilters().AsNoTracking().SingleAsync(b => b.Id == bookingId);
    }

    private static async Task<List<AuditLog>> AuditAsync(TestWebAppFactory factory, Guid tenantId, string action)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.AuditLogs.IgnoreQueryFilters().Where(a => a.TenantId == tenantId && a.Action == action).ToListAsync();
    }

    private static async Task<List<LedgerEntry>> LedgerAsync(TestWebAppFactory factory, Guid bookingId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.LedgerEntries.IgnoreQueryFilters().Where(l => l.RelatedBookingId == bookingId).ToListAsync();
    }

    private static async Task<JsonElement> HeartbeatAsync(TestWebAppFactory factory, Box box)
    {
        var response = await factory.CreateClient().SendAsync(FromBox(box, HeartbeatPath, new { running_version = "1.0.0" }));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    /// <summary>
    /// The app with email stubbed into <paramref name="mail"/>. The sweep and the reversal
    /// both send, and neither may dial SMTP for every tenant in the shared database.
    /// </summary>
    private static WebApplicationFactory<Program> Quiet(TestWebAppFactory factory, StubEmailService mail)
        => factory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<Crusaders.Mainframe.Api.Email.IEmailService>();
            s.AddSingleton<Crusaders.Mainframe.Api.Email.IEmailService>(mail);
        }));

    /// <summary>One tick of the real no-show sweep, quietly.</summary>
    private static async Task SweepAsync(TestWebAppFactory factory)
    {
        await using var quiet = Quiet(factory, new StubEmailService());
        var worker = new NoShowWorker(quiet.Services, quiet.Services.GetRequiredService<IEventBus>(), NullLogger<NoShowWorker>.Instance);
        await worker.TickAsync(default);
    }

    private static async Task<int> BalanceAsync(TestWebAppFactory factory, Guid userId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.LedgerEntries.IgnoreQueryFilters().Where(l => l.UserId == userId).SumAsync(l => l.AmountMinutes);
    }

    /// <summary>Whole seconds, so a value that round-trips through timestamptz compares equal to itself.</summary>
    private static DateTimeOffset WholeSeconds(DateTimeOffset t) => DateTimeOffset.FromUnixTimeSeconds(t.ToUnixTimeSeconds());

    /// <summary>
    /// A booking that started ten minutes ago against a five-minute grace, swept as a
    /// no-show: refunded in full, penalised, released. The state a box that lost WiFi at
    /// the wrong moment finds when it reconnects.
    /// </summary>
    private static async Task<(Booked Booked, Booking Swept)> SweptNoShowAsync(TestWebAppFactory factory, Box box)
    {
        var booked = await BookAsync(factory, box, courtNumber: 1, startsInMinutes: -10);
        await SweepAsync(factory);

        var swept = await BookingAsync(factory, booked.BookingId);
        Assert.Equal(BookingStatus.NoShow, swept.Status);
        Assert.Null(swept.CheckedInAt);

        var settled = await LedgerAsync(factory, booked.BookingId);
        Assert.Equal(45, Assert.Single(settled, l => l.Type == LedgerEntryType.CancellationRefund).AmountMinutes);
        Assert.True(Assert.Single(settled, l => l.Type == LedgerEntryType.NoShowPenalty).AmountMinutes < 0);
        return (booked, swept);
    }

    /// <summary>
    /// The four settlement rows a reversed no-show leaves behind the charge, and the shape
    /// each must have: refund and penalty as the sweep posted them, a debit reversing the
    /// refund and a credit reversing the penalty — the same two types with the opposite
    /// sign, each carrying a reason and its own reference, never netted into one.
    /// </summary>
    private static async Task AssertReversedLedgerAsync(TestWebAppFactory factory, Guid bookingId)
    {
        var ledger = await LedgerAsync(factory, bookingId);
        Assert.Equal(5, ledger.Count);   // the seed charge, and the four settlement rows

        var refunds = ledger.Where(l => l.Type == LedgerEntryType.CancellationRefund).ToList();
        var penalties = ledger.Where(l => l.Type == LedgerEntryType.NoShowPenalty).ToList();
        Assert.Equal(2, refunds.Count);
        Assert.Equal(2, penalties.Count);
        Assert.Equal(0, refunds.Sum(l => l.AmountMinutes));
        Assert.Equal(0, penalties.Sum(l => l.AmountMinutes));

        var refundReversal = Assert.Single(refunds, l => l.AmountMinutes < 0);
        var penaltyReversal = Assert.Single(penalties, l => l.AmountMinutes > 0);
        Assert.Equal(BookingService.NoShowReversalReference(bookingId, "refund"), refundReversal.ExternalReference);
        Assert.Equal(BookingService.NoShowReversalReference(bookingId, "penalty"), penaltyReversal.ExternalReference);
        Assert.All(ledger, l => Assert.False(string.IsNullOrWhiteSpace(l.Reason)));
        Assert.All(ledger, l => Assert.Equal(bookingId, l.RelatedBookingId));
    }

    // ---- the resold tail (closing re-review #16) ------------------------------------

    /// <summary>
    /// A second booking on a court the first member was still playing on, so the box
    /// cannot lie about it. Written directly, at a start inside the tail the sweep released.
    /// </summary>
    private static async Task<Booked> BookOnTailAsync(
        TestWebAppFactory factory, Box box, Guid userId, double startsInMinutes, int minutes,
        BookingStatus status = BookingStatus.Booked, bool charged = true, bool mintCode = false)
    {
        using var scope = factory.Services.CreateScope();
        scope.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Multitenancy.ITenantContext>().Set(box.TenantId, box.Slug);
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var startsAt = DateTimeOffset.UtcNow.AddMinutes(startsInMinutes);
        var booking = new Booking
        {
            TenantId = box.TenantId,
            CourtId = box.CourtIds[1],
            UserId = userId,
            BookedByUserId = userId,
            PaidByUserId = userId,
            ActorUserId = userId,
            StartsAt = startsAt,
            EndsAt = startsAt.AddMinutes(minutes),
            SliceMinutes = 15,
            SliceCount = Math.Max(1, minutes / 15),
            AmountChargedMinutes = 15 * Math.Max(1, minutes / 15),   // its length in minutes (§1.1)
            Status = status,
            ChargedAt = charged ? DateTimeOffset.UtcNow : null,
        };
        db.Bookings.Add(booking);
        if (charged)
        {
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = box.TenantId, UserId = userId, Type = LedgerEntryType.BookingCharge,
                AmountMinutes = -booking.AmountChargedMinutes, ActorUserId = userId, RelatedBookingId = booking.Id, Reason = "seed charge",
            });
        }
        if (status == BookingStatus.NoShow)
        {
            // As the sweep would have left it: refunded in full, penalised 30%.
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = box.TenantId, UserId = userId, Type = LedgerEntryType.CancellationRefund,
                AmountMinutes = booking.AmountChargedMinutes, ActorUserId = Guid.Empty, RelatedBookingId = booking.Id, Reason = "No-show — booking refunded",
            });
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = box.TenantId, UserId = userId, Type = LedgerEntryType.NoShowPenalty,
                AmountMinutes = -(int)Math.Floor(booking.AmountChargedMinutes * 0.3m), ActorUserId = Guid.Empty, RelatedBookingId = booking.Id, Reason = "No-show penalty",
            });
        }
        await db.SaveChangesAsync();
        var code = mintCode
            ? (await scope.ServiceProvider.GetRequiredService<AccessCodeService>().MintForBookingAsync(booking, TimeSpan.FromMinutes(5), default)).Code
            : "";
        return new Booked(booking.Id, code);
    }

    /// <summary>A second funded member of the box's club.</summary>
    private static async Task<Guid> AnotherMemberAsync(TestWebAppFactory factory, Box box, int credits = 200)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var other = new User { TenantId = box.TenantId, Email = $"other-{Guid.NewGuid():N}@test.local", PasswordHash = "x", EmailVerified = true };
        db.Users.Add(other);
        db.Memberships.Add(new Membership
        {
            TenantId = box.TenantId, UserId = other.Id, FullName = "Second Buyer",
            MembershipNumber = $"o-{Guid.NewGuid():N}"[..20], Status = MembershipStatus.Active,
        });
        db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = box.TenantId, UserId = other.Id, Type = LedgerEntryType.TopUp, AmountMinutes = credits, ActorUserId = other.Id, Reason = "seed",
        });
        await db.SaveChangesAsync();
        return other.Id;
    }

    // ---- a cancelled booking lit from a stale roster (closing re-review #21) ---------

    private static async Task<CancellationResult.Ok> CancelAsync(
        TestWebAppFactory factory, Box box, Guid bookingId, bool waivePenalty = true)
    {
        using var scope = factory.Services.CreateScope();
        scope.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Multitenancy.ITenantContext>().Set(box.TenantId, box.Slug);
        var bookings = scope.ServiceProvider.GetRequiredService<BookingService>();
        var result = await bookings.CancelAsync(bookingId, Guid.NewGuid(), actorIsAdmin: true, waivePenalty, default);
        return Assert.IsType<CancellationResult.Ok>(result);
    }

    // ---- a replay grants the remainder, and nothing once over (closing re-review #20) --

    private static async Task ShiftWalkUpAsync(TestWebAppFactory factory, Guid bookingId, double startsInMinutes, double endsInMinutes, BookingStatus? status = null)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var row = await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.Id == bookingId);
        row.StartsAt = DateTimeOffset.UtcNow.AddMinutes(startsInMinutes);
        row.EndsAt = DateTimeOffset.UtcNow.AddMinutes(endsInMinutes);
        if (status is { } st) row.Status = st;
        await db.SaveChangesAsync();
    }

    // ---- the box can say the club is shut (finding M-F5) -----------------------------

    /// <summary>
    /// Closes the club around <b>now</b>, deterministically at every hour of the day.
    ///
    /// <para>
    /// A fixed window would be open for part of the day and shut for the rest, which is the
    /// wall-clock flake <c>memory/gotchas.md</c> records twice over. The window is chosen
    /// from the current minute-of-day instead — late in the day picks the first hour,
    /// early in the day picks the last — so it never contains now and never wraps midnight,
    /// which the operating-hours rule cannot express anyway. Returns what the API should
    /// quote back.
    /// </para>
    ///
    /// <para>
    /// <b>The minute-of-day is the CLUB's, not the runner's.</b> <c>day_start_minute</c> and
    /// <c>day_end_minute</c> are read against <c>settings.timezone</c>, and
    /// <see cref="SeedAsync"/> no longer leaves that at UTC — so a window chosen from
    /// <c>DateTimeOffset.UtcNow</c> is chosen against the wrong day the moment the two clocks
    /// disagree. That is the trap <c>memory/gotchas.md</c> names: every fixture that pinned
    /// <c>"timezone":"UTC"</c> has to move with the club.
    /// </para>
    ///
    /// <para>
    /// <b>It is not, today, a live defect, and the honest reason is worth writing down.</b>
    /// Substituting the runner's clock back in was run as a mutation and
    /// <c>A_walk_up_at_a_closed_club_is_refused_with_the_opening_hours</c> stayed green — because
    /// <see cref="SeedAsync"/>'s zone pins the club's local minute-of-day between 60 and
    /// <c>1440 - RelayHardCap.Minutes - 60</c> = 1290, and both candidate windows (0–60 and
    /// 1380–1440) sit outside that band, so the club comes out shut either way. The club is
    /// therefore closed by the band's arithmetic rather than by this method's, and the band is
    /// a number someone will change; measuring the club's own clock is what makes it not
    /// depend on that. No test goes red if this line is reverted — see the residue.
    /// </para>
    /// </summary>
    private static async Task<(string OpensAt, string ClosesAt)> CloseTheClubAsync(TestWebAppFactory factory, Box box)
    {
        var local = TimeZoneInfo.ConvertTime(
            DateTimeOffset.UtcNow, TimeZoneInfo.FindSystemTimeZoneById(box.Timezone));
        var minuteOfDay = (local.Hour * 60) + local.Minute;
        var (open, close) = minuteOfDay >= 720 ? (0, 60) : (1380, 1440);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var row = await db.TenantSettings.IgnoreQueryFilters().SingleAsync(t => t.TenantId == box.TenantId);
        row.SettingsJson = row.SettingsJson.TrimEnd('}') + $",\"day_start_minute\":{open},\"day_end_minute\":{close}}}";
        await db.SaveChangesAsync();

        return ($"{open / 60:D2}:{open % 60:D2}", $"{close / 60:D2}:{close % 60:D2}");
    }

    // ---- a working box is a reporting box (finding L-F5) -----------------------------

    /// <summary>Backdates the box's last-seen, as a silence of <paramref name="minutes"/> would.</summary>
    private static async Task<DateTimeOffset> WentQuietAsync(TestWebAppFactory factory, Box box, int minutes)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var device = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.Id == box.DeviceId);
        var quietAt = DateTimeOffset.UtcNow.AddMinutes(-minutes);
        device.LastSeenAt = quietAt;
        await db.SaveChangesAsync();
        return quietAt;
    }

    private static async Task<Device> DeviceAsync(TestWebAppFactory factory, Box box)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.Devices.IgnoreQueryFilters().AsNoTracking().SingleAsync(d => d.Id == box.DeviceId);
    }

    // ---- a membership the club has barred, at the box (finding K-F1) -----------------
    //
    // The critical of round 3: a suspended member walked up to the touchpad, was sold fifty
    // credits of court time and had the lights switched on, twice, while the console's own
    // suspend modal promised in those words that they could not "open a court at the box".
    // The guards existed on the pre-booked path and the roster and nowhere else, because a
    // walk-up CREATES its booking and so never met a candidate set.
    //
    // These drive every door a box can reach, over the real wire, and the theory varies the
    // MEMBERSHIP ROW alone — an Active row on the same fixture must still sell, or the tests
    // would pass just as well against a build that refused everybody.

    /// <summary>Moves the box's member into <paramref name="status"/>, changing nothing else.</summary>
    private static async Task SetMembershipAsync(TestWebAppFactory factory, Box box, MembershipStatus status)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var membership = await db.Memberships.IgnoreQueryFilters().SingleAsync(m => m.UserId == box.MemberId);
        membership.Status = status;
        await db.SaveChangesAsync();
    }

    private static async Task<bool> CodeIsLiveAsync(TestWebAppFactory factory, string code)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var row = await db.AccessCodes.IgnoreQueryFilters().AsNoTracking().FirstOrDefaultAsync(c => c.Code == code);
        return row is not null && row.IsLiveAt(DateTimeOffset.UtcNow);
    }

    private static async Task<bool> BookingHasLiveCodeAsync(TestWebAppFactory factory, Guid bookingId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var now = DateTimeOffset.UtcNow;
        return await db.AccessCodes.IgnoreQueryFilters().AsNoTracking()
            .AnyAsync(c => c.BookingId == bookingId && c.ExpiresAt > now);
    }
}

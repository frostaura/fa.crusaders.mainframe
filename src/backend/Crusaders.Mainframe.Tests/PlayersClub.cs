using System.Collections.Concurrent;
using System.IdentityModel.Tokens.Jwt;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.IdentityModel.Tokens;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// A club for the players-and-splits suites (D11–D13): an admin, an organiser, three partners and
/// a bystander, one 8-credit court, a UTC day that runs round the clock, and quiet hours switched
/// OFF so a mail's timing is never the hour the suite happens to run at (the quiet-hours test turns
/// them on itself). Every address is <c>*.review.test</c>.
///
/// <para>
/// A fresh slug per club, because the whole Postgres tier shares one database — which is also
/// what makes a second club a real cross-tenant probe.
/// </para>
/// </summary>
public sealed class PlayersClub
{
    public const string Secret = "test-only-signing-key-not-used-in-any-real-environment";

    public const string Settings =
        """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"grace_window_minutes":5,"penalty_window_minutes":15,"penalty_pct":30,"timezone":"UTC","member_quiet_start_minute":0,"member_quiet_end_minute":0}""";

    public Guid TenantId { get; private init; }
    public string Slug { get; private init; } = "";
    public Guid CourtId { get; private init; }
    public Guid Admin { get; private init; }
    public Guid Organiser { get; private init; }
    public Guid Sam { get; private init; }
    public Guid Alex { get; private init; }
    public Guid Jo { get; private init; }
    public Guid Bystander { get; private init; }

    public static async Task<PlayersClub> SeedAsync(WebApplicationFactory<Program> factory, string prefix, string settings = Settings)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"{(prefix.Length > 12 ? prefix[..12] : prefix)}-{Guid.NewGuid():N}"[..25];
        var tenant = new Tenant
        {
            Slug = slug, DisplayName = $"Club {slug}",
            DeviceApiKey = DeviceApiKey.Generate(), DeviceApiKeyRegeneratedAt = DateTimeOffset.UtcNow,
        };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = settings });
        var court = new Court { TenantId = tenant.Id, CourtNumber = 1, Name = "Court 1" };
        db.Courts.Add(court);

        var club = new PlayersClub
        {
            TenantId = tenant.Id, Slug = slug, CourtId = court.Id,
            Admin = Person(db, tenant.Id, slug, "Ada Admin", isAdmin: true),
            Organiser = Person(db, tenant.Id, slug, "Olive Organiser"),
            Sam = Person(db, tenant.Id, slug, "Sam Partner"),
            Alex = Person(db, tenant.Id, slug, "Alex Partner"),
            Jo = Person(db, tenant.Id, slug, "Jo Partner"),
            Bystander = Person(db, tenant.Id, slug, "Bea Bystander"),
        };
        await db.SaveChangesAsync();
        return club;
    }

    private static Guid Person(MainframeDbContext db, Guid tenantId, string slug, string name, bool isAdmin = false)
    {
        var handle = name.ToLowerInvariant().Replace(' ', '.');
        var user = new User
        {
            TenantId = tenantId, Email = $"{handle}@{slug}.review.test", PasswordHash = "x",
            EmailVerified = true, IsAdmin = isAdmin,
        };
        db.Users.Add(user);
        db.Memberships.Add(new Membership
        {
            TenantId = tenantId, UserId = user.Id, FullName = name,
            MembershipNumber = $"{handle}-{Guid.NewGuid():N}"[..20], Status = MembershipStatus.Active,
        });
        return user.Id;
    }

    public HttpClient Client(WebApplicationFactory<Program> factory, Guid userId, bool admin = false)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", Token(userId, admin));
        return client;
    }

    public string Token(Guid userId, bool admin)
    {
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, userId.ToString()),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString()),
            new("tenant_id", TenantId.ToString()),
            new("tenant_slug", Slug),
            new("purpose", "access"),
        };
        if (admin) claims.Add(new Claim(ClaimTypes.Role, "admin"));
        var token = new JwtSecurityToken(
            issuer: "crusaders.mainframe", audience: "crusaders.mainframe.app", claims: claims,
            notBefore: DateTime.UtcNow, expires: DateTime.UtcNow.AddMinutes(10),
            signingCredentials: new SigningCredentials(new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Secret)), SecurityAlgorithms.HmacSha256));
        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    // ------------------------------------------------------------------ money and rows

    public async Task CreditAsync(WebApplicationFactory<Program> factory, Guid userId, int credits)
    {
        await WriteAsync(factory, db => db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = TenantId, UserId = userId, Type = LedgerEntryType.TopUp, AmountMinutes = credits,
            ActorUserId = Guid.Empty, Reason = "fixture float",
        }));
    }

    public static async Task<decimal> BalanceAsync(WebApplicationFactory<Program> factory, Guid userId) =>
        await ReadAsync(factory, db => db.LedgerEntries.IgnoreQueryFilters().Where(l => l.UserId == userId).SumAsync(l => l.AmountMinutes));

    public async Task<List<LedgerEntry>> SharesAsync(WebApplicationFactory<Program> factory, Guid bookingId) =>
        await ReadAsync(factory, db => db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.TenantId == TenantId && l.RelatedBookingId == bookingId && l.Type == LedgerEntryType.ShareTransfer)
            .OrderBy(l => l.CreatedAt).ToListAsync());

    public async Task<List<BookingParticipant>> SeatsAsync(WebApplicationFactory<Program> factory, Guid bookingId) =>
        await ReadAsync(factory, db => db.BookingParticipants.IgnoreQueryFilters()
            .Where(p => p.BookingId == bookingId).OrderBy(p => p.Seat).ThenBy(p => p.CreatedAt).ToListAsync());

    /// <summary>
    /// A charged booking written straight to the table, anywhere on the clock — for a game in the
    /// past or about to start, which the booking rules would (rightly) refuse to create.
    /// </summary>
    public async Task<Guid> InsertBookingAsync(
        WebApplicationFactory<Program> factory, DateTimeOffset startsAt, int slices = 4, Guid? organiser = null)
    {
        var booking = new Booking
        {
            TenantId = TenantId, CourtId = CourtId, UserId = organiser ?? Organiser, BookedByUserId = organiser ?? Organiser,
            PaidByUserId = organiser ?? Organiser, ActorUserId = organiser ?? Organiser, StartsAt = startsAt,
            EndsAt = startsAt.AddMinutes(15 * slices), SliceMinutes = 15, SliceCount = slices,
            AmountChargedMinutes = 8 * slices, Status = BookingStatus.Booked, ChargedAt = startsAt.AddDays(-1),
        };
        await WriteAsync(factory, db =>
        {
            db.Bookings.Add(booking);
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = TenantId, UserId = booking.UserId!.Value, Type = LedgerEntryType.BookingCharge,
                AmountMinutes = -booking.AmountChargedMinutes, ActorUserId = booking.UserId.Value, RelatedBookingId = booking.Id,
            });
        });
        return booking.Id;
    }

    /// <summary>A seat written straight to the table, for states the API only reaches with time.</summary>
    public async Task<Guid> InsertSeatAsync(
        WebApplicationFactory<Program> factory, Guid bookingId, int seat, Guid? userId, ParticipantStatus status,
        int share, DateTimeOffset? invitedAt = null)
    {
        var row = new BookingParticipant
        {
            TenantId = TenantId, BookingId = bookingId, Seat = seat, UserId = userId, Status = status,
            ShareMinutes = share, ShareWeight = 1, SplitMode = seat == 1 ? SplitModes.Equal : null,
            InvitedAt = invitedAt ?? DateTimeOffset.UtcNow, CreatedAt = DateTimeOffset.UtcNow, UpdatedAt = DateTimeOffset.UtcNow,
        };
        await WriteAsync(factory, db => db.BookingParticipants.Add(row));
        return row.Id;
    }

    public async Task WriteAsync(WebApplicationFactory<Program> factory, Action<MainframeDbContext> write)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        write(db);
        await db.SaveChangesAsync();
    }

    public static async Task<T> ReadAsync<T>(WebApplicationFactory<Program> factory, Func<MainframeDbContext, Task<T>> read)
    {
        using var scope = factory.Services.CreateScope();
        return await read(scope.ServiceProvider.GetRequiredService<MainframeDbContext>());
    }

    /// <summary>Runs <paramref name="work"/> in a scope whose tenant is this club — a service called as a worker would call it.</summary>
    public async Task<T> InClubAsync<T>(WebApplicationFactory<Program> factory, Func<IServiceProvider, Task<T>> work)
    {
        using var scope = factory.Services.CreateScope();
        scope.ServiceProvider.GetRequiredService<Api.Multitenancy.ITenantContext>().Set(TenantId, Slug);
        return await work(scope.ServiceProvider);
    }

    // ------------------------------------------------------------------ http

    /// <summary>Tomorrow at <paramref name="hour"/>, UTC — outside every penalty window, before every peak.</summary>
    public static DateTimeOffset Tomorrow(int hour = 8) => new(DateTimeOffset.UtcNow.AddDays(1).Date.AddHours(hour), TimeSpan.Zero);

    /// <summary>Books a court as the organiser with <paramref name="players"/>. Answers the booking id and the response.</summary>
    public async Task<(Guid BookingId, JsonElement Body)> BookWithPlayersAsync(
        WebApplicationFactory<Program> factory, object[] players, string splitMode = "equal", DateTimeOffset? at = null, int slices = 4)
    {
        var response = await Client(factory, Organiser).PostAsJsonAsync("/api/v1/bookings", new
        {
            courtId = CourtId, startsAt = at ?? Tomorrow(), sliceCount = slices, players, splitMode,
        });
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"booking refused: {(int)response.StatusCode} {body}");
        return (body.GetProperty("booking_id").GetGuid(), body);
    }

    public static Guid SeatOf(JsonElement bookBody, int seat) =>
        bookBody.GetProperty("players").GetProperty("participants").EnumerateArray()
            .First(p => p.GetProperty("seat").GetInt32() == seat).GetProperty("participant_id").GetGuid();

    public static string? TokenOf(JsonElement bookBody, int seat) =>
        bookBody.GetProperty("players").GetProperty("participants").EnumerateArray()
            .First(p => p.GetProperty("seat").GetInt32() == seat).GetProperty("invite_token").GetString();
}

/// <summary>A mail server that keeps what it was handed, in the order it was handed it (C8 asserts the order).</summary>
public sealed class CapturingMail : IEmailService
{
    public ConcurrentQueue<EmailMessage> Sent { get; } = [];

    public Task SendAsync(EmailMessage message, CancellationToken ct = default)
    {
        Sent.Enqueue(message);
        return Task.CompletedTask;
    }

    public static WebApplicationFactory<Program> On(TestWebAppFactory factory, CapturingMail mail) =>
        factory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IEmailService>();
            s.AddSingleton<IEmailService>(mail);
        }));
}

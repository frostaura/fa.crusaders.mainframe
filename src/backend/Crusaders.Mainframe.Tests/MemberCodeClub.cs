using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// A club for the member-code HTTP tests: four courts, an acknowledged court box on all four, a
/// named door, and three active members with known REFs — Olga the organiser, Pam the payer,
/// Sid who is later suspended — plus the arithmetic to compute any of their codes at any step.
/// </summary>
internal sealed class MemberCodeClub
{
    public const string Settings =
        """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"grace_window_minutes":5,"timezone":"Africa/Johannesburg","heartbeat_seconds":45}""";

    public required Guid TenantId { get; init; }
    public required string Slug { get; init; }
    public required string DeviceKey { get; init; }
    public required Guid AdminId { get; init; }
    public required Guid Olga { get; init; }
    public required Guid Pam { get; init; }
    public required Guid Sid { get; init; }
    public required Guid OlgaMembership { get; init; }
    public required Guid SidMembership { get; init; }
    public required List<Guid> Courts { get; init; }
    public required string BoxMac { get; init; }
    public required string DoorMac { get; init; }
    public required Dictionary<Guid, int> Refs { get; init; }

    /// <summary>The club's zone as seeded — what the server keys its day (and so every K_day) on.</summary>
    public string Zone { get; init; } = "Africa/Johannesburg";

    /// <summary>
    /// <see cref="Settings"/> in a club whose local noon is now — for a test about something other
    /// than the club's midnight. A booking or walk-up bought in the last hour of a club day runs
    /// into the midnight close (pro-rata price) or into tomorrow's key, so a test that pins the
    /// Johannesburg zone is red for part of every day for reasons that are not its subject.
    /// </summary>
    public static string SettingsAtNoon() => Settings.Replace("Africa/Johannesburg", ZoneWhoseNoonIsNow());

    /// <summary>
    /// A fixed-offset IANA zone (<c>Etc/GMT±N</c>) whose local hour is 12 at the current UTC hour,
    /// so its midnight is at least eleven hours from any instant a test can reach. Note the tzdb's
    /// inverted sign: <c>Etc/GMT-2</c> is UTC+2.
    /// </summary>
    public static string ZoneWhoseNoonIsNow()
    {
        var east = 12 - DateTimeOffset.UtcNow.Hour;
        return east == 0 ? "Etc/GMT" : $"Etc/GMT{(east > 0 ? "-" : "+")}{Math.Abs(east)}";
    }

    /// <param name="clock">
    /// Pins the instant the door and pay-for decide at — and so the 30 s code step they check.
    /// A test that builds a code at <c>clock.Now</c> and sends it can then never have a step
    /// boundary fall between the two (<c>memory/gotchas-clock.md</c>). Unset: the real clock.
    /// </param>
    public static WebApplicationFactory<Program> Wired(TestWebAppFactory factory, StubEmailService mail, PinnedClock? clock = null) =>
        factory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IEmailService>();
            s.AddSingleton<IEmailService>(mail);
            if (clock is not null)
            {
                s.RemoveAll<TimeProvider>();
                s.AddSingleton<TimeProvider>(clock);
            }
        }));

    public static async Task<MemberCodeClub> SeedAsync(
        WebApplicationFactory<Program> app, string prefix, string settings = Settings, int[]? refValues = null)
    {
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        // No MigrateAsync: the database is a clone of the template PostgresFixture migrated once.

        var slug = $"{(prefix.Length > 10 ? prefix[..10] : prefix)}-{Guid.NewGuid():N}"[..24];
        var tenant = new Tenant
        {
            Slug = slug, DisplayName = $"Club {slug}",
            DeviceApiKey = DeviceApiKey.Generate(), DeviceApiKeyRegeneratedAt = DateTimeOffset.UtcNow,
        };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = settings });

        var courts = Enumerable.Range(1, 4)
            .Select(n => new Court { TenantId = tenant.Id, CourtNumber = n, Name = $"Court {n}" })
            .ToList();
        db.Courts.AddRange(courts);

        var refs = refValues ?? [.. Enumerable.Range(0, 4).Select(_ => Random.Shared.Next(1, MemberCodeMath.MaxRefValue))];
        var (admin, _) = Person(db, tenant.Id, slug, "adm", "Ada Admin", true);
        var (olga, olgaM) = Person(db, tenant.Id, slug, "olga", "Olga Organiser", false);
        var (pam, _) = Person(db, tenant.Id, slug, "pam", "Pam Payer", false);
        var (sid, sidM) = Person(db, tenant.Id, slug, "sid", "Sid Suspended", false);
        var people = new[] { admin, olga, pam, sid };
        var refMap = new Dictionary<Guid, int>();
        for (var i = 0; i < people.Length; i++)
        {
            refMap[people[i]] = refs[i];
            db.MemberCodes.Add(new MemberCode { TenantId = tenant.Id, UserId = people[i], Ref = refs[i] });
        }

        var boxMac = Guid.NewGuid().ToString("N")[..12];
        var doorMac = Guid.NewGuid().ToString("N")[..12];
        db.Devices.Add(new Device
        {
            TenantId = tenant.Id, DeviceCode = $"box-{boxMac[^6..]}", Name = "Box", Kind = DeviceKind.CourtBox,
            MacAddress = boxMac, CourtNumbers = [1, 2, 3, 4], AutoRegistered = false,
        });
        db.Devices.Add(new Device
        {
            TenantId = tenant.Id, DeviceCode = $"gate-{doorMac[^6..]}", Name = "Front door", Kind = DeviceKind.Gate,
            Hardware = DeviceHardware.Esp32, MacAddress = doorMac, GateKey = "front-door",
        });

        foreach (var p in new[] { olga, pam, sid })
        {
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = tenant.Id, UserId = p, Type = LedgerEntryType.TopUp, AmountMinutes = 200,
                ActorUserId = p, Reason = "seed",
            });
        }

        await db.SaveChangesAsync();
        return new MemberCodeClub
        {
            TenantId = tenant.Id, Slug = slug, DeviceKey = tenant.DeviceApiKey!, AdminId = admin,
            Olga = olga, Pam = pam, Sid = sid, OlgaMembership = olgaM, SidMembership = sidM,
            Courts = [.. courts.Select(c => c.Id)], BoxMac = boxMac, DoorMac = doorMac, Refs = refMap,
            Zone = JsonDocument.Parse(settings).RootElement.TryGetProperty("timezone", out var tz) ? tz.GetString()! : "UTC",
        };
    }

    private static (Guid User, Guid Membership) Person(MainframeDbContext db, Guid tenantId, string slug, string handle, string name, bool admin)
    {
        var user = new User
        {
            TenantId = tenantId, Email = $"{handle}-{slug}@test.local", PasswordHash = new Pbkdf2PasswordHasher().Hash("OldPass!123"),
            EmailVerified = true, IsAdmin = admin,
        };
        db.Users.Add(user);
        var m = new Membership
        {
            TenantId = tenantId, UserId = user.Id, FullName = name, MembershipNumber = $"{handle}-{slug}", Status = MembershipStatus.Active,
        };
        db.Memberships.Add(m);
        return (user.Id, m.Id);
    }

    // ---- Codes ------------------------------------------------------------------------------------

    /// <summary>The master key the factory host runs with — see <see cref="TestWebAppFactory.TestMemberCodeMasterKey"/>.</summary>
    public static byte[] MasterKey => Convert.FromBase64String(TestWebAppFactory.TestMemberCodeMasterKey);

    /// <param name="tz">The zone whose day keys the OFF half. Unset: the club's own (<see cref="Zone"/>).</param>
    public string Code(Guid user, DateTimeOffset? at = null, int generation = 1, long stepOffset = 0, string? tz = null)
    {
        var secret = MemberCodeMath.MemberSecret(MasterKey, TenantId, user, generation);
        var step = MemberCodeMath.StepOf(at ?? DateTimeOffset.UtcNow) + stepOffset;
        return MemberCodeMath.Token(MemberCodeMath.RefText(Refs[user]), secret, step, MemberCodeMath.ZoneOf(tz ?? Zone));
    }

    /// <summary>The same code with its ON half garbled — what a holder of K_day but not S would make.</summary>
    public string ForgedOn(Guid user, DateTimeOffset? at = null)
    {
        var real = Code(user, at);
        var on = real.Substring(5, 8);
        var wrong = ((long.Parse(on) + 1) % 100_000_000).ToString("00000000");
        return real[..5] + wrong + real[13..];
    }

    // ---- Wire -------------------------------------------------------------------------------------

    public HttpRequestMessage Device(string path, JsonObject body)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", DeviceKey);
        return req;
    }

    public HttpRequestMessage Heartbeat(string mac, bool m1, string? kind = null)
    {
        var body = new JsonObject { ["mac"] = mac, ["firmware_version"] = m1 ? "2.1.0" : "2.0.0", ["uptime_ms"] = 86_400_000 };
        if (kind is not null) body["kind"] = kind;
        if (m1) body["caps"] = new JsonArray("codes:m1");
        return Device("/api/v1/device/heartbeat", body);
    }

    public HttpRequestMessage Gate(string token) =>
        Device("/api/v1/device/gate", new JsonObject { ["mac"] = DoorMac, ["method"] = "qr", ["token"] = token });

    public HttpRequestMessage Activate(string token, long? scanAge = null)
    {
        var body = new JsonObject { ["mac"] = BoxMac, ["method"] = "qr", ["token"] = token };
        if (scanAge is not null) body["scan_age_ms"] = scanAge;
        return Device("/api/v1/device/activate", body);
    }

    public HttpRequestMessage WalkUp(string token, int court, string nonce, int minutes = 15) =>
        Device("/api/v1/device/walkup", new JsonObject
        {
            ["mac"] = BoxMac, ["minutes"] = minutes, ["method"] = "qr", ["token"] = token, ["court"] = court, ["nonce"] = nonce,
        });

    public HttpRequestMessage PayFor(string token, int court, string nonce, bool confirm, string? label = null, string? mac = null)
    {
        var body = new JsonObject
        {
            ["mac"] = mac ?? BoxMac, ["method"] = "qr", ["token"] = token, ["court"] = court, ["nonce"] = nonce, ["confirm"] = confirm,
        };
        if (label is not null) body["amount_label"] = label;
        return Device("/api/v1/device/pay-for", body);
    }

    /// <summary>One uploaded event. <paramref name="agoMs"/> is how long before the upload it happened; negative claims the future (a broken counter, which the server clamps).</summary>
    public HttpRequestMessage Events(string mac, long seq, string kind, int court, string subject, long bootId = 7, long agoMs = 1_000)
    {
        return Device("/api/v1/device/events", new JsonObject
        {
            ["mac"] = mac, ["boot_id"] = bootId, ["uptime_ms"] = 100_000_000,
            ["events"] = new JsonArray(new JsonObject
            {
                ["seq"] = seq, ["uptime_ms"] = 100_000_000 - agoMs, ["kind"] = kind, ["court"] = court, ["method"] = "qr",
                ["subject"] = subject, ["duration_ms"] = 600_000,
            }),
        });
    }

    public HttpClient Member(WebApplicationFactory<Program> app, Guid user, string? role = null)
    {
        var club = new DoorClub(TenantId, Slug, DeviceKey, AdminId, user, Courts[0]);
        var client = app.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", club.TokenFor(user, role));
        return client;
    }

    /// <summary>A client carrying a bearer token, as the PWA holds one.</summary>
    public HttpClient Bearer(WebApplicationFactory<Program> app, string token)
    {
        var client = app.CreateClient();
        client.DefaultRequestHeaders.Host = $"{Slug}.crusaders.test";
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return client;
    }

    /// <summary>A real sign-in through <c>/auth/login</c> — the token the server itself mints. Every seeded person's password is <c>OldPass!123</c>.</summary>
    public async Task<string> LoginAsync(WebApplicationFactory<Program> app, string handle, string password = "OldPass!123")
    {
        var client = app.CreateClient();
        client.DefaultRequestHeaders.Host = $"{Slug}.crusaders.test";
        var response = await client.PostAsync("/api/v1/auth/login", new StringContent(
            new JsonObject { ["email"] = $"{handle}-{Slug}@test.local", ["password"] = password }.ToJsonString(), Encoding.UTF8, "application/json"));
        response.EnsureSuccessStatusCode();
        return (await JsonAsync(response)).GetProperty("access_token").GetString()!;
    }

    public static async Task<JsonElement> JsonAsync(HttpResponseMessage response) =>
        JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;

    // ---- Database ---------------------------------------------------------------------------------

    public async Task<Booking> BookAsync(
        WebApplicationFactory<Program> app, Guid user, int courtIndex, int startsInMinutes, int minutes = 60, bool checkedIn = false)
    {
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var startsAt = DateTimeOffset.UtcNow.AddMinutes(startsInMinutes).Storable();
        var booking = new Booking
        {
            TenantId = TenantId, CourtId = Courts[courtIndex], UserId = user, BookedByUserId = user, PaidByUserId = user,
            ActorUserId = user, StartsAt = startsAt, EndsAt = startsAt.AddMinutes(minutes), SliceMinutes = 15,
            SliceCount = minutes / 15, AmountChargedMinutes = 15 * (minutes / 15), Status = BookingStatus.Booked,
            ChargedAt = DateTimeOffset.UtcNow, CheckedInAt = checkedIn ? DateTimeOffset.UtcNow.Storable() : null,
        };
        db.Bookings.Add(booking);
        db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = TenantId, UserId = user, Type = LedgerEntryType.BookingCharge, AmountMinutes = -booking.AmountChargedMinutes,
            ActorUserId = user, RelatedBookingId = booking.Id, Reason = "seed charge",
        });
        await db.SaveChangesAsync();
        return booking;
    }

    public async Task<T> ReadAsync<T>(WebApplicationFactory<Program> app, Func<MainframeDbContext, Task<T>> read)
    {
        using var scope = app.Services.CreateScope();
        return await read(scope.ServiceProvider.GetRequiredService<MainframeDbContext>());
    }

    public async Task WriteAsync(WebApplicationFactory<Program> app, Func<MainframeDbContext, Task> write)
    {
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await write(db);
        await db.SaveChangesAsync();
    }

    public Task<int> BalanceAsync(WebApplicationFactory<Program> app, Guid user) =>
        ReadAsync(app, db => db.LedgerEntries.IgnoreQueryFilters().Where(l => l.TenantId == TenantId && l.UserId == user).SumAsync(l => l.AmountMinutes));

    public Task<int> UsesAsync(WebApplicationFactory<Program> app, string? useClass = null) =>
        ReadAsync(app, db => db.MemberCodeUses.IgnoreQueryFilters()
            .CountAsync(u => u.TenantId == TenantId && (useClass == null || u.UseClass == useClass)));

    /// <summary>Writes a settings key straight into the document, as a hand edit or the cut-over would.</summary>
    public Task SetAsync(WebApplicationFactory<Program> app, string key, object value) => WriteAsync(app, async db =>
    {
        var row = await db.TenantSettings.IgnoreQueryFilters().FirstAsync(s => s.TenantId == TenantId);
        var doc = JsonNode.Parse(row.SettingsJson)!.AsObject();
        doc[key] = JsonValue.Create(value);
        row.SettingsJson = doc.ToJsonString();
    });

    public Task SetPhaseAsync(WebApplicationFactory<Program> app, string phase, DateTimeOffset? cutoverAt = null) => WriteAsync(app, async db =>
    {
        var row = await db.TenantSettings.IgnoreQueryFilters().FirstAsync(s => s.TenantId == TenantId);
        var doc = JsonNode.Parse(row.SettingsJson)!.AsObject();
        doc[MemberCodeSettings.PhaseKey] = phase;
        doc[MemberCodeSettings.CutoverAtKey] = (cutoverAt ?? DateTimeOffset.UtcNow).ToString("O");
        row.SettingsJson = doc.ToJsonString();
    });
}

/// <summary>
/// A wall clock that stands still at <see cref="Now"/> — the instant a test built its codes at.
/// Pinned to the real time at construction, so everything the server reads from
/// <c>DateTimeOffset.UtcNow</c> (bookings, claims) stays seconds away from it.
/// </summary>
internal sealed class PinnedClock(DateTimeOffset now) : TimeProvider
{
    public PinnedClock() : this(DateTimeOffset.UtcNow) { }

    public DateTimeOffset Now { get; } = now;

    public override DateTimeOffset GetUtcNow() => Now;
}

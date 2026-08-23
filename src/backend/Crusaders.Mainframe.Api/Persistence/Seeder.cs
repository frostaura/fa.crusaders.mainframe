using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Security;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Persistence;

/// <summary>
/// Idempotent seed for the Crusaders pilot tenant. Run on startup in Development.
/// In production, tenant onboarding goes through the platform-admin onboarding wizard.
/// </summary>
public static class Seeder
{
    public const string CrusadersSlug = "crusaders";
    public const string DefaultAdminEmail = "any@frostaura.net";
    public const string DefaultAdminPassword = "ChangeMeOnFirstLogin!";

    public static async Task SeedAsync(IServiceProvider services, ILogger logger)
    {
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        var hasher = scope.ServiceProvider.GetRequiredService<IPasswordHasher>();

        // Schema comes from EF migrations under Migrations/ — nothing is patched here.
        //
        // This block previously carried ~35 lines of raw ALTER TABLE / CREATE TABLE
        // that ran in Development only, which meant eight columns and the whole
        // webauthn_credentials table existed on developer machines and nowhere else.
        // A production boot against a fresh database could not work, and CI never
        // noticed because the tests run on the in-memory provider. The migration now
        // covers all of it; re-adding DDL here is choosing that defect again.

        // Use IgnoreQueryFilters everywhere here — we're operating above tenancy.
        var tenant = await db.Tenants.IgnoreQueryFilters().FirstOrDefaultAsync(t => t.Slug == CrusadersSlug);
        if (tenant is null)
        {
            tenant = new Tenant
            {
                Slug = CrusadersSlug,
                DisplayName = "Crusaders Squash Club",
                Status = "active",
            };
            db.Tenants.Add(tenant);
            db.TenantSettings.Add(new TenantSettings
            {
                TenantId = tenant.Id,
                SettingsJson = """
                {
                  "slice_minutes": 15,
                  "slice_price_credits": 8.00,
                  "penalty_pct": 30.0,
                  "grace_window_minutes": 5,
                  "penalty_window_minutes": 15,
                  "advance_booking_days": 14,
                  "credits_per_zar_regular": 1.6,
                  "credits_per_zar_league": 2.4,
                  "topup_block_zar": 100.00,
                  "topup_max_zar_per_member": 1000.00,
                  "member_per_day_max_minutes": 60,
                  "peak_hours": "16:00-19:00",
                  "peak_advance_hours_for_regular": 1,
                  "retention_years": 2,
                  "operating_hours": {
                    "mon": "06:00-22:00", "tue": "06:00-22:00", "wed": "06:00-22:00",
                    "thu": "06:00-22:00", "fri": "06:00-22:00",
                    "sat": "07:00-20:00", "sun": "07:00-20:00"
                  },
                  "timezone": "Africa/Johannesburg",
                  "brand_accent_hex": "#7AB07A",
                  "payfast": {
                    "merchant_id": "REPLACE_WITH_PAYFAST_MERCHANT_ID",
                    "merchant_key": "REPLACE_WITH_PAYFAST_MERCHANT_KEY",
                    "passphrase": "REPLACE_WITH_PAYFAST_PASSPHRASE",
                    "environment": "test"
                  }
                }
                """,
            });
            await db.SaveChangesAsync();
            logger.LogInformation("Seeded tenant {Slug} ({Id})", tenant.Slug, tenant.Id);
        }

        // Set tenant context for the rest of the seed so query-filtered tables work normally.
        tenantContext.Set(tenant.Id, tenant.Slug);

        // Default admin user
        var adminEmail = DefaultAdminEmail.ToLowerInvariant();
        var admin = await db.Users.FirstOrDefaultAsync(u => u.Email == adminEmail);
        if (admin is null)
        {
            admin = new User
            {
                TenantId = tenant.Id,
                Email = adminEmail,
                PasswordHash = hasher.Hash(DefaultAdminPassword),
                EmailVerified = true,
                IsAdmin = true,
                Status = "active",
            };
            db.Users.Add(admin);
            db.Memberships.Add(new Membership
            {
                TenantId = tenant.Id,
                UserId = admin.Id,
                FullName = "Crusaders Admin",
                MembershipNumber = "ADMIN-0001",
                Status = MembershipStatus.Active,
            });
            await db.SaveChangesAsync();
            logger.LogInformation("Seeded admin user {Email}", adminEmail);
        }
        else if (!hasher.Verify(DefaultAdminPassword, admin.PasswordHash ?? ""))
        {
            // Dev convenience: keep the seeded admin signable-in via the dev shortcut, even if the
            // password drifted (e.g. after admin self-reset during a test run). Stamps every restart.
            admin.PasswordHash = hasher.Hash(DefaultAdminPassword);
            await db.SaveChangesAsync();
            logger.LogInformation("Reset seeded admin {Email} password to dev default", adminEmail);
        }

        // Four courts
        if (!await db.Courts.AnyAsync())
        {
            for (var i = 1; i <= 4; i++)
            {
                db.Courts.Add(new Court
                {
                    TenantId = tenant.Id,
                    CourtNumber = i,
                    Name = $"Court {i}",
                    CourtType = CourtType.Squash,
                    SlicePriceCredits = 50.00m,
                });
            }
            await db.SaveChangesAsync();
            logger.LogInformation("Seeded 4 squash courts");
        }

        await SeedSampleMembersAndBookingsAsync(db, tenant.Id, admin.Id, logger);
    }

    private static readonly (string FullName, string MembershipNumber, string Email, string Hex, MemberClass Class)[] SampleMembers =
    {
        ("Naledi Khoza",       "MEM-1001", "naledi@sample.local", "#7AB07A", MemberClass.Regular),
        ("Liam O'Connor",      "MEM-1002", "liam@sample.local",   "#5B8DEF", MemberClass.LeagueOrSenior),
        ("Aisha Patel",        "MEM-1003", "aisha@sample.local",  "#E07A7A", MemberClass.Regular),
        ("Sipho Dlamini",      "MEM-1004", "sipho@sample.local",  "#F2B441", MemberClass.LeagueOrSenior),
        ("Mia van der Merwe",  "MEM-1005", "mia@sample.local",    "#A07AC0", MemberClass.Regular),
    };

    private static async Task SeedSampleMembersAndBookingsAsync(
        MainframeDbContext db, Guid tenantId, Guid adminUserId, ILogger logger)
    {
        // Idempotent: skip if any sample member already exists.
        var existing = await db.Memberships
            .Where(m => SampleMembers.Select(s => s.MembershipNumber).Contains(m.MembershipNumber))
            .Select(m => m.MembershipNumber)
            .ToListAsync();
        // Members are seeded once. Bookings are reseeded each boot (each day's slots are
        // gated by an exact-match exists check below) so today's grid always has data.

        var courts = await db.Courts.OrderBy(c => c.CourtNumber).ToListAsync();
        if (courts.Count == 0) return;

        // Pre-create each missing user + membership + opening top-up.
        var createdUsers = new Dictionary<string, Guid>();
        foreach (var s in SampleMembers)
        {
            if (existing.Contains(s.MembershipNumber)) continue;

            var user = new Domain.User
            {
                TenantId = tenantId,
                Email = s.Email,
                EmailVerified = true,
                IsAdmin = false,
                Status = "active",
            };
            db.Users.Add(user);
            db.Memberships.Add(new Domain.Membership
            {
                TenantId = tenantId,
                UserId = user.Id,
                FullName = s.FullName,
                MembershipNumber = s.MembershipNumber,
                PhotoUrl = BuildAvatarSvg(s.FullName, s.Hex),
                Status = Domain.MembershipStatus.Active,
                MemberClass = s.Class,
            });
            // ZAR 500 opening balance so bookings have funds.
            db.LedgerEntries.Add(new Domain.LedgerEntry
            {
                TenantId = tenantId,
                UserId = user.Id,
                Type = Domain.LedgerEntryType.AdminAdjustment,
                AmountCredits = 500m,
                ActorUserId = adminUserId,
                Reason = "sample seed opening balance",
            });
            createdUsers[s.MembershipNumber] = user.Id;
        }
        await db.SaveChangesAsync();
        logger.LogInformation("Seeded {N} sample members", createdUsers.Count);

        // Sample bookings: today + the next 6 days, scattered "here and there" across courts
        // and times so the schedule has organic-looking activity rather than the same grid
        // every day. Times are SAST (UTC+2) wall-clock, then converted to UTC.
        var sast = TimeSpan.FromHours(2);
        var dates = Enumerable.Range(0, 7).Select(d => DateTime.UtcNow.Date.AddDays(d)).ToArray();

        // Per-day rotation of (court, hour, minute, member). Offsets shift by date index so
        // the same time/court doesn't repeat verbatim each day. Some days are lighter than
        // others on purpose.
        var basePlan = new (int CourtIndex, int Hour, int Minute, string MembershipNumber)[]
        {
            (0,  7,  0, "MEM-1001"),
            (1,  8, 30, "MEM-1002"),
            (2, 12,  0, "MEM-1003"),
            (3, 17, 30, "MEM-1004"),
            (0, 18,  0, "MEM-1005"),
            (1, 19,  0, "MEM-1001"),
            (2,  9,  0, "MEM-1004"),
            (3, 13, 30, "MEM-1002"),
            (0, 16,  0, "MEM-1003"),
            (1, 20,  0, "MEM-1005"),
        };

        // Day-by-day intensity: pick how many of basePlan to seed on each day, with a
        // pseudo-random rotation offset to vary which entries land where.
        var perDayCount = new[] { 6, 4, 7, 3, 5, 8, 4 };

        var memberIdByNumber = await db.Memberships
            .Where(m => basePlan.Select(p => p.MembershipNumber).Contains(m.MembershipNumber))
            .ToDictionaryAsync(m => m.MembershipNumber, m => m.UserId);

        var bookingsCreated = 0;
        for (var di = 0; di < dates.Length; di++)
        {
            var date = dates[di];
            var take = perDayCount[di % perDayCount.Length];
            var offset = di * 3;
            var dayPlan = Enumerable.Range(0, take)
                .Select(i => basePlan[(i + offset) % basePlan.Length]);
            foreach (var p in dayPlan)
            {
                var court = courts[p.CourtIndex];
                var startsAtUtc = new DateTimeOffset(date.AddHours(p.Hour).AddMinutes(p.Minute), TimeSpan.Zero) - sast;
                var endsAtUtc = startsAtUtc.AddMinutes(30);

                var alreadyBooked = await db.Bookings.AnyAsync(b =>
                    b.CourtId == court.Id && b.StartsAt == startsAtUtc && b.Status == Domain.BookingStatus.Booked);
                if (alreadyBooked) continue;

                if (!memberIdByNumber.TryGetValue(p.MembershipNumber, out var userId)) continue;

                var booking = new Domain.Booking
                {
                    TenantId = tenantId,
                    CourtId = court.Id,
                    UserId = userId,
                    ActorUserId = adminUserId,
                    StartsAt = startsAtUtc,
                    EndsAt = endsAtUtc,
                    SliceMinutes = 30,
                    SliceCount = 1,
                    AmountChargedCredits = court.SlicePriceCredits,
                    Status = Domain.BookingStatus.Booked,
                };
                db.Bookings.Add(booking);
                db.LedgerEntries.Add(new Domain.LedgerEntry
                {
                    TenantId = tenantId,
                    UserId = userId,
                    Type = Domain.LedgerEntryType.BookingCharge,
                    AmountCredits = -court.SlicePriceCredits,
                    RelatedBookingId = booking.Id,
                    ActorUserId = adminUserId,
                    Reason = $"Booking {court.Name} {startsAtUtc:yyyy-MM-dd HH:mm}",
                });
                bookingsCreated++;
            }
        }
        await db.SaveChangesAsync();
        logger.LogInformation("Seeded {N} sample bookings across {Days} day(s)", bookingsCreated, dates.Length);
    }

    /// <summary>
    /// Builds a deterministic SVG-data-URI avatar for the given name + hex background.
    /// Two-letter initials, white text, centered. No external network required.
    /// </summary>
    private static string BuildAvatarSvg(string fullName, string bgHex)
    {
        var parts = fullName.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var initials = parts.Length switch
        {
            0 => "?",
            1 => parts[0][..1].ToUpperInvariant(),
            _ => $"{parts[0][0]}{parts[^1][0]}".ToUpperInvariant(),
        };
        var svg =
            $"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>" +
            $"<rect width='64' height='64' rx='32' fill='{bgHex}'/>" +
            $"<text x='32' y='38' font-family='Figtree,Arial,sans-serif' font-size='24' font-weight='600' " +
            $"text-anchor='middle' fill='white'>{initials}</text></svg>";
        var b64 = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(svg));
        return $"data:image/svg+xml;base64,{b64}";
    }
}

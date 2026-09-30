using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Minting access codes over a real host, for the HTTP tests that need one. Lives here
/// rather than in each file so the way a test obtains a code is the way the API does —
/// through <see cref="AccessCodeService"/>, under the tenant it belongs to.
/// </summary>
internal static class TestAccessCodes
{
    public static async Task<string> MintIdentAsync(
        IServiceProvider services, Guid tenantId, string slug, Guid userId, TimeSpan? lifetime = null)
    {
        using var scope = services.CreateScope();
        scope.ServiceProvider.GetRequiredService<ITenantContext>().Set(tenantId, slug);
        var codes = scope.ServiceProvider.GetRequiredService<AccessCodeService>();
        return (await codes.MintIdentAsync(userId, lifetime ?? TimeSpan.FromSeconds(60), default)).Code;
    }

    /// <summary>A live booking-activation code for <paramref name="bookingId"/>, as the roster would push it.</summary>
    public static async Task<string> InsertBookingCodeAsync(IServiceProvider services, Guid tenantId, Guid userId, Guid bookingId)
    {
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var row = new AccessCode
        {
            TenantId = tenantId,
            Code = AccessCodeService.NewCode(),
            Purpose = AccessCodePurpose.BookingActivation,
            UserId = userId,
            BookingId = bookingId,
            ExpiresAt = DateTimeOffset.UtcNow.AddHours(2),
        };
        db.AccessCodes.Add(row);
        await db.SaveChangesAsync();
        return row.Code;
    }

    /// <summary>A well-formed code whose lifetime is already over.</summary>
    public static async Task<string> InsertExpiredAsync(IServiceProvider services, Guid tenantId, Guid userId)
    {
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var row = new AccessCode
        {
            TenantId = tenantId,
            Code = AccessCodeService.NewCode(),
            Purpose = AccessCodePurpose.MemberIdent,
            UserId = userId,
            ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(-2),
        };
        db.AccessCodes.Add(row);
        await db.SaveChangesAsync();
        return row.Code;
    }
}

/// <summary>
/// The code a member's phone shows a court box.
///
/// <para>
/// These are the properties the scanner pipeline and the money path both lean on: a code
/// is short enough to scan and random enough not to guess; a booking gets one code and
/// keeps it; a dead code identifies nobody; a code from another club identifies nobody
/// here. The last two are what stop a photographed screen being a permanent key.
/// </para>
/// </summary>
public sealed class AccessCodeTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public AccessCodeTests(PostgresFixture pg) => _pg = pg;

    private static readonly TimeSpan Grace = TimeSpan.FromMinutes(5);

    private static async Task<Booking> BookAsync(TestHost host, double hoursAhead = 2)
    {
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var startsAt = TestHost.BookableSlot(hoursAhead);
        var booking = new Booking
        {
            TenantId = host.Tenant.Id,
            CourtId = host.Courts[0].Id,
            UserId = host.PlayerUser.Id,
            BookedByUserId = host.PlayerUser.Id,
            PaidByUserId = host.PlayerUser.Id,
            ActorUserId = host.PlayerUser.Id,
            StartsAt = startsAt,
            EndsAt = startsAt.AddMinutes(30),
            SliceMinutes = 15,
            SliceCount = 2,
            AmountChargedCredits = 16m,
            Status = BookingStatus.Booked,
        };
        db.Bookings.Add(booking);
        await db.SaveChangesAsync();
        return booking;
    }

    // ---- Format ------------------------------------------------------------

    /// <summary>
    /// Twelve characters of Crockford base32. Twelve because the box's frame codec carries
    /// 24 bytes per argument and poisons anything longer; Crockford because I, L, O and U
    /// are the letters a person mis-reads off a screen.
    /// </summary>
    [Fact]
    public void A_fresh_code_is_twelve_crockford_characters()
    {
        for (var i = 0; i < 200; i++)
        {
            var code = AccessCodeService.NewCode();
            Assert.Equal(AccessCode.Length, code.Length);
            Assert.True(code.Length <= 24, "must fit the scanner pipeline's 24-byte argument");
            Assert.All(code, ch => Assert.Contains(ch, AccessCodeService.Alphabet));
            Assert.DoesNotContain(code, ch => ch is 'I' or 'L' or 'O' or 'U' || char.IsLower(ch));
        }
    }

    [Fact]
    public void Two_fresh_codes_differ()
    {
        var a = AccessCodeService.NewCode();
        var b = AccessCodeService.NewCode();
        Assert.NotEqual(a, b);
    }

    // ---- Normalise ---------------------------------------------------------

    /// <summary>
    /// Case and surrounding space are forgiven; anything that could not be a code at all is
    /// not. The scanner emits what the label carries and a desk types what it reads.
    /// </summary>
    [Theory]
    [InlineData("7q3f9km2xz8b", "7Q3F9KM2XZ8B")]
    [InlineData("  7Q3F9KM2XZ8B  ", "7Q3F9KM2XZ8B")]
    [InlineData("\r\n7Q3F9KM2XZ8B\r\n", "7Q3F9KM2XZ8B")]
    [InlineData("7Q3F9KM2XZ8", null)]        // eleven
    [InlineData("7Q3F9KM2XZ8BB", null)]      // thirteen
    [InlineData("7Q3F9KM2XZ8I", null)]       // I is not in the alphabet
    [InlineData("   ", null)]
    [InlineData("", null)]
    [InlineData(null, null)]
    public void A_presented_code_is_trimmed_and_upper_cased_or_refused(string? presented, string? expected)
    {
        Assert.Equal(expected, AccessCodeService.Normalise(presented));
    }

    /// <summary>
    /// <b>The length is checked BEFORE anything is allocated</b>, so a board — or anyone
    /// holding the club key — cannot make the server upper-case a megabyte per request.
    ///
    /// <para>
    /// This is the one property of <c>Normalise</c> that its return value cannot express: the
    /// answer for an over-long string is <c>null</c> either way, and every behavioural test
    /// above stays green against the slow order. So the assertion is on allocation, and the
    /// varied field has to be the LENGTH — the same test at twelve characters passes against
    /// both implementations, which is exactly why it would not have caught this.
    /// </para>
    ///
    /// <para>
    /// The budget is a thousandth of the input's own byte count rather than zero: the
    /// measurement itself and the theory's own boxing are not free, and the defect this
    /// guards is a factor-of-a-million one, not a byte.
    /// </para>
    ///
    /// <para>
    /// <b>The filler character is load-bearing and was wrong the first time.</b> A megabyte of
    /// <c>'A'</c> measured as free even against the slow order, because
    /// <see cref="string.ToUpperInvariant"/> scans for the first character that would change
    /// and hands back the SAME instance when none does — so the fixture, not the code, was
    /// what made the test pass. Lower case is what forces the copy the fast order exists to
    /// avoid.
    /// </para>
    /// </summary>
    [Fact]
    public void An_absurdly_long_token_is_refused_before_anything_is_allocated()
    {
        const int chars = 4 * 1024 * 1024;
        var absurd = new string('a', chars);

        // Warm the path, so the JIT's own one-off allocations are not the measurement.
        Assert.Null(AccessCodeService.Normalise(absurd));
        Assert.Equal("7Q3F9KM2XZ8B", AccessCodeService.Normalise("7q3f9km2xz8b"));

        var before = GC.GetAllocatedBytesForCurrentThread();
        Assert.Null(AccessCodeService.Normalise(absurd));
        var allocated = GC.GetAllocatedBytesForCurrentThread() - before;

        Assert.True(
            allocated < chars * 2L / 1000,
            $"Normalise allocated {allocated} bytes refusing a {chars}-character token; it is "
            + "upper-casing before it checks the length.");
    }

    // ---- Booking codes -----------------------------------------------------

    /// <summary>One booking, one code — however many times the phone asks.</summary>
    [Fact]
    public async Task Minting_for_the_same_booking_twice_returns_the_same_row()
    {
        await using var host = await TestHost.CreateAsync();
        var booking = await BookAsync(host);

        using var scope = host.NewScope();
        var codes = scope.ServiceProvider.GetRequiredService<AccessCodeService>();

        var first = await codes.MintForBookingAsync(booking, Grace, default);
        var second = await codes.MintForBookingAsync(booking, Grace, default);

        Assert.Equal(first.Id, second.Id);
        Assert.Equal(first.Code, second.Code);
        Assert.Equal(AccessCodePurpose.BookingActivation, first.Purpose);
        Assert.Equal(booking.Id, first.BookingId);
        Assert.Equal(host.PlayerUser.Id, first.UserId);
        Assert.Equal(booking.EndsAt.Add(Grace), first.ExpiresAt);

        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Equal(1, await db.AccessCodes.CountAsync(c => c.BookingId == booking.Id));
    }

    /// <summary>The same idempotency across two requests — two scopes, two contexts.</summary>
    [Fact]
    public async Task Minting_for_the_same_booking_from_two_scopes_returns_the_same_row()
    {
        await using var host = await TestHost.CreateAsync();
        var booking = await BookAsync(host);

        string first, second;
        using (var scope = host.NewScope())
        {
            first = (await scope.ServiceProvider.GetRequiredService<AccessCodeService>().MintForBookingAsync(booking, Grace, default)).Code;
        }
        using (var scope = host.NewScope())
        {
            second = (await scope.ServiceProvider.GetRequiredService<AccessCodeService>().MintForBookingAsync(booking, Grace, default)).Code;
        }

        Assert.Equal(first, second);
    }

    /// <summary>
    /// The booking's code is written in the same unit of work as the booking. A booking
    /// made through the service must come out with its code already there.
    /// </summary>
    [Fact]
    public async Task A_booking_made_through_the_service_carries_its_code()
    {
        await using var host = await TestHost.CreateAsync();

        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id, Reason: "seed"), default);

        var bookings = scope.ServiceProvider.GetRequiredService<BookingService>();
        var result = await bookings.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, TestHost.BookableSlot(), 2, default);
        var ok = Assert.IsType<BookingResult.Ok>(result);

        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var code = await db.AccessCodes.SingleAsync(c => c.BookingId == ok.Booking.Id);
        Assert.Equal(AccessCodePurpose.BookingActivation, code.Purpose);
        Assert.Equal(ok.Booking.EndsAt.AddMinutes(5), code.ExpiresAt);   // fixture grace is 5
    }

    // ---- Ident codes -------------------------------------------------------

    [Fact]
    public async Task An_ident_code_is_reused_while_it_lives_and_replaced_once_it_has_expired()
    {
        await using var host = await TestHost.CreateAsync();

        using var scope = host.NewScope();
        var codes = scope.ServiceProvider.GetRequiredService<AccessCodeService>();

        var first = await codes.MintIdentAsync(host.PlayerUser.Id, TimeSpan.FromSeconds(60), default);
        var again = await codes.MintIdentAsync(host.PlayerUser.Id, TimeSpan.FromSeconds(60), default);
        Assert.Equal(first.Code, again.Code);

        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        first.ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(-1);
        await db.SaveChangesAsync();

        var replacement = await codes.MintIdentAsync(host.PlayerUser.Id, TimeSpan.FromSeconds(60), default);
        Assert.NotEqual(first.Code, replacement.Code);
    }

    /// <summary>
    /// Reuse stops short of expiry, and that is the whole of round-3 finding 21.
    ///
    /// <para>
    /// The Court Code page re-fetches ten seconds before its code dies so the member never
    /// holds a dead QR. Against unconditional reuse that pre-fetch got the same code back
    /// with nine seconds on it — one extra request per lifetime and no change at all to
    /// what the member was holding up at the box. A code inside the refresh lead is
    /// replaced now, so the pre-fetch returns something the member can actually scan.
    /// </para>
    /// </summary>
    [Fact]
    public async Task An_ident_code_inside_the_refresh_lead_is_replaced_rather_than_handed_out_again()
    {
        await using var host = await TestHost.CreateAsync();

        using var scope = host.NewScope();
        var codes = scope.ServiceProvider.GetRequiredService<AccessCodeService>();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var lifetime = TimeSpan.FromSeconds(60);
        var first = await codes.MintIdentAsync(host.PlayerUser.Id, lifetime, default);

        // Still comfortably outside the lead: the same code.
        first.ExpiresAt = DateTimeOffset.UtcNow.Add(AccessCodeService.IdentRefreshLead).AddSeconds(5);
        await db.SaveChangesAsync();
        Assert.Equal(first.Code, (await codes.MintIdentAsync(host.PlayerUser.Id, lifetime, default)).Code);

        // Inside it — where the page's pre-fetch lands: a fresh code.
        first.ExpiresAt = DateTimeOffset.UtcNow.Add(AccessCodeService.IdentRefreshLead).AddSeconds(-5);
        await db.SaveChangesAsync();
        var fresh = await codes.MintIdentAsync(host.PlayerUser.Id, lifetime, default);
        Assert.NotEqual(first.Code, fresh.Code);

        // And the one it replaced is left alone — a member may be holding it up at a box
        // right now, and the box decides scans offline. Both resolve to the same member.
        var stillThere = await db.AccessCodes.SingleAsync(c => c.Code == first.Code, default);
        Assert.True(stillThere.IsLiveAt(DateTimeOffset.UtcNow));
        Assert.NotNull(await codes.ResolveAsync(first.Code, default));
        Assert.NotNull(await codes.ResolveAsync(fresh.Code, default));
    }

    /// <summary>
    /// The lead is capped at half the lifetime, so a club that sets a very short
    /// <c>qr_lifetime_seconds</c> gets rotation rather than a new row on every poll — the
    /// confetti the reuse rule exists to prevent.
    /// </summary>
    [Fact]
    public async Task A_lifetime_shorter_than_the_lead_still_reuses_rather_than_minting_every_call()
    {
        await using var host = await TestHost.CreateAsync();

        using var scope = host.NewScope();
        var codes = scope.ServiceProvider.GetRequiredService<AccessCodeService>();

        var lifetime = TimeSpan.FromSeconds(10);   // shorter than IdentRefreshLead
        var first = await codes.MintIdentAsync(host.PlayerUser.Id, lifetime, default);
        var again = await codes.MintIdentAsync(host.PlayerUser.Id, lifetime, default);

        Assert.Equal(first.Code, again.Code);
    }

    /// <summary>
    /// Documents the contract the Court Code page's pre-fetch is written against: the
    /// server's lead must be longer than the page's ten seconds, or a pre-fetch lands on
    /// the reuse side of the line and the fix is a no-op again.
    /// </summary>
    [Fact]
    public void The_refresh_lead_is_longer_than_the_pages_prefetch()
        => Assert.True(AccessCodeService.IdentRefreshLead > TimeSpan.FromSeconds(10));

    // ---- Resolution --------------------------------------------------------

    [Fact]
    public async Task A_live_code_resolves_to_its_member_for_either_purpose()
    {
        await using var host = await TestHost.CreateAsync();
        var booking = await BookAsync(host);

        using var scope = host.NewScope();
        var codes = scope.ServiceProvider.GetRequiredService<AccessCodeService>();

        var bookingCode = await codes.MintForBookingAsync(booking, Grace, default);
        var identCode = await codes.MintIdentAsync(host.LeaguePlayerUser.Id, TimeSpan.FromSeconds(60), default);

        var b = await codes.ResolveAsync(bookingCode.Code, default);
        Assert.NotNull(b);
        Assert.Equal(AccessCodePurpose.BookingActivation, b.Purpose);
        Assert.Equal(host.PlayerUser.Id, b.UserId);
        Assert.Equal(booking.Id, b.BookingId);

        var i = await codes.ResolveAsync(identCode.Code, default);
        Assert.NotNull(i);
        Assert.Equal(AccessCodePurpose.MemberIdent, i.Purpose);
        Assert.Equal(host.LeaguePlayerUser.Id, i.UserId);
        Assert.Null(i.BookingId);

        // A scanner that emits lower case, or a code typed at a desk, is the same code.
        Assert.NotNull(await codes.ResolveAsync(identCode.Code.ToLowerInvariant(), default));
        Assert.NotNull(await codes.ResolveAsync($"  {identCode.Code} ", default));
    }

    /// <summary>
    /// The lifetime is the point. A code that outlived its expiry would let a photographed
    /// screen open a court forever.
    /// </summary>
    [Fact]
    public async Task An_expired_code_resolves_to_nobody()
    {
        await using var host = await TestHost.CreateAsync();

        using var scope = host.NewScope();
        var codes = scope.ServiceProvider.GetRequiredService<AccessCodeService>();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var row = await codes.MintIdentAsync(host.PlayerUser.Id, TimeSpan.FromSeconds(60), default);
        Assert.NotNull(await codes.ResolveAsync(row.Code, default));

        row.ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(-1);
        await db.SaveChangesAsync();

        Assert.Null(await codes.ResolveAsync(row.Code, default));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("ABCDEFGHJKM")]            // eleven
    [InlineData("ABCDEFGHJKMNP")]          // thirteen
    [InlineData("ABCDEFGHJKMO")]           // O is not in the alphabet
    [InlineData("eyJhbGciOiJIUzI1NiJ9.x")] // the old JWT, or the start of one
    public async Task Something_that_is_not_a_code_resolves_to_nobody_without_a_database_read(string? presented)
    {
        await using var host = await TestHost.CreateAsync();

        using var scope = host.NewScope();
        var codes = scope.ServiceProvider.GetRequiredService<AccessCodeService>();

        Assert.Null(await codes.ResolveAsync(presented, default));
    }

    /// <summary>
    /// Two clubs in one database. A code minted at one identifies nobody at the other —
    /// structurally, through the query filter, not through a claim somebody compares.
    /// </summary>
    [Fact]
    public async Task A_code_from_another_tenant_resolves_to_nobody()
    {
        var shared = $"codes-shared-{Guid.NewGuid():N}";
        await using var home = await TestHost.CreateAsync("home", shared);
        await using var away = await TestHost.CreateAsync("away", shared);

        string awayCode;
        using (var scope = away.NewScope())
        {
            awayCode = (await scope.ServiceProvider.GetRequiredService<AccessCodeService>()
                .MintIdentAsync(away.PlayerUser.Id, TimeSpan.FromMinutes(5), default)).Code;
        }

        using (var scope = home.NewScope())
        {
            var codes = scope.ServiceProvider.GetRequiredService<AccessCodeService>();
            Assert.Null(await codes.ResolveAsync(awayCode, default));

            // And the row is really there, so the refusal above is the filter and not an
            // empty table.
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.NotNull(await db.AccessCodes.IgnoreQueryFilters().SingleOrDefaultAsync(c => c.Code == awayCode));
        }

        using (var scope = away.NewScope())
        {
            Assert.NotNull(await scope.ServiceProvider.GetRequiredService<AccessCodeService>().ResolveAsync(awayCode, default));
        }
    }

    // ---- Concurrency (real database) ----------------------------------------

    /// <summary>
    /// Two phones asking for the same booking's code at once — or one phone retrying — must
    /// end with one row. The in-memory provider has no unique index, so only Postgres can
    /// say whether the second writer is refused rather than duplicated.
    /// </summary>
    [SkippableFact]
    public async Task Two_concurrent_mints_for_one_booking_leave_one_row()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = _pg.SharedHost;

        Guid tenantId, userId;
        Booking booking;
        string slug;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            await db.Database.MigrateAsync();

            slug = $"conc-{Guid.NewGuid():N}"[..20];
            var tenant = new Tenant { Slug = slug, DisplayName = "Concurrent Club" };
            db.Tenants.Add(tenant);
            db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = """{"timezone":"UTC"}""" });
            var user = new User { TenantId = tenant.Id, Email = $"{slug}@test.local", PasswordHash = "x", EmailVerified = true };
            db.Users.Add(user);
            var court = new Court { TenantId = tenant.Id, CourtNumber = 1, Name = "Court 1", SlicePriceCredits = 8m };
            db.Courts.Add(court);
            var startsAt = DateTimeOffset.UtcNow.AddHours(1);
            booking = new Booking
            {
                TenantId = tenant.Id,
                CourtId = court.Id,
                UserId = user.Id,
                BookedByUserId = user.Id,
                PaidByUserId = user.Id,
                ActorUserId = user.Id,
                StartsAt = startsAt,
                EndsAt = startsAt.AddMinutes(30),
                SliceMinutes = 15,
                SliceCount = 2,
                AmountChargedCredits = 16m,
            };
            db.Bookings.Add(booking);
            await db.SaveChangesAsync();
            tenantId = tenant.Id;
            userId = user.Id;
        }

        async Task<string> MintAsync()
        {
            using var scope = factory.Services.CreateScope();
            scope.ServiceProvider.GetRequiredService<ITenantContext>().Set(tenantId, slug);
            var codes = scope.ServiceProvider.GetRequiredService<AccessCodeService>();
            return (await codes.MintForBookingAsync(booking, Grace, default)).Code;
        }

        // Eight callers that all find no code and all insert. The filtered unique index on
        // (tenant, booking) lets exactly one in; the rest hit 23505, retry, and find it.
        var minted = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => MintAsync()));

        Assert.Single(minted.Distinct());

        var settled = await MintAsync();
        Assert.Equal(minted[0], settled);

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = Assert.Single(await db.AccessCodes.IgnoreQueryFilters().Where(c => c.BookingId == booking.Id).ToListAsync());
            Assert.Equal(userId, row.UserId);
            Assert.Equal(settled, row.Code);
        }
    }

    /// <summary>
    /// The one collision the retry exists for: a code that is already taken in this
    /// tenant. Forced, because sixty random bits will not collide on their own in the
    /// lifetime of the club.
    /// </summary>
    [SkippableFact]
    public async Task A_code_collision_is_refused_by_the_database_not_merged()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = _pg.SharedHost;
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var tenantId = Guid.NewGuid();
        var code = AccessCodeService.NewCode();

        AccessCode Row() => new()
        {
            TenantId = tenantId,
            Code = code,
            Purpose = AccessCodePurpose.MemberIdent,
            UserId = Guid.NewGuid(),
            ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(1),
        };

        db.AccessCodes.Add(Row());
        await db.SaveChangesAsync();

        db.AccessCodes.Add(Row());
        var clash = await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync());
        Assert.Equal("23505", Assert.IsType<Npgsql.PostgresException>(clash.InnerException).SqlState);
        db.ChangeTracker.Clear();

        // Same code, another tenant: legal, because the index is per tenant and the
        // resolver can never reach across.
        var elsewhere = Row();
        elsewhere.TenantId = Guid.NewGuid();
        db.AccessCodes.Add(elsewhere);
        await db.SaveChangesAsync();
    }
}

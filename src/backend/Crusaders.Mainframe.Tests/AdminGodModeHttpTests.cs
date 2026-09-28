using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Decision R19, "admin god mode", over real HTTP and real Postgres: the quote endpoints that let
/// the console show an admin the consequence before they send <c>allowNegativeBalance</c>, and
/// the change-record rows every admin money decision now leaves in the table nobody can delete
/// from.
///
/// <para>
/// <b>The quote's whole promise is "the same number".</b> So every quote test here books the
/// thing it quoted and compares the quoted figure with the ledger row, rather than with a
/// literal: a quote that drifted from the booking's pricing would still match a literal
/// somebody computed by hand from the same wrong idea.
/// </para>
///
/// <para>
/// The member carries a group priced at 1.5× the court, so a quote that read the court's price
/// instead of the member's would be visibly wrong — 32 where 48 is charged. A fixture with no
/// group would pass that defect (<c>memory/gotchas.md</c>, "green because of its FIXTURE").
/// </para>
/// </summary>
public sealed class AdminGodModeHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public AdminGodModeHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string QuotePath = "/api/v1/admin/bookings/quote";
    private const string BulkQuotePath = "/api/v1/admin/bookings/bulk/quote";
    private const string BookPath = "/api/v1/admin/bookings/";
    private const string BulkBookPath = "/api/v1/admin/bookings/bulk";

    /// <summary>DoorClub's court is 8 credits a slice; the member's group charges 1.5× that.</summary>
    private const decimal CourtSliceCredits = 8m;
    private const decimal GroupSliceCredits = 12m;

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    /// <summary>Two days out, on the hour, in UTC — outside every clock trap in gotchas-clock.</summary>
    private static DateTimeOffset Slot(int hour, int minute = 0)
    {
        var day = DateTime.UtcNow.Date.AddDays(2);
        return new DateTimeOffset(day.Year, day.Month, day.Day, hour, minute, 0, TimeSpan.Zero);
    }

    private static string Iso(DateTimeOffset at) => Uri.EscapeDataString(at.ToString("o"));

    private static async Task<(HttpStatusCode Status, JsonElement Body)> ReadAsync(HttpResponseMessage res)
    {
        var text = await res.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(text) ? "{}" : text);
        return (res.StatusCode, doc.RootElement.Clone());
    }

    private static Task<(HttpStatusCode Status, JsonElement Body)> QuoteAsync(
        HttpClient client, Guid courtId, DateTimeOffset startsAt, int slices, Guid? userId = null)
    {
        var who = userId is null ? "" : $"userId={userId}&";
        return ReadAsync(client.GetAsync($"{QuotePath}?{who}courtId={courtId}&startsAt={Iso(startsAt)}&slices={slices}"));
    }

    private static async Task<(HttpStatusCode Status, JsonElement Body)> ReadAsync(Task<HttpResponseMessage> pending)
        => await ReadAsync(await pending);

    /// <summary>The club, with the member in a 1.5× group and holding <paramref name="memberCredits"/>.</summary>
    private static async Task<DoorClub> SeedAsync(TestWebAppFactory factory, string prefix, decimal memberCredits)
    {
        var club = await DoorClub.SeedAsync(factory, prefix);
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var group = new MemberGroup
        {
            TenantId = club.TenantId,
            Name = "League",
            PricingMode = GroupPricingMode.Multiplier,
            PriceMultiplierBps = 15_000,
            CreatedByUserId = club.AdminUserId,
        };
        db.MemberGroups.Add(group);
        db.MemberGroupMembers.Add(new MemberGroupMember
        {
            TenantId = club.TenantId, GroupId = group.Id, UserId = club.MemberUserId, AddedByUserId = club.AdminUserId,
        });
        if (memberCredits != 0m)
        {
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = club.TenantId, UserId = club.MemberUserId, Type = LedgerEntryType.TopUp,
                AmountCredits = memberCredits, ActorUserId = Guid.Empty, Reason = "fixture float",
            });
        }
        await db.SaveChangesAsync();
        return club;
    }

    private static async Task<List<AdminChangeLog>> ChangesAsync(TestWebAppFactory factory, Guid tenantId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.AdminChangeLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == tenantId).OrderBy(a => a.OccurredAt).ToListAsync();
    }

    private static async Task<List<LedgerEntry>> ChargesAsync(TestWebAppFactory factory, Guid tenantId, Guid userId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.TenantId == tenantId && l.UserId == userId && l.Type == LedgerEntryType.BookingCharge)
            .ToListAsync();
    }

    // ------------------------------------------------------------------ single quote

    /// <summary>
    /// The quote is the booking. Quoted at the member's GROUP price, it names the balance the
    /// booking leaves; booked with the override, the ledger row is that price and the response
    /// quotes that balance — and the desk's two decisions land in the change record.
    /// </summary>
    [SkippableFact]
    public async Task A_quote_for_a_member_is_exactly_what_the_booking_then_charges()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "gmquote", memberCredits: 5m);
        var admin = club.AdminClient(factory);

        var (status, quote) = await QuoteAsync(admin, club.CourtId, Slot(10), 4, club.MemberUserId);

        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal(GroupSliceCredits * 4, quote.GetProperty("price_credits").GetDecimal());
        Assert.Equal(5m, quote.GetProperty("balance_credits").GetDecimal());
        Assert.Equal(5m - GroupSliceCredits * 4, quote.GetProperty("balance_after_credits").GetDecimal());
        Assert.True(quote.GetProperty("overdraws").GetBoolean());
        Assert.Equal(club.MemberUserId, quote.GetProperty("user_id").GetGuid());
        // Credits only: the club's currency symbol is rand's and never fronts a credit figure.
        Assert.False(quote.TryGetProperty("currency_symbol", out _));

        var (bookStatus, booked) = await ReadAsync(admin.PostAsJsonAsync(BookPath, new
        {
            courtId = club.CourtId, userId = club.MemberUserId, startsAt = Slot(10), sliceCount = 4,
            allowNegativeBalance = true,
        }));

        Assert.Equal(HttpStatusCode.OK, bookStatus);
        var charge = Assert.Single(await ChargesAsync(factory, club.TenantId, club.MemberUserId));
        Assert.Equal(-quote.GetProperty("price_credits").GetDecimal(), charge.AmountCredits);
        Assert.Equal(
            quote.GetProperty("balance_after_credits").GetDecimal(),
            booked.GetProperty("balance_after_credits").GetDecimal());

        var actions = (await ChangesAsync(factory, club.TenantId)).Select(c => c.Action).ToList();
        Assert.Equal(2, actions.Count);
        Assert.Contains(AdminChangeActions.BookingBookedOnBehalf, actions);
        Assert.Contains(AdminChangeActions.BookingOverdraftAuthorised, actions);
    }

    /// <summary>
    /// The quote is PAYER-shaped, not court-shaped. The same slot costs the admin the court's
    /// price and the member their group's, and each quote reads its own payer's wallet. Omitting
    /// <c>userId</c> is the admin's own booking.
    /// </summary>
    [SkippableFact]
    public async Task A_quote_for_yourself_and_a_quote_for_a_member_read_different_prices_and_wallets()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "gmself", memberCredits: 100m);
        var admin = club.AdminClient(factory);

        var (_, self) = await QuoteAsync(admin, club.CourtId, Slot(11), 4);
        var (_, other) = await QuoteAsync(admin, club.CourtId, Slot(11), 4, club.MemberUserId);

        Assert.Equal(club.AdminUserId, self.GetProperty("user_id").GetGuid());
        Assert.Equal(CourtSliceCredits * 4, self.GetProperty("price_credits").GetDecimal());
        Assert.Equal(0m, self.GetProperty("balance_credits").GetDecimal());
        Assert.True(self.GetProperty("overdraws").GetBoolean());

        Assert.Equal(GroupSliceCredits * 4, other.GetProperty("price_credits").GetDecimal());
        Assert.Equal(100m, other.GetProperty("balance_credits").GetDecimal());
        Assert.False(other.GetProperty("overdraws").GetBoolean());

        // And the admin's own booking, overdrawn, charges what the self-quote said.
        var (status, _) = await ReadAsync(admin.PostAsJsonAsync(BookPath, new
        {
            courtId = club.CourtId, userId = club.AdminUserId, startsAt = Slot(11), sliceCount = 4,
            allowNegativeBalance = true,
        }));
        Assert.Equal(HttpStatusCode.OK, status);
        var charge = Assert.Single(await ChargesAsync(factory, club.TenantId, club.AdminUserId));
        Assert.Equal(-self.GetProperty("price_credits").GetDecimal(), charge.AmountCredits);

        // Self: an overdraft row, and no on-behalf row — the admin booked for nobody else.
        var row = Assert.Single(await ChangesAsync(factory, club.TenantId));
        Assert.Equal(AdminChangeActions.BookingOverdraftAuthorised, row.Action);
    }

    /// <summary>
    /// The boundary of <c>overdraws</c> is the booking's own guard, <c>balance &lt; price</c>. A
    /// member holding exactly the price does not overdraw — and the booking sent WITHOUT the
    /// override proves it by landing on zero. One credit short, and it does.
    /// </summary>
    [SkippableFact]
    public async Task Holding_exactly_the_price_is_not_an_overdraft_and_one_credit_less_is()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "gmedge", memberCredits: GroupSliceCredits * 4);
        var admin = club.AdminClient(factory);

        var (_, exact) = await QuoteAsync(admin, club.CourtId, Slot(8), 4, club.MemberUserId);
        Assert.False(exact.GetProperty("overdraws").GetBoolean());
        Assert.Equal(0m, exact.GetProperty("balance_after_credits").GetDecimal());

        var (_, exactBulk) = await ReadAsync(admin.PostAsJsonAsync(BulkQuotePath, new
        {
            user_id = club.MemberUserId,
            items = new[] { new { court_id = club.CourtId, starts_at = Slot(8), slices = 4 } },
        }));
        Assert.False(exactBulk.GetProperty("overdraws").GetBoolean());

        var (_, oneMore) = await QuoteAsync(admin, club.CourtId, Slot(8), 5, club.MemberUserId);
        Assert.True(oneMore.GetProperty("overdraws").GetBoolean());

        var (status, _) = await ReadAsync(admin.PostAsJsonAsync(BookPath, new
        {
            courtId = club.CourtId, userId = club.MemberUserId, startsAt = Slot(8), sliceCount = 4,
        }));
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.DoesNotContain(await ChangesAsync(factory, club.TenantId),
            c => c.Action == AdminChangeActions.BookingOverdraftAuthorised);
    }

    /// <summary>
    /// A refusal the booking would meet is answered with the booking's own status and code, so
    /// the console has one mapping for the quote and the POST.
    /// </summary>
    [SkippableFact]
    public async Task A_quote_is_refused_with_the_status_and_code_the_booking_would_get()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "gmrefuse", memberCredits: 500m);
        var admin = club.AdminClient(factory);

        var (bookStatus, _) = await ReadAsync(admin.PostAsJsonAsync(BookPath, new
        {
            courtId = club.CourtId, userId = club.MemberUserId, startsAt = Slot(12), sliceCount = 4,
        }));
        Assert.Equal(HttpStatusCode.OK, bookStatus);

        var (taken, takenBody) = await QuoteAsync(admin, club.CourtId, Slot(12, 30), 2, club.MemberUserId);
        Assert.Equal(HttpStatusCode.Conflict, taken);
        Assert.Equal("slot_taken", takenBody.GetProperty("error").GetString());

        var (past, pastBody) = await QuoteAsync(admin, club.CourtId, DateTimeOffset.UtcNow.AddHours(-2), 2, club.MemberUserId);
        Assert.Equal(HttpStatusCode.BadRequest, past);
        Assert.Equal("past_time", pastBody.GetProperty("error").GetString());

        var (tooLong, tooLongBody) = await QuoteAsync(admin, club.CourtId, Slot(14), 0, club.MemberUserId);
        Assert.Equal(HttpStatusCode.BadRequest, tooLong);
        Assert.Equal("invalid_duration", tooLongBody.GetProperty("error").GetString());
    }

    /// <summary>
    /// Cross-tenant: another club's member is refused the way the POST refuses them, and
    /// another club's court does not exist here. Nothing about the other club — not its
    /// member's balance, not its court's price — comes back.
    /// </summary>
    [SkippableFact]
    public async Task Another_clubs_member_or_court_cannot_be_quoted()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var clubA = await SeedAsync(factory, "gmxa", memberCredits: 10m);
        var clubB = await SeedAsync(factory, "gmxb", memberCredits: 999m);
        var admin = clubA.AdminClient(factory);

        var (memberStatus, memberBody) = await QuoteAsync(admin, clubA.CourtId, Slot(9), 4, clubB.MemberUserId);
        Assert.Equal(HttpStatusCode.Forbidden, memberStatus);
        Assert.False(memberBody.TryGetProperty("balance_credits", out _));

        var (courtStatus, courtBody) = await QuoteAsync(admin, clubB.CourtId, Slot(9), 4, clubA.MemberUserId);
        Assert.Equal(HttpStatusCode.NotFound, courtStatus);
        Assert.Equal("court_not_found", courtBody.GetProperty("error").GetString());

        var (bulkStatus, bulkBody) = await ReadAsync(admin.PostAsJsonAsync(BulkQuotePath, new
        {
            user_id = clubB.MemberUserId,
            items = new[] { new { court_id = clubA.CourtId, starts_at = Slot(9), slices = 4 } },
        }));
        Assert.Equal(HttpStatusCode.BadRequest, bulkStatus);
        Assert.Equal("member_not_found", bulkBody.GetProperty("error").GetString());

        var (bulkCourt, bulkCourtBody) = await ReadAsync(admin.PostAsJsonAsync(BulkQuotePath, new
        {
            user_id = clubA.MemberUserId,
            items = new[] { new { court_id = clubB.CourtId, starts_at = Slot(9), slices = 4 } },
        }));
        Assert.Equal(HttpStatusCode.OK, bulkCourt);
        var line = bulkCourtBody.GetProperty("items")[0];
        Assert.False(line.GetProperty("bookable").GetBoolean());
        Assert.Equal("court_not_found", line.GetProperty("reason").GetString());
    }

    /// <summary>Both quote routes are admin-only, like the bookings they forecast.</summary>
    [SkippableFact]
    public async Task A_member_cannot_reach_either_quote()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "gmrole", memberCredits: 0m);
        var member = club.MemberClient(factory);

        var (single, _) = await QuoteAsync(member, club.CourtId, Slot(9), 4);
        var (bulk, _) = await ReadAsync(member.PostAsJsonAsync(BulkQuotePath, new
        {
            items = new[] { new { court_id = club.CourtId, starts_at = Slot(9), slices = 4 } },
        }));

        Assert.Equal(HttpStatusCode.Forbidden, single);
        Assert.Equal(HttpStatusCode.Forbidden, bulk);
    }

    // ------------------------------------------------------------------ bulk quote

    /// <summary>
    /// A batch quote is the batch. Four items: two bookable, one overlapping the first on the
    /// same court (the loop would book the first and refuse it), one in the past. The quoted
    /// total is what the batch charges, item by item, and the refusals are the batch's own
    /// codes. The one item that crossed below zero leaves one overdraft row; the batch leaves
    /// one intent row and no per-item on-behalf rows.
    /// </summary>
    [SkippableFact]
    public async Task A_bulk_quote_totals_what_the_batch_then_charges_item_by_item()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "gmbulk", memberCredits: 50m);
        var admin = club.AdminClient(factory);
        var past = DateTimeOffset.UtcNow.AddHours(-3);

        var (status, quote) = await ReadAsync(admin.PostAsJsonAsync(BulkQuotePath, new
        {
            user_id = club.MemberUserId,
            items = new object[]
            {
                new { court_id = club.CourtId, starts_at = Slot(10), slices = 4 },
                new { court_id = club.CourtId, starts_at = Slot(10, 30), slices = 2 },
                new { court_id = club.CourtId, starts_at = Slot(12), slices = 4 },
                new { court_id = club.CourtId, starts_at = past, slices = 4 },
            },
        }));

        Assert.Equal(HttpStatusCode.OK, status);
        var lines = quote.GetProperty("items").EnumerateArray().ToList();
        Assert.Equal(4, lines.Count);
        Assert.True(lines[0].GetProperty("bookable").GetBoolean());
        Assert.Equal(GroupSliceCredits * 4, lines[0].GetProperty("price_credits").GetDecimal());
        Assert.Equal(JsonValueKind.Null, lines[0].GetProperty("reason").ValueKind);
        Assert.False(lines[1].GetProperty("bookable").GetBoolean());
        Assert.Equal("slot_taken", lines[1].GetProperty("reason").GetString());
        Assert.True(lines[2].GetProperty("bookable").GetBoolean());
        Assert.Equal("past_time", lines[3].GetProperty("reason").GetString());

        var total = quote.GetProperty("total_credits").GetDecimal();
        Assert.Equal(GroupSliceCredits * 8, total);
        Assert.Equal(50m, quote.GetProperty("balance_credits").GetDecimal());
        Assert.Equal(50m - total, quote.GetProperty("balance_after_credits").GetDecimal());
        Assert.True(quote.GetProperty("overdraws").GetBoolean());

        // The same items through the bulk BOOK body's own spelling, with the override.
        var (bookStatus, booked) = await ReadAsync(admin.PostAsJsonAsync(BulkBookPath, new
        {
            idempotencyKey = "gm_bulk",
            onBehalf = new { userId = club.MemberUserId },
            allowNegativeBalance = true,
            items = new object[]
            {
                new { courtId = club.CourtId, startsAt = Slot(10), sliceCount = 4 },
                new { courtId = club.CourtId, startsAt = Slot(10, 30), sliceCount = 2 },
                new { courtId = club.CourtId, startsAt = Slot(12), sliceCount = 4 },
                new { courtId = club.CourtId, startsAt = past, sliceCount = 4 },
            },
        }));

        Assert.Equal(HttpStatusCode.OK, bookStatus);
        Assert.Equal(total, booked.GetProperty("total_charged_credits").GetDecimal());
        var results = booked.GetProperty("results").EnumerateArray().ToList();
        for (var i = 0; i < 4; i++)
        {
            Assert.Equal(lines[i].GetProperty("price_credits").GetDecimal(), results[i].GetProperty("amount_credits").GetDecimal());
            if (!lines[i].GetProperty("bookable").GetBoolean())
            {
                Assert.Equal(lines[i].GetProperty("reason").GetString(), results[i].GetProperty("error").GetString());
            }
        }
        Assert.Equal(-total, (await ChargesAsync(factory, club.TenantId, club.MemberUserId)).Sum(c => c.AmountCredits));

        var actions = (await ChangesAsync(factory, club.TenantId)).Select(c => c.Action).ToList();
        Assert.Equal(1, actions.Count(a => a == AdminChangeActions.BookingsBulkBooked));
        Assert.Equal(1, actions.Count(a => a == AdminChangeActions.BookingOverdraftAuthorised));
        // One per item that booked, in that booking's own unit of work (review finding F2): the
        // bulk_booked row is the summary, saved after the loop, and cannot be the only record.
        Assert.Equal(
            results.Count(r => r.GetProperty("status").GetString() == "booked"),
            actions.Count(a => a == AdminChangeActions.BookingBookedOnBehalf));
    }

    /// <summary>
    /// The bulk BOOK body's camelCase spelling prices identically to the documented snake_case
    /// one — a console sending the same items array to the quote and then the batch must not
    /// have one of them bind to nothing.
    /// </summary>
    [SkippableFact]
    public async Task The_bulk_quote_reads_both_spellings_the_same()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "gmspell", memberCredits: 0m);
        var admin = club.AdminClient(factory);

        var (_, snake) = await ReadAsync(admin.PostAsJsonAsync(BulkQuotePath, new
        {
            user_id = club.MemberUserId,
            items = new[] { new { court_id = club.CourtId, starts_at = Slot(15), slices = 3 } },
        }));
        var (_, camel) = await ReadAsync(admin.PostAsJsonAsync(BulkQuotePath, new
        {
            userId = club.MemberUserId,
            items = new[] { new { courtId = club.CourtId, startsAt = Slot(15), sliceCount = 3 } },
        }));

        Assert.Equal(GroupSliceCredits * 3, snake.GetProperty("total_credits").GetDecimal());
        Assert.Equal(snake.GetProperty("total_credits").GetDecimal(), camel.GetProperty("total_credits").GetDecimal());
        Assert.Equal(club.MemberUserId, camel.GetProperty("user_id").GetGuid());

        var (bad, badBody) = await ReadAsync(admin.PostAsJsonAsync(BulkQuotePath, new
        {
            items = new[] { new { court_id = club.CourtId } },
        }));
        Assert.Equal(HttpStatusCode.BadRequest, bad);
        Assert.Equal("item_invalid", badBody.GetProperty("error").GetString());
    }

    /// <summary>
    /// An admin's own batch, unlocked by the same R19 rule as a single booking: with the flag it
    /// books into the red and records it; without, it halts exactly as before.
    /// </summary>
    [SkippableFact]
    public async Task An_admins_own_batch_overdraws_only_when_asked_and_is_recorded_when_it_does()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "gmbself", memberCredits: 0m);
        var admin = club.AdminClient(factory);
        object Items() => new[] { new { courtId = club.CourtId, startsAt = Slot(7), sliceCount = 4 } };

        var (_, refused) = await ReadAsync(admin.PostAsJsonAsync(BulkBookPath, new
        {
            idempotencyKey = "gm_self_1", items = Items(),
        }));
        Assert.Equal("insufficient_balance", refused.GetProperty("halted_reason").GetString());

        var (_, booked) = await ReadAsync(admin.PostAsJsonAsync(BulkBookPath, new
        {
            idempotencyKey = "gm_self_2", allowNegativeBalance = true, items = Items(),
        }));
        Assert.Equal("booked", booked.GetProperty("results")[0].GetProperty("status").GetString());
        Assert.Equal(-CourtSliceCredits * 4, booked.GetProperty("payer").GetProperty("balance_after_credits").GetDecimal());

        var overdraft = Assert.Single(await ChangesAsync(factory, club.TenantId),
            c => c.Action == AdminChangeActions.BookingOverdraftAuthorised);
        Assert.Equal(club.AdminUserId, overdraft.SubjectId);
        using var after = JsonDocument.Parse(overdraft.AfterJson!);
        Assert.True(after.RootElement.GetProperty("self").GetBoolean());
    }

    /// <summary>
    /// A quote is a read, and it does not spend the booking's budget. Both quote routes sat under
    /// the <c>auth</c> limiter — ten a minute per user, shared with the booking they quote — so
    /// an admin who re-quoted ten times while changing the member, the length and the slot was
    /// answered 429 on the booking they had been quoting for (review finding P2-1). Run at the
    /// production ceiling, not the suite's raised one.
    /// </summary>
    [SkippableFact]
    public async Task Quoting_does_not_spend_the_bookings_rate_limit()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = new TestWebAppFactory
        {
            ConnectionString = _pg.ConnectionString,
            RateLimits = new Dictionary<string, int> { ["AuthPerMinute"] = 10 },
        };
        var club = await SeedAsync(factory, "gmquotelim", memberCredits: 500m);
        var admin = club.AdminClient(factory);

        for (var i = 0; i < 6; i++)
        {
            var (single, _) = await QuoteAsync(admin, club.CourtId, Slot(9), 4, club.MemberUserId);
            Assert.Equal(HttpStatusCode.OK, single);
            var bulk = await admin.PostAsJsonAsync(BulkQuotePath, new
            {
                userId = club.MemberUserId,
                items = new object[] { new { courtId = club.CourtId, startsAt = Slot(9), sliceCount = 4 } },
            });
            Assert.Equal(HttpStatusCode.OK, bulk.StatusCode);
        }

        var booked = await admin.PostAsJsonAsync(BookPath, new
        {
            courtId = club.CourtId,
            userId = club.MemberUserId,
            startsAt = Slot(9),
            sliceCount = 4,
        });
        Assert.Equal(HttpStatusCode.OK, booked.StatusCode);
    }

    /// <summary>
    /// The single quote reads the booking POST's own word for the length, <c>sliceCount</c>, and
    /// the snake_case spelling, and refuses a malformed query with an <c>{error}</c> like every
    /// other refusal in the API — it answered an empty-bodied 400 to both (review finding P3-1).
    /// </summary>
    [SkippableFact]
    public async Task The_single_quote_reads_every_spelling_and_refuses_in_words()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "gmquotesp", memberCredits: 500m);
        var admin = club.AdminClient(factory);
        var at = Iso(Slot(9));

        var (plain, expected) = await ReadAsync(admin.GetAsync(
            $"{QuotePath}?userId={club.MemberUserId}&courtId={club.CourtId}&startsAt={at}&slices=4"));
        var (camel, viaSliceCount) = await ReadAsync(admin.GetAsync(
            $"{QuotePath}?userId={club.MemberUserId}&courtId={club.CourtId}&startsAt={at}&sliceCount=4"));
        var (snake, viaSnake) = await ReadAsync(admin.GetAsync(
            $"{QuotePath}?user_id={club.MemberUserId}&court_id={club.CourtId}&starts_at={at}&slice_count=4"));

        Assert.Equal(HttpStatusCode.OK, plain);
        Assert.Equal(HttpStatusCode.OK, camel);
        Assert.Equal(HttpStatusCode.OK, snake);
        Assert.Equal(expected.GetProperty("price_credits").GetDecimal(), viaSliceCount.GetProperty("price_credits").GetDecimal());
        Assert.Equal(expected.GetProperty("price_credits").GetDecimal(), viaSnake.GetProperty("price_credits").GetDecimal());
        Assert.Equal(club.MemberUserId, viaSnake.GetProperty("user_id").GetGuid());

        var (bad, refusal) = await ReadAsync(admin.GetAsync($"{QuotePath}?courtId=not-a-guid&startsAt={at}&slices=4"));
        Assert.Equal(HttpStatusCode.BadRequest, bad);
        Assert.Equal("quote_query_invalid", refusal.GetProperty("error").GetString());
    }
}

using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// What the heartbeat pushes into a court box's roster cache (review C2).
///
/// <para>
/// The roster is the box's whole basis for admitting a member with no network, so what goes
/// into it is a money decision: a booking that should be there and is not is a paid member
/// refused; one that is there and should not be is a court lit for somebody who did not pay
/// for it, or lit on the wrong court. These pin the selection, the relay mapping, the
/// relative-time arithmetic and the cap — and that another club's bookings can never reach a
/// box, which is the P0 class.
/// </para>
/// </summary>
public class DeviceRosterTests
{
    private sealed record Fixture(TestHost Host, IServiceScope Scope, MainframeDbContext Db, AccessCodeService Codes, TenantSettingsView Settings);

    private static async Task<Fixture> CreateAsync(string? sharedDb = null, string? slug = null)
    {
        var host = await TestHost.CreateAsync(slug, sharedDb);
        var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var codes = scope.ServiceProvider.GetRequiredService<AccessCodeService>();
        var settings = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);
        return new Fixture(host, scope, db, codes, settings);
    }

    private static Device BoxOn(Fixture f, params int[] courtNumbers) => new()
    {
        TenantId = f.Host.Tenant.Id,
        DeviceCode = "court-box-1",
        Name = "The box",
        Kind = DeviceKind.CourtBox,
        CourtNumbers = [.. courtNumbers],
    };

    /// <summary>A charged booking for the player on <paramref name="court"/>, written directly so the clock can be placed anywhere.</summary>
    private static async Task<Booking> BookAsync(Fixture f, Court court, double startsInMinutes, int minutes = 45, bool checkedIn = false)
    {
        var startsAt = DateTimeOffset.UtcNow.AddMinutes(startsInMinutes);
        var booking = new Booking
        {
            TenantId = f.Host.Tenant.Id,
            CourtId = court.Id,
            UserId = f.Host.PlayerUser.Id,
            BookedByUserId = f.Host.PlayerUser.Id,
            PaidByUserId = f.Host.PlayerUser.Id,
            ActorUserId = f.Host.PlayerUser.Id,
            StartsAt = startsAt,
            EndsAt = startsAt.AddMinutes(minutes),
            SliceMinutes = 15,
            SliceCount = Math.Max(1, minutes / 15),
            AmountChargedCredits = 8m * Math.Max(1, minutes / 15),
            Status = BookingStatus.Booked,
            ChargedAt = DateTimeOffset.UtcNow,
            CheckedInAt = checkedIn ? DateTimeOffset.UtcNow : null,
        };
        f.Db.Bookings.Add(booking);
        await f.Db.SaveChangesAsync();
        return booking;
    }

    private static Task<List<string>> BuildAsync(Fixture f, Device box, DateTimeOffset? now = null) =>
        DeviceRosterBuilder.BuildAsync(f.Db, f.Codes, box, f.Settings, now ?? DateTimeOffset.UtcNow, default);

    private static string TokenOf(string entry) => entry.Split('|')[0];
    private static int RelayOf(string entry) => int.Parse(entry.Split('|')[1]);
    private static long OpensInOf(string entry) => long.Parse(entry.Split('|')[2]);
    private static long ClosesInOf(string entry) => long.Parse(entry.Split('|')[3]);

    private static async Task<string> CodeOfAsync(Fixture f, Booking booking) =>
        (await f.Db.AccessCodes.AsNoTracking().SingleAsync(c => c.BookingId == booking.Id)).Code;

    // ---- Which bookings ------------------------------------------------------

    /// <summary>
    /// A box carries the bookings on the courts it drives and no other. Court 5 exists at
    /// the club; a box wired to courts 1–4 never hears about it, and a box wired to 5 does.
    /// </summary>
    [Fact]
    public async Task A_box_carries_only_the_bookings_on_its_own_courts()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var court5 = new Court { TenantId = f.Host.Tenant.Id, CourtNumber = 5, Name = "Court 5", SlicePriceCredits = 8m };
        f.Db.Courts.Add(court5);
        await f.Db.SaveChangesAsync();

        var onFive = await BookAsync(f, court5, startsInMinutes: 5);
        var onTwo = await BookAsync(f, f.Host.Courts[1], startsInMinutes: 5);

        var fourCourtBox = await BuildAsync(f, BoxOn(f, 1, 2, 3, 4));
        var entry = Assert.Single(fourCourtBox);
        Assert.Equal(await CodeOfAsync(f, onTwo), TokenOf(entry));

        var fiveBox = await BuildAsync(f, BoxOn(f, 5));
        var five = Assert.Single(fiveBox);
        Assert.Equal(await CodeOfAsync(f, onFive), TokenOf(five));
        Assert.Equal(0, RelayOf(five));
    }

    /// <summary>
    /// The court filter has to be in the QUERY, not only in the formatter. Sixteen bookings
    /// on the box's courts and one earlier booking on a court it does not drive: if the
    /// selection took the earliest sixteen of everything and the formatter dropped the
    /// stranger, the box would be sent fifteen and refuse a paid member — and the roster
    /// would have minted a code for a booking on a court this box cannot light.
    /// </summary>
    [Fact]
    public async Task A_booking_on_another_court_neither_takes_a_roster_slot_nor_gets_a_code_minted()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var court5 = new Court { TenantId = f.Host.Tenant.Id, CourtNumber = 5, Name = "Court 5", SlicePriceCredits = 8m };
        f.Db.Courts.Add(court5);
        await f.Db.SaveChangesAsync();

        var stranger = await BookAsync(f, court5, startsInMinutes: 1, minutes: 5);
        for (var i = 0; i < DeviceRosterBuilder.RosterMaxEntries; i++)
        {
            await BookAsync(f, f.Host.Courts[i % 4], startsInMinutes: 2 + i * 5, minutes: 5);
        }

        var roster = await BuildAsync(f, BoxOn(f, 1, 2, 3, 4));

        Assert.Equal(DeviceRosterBuilder.RosterMaxEntries, roster.Count);
        Assert.Equal("", await CodeOfOrEmptyAsync(f, stranger));
    }

    /// <summary>
    /// The relay is the court's POSITION in the box's list, not its number. A box wired
    /// backwards — court 4 on relay A — sends a court-2 booking as relay 2.
    /// </summary>
    [Fact]
    public async Task The_relay_is_the_position_of_the_court_in_the_boxs_list()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        await BookAsync(f, f.Host.Courts[1], startsInMinutes: 5);   // court 2

        var entry = Assert.Single(await BuildAsync(f, BoxOn(f, 4, 3, 2, 1)));
        Assert.Equal(2, RelayOf(entry));

        var straight = Assert.Single(await BuildAsync(f, BoxOn(f, 1, 2, 3, 4)));
        Assert.Equal(1, RelayOf(straight));
    }

    /// <summary>
    /// The window is <c>[StartsAt − cue, EndsAt] ∩ [now, now + roster_window]</c>. A
    /// booking whose cue opens one minute past the horizon is absent; one minute inside it
    /// is present. A booking that ended a minute ago is absent; one with a minute left is
    /// present — a late arrival still gets what is left of the slot.
    /// </summary>
    [Fact]
    public async Task Bookings_just_outside_the_window_are_absent_and_just_inside_are_present()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var horizon = f.Settings.RosterWindowMinutes + f.Settings.ActivationCueWindowMinutes;
        var justOutside = await BookAsync(f, f.Host.Courts[0], startsInMinutes: horizon + 1);
        var justInside = await BookAsync(f, f.Host.Courts[1], startsInMinutes: horizon - 1);
        var justEnded = await BookAsync(f, f.Host.Courts[2], startsInMinutes: -46, minutes: 45);
        var almostOver = await BookAsync(f, f.Host.Courts[3], startsInMinutes: -44, minutes: 45);

        var roster = await BuildAsync(f, BoxOn(f, 1, 2, 3, 4));
        var tokens = roster.Select(TokenOf).ToList();

        Assert.DoesNotContain(await CodeOfOrEmptyAsync(f, justOutside), tokens);
        Assert.DoesNotContain(await CodeOfOrEmptyAsync(f, justEnded), tokens);
        Assert.Contains(await CodeOfAsync(f, justInside), tokens);
        Assert.Contains(await CodeOfAsync(f, almostOver), tokens);
        Assert.Equal(2, roster.Count);
    }

    /// <summary>A booking outside the window is never minted a code by the roster, so "its code" may not exist.</summary>
    private static async Task<string> CodeOfOrEmptyAsync(Fixture f, Booking booking) =>
        (await f.Db.AccessCodes.AsNoTracking().FirstOrDefaultAsync(c => c.BookingId == booking.Id))?.Code ?? "";

    /// <summary>
    /// A live session STAYS on the roster while its window is open. It used to be dropped
    /// on the grounds that a re-light is the online path's job — but the relay hard cap is
    /// ninety minutes and a slot can be longer, so the second half of a paid two-hour slot
    /// was dark during any outage: the box had nothing to re-light it from.
    /// </summary>
    [Fact]
    public async Task A_checked_in_booking_still_in_its_window_is_included()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var live = await BookAsync(f, f.Host.Courts[0], startsInMinutes: -5, minutes: 120, checkedIn: true);
        var pending = await BookAsync(f, f.Host.Courts[1], startsInMinutes: 5);

        var roster = await BuildAsync(f, BoxOn(f, 1, 2, 3, 4));
        Assert.Equal(2, roster.Count);
        Assert.Contains(roster, e => TokenOf(e) == CodeOfAsync(f, live).Result && RelayOf(e) == 0 && ClosesInOf(e) > 100 * 60);
        Assert.Contains(roster, e => TokenOf(e) == CodeOfAsync(f, pending).Result && RelayOf(e) == 1);
    }

    /// <summary>...and drops off once it has ended, like any other booking.</summary>
    [Fact]
    public async Task A_checked_in_booking_that_has_ended_is_excluded()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        await BookAsync(f, f.Host.Courts[0], startsInMinutes: -50, minutes: 45, checkedIn: true);
        var pending = await BookAsync(f, f.Host.Courts[1], startsInMinutes: 5);

        var entry = Assert.Single(await BuildAsync(f, BoxOn(f, 1, 2, 3, 4)));
        Assert.Equal(await CodeOfAsync(f, pending), TokenOf(entry));
    }

    /// <summary>
    /// Seventeen bookings inside the window on one box: the sixteen that start first go,
    /// the seventeenth waits for a later heartbeat. Earliest, because that is the member
    /// standing at the box now.
    /// </summary>
    [Fact]
    public async Task The_cap_keeps_the_sixteen_earliest_and_every_entry_matches_the_contract_grammar()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var bookings = new List<Booking>();
        for (var i = 0; i < DeviceRosterBuilder.RosterMaxEntries + 1; i++)
        {
            bookings.Add(await BookAsync(f, f.Host.Courts[i % 4], startsInMinutes: 1 + i * 5, minutes: 5));
        }

        var roster = await BuildAsync(f, BoxOn(f, 1, 2, 3, 4));

        Assert.Equal(DeviceRosterBuilder.RosterMaxEntries, roster.Count);
        Assert.All(roster, entry => Assert.Matches(DeviceProtocolCorpusTests.RosterEntryPattern, entry));

        var tokens = roster.Select(TokenOf).ToList();
        Assert.DoesNotContain(await CodeOfOrEmptyAsync(f, bookings[^1]), tokens);
        Assert.Contains(await CodeOfAsync(f, bookings[0]), tokens);

        var opensIn = roster.Select(OpensInOf).ToList();
        Assert.Equal(opensIn.OrderBy(x => x), opensIn);
    }

    /// <summary>The token the box matches is the booking's own activation code — the bytes the member's phone shows.</summary>
    [Fact]
    public async Task The_token_is_the_bookings_activation_code_minted_once()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var booking = await BookAsync(f, f.Host.Courts[0], startsInMinutes: 5);
        var box = BoxOn(f, 1);

        var first = Assert.Single(await BuildAsync(f, box));
        var second = Assert.Single(await BuildAsync(f, box));

        Assert.Equal(TokenOf(first), TokenOf(second));
        Assert.Equal(await CodeOfAsync(f, booking), TokenOf(first));
        Assert.Equal(AccessCode.Length, TokenOf(first).Length);

        var resolved = await f.Codes.ResolveAsync(TokenOf(first), default);
        Assert.NotNull(resolved);
        Assert.Equal(AccessCodePurpose.BookingActivation, resolved.Purpose);
        Assert.Equal(booking.Id, resolved.BookingId);
        Assert.Equal(1, await f.Db.AccessCodes.CountAsync(c => c.BookingId == booking.Id));
    }

    // ---- Relative time ---------------------------------------------------------

    /// <summary>
    /// The arithmetic against a fixed clock, with no database: opens_in counts to
    /// <c>StartsAt − cue</c> and goes negative once the cue is open; closes_in counts to
    /// <c>EndsAt</c>. Both floored, so a booking half a second from opening is not open.
    /// </summary>
    [Fact]
    public void Relative_seconds_are_measured_from_the_response_instant_and_the_cue_window()
    {
        var now = new DateTimeOffset(2023, 11, 14, 22, 13, 20, TimeSpan.Zero);
        var cue = TimeSpan.FromMinutes(10);

        Booking At(double startsInMinutes, int minutes) => new()
        {
            TenantId = Guid.NewGuid(),
            CourtId = Guid.NewGuid(),
            StartsAt = now.AddMinutes(startsInMinutes),
            EndsAt = now.AddMinutes(startsInMinutes + minutes),
        };

        var roster = DeviceRosterBuilder.Format(
        [
            new DeviceRosterBuilder.Candidate(At(30, 45), 3, "7Q3F9KM2XZ8B"),
            new DeviceRosterBuilder.Candidate(At(-20, 45), 1, "K4TQ8N2ZV7BM"),
            new DeviceRosterBuilder.Candidate(At(0.0083, 15), 2, "ABCDEFGH2345"),   // opens in 0.5 s, less the cue
        ], [1, 2, 3, 4], now, cue);

        Assert.Equal(
        [
            "K4TQ8N2ZV7BM|0|-1800|1500",   // started 20 min ago: cue opened 30 min ago, 25 min left
            "ABCDEFGH2345|1|-600|900",      // starts in half a second: the cue is long open
            "7Q3F9KM2XZ8B|2|1200|4500",    // starts in 30: cue opens in 20, ends in 75
        ], roster);
    }

    /// <summary>Format is pure over its inputs: the cap, the relay lookup and the token wall need no database to be wrong.</summary>
    [Fact]
    public void Format_drops_what_the_box_cannot_express_and_caps_after_ordering()
    {
        var now = DateTimeOffset.UtcNow;
        Booking At(int i) => new() { StartsAt = now.AddMinutes(i), EndsAt = now.AddMinutes(i + 10) };

        var candidates = Enumerable.Range(0, 20)
            .Select(i => new DeviceRosterBuilder.Candidate(At(i), 1 + (i % 2), $"TOKEN{i:00}"))
            .Reverse()   // inserted latest-first; the cap must still keep the earliest
            .Append(new DeviceRosterBuilder.Candidate(At(-5), 9, "NOTONTHISBOX"))
            .Append(new DeviceRosterBuilder.Candidate(At(-4), 1, new string('A', DeviceRosterBuilder.MaxTokenLength + 1)))
            .ToList();

        var roster = DeviceRosterBuilder.Format(candidates, [1, 2], now, TimeSpan.Zero);

        Assert.Equal(DeviceRosterBuilder.RosterMaxEntries, roster.Count);
        Assert.Equal("TOKEN00", roster[0].Split('|')[0]);
        Assert.Equal("TOKEN15", roster[^1].Split('|')[0]);
        Assert.DoesNotContain(roster, e => e.StartsWith("NOTONTHISBOX", StringComparison.Ordinal));
        Assert.DoesNotContain(roster, e => e.StartsWith("AAAAA", StringComparison.Ordinal));
        Assert.All(roster, e => Assert.InRange(RelayOf(e), 0, 1));
    }

    [Fact]
    public void A_box_with_no_courts_has_an_empty_roster()
    {
        var roster = DeviceRosterBuilder.Format(
            [new DeviceRosterBuilder.Candidate(new Booking { StartsAt = DateTimeOffset.UtcNow, EndsAt = DateTimeOffset.UtcNow.AddHours(1) }, 1, "TOKEN")],
            [], DateTimeOffset.UtcNow, TimeSpan.Zero);
        Assert.Empty(roster);
    }

    // ---- Tenant isolation -------------------------------------------------------

    /// <summary>
    /// Two clubs in one database, both with a court 1. Club B's booking on ITS court 1
    /// never reaches club A's box, however the box is wired — and the row really is there,
    /// so the absence is the filter and not an empty table. Cross-tenant leakage on this
    /// path lights a court at one club for a member of another.
    /// </summary>
    [Fact]
    public async Task Another_clubs_booking_never_appears_in_this_clubs_roster()
    {
        var shared = $"crusaders-roster-{Guid.NewGuid():N}";
        var a = await CreateAsync(sharedDb: shared, slug: "club-a");
        var b = await CreateAsync(sharedDb: shared, slug: "club-b");
        await using var _ = a.Host;
        await using var __ = b.Host;
        using var ___ = a.Scope;
        using var ____ = b.Scope;

        var bookingB = await BookAsync(b, b.Host.Courts[0], startsInMinutes: 5);
        var bookingA = await BookAsync(a, a.Host.Courts[0], startsInMinutes: 5);

        var rosterA = await BuildAsync(a, BoxOn(a, 1, 2, 3, 4));
        var entry = Assert.Single(rosterA);
        Assert.Equal(await CodeOfAsync(a, bookingA), TokenOf(entry));

        // The other club's row exists in the same store, is inside the window, and is on a
        // court numbered 1 — everything but the tenant matches.
        Assert.NotNull(await a.Db.Bookings.IgnoreQueryFilters().SingleOrDefaultAsync(x => x.Id == bookingB.Id));
        Assert.Empty(await a.Db.AccessCodes.IgnoreQueryFilters().Where(c => c.BookingId == bookingB.Id && c.TenantId == a.Host.Tenant.Id).ToListAsync());

        // And club B's own box sees only its own.
        var rosterB = await BuildAsync(b, BoxOn(b, 1, 2, 3, 4));
        Assert.Equal(await CodeOfAsync(b, bookingB), TokenOf(Assert.Single(rosterB)));
    }
}

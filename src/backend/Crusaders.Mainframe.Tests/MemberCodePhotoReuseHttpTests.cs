using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Crusaders.Mainframe.Api.Domain;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 8, D8-1 — the server's half. A photo of a code that has just lit a court is a
/// code whose COURT use is spent and whose MONEY use is not: the use table is per class (§4.4), so
/// a walk-up or a pay-for on it read an untouched money class and charged the victim. Money now
/// refuses a code that already has a court use at the same step, and an activation that would
/// refuse such a code for a booking reason (no booking here, wrong court) answers
/// <c>code_used</c> instead — the one refusal the box arms nothing for.
/// </summary>
public sealed class MemberCodePhotoReuseHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private static async Task<(HttpStatusCode Status, JsonElement Body)> SendAsync(HttpClient device, HttpRequestMessage req)
    {
        var response = await device.SendAsync(req);
        var text = await response.Content.ReadAsStringAsync();
        return (response.StatusCode, text.Length > 0 ? JsonDocument.Parse(text).RootElement.Clone() : default);
    }

    private static string Reason(JsonElement body) =>
        body.TryGetProperty("reason", out var r) ? r.GetString()! : body.GetProperty("error").GetString()!;

    /// <summary>A second court box, driving only <paramref name="courts"/>, acknowledged like the first.</summary>
    private static async Task<string> SecondBoxAsync(MemberCodeClub club, WebApplicationFactory<Program> app, params int[] courts)
    {
        var mac = Guid.NewGuid().ToString("N")[..12];
        await club.WriteAsync(app, db =>
        {
            db.Devices.Add(new Device
            {
                TenantId = club.TenantId, DeviceCode = $"box-{mac[^6..]}", Name = "Box two", Kind = DeviceKind.CourtBox,
                MacAddress = mac, CourtNumbers = [.. courts], AutoRegistered = false,
            });
            return Task.CompletedTask;
        });
        return mac;
    }

    private static HttpRequestMessage ActivateAt(MemberCodeClub club, string mac, string token) =>
        club.Device("/api/v1/device/activate", new JsonObject { ["mac"] = mac, ["method"] = "qr", ["token"] = token });

    [SkippableFact]
    public async Task A_code_that_lit_a_court_buys_nothing_at_the_same_step_and_the_next_code_does()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var clock = new PinnedClock();
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService(), clock);
        var club = await MemberCodeClub.SeedAsync(app, "photo1");
        await club.BookAsync(app, club.Olga, courtIndex: 0, startsInMinutes: -5);                    // Olga: court 1
        await club.BookAsync(app, club.Pam, courtIndex: 1, startsInMinutes: -10, checkedIn: true);  // Pam: court 2, payable
        var device = app.CreateClient();
        var before = await club.BalanceAsync(app, club.Olga);

        // Olga lights her court. Somebody photographed the code on her screen.
        var photo = club.Code(club.Olga, at: clock.Now);
        var lit = await SendAsync(device, club.Activate(photo));
        Assert.True(lit.Body.GetProperty("activated").GetBoolean());

        // The photo cannot buy a walk-up on her minutes...
        var walkUp = await SendAsync(device, club.WalkUp(photo, court: 3, nonce: "0123456789abcdef"));
        Assert.Equal(HttpStatusCode.Conflict, walkUp.Status);
        Assert.Equal("code_used", Reason(walkUp.Body));

        // ...nor be quoted, nor pay, for Pam's court.
        var quote = await SendAsync(device, club.PayFor(photo, 2, "fedcba9876543210", confirm: false));
        Assert.False(quote.Body.GetProperty("payable").GetBoolean());
        Assert.Equal("code_used", Reason(quote.Body));
        var confirm = await SendAsync(device, club.PayFor(photo, 2, "fedcba9876543210", confirm: true, label: "60"));
        Assert.False(confirm.Body.GetProperty("paid").GetBoolean());
        Assert.Equal("code_used", Reason(confirm.Body));

        Assert.Equal(before, await club.BalanceAsync(app, club.Olga));
        Assert.Equal(0, await club.UsesAsync(app, MemberCodeUseClass.Money));

        // The rule is per code, not per member: her NEXT code buys a walk-up as it always did.
        var next = club.Code(club.Olga, at: clock.Now, stepOffset: 1);
        var bought = await SendAsync(device, club.WalkUp(next, court: 3, nonce: "aaaabbbbccccdddd"));
        Assert.Equal(HttpStatusCode.OK, bought.Status);
        Assert.True(await club.BalanceAsync(app, club.Olga) < before);
    }

    [SkippableFact]
    public async Task A_code_already_acted_on_is_code_used_at_a_box_where_it_has_no_booking()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var clock = new PinnedClock();
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService(), clock);
        var club = await MemberCodeClub.SeedAsync(app, "photo2");
        await club.BookAsync(app, club.Olga, courtIndex: 0, startsInMinutes: -5);   // court 1, on box one only
        var boxTwo = await SecondBoxAsync(club, app, 4);
        var device = app.CreateClient();

        // A code that lit a court at box one, shown at box two: not "no booking" — which arms the
        // buttons — but code_used, which arms nothing.
        var photo = club.Code(club.Olga, at: clock.Now);
        Assert.True((await SendAsync(device, club.Activate(photo))).Body.GetProperty("activated").GetBoolean());
        var there = await SendAsync(device, ActivateAt(club, boxTwo, photo));
        Assert.False(there.Body.GetProperty("activated").GetBoolean());
        Assert.Equal("code_used", Reason(there.Body));

        // A code that bought a walk-up at box one, shown at box two: the same.
        var pams = club.Code(club.Pam, at: clock.Now);
        Assert.Equal(HttpStatusCode.OK, (await SendAsync(device, club.WalkUp(pams, court: 3, nonce: "1111222233334444"))).Status);
        var again = await SendAsync(device, ActivateAt(club, boxTwo, pams));
        Assert.Equal("code_used", Reason(again.Body));

        // A code nothing has acted on is still the member with no booking here, who may buy.
        var fresh = club.Code(club.AdminId, at: clock.Now);
        var none = await SendAsync(device, ActivateAt(club, boxTwo, fresh));
        Assert.Equal("no_booking", Reason(none.Body));

        // And the door is another class: a front door opened on the code at this step does not
        // make the court read code_used (§4.4).
        var door = club.Code(club.Pam, at: clock.Now, stepOffset: 1);
        Assert.True((await SendAsync(device, club.Gate(door))).Body.GetProperty("opened").GetBoolean());
        Assert.Equal("no_booking", Reason((await SendAsync(device, ActivateAt(club, boxTwo, door))).Body));
    }

    /// <summary>What a refused activation must have left untouched: the booking dark, the purse whole, no court use, no audit row but the refusal's own.</summary>
    private static async Task AssertNothingLitAsync(
        MemberCodeClub club, WebApplicationFactory<Program> app, Booking booking, Guid member, int balance, int courtUses, int audits)
    {
        var stored = await club.ReadAsync(app, db => db.Bookings.IgnoreQueryFilters().AsNoTracking().FirstAsync(b => b.Id == booking.Id));
        Assert.Null(stored.CheckedInAt);
        Assert.Equal(balance, await club.BalanceAsync(app, member));
        Assert.Equal(courtUses, await club.UsesAsync(app, MemberCodeUseClass.Court));
        Assert.Equal(audits, await AuditsAsync(club, app));
    }

    /// <summary>Rows that would say something HAPPENED — the refusal's own record (E9-6) is expected, and not counted.</summary>
    private static Task<int> AuditsAsync(MemberCodeClub club, WebApplicationFactory<Program> app) =>
        club.ReadAsync(app, db => db.AuditLogs.IgnoreQueryFilters()
            .CountAsync(a => a.TenantId == club.TenantId && a.Action != "court.activation_refused"));

    /// <summary>
    /// Review round 8, D8-1 — the other direction. The use table is per class, so a photo of the
    /// code that had just BOUGHT a walk-up at box one still had an unspent court class, and lit the
    /// member's own booking at box two. An activation that would light a court is now
    /// <c>code_used</c> when the code holds a money use: nothing lit, nothing charged, and no audit
    /// row, exactly as for any other <c>code_used</c> on this path.
    /// </summary>
    [SkippableFact]
    public async Task A_code_that_bought_a_walk_up_lights_nothing_at_another_box()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var clock = new PinnedClock();
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService(), clock);
        var club = await MemberCodeClub.SeedAsync(app, "photo3");
        var boxTwo = await SecondBoxAsync(club, app, 4);
        var device = app.CreateClient();

        // Pam buys a walk-up on court 3 at box one. Somebody photographed the code.
        var photo = club.Code(club.Pam, at: clock.Now);
        Assert.Equal(HttpStatusCode.OK, (await SendAsync(device, club.WalkUp(photo, court: 3, nonce: "5555666677778888"))).Status);
        Assert.Equal(1, await club.UsesAsync(app, MemberCodeUseClass.Money));

        // Her own booking on court 4, which only box two drives.
        var hers = await club.BookAsync(app, club.Pam, courtIndex: 3, startsInMinutes: -5);
        var balance = await club.BalanceAsync(app, club.Pam);
        var courtUses = await club.UsesAsync(app, MemberCodeUseClass.Court);
        var audits = await AuditsAsync(club, app);

        var there = await SendAsync(device, ActivateAt(club, boxTwo, photo));
        Assert.False(there.Body.GetProperty("activated").GetBoolean());
        Assert.Equal("code_used", Reason(there.Body));
        await AssertNothingLitAsync(club, app, hers, club.Pam, balance, courtUses, audits);

        // Her next code lights it as it always did.
        var next = club.Code(club.Pam, at: clock.Now, stepOffset: 1);
        Assert.True((await SendAsync(device, ActivateAt(club, boxTwo, next))).Body.GetProperty("activated").GetBoolean());
    }

    /// <summary>The same for a code that paid for somebody else's court at box one.</summary>
    [SkippableFact]
    public async Task A_code_that_paid_for_a_court_lights_nothing_at_another_box()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var clock = new PinnedClock();
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService(), clock);
        var club = await MemberCodeClub.SeedAsync(app, "photo4");
        await club.BookAsync(app, club.Pam, courtIndex: 1, startsInMinutes: -10, checkedIn: true);  // Pam: court 2, payable
        var boxTwo = await SecondBoxAsync(club, app, 4);
        var device = app.CreateClient();

        // Olga pays for Pam's court at box one.
        var photo = club.Code(club.Olga, at: clock.Now);
        var quote = await SendAsync(device, club.PayFor(photo, 2, "9999aaaabbbbcccc", confirm: false));
        Assert.True(quote.Body.GetProperty("payable").GetBoolean());
        var label = quote.Body.GetProperty("amount_label").GetString();
        var paid = await SendAsync(device, club.PayFor(photo, 2, "9999aaaabbbbcccc", confirm: true, label: label));
        Assert.True(paid.Body.GetProperty("paid").GetBoolean());

        // Olga's own booking on court 4, at box two: the photo of the paying code lights nothing.
        var hers = await club.BookAsync(app, club.Olga, courtIndex: 3, startsInMinutes: -5);
        var balance = await club.BalanceAsync(app, club.Olga);
        var courtUses = await club.UsesAsync(app, MemberCodeUseClass.Court);
        var audits = await AuditsAsync(club, app);

        var there = await SendAsync(device, ActivateAt(club, boxTwo, photo));
        Assert.False(there.Body.GetProperty("activated").GetBoolean());
        Assert.Equal("code_used", Reason(there.Body));
        await AssertNothingLitAsync(club, app, hers, club.Olga, balance, courtUses, audits);
    }

    /// <summary>
    /// The door is still another class: a front door opened on the code, then the member's own
    /// court lit on it inside the same step (§4.4).
    /// </summary>
    [SkippableFact]
    public async Task Front_door_then_court_on_one_code_still_lights_the_court()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var clock = new PinnedClock();
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService(), clock);
        var club = await MemberCodeClub.SeedAsync(app, "photo5");
        await club.BookAsync(app, club.Olga, courtIndex: 0, startsInMinutes: -5);
        var device = app.CreateClient();

        var code = club.Code(club.Olga, at: clock.Now);
        Assert.True((await SendAsync(device, club.Gate(code))).Body.GetProperty("opened").GetBoolean());
        Assert.True((await SendAsync(device, club.Activate(code))).Body.GetProperty("activated").GetBoolean());
    }

    /// <summary>
    /// Review round 9, E9-6: the door wrote a reused code's refusal against the member, the court
    /// boxes wrote nothing — the Night of a member whose code was photographed showed the door
    /// turning the photo away and nothing at either court. Every court-box <c>code_used</c> (a
    /// repeat at the same box, another box, a walk-up) is now on the member's record, by reason,
    /// and the code itself is never written down.
    /// </summary>
    [SkippableFact]
    public async Task A_reused_code_turned_away_at_a_court_box_is_on_the_members_record()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var clock = new PinnedClock();
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService(), clock);
        var club = await MemberCodeClub.SeedAsync(app, "photo9");
        await club.BookAsync(app, club.Olga, courtIndex: 0, startsInMinutes: -5);
        var boxTwo = await SecondBoxAsync(club, app, 4);
        var device = app.CreateClient();

        var photo = club.Code(club.Olga, at: clock.Now);
        Assert.True((await SendAsync(device, club.Activate(photo))).Body.GetProperty("activated").GetBoolean());
        Assert.Equal("code_used", Reason((await SendAsync(device, club.Activate(photo))).Body));           // same box
        Assert.Equal("code_used", Reason((await SendAsync(device, ActivateAt(club, boxTwo, photo))).Body)); // another box
        Assert.Equal("code_used", Reason((await SendAsync(device, club.WalkUp(photo, court: 3, nonce: "9999888877776666"))).Body));

        var rows = await club.ReadAsync(app, db => db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId && a.Action == "court.activation_refused").OrderBy(a => a.CreatedAt).ToListAsync());
        Assert.Equal(3, rows.Count);
        Assert.All(rows, a =>
        {
            Assert.Equal(club.Olga, a.SubjectUserId);
            Assert.Equal(Guid.Empty, a.ActorUserId);
            Assert.Equal("code_used", JsonDocument.Parse(a.DetailsJson!).RootElement.GetProperty("reason").GetString());
            Assert.DoesNotContain(photo, a.DetailsJson, StringComparison.Ordinal);
        });

        var night = await club.Member(app, club.AdminId, "admin")
            .GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{club.Olga}/trace?day={clock.Now:yyyy-MM-dd}");
        var refused = night.GetProperty("events").EnumerateArray()
            .Where(e => e.GetProperty("kind").GetString() == "court.refused")
            .Select(e => e.GetProperty("headline").GetString()).ToList();
        Assert.Equal(3, refused.Count);
        Assert.Contains("Was turned away at Court 1 — code already used", refused);
        Assert.Contains("Was turned away at Court 4 — code already used", refused);
        Assert.Contains("Was turned away at Court 3 — code already used", refused);
    }
}

using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Crusaders.Mainframe.Api.Domain;
using Microsoft.AspNetCore.Mvc.Testing;

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
}

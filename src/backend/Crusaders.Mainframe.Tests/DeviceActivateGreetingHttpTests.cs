using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Crusaders.Mainframe.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// <c>POST /api/v1/device/activate</c>'s greeting: every answer about a member this club knows —
/// lit or refused — carries <c>greeting_name</c> (their upper-case, ASCII first name) and
/// <c>balance_minutes</c> (what they may spend, from the ledger); an unrecognised code carries
/// neither, because the fields' presence is what "recognised" means on the wire.
/// </summary>
public sealed class DeviceActivateGreetingHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private static async Task<(HttpStatusCode Status, JsonElement Body)> SendAsync(HttpClient device, HttpRequestMessage req)
    {
        var response = await device.SendAsync(req);
        return (response.StatusCode, await MemberCodeClub.JsonAsync(response));
    }

    [SkippableFact]
    public async Task A_granted_activation_greets_the_member_by_first_name_with_their_spendable_minutes()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var c = await MemberCodeClub.SeedAsync(app, "greetok", MemberCodeClub.SettingsAtNoon());
        await c.BookAsync(app, c.Olga, courtIndex: 0, startsInMinutes: -2);

        var (status, body) = await SendAsync(app.CreateClient(), c.Activate(c.Code(c.Olga)));

        Assert.Equal(HttpStatusCode.OK, status);
        Assert.True(body.GetProperty("activated").GetBoolean());
        Assert.Equal("OLGA", body.GetProperty("greeting_name").GetString());
        Assert.Equal(140, body.GetProperty("balance_minutes").GetInt32());   // 200 − the 60 the booking cost
        Assert.Equal(await c.BalanceAsync(app, c.Olga), body.GetProperty("balance_minutes").GetInt32());
    }

    [SkippableFact]
    public async Task A_refused_but_recognised_member_is_still_greeted_with_their_balance()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var c = await MemberCodeClub.SeedAsync(app, "greetref", MemberCodeClub.SettingsAtNoon());
        await c.WriteAsync(app, async db =>
            (await db.Memberships.IgnoreQueryFilters().SingleAsync(m => m.Id == c.SidMembership)).Status = MembershipStatus.Suspended);
        var device = app.CreateClient();

        // Pam has no booking; Sid is barred. Both are people this club knows. (A barred member's
        // rotating code no longer resolves at all, so Sid shows the app's ident QR.)
        var (_, pam) = await SendAsync(device, c.Activate(c.Code(c.Pam)));
        var (_, sid) = await SendAsync(device, c.Activate(await TestAccessCodes.MintIdentAsync(app.Services, c.TenantId, c.Slug, c.Sid)));

        Assert.False(pam.GetProperty("activated").GetBoolean());
        Assert.Equal("PAM", pam.GetProperty("greeting_name").GetString());
        Assert.Equal(200, pam.GetProperty("balance_minutes").GetInt32());
        Assert.False(sid.GetProperty("activated").GetBoolean());
        Assert.Equal("SID", sid.GetProperty("greeting_name").GetString());
        Assert.Equal(200, sid.GetProperty("balance_minutes").GetInt32());
    }

    [SkippableFact]
    public async Task The_greeting_is_folded_to_plain_letters_and_empty_for_a_member_with_no_name()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var c = await MemberCodeClub.SeedAsync(app, "greetname", MemberCodeClub.SettingsAtNoon());
        await c.WriteAsync(app, async db =>
        {
            (await db.Memberships.IgnoreQueryFilters().SingleAsync(m => m.UserId == c.Pam)).FullName = "Zoë Ångström-Nel";
            (await db.Memberships.IgnoreQueryFilters().SingleAsync(m => m.UserId == c.Olga)).FullName = "";
        });
        var device = app.CreateClient();

        var (_, pam) = await SendAsync(device, c.Activate(c.Code(c.Pam)));
        var (_, olga) = await SendAsync(device, c.Activate(c.Code(c.Olga)));

        Assert.Equal("ZOE", pam.GetProperty("greeting_name").GetString());
        // Present and empty: recognised, with nothing on file to print.
        Assert.Equal("", olga.GetProperty("greeting_name").GetString());
        Assert.Equal(200, olga.GetProperty("balance_minutes").GetInt32());
    }

    [SkippableFact]
    public async Task The_balance_is_what_the_member_may_spend_not_a_stored_figure()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var c = await MemberCodeClub.SeedAsync(app, "greetbal", MemberCodeClub.SettingsAtNoon());
        await c.WriteAsync(app, db =>
        {
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = c.TenantId, UserId = c.Pam, Type = LedgerEntryType.AdminAdjustment, AmountMinutes = -37,
                ActorUserId = c.AdminId, Reason = "test: a debit since the seed",
            });
            return Task.CompletedTask;
        });

        var (_, pam) = await SendAsync(app.CreateClient(), c.Activate(c.Code(c.Pam)));

        Assert.Equal(163, pam.GetProperty("balance_minutes").GetInt32());
        Assert.Equal(JsonValueKind.Number, pam.GetProperty("balance_minutes").ValueKind);
    }

    [SkippableFact]
    public async Task An_unrecognised_code_and_another_clubs_member_get_neither_field()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var a = await MemberCodeClub.SeedAsync(app, "greetxa", MemberCodeClub.SettingsAtNoon());
        var b = await MemberCodeClub.SeedAsync(app, "greetxb", MemberCodeClub.SettingsAtNoon());
        var device = app.CreateClient();

        var unknown = await SendAsync(device, a.Activate("nobody-at-all"));
        var foreignCode = await SendAsync(device, a.Activate(b.Code(b.Pam)));
        var foreignQr = await SendAsync(device, a.Activate(await TestAccessCodes.MintIdentAsync(app.Services, b.TenantId, b.Slug, b.Pam)));
        var pin = await SendAsync(device, a.Device("/api/v1/device/activate", new JsonObject
        {
            ["mac"] = a.BoxMac, ["method"] = "pin", ["token"] = "1234",
        }));

        foreach (var (status, body) in new[] { unknown, foreignCode, foreignQr, pin })
        {
            Assert.Equal(HttpStatusCode.OK, status);
            Assert.False(body.GetProperty("activated").GetBoolean());
            Assert.Equal("not_recognised", body.GetProperty("reason").GetString());
            Assert.False(body.TryGetProperty("greeting_name", out _));
            Assert.False(body.TryGetProperty("balance_minutes", out _));
        }
    }

    [SkippableFact]
    public async Task A_door_gate_asking_to_activate_gets_neither_field()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var c = await MemberCodeClub.SeedAsync(app, "greetgate", MemberCodeClub.SettingsAtNoon());

        var (status, body) = await SendAsync(app.CreateClient(), c.Device("/api/v1/device/activate", new JsonObject
        {
            ["mac"] = c.DoorMac, ["method"] = "qr", ["token"] = c.Code(c.Pam),
        }));

        Assert.Equal(HttpStatusCode.OK, status);
        Assert.False(body.GetProperty("activated").GetBoolean());
        Assert.False(body.TryGetProperty("greeting_name", out _));
        Assert.False(body.TryGetProperty("balance_minutes", out _));
    }
}

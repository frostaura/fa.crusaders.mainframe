using System.Net;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// D10 — paying for somebody else's court at the box (<c>docs/specs/member-code.md</c> §9.2), over
/// HTTP against Postgres: the decision table, the money (a refund and a debit of the same amount,
/// posted together, nothing else), the nonce's idempotent replay, and both emails.
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class MemberCodePayForHttpTests(PostgresFixture pg)
{
    private const string Nonce = "9f2a4c6e8b0d1f3a";

    private sealed record Rig(MemberCodeClub Club, Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<Program> App, StubEmailService Mail, HttpClient Device);

    private async Task<Rig> RigAsync(TestWebAppFactory factory, string prefix)
    {
        var mail = new StubEmailService();
        var app = MemberCodeClub.Wired(factory, mail);
        var club = await MemberCodeClub.SeedAsync(app, prefix);
        return new Rig(club, app, mail, app.CreateClient());
    }

    private static async Task<(HttpStatusCode Status, string Body)> SendAsync(Rig r, HttpRequestMessage req)
    {
        var response = await r.Device.SendAsync(req);
        return (response.StatusCode, await response.Content.ReadAsStringAsync());
    }

    [SkippableFact]
    public async Task Quote_then_confirm_moves_the_charge_to_the_payer_refunds_the_booker_and_mails_both()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        var r = await RigAsync(factory, "payok");
        await using var _ = r.App;
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -10, checkedIn: true);   // 32 credits, lit
        var code = c.Code(c.Pam);

        var quote = await SendAsync(r, c.PayFor(code, 2, Nonce, confirm: false));
        Assert.Equal(HttpStatusCode.OK, quote.Status);
        Assert.Equal("""{"payable":true,"reason":"ok","court_number":2,"amount_credits":32.0,"amount_label":"32"}""", quote.Body);
        Assert.Equal(200m, await c.BalanceAsync(r.App, c.Pam));   // a quote moves nothing
        Assert.Equal(0, await c.UsesAsync(r.App));

        var paid = await SendAsync(r, c.PayFor(code, 2, Nonce, confirm: true, label: "32"));
        Assert.Equal(
            """{"paid":true,"reason":"ok","court_number":2,"amount_credits":32.0,"amount_label":"32","balance_after_credits":168.0,"replayed":false,"granted_seconds":0}""",
            paid.Body);

        Assert.Equal(168m, await c.BalanceAsync(r.App, c.Pam));
        Assert.Equal(200m, await c.BalanceAsync(r.App, c.Olga));   // 200 − 32 at booking + 32 back
        var rows = await c.ReadAsync(r.App, db => db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.TenantId == c.TenantId && l.RelatedBookingId == booking.Id).OrderBy(l => l.AmountCredits).ToListAsync());
        Assert.Equal(3, rows.Count);   // the seed charge, the payer's debit, the booker's refund — nothing else
        Assert.Equal(-32m, rows.Single(l => l.UserId == c.Pam).AmountCredits);
        Assert.Equal(c.Pam, rows.Single(l => l.UserId == c.Pam).ActorUserId);
        Assert.Equal(32m, rows.Single(l => l.UserId == c.Olga && l.AmountCredits > 0).AmountCredits);
        Assert.Equal(0m, rows.Sum(l => l.AmountCredits) + 32m);   // net across both members is the one original charge

        var stored = await c.ReadAsync(r.App, db => db.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == booking.Id));
        Assert.Equal(c.Pam, stored.PaidByUserId);
        Assert.Equal(1, await c.UsesAsync(r.App, MemberCodeUseClass.Money));
        Assert.Equal(2, r.Mail.Sent.Count(m => m.Subject.Contains("paid for", StringComparison.OrdinalIgnoreCase)));
        Assert.Single(await c.ReadAsync(r.App, db => db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == c.TenantId && a.Action == DevicePayForEndpoint.PaidAction).ToListAsync()));
    }

    [SkippableFact]
    public async Task A_retried_confirm_is_answered_with_the_first_payment_and_never_charges_twice()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        var r = await RigAsync(factory, "payreplay");
        await using var _ = r.App;
        var c = r.Club;
        await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -10, checkedIn: true);
        var code = c.Code(c.Pam);

        await SendAsync(r, c.PayFor(code, 2, Nonce, confirm: false));
        var first = await SendAsync(r, c.PayFor(code, 2, Nonce, confirm: true, label: "32"));
        var again = await SendAsync(r, c.PayFor(code, 2, Nonce, confirm: true, label: "32"));
        var third = await SendAsync(r, c.PayFor(c.Code(c.Pam, stepOffset: 1), 2, Nonce, confirm: true, label: "32"));

        Assert.Contains("\"replayed\":false", first.Body);
        Assert.Equal(
            """{"paid":true,"reason":"ok","court_number":2,"amount_credits":32.0,"amount_label":"32","balance_after_credits":168.0,"replayed":true,"granted_seconds":0}""",
            again.Body);
        Assert.Contains("\"replayed\":true", third.Body);
        Assert.Equal(168m, await c.BalanceAsync(r.App, c.Pam));
        Assert.Equal(2, r.Mail.Sent.Count(m => m.Subject.Contains("paid for", StringComparison.OrdinalIgnoreCase)));
    }

    /// <summary>Two concurrent confirms of one nonce pay once.</summary>
    [SkippableFact]
    public async Task Concurrent_confirms_of_one_nonce_pay_exactly_once()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        var r = await RigAsync(factory, "payrace");
        await using var _ = r.App;
        var c = r.Club;
        await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -10, checkedIn: true);
        var code = c.Code(c.Pam);

        await SendAsync(r, c.PayFor(code, 2, Nonce, confirm: false));
        var results = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => SendAsync(r, c.PayFor(code, 2, Nonce, confirm: true, label: "32"))));

        Assert.All(results, x => Assert.True(x.Status is HttpStatusCode.OK or HttpStatusCode.ServiceUnavailable, x.Body));
        Assert.Contains(results, x => x.Body.Contains("\"replayed\":false"));
        Assert.Equal(168m, await c.BalanceAsync(r.App, c.Pam));
        Assert.Equal(200m, await c.BalanceAsync(r.App, c.Olga));
    }

    [SkippableFact]
    public async Task A_booking_nobody_has_started_is_activated_for_the_payer_and_the_court_lights()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        var r = await RigAsync(factory, "paylight");
        await using var _ = r.App;
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: 2, minutes: 45);

        await SendAsync(r, c.PayFor(c.Code(c.Pam), 1, Nonce, confirm: false));
        var paid = JsonDocument.Parse((await SendAsync(r, c.PayFor(c.Code(c.Pam), 1, Nonce, confirm: true, label: "24"))).Body).RootElement;

        Assert.True(paid.GetProperty("paid").GetBoolean());
        Assert.InRange(paid.GetProperty("granted_seconds").GetInt32(), 45 * 60, 47 * 60 + 1);
        var stored = await c.ReadAsync(r.App, db => db.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == booking.Id));
        Assert.NotNull(stored.CheckedInAt);
        Assert.Equal(c.Pam, stored.PaidByUserId);
        Assert.Equal(176m, await c.BalanceAsync(r.App, c.Pam));
    }

    [SkippableFact]
    public async Task The_decision_table()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        var r = await RigAsync(factory, "paytable");
        await using var _ = r.App;
        var c = r.Club;
        await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -10, checkedIn: true);                 // court 2: 32 credits
        await c.BookAsync(r.App, c.Olga, courtIndex: 2, startsInMinutes: -70, minutes: 60);                     // court 3: ended 10 min ago… outside grace
        var ended = await c.BookAsync(r.App, c.Sid, courtIndex: 3, startsInMinutes: -62, minutes: 60);          // court 4: ended 2 min ago
        await c.WriteAsync(r.App, async db => (await db.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == ended.Id)).Status = BookingStatus.Completed);

        async Task<string> Quote(string token, int court, string nonce = Nonce) =>
            JsonDocument.Parse((await SendAsync(r, c.PayFor(token, court, nonce, confirm: false))).Body).RootElement.GetProperty("reason").GetString()!;

        Assert.Equal("ok", await Quote(c.Code(c.Pam), 2));
        Assert.Equal("own_booking", await Quote(c.Code(c.Olga), 2));
        Assert.Equal("not_booked", await Quote(c.Code(c.Pam), 1));
        Assert.Equal("not_booked", await Quote(c.Code(c.Pam), 3));
        Assert.Equal("ended", await Quote(c.Code(c.Pam), 4));
        Assert.Equal("court_not_on_device", await Quote(c.Code(c.Pam), 9));
        Assert.Equal("not_recognised", await Quote(c.ForgedOn(c.Pam), 2));
        Assert.Equal("not_recognised", await Quote("7Q3F9KM2XZ8B", 2));

        // A price that moved between the presses: nothing charged, the current label returned.
        var changed = await SendAsync(r, c.PayFor(c.Code(c.Pam), 2, Nonce, confirm: true, label: "30"));
        Assert.Equal("""{"paid":false,"reason":"price_changed","court_number":2,"amount_label":"32"}""", changed.Body);
        Assert.Equal(200m, await c.BalanceAsync(r.App, c.Pam));

        // Insufficient: Pam spends down to 20 first.
        await c.WriteAsync(r.App, db =>
        {
            db.LedgerEntries.Add(new LedgerEntry { TenantId = c.TenantId, UserId = c.Pam, Type = LedgerEntryType.BookingCharge, AmountCredits = -180m, ActorUserId = c.Pam, Reason = "spent" });
            return Task.CompletedTask;
        });
        Assert.Equal("insufficient_balance", await Quote(c.Code(c.Pam), 2));
        var poor = await SendAsync(r, c.PayFor(c.Code(c.Pam), 2, "0000000000000001", confirm: true, label: "32"));
        Assert.Equal("""{"paid":false,"reason":"insufficient_balance","court_number":2}""", poor.Body);
        Assert.Equal(20m, await c.BalanceAsync(r.App, c.Pam));

        // Suspended payer.
        await c.WriteAsync(r.App, async db => (await db.Memberships.IgnoreQueryFilters().FirstAsync(m => m.Id == c.SidMembership)).Status = MembershipStatus.Suspended);
        Assert.Equal("not_recognised", await Quote(c.Code(c.Sid), 2));   // a barred member's code is not a member's code (§4.3)

        Assert.Equal(0, await c.UsesAsync(r.App));
    }

    [SkippableFact]
    public async Task After_one_member_pays_a_second_is_told_it_is_already_paid_and_the_used_code_is_code_used()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        var r = await RigAsync(factory, "paytwice");
        await using var _ = r.App;
        var c = r.Club;
        await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -10, checkedIn: true);
        await c.BookAsync(r.App, c.Olga, courtIndex: 2, startsInMinutes: -10, checkedIn: true);
        var code = c.Code(c.Pam);

        await SendAsync(r, c.PayFor(code, 2, Nonce, confirm: false));
        Assert.Contains("\"paid\":true", (await SendAsync(r, c.PayFor(code, 2, Nonce, confirm: true, label: "32"))).Body);

        var again = JsonDocument.Parse((await SendAsync(r, c.PayFor(c.Code(c.Sid), 2, "1111111111111111", confirm: false))).Body).RootElement;
        Assert.Equal("already_paid", again.GetProperty("reason").GetString());

        var sameCode = JsonDocument.Parse((await SendAsync(r, c.PayFor(code, 3, "2222222222222222", confirm: false))).Body).RootElement;
        Assert.Equal("code_used", sameCode.GetProperty("reason").GetString());
    }

    // The split refusal is proven against real P11 seats — PlayersMemberCodeSeamHttpTests.

    /// <summary>Two clubs' boxes may mint the same nonce; each pays its own court (cross-tenant for device_pay_fors).</summary>
    [SkippableFact]
    public async Task The_same_nonce_at_two_clubs_is_two_payments()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        var mail = new StubEmailService();
        await using var app = MemberCodeClub.Wired(factory, mail);
        var a = await MemberCodeClub.SeedAsync(app, "noncea");
        var b = await MemberCodeClub.SeedAsync(app, "nonceb");
        await a.BookAsync(app, a.Olga, 1, -10, checkedIn: true);
        await b.BookAsync(app, b.Olga, 1, -10, checkedIn: true);
        var device = app.CreateClient();

        await device.SendAsync(a.PayFor(a.Code(a.Pam), 2, Nonce, false));
        await device.SendAsync(b.PayFor(b.Code(b.Pam), 2, Nonce, false));
        var pa = await (await device.SendAsync(a.PayFor(a.Code(a.Pam), 2, Nonce, true, "32"))).Content.ReadAsStringAsync();
        var pb = await (await device.SendAsync(b.PayFor(b.Code(b.Pam), 2, Nonce, true, "32"))).Content.ReadAsStringAsync();

        Assert.Contains("\"replayed\":false", pa);
        Assert.Contains("\"replayed\":false", pb);
        Assert.Equal(168m, await a.BalanceAsync(app, a.Pam));
        Assert.Equal(168m, await b.BalanceAsync(app, b.Pam));

        // And one club's box cannot confirm with the other's key: the MAC is not a board of that club.
        var cross = await device.SendAsync(a.PayFor(a.Code(a.Pam), 2, "3333333333333333", true, "32", mac: b.BoxMac));
        Assert.NotEqual(HttpStatusCode.OK, cross.StatusCode);
    }
}

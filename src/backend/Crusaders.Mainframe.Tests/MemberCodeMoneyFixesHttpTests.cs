using System.Net;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Webhooks;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The money paths the P7 reviews broke (<c>docs/specs/member-code.md</c> §4.4, §9, §13): racing
/// payers and a stranded nonce, a claim burned by a throw, an uncharged booking, the cue window,
/// a confirm paying for a booking the glass never asked about, and identical walk-up retries in
/// flight together.
/// </summary>
public sealed class MemberCodeMoneyFixesHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private static async Task<(HttpStatusCode Status, JsonElement Body)> SendAsync(HttpClient device, HttpRequestMessage req)
    {
        var response = await device.SendAsync(req);
        var text = await response.Content.ReadAsStringAsync();
        return (response.StatusCode, text.Length > 0 ? JsonDocument.Parse(text).RootElement.Clone() : default);
    }

    /// <summary>A request the server failed: a 5xx, or — the in-process test server rethrows — the exception itself.</summary>
    private static async Task<bool> FailedAsync(Func<Task<HttpResponseMessage>> send)
    {
        try
        {
            return (int)(await send()).StatusCode >= 500;
        }
        catch (InvalidOperationException ex) when (ex.Message == "injected failure")
        {
            return true;
        }
    }

    private static Task TopUpAsync(MemberCodeClub club, WebApplicationFactory<Program> app, Guid user, decimal credits) =>
        club.WriteAsync(app, db =>
        {
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = club.TenantId, UserId = user, Type = LedgerEntryType.TopUp, AmountCredits = credits, ActorUserId = user, Reason = "seed",
            });
            return Task.CompletedTask;
        });

    // ---- #6: racing payers ---------------------------------------------------------------------

    /// <summary>
    /// Three members confirm for one booking at once, on three courts at once. Exactly one pays
    /// each; every other answer is a 200 <c>already_paid</c> — never a 500 — and a retry of a
    /// losing nonce is answered, never 503 for ever.
    /// </summary>
    [SkippableFact]
    public async Task Racing_payers_one_pays_and_every_other_is_told_already_paid_and_can_retry()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        // Codes at steps −1, 0 and +1 of a pinned step: a boundary crossed mid-test turned the −1
        // codes into not_recognised ~1 run in 8 (memory/gotchas-clock.md).
        var clock = new PinnedClock();
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService(), clock);
        var club = await MemberCodeClub.SeedAsync(app, "payrace2");
        await TopUpAsync(club, app, club.AdminId, 200m);
        var device = app.CreateClient();
        var payers = new[] { club.Pam, club.Sid, club.AdminId };
        var courts = new[] { 2, 3, 4 };
        foreach (var court in courts) await club.BookAsync(app, club.Olga, courtIndex: court - 1, startsInMinutes: -10, checkedIn: true);

        // Each payer's code at a different step per court: one code pays once (§4.4).
        var attempts = (from c in courts.Select((court, i) => (court, offset: i - 1))
                        from p in payers.Select((payer, j) => (payer, j))
                        select (c.court, p.payer, token: club.Code(p.payer, at: clock.Now, stepOffset: c.offset), nonce: $"{c.court:x2}{p.j:x2}000000000000")).ToList();
        foreach (var a in attempts) Assert.Equal("ok", (await SendAsync(device, club.PayFor(a.token, a.court, a.nonce, confirm: false))).Body.GetProperty("reason").GetString());

        var answers = await Task.WhenAll(attempts.Select(async a => (a, answer: await SendAsync(device, club.PayFor(a.token, a.court, a.nonce, confirm: true, label: "32")))));

        Assert.All(answers, x => Assert.Equal(HttpStatusCode.OK, x.answer.Status));
        foreach (var court in courts)
        {
            var here = answers.Where(x => x.a.court == court).ToList();
            Assert.Single(here, x => x.answer.Body.GetProperty("paid").GetBoolean());
            Assert.All(here.Where(x => !x.answer.Body.GetProperty("paid").GetBoolean()),
                x => Assert.Equal("already_paid", x.answer.Body.GetProperty("reason").GetString()));
        }

        // A losing nonce retried: decided, not stranded.
        foreach (var (a, answer) in answers.Where(x => !x.answer.Body.GetProperty("paid").GetBoolean()))
        {
            var retry = await SendAsync(device, club.PayFor(a.token, a.court, a.nonce, confirm: true, label: "32"));
            Assert.Equal(HttpStatusCode.OK, retry.Status);
        }

        // The money: three bookings' worth, moved once each.
        var total = 0m;
        foreach (var p in payers) total += await club.BalanceAsync(app, p);
        Assert.Equal(200m * 3 - 96m, total);
        Assert.Equal(200m, await club.BalanceAsync(app, club.Olga));
    }

    /// <summary>
    /// A nonce row a crash left unpaid (the paid state commits with the money, so unpaid means the
    /// money never moved) is cleared by the next retry once it is stale — and is "in progress"
    /// while it is fresh.
    /// </summary>
    [SkippableFact]
    public async Task A_nonce_a_crash_left_unpaid_is_decided_afresh_once_stale()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "paystale");
        var booking = await club.BookAsync(app, club.Olga, courtIndex: 1, startsInMinutes: -10, checkedIn: true);
        var device = app.CreateClient();
        var boxId = await club.ReadAsync(app, db => db.Devices.IgnoreQueryFilters().Where(d => d.MacAddress == club.BoxMac).Select(d => d.Id).FirstAsync());

        async Task Strand(string nonce, TimeSpan age) => await club.WriteAsync(app, db =>
        {
            db.DevicePayFors.Add(new DevicePayFor
            {
                TenantId = club.TenantId, DeviceId = boxId, Nonce = nonce, BookingId = booking.Id, PayerUserId = club.Pam,
                CourtNumber = 2, AmountCredits = 32m, AmountLabel = "32", CreatedAt = DateTimeOffset.UtcNow - age,
            });
            return Task.CompletedTask;
        });

        await Strand("aaaa000000000000", TimeSpan.FromSeconds(1));
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await SendAsync(device, club.PayFor(club.Code(club.Pam), 2, "aaaa000000000000", confirm: true, label: "32"))).Status);

        await Strand("bbbb000000000000", TimeSpan.FromMinutes(2));
        await SendAsync(device, club.PayFor(club.Code(club.Pam), 2, "bbbb000000000000", confirm: false));
        var paid = await SendAsync(device, club.PayFor(club.Code(club.Pam), 2, "bbbb000000000000", confirm: true, label: "32"));
        Assert.Equal(HttpStatusCode.OK, paid.Status);
        Assert.True(paid.Body.GetProperty("paid").GetBoolean());
        Assert.False(paid.Body.GetProperty("replayed").GetBoolean());
        Assert.Equal(168m, await club.BalanceAsync(app, club.Pam));
    }

    // ---- #9: a claim is not burned by a throw -----------------------------------------------------

    private sealed class ThrowOnce(
        MainframeDbContext db, BookingService bookings, TenantSettingsAccessor settings, ITenantContext tenant,
        IEventBus bus, ActivationPlumbing plumbing) : CourtActivationService(db, bookings, settings, tenant, bus, plumbing)
    {
        public static int Remaining;

        public override Task<ActivationResult> ActivateAsync(ActivationRequest request, CancellationToken ct) =>
            Interlocked.Decrement(ref Remaining) >= 0
                ? throw new InvalidOperationException("injected failure")
                : base.ActivateAsync(request, ct);
    }

    private static WebApplicationFactory<Program> Throwing(WebApplicationFactory<Program> app) =>
        app.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<CourtActivationService>();
            s.AddScoped<CourtActivationService, ThrowOnce>();
        }));

    [SkippableFact]
    public async Task An_activation_that_throws_gives_its_use_back_so_the_retry_is_not_code_used()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = Throwing(MemberCodeClub.Wired(factory, new StubEmailService()));
        var club = await MemberCodeClub.SeedAsync(app, "throwact");
        await club.BookAsync(app, club.Olga, courtIndex: 1, startsInMinutes: -5);
        var device = app.CreateClient();
        var code = club.Code(club.Olga);

        ThrowOnce.Remaining = 1;
        Assert.True(await FailedAsync(() => device.SendAsync(club.Activate(code))));
        Assert.Equal(0, await club.UsesAsync(app));

        var retry = await MemberCodeClub.JsonAsync(await device.SendAsync(club.Activate(code)));
        Assert.True(retry.GetProperty("activated").GetBoolean());
    }

    [SkippableFact]
    public async Task A_pay_for_that_throws_gives_back_its_nonce_and_its_use_and_the_retry_pays()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = Throwing(MemberCodeClub.Wired(factory, new StubEmailService()));
        var club = await MemberCodeClub.SeedAsync(app, "throwpay");
        await club.BookAsync(app, club.Olga, courtIndex: 0, startsInMinutes: 2, minutes: 45);   // unstarted, cue open: activates
        var device = app.CreateClient();
        var code = club.Code(club.Pam);
        const string nonce = "cafe000000000000";

        await SendAsync(device, club.PayFor(code, 1, nonce, confirm: false));
        ThrowOnce.Remaining = 1;
        Assert.True(await FailedAsync(() => device.SendAsync(club.PayFor(code, 1, nonce, confirm: true, label: "24"))));
        Assert.Equal(0, await club.UsesAsync(app));
        Assert.Equal(0, await club.ReadAsync(app, db => db.DevicePayFors.IgnoreQueryFilters().CountAsync(p => p.TenantId == club.TenantId)));
        Assert.Equal(200m, await club.BalanceAsync(app, club.Pam));

        var retry = await SendAsync(device, club.PayFor(code, 1, nonce, confirm: true, label: "24"));
        Assert.True(retry.Body.GetProperty("paid").GetBoolean());
        Assert.Equal(176m, await club.BalanceAsync(app, club.Pam));
    }

    // ---- #10: nobody to refund ------------------------------------------------------------------

    [SkippableFact]
    public async Task A_booking_never_charged_is_not_paid_for_at_the_box_whose_glass_would_say_booker_refunded()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var mail = new StubEmailService();
        var clock = new PinnedClock();
        await using var app = MemberCodeClub.Wired(factory, mail, clock);
        var club = await MemberCodeClub.SeedAsync(app, "uncharged");
        var legacy = await club.BookAsync(app, club.Olga, courtIndex: 1, startsInMinutes: -10, checkedIn: true);
        var free = await club.BookAsync(app, club.Olga, courtIndex: 2, startsInMinutes: -10, checkedIn: true);
        await club.WriteAsync(app, async db =>
        {
            (await db.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == legacy.Id)).ChargedAt = null;
            (await db.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == free.Id)).AmountChargedCredits = 0m;
        });
        var device = app.CreateClient();

        var quote = await SendAsync(device, club.PayFor(club.Code(club.Pam, at: clock.Now), 2, "0101010101010101", confirm: false));
        Assert.Equal("not_chargeable", quote.Body.GetProperty("reason").GetString());
        var confirm = await SendAsync(device, club.PayFor(club.Code(club.Pam, at: clock.Now, stepOffset: -1), 2, "0202020202020202", confirm: true, label: "32"));
        Assert.Equal("not_chargeable", confirm.Body.GetProperty("reason").GetString());
        Assert.Equal("already_paid", (await SendAsync(device, club.PayFor(club.Code(club.Pam, at: clock.Now), 3, "0303030303030303", confirm: false))).Body.GetProperty("reason").GetString());

        Assert.Equal(200m, await club.BalanceAsync(app, club.Pam));
        Assert.DoesNotContain(mail.Sent, m => m.Subject.Contains("paid for", StringComparison.OrdinalIgnoreCase));
    }

    // ---- #11: one cue window ----------------------------------------------------------------------

    /// <summary>
    /// A hand-edited cue window outside the PUT's bounds reads CLAMPED everywhere: the booking the
    /// quote found (started, nobody on it) is activated for the payer and lit, not reassigned dark
    /// or refused by an activation gate reading the raw value.
    /// </summary>
    [SkippableFact]
    public async Task An_out_of_range_cue_window_is_read_clamped_by_the_pay_for_and_the_activation_alike()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "cueclamp");
        await club.SetAsync(app, "activation_cue_window_minutes", -30);
        var booking = await club.BookAsync(app, club.Olga, courtIndex: 1, startsInMinutes: -10, minutes: 60);
        var device = app.CreateClient();
        var code = club.Code(club.Pam);

        await SendAsync(device, club.PayFor(code, 2, "c0e0000000000000", confirm: false));
        var paid = await SendAsync(device, club.PayFor(code, 2, "c0e0000000000000", confirm: true, label: "32"));

        Assert.True(paid.Body.GetProperty("paid").GetBoolean(), paid.Body.ToString());
        Assert.InRange(paid.Body.GetProperty("granted_seconds").GetInt32(), 49 * 60, 50 * 60 + 1);
        Assert.NotNull((await club.ReadAsync(app, db => db.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == booking.Id))).CheckedInAt);
    }

    // ---- #12: the booking the glass asked about ----------------------------------------------------

    /// <summary>
    /// Quoted at 17:59 for the 17:00 booking, confirmed at 18:00 when the court's live booking is
    /// Sid's 18:00 one at the same price: refused <c>price_changed</c>, and nobody's money moves.
    /// A confirm with no quote behind it is refused the same way.
    /// </summary>
    [SkippableFact]
    public async Task A_confirm_pays_only_for_the_booking_its_quote_named()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "quotepin");
        var five = await club.BookAsync(app, club.Olga, courtIndex: 1, startsInMinutes: -59, minutes: 60, checkedIn: true);
        await club.BookAsync(app, club.Sid, courtIndex: 1, startsInMinutes: 1, minutes: 60, checkedIn: true);
        var device = app.CreateClient();
        const string nonce = "1234123412341234";

        var quote = await SendAsync(device, club.PayFor(club.Code(club.Pam), 2, nonce, confirm: false));
        Assert.Equal("32", quote.Body.GetProperty("amount_label").GetString());

        // The 17:00 slot ends between the two presses.
        await club.WriteAsync(app, async db => (await db.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == five.Id)).EndsAt = DateTimeOffset.UtcNow.AddSeconds(-1));

        var confirm = await SendAsync(device, club.PayFor(club.Code(club.Pam), 2, nonce, confirm: true, label: "32"));
        Assert.False(confirm.Body.GetProperty("paid").GetBoolean());
        Assert.Equal("price_changed", confirm.Body.GetProperty("reason").GetString());

        var unquoted = await SendAsync(device, club.PayFor(club.Code(club.Pam), 2, "9999999999999999", confirm: true, label: "32"));
        Assert.Equal("price_changed", unquoted.Body.GetProperty("reason").GetString());

        Assert.Equal(200m, await club.BalanceAsync(app, club.Pam));
        Assert.Equal(0, await club.UsesAsync(app));

        // Asked again, the glass names the 18:00 booking and the payer may agree to that.
        await SendAsync(device, club.PayFor(club.Code(club.Pam), 2, nonce, confirm: false));
        Assert.True((await SendAsync(device, club.PayFor(club.Code(club.Pam), 2, nonce, confirm: true, label: "32"))).Body.GetProperty("paid").GetBoolean());
    }

    // ---- #14: identical walk-up retries in flight together ---------------------------------------

    [SkippableFact]
    public async Task Identical_walk_up_retries_in_flight_together_are_one_purchase_and_none_is_code_used()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "walktwins", MemberCodeClub.SettingsAtNoon());
        var device = app.CreateClient();
        var code = club.Code(club.Pam);

        var answers = await Task.WhenAll(Enumerable.Range(0, 6).Select(_ => device.SendAsync(club.WalkUp(code, court: 3, nonce: "eeeeeeeeeeeeeeee"))));

        foreach (var a in answers) Assert.Equal(HttpStatusCode.OK, a.StatusCode);
        Assert.Equal(200m - 8m, await club.BalanceAsync(app, club.Pam));
        Assert.Equal(1, await club.UsesAsync(app, MemberCodeUseClass.Money));
    }

    // ---- Refute round 1, #8: a committed purchase keeps its use -------------------------------

    private sealed class RefuseOnce(
        MainframeDbContext db, BookingService bookings, TenantSettingsAccessor settings, ITenantContext tenant,
        IEventBus bus, ActivationPlumbing plumbing) : CourtActivationService(db, bookings, settings, tenant, bus, plumbing)
    {
        public static int Remaining;

        public override Task<ActivationResult> ActivateAsync(ActivationRequest request, CancellationToken ct) =>
            Interlocked.Decrement(ref Remaining) >= 0
                ? Task.FromResult<ActivationResult>(new ActivationResult.NotChargeable())
                : base.ActivateAsync(request, ct);
    }

    /// <summary>
    /// The purchase committed — the money moved, and moved back when the activation was refused —
    /// under this code: the use table records acts, so the use is kept and the same code cannot
    /// buy again inside its step.
    /// </summary>
    [SkippableFact]
    public async Task A_walk_up_voided_after_its_purchase_committed_keeps_its_use()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService()).WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<CourtActivationService>();
            s.AddScoped<CourtActivationService, RefuseOnce>();
        }));
        var club = await MemberCodeClub.SeedAsync(app, "walkvoid", MemberCodeClub.SettingsAtNoon());
        var code = club.Code(club.Pam);

        RefuseOnce.Remaining = 1;
        var refused = await app.CreateClient().SendAsync(club.WalkUp(code, court: 3, nonce: "f0f0f0f0f0f0f0f0"));
        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        Assert.Equal(200m, await club.BalanceAsync(app, club.Pam));
        Assert.Equal(1, await club.UsesAsync(app, MemberCodeUseClass.Money));

        var again = await app.CreateClient().SendAsync(club.WalkUp(code, court: 4, nonce: "0f0f0f0f0f0f0f0f"));
        Assert.Equal("""{"error":"code_used"}""", await again.Content.ReadAsStringAsync());
    }
}

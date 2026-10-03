using System.Net.Http.Json;
using System.Text.Json;
using System.Threading.Channels;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 6, chain E6 — paying for somebody else's court at the box (D10), followed all the
/// way to what an admin and the booker read afterwards: the booker's booking page (E6-2), the
/// attendance line (E6-7), both members' nights (E6-1, E6-3, E6-8), the webhook mirror of the
/// payer's side (E6-4) and the quote's balance check (E6-5).
/// </summary>
public sealed class R6MoneyChainHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Nonce = "6e6e6e6e6e6e6e6e";

    /// <summary>Keeps every event the server emits, and still hands them on to the dispatcher.</summary>
    private sealed class RecordingBus : IEventBus
    {
        private readonly Channel<DomainEvent> _channel = Channel.CreateUnbounded<DomainEvent>();
        private readonly List<DomainEvent> _emitted = [];

        public ChannelReader<DomainEvent> Reader => _channel.Reader;

        public List<DomainEvent> Emitted
        {
            get { lock (_emitted) return [.. _emitted]; }
        }

        public async ValueTask EmitAsync(DomainEvent evt, CancellationToken ct = default)
        {
            lock (_emitted) _emitted.Add(evt);
            await _channel.Writer.WriteAsync(evt, ct);
        }
    }

    private sealed record Rig(MemberCodeClub Club, WebApplicationFactory<Program> App, RecordingBus Bus, HttpClient Device);

    private static async Task<Rig> RigAsync(TestWebAppFactory factory, string prefix)
    {
        var bus = new RecordingBus();
        var app = MemberCodeClub.Wired(factory, new StubEmailService()).WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IEventBus>();
            s.AddSingleton<IEventBus>(bus);
        }));
        var club = await MemberCodeClub.SeedAsync(app, prefix);
        return new Rig(club, app, bus, app.CreateClient());
    }

    /// <summary>Quote then confirm, Pam paying for Olga's court 2. Returns the confirm's body.</summary>
    private static async Task<JsonElement> PayAsync(Rig r, int court, string label)
    {
        var c = r.Club;
        (await r.Device.SendAsync(c.PayFor(c.Code(c.Pam), court, Nonce, confirm: false))).EnsureSuccessStatusCode();
        var paid = await r.Device.SendAsync(c.PayFor(c.Code(c.Pam), court, Nonce, confirm: true, label: label));
        return await MemberCodeClub.JsonAsync(paid);
    }

    private static async Task<List<JsonElement>> NightAsync(Rig r, Guid user)
    {
        var admin = r.Club.Member(r.App, r.Club.AdminId, "admin");
        var body = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{user}/trace");
        return body.GetProperty("events").EnumerateArray().ToList();
    }

    /// <summary>
    /// E6-2: after somebody paid for Olga's court at the box, her booking page said "You paid at
    /// booking 60 · Your cost 60" — the money block read the PAYER's rows and labelled them hers.
    /// It now says what Olga is out (nothing) and who paid instead.
    /// </summary>
    [SkippableFact]
    public async Task The_bookers_page_says_somebody_else_paid_and_what_the_booker_is_out()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "r6paidby");
        await using var _ = r.App;
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -10, checkedIn: true);

        Assert.True((await PayAsync(r, 2, "60")).GetProperty("paid").GetBoolean());

        var detail = await c.Member(r.App, c.Olga).GetFromJsonAsync<JsonElement>($"/api/v1/bookings/{booking.Id}");
        var money = detail.GetProperty("money");
        Assert.Equal(60, money.GetProperty("price_minutes").GetInt32());
        Assert.Equal(0, money.GetProperty("organiser_owed_minutes").GetInt32());
        Assert.Equal(0, money.GetProperty("organiser_net_minutes").GetInt32());
        Assert.Equal(c.Pam, money.GetProperty("paid_by").GetProperty("user_id").GetGuid());
        Assert.Equal("Pam Payer", money.GetProperty("paid_by").GetProperty("name").GetString());
        Assert.Equal(60, money.GetProperty("paid_by_minutes").GetInt32());
    }

    /// <summary>A booking nobody else paid for names no other payer — the field is null, not the organiser.</summary>
    [SkippableFact]
    public async Task A_booking_the_organiser_paid_for_names_nobody_else()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "r6ownpay");
        await using var _ = r.App;
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: 30);

        var money = (await c.Member(r.App, c.Olga).GetFromJsonAsync<JsonElement>($"/api/v1/bookings/{booking.Id}")).GetProperty("money");
        Assert.Equal(60, money.GetProperty("organiser_owed_minutes").GetInt32());
        Assert.Equal(JsonValueKind.Null, money.GetProperty("paid_by").ValueKind);
        Assert.Equal(0, money.GetProperty("paid_by_minutes").GetInt32());
    }

    /// <summary>E6-7: a solo booking checked in read "0 of 1 player checked in" — nobody had a seat to stamp.</summary>
    [SkippableFact]
    public async Task A_solo_booking_checked_in_counts_its_one_player()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "r6solo");
        await using var _ = r.App;
        var c = r.Club;
        var lit = await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -10, checkedIn: true);
        var later = await c.BookAsync(r.App, c.Olga, courtIndex: 2, startsInMinutes: 60);

        var olga = c.Member(r.App, c.Olga);
        var litAttendance = (await olga.GetFromJsonAsync<JsonElement>($"/api/v1/bookings/{lit.Id}")).GetProperty("attendance");
        var laterAttendance = (await olga.GetFromJsonAsync<JsonElement>($"/api/v1/bookings/{later.Id}")).GetProperty("attendance");
        Assert.Equal(1, litAttendance.GetProperty("players_checked_in").GetInt32());
        Assert.Equal(0, laterAttendance.GetProperty("players_checked_in").GetInt32());
    }

    /// <summary>
    /// E6-1: Olga's refund was on Pam's night (Pam was its actor) reading "Got 60 minutes back" —
    /// Pam's night claimed Olga's money as Pam's. A row about somebody else's money names them.
    /// E6-3: the pay-for's own audit row read "Something this club's records have no word for".
    /// </summary>
    [SkippableFact]
    public async Task Both_nights_tell_the_pay_for_in_words_and_never_claim_the_other_members_money()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "r6night");
        await using var _ = r.App;
        var c = r.Club;
        await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -10, checkedIn: true);
        Assert.True((await PayAsync(r, 2, "60")).GetProperty("paid").GetBoolean());

        var pam = await NightAsync(r, c.Pam);
        Assert.DoesNotContain(pam, e => e.GetProperty("kind").GetString() == TraceKinds.Unrecognised);

        var othersRefund = Assert.Single(pam, e => e.GetProperty("kind").GetString() == TraceKinds.WalletRefunded);
        Assert.Contains("Olga Organiser", othersRefund.GetProperty("headline").GetString());
        Assert.Equal(JsonValueKind.Null, othersRefund.GetProperty("balance_after_minutes").ValueKind);

        var ownSpend = Assert.Single(pam, e => e.GetProperty("kind").GetString() == TraceKinds.WalletSpent);
        Assert.DoesNotContain("Olga", ownSpend.GetProperty("headline").GetString());

        var paidFor = Assert.Single(pam, e => e.GetProperty("kind").GetString() == TraceKinds.BookingPaidForSomebody);
        Assert.Contains("Olga Organiser", paidFor.GetProperty("headline").GetString());
        Assert.Contains("Court 2", paidFor.GetProperty("headline").GetString());

        var olga = await NightAsync(r, c.Olga);
        Assert.DoesNotContain(olga, e => e.GetProperty("kind").GetString() == TraceKinds.Unrecognised);
        var paidForThem = Assert.Single(olga, e => e.GetProperty("kind").GetString() == TraceKinds.BookingPaidForThem);
        Assert.Contains("Pam Payer", paidForThem.GetProperty("headline").GetString());
        var ownRefund = Assert.Single(olga, e => e.GetProperty("kind").GetString() == TraceKinds.WalletRefunded);
        Assert.DoesNotContain("Olga", ownRefund.GetProperty("headline").GetString());
    }

    /// <summary>
    /// E6-4: the booker's refund reached the webhooks (<c>minutes.refunded</c>) and the payer's
    /// debit reached none — a payer-scoped endpoint never heard that its member paid for a court.
    /// </summary>
    [SkippableFact]
    public async Task The_payers_side_reaches_the_event_stream()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "r6hook");
        await using var _ = r.App;
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -10, checkedIn: true);
        Assert.True((await PayAsync(r, 2, "60")).GetProperty("paid").GetBoolean());

        DomainEvent? changed = null;
        for (var i = 0; i < 50 && changed is null; i++)
        {
            changed = r.Bus.Emitted.FirstOrDefault(e => e.Type == BookingEvents.PayerChanged && Equals(e.Data["booking_id"], booking.Id));
            if (changed is null) await Task.Delay(100);
        }
        Assert.NotNull(changed);
        Assert.Equal(c.Pam, changed!.SubjectUserId);
        Assert.Equal(c.Pam, changed.ActorUserId);
        Assert.Equal(c.Pam, changed.Data["user_id"]);
        Assert.Equal(c.Olga, changed.Data["previous_payer_user_id"]);
        Assert.Equal(60, changed.Data["amount_minutes"]);
    }

    /// <summary>
    /// E6-5: the quote asked the BALANCE and the confirm asked what is SPENDABLE, so a payer whose
    /// minutes were held was shown PAY 60 MIN? and then refused. The quote now asks what the
    /// confirm asks.
    /// </summary>
    [SkippableFact]
    public async Task The_quote_refuses_minutes_that_are_held_as_the_confirm_would()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "r6held");
        await using var _ = r.App;
        var c = r.Club;
        await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -10, checkedIn: true);   // 60 on court 2

        // Pam: 200 − 60 (her own later booking) − 90 spent = 50, then 50 received as a share on
        // that booking, held for her partner's possible return: balance 100, spendable 50.
        var own = await c.BookAsync(r.App, c.Pam, courtIndex: 3, startsInMinutes: 120, minutes: 60);
        await c.WriteAsync(r.App, db =>
        {
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = c.TenantId, UserId = c.Pam, Type = LedgerEntryType.BookingCharge, AmountMinutes = -90,
                ActorUserId = c.Pam, Reason = "spent elsewhere",
            });
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = c.TenantId, UserId = c.Pam, Type = LedgerEntryType.ShareTransfer, AmountMinutes = 50,
                ActorUserId = c.Sid, RelatedBookingId = own.Id, Reason = "share", ExternalReference = $"share:{Guid.NewGuid():N}:1:in",
            });
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = c.TenantId, UserId = c.Sid, Type = LedgerEntryType.ShareTransfer, AmountMinutes = -50,
                ActorUserId = c.Sid, RelatedBookingId = own.Id, Reason = "share", ExternalReference = $"share:{Guid.NewGuid():N}:1:out",
            });
            return Task.CompletedTask;
        });

        var wallet = await c.Member(r.App, c.Pam).GetFromJsonAsync<JsonElement>("/api/v1/wallet");
        var spendable = wallet.GetProperty("spendable_minutes").GetInt32();
        Assert.Equal(100, await c.BalanceAsync(r.App, c.Pam));
        Assert.True(spendable < 60, $"the rig must leave Pam short of spendable minutes (spendable {spendable})");

        var quote = await MemberCodeClub.JsonAsync(await r.Device.SendAsync(c.PayFor(c.Code(c.Pam), 2, Nonce, confirm: false)));
        Assert.Equal("insufficient_balance", quote.GetProperty("reason").GetString());
    }

    /// <summary>
    /// E6-8: a box scan that lit a court was written to the night as the club's own automatic
    /// check, with no board code — the lights-on row named no device. It names the box.
    /// </summary>
    [SkippableFact]
    public async Task A_box_that_lit_the_court_is_named_on_the_night()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "r6lights");
        await using var _ = r.App;
        var c = r.Club;
        await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: 2, minutes: 45);

        Assert.True((await PayAsync(r, 1, "45")).GetProperty("paid").GetBoolean());

        var lightsOn = Assert.Single(await NightAsync(r, c.Olga), e => e.GetProperty("kind").GetString() == TraceKinds.LightsOn);
        Assert.Equal(TraceActors.Device, lightsOn.GetProperty("actor").GetProperty("kind").GetString());
        Assert.Equal($"box-{c.BoxMac[^6..]}", lightsOn.GetProperty("device_code").GetString());
    }
}

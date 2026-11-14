using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Extending play on a lit court at the box — <c>POST /api/v1/device/extend</c> — over HTTP against
/// Postgres: the money (one <c>LightsPurchase</c> debit of exactly the minutes granted, under the
/// box's nonce), the new booking (the scanner's, starting at the end of what is in play, checked in),
/// chained extensions, truncation at the next booking, every refusal the box can be told, the nonce's
/// idempotent replay, the confirmation mail, and that one club's box cannot reach another club's
/// court or bill another club's member.
///
/// <para>
/// The club is <see cref="MemberCodeClub"/> seeded at its own noon, so no extension here ever meets
/// closing time — the truncation under test is the next booking's, asserted exactly.
/// </para>
/// </summary>
public sealed class DeviceExtendHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string ExtendPath = "/api/v1/device/extend";

    private sealed record Rig(MemberCodeClub Club, WebApplicationFactory<Program> App, StubEmailService Mail, HttpClient Device);

    private async Task<Rig> RigAsync(TestWebAppFactory factory, string prefix)
    {
        var mail = new StubEmailService();
        var app = MemberCodeClub.Wired(factory, mail);
        var club = await MemberCodeClub.SeedAsync(app, prefix, MemberCodeClub.SettingsAtNoon());
        return new Rig(club, app, mail, app.CreateClient());
    }

    private static HttpRequestMessage Extend(
        MemberCodeClub c, string? token, int court, int minutes, string? nonce, string? mac = null, string method = "qr")
    {
        var body = new JsonObject
        {
            ["mac"] = mac ?? c.BoxMac,
            ["method"] = method,
            ["token"] = token,
            ["court"] = court,
            ["minutes"] = minutes,
        };
        if (nonce is not null) body["nonce"] = nonce;
        return c.Device(ExtendPath, body);
    }

    private static async Task<(HttpStatusCode Status, JsonElement Body)> SendAsync(HttpClient device, HttpRequestMessage req)
    {
        var response = await device.SendAsync(req);
        return (response.StatusCode, await MemberCodeClub.JsonAsync(response));
    }

    private static string Wire(DateTimeOffset t) =>
        t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);

    private static Task<Guid> BoxIdAsync(WebApplicationFactory<Program> app, MemberCodeClub c) =>
        c.ReadAsync(app, db => db.Devices.IgnoreQueryFilters().Where(d => d.MacAddress == c.BoxMac).Select(d => d.Id).SingleAsync());

    private static Task<List<Booking>> BookingsOfAsync(WebApplicationFactory<Program> app, MemberCodeClub c, Guid user) =>
        c.ReadAsync(app, db => db.Bookings.IgnoreQueryFilters().AsNoTracking()
            .Where(b => b.TenantId == c.TenantId && b.UserId == user).OrderBy(b => b.StartsAt).ToListAsync());

    /// <summary>A plain booking written straight in, at an exact instant — the next player waiting at the session's end.</summary>
    private static async Task<Booking> WaitingAsync(
        WebApplicationFactory<Program> app, MemberCodeClub c, Guid user, int courtIndex, DateTimeOffset startsAt, int minutes = 30)
    {
        var booking = new Booking
        {
            TenantId = c.TenantId,
            CourtId = c.Courts[courtIndex],
            UserId = user,
            BookedByUserId = user,
            PaidByUserId = user,
            ActorUserId = user,
            StartsAt = startsAt,
            EndsAt = startsAt.AddMinutes(minutes),
            SliceMinutes = 15,
            SliceCount = Math.Max(1, minutes / 15),
            AmountChargedMinutes = minutes,
            Status = BookingStatus.Booked,
            ChargedAt = DateTimeOffset.UtcNow,
        };
        await c.WriteAsync(app, db =>
        {
            db.Bookings.Add(booking);
            return Task.CompletedTask;
        });
        return booking;
    }

    // ---- the purchase ---------------------------------------------------------------------------

    [SkippableFact]
    public async Task An_extension_is_a_new_checked_in_booking_for_the_scanner_from_the_end_of_play_charged_exactly()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "extok");
        await using var _ = r.App;
        var c = r.Club;
        var playing = await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: -10, checkedIn: true);   // ends in 50

        var (status, body) = await SendAsync(r.Device, Extend(c, c.Code(c.Pam), court: 1, minutes: 30, nonce: "e1e1e1e1e1e1e1e1"));

        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal(30, body.GetProperty("extended_minutes").GetInt32());
        Assert.Equal("30", body.GetProperty("amount_minutes").GetRawText());   // whole minutes on the wire
        Assert.Equal(170, body.GetProperty("balance_after_minutes").GetInt32());
        Assert.Equal(Wire(playing.EndsAt.AddMinutes(30)), body.GetProperty("ends_at").GetString());
        Assert.False(body.GetProperty("replayed").GetBoolean());
        Assert.Equal("PAM", body.GetProperty("greeting_name").GetString());

        // The scanner's own booking, starting exactly where play ends, checked in at creation so the
        // no-show sweep never touches it — and the session in play is left exactly as it was sold.
        var extension = Assert.Single(await BookingsOfAsync(r.App, c, c.Pam));
        Assert.Equal(body.GetProperty("booking_id").GetGuid(), extension.Id);
        Assert.Equal(c.Courts[0], extension.CourtId);
        Assert.Equal(playing.EndsAt, extension.StartsAt);
        Assert.Equal(playing.EndsAt.AddMinutes(30), extension.EndsAt);
        Assert.Equal(BookingStatus.Booked, extension.Status);
        Assert.Equal(c.Pam, extension.PaidByUserId);
        Assert.Equal(30, extension.AmountChargedMinutes);
        Assert.NotNull(extension.ChargedAt);
        Assert.NotNull(extension.CheckedInAt);
        var original = await c.ReadAsync(r.App, db => db.Bookings.IgnoreQueryFilters().AsNoTracking().SingleAsync(b => b.Id == playing.Id));
        Assert.Equal(playing.EndsAt, original.EndsAt);

        // One debit, of the minutes granted, under the box's nonce, on the payer — and nothing else moved.
        var reference = DeviceExtendEndpoint.Reference(await BoxIdAsync(r.App, c), "e1e1e1e1e1e1e1e1");
        var debit = await c.ReadAsync(r.App, db => db.LedgerEntries.IgnoreQueryFilters().AsNoTracking()
            .SingleAsync(l => l.ExternalReference == reference));
        Assert.Equal(c.Pam, debit.UserId);
        Assert.Equal(-30, debit.AmountMinutes);
        Assert.Equal(LedgerEntryType.LightsPurchase, debit.Type);
        Assert.Equal(extension.Id, debit.RelatedBookingId);
        Assert.Equal(170, await c.BalanceAsync(r.App, c.Pam));
        Assert.Equal(140, await c.BalanceAsync(r.App, c.Olga));   // 200 − her own 60, untouched by the extension

        Assert.Equal(1, await c.UsesAsync(r.App, MemberCodeUseClass.Money));
        var audit = Assert.Single(await c.ReadAsync(r.App, db => db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == c.TenantId && a.Action == DeviceExtendEndpoint.ExtendedAction).ToListAsync()));
        Assert.Equal(c.Pam, audit.ActorUserId);
        Assert.Equal(c.Pam, audit.SubjectUserId);
        Assert.Contains(playing.Id.ToString(), audit.DetailsJson);
    }

    [SkippableFact]
    public async Task Extensions_chain_each_one_starting_where_the_last_one_ends()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "extchain");
        await using var _ = r.App;
        var c = r.Club;
        var playing = await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -10, checkedIn: true);

        var first = await SendAsync(r.Device, Extend(c, c.Code(c.Pam), court: 2, minutes: 30, nonce: "c1c1c1c1c1c1c1c1"));
        var second = await SendAsync(r.Device, Extend(c, c.Code(c.Sid), court: 2, minutes: 15, nonce: "c2c2c2c2c2c2c2c2"));
        var third = await SendAsync(r.Device, Extend(c, c.Code(c.Olga), court: 2, minutes: 20, nonce: "c3c3c3c3c3c3c3c3"));

        Assert.Equal(HttpStatusCode.OK, first.Status);
        Assert.Equal(HttpStatusCode.OK, second.Status);
        Assert.Equal(HttpStatusCode.OK, third.Status);
        Assert.Equal(Wire(playing.EndsAt.AddMinutes(30)), first.Body.GetProperty("ends_at").GetString());
        Assert.Equal(Wire(playing.EndsAt.AddMinutes(45)), second.Body.GetProperty("ends_at").GetString());
        Assert.Equal(Wire(playing.EndsAt.AddMinutes(65)), third.Body.GetProperty("ends_at").GetString());

        var sids = Assert.Single(await BookingsOfAsync(r.App, c, c.Sid));
        Assert.Equal(playing.EndsAt.AddMinutes(30), sids.StartsAt);
        Assert.Equal(playing.EndsAt.AddMinutes(45), sids.EndsAt);
        Assert.Equal(185, await c.BalanceAsync(r.App, c.Sid));
        Assert.Equal(200 - 60 - 20, await c.BalanceAsync(r.App, c.Olga));   // her booking, then her own extension
        Assert.Equal(170, await c.BalanceAsync(r.App, c.Pam));
    }

    [SkippableFact]
    public async Task An_extension_is_truncated_at_the_next_booking_and_charged_only_what_it_got()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "exttrunc");
        await using var _ = r.App;
        var c = r.Club;
        var playing = await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: -10, checkedIn: true);
        await WaitingAsync(r.App, c, c.Sid, courtIndex: 0, playing.EndsAt.AddMinutes(20));

        var (status, body) = await SendAsync(r.Device, Extend(c, c.Code(c.Pam), court: 1, minutes: 60, nonce: "7a7a7a7a7a7a7a7a"));

        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal(20, body.GetProperty("extended_minutes").GetInt32());
        Assert.Equal(20, body.GetProperty("amount_minutes").GetInt32());
        Assert.Equal(180, body.GetProperty("balance_after_minutes").GetInt32());
        Assert.Equal(Wire(playing.EndsAt.AddMinutes(20)), body.GetProperty("ends_at").GetString());
        Assert.Equal(playing.EndsAt.AddMinutes(20), Assert.Single(await BookingsOfAsync(r.App, c, c.Pam)).EndsAt);
        Assert.Equal(180, await c.BalanceAsync(r.App, c.Pam));
    }

    [SkippableFact]
    public async Task With_the_next_player_waiting_at_the_end_there_is_no_time_and_nothing_is_charged()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "extnone");
        await using var _ = r.App;
        var c = r.Club;
        var playing = await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: -10, checkedIn: true);
        // Not checked in, so it is the next player, not an extension the chain would follow.
        await WaitingAsync(r.App, c, c.Sid, courtIndex: 0, playing.EndsAt);

        var (status, body) = await SendAsync(r.Device, Extend(c, c.Code(c.Pam), court: 1, minutes: 30, nonce: "0d0d0d0d0d0d0d0d"));

        Assert.Equal(HttpStatusCode.Conflict, status);
        Assert.Equal(DeviceExtendEndpoint.NoTimeAvailable, body.GetProperty("error").GetString());
        Assert.Empty(await BookingsOfAsync(r.App, c, c.Pam));
        Assert.Equal(200, await c.BalanceAsync(r.App, c.Pam));
        // The refusal gave the code's money use back: the member may scan the same code again.
        Assert.Equal(0, await c.UsesAsync(r.App, MemberCodeUseClass.Money));
    }

    [SkippableFact]
    public async Task An_extension_the_scanner_cannot_afford_is_refused_with_both_numbers()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "extbroke");
        await using var _ = r.App;
        var c = r.Club;
        await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: -10, checkedIn: true);
        await c.WriteAsync(r.App, db =>
        {
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = c.TenantId,
                UserId = c.Pam,
                Type = LedgerEntryType.AdminAdjustment,
                AmountMinutes = -190,
                ActorUserId = c.AdminId,
                Reason = "test: spend down",
            });
            return Task.CompletedTask;
        });

        var (status, body) = await SendAsync(r.Device, Extend(c, c.Code(c.Pam), court: 1, minutes: 30, nonce: "b0b0b0b0b0b0b0b0"));

        Assert.Equal(HttpStatusCode.PaymentRequired, status);
        Assert.Equal(DeviceExtendEndpoint.InsufficientBalance, body.GetProperty("error").GetString());
        Assert.Equal(10, body.GetProperty("current_minutes").GetInt32());
        Assert.Equal(30, body.GetProperty("required_minutes").GetInt32());
        Assert.Empty(await BookingsOfAsync(r.App, c, c.Pam));
        Assert.Equal(10, await c.BalanceAsync(r.App, c.Pam));
        Assert.Equal(0, await c.UsesAsync(r.App, MemberCodeUseClass.Money));
    }

    [SkippableFact]
    public async Task A_court_with_nothing_in_play_cannot_be_extended()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "extdark");
        await using var _ = r.App;
        var c = r.Club;
        // Play on another court, and a booking on this one that has not started: neither is in play here.
        await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: -10, checkedIn: true);
        await c.BookAsync(r.App, c.Sid, courtIndex: 2, startsInMinutes: 30);

        var (status, body) = await SendAsync(r.Device, Extend(c, c.Code(c.Pam), court: 3, minutes: 30, nonce: "da4da4da4da4da4d"));

        Assert.Equal(HttpStatusCode.Conflict, status);
        Assert.Equal(DeviceExtendEndpoint.CourtNotLit, body.GetProperty("error").GetString());
        Assert.Empty(await BookingsOfAsync(r.App, c, c.Pam));
        Assert.Equal(200, await c.BalanceAsync(r.App, c.Pam));
        Assert.Equal(0, await c.UsesAsync(r.App));
    }

    // ---- one money use per code (member-code §4.4) ----------------------------------------------

    [SkippableFact]
    public async Task A_code_that_already_bought_court_time_cannot_buy_an_extension()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "extusedw");
        await using var _ = r.App;
        var c = r.Club;
        var code = c.Code(c.Pam);

        var walkUp = await r.Device.SendAsync(c.WalkUp(code, court: 3, nonce: "aaaaaaaaaaaaaaaa"));
        Assert.Equal(HttpStatusCode.OK, walkUp.StatusCode);

        var (status, body) = await SendAsync(r.Device, Extend(c, code, court: 3, minutes: 15, nonce: "abababababababab"));

        Assert.Equal(HttpStatusCode.Conflict, status);
        Assert.Equal("code_used", body.GetProperty("error").GetString());
        Assert.Single(await BookingsOfAsync(r.App, c, c.Pam));   // the walk-up, and no extension
        Assert.Equal(185, await c.BalanceAsync(r.App, c.Pam));

        // The court is in play, and a member with a fresh code extends it: the refusal was the code's.
        var (fresh, _) = await SendAsync(r.Device, Extend(c, c.Code(c.Olga), court: 3, minutes: 15, nonce: "acacacacacacacac"));
        Assert.Equal(HttpStatusCode.OK, fresh);
    }

    [SkippableFact]
    public async Task A_code_that_lit_a_court_cannot_then_buy_an_extension_on_it()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "extusedc");
        await using var _ = r.App;
        var c = r.Club;
        await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -2);
        var code = c.Code(c.Olga);

        var lit = await MemberCodeClub.JsonAsync(await r.Device.SendAsync(c.Activate(code)));
        Assert.True(lit.GetProperty("activated").GetBoolean());

        var (status, body) = await SendAsync(r.Device, Extend(c, code, court: 2, minutes: 15, nonce: "1c1c1c1c1c1c1c1c"));

        Assert.Equal(HttpStatusCode.Conflict, status);
        Assert.Equal("code_used", body.GetProperty("error").GetString());
        Assert.Equal(140, await c.BalanceAsync(r.App, c.Olga));
        Assert.Equal(0, await c.UsesAsync(r.App, MemberCodeUseClass.Money));
    }

    // ---- idempotency ---------------------------------------------------------------------------

    [SkippableFact]
    public async Task A_retried_nonce_is_answered_with_the_first_extension_and_never_charged_twice()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "extreplay");
        await using var _ = r.App;
        var c = r.Club;
        await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: -10, checkedIn: true);
        var code = c.Code(c.Pam);
        const string nonce = "5e5e5e5e5e5e5e5e";

        var first = await SendAsync(r.Device, Extend(c, code, court: 1, minutes: 30, nonce: nonce));
        var again = await SendAsync(r.Device, Extend(c, code, court: 1, minutes: 30, nonce: nonce));
        // The replay is answered before anything else is checked: a retry is the purchase already made.
        var garbled = await SendAsync(r.Device, Extend(c, "not-a-code", court: 1, minutes: 45, nonce: nonce));

        Assert.Equal(HttpStatusCode.OK, first.Status);
        Assert.False(first.Body.GetProperty("replayed").GetBoolean());
        foreach (var replay in new[] { again, garbled })
        {
            Assert.Equal(HttpStatusCode.OK, replay.Status);
            Assert.True(replay.Body.GetProperty("replayed").GetBoolean());
            Assert.Equal(first.Body.GetProperty("booking_id").GetGuid(), replay.Body.GetProperty("booking_id").GetGuid());
            Assert.Equal(30, replay.Body.GetProperty("amount_minutes").GetInt32());
            Assert.Equal(170, replay.Body.GetProperty("balance_after_minutes").GetInt32());
            Assert.Equal(first.Body.GetProperty("ends_at").GetString(), replay.Body.GetProperty("ends_at").GetString());
        }

        Assert.Single(await BookingsOfAsync(r.App, c, c.Pam));
        Assert.Equal(170, await c.BalanceAsync(r.App, c.Pam));
        var reference = DeviceExtendEndpoint.Reference(await BoxIdAsync(r.App, c), nonce);
        Assert.Equal(1, await c.ReadAsync(r.App, db => db.LedgerEntries.IgnoreQueryFilters().CountAsync(l => l.ExternalReference == reference)));
    }

    [SkippableFact]
    public async Task A_replay_of_an_extension_that_was_cancelled_is_purchase_ended()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "extended");
        await using var _ = r.App;
        var c = r.Club;
        await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: -10, checkedIn: true);
        const string nonce = "edededededededed";

        var (status, body) = await SendAsync(r.Device, Extend(c, c.Code(c.Pam), court: 1, minutes: 30, nonce: nonce));
        Assert.Equal(HttpStatusCode.OK, status);
        var bookingId = body.GetProperty("booking_id").GetGuid();
        await c.WriteAsync(r.App, async db =>
            (await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.Id == bookingId)).Status = BookingStatus.Cancelled);

        var (replayStatus, replay) = await SendAsync(r.Device, Extend(c, c.Code(c.Pam), court: 1, minutes: 30, nonce: nonce));

        Assert.Equal(HttpStatusCode.Conflict, replayStatus);
        Assert.Equal("purchase_ended", replay.GetProperty("error").GetString());
        Assert.Equal(bookingId, replay.GetProperty("booking_id").GetGuid());
        Assert.Equal(170, await c.BalanceAsync(r.App, c.Pam));
    }

    // ---- the request itself --------------------------------------------------------------------

    [SkippableFact]
    public async Task A_door_gate_cannot_extend_a_court()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "extgate");
        await using var _ = r.App;
        var c = r.Club;
        await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: -10, checkedIn: true);

        var (status, body) = await SendAsync(r.Device, Extend(c, c.Code(c.Pam), court: 1, minutes: 30, nonce: "9a9a9a9a9a9a9a9a", mac: c.DoorMac));

        Assert.Equal(HttpStatusCode.BadRequest, status);
        Assert.Equal("not_a_court_box", body.GetProperty("error").GetString());
        Assert.Empty(await BookingsOfAsync(r.App, c, c.Pam));
        Assert.Equal(200, await c.BalanceAsync(r.App, c.Pam));
    }

    [SkippableFact]
    public async Task Malformed_requests_are_refused_by_name_and_charge_nothing()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "extbad");
        await using var _ = r.App;
        var c = r.Club;
        await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: -10, checkedIn: true);
        await c.WriteAsync(r.App, async db =>
            (await db.Courts.IgnoreQueryFilters().SingleAsync(x => x.Id == c.Courts[3])).IsActive = false);

        async Task<(HttpStatusCode, string?)> Refusal(HttpRequestMessage req)
        {
            var (status, body) = await SendAsync(r.Device, req);
            return (status, body.GetProperty("error").GetString());
        }

        Assert.Equal((HttpStatusCode.BadRequest, "nonce_required"), await Refusal(Extend(c, c.Code(c.Pam), 1, 30, nonce: null)));
        Assert.Equal((HttpStatusCode.BadRequest, "nonce_required"), await Refusal(Extend(c, c.Code(c.Pam), 1, 30, nonce: "  ")));
        Assert.Equal((HttpStatusCode.BadRequest, "nonce_too_long"),
            await Refusal(Extend(c, c.Code(c.Pam), 1, 30, nonce: new string('n', DeviceEventEndpoints.MaxNonceLength + 1))));
        Assert.Equal((HttpStatusCode.BadRequest, "minutes_out_of_range"), await Refusal(Extend(c, c.Code(c.Pam), 1, 0, "m0m0m0m0m0m0m0m0")));
        Assert.Equal((HttpStatusCode.BadRequest, "minutes_out_of_range"),
            await Refusal(Extend(c, c.Code(c.Pam), 1, DeviceExtendEndpoint.MaxMinutes + 1, "m9m9m9m9m9m9m9m9")));
        Assert.Equal((HttpStatusCode.BadRequest, DeviceExtendEndpoint.CourtNotOnDevice),
            await Refusal(Extend(c, c.Code(c.Pam), 5, 30, "c5c5c5c5c5c5c5c5")));
        Assert.Equal((HttpStatusCode.NotFound, "court_not_found"), await Refusal(Extend(c, c.Code(c.Pam), 4, 30, "c4c4c4c4c4c4c4c4")));
        Assert.Equal((HttpStatusCode.BadRequest, "not_recognised"), await Refusal(Extend(c, "nobody-at-all", 1, 30, "n1n1n1n1n1n1n1n1")));
        // A PIN against the whole roll is an oracle, not an identification.
        Assert.Equal((HttpStatusCode.BadRequest, "not_recognised"), await Refusal(Extend(c, "1234", 1, 30, "n2n2n2n2n2n2n2n2", method: "pin")));

        Assert.Empty(await BookingsOfAsync(r.App, c, c.Pam));
        Assert.Equal(200, await c.BalanceAsync(r.App, c.Pam));
        Assert.Equal(0, await c.UsesAsync(r.App));
    }

    [SkippableFact]
    public async Task A_barred_member_is_not_recognised_and_charged_nothing()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "extbar");
        await using var _ = r.App;
        var c = r.Club;
        await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: -10, checkedIn: true);
        await c.WriteAsync(r.App, async db =>
            (await db.Memberships.IgnoreQueryFilters().SingleAsync(m => m.Id == c.SidMembership)).Status = MembershipStatus.Suspended);

        // Both ways a barred member can present: the rotating code (which no longer resolves) and the
        // app's ident QR (which does, and is then refused as barred).
        var (status, body) = await SendAsync(r.Device, Extend(c, c.Code(c.Sid), court: 1, minutes: 30, nonce: "5d5d5d5d5d5d5d5d"));
        var qr = await TestAccessCodes.MintIdentAsync(r.App.Services, c.TenantId, c.Slug, c.Sid);
        var (qrStatus, qrBody) = await SendAsync(r.Device, Extend(c, qr, court: 1, minutes: 30, nonce: "5e5d5d5d5d5d5d5d"));

        Assert.Equal(HttpStatusCode.BadRequest, status);
        Assert.Equal("not_recognised", body.GetProperty("error").GetString());
        Assert.Equal(HttpStatusCode.BadRequest, qrStatus);
        Assert.Equal("not_recognised", qrBody.GetProperty("error").GetString());
        Assert.Empty(await BookingsOfAsync(r.App, c, c.Sid));
        Assert.Equal(200, await c.BalanceAsync(r.App, c.Sid));
    }

    [SkippableFact]
    public async Task An_ident_qr_identifies_the_scanner_as_well_as_a_member_code()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "extident");
        await using var _ = r.App;
        var c = r.Club;
        await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: -10, checkedIn: true);
        var qr = await TestAccessCodes.MintIdentAsync(r.App.Services, c.TenantId, c.Slug, c.Pam);

        var (status, body) = await SendAsync(r.Device, Extend(c, qr, court: 1, minutes: 15, nonce: "1d1d1d1d1d1d1d1d"));

        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal(15, body.GetProperty("amount_minutes").GetInt32());
        Assert.Equal(185, await c.BalanceAsync(r.App, c.Pam));
        Assert.Equal(0, await c.UsesAsync(r.App));   // an ident code is not a member code: no use is written
    }

    // ---- what else moves ------------------------------------------------------------------------

    [SkippableFact]
    public async Task The_lit_courts_believed_end_moves_to_the_extensions_end()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "extlight");
        await using var _ = r.App;
        var c = r.Club;
        var playing = await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: -10, checkedIn: true);
        var onSince = playing.StartsAt;
        await c.WriteAsync(r.App, db =>
        {
            db.CourtLightStates.Add(new CourtLightState
            {
                TenantId = c.TenantId,
                CourtId = c.Courts[0],
                State = LightState.On,
                OnSince = onSince,
                OnUntil = playing.EndsAt,
                BookingId = playing.Id,
                Cause = LightCause.Member,
                CausedByUserId = c.Olga,
            });
            return Task.CompletedTask;
        });

        var (status, _) = await SendAsync(r.Device, Extend(c, c.Code(c.Pam), court: 1, minutes: 30, nonce: "11ee11ee11ee11ee"));

        Assert.Equal(HttpStatusCode.OK, status);
        var light = await c.ReadAsync(r.App, db => db.CourtLightStates.IgnoreQueryFilters().AsNoTracking()
            .SingleAsync(l => l.CourtId == c.Courts[0]));
        Assert.Equal(LightState.On, light.State);
        Assert.Equal(playing.EndsAt.AddMinutes(30), light.OnUntil);
        // The same light running on: when it came on, and why, are unchanged.
        Assert.Equal(onSince, light.OnSince);
        Assert.Equal(LightCause.Member, light.Cause);
        Assert.Equal(c.Olga, light.CausedByUserId);
    }

    /// <summary>
    /// Every player-affecting event sends an email, and email never holds a request: on the real
    /// <c>IEmailService</c> the confirmation lands in the outbox, addressed to the scanner.
    /// </summary>
    [SkippableFact]
    public async Task The_scanner_is_sent_a_confirmation_through_the_outbox()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var c = await MemberCodeClub.SeedAsync(factory, "extmail", MemberCodeClub.SettingsAtNoon());
        await c.BookAsync(factory, c.Olga, courtIndex: 0, startsInMinutes: -10, checkedIn: true);
        var pamAddress = $"pam-{c.Slug}@test.local";

        var (status, _) = await SendAsync(factory.CreateClient(), Extend(c, c.Code(c.Pam), court: 1, minutes: 30, nonce: "3a113a113a113a11"));
        Assert.Equal(HttpStatusCode.OK, status);

        // The confirmation is composed off the request path; wait for it to be queued.
        EmailOutboxMessage? queued = null;
        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (queued is null && DateTime.UtcNow < deadline)
        {
            queued = await c.ReadAsync(factory, db => db.EmailOutbox.IgnoreQueryFilters().AsNoTracking()
                .FirstOrDefaultAsync(m => m.ToAddress == pamAddress));
            if (queued is null) await Task.Delay(50);
        }

        Assert.NotNull(queued);
        Assert.Equal(c.TenantId, queued!.TenantId);
        Assert.Equal(EmailOutboxState.Pending, queued.State);
        // Only the scanner is mailed: the member whose session was extended paid nothing.
        Assert.False(await c.ReadAsync(factory, db => db.EmailOutbox.IgnoreQueryFilters()
            .AnyAsync(m => m.ToAddress == $"olga-{c.Slug}@test.local")));
    }

    // ---- tenant isolation (a P0 if it leaks) ----------------------------------------------------

    [SkippableFact]
    public async Task One_clubs_box_can_neither_extend_another_clubs_court_nor_bill_another_clubs_member()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var mail = new StubEmailService();
        await using var app = MemberCodeClub.Wired(factory, mail);
        var a = await MemberCodeClub.SeedAsync(app, "extxa", MemberCodeClub.SettingsAtNoon());
        var b = await MemberCodeClub.SeedAsync(app, "extxb", MemberCodeClub.SettingsAtNoon());
        var device = app.CreateClient();
        var playingA = await a.BookAsync(app, a.Olga, courtIndex: 0, startsInMinutes: -10, checkedIn: true);

        // B's box names court 1 — the number A's lit court has. B's court 1 is dark: B cannot reach A's.
        var (fromB, bodyB) = await SendAsync(device, Extend(b, b.Code(b.Pam), court: 1, minutes: 30, nonce: "x1x1x1x1x1x1x1x1"));
        Assert.Equal(HttpStatusCode.Conflict, fromB);
        Assert.Equal(DeviceExtendEndpoint.CourtNotLit, bodyB.GetProperty("error").GetString());

        // B's members scanned at A's box, by member code and by ident QR, are nobody A knows.
        var (codeAtA, codeBody) = await SendAsync(device, Extend(a, b.Code(b.Pam), court: 1, minutes: 30, nonce: "x2x2x2x2x2x2x2x2"));
        Assert.Equal(HttpStatusCode.BadRequest, codeAtA);
        Assert.Equal("not_recognised", codeBody.GetProperty("error").GetString());
        var foreignQr = await TestAccessCodes.MintIdentAsync(app.Services, b.TenantId, b.Slug, b.Pam);
        var (qrAtA, qrBody) = await SendAsync(device, Extend(a, foreignQr, court: 1, minutes: 30, nonce: "x3x3x3x3x3x3x3x3"));
        Assert.Equal(HttpStatusCode.BadRequest, qrAtA);
        Assert.Equal("not_recognised", qrBody.GetProperty("error").GetString());

        // A's box carrying B's API key is not A's box: the device does not resolve under B.
        var wrongKey = await device.SendAsync(Extend(b, b.Code(b.Pam), court: 1, minutes: 30, nonce: "x4x4x4x4x4x4x4x4", mac: a.BoxMac));
        Assert.NotEqual(HttpStatusCode.OK, wrongKey.StatusCode);

        // Nothing was sold anywhere, and nobody in either club was charged.
        Assert.Equal(200, await b.BalanceAsync(app, b.Pam));
        Assert.Equal(200, await a.BalanceAsync(app, a.Pam));
        Assert.Empty(await BookingsOfAsync(app, b, b.Pam));
        Assert.Equal(playingA.EndsAt, (await a.ReadAsync(app, db => db.Bookings.IgnoreQueryFilters().AsNoTracking()
            .Where(x => x.CourtId == a.Courts[0]).ToListAsync())).Max(x => x.EndsAt));

        // And the same nonce at A's own box is A's own fresh purchase — a nonce is never shared across boxes.
        var (own, ownBody) = await SendAsync(device, Extend(a, a.Code(a.Pam), court: 1, minutes: 30, nonce: "x1x1x1x1x1x1x1x1"));
        Assert.Equal(HttpStatusCode.OK, own);
        Assert.False(ownBody.GetProperty("replayed").GetBoolean());
        Assert.Equal(170, await a.BalanceAsync(app, a.Pam));
        Assert.Equal(200, await b.BalanceAsync(app, b.Pam));
    }
}

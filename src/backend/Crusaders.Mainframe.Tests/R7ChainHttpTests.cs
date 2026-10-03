using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 7, the end-to-end chain (E7) and the money journeys (J7) as the backend owes them:
/// whose money a night's amount column holds and both halves of every share (E7-3), what one
/// unnamed door is called (E7-4), the payer at the box reading the court they paid for (E7-5), a
/// member's daily rows adding up (J7-2) and minutes said in words in a booking mail (J7-3).
/// </summary>
public sealed class R7ChainHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Nonce = "7e7e7e7e7e7e7e7e";

    private sealed record Rig(MemberCodeClub Club, WebApplicationFactory<Program> App, StubEmailService Mail, HttpClient Device);

    private static async Task<Rig> RigAsync(TestWebAppFactory factory, string prefix, string? settings = null)
    {
        var mail = new StubEmailService();
        var app = MemberCodeClub.Wired(factory, mail);
        var club = await MemberCodeClub.SeedAsync(app, prefix, settings ?? MemberCodeClub.Settings);
        return new Rig(club, app, mail, app.CreateClient());
    }

    private static async Task<List<JsonElement>> NightAsync(Rig r, Guid user)
    {
        var admin = r.Club.Member(r.App, r.Club.AdminId, "admin");
        var body = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{user}/trace");
        return body.GetProperty("events").EnumerateArray().ToList();
    }

    private static string Kind(JsonElement e) => e.GetProperty("kind").GetString()!;

    private static Guid? SubjectOf(JsonElement e) =>
        e.GetProperty("subject").ValueKind == JsonValueKind.Null ? null : e.GetProperty("subject").GetProperty("user_id").GetGuid();

    /// <summary>
    /// E7-3: Pam paid Olga a 15-minute share, and the club's sweep later handed it back. Pam's
    /// night showed Olga's +15 in PAM's amount column beside Pam's own −15, and the automatic
    /// return had no counterpart at all (its other half was the system's act, not Pam's).
    /// </summary>
    [SkippableFact]
    public async Task A_nights_amount_column_is_the_members_own_and_every_share_shows_both_halves()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "r7share");
        await using var _ = r.App;
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: 60, minutes: 30);
        await c.WriteAsync(r.App, db =>
        {
            Share(db, c, booking.Id, from: c.Pam, to: c.Olga, actor: c.Pam, seq: 1);
            Share(db, c, booking.Id, from: c.Olga, to: c.Pam, actor: Guid.Empty, seq: 2);
            return Task.CompletedTask;
        });

        var shares = (await NightAsync(r, c.Pam)).Where(e => Kind(e) == TraceKinds.WalletShareMoved).ToList();
        Assert.Equal(4, shares.Count);

        var own = shares.Where(e => SubjectOf(e) == c.Pam).ToList();
        Assert.Equal([-15, 15], own.Select(e => e.GetProperty("amount_minutes").GetInt32()).Order());

        var olgas = shares.Where(e => SubjectOf(e) == c.Olga).ToList();
        Assert.Equal(2, olgas.Count);
        Assert.All(olgas, e =>
        {
            Assert.Equal(JsonValueKind.Null, e.GetProperty("amount_minutes").ValueKind);
            Assert.Equal(JsonValueKind.Null, e.GetProperty("balance_after_minutes").ValueKind);
            Assert.Contains("Olga Organiser", e.GetProperty("headline").GetString());
            Assert.Contains("15 minutes", e.GetProperty("headline").GetString());
        });
    }

    private static void Share(MainframeDbContext db, MemberCodeClub c, Guid booking, Guid from, Guid to, Guid actor, int seq)
    {
        var key = $"share:{Guid.NewGuid():N}:{seq}";
        db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = c.TenantId, UserId = from, Type = LedgerEntryType.ShareTransfer, AmountMinutes = -15,
            ActorUserId = actor, RelatedBookingId = booking, Reason = "Share of a split booking", ExternalReference = $"{key}:out",
        });
        db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = c.TenantId, UserId = to, Type = LedgerEntryType.ShareTransfer, AmountMinutes = 15,
            ActorUserId = actor, RelatedBookingId = booking, Reason = "Share of a split booking", ExternalReference = $"{key}:in",
        });
    }

    /// <summary>
    /// E7-4: one gate the club never named read "Door gate" (the auto-registration placeholder,
    /// which no surface may present as a name) on the night and "Unnamed scanner (gate-…)" on the
    /// Doors page. The night uses the console's rule.
    /// </summary>
    [SkippableFact]
    public async Task An_unnamed_gate_is_called_what_the_doors_page_calls_it()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "r7door");
        await using var _ = r.App;
        var c = r.Club;
        await c.WriteAsync(r.App, async db =>
        {
            var gate = await db.Devices.IgnoreQueryFilters().SingleAsync(d => d.MacAddress == c.DoorMac);
            gate.Name = DeviceRegistryService.GatePlaceholderName;
            gate.GateKey = null;
        });

        var opened = await MemberCodeClub.JsonAsync(await r.Device.SendAsync(c.Gate(c.Code(c.Olga))));
        Assert.True(opened.GetProperty("opened").GetBoolean());

        var door = Assert.Single(await NightAsync(r, c.Olga), e => Kind(e) == TraceKinds.DoorOpened);
        Assert.Equal($"Came in through Unnamed scanner (gate-{c.DoorMac[^6..]})", door.GetProperty("headline").GetString());
        Assert.DoesNotContain(DeviceRegistryService.GatePlaceholderName, door.GetRawText());
    }

    /// <summary>
    /// E7-5: Pam paid for Olga's court at the box. Her wallet carried the whole charge, and the
    /// booking it paid for answered her "Booking not found", listed nowhere for her, and was
    /// missing from the desk's Bookings tab for her. She reads it now — and may change nothing.
    /// </summary>
    [SkippableFact]
    public async Task The_payer_at_the_box_reads_the_court_they_paid_for_and_it_is_listed_for_them()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "r7payer");
        await using var _ = r.App;
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -10, checkedIn: true);
        (await r.Device.SendAsync(c.PayFor(c.Code(c.Pam), 2, Nonce, confirm: false))).EnsureSuccessStatusCode();
        var paid = await MemberCodeClub.JsonAsync(await r.Device.SendAsync(c.PayFor(c.Code(c.Pam), 2, Nonce, confirm: true, label: "60")));
        Assert.True(paid.GetProperty("paid").GetBoolean());

        var pam = c.Member(r.App, c.Pam);
        var detail = await pam.GetAsync($"/api/v1/bookings/{booking.Id}");
        Assert.Equal(HttpStatusCode.OK, detail.StatusCode);
        var body = await MemberCodeClub.JsonAsync(detail);
        Assert.Equal("payer", body.GetProperty("viewer").GetProperty("role").GetString());
        Assert.Equal(c.Pam, body.GetProperty("money").GetProperty("paid_by").GetProperty("user_id").GetGuid());
        Assert.All(body.GetProperty("permissions").EnumerateObject().Where(p => p.Value.ValueKind is JsonValueKind.True or JsonValueKind.False),
            p => Assert.False(p.Value.GetBoolean(), $"a payer may not {p.Name}"));

        var upcoming = await pam.GetFromJsonAsync<JsonElement>("/api/v1/me/bookings/upcoming");
        var mine = Assert.Single(Items(upcoming), g => g.GetProperty("booking_id").GetGuid() == booking.Id);
        Assert.Equal("payer", mine.GetProperty("role").GetString());
        Assert.Equal(60, mine.GetProperty("my_paid_minutes").GetInt32());

        var admin = c.Member(r.App, c.AdminId, "admin");
        var desk = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{c.Pam}/bookings?when=upcoming");
        var row = Assert.Single(desk.GetProperty("items").EnumerateArray(), b => b.GetProperty("booking_id").GetGuid() == booking.Id);
        Assert.Equal("payer", row.GetProperty("role").GetString());
        Assert.Equal(60, row.GetProperty("cost_minutes").GetInt32());

        // A stranger still reads nothing.
        Assert.Equal(HttpStatusCode.NotFound, (await c.Member(r.App, c.Sid).GetAsync($"/api/v1/bookings/{booking.Id}")).StatusCode);
    }

    /// <summary>
    /// E7-6 (FD1's ask): "Recent games" printed a no-show as 06:24–06:29 — the sweep's cut end —
    /// for a game sold to 07:09. The member's lists carry the sold end beside the live one.
    /// </summary>
    [SkippableFact]
    public async Task A_recent_no_show_lists_the_end_it_was_sold_to()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "r7sold");
        await using var _ = r.App;
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: -120, minutes: 45);
        await c.WriteAsync(r.App, async db =>
        {
            var row = await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.Id == booking.Id);
            row.Status = BookingStatus.NoShow;
            row.EndsAt = row.StartsAt.AddMinutes(5);
        });

        var recent = await c.Member(r.App, c.Olga).GetFromJsonAsync<JsonElement>("/api/v1/me/bookings/recent");
        var game = Assert.Single(Items(recent), g => g.GetProperty("booking_id").GetGuid() == booking.Id);
        Assert.Equal(booking.StartsAt.AddMinutes(5), game.GetProperty("ends_at").GetDateTimeOffset());
        Assert.Equal(booking.StartsAt.AddMinutes(45), game.GetProperty("sold_ends_at").GetDateTimeOffset());
    }

    private static IEnumerable<JsonElement> Items(JsonElement list) =>
        list.ValueKind == JsonValueKind.Array ? list.EnumerateArray() : list.GetProperty("items").EnumerateArray();

    /// <summary>
    /// J7-2: the member's daily breakdown had top-ups, spend and refunds only, so a day with a
    /// share, a penalty or a desk adjustment did not add up to what the balance moved. Every
    /// bucket is there now, and the buckets sum to the day's movement.
    /// </summary>
    [SkippableFact]
    public async Task A_members_daily_rows_add_up_to_what_their_balance_moved()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "r7daily");
        await using var _ = r.App;
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Pam, courtIndex: 0, startsInMinutes: -120, minutes: 30);
        await c.WriteAsync(r.App, db =>
        {
            Row(db, c, LedgerEntryType.NoShowPenalty, -9, booking.Id);
            Row(db, c, LedgerEntryType.AdminAdjustment, 5, null);
            Row(db, c, LedgerEntryType.PaymentReversal, -20, null);
            Share(db, c, booking.Id, from: c.Pam, to: c.Olga, actor: c.Pam, seq: 1);
            return Task.CompletedTask;
        });

        var days = (await c.Member(r.App, c.Pam).GetFromJsonAsync<JsonElement>("/api/v1/reports/me/daily")).EnumerateArray().ToList();
        int Sum(string field) => days.Sum(d => d.GetProperty(field).GetInt32());

        Assert.Equal(9, Sum("penalties_minutes"));
        Assert.Equal(5, Sum("adjustments_minutes"));
        Assert.Equal(-20, Sum("reversals_minutes"));
        Assert.Equal(-15, Sum("share_transfers_minutes"));
        foreach (var d in days)
        {
            var buckets = d.GetProperty("top_ups_minutes").GetInt32() - d.GetProperty("spent_minutes").GetInt32()
                          + d.GetProperty("refunds_minutes").GetInt32() - d.GetProperty("penalties_minutes").GetInt32()
                          + d.GetProperty("adjustments_minutes").GetInt32() + d.GetProperty("reversals_minutes").GetInt32()
                          + d.GetProperty("share_transfers_minutes").GetInt32();
            Assert.Equal(d.GetProperty("net_movement_minutes").GetInt32(), buckets);
        }
        Assert.Equal(await c.BalanceAsync(r.App, c.Pam), days[^1].GetProperty("balance_minutes").GetInt32());
        Assert.Equal(200 - 30 - 9 + 5 - 20 - 15, Sum("net_movement_minutes"));
    }

    private static void Row(MainframeDbContext db, MemberCodeClub c, LedgerEntryType type, int minutes, Guid? booking) =>
        db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = c.TenantId, UserId = c.Pam, Type = type, AmountMinutes = minutes,
            ActorUserId = c.AdminId, RelatedBookingId = booking, Reason = type.ToString(),
        });

    /// <summary>
    /// J7-3: a box walk-up's mail said "Court time: 60 min" — a compact figure inside a sentence a
    /// screen reader reads whole, beside "Charged: 1 hour" in long words. Minutes in prose are words.
    /// </summary>
    [SkippableFact]
    public async Task A_walk_up_mail_says_its_court_time_in_words()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        var r = await RigAsync(factory, "r7mail", MemberCodeClub.SettingsAtNoon());
        await using var _ = r.App;
        var c = r.Club;

        var bought = await r.Device.SendAsync(c.WalkUp(c.Code(c.Pam), court: 3, nonce: Nonce, minutes: 60));
        Assert.Equal(HttpStatusCode.OK, bought.StatusCode);

        EmailMessage? mail = null;
        for (var i = 0; i < 50 && mail is null; i++)
        {
            mail = r.Mail.Sent.FirstOrDefault(m => m.Subject.StartsWith("Court time started", StringComparison.Ordinal));
            if (mail is null) await Task.Delay(100);
        }
        Assert.NotNull(mail);
        Assert.EndsWith(", 1 hour", mail!.Subject, StringComparison.Ordinal);
        Assert.Contains("Court time: 1 hour", mail.PlainBody, StringComparison.Ordinal);
        Assert.DoesNotContain("60 min", mail.PlainBody, StringComparison.Ordinal);
    }
}

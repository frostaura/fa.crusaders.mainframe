using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 16, lane BE16b — one split game, through the whole stack, from each side of it.
/// Shared set-up for the three R16 classes below (split by theme so none is the suite's floor).
/// </summary>
internal static class R16Kit
{
    public const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    public sealed record Game(
        PlayersClub Club, WebApplicationFactory<Program> App, CapturingMail Mail, Guid BookingId, DateTimeOffset Start,
        Dictionary<Guid, Guid> SeatOf)
    {
        /// <summary>The court and start as every inbox line says them: "Court 1, Thu 8 Oct, 08:00".</summary>
        public string Where => $"Court 1, {Start.ToString("ddd d MMM, HH:mm", CultureInfo.InvariantCulture)}";

        public HttpClient Admin => Club.Client(App, Club.Admin, admin: true);

        public HttpClient As(Guid user) => Club.Client(App, user);
    }

    /// <summary>Olive's 32-minute court three days out at 08:00, with Sam (and, for two, Alex) invited — accepted and paid when <paramref name="accept"/>.</summary>
    public static async Task<Game> GameAsync(PostgresFixture pg, string prefix, int partners, bool accept = true, int partnerFloat = 50)
    {
        var mail = new CapturingMail();
        var app = CapturingMail.On(pg.SharedHost, mail);
        var club = await PlayersClub.SeedAsync(app, prefix);
        var who = new[] { club.Sam, club.Alex }.Take(partners).ToArray();
        foreach (var p in who) await club.CreditAsync(app, p, partnerFloat);
        await club.CreditAsync(app, club.Organiser, 100);
        var start = PlayersClub.Tomorrow(8).AddDays(2);
        var bookingId = await club.InsertBookingAsync(app, start);
        (await club.Client(app, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players",
            new { players = who.Select(p => (object)new { userId = p }).ToArray() })).EnsureSuccessStatusCode();
        var seatOf = new Dictionary<Guid, Guid>();
        foreach (var seat in await club.SeatsAsync(app, bookingId))
        {
            if (seat.Seat == 1 || seat.UserId is not { } user) continue;
            seatOf[user] = seat.Id;
            if (!accept) continue;
            (await club.Client(app, user).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat.Id}/accept",
                new { expectedShareMinutes = seat.ShareMinutes })).EnsureSuccessStatusCode();
        }
        await DeliverAsync(app);
        mail.Sent.Clear();
        return new Game(club, app, mail, bookingId, start, seatOf);
    }

    public static async Task DeliverAsync(WebApplicationFactory<Program> app)
    {
        for (var i = 0; i < 50 && await PeopleClub.DeliverAdminNoticesAsync(app) > 0; i++) { }
    }

    public static List<EmailMessage> MailTo(Game g, string handle) =>
        [.. g.Mail.Sent.Where(m => m.To == $"{handle}@{g.Club.Slug}.review.test")];

    public static string Flat(EmailMessage m) =>
        System.Text.RegularExpressions.Regex.Replace(m.PlainBody + " " + m.HtmlBody, @"\s+", " ");

    public static Task<List<MemberNotification>> InboxAsync(Game g, Guid user, string? kind = null) =>
        PlayersClub.ReadAsync(g.App, db => db.MemberNotifications.IgnoreQueryFilters()
            .Where(n => n.UserId == user && n.BookingId == g.BookingId && (kind == null || n.Kind == kind))
            .OrderBy(n => n.CreatedAt).ToListAsync());

    public static Task<List<AuditLog>> AuditAsync(Game g, string action) =>
        PlayersClub.ReadAsync(g.App, db => db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == g.Club.TenantId && a.Action == action).OrderBy(a => a.CreatedAt).ToListAsync());

    public static async Task<List<JsonElement>> NightAsync(Game g, Guid user)
    {
        var body = await g.Admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{user}/trace");
        return [.. body.GetProperty("events").EnumerateArray()];
    }

    public static string Kind(JsonElement e) => e.GetProperty("kind").GetString()!;

    public static string Headline(JsonElement e) => e.GetProperty("headline").GetString()!;

    public static bool Own(JsonElement e) => e.GetProperty("amount_minutes").ValueKind == JsonValueKind.Number;

    public static JsonElement LastOwnShare(List<JsonElement> night) =>
        night.Last(e => Kind(e) == TraceKinds.WalletShareMoved && Own(e));

    /// <summary>The member's wallet CSV, one array of cells per line after the header.</summary>
    public static async Task<List<string[]>> CsvAsync(Game g, Guid user)
    {
        var from = DateTimeOffset.UtcNow.AddDays(-1).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var to = DateTimeOffset.UtcNow.AddDays(1).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var response = await g.As(user).GetAsync($"/api/v1/reports/me/wallet.csv?from={from}&to={to}");
        response.EnsureSuccessStatusCode();
        return [.. (await response.Content.ReadAsStringAsync()).Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Skip(1).Select(l => l.TrimEnd('\r').Split(','))];
    }

    public static async Task<JsonElement> SeatRowAsync(Game g, HttpClient viewer, Guid seatId)
    {
        var detail = await viewer.GetFromJsonAsync<JsonElement>($"/api/v1/bookings/{g.BookingId}");
        return detail.GetProperty("players").EnumerateArray().Single(p =>
            p.GetProperty("participant_id").ValueKind == JsonValueKind.String && p.GetProperty("participant_id").GetGuid() == seatId);
    }

    public static async Task<JsonElement> BodyAsync(HttpResponseMessage response) =>
        await response.Content.ReadFromJsonAsync<JsonElement>();
}

/// <summary>
/// Review round 16, lane BE16b — the seat acts:
/// <list type="bullet">
/// <item>J16-2: a share an ADD lowered went back as the club's system with no cause ("Share refunded… came
/// back from Mia", actor (unknown), Transactions "The club's system"). Now the adder's act, cause
/// <c>player_added</c>, worded "Jo joined, so the split went down" on every surface — and no share row a
/// person caused is posted with an empty actor.</item>
/// <item>J16-11: a member already at their daily cap could be invited — an invite they could never accept.</item>
/// <item>E16-8 / J16-10: collect on an unanswered invite said <c>not_invited</c>; the overdraft tick was
/// required even when the partner's balance covered the share.</item>
/// <item>E16-1 / J16-5: the club's accept-on-behalf wrote no record and reached nobody's Night.</item>
/// <item>J16-1: a share settled by hand was asked for consent after a split change.</item>
/// </list>
/// </summary>
public sealed class R16SeatActsHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    // ------------------------------------------------------------------ J16-2

    [SkippableTheory]
    [InlineData(false, 1)]
    [InlineData(true, 1)]
    [InlineData(false, 2)]
    [InlineData(true, 2)]
    public async Task A_share_an_add_lowered_goes_back_as_the_adders_act_with_its_cause(bool byClub, int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = await R16Kit.GameAsync(pg, $"r16b-add{(byClub ? "c" : "o")}{partners}", partners);
        var before = DateTimeOffset.UtcNow;
        var add = byClub
            ? g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players", new { userId = g.Club.Jo, reason = "Phoned in" })
            : g.As(g.Club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{g.BookingId}/players", new { players = new object[] { new { userId = g.Club.Jo } } });
        (await add).EnsureSuccessStatusCode();
        await R16Kit.DeliverAsync(g.App);
        var adder = byClub ? g.Club.Admin : g.Club.Organiser;

        // The guard: every share row the add caused names the person who added — never the system.
        var rows = (await g.Club.SharesAsync(g.App, g.BookingId)).Where(l => l.CreatedAt >= before).ToList();
        Assert.Equal(partners * 2, rows.Count);
        Assert.All(rows, r => Assert.Equal(adder, r.ActorUserId));

        var back = rows.Single(r => r.UserId == g.Club.Sam);
        var line = (await R16Kit.InboxAsync(g, g.Club.Sam, MemberEventCatalogue.ShareMoved)).Last();
        Assert.Equal($"{back.AmountMinutes} minutes of your share came back — Jo Partner joined {g.Where}, so the split went down", line.Headline);
        var olive = (await R16Kit.InboxAsync(g, g.Club.Organiser, MemberEventCatalogue.ShareMoved)).Last();
        Assert.EndsWith($"— Jo Partner joined {g.Where}, so the split went down", olive.Headline, StringComparison.Ordinal);

        var mail = Assert.Single(R16Kit.MailTo(g, "sam.partner"), m => m.Subject.Contains("share", StringComparison.OrdinalIgnoreCase));
        Assert.Equal("Your share went down: Jo Partner joined — Court 1", mail.Subject);
        Assert.Contains("Jo Partner joined the game and the split went down", R16Kit.Flat(mail), StringComparison.Ordinal);

        var csv = (await R16Kit.CsvAsync(g, g.Club.Sam)).Last(c => c[1] == "ShareTransfer");
        Assert.Equal(WalletShareCauses.PlayerAdded, csv[5]);
        Assert.Equal(byClub ? "The club" : "Olive Organiser", csv[6]);

        var night = await R16Kit.NightAsync(g, g.Club.Sam);
        Assert.EndsWith(" — Jo Partner joined, so their share went down", R16Kit.Headline(R16Kit.LastOwnShare(night)), StringComparison.Ordinal);
        var now = (await g.Club.SeatsAsync(g.App, g.BookingId)).Single(s => s.UserId == g.Club.Sam).ShareMinutes;
        Assert.Contains(night, e => R16Kit.Headline(e) == $"Jo Partner joined Olive Organiser's game on Court 1, so their share is now {now} minutes");

        // The admin's Transactions name who did it, as the wallet row does.
        var ledger = await g.Admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/ledger?userId={g.Club.Sam}");
        var row = ledger.EnumerateArray().First(r => r.GetProperty("id").GetGuid() == back.Id);
        Assert.Equal(byClub ? "Ada Admin" : "Olive Organiser", row.GetProperty("actor_name").GetString());
        Assert.Equal(row.GetProperty("actor_name").GetString(), row.GetProperty("actorName").GetString());
    }

    // ------------------------------------------------------------------ J16-11

    [SkippableTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task A_member_already_at_their_daily_cap_is_not_added(bool byClub)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = await R16Kit.GameAsync(pg, $"r16b-cap{(byClub ? "c" : "o")}", 1);
        // Jo already holds the club's four slots on that day.
        await g.Club.InsertBookingAsync(g.App, g.Start.AddHours(4), organiser: g.Club.Jo);
        var shares = (await g.Club.SharesAsync(g.App, g.BookingId)).Count;

        var add = await (byClub
            ? g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players", new { userId = g.Club.Jo, reason = "Phoned in", accepted = true })
            : g.As(g.Club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{g.BookingId}/players", new { players = new object[] { new { userId = g.Club.Jo } } }));

        Assert.Equal(HttpStatusCode.Conflict, add.StatusCode);
        var body = await R16Kit.BodyAsync(add);
        Assert.Equal(PlayerErrors.AtDailyLimit, body.GetProperty("error").GetString());
        Assert.Equal(g.Club.Jo, body.GetProperty("user_id").GetGuid());
        Assert.Equal("Jo Partner", body.GetProperty("name").GetString());
        Assert.DoesNotContain(await g.Club.SeatsAsync(g.App, g.BookingId), s => s.UserId == g.Club.Jo);
        Assert.Equal(shares, (await g.Club.SharesAsync(g.App, g.BookingId)).Count);   // no re-split

        // A member with room that day is added as before.
        var alex = await (byClub
            ? g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players", new { userId = g.Club.Alex, reason = "Phoned in" })
            : g.As(g.Club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{g.BookingId}/players", new { players = new object[] { new { userId = g.Club.Alex } } }));
        Assert.Equal(HttpStatusCode.OK, alex.StatusCode);
    }

    // ------------------------------------------------------------------ E16-8 / J16-10

    [SkippableFact]
    public async Task Collecting_an_unanswered_invite_says_it_was_never_accepted()
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = await R16Kit.GameAsync(pg, "r16b-colinv", 1, accept: false);
        var collect = await g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players/{g.SeatOf[g.Club.Sam]}/collect",
            new { reason = "Bar tab", allowNegativeBalance = true });
        Assert.Equal(HttpStatusCode.Conflict, collect.StatusCode);
        Assert.Equal(PlayerErrors.NotAccepted, (await R16Kit.BodyAsync(collect)).GetProperty("error").GetString());
    }

    [SkippableTheory]
    [InlineData(50, false)]   // covered: no tick needed
    [InlineData(0, true)]     // short: the tick, by name
    public async Task The_overdraft_is_named_only_when_the_partner_cannot_cover_the_share(int partnerFloat, bool short_)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = await R16Kit.GameAsync(pg, $"r16b-col{partnerFloat}", 1, accept: false, partnerFloat: partnerFloat);
        var seat = g.SeatOf[g.Club.Sam];
        // The club says yes for Sam (no consent recorded), so the share is unpaid and only the desk's collect takes it.
        (await g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players/{seat}/accept", new { reason = "Playing tonight" })).EnsureSuccessStatusCode();
        var share = (await g.Club.SeatsAsync(g.App, g.BookingId)).Single(s => s.Id == seat).ShareMinutes;

        var row = await R16Kit.SeatRowAsync(g, g.Admin, seat);
        Assert.Equal(short_, row.GetProperty("collect_needs_overdraft").GetBoolean());

        var bare = await g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players/{seat}/collect", new { reason = "Bar tab" });
        if (short_)
        {
            Assert.Equal(HttpStatusCode.BadRequest, bare.StatusCode);
            var refusal = await R16Kit.BodyAsync(bare);
            Assert.Equal(PlayerErrors.OverdraftNotAuthorised, refusal.GetProperty("error").GetString());
            Assert.Equal(share, refusal.GetProperty("collect_minutes").GetInt32());
            Assert.Equal(0, refusal.GetProperty("balance_minutes").GetInt32());
            Assert.Empty(await g.Club.SharesAsync(g.App, g.BookingId));
            bare = await g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players/{seat}/collect", new { reason = "Bar tab", allowNegativeBalance = true });
        }
        Assert.Equal(HttpStatusCode.OK, bare.StatusCode);
        Assert.Equal(share, (await R16Kit.BodyAsync(bare)).GetProperty("collected_minutes").GetInt32());
        Assert.Equal(JsonValueKind.Null, (await R16Kit.SeatRowAsync(g, g.Admin, seat)).GetProperty("collect_needs_overdraft").ValueKind);
    }

    // ------------------------------------------------------------------ E16-1 / J16-5

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task The_clubs_accept_on_behalf_is_on_the_record_on_three_Nights_and_in_the_organisers_inbox(int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = await R16Kit.GameAsync(pg, $"r16b-acc{partners}", partners, accept: false);
        var seat = g.SeatOf[g.Club.Sam];
        (await g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players/{seat}/accept", new { reason = "Playing tonight" })).EnsureSuccessStatusCode();

        var audit = Assert.Single(await R16Kit.AuditAsync(g, "players.accepted_by_club"));
        Assert.Equal(g.Club.Admin, audit.ActorUserId);
        Assert.Equal(g.Club.Sam, audit.SubjectUserId);
        Assert.Equal(seat, JsonDocument.Parse(audit.DetailsJson!).RootElement.GetProperty("participant_id").GetGuid());

        Assert.Equal("Ada Admin accepted their place in Olive Organiser's game on Court 1 for them",
            R16Kit.Headline(Assert.Single(await R16Kit.NightAsync(g, g.Club.Sam), e => R16Kit.Kind(e) == TraceKinds.BookingAcceptedForThem)));
        Assert.Equal("Ada Admin accepted Sam Partner's place in their game on Court 1 for them",
            R16Kit.Headline(Assert.Single(await R16Kit.NightAsync(g, g.Club.Organiser), e => R16Kit.Kind(e) == TraceKinds.BookingClubAcceptedPlayer)));
        Assert.Equal("Accepted Sam Partner's place in Olive Organiser's game on Court 1 for them",
            R16Kit.Headline(Assert.Single(await R16Kit.NightAsync(g, g.Club.Admin), e => R16Kit.Kind(e) == TraceKinds.BookingAcceptedForPlayer)));

        var line = Assert.Single(await R16Kit.InboxAsync(g, g.Club.Organiser, MemberEventCatalogue.Response), n => n.Headline.StartsWith("The club", StringComparison.Ordinal));
        Assert.Equal($"The club accepted Sam Partner's place in your game — {g.Where}", line.Headline);
    }

    // ------------------------------------------------------------------ J16-1

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_share_settled_by_hand_is_never_asked_for_consent_after_a_split_change(int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = await R16Kit.GameAsync(pg, $"r16b-sett{partners}", partners, accept: false);
        var seat = g.SeatOf[g.Club.Sam];
        (await g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players/{seat}/accept", new { reason = "Playing" })).EnsureSuccessStatusCode();
        (await g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players/{seat}/settle-outside", new { reason = "Cash" })).EnsureSuccessStatusCode();

        // Olive moves the split so Sam's share goes UP — past anything Sam said yes to (nothing).
        var split = await g.As(g.Club.Organiser).PutAsJsonAsync($"/api/v1/bookings/{g.BookingId}/split",
            new { mode = "amount", seats = new object[] { new { participantId = seat, amount = 20 } } });
        split.EnsureSuccessStatusCode();
        var answered = (await R16Kit.BodyAsync(split)).GetProperty("shares").EnumerateArray().Single(s => s.GetProperty("participant_id").GetGuid() == seat);
        Assert.False(answered.GetProperty("needs_consent").GetBoolean());

        var row = await R16Kit.SeatRowAsync(g, g.As(g.Club.Sam), seat);
        Assert.False(row.GetProperty("needs_consent").GetBoolean());
        var invite = await g.As(g.Club.Sam).GetFromJsonAsync<JsonElement>($"/api/v1/me/invites/{seat}");
        Assert.False(invite.GetProperty("needs_consent").GetBoolean());
        // Whoever asked is named: it was Olive, not the club.
        Assert.Equal("organiser", invite.GetProperty("share_changed_by").GetString());
        Assert.Equal("Olive Organiser", invite.GetProperty("share_changed_by_name").GetString());

        var line = (await R16Kit.InboxAsync(g, g.Club.Sam, MemberEventCatalogue.GameChanged)).Last();
        Assert.Equal($"Olive Organiser changed the split of {g.Where} — you paid Olive Organiser by hand, so nothing moves in the app", line.Headline);
    }

    [SkippableFact]
    public async Task A_share_an_add_lowered_was_changed_by_the_club_when_the_club_added()
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = await R16Kit.GameAsync(pg, "r16b-chby", 1);
        var seat = g.SeatOf[g.Club.Sam];
        Assert.Equal(JsonValueKind.Null, (await R16Kit.SeatRowAsync(g, g.As(g.Club.Sam), seat)).GetProperty("share_changed_by").ValueKind);
        (await g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players", new { userId = g.Club.Jo, reason = "Phoned in" })).EnsureSuccessStatusCode();

        var row = await R16Kit.SeatRowAsync(g, g.As(g.Club.Sam), seat);
        Assert.Equal("club", row.GetProperty("share_changed_by").GetString());
        Assert.Equal(JsonValueKind.Null, row.GetProperty("share_changed_by_name").ValueKind);
    }
}

/// <summary>
/// Review round 16, lane BE16b — what each side is told, on the inbox, in the mail, on the Night and in the CSV:
/// <list type="bullet">
/// <item>E16-4 / J16-4: withdrawal, no-show and club-removal share lines named no court and no day (and the
/// club removal's organiser line no cause); the Night's withdrawal rows bypassed the share sentence.</item>
/// <item>E16-5: the organiser's collect mail said "Sam paid their share" over a body saying the club collected it.</item>
/// <item>J16-6: settle-outside told nobody; a later cancel promised a settled partner their share "comes back".</item>
/// <item>J16-7: the club cancelling a started split sent the partners no frame — no toast.</item>
/// <item>E16-7 / J16-9: the CSV's <c>done_by</c> was blank for own acts and the system's sweeps.</item>
/// </list>
/// </summary>
public sealed class R16WordsHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    // ------------------------------------------------------------------ E16-4: withdrawal

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_withdrawal_names_the_court_and_day_and_its_Night_rows_say_who_withdrew_in_the_right_voice(int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = await R16Kit.GameAsync(pg, $"r16b-wd{partners}", partners);
        var paid = (await g.Club.SeatsAsync(g.App, g.BookingId)).Single(s => s.UserId == g.Club.Sam).ShareMinutes;
        (await g.As(g.Club.Sam).PostAsync($"/api/v1/bookings/{g.BookingId}/players/{g.SeatOf[g.Club.Sam]}/withdraw", null)).EnsureSuccessStatusCode();

        Assert.Equal($"{paid} minutes of your share of {g.Where} came back — you withdrew from the game",
            (await R16Kit.InboxAsync(g, g.Club.Sam, MemberEventCatalogue.ShareMoved)).Last().Headline);
        Assert.Equal($"{paid} minutes went back to Sam Partner for {g.Where} — they withdrew from the game",
            (await R16Kit.InboxAsync(g, g.Club.Organiser, MemberEventCatalogue.ShareMoved)).Last().Headline);

        Assert.Equal($"{paid} minutes of their share of Court 1 came back from Olive Organiser — they withdrew from the game",
            R16Kit.Headline(R16Kit.LastOwnShare(await R16Kit.NightAsync(g, g.Club.Sam))));
        Assert.Equal($"{paid} minutes went back to Sam Partner for their share of Court 1 — Sam Partner withdrew from the game",
            R16Kit.Headline(R16Kit.LastOwnShare(await R16Kit.NightAsync(g, g.Club.Organiser))));

        // E16-7: the CSV names who did each row — never blank.
        var csv = await R16Kit.CsvAsync(g, g.Club.Sam);
        Assert.All(csv, c => Assert.NotEqual("", c[6]));
        Assert.Equal(PlayersReportsYou, csv.Last(c => c[1] == "ShareTransfer")[6]);
        Assert.Equal("Automatic", csv.First(c => c[1] == "TopUp")[6]);   // the fixture's float, posted by nobody
        var olive = await R16Kit.CsvAsync(g, g.Club.Organiser);
        Assert.Equal("Sam Partner", olive.Last(c => c[1] == "ShareTransfer")[6]);
        Assert.Equal(WalletShareCauses.ShareReturned, olive.Last(c => c[1] == "ShareTransfer")[5]);
    }

    private const string PlayersReportsYou = "You";

    // ------------------------------------------------------------------ E16-4: the club's removal

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task The_clubs_removal_says_so_with_the_court_and_day_on_both_sides(int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = await R16Kit.GameAsync(pg, $"r16b-crm{partners}", partners);
        var paid = (await g.Club.SeatsAsync(g.App, g.BookingId)).Single(s => s.UserId == g.Club.Sam).ShareMinutes;
        (await g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players/{g.SeatOf[g.Club.Sam]}/remove", new { reason = "Double booked" }))
            .EnsureSuccessStatusCode();

        Assert.Equal($"{paid} minutes of your share came back — the club took you off {g.Where}",
            (await R16Kit.InboxAsync(g, g.Club.Sam, MemberEventCatalogue.ShareMoved)).Last().Headline);
        Assert.Equal($"{paid} minutes went back to Sam Partner — the club took them off {g.Where}",
            (await R16Kit.InboxAsync(g, g.Club.Organiser, MemberEventCatalogue.ShareMoved)).Last().Headline);
    }

    // ------------------------------------------------------------------ E16-5

    [SkippableFact]
    public async Task The_organisers_collect_mail_says_the_club_collected_it()
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = await R16Kit.GameAsync(pg, "r16b-colm", 1, accept: false);
        var seat = g.SeatOf[g.Club.Sam];
        (await g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players/{seat}/accept", new { reason = "Playing" })).EnsureSuccessStatusCode();
        await R16Kit.DeliverAsync(g.App);
        g.Mail.Sent.Clear();
        (await g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players/{seat}/collect", new { reason = "Bar tab" })).EnsureSuccessStatusCode();
        await R16Kit.DeliverAsync(g.App);

        var olive = Assert.Single(R16Kit.MailTo(g, "olive.organiser"));
        Assert.Equal("The club collected Sam Partner's share — Court 1", olive.Subject);
        Assert.Contains("The club collected", R16Kit.Flat(olive), StringComparison.Ordinal);
        Assert.DoesNotContain("paid their share", olive.Subject, StringComparison.Ordinal);
    }

    // ------------------------------------------------------------------ J16-6

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task Settle_outside_tells_both_players_and_a_later_cancel_never_promises_the_share_back(int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = await R16Kit.GameAsync(pg, $"r16b-so{partners}", partners, accept: false);
        var seat = g.SeatOf[g.Club.Sam];
        (await g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players/{seat}/accept", new { reason = "Playing" })).EnsureSuccessStatusCode();
        await R16Kit.DeliverAsync(g.App);
        g.Mail.Sent.Clear();
        (await g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players/{seat}/settle-outside", new { reason = "Cash" })).EnsureSuccessStatusCode();
        await R16Kit.DeliverAsync(g.App);

        Assert.Contains(await R16Kit.InboxAsync(g, g.Club.Sam),
            n => n.Headline == $"The club recorded that you paid Olive Organiser by hand for {g.Where} — nothing moves in the app");
        Assert.Contains(await R16Kit.InboxAsync(g, g.Club.Organiser),
            n => n.Headline == $"The club recorded that Sam Partner paid you by hand for {g.Where}");
        Assert.Equal("Your share is recorded as paid by hand — Court 1", Assert.Single(R16Kit.MailTo(g, "sam.partner")).Subject);
        Assert.Empty(R16Kit.MailTo(g, "olive.organiser"));

        g.Mail.Sent.Clear();
        (await g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/cancel", new { reason = "Court resurfacing" })).EnsureSuccessStatusCode();
        await R16Kit.DeliverAsync(g.App);
        var line = Assert.Single(await R16Kit.InboxAsync(g, g.Club.Sam, MemberEventCatalogue.GameCancelled));
        Assert.Equal($"The club cancelled {g.Where} — you paid Olive Organiser by hand, so that is between you and Olive Organiser", line.Headline);
        var mail = Assert.Single(R16Kit.MailTo(g, "sam.partner"), m => m.Subject.StartsWith("Game cancelled", StringComparison.Ordinal));
        Assert.DoesNotContain("comes back", R16Kit.Flat(mail), StringComparison.Ordinal);
        Assert.Contains("You paid Olive Organiser by hand for this game", R16Kit.Flat(mail), StringComparison.Ordinal);
        if (partners == 2)
        {
            // The partner who paid in the app keeps the ordinary words.
            Assert.DoesNotContain("by hand", Assert.Single(await R16Kit.InboxAsync(g, g.Club.Alex, MemberEventCatalogue.GameCancelled)).Headline, StringComparison.Ordinal);
        }
    }

    // ------------------------------------------------------------------ J16-7

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task The_club_cancelling_a_started_split_tells_each_partners_wallet_their_share_stands(int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = await R16Kit.GameAsync(pg, $"r16b-stf{partners}", partners);
        await g.Club.WriteAsync(g.App, db =>
        {
            var b = db.Bookings.IgnoreQueryFilters().First(x => x.Id == g.BookingId);
            b.StartsAt = DateTimeOffset.UtcNow.AddMinutes(-5).Storable();
            b.EndsAt = b.StartsAt.AddMinutes(32);
            b.CheckedInAt = b.StartsAt.AddMinutes(1);
            b.LightsOnCuedAt = b.CheckedInAt;
        });
        var bus = g.App.Services.GetRequiredService<Crusaders.Mainframe.Api.Services.Realtime.IRealtimeBus>();
        var wallets = new[] { g.Club.Sam, g.Club.Alex }.Take(partners)
            .ToDictionary(u => u, u => bus.Subscribe(Crusaders.Mainframe.Api.Services.Realtime.RealtimeTopic.Wallet(g.Club.TenantId, u)));

        (await g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/cancel", new { reason = "Flooded court" })).EnsureSuccessStatusCode();

        foreach (var (partner, channel) in wallets)
        {
            var frames = new List<JsonElement>();
            for (var i = 0; i < 40 && frames.Count == 0; i++)
            {
                while (channel.Reader.TryRead(out var m))
                {
                    if (m.Event == LedgerService.BalanceEvent) frames.Add(JsonDocument.Parse(m.JsonPayload).RootElement.Clone());
                }
                if (frames.Count == 0) await Task.Delay(50);
            }
            var frame = Assert.Single(frames);
            Assert.Equal(ShareSweep.CancelledShareStandsReason, frame.GetProperty("reason").GetString());
            Assert.Equal(0, frame.GetProperty("delta_minutes").GetInt32());
            Assert.Equal("club", frame.GetProperty("cancelled_by").GetString());
            Assert.Equal("Court 1", frame.GetProperty("court_name").GetString());
            Assert.Equal(JsonValueKind.String, frame.GetProperty("booking_starts_at").ValueKind);
        }
    }
}

/// <summary>
/// Review round 16, lane BE16b — the Night's voice, badges and the partner picker:
/// <list type="bullet">
/// <item>E16-6: "Checked in at Court 1" on the booker's Night when somebody else scanned; the scanning
/// partner's own reversal row spoke of them in the third person.</item>
/// <item>E16-9: "First court" and "Night owl" stood on a session the club cancelled half way. Badges are
/// never taken back (play.md §3.3), so they are awarded when a session ENDS, and never for a cancelled one.</item>
/// <item>J16-3: two members of one name could not be told apart in the member's partner picker.</item>
/// </list>
/// </summary>
public sealed class R16NightBadgesPickerHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    // ------------------------------------------------------------------ E16-6

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_check_in_by_somebody_else_is_named_and_the_scanners_own_reversal_is_in_their_voice(int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var start = DateTimeOffset.UtcNow.AddMinutes(-10).Storable();
        var app = CapturingMail.On(pg.SharedHost, new CapturingMail());
        var club = await PlayersClub.SeedAsync(app, $"r16b-voice{partners}");
        var who = new[] { club.Sam, club.Alex }.Take(partners).ToArray();
        foreach (var p in who) await club.CreditAsync(app, p, 50);
        await club.CreditAsync(app, club.Organiser, 32);
        var bookingId = await club.InsertBookingAsync(app, start);
        (await club.Client(app, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players",
            new { players = who.Select(p => (object)new { userId = p }).ToArray() })).EnsureSuccessStatusCode();
        foreach (var seat in (await club.SeatsAsync(app, bookingId)).Where(s => s.Seat > 1))
        {
            (await club.Client(app, seat.UserId!.Value).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat.Id}/accept",
                new { expectedShareMinutes = seat.ShareMinutes })).EnsureSuccessStatusCode();
        }
        await new Crusaders.Mainframe.Api.Webhooks.NoShowWorker(app.Services, app.Services.GetRequiredService<Crusaders.Mainframe.Api.Webhooks.IEventBus>(),
            Microsoft.Extensions.Logging.Abstractions.NullLogger<Crusaders.Mainframe.Api.Webhooks.NoShowWorker>.Instance).TickAsync(DateTimeOffset.UtcNow, default);
        await club.InClubAsync(app, async sp =>
        {
            var row = await sp.GetRequiredService<MainframeDbContext>().Bookings.FirstAsync(b => b.Id == bookingId);
            return await sp.GetRequiredService<BookingService>().ReverseNoShowAsync(
                row, start.AddMinutes(2).Storable(), Guid.Empty, default, scan: new ReversalScan(club.Sam, "member_code"));
        });

        var night = new R16Kit.Game(club, app, new CapturingMail(), bookingId, start, []);
        var olive = await R16Kit.NightAsync(night, club.Organiser);
        Assert.Equal("Sam Partner checked in at Court 1", R16Kit.Headline(Assert.Single(olive, e => R16Kit.Kind(e) == TraceKinds.CourtCheckedIn)));

        var sam = await R16Kit.NightAsync(night, club.Sam);
        Assert.Equal("Checked in at Court 1 for Olive Organiser's booking", R16Kit.Headline(Assert.Single(sam, e => R16Kit.Kind(e) == TraceKinds.CourtCheckedIn)));
        Assert.Equal("Their check-in reached the club late — the no-show on Olive Organiser's game on Court 1 was reversed",
            R16Kit.Headline(Assert.Single(sam, e => R16Kit.Kind(e) == TraceKinds.BookingNoShowReversed)));
    }

    // ------------------------------------------------------------------ E16-9

    private static Task<List<MemberBadge>> BadgesAsync(WebApplicationFactory<Program> f, Guid user) =>
        PlayersClub.ReadAsync(f, db => db.MemberBadges.IgnoreQueryFilters().Where(b => b.UserId == user).ToListAsync());

    [SkippableTheory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task A_session_earns_its_badges_when_it_ends_and_never_if_the_club_cancelled_it(bool cancelled)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var app = CapturingMail.On(pg.SharedHost, new CapturingMail());
        var club = await PlayersClub.SeedAsync(app, $"r16b-badge{(cancelled ? "c" : "e")}");
        var start = DateTimeOffset.UtcNow.AddMinutes(-5).Storable();
        var bookingId = await club.InsertBookingAsync(app, start);
        await club.InsertSeatAsync(app, bookingId, 1, club.Organiser, ParticipantStatus.Accepted, 16);
        await club.InsertSeatAsync(app, bookingId, 2, club.Sam, ParticipantStatus.Accepted, 16);
        await club.WriteAsync(app, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == bookingId).CheckedInAt = start.AddMinutes(1));

        async Task EvaluateAsync(DateTimeOffset at)
        {
            foreach (var u in new[] { club.Organiser, club.Sam })
            {
                await club.InClubAsync(app, sp => sp.GetRequiredService<PlayEvaluator>().EvaluateAsync(u, at, default));
            }
        }

        await EvaluateAsync(DateTimeOffset.UtcNow);   // on court: nothing yet
        Assert.Empty(await BadgesAsync(app, club.Organiser));
        Assert.Empty(await BadgesAsync(app, club.Sam));

        if (cancelled)
        {
            (await club.Client(app, club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/bookings/{bookingId}/cancel", new { reason = "Flooded court" }))
                .EnsureSuccessStatusCode();
        }
        await EvaluateAsync(start.AddMinutes(40));   // after its end
        foreach (var u in new[] { club.Organiser, club.Sam })
        {
            var badges = await BadgesAsync(app, u);
            if (cancelled) Assert.Empty(badges);
            else Assert.Equal(start.AddMinutes(1), Assert.Single(badges, b => b.BadgeKey == BadgeCatalogue.FirstSession).AwardedAt);
        }
    }

    // ------------------------------------------------------------------ J16-3

    [SkippableFact]
    public async Task The_partner_picker_tells_namesakes_apart_without_publishing_anything_private()
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var app = CapturingMail.On(pg.SharedHost, new CapturingMail());
        var club = await PlayersClub.SeedAsync(app, "r16b-dir");
        // Sam played twice with Alex (once as a partner on Olive's game, once on Alex's own) and never with Jo.
        var first = DateTimeOffset.UtcNow.AddDays(-9).Storable();
        var second = DateTimeOffset.UtcNow.AddDays(-2).Storable();
        var g1 = await club.InsertBookingAsync(app, first);
        await club.InsertSeatAsync(app, g1, 1, club.Organiser, ParticipantStatus.Accepted, 10);
        await club.InsertSeatAsync(app, g1, 2, club.Sam, ParticipantStatus.Accepted, 11);
        await club.InsertSeatAsync(app, g1, 3, club.Alex, ParticipantStatus.Accepted, 11);
        var g2 = await club.InsertBookingAsync(app, second, organiser: club.Alex);
        await club.InsertSeatAsync(app, g2, 1, club.Alex, ParticipantStatus.Accepted, 16);
        await club.InsertSeatAsync(app, g2, 2, club.Sam, ParticipantStatus.Accepted, 16);
        await club.WriteAsync(app, db =>
        {
            foreach (var b in db.Bookings.IgnoreQueryFilters().Where(b => b.Id == g1 || b.Id == g2)) b.CheckedInAt = b.StartsAt.AddMinutes(1);
            foreach (var u in new[] { club.Alex, club.Jo })
            {
                db.UserPreferences.Add(new UserPreferences { TenantId = club.TenantId, UserId = u, Findable = true });
            }
        });

        var sam = club.Client(app, club.Sam);
        var body = await sam.GetFromJsonAsync<JsonElement>("/api/v1/members/directory?q=Partner");
        var items = body.GetProperty("items").EnumerateArray().ToList();
        var alex = items.Single(i => i.GetProperty("user_id").GetGuid() == club.Alex);
        var jo = items.Single(i => i.GetProperty("user_id").GetGuid() == club.Jo);
        Assert.Equal(2, alex.GetProperty("played_with_you").GetInt32());
        Assert.Equal(second, alex.GetProperty("last_played_with_you_at").GetDateTimeOffset());
        Assert.Equal(0, jo.GetProperty("played_with_you").GetInt32());
        Assert.Equal(JsonValueKind.Null, jo.GetProperty("last_played_with_you_at").ValueKind);
        Assert.Matches(@"^\d{4}-\d{2}-\d{2}$", jo.GetProperty("member_since").GetString()!);
        foreach (var item in items)
        {
            var keys = item.EnumerateObject().Select(p => p.Name).ToHashSet();
            Assert.Equal(["user_id", "name", "photo_url", "played_with_you", "last_played_with_you_at", "member_since", "member_ref"], keys);
        }
        Assert.DoesNotContain("review.test", body.GetRawText(), StringComparison.Ordinal);

        (await sam.PutAsync($"/api/v1/me/partners/favourites/{club.Jo}", null)).EnsureSuccessStatusCode();
        var favourite = Assert.Single((await sam.GetFromJsonAsync<JsonElement>("/api/v1/me/partners/favourites")).GetProperty("items").EnumerateArray());
        Assert.Equal(0, favourite.GetProperty("played_with_you").GetInt32());
        var recent = Assert.Single((await sam.GetFromJsonAsync<JsonElement>("/api/v1/me/partners/recent")).GetProperty("items").EnumerateArray(),
            r => r.GetProperty("user_id").GetGuid() == club.Alex);
        Assert.Equal(2, recent.GetProperty("played_with_you").GetInt32());
    }
}

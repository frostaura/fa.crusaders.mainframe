using System.Data.Common;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 18, lane BE18b — bookings, the court box and the Night, over HTTP against Postgres.
///
/// <list type="bullet">
/// <item>J18-8: a member's cancel of their OWN booking that is not open says why (409), as the desk's does.</item>
/// <item>E18-3: a restore after a power cut reads "Court 1 lights came back on after a power cut" on the
/// organiser's Night and each player's, and in the CSV — never "no word for (court.lights_restored)".</item>
/// <item>E18-4: every check-in row's subject is the booking's organiser.</item>
/// <item>E18-6: a pay-for payer's scan stamps the payer's seat, never the organiser's; the organiser's own
/// later scan is on the record once.</item>
/// <item>E18-7: the lights-on row prints at the scan on every Night.</item>
/// <item>E18-8: the member's own late check-in reads in their voice; an accepted upload names its member.</item>
/// <item>J18-2 (global net): a unique violation no route answered is 503 <c>conflict_retry</c>, never 500.</item>
/// <item>D18-5: a device body naming two boards is refused.</item>
/// </list>
/// </summary>
public sealed class R18BookingNightHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private sealed record Rig(MemberCodeClub Club, WebApplicationFactory<Program> App, UniqueViolationOn Strike) : IAsyncDisposable
    {
        public ValueTask DisposeAsync() => App.DisposeAsync();
    }

    private async Task<Rig> RigAsync(string prefix)
    {
        var strike = new UniqueViolationOn();
        var app = MemberCodeClub.Wired(pg.SharedHost, new StubEmailService()).WithWebHostBuilder(b => b.ConfigureServices(s =>
            s.ConfigureDbContext<MainframeDbContext>(o => o.AddInterceptors(strike))));
        return new Rig(await MemberCodeClub.SeedAsync(app, prefix), app, strike);
    }

    // ---- helpers --------------------------------------------------------------------------------------

    /// <summary>Accepted seats for <paramref name="players"/> (seat 1 the organiser), no shares; declined seats for <paramref name="declined"/>.</summary>
    private static Task SeatAsync(Rig r, Guid bookingId, IReadOnlyList<Guid> players, params Guid[] declined)
    {
        return r.Club.WriteAsync(r.App, db =>
        {
            var now = DateTimeOffset.UtcNow;
            var all = players.Select(p => (p, ParticipantStatus.Accepted)).Concat(declined.Select(d => (d, ParticipantStatus.Declined))).ToList();
            for (var i = 0; i < all.Count; i++)
            {
                db.BookingParticipants.Add(new BookingParticipant
                {
                    TenantId = r.Club.TenantId,
                    BookingId = bookingId,
                    Seat = i + 1,
                    UserId = all[i].Item1,
                    Status = all[i].Item2,
                    ShareMinutes = 0,
                    ConsentedMinutes = 0,
                    ShareWeight = 1,
                    SplitMode = i == 0 ? SplitModes.Equal : null,
                    InvitedAt = now,
                    CreatedAt = now,
                    UpdatedAt = now,
                    RespondedAt = now,
                });
            }
            return Task.CompletedTask;
        });
    }

    private static async Task<Guid> MemberAsync(Rig r, string handle, string name)
    {
        var c = r.Club;
        var user = new User
        {
            TenantId = c.TenantId,
            Email = $"{handle}-{c.Slug}@test.local",
            PasswordHash = new Pbkdf2PasswordHasher().Hash("OldPass!123"),
            EmailVerified = true,
        };
        var used = c.Refs.Values.ToHashSet();
        var reference = Enumerable.Range(0, 64).Select(_ => Random.Shared.Next(1, MemberCodeMath.MaxRefValue)).First(x => !used.Contains(x));
        await c.WriteAsync(r.App, db =>
        {
            db.Users.Add(user);
            db.Memberships.Add(new Membership
            {
                TenantId = c.TenantId,
                UserId = user.Id,
                FullName = name,
                MembershipNumber = $"{handle}-{c.Slug}",
                Status = MembershipStatus.Active,
            });
            db.MemberCodes.Add(new MemberCode { TenantId = c.TenantId, UserId = user.Id, Ref = reference });
            return Task.CompletedTask;
        });
        c.Refs[user.Id] = reference;
        return user.Id;
    }

    private static HttpClient Admin(Rig r) => r.Club.Member(r.App, r.Club.AdminId, "admin");

    private static async Task<List<JsonElement>> NightAsync(Rig r, Guid user)
    {
        var body = await Admin(r).GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{user}/trace");
        return [.. body.GetProperty("events").EnumerateArray()];
    }

    private static string Kind(JsonElement e) => e.GetProperty("kind").GetString()!;

    private static string Headline(JsonElement e) => e.GetProperty("headline").GetString()!;

    private static Guid? SubjectId(JsonElement e) =>
        e.GetProperty("subject").ValueKind == JsonValueKind.Object ? e.GetProperty("subject").GetProperty("user_id").GetGuid() : null;

    private static Task<List<AuditLog>> AuditsAsync(Rig r, string action) =>
        r.Club.ReadAsync(r.App, db => db.AuditLogs.IgnoreQueryFilters().AsNoTracking()
            .Where(a => a.TenantId == r.Club.TenantId && a.Action == action).ToListAsync());

    private static Task<List<BookingParticipant>> SeatsAsync(Rig r, Guid bookingId) =>
        r.Club.ReadAsync(r.App, db => db.BookingParticipants.IgnoreQueryFilters().AsNoTracking()
            .Where(p => p.BookingId == bookingId).OrderBy(p => p.Seat).ToListAsync());

    private static Task SetStatusAsync(Rig r, Guid bookingId, BookingStatus status) =>
        r.Club.WriteAsync(r.App, async db => (await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.Id == bookingId)).Status = status);

    private static async Task<HttpResponseMessage> SendAsync(Rig r, HttpRequestMessage req) => await r.App.CreateClient().SendAsync(req);

    private static async Task<JsonElement> OkJsonAsync(HttpResponseMessage response)
    {
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"{(int)response.StatusCode}: {await response.Content.ReadAsStringAsync()}");
        return await MemberCodeClub.JsonAsync(response);
    }

    // ---- J18-8: a member's own not-open booking ------------------------------------------------------

    [SkippableTheory]
    [InlineData(BookingStatus.Cancelled, "booking_not_open", null)]
    [InlineData(BookingStatus.NoShow, "not_cancellable", "no_show")]
    [InlineData(BookingStatus.Completed, "not_cancellable", "completed")]
    public async Task A_members_cancel_of_their_own_booking_that_is_not_open_says_why(BookingStatus status, string error, string? word)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync($"r18bc{(int)status}");
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: 120);
        await SetStatusAsync(r, booking.Id, status);
        var before = await c.BalanceAsync(r.App, c.Olga);

        var answer = await c.Member(r.App, c.Olga).PostAsync($"/api/v1/bookings/{booking.Id}/cancel", null);

        Assert.Equal(HttpStatusCode.Conflict, answer.StatusCode);
        var body = await MemberCodeClub.JsonAsync(answer);
        Assert.Equal(error, body.GetProperty("error").GetString());
        if (word is not null) Assert.Equal(word, body.GetProperty("status").GetString());
        Assert.Equal(before, await c.BalanceAsync(r.App, c.Olga));

        // A stranger still learns nothing — not even that the id is real.
        var stranger = await c.Member(r.App, c.Pam).PostAsync($"/api/v1/bookings/{booking.Id}/cancel", null);
        Assert.Equal(HttpStatusCode.NotFound, stranger.StatusCode);
    }

    // ---- E18-3: the restore after a power cut on every player's Night ---------------------------------

    [SkippableTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task A_restore_after_a_power_cut_reads_in_words_on_the_organisers_and_players_nights(bool partnered)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync(partnered ? "r18brs2" : "r18brs1");
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: -10, minutes: 60, checkedIn: true);
        await c.WriteAsync(r.App, async db => (await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.Id == booking.Id)).LightsOnCuedAt = booking.StartsAt);
        var declined = await MemberAsync(r, "dee", "Dee Declined");
        if (partnered) await SeatAsync(r, booking.Id, [c.Olga, c.Pam], declined);

        // The box comes back from a power cut (a fresh uptime), is told what to restore, and confirms it.
        var offered = await OkJsonAsync(await SendAsync(r, Beat(c, new JsonObject { ["uptime_ms"] = 30_000 })));
        Assert.Single(offered.GetProperty("relays").EnumerateArray());
        await OkJsonAsync(await SendAsync(r, Beat(c, new JsonObject { ["uptime_ms"] = 31_000, ["restored_relays"] = 1 })));
        Assert.NotEmpty(await AuditsAsync(r, CourtLightStateService.LightsRestoredAction));

        const string sentence = "Court 1 lights came back on after a power cut";
        var players = partnered ? new[] { c.Olga, c.Pam } : [c.Olga];
        foreach (var player in players)
        {
            var night = await NightAsync(r, player);
            Assert.DoesNotContain(night, e => Kind(e) == TraceKinds.Unrecognised);
            var restored = Assert.Single(night, e => Kind(e) == TraceKinds.LightsRestored);
            Assert.Equal(sentence, Headline(restored));
            Assert.Equal(TraceKinds.LightsStrand, restored.GetProperty("strand").GetString());
        }
        // Somebody who said no was not in the session.
        Assert.DoesNotContain(await NightAsync(r, declined), e => Kind(e) == TraceKinds.LightsRestored);

        var csv = await Admin(r).GetStringAsync($"/api/v1/admin/members/{c.Olga}/trace.csv");
        Assert.Contains($"{TraceKinds.LightsRestored},{sentence}", csv, StringComparison.Ordinal);
        Assert.DoesNotContain("no word for", csv, StringComparison.Ordinal);
    }

    private static HttpRequestMessage Beat(MemberCodeClub c, JsonObject body)
    {
        body["mac"] = c.BoxMac;
        body["firmware_version"] = "2.2.8";
        body["caps"] = new JsonArray("codes:m1");
        return c.Device("/api/v1/device/heartbeat", body);
    }

    // ---- E18-4: one subject rule for check-in rows -----------------------------------------------------

    [SkippableFact]
    public async Task Every_check_in_rows_subject_is_the_bookings_organiser_on_every_night()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync("r18bsub");
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: 2);
        var third = await MemberAsync(r, "tia", "Tia Third");
        await SeatAsync(r, booking.Id, [c.Olga, c.Pam, third]);

        // Pam lights it (court.activated, subject Olga); Tia and Olga arrive after (seat rows).
        foreach (var who in new[] { c.Pam, third, c.Olga })
        {
            Assert.True((await OkJsonAsync(await SendAsync(r, c.Activate(c.Code(who))))).GetProperty("activated").GetBoolean());
        }

        foreach (var night in new[] { c.Olga, c.Pam, third })
        {
            var checkIns = (await NightAsync(r, night)).Where(e => Kind(e) == TraceKinds.CourtCheckedIn).ToList();
            Assert.NotEmpty(checkIns);
            Assert.All(checkIns, e => Assert.Equal(c.Olga, SubjectId(e)));
        }
        Assert.Equal(3, (await NightAsync(r, c.Olga)).Count(e => Kind(e) == TraceKinds.CourtCheckedIn));
    }

    // ---- E18-6: pay-for attendance -------------------------------------------------------------------

    private const string Nonce = "7e1b3d5f9a2c4e6b";

    [SkippableFact]
    public async Task The_organisers_own_scan_after_a_pay_for_is_on_the_record_once()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync("r18bpf1");
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -5);   // solo, not yet lit
        var payer = c.Code(c.Pam);
        await OkJsonAsync(await SendAsync(r, c.PayFor(payer, 2, Nonce, confirm: false)));
        var paid = await OkJsonAsync(await SendAsync(r, c.PayFor(payer, 2, Nonce, confirm: true, label: "60")));
        Assert.True(paid.GetProperty("granted_seconds").GetInt32() > 0, "the pay-for should have lit the court");
        Assert.Empty(await AuditsAsync(r, SeatCheckIn.Action));

        // Olga arrives and scans: activated (a repeat of a live session), and now on the record.
        Assert.True((await OkJsonAsync(await SendAsync(r, c.Activate(c.Code(c.Olga))))).GetProperty("activated").GetBoolean());
        Assert.True((await OkJsonAsync(await SendAsync(r, c.Activate(c.Code(c.Olga, stepOffset: 1))))).GetProperty("activated").GetBoolean());

        var row = Assert.Single(await AuditsAsync(r, SeatCheckIn.Action));
        Assert.Equal(c.Olga, row.ActorUserId);
        Assert.Equal(c.Olga, row.SubjectUserId);
        var details = JsonDocument.Parse(row.DetailsJson!).RootElement;
        Assert.Equal(booking.Id, details.GetProperty("booking_id").GetGuid());
        Assert.Equal(JsonValueKind.Null, details.GetProperty("participant_id").ValueKind);
        Assert.False(details.GetProperty("lit_court").GetBoolean());

        var night = await NightAsync(r, c.Olga);
        Assert.Contains(night, e => Kind(e) == TraceKinds.CourtCheckedIn && Headline(e) == "Checked in at Court 2");
        Assert.Contains(night, e => Kind(e) == TraceKinds.CourtCheckedIn && Headline(e) == "Pam Payer checked in at Court 2");
    }

    [SkippableFact]
    public async Task A_payer_holding_a_seat_checks_in_their_own_seat_never_the_organisers()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync("r18bpf2");
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -5);
        await SeatAsync(r, booking.Id, [c.Olga, c.Pam]);
        var payer = c.Code(c.Pam);
        await OkJsonAsync(await SendAsync(r, c.PayFor(payer, 2, Nonce, confirm: false)));
        await OkJsonAsync(await SendAsync(r, c.PayFor(payer, 2, Nonce, confirm: true, label: "60")));

        var seats = await SeatsAsync(r, booking.Id);
        Assert.Null(seats.Single(s => s.UserId == c.Olga).CheckedInAt);
        Assert.NotNull(seats.Single(s => s.UserId == c.Pam).CheckedInAt);

        Assert.True((await OkJsonAsync(await SendAsync(r, c.Activate(c.Code(c.Olga))))).GetProperty("activated").GetBoolean());
        Assert.NotNull((await SeatsAsync(r, booking.Id)).Single(s => s.UserId == c.Olga).CheckedInAt);
        var rows = await AuditsAsync(r, SeatCheckIn.Action);
        Assert.Equal(new[] { c.Olga, c.Pam }.Order(), rows.Select(a => a.SubjectUserId!.Value).Order());
    }

    // ---- E18-7 / E18-8: a late upload that reverses a no-show ------------------------------------------

    [SkippableFact]
    public async Task A_partners_late_upload_lights_the_court_at_the_scan_on_every_night()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync("r18blit");
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: -20);
        await SeatAsync(r, booking.Id, [c.Olga, c.Pam]);
        await SetStatusAsync(r, booking.Id, BookingStatus.NoShow);
        var scannedAt = DateTimeOffset.UtcNow.AddMinutes(-10);

        await OkJsonAsync(await SendAsync(r, c.Events(c.BoxMac, 1, "activation", 0, c.Code(c.Pam, scannedAt), agoMs: 600_000)));

        var organisers = Assert.Single(await NightAsync(r, c.Olga), e => Kind(e) == TraceKinds.LightsOn).GetProperty("at").GetDateTimeOffset();
        var partners = Assert.Single(await NightAsync(r, c.Pam), e => Kind(e) == TraceKinds.LightsOn).GetProperty("at").GetDateTimeOffset();
        Assert.True((organisers - partners).Duration() < TimeSpan.FromSeconds(1), $"organiser's {organisers:O} vs partner's {partners:O}");
        // At the scan (ten minutes before the upload), never at the upload — the server places the scan from
        // the event's own uptime, so a loaded host's request latency moves it a little later than scannedAt.
        Assert.True(partners >= scannedAt.AddSeconds(-1) && partners <= scannedAt.AddMinutes(1),
            $"the partner's lights row printed at {partners:O}, not at the scan {scannedAt:O}");
    }

    [SkippableFact]
    public async Task The_organisers_own_late_check_in_reads_in_their_voice_and_the_upload_names_them()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync("r18bown");
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: -20);
        await SetStatusAsync(r, booking.Id, BookingStatus.NoShow);

        await OkJsonAsync(await SendAsync(r, c.Events(c.BoxMac, 1, "activation", 0, c.Code(c.Olga))));

        var night = await NightAsync(r, c.Olga);
        Assert.Equal("Their check-in reached the club late — no-show reversed",
            Headline(Assert.Single(night, e => Kind(e) == TraceKinds.BookingNoShowReversed)));
        Assert.DoesNotContain(night, e => Kind(e) == TraceKinds.CourtRefused);

        // The device activity names the member on the upload's own rows (the event and its verdict).
        var rows = (await AuditsAsync(r, TraceKinds.ActivationAction)).Concat(await AuditsAsync(r, "device.activation_reversed_no_show")).ToList();
        Assert.Equal(2, rows.Count);
        Assert.All(rows, a => Assert.Equal(c.Olga, a.SubjectUserId));
        var box = await c.ReadAsync(r.App, db => db.Devices.IgnoreQueryFilters().SingleAsync(d => d.TenantId == c.TenantId && d.MacAddress == c.BoxMac));
        var activity = await Admin(r).GetFromJsonAsync<JsonElement>($"/api/v1/admin/devices/{box.Id}/activity");
        // The upload's two rows and the lights row it wrote — every one names Olga.
        var items = activity.GetProperty("items").EnumerateArray().ToList();
        Assert.True(items.Count >= 2, $"{items.Count} activity rows");
        Assert.All(items, i => Assert.Equal(JsonValueKind.Object, i.GetProperty("member").ValueKind));
    }

    // ---- J18-2 global net: an escaped unique violation ------------------------------------------------

    [SkippableFact]
    public async Task A_unique_violation_no_route_answered_is_503_conflict_retry_on_member_and_device_routes()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync("r18b505");
        var c = r.Club;
        await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: 2);

        r.Strike.Arm("INSERT INTO audit_log", times: 1);
        var member = await c.Member(r.App, c.Olga).PostAsJsonAsync("/api/v1/me/pin", new { pin = "4826" });
        await AssertConflictRetryAsync(member);

        r.Strike.Arm("INSERT INTO audit_log", times: 99);
        var device = await SendAsync(r, c.Activate(c.Code(c.Olga)));
        await AssertConflictRetryAsync(device);
        r.Strike.Arm("never", times: 0);
    }

    private static async Task AssertConflictRetryAsync(HttpResponseMessage response)
    {
        Assert.True(response.StatusCode == HttpStatusCode.ServiceUnavailable, $"{(int)response.StatusCode}: {await response.Content.ReadAsStringAsync()}");
        Assert.Equal("conflict_retry", (await MemberCodeClub.JsonAsync(response)).GetProperty("error").GetString());
        Assert.Equal("1", response.Headers.GetValues("Retry-After").Single());
    }

    /// <summary>Answers matching commands with PostgreSQL's unique violation instead of running them, while armed.</summary>
    private sealed class UniqueViolationOn : DbCommandInterceptor
    {
        private readonly Lock _gate = new();
        private string _marker = "\u0000never";
        private int _left;

        public void Arm(string marker, int times)
        {
            lock (_gate)
            {
                _marker = marker;
                _left = times;
            }
        }

        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
            DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
        {
            lock (_gate)
            {
                if (_left > 0 && command.CommandText.Contains(_marker, StringComparison.Ordinal))
                {
                    _left--;
                    throw new PostgresException("duplicate key value violates unique constraint", "ERROR", "ERROR", PostgresErrorCodes.UniqueViolation);
                }
            }
            return ValueTask.FromResult(result);
        }

        public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(
            DbCommand command, CommandEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            lock (_gate)
            {
                if (_left > 0 && command.CommandText.Contains(_marker, StringComparison.Ordinal))
                {
                    _left--;
                    throw new PostgresException("duplicate key value violates unique constraint", "ERROR", "ERROR", PostgresErrorCodes.UniqueViolation);
                }
            }
            return ValueTask.FromResult(result);
        }
    }

    // ---- D18-5: one body, one board --------------------------------------------------------------------

    [SkippableTheory]
    [InlineData("\"mac\":\"{A}\",\"firmware_version\":\"2.2.8\",\"mac\":\"{B}\"")]
    [InlineData("\"mac\":\"{A}\",\"firmware_version\":\"2.2.8\",\"MAC\":\"{B}\"")]
    [InlineData("\"mac\":\"{A}\",\"firmware_version\":\"2.2.8\",\"mac\":\"{A}\"")]
    public async Task A_device_body_naming_its_board_twice_is_refused(string fields)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync("r18bmac");
        var c = r.Club;
        var other = Guid.NewGuid().ToString("N")[..12];
        var json = "{" + fields.Replace("{A}", c.BoxMac, StringComparison.Ordinal).Replace("{B}", other, StringComparison.Ordinal) + ",\"uptime_ms\":86400000}";

        var answer = await SendAsync(r, Raw(c, json));

        Assert.Equal(HttpStatusCode.BadRequest, answer.StatusCode);
        Assert.Equal("malformed_body", (await MemberCodeClub.JsonAsync(answer)).GetProperty("error").GetString());
        Assert.False(await c.ReadAsync(r.App, db => db.Devices.IgnoreQueryFilters().AnyAsync(d => d.MacAddress == other)));

        // One board, named once, is answered as always.
        await OkJsonAsync(await SendAsync(r, Raw(c, $"{{\"mac\":\"{c.BoxMac}\",\"firmware_version\":\"2.2.8\",\"uptime_ms\":86400000}}")));
    }

    private static HttpRequestMessage Raw(MemberCodeClub c, string json)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/device/heartbeat")
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", c.DeviceKey);
        return req;
    }
}

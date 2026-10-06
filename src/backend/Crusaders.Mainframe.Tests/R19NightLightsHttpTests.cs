using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Webhooks;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 19, lane BE19 — the lights on the Night, over HTTP against Postgres.
///
/// <list type="bullet">
/// <item>E19-2: one instant per lighting on every Night — the box's upload of a scan the server answered
/// online does not move the organiser's "lights came on" to the box's clock, and the row keeps its
/// organiser; partners who played see the lights go off, at the organiser's instant; the
/// <c>booking.lights_on</c> webhook's <c>occurred_at</c> is the Night's instant.</item>
/// <item>E19-3 (wording): a pay-for payer's scan reads as paying for the court and lighting it — never
/// "checked in" — unless they hold an accepted seat on that booking.</item>
/// </list>
/// </summary>
public sealed class R19NightLightsHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private sealed record Rig(MemberCodeClub Club, WebApplicationFactory<Program> App, KeepingBus Bus) : IAsyncDisposable
    {
        public ValueTask DisposeAsync() => App.DisposeAsync();
    }

    private async Task<Rig> RigAsync(string prefix)
    {
        var bus = new KeepingBus();
        var app = MemberCodeClub.Wired(pg.SharedHost, new StubEmailService()).WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IEventBus>();
            s.AddSingleton<IEventBus>(bus);
        }));
        return new Rig(await MemberCodeClub.SeedAsync(app, prefix), app, bus);
    }

    /// <summary>Keeps every event the server emits and still hands them on.</summary>
    private sealed class KeepingBus : IEventBus
    {
        private readonly System.Threading.Channels.Channel<DomainEvent> _channel =
            System.Threading.Channels.Channel.CreateUnbounded<DomainEvent>();
        private readonly List<DomainEvent> _kept = [];

        public System.Threading.Channels.ChannelReader<DomainEvent> Reader => _channel.Reader;

        public List<DomainEvent> Kept
        {
            get { lock (_kept) return [.. _kept]; }
        }

        public async ValueTask EmitAsync(DomainEvent evt, CancellationToken ct = default)
        {
            lock (_kept) _kept.Add(evt);
            await _channel.Writer.WriteAsync(evt, ct);
        }
    }

    // ---- helpers --------------------------------------------------------------------------------------

    /// <summary>Accepted seats for <paramref name="players"/>, seat 1 the organiser.</summary>
    private static Task SeatAsync(Rig r, Guid bookingId, params Guid[] players)
    {
        return r.Club.WriteAsync(r.App, db =>
        {
            var now = DateTimeOffset.UtcNow;
            for (var i = 0; i < players.Length; i++)
            {
                db.BookingParticipants.Add(new BookingParticipant
                {
                    TenantId = r.Club.TenantId,
                    BookingId = bookingId,
                    Seat = i + 1,
                    UserId = players[i],
                    Status = ParticipantStatus.Accepted,
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

    private static async Task<List<JsonElement>> NightAsync(Rig r, Guid user)
    {
        var admin = r.Club.Member(r.App, r.Club.AdminId, "admin");
        var body = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{user}/trace");
        return [.. body.GetProperty("events").EnumerateArray()];
    }

    private static string Kind(JsonElement e) => e.GetProperty("kind").GetString()!;

    private static string Headline(JsonElement e) => e.GetProperty("headline").GetString()!;

    private static DateTimeOffset At(JsonElement e) => e.GetProperty("at").GetDateTimeOffset();

    private static Guid? SubjectId(JsonElement e) =>
        e.GetProperty("subject").ValueKind == JsonValueKind.Object ? e.GetProperty("subject").GetProperty("user_id").GetGuid() : null;

    private static Task<List<AuditLog>> AuditsAsync(Rig r, string action) =>
        r.Club.ReadAsync(r.App, db => db.AuditLogs.IgnoreQueryFilters().AsNoTracking()
            .Where(a => a.TenantId == r.Club.TenantId && a.Action == action).ToListAsync());

    private static async Task<JsonElement> OkJsonAsync(HttpResponseMessage response)
    {
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"{(int)response.StatusCode}: {await response.Content.ReadAsStringAsync()}");
        return await MemberCodeClub.JsonAsync(response);
    }

    private static async Task<HttpResponseMessage> SendAsync(Rig r, HttpRequestMessage req) => await r.App.CreateClient().SendAsync(req);

    private static void SameInstant(DateTimeOffset expected, DateTimeOffset actual, string what) =>
        Assert.True((expected - actual).Duration() < TimeSpan.FromMilliseconds(1), $"{what}: {actual:O}, expected {expected:O}");

    // ---- E19-2: one instant per lighting ------------------------------------------------------------

    /// <summary>
    /// A court lit online, then the box's queue uploads the same scan with its own clock a little behind:
    /// the organiser's Night keeps ONE "lights came on" at the server's instant, about the organiser, and the
    /// partner's reads the same instant. Lit by the organiser and by the partner.
    /// </summary>
    [SkippableTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task An_online_lighting_keeps_its_instant_and_organiser_after_the_box_uploads_it(bool partnerScans)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync(partnerScans ? "r19bup" : "r19buo");
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: -5);
        await SeatAsync(r, booking.Id, c.Olga, c.Pam);
        var scanner = partnerScans ? c.Pam : c.Olga;
        var code = c.Code(scanner);

        Assert.True((await OkJsonAsync(await SendAsync(r, c.Activate(code)))).GetProperty("activated").GetBoolean());
        var online = Assert.Single(await AuditsAsync(r, TraceKinds.LightsOnAction));
        var lit = online.ScanAt;

        // The box's queued copy, placed 400 ms before the server's instant by the box's own clock.
        var agoMs = (long)(DateTimeOffset.UtcNow - lit).TotalMilliseconds + 400;
        await OkJsonAsync(await SendAsync(r, c.Events(c.BoxMac, 1, "activation", 0, code, agoMs: agoMs)));

        var organisers = Assert.Single(await NightAsync(r, c.Olga), e => Kind(e) == TraceKinds.LightsOn);
        SameInstant(lit, At(organisers), "the organiser's lights row");
        Assert.Equal(c.Olga, SubjectId(organisers));
        var partners = Assert.Single(await NightAsync(r, c.Pam), e => Kind(e) == TraceKinds.LightsOn);
        SameInstant(lit, At(partners), "the partner's lights row");
    }

    /// <summary>
    /// A board-measured session (uploaded activation and release): the partner who played sees the lights
    /// go off, at the organiser's instant, and every lights row the box reported is about the organiser.
    /// </summary>
    [SkippableFact]
    public async Task A_partner_who_played_sees_the_lights_go_off_at_the_organisers_instant()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync("r19boff");
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: -20);
        await SeatAsync(r, booking.Id, c.Olga, c.Pam);
        var scannedAt = DateTimeOffset.UtcNow.AddMinutes(-15);

        await OkJsonAsync(await SendAsync(r, c.Events(c.BoxMac, 1, "activation", 0, c.Code(c.Olga, scannedAt), agoMs: 900_000)));
        await OkJsonAsync(await SendAsync(r, c.Events(c.BoxMac, 2, "release", 0, "", agoMs: 300_000)));

        var organisers = await NightAsync(r, c.Olga);
        var off = Assert.Single(organisers, e => Kind(e) == TraceKinds.LightsOff);
        var partnersOff = Assert.Single(await NightAsync(r, c.Pam), e => Kind(e) == TraceKinds.LightsOff);
        SameInstant(At(off), At(partnersOff), "the partner's lights-off row");
        Assert.All(organisers.Where(e => Kind(e) is TraceKinds.LightsOn or TraceKinds.LightsOff),
            e => Assert.Equal(c.Olga, SubjectId(e)));
    }

    /// <summary>
    /// The <c>booking.lights_on</c> webhook says the court came on when the Night says it did — for a member's
    /// scan, and for a pay-for at the box.
    /// </summary>
    [SkippableTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task The_lights_on_webhook_occurred_at_is_the_nights_instant(bool payFor)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync(payFor ? "r19bwhp" : "r19bwhs");
        var c = r.Club;
        await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -5);
        if (payFor)
        {
            var payer = c.Code(c.Pam);
            await OkJsonAsync(await SendAsync(r, c.PayFor(payer, 2, "7e1b3d5f9a2c4e6b", confirm: false)));
            await OkJsonAsync(await SendAsync(r, c.PayFor(payer, 2, "7e1b3d5f9a2c4e6b", confirm: true, label: "60")));
        }
        else
        {
            Assert.True((await OkJsonAsync(await SendAsync(r, c.Activate(c.Code(c.Olga))))).GetProperty("activated").GetBoolean());
        }

        var row = Assert.Single(await AuditsAsync(r, TraceKinds.LightsOnAction));
        var night = Assert.Single(await NightAsync(r, c.Olga), e => Kind(e) == TraceKinds.LightsOn);
        var hook = Assert.Single(r.Bus.Kept, e => e.Type == "booking.lights_on");
        SameInstant(At(night), hook.OccurredAt, "booking.lights_on occurred_at");
        SameInstant(row.ScanAt, hook.OccurredAt, "booking.lights_on vs the lights row");
        SameInstant(hook.OccurredAt, (DateTimeOffset)hook.Data["scanned_at"]!, "booking.lights_on scanned_at");
    }

    // ---- E19-3: a payer at the box paid and lit; they did not check in --------------------------------

    /// <summary>
    /// A member who pays for somebody else's court at the box and lights it reads as exactly that on both
    /// Nights — never "checked in" — and a payer who holds an accepted seat on the game still checks in.
    /// </summary>
    [SkippableTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task A_pay_for_payer_paid_for_and_lit_the_court_and_checked_in_only_with_a_seat(bool payerHoldsSeat)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync(payerHoldsSeat ? "r19bpfs" : "r19bpfn");
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -5);
        if (payerHoldsSeat) await SeatAsync(r, booking.Id, c.Olga, c.Pam);
        var payer = c.Code(c.Pam);
        await OkJsonAsync(await SendAsync(r, c.PayFor(payer, 2, "7e1b3d5f9a2c4e6b", confirm: false)));
        await OkJsonAsync(await SendAsync(r, c.PayFor(payer, 2, "7e1b3d5f9a2c4e6b", confirm: true, label: "60")));

        var organisers = (await NightAsync(r, c.Olga)).Where(e => Kind(e) == TraceKinds.CourtCheckedIn).Select(Headline).ToList();
        var payers = (await NightAsync(r, c.Pam)).Where(e => Kind(e) == TraceKinds.CourtCheckedIn).Select(Headline).ToList();
        if (payerHoldsSeat)
        {
            Assert.Contains("Pam Payer checked in at Court 2", organisers);
            Assert.DoesNotContain(organisers.Concat(payers), h => h.Contains("lit it", StringComparison.Ordinal));
            return;
        }

        Assert.Equal(["Pam Payer paid for Court 2 at the court box and lit it"], organisers);
        var own = Assert.Single(payers);
        Assert.StartsWith("Paid for Court 2 at the court box and lit it for ", own, StringComparison.Ordinal);
        Assert.DoesNotContain("checked in", own, StringComparison.OrdinalIgnoreCase);
    }
}

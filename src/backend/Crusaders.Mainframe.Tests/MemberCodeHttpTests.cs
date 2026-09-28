using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The single rotating member code over real HTTP against Postgres (<c>docs/specs/member-code.md</c>
/// §4, §8, §10): enrolment and status, rotation, every device path accepting a v1 token, the use
/// table and its classes, window edges, cross-tenant isolation of the new tables, and IDOR on the
/// admin reset. Pay-for, the heartbeat and the forgery path are in the sibling classes.
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class MemberCodeHttpTests(PostgresFixture pg)
{
    internal const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    // ---- Enrolment and status (§10) --------------------------------------------------------------

    [SkippableFact]
    public async Task Enrolment_hands_the_phone_the_secret_the_server_checks_codes_with_and_status_never_does()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        var mail = new StubEmailService();
        await using var app = MemberCodeClub.Wired(factory, mail);
        var club = await MemberCodeClub.SeedAsync(app, "enrol");
        var phone = club.Member(app, club.Olga);

        var enrol = await phone.PostAsync("/api/v1/me/code/enrol", null);
        Assert.Equal(HttpStatusCode.OK, enrol.StatusCode);
        Assert.Equal("no-store", enrol.Headers.CacheControl?.ToString());
        var body = await MemberCodeClub.JsonAsync(enrol);
        Assert.Equal(
            ["v", "ref", "generation", "secret", "tz", "step_seconds", "server_time_ms", "phase"],
            body.EnumerateObject().Select(p => p.Name));
        Assert.Equal(1, body.GetProperty("v").GetInt32());
        Assert.Equal(MemberCodeMath.RefText(club.Refs[club.Olga]), body.GetProperty("ref").GetString());
        Assert.Equal(1, body.GetProperty("generation").GetInt32());
        Assert.Equal("Africa/Johannesburg", body.GetProperty("tz").GetString());
        Assert.Equal(30, body.GetProperty("step_seconds").GetInt32());
        Assert.InRange(body.GetProperty("server_time_ms").GetInt64(), DateTimeOffset.UtcNow.AddMinutes(-1).ToUnixTimeMilliseconds(), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

        // The secret, 43 characters of base64url, computes a code the door accepts.
        var secretText = body.GetProperty("secret").GetString()!;
        Assert.Equal(43, secretText.Length);
        var secret = MemberCodeMath.FromBase64Url(secretText)!;
        var token = MemberCodeMath.Token(body.GetProperty("ref").GetString()!, secret, MemberCodeMath.StepOf(DateTimeOffset.UtcNow), MemberCodeMath.ZoneOf("Africa/Johannesburg"));
        var client = app.CreateClient();
        var gate = await MemberCodeClub.JsonAsync(await client.SendAsync(club.Gate(token)));
        Assert.True(gate.GetProperty("opened").GetBoolean());

        var status = await phone.GetAsync("/api/v1/me/code");
        Assert.Equal("no-store", status.Headers.CacheControl?.ToString());
        var s = await MemberCodeClub.JsonAsync(status);
        Assert.Equal(["v", "ref", "generation", "tz", "server_time_ms", "phase"], s.EnumerateObject().Select(p => p.Name));
        Assert.DoesNotContain(secretText, await status.Content.ReadAsStringAsync());

        var audit = await club.ReadAsync(app, db => db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId && a.Action == MemberCodeService.EnrolledAction).ToListAsync());
        Assert.Equal(club.Olga, Assert.Single(audit).SubjectUserId);
        Assert.DoesNotContain(secretText, audit[0].DetailsJson ?? "");
    }

    [SkippableFact]
    public async Task A_barred_member_is_refused_a_secret_and_a_status_with_403()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "enrolbar");
        await club.WriteAsync(app, async db =>
            (await db.Memberships.IgnoreQueryFilters().FirstAsync(m => m.Id == club.SidMembership)).Status = MembershipStatus.Suspended);

        var phone = club.Member(app, club.Sid);
        var response = await phone.PostAsync("/api/v1/me/code/enrol", null);
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal("member_suspended", (await MemberCodeClub.JsonAsync(response)).GetProperty("error").GetString());
        Assert.DoesNotContain("secret", await response.Content.ReadAsStringAsync());

        var status = await phone.GetAsync("/api/v1/me/code");
        Assert.Equal(HttpStatusCode.Forbidden, status.StatusCode);
        Assert.Equal("member_suspended", (await MemberCodeClub.JsonAsync(status)).GetProperty("error").GetString());

        await club.WriteAsync(app, async db =>
            (await db.Memberships.IgnoreQueryFilters().FirstAsync(m => m.Id == club.SidMembership)).Status = MembershipStatus.PendingApproval);
        Assert.Equal("member_not_active", (await MemberCodeClub.JsonAsync(await phone.GetAsync("/api/v1/me/code"))).GetProperty("error").GetString());
    }

    [SkippableFact]
    public async Task A_member_who_never_enrolled_is_given_a_ref_on_first_status_and_it_never_changes()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "refnew");
        await club.WriteAsync(app, async db =>
            db.MemberCodes.Remove(await db.MemberCodes.IgnoreQueryFilters().FirstAsync(c => c.UserId == club.Pam)));

        var phone = club.Member(app, club.Pam);
        var first = (await MemberCodeClub.JsonAsync(await phone.GetAsync("/api/v1/me/code"))).GetProperty("ref").GetString()!;
        await phone.PostAsync("/api/v1/me/code/enrol", null);
        var again = (await MemberCodeClub.JsonAsync(await phone.GetAsync("/api/v1/me/code"))).GetProperty("ref").GetString()!;

        Assert.True(MemberCodeMath.IsCanonicalRef(first));
        Assert.Equal(first, again);
    }

    // ---- Rotation (§10) --------------------------------------------------------------------------

    [SkippableFact]
    public async Task Changing_the_password_rotates_the_code_and_the_old_generation_stops_working()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "rotpw");
        var device = app.CreateClient();
        var phone = club.Member(app, club.Olga);

        var changed = await phone.PostAsJsonAsync("/api/v1/me/password", new { currentPassword = "OldPass!123", newPassword = "NewPass!456" });
        Assert.Equal(HttpStatusCode.OK, changed.StatusCode);

        // The change ended the session it was made from; the answer carries its replacement.
        phone = club.Bearer(app, (await MemberCodeClub.JsonAsync(changed)).GetProperty("access_token").GetString()!);
        var status = await MemberCodeClub.JsonAsync(await phone.GetAsync("/api/v1/me/code"));
        Assert.Equal(2, status.GetProperty("generation").GetInt32());

        var old = await MemberCodeClub.JsonAsync(await device.SendAsync(club.Gate(club.Code(club.Olga, generation: 1))));
        Assert.False(old.GetProperty("opened").GetBoolean());
        Assert.Equal("not_recognised", old.GetProperty("reason").GetString());

        var fresh = await MemberCodeClub.JsonAsync(await device.SendAsync(club.Gate(club.Code(club.Olga, generation: 2))));
        Assert.True(fresh.GetProperty("opened").GetBoolean());

        var rotated = await club.ReadAsync(app, db => db.AuditLogs.IgnoreQueryFilters()
            .CountAsync(a => a.TenantId == club.TenantId && a.Action == MemberCodeService.RotatedAction && a.SubjectUserId == club.Olga));
        Assert.Equal(1, rotated);
    }

    [SkippableFact]
    public async Task Suspension_and_the_admin_reset_rotate_and_logout_does_not()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "rotadm");
        var admin = club.Member(app, club.AdminId, "admin");

        Assert.Equal(HttpStatusCode.NoContent, (await club.Member(app, club.Pam).PostAsync("/api/v1/auth/logout", null)).StatusCode);
        Assert.Equal(1, await club.ReadAsync(app, db => db.MemberCodes.IgnoreQueryFilters().Where(c => c.UserId == club.Pam).Select(c => c.Generation).FirstAsync()));

        var suspend = await admin.PostAsJsonAsync($"/api/v1/admin/members/{club.SidMembership}/suspend", new { reason = "dues" });
        Assert.Equal(HttpStatusCode.OK, suspend.StatusCode);
        Assert.Equal(2, await club.ReadAsync(app, db => db.MemberCodes.IgnoreQueryFilters().Where(c => c.UserId == club.Sid).Select(c => c.Generation).FirstAsync()));

        var reset = await MemberCodeClub.JsonAsync(await admin.PostAsync($"/api/v1/admin/members/{club.OlgaMembership}/code/reset", null));
        Assert.True(reset.GetProperty("rotated").GetBoolean());
        Assert.Equal(2, reset.GetProperty("generation").GetInt32());

        var audit = await club.ReadAsync(app, db => db.AuditLogs.IgnoreQueryFilters()
            .FirstAsync(a => a.TenantId == club.TenantId && a.Action == MemberCodeService.RotatedAction && a.SubjectUserId == club.Olga));
        Assert.Equal(club.AdminId, audit.ActorUserId);
        Assert.Contains("admin_reset", audit.DetailsJson);
    }

    /// <summary>IDOR: an admin of one club cannot rotate a member of another, and a member cannot rotate anybody.</summary>
    [SkippableFact]
    public async Task The_admin_reset_is_tenant_scoped_and_admin_only()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var home = await MemberCodeClub.SeedAsync(app, "idorhome");
        var away = await MemberCodeClub.SeedAsync(app, "idoraway");

        var foreign = await away.Member(app, away.AdminId, "admin").PostAsync($"/api/v1/admin/members/{home.OlgaMembership}/code/reset", null);
        Assert.Equal(HttpStatusCode.NotFound, foreign.StatusCode);

        var member = await home.Member(app, home.Pam).PostAsync($"/api/v1/admin/members/{home.OlgaMembership}/code/reset", null);
        Assert.Equal(HttpStatusCode.Forbidden, member.StatusCode);

        Assert.Equal(1, await home.ReadAsync(app, db => db.MemberCodes.IgnoreQueryFilters().Where(c => c.UserId == home.Olga).Select(c => c.Generation).FirstAsync()));
    }

    // ---- The door, the use table and the window (§4) ---------------------------------------------

    [SkippableFact]
    public async Task A_code_opens_the_door_once_per_step_and_a_second_open_is_code_used()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "gateonce");
        var device = app.CreateClient();
        var now = DateTimeOffset.UtcNow;
        var code = club.Code(club.Pam, now);

        var first = await MemberCodeClub.JsonAsync(await device.SendAsync(club.Gate(code)));
        var second = await MemberCodeClub.JsonAsync(await device.SendAsync(club.Gate(code)));

        Assert.True(first.GetProperty("opened").GetBoolean());
        Assert.False(second.GetProperty("opened").GetBoolean());
        Assert.Equal("code_used", second.GetProperty("reason").GetString());
        Assert.Equal(0, second.GetProperty("unlock_seconds").GetInt32());
        Assert.Equal(1, await club.UsesAsync(app, MemberCodeUseClass.Door));
    }

    [SkippableTheory]
    [InlineData(-1, true)]
    [InlineData(1, true)]
    [InlineData(-2, false)]
    [InlineData(2, false)]
    public async Task The_window_is_one_step_either_side_and_no_further(int offset, bool opens)
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "window");

        var json = await MemberCodeClub.JsonAsync(await app.CreateClient().SendAsync(club.Gate(club.Code(club.Pam, stepOffset: offset))));

        Assert.Equal(opens, json.GetProperty("opened").GetBoolean());
        if (!opens) Assert.Equal("not_recognised", json.GetProperty("reason").GetString());
        Assert.Equal(opens ? 1 : 0, await club.UsesAsync(app));
    }

    [SkippableFact]
    public async Task A_code_with_a_wrong_half_or_from_another_club_or_a_barred_member_is_not_recognised()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "wrongs");
        var other = await MemberCodeClub.SeedAsync(app, "wrongsaway");
        var device = app.CreateClient();

        var forged = await MemberCodeClub.JsonAsync(await device.SendAsync(club.Gate(club.ForgedOn(club.Pam))));
        Assert.Equal("not_recognised", forged.GetProperty("reason").GetString());

        // And the other half: a right ON beside a wrong OFF is no more a code than the reverse.
        var real = club.Code(club.Pam);
        var wrongOff = real[..13] + ((int.Parse(real[13..]) + 1) % 1_000_000).ToString("000000");
        var offForged = await MemberCodeClub.JsonAsync(await device.SendAsync(club.Gate(wrongOff)));
        Assert.Equal("not_recognised", offForged.GetProperty("reason").GetString());

        // Another club's genuine code, at this club's door: its REF means nothing here.
        var foreign = await MemberCodeClub.JsonAsync(await device.SendAsync(club.Gate(other.Code(other.Pam))));
        Assert.Equal("not_recognised", foreign.GetProperty("reason").GetString());

        await club.WriteAsync(app, async db =>
            (await db.Memberships.IgnoreQueryFilters().FirstAsync(m => m.Id == club.SidMembership)).Status = MembershipStatus.Suspended);
        var barred = await MemberCodeClub.JsonAsync(await device.SendAsync(club.Gate(club.Code(club.Sid))));
        Assert.Equal("not_recognised", barred.GetProperty("reason").GetString());

        var malformed = await MemberCodeClub.JsonAsync(await device.SendAsync(club.Gate("1U00012345678123456")));
        Assert.Equal("not_recognised", malformed.GetProperty("reason").GetString());

        Assert.Equal(0, await club.UsesAsync(app));
    }

    /// <summary>
    /// The same REF value in two clubs is two members: the use tables do not collide and neither
    /// club's code works at the other's door. Cross-tenant injection for member_codes and
    /// member_code_uses.
    /// </summary>
    [SkippableFact]
    public async Task Two_clubs_may_hold_the_same_ref_and_their_uses_never_meet()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        int[] refs = [0x11111, 0x22222, 0x33333, 0x44444];
        var a = await MemberCodeClub.SeedAsync(app, "sameref-a", refValues: refs);
        var b = await MemberCodeClub.SeedAsync(app, "sameref-b", refValues: refs);
        var device = app.CreateClient();
        var now = DateTimeOffset.UtcNow;

        Assert.True((await MemberCodeClub.JsonAsync(await device.SendAsync(a.Gate(a.Code(a.Pam, now))))).GetProperty("opened").GetBoolean());
        Assert.True((await MemberCodeClub.JsonAsync(await device.SendAsync(b.Gate(b.Code(b.Pam, now))))).GetProperty("opened").GetBoolean());
        Assert.Equal("not_recognised", (await MemberCodeClub.JsonAsync(await device.SendAsync(b.Gate(a.Code(a.Olga, now))))).GetProperty("reason").GetString());

        Assert.Equal(1, await a.UsesAsync(app));
        Assert.Equal(1, await b.UsesAsync(app));
    }

    [SkippableFact]
    public async Task The_door_and_the_court_are_two_classes_so_one_code_may_do_both()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "classes");
        await club.BookAsync(app, club.Olga, courtIndex: 1, startsInMinutes: -5);
        var device = app.CreateClient();
        var code = club.Code(club.Olga);

        var door = await MemberCodeClub.JsonAsync(await device.SendAsync(club.Gate(code)));
        var court = await MemberCodeClub.JsonAsync(await device.SendAsync(club.Activate(code)));
        var again = await MemberCodeClub.JsonAsync(await device.SendAsync(club.Activate(code)));

        Assert.True(door.GetProperty("opened").GetBoolean());
        Assert.True(court.GetProperty("activated").GetBoolean());
        Assert.Equal(2, court.GetProperty("court_number").GetInt32());
        Assert.False(again.GetProperty("activated").GetBoolean());
        Assert.Equal("code_used", again.GetProperty("reason").GetString());
        Assert.Equal(1, await club.UsesAsync(app, MemberCodeUseClass.Door));
        Assert.Equal(1, await club.UsesAsync(app, MemberCodeUseClass.Court));
    }

    /// <summary>§4.4: a row only when the server acts. Told too early, the member may scan the same code again.</summary>
    [SkippableFact]
    public async Task A_refusal_writes_no_use_so_a_member_told_too_early_is_not_refused_as_a_replay()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "tooearly");
        await club.BookAsync(app, club.Olga, courtIndex: 0, startsInMinutes: 60);
        var device = app.CreateClient();
        var code = club.Code(club.Olga);

        var first = await MemberCodeClub.JsonAsync(await device.SendAsync(club.Activate(code)));
        var second = await MemberCodeClub.JsonAsync(await device.SendAsync(club.Activate(code)));

        Assert.Equal("too_early", first.GetProperty("reason").GetString());
        Assert.Equal("too_early", second.GetProperty("reason").GetString());
        Assert.Equal(0, await club.UsesAsync(app));
    }

    /// <summary>§4.2: the server checks at (received − scan_age_ms), and refuses an age past the club's own cap.</summary>
    [SkippableFact]
    public async Task Scan_age_moves_the_check_back_and_is_capped_by_the_clubs_own_settings()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "scanage");
        await club.BookAsync(app, club.Olga, courtIndex: 0, startsInMinutes: -5);
        await club.BookAsync(app, club.Pam, courtIndex: 1, startsInMinutes: -5);
        var device = app.CreateClient();

        // A code from 75 s ago — at least two steps back, outside ±1 — read 75 s ago: inside the
        // window once the age is applied.
        var old = club.Code(club.Olga, DateTimeOffset.UtcNow.AddSeconds(-75));
        Assert.Equal("not_recognised", (await MemberCodeClub.JsonAsync(await device.SendAsync(club.Activate(old)))).GetProperty("reason").GetString());
        Assert.True((await MemberCodeClub.JsonAsync(await device.SendAsync(club.Activate(old, scanAge: 75_000)))).GetProperty("activated").GetBoolean());

        // Defaults: scan memory 30 s + choice 20 s → cap 80 000 ms. One past it is refused.
        var cap = MemberCodeSettings.MaxScanAgeMs(new TenantSettingsAccessorShim().Defaults);
        Assert.Equal(80_000, cap);
        var pam = club.Code(club.Pam, DateTimeOffset.UtcNow.AddMilliseconds(-(cap + 1)));
        Assert.Equal("not_recognised", (await MemberCodeClub.JsonAsync(await device.SendAsync(club.Activate(pam, scanAge: cap + 1)))).GetProperty("reason").GetString());
        Assert.Equal("not_recognised", (await MemberCodeClub.JsonAsync(await device.SendAsync(club.Activate(club.Code(club.Pam), scanAge: -1)))).GetProperty("reason").GetString());
    }

    // ---- The walk-up (§4.4) ----------------------------------------------------------------------

    [SkippableFact]
    public async Task A_v1_code_buys_a_walk_up_once_a_retry_replays_and_a_second_purchase_is_code_used()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "walkv1");
        var device = app.CreateClient();
        var code = club.Code(club.Pam);

        var bought = await device.SendAsync(club.WalkUp(code, court: 3, nonce: "aaaaaaaaaaaaaaaa"));
        Assert.Equal(HttpStatusCode.OK, bought.StatusCode);
        Assert.False((await MemberCodeClub.JsonAsync(bought)).GetProperty("replayed").GetBoolean());

        var retry = await device.SendAsync(club.WalkUp(code, court: 3, nonce: "aaaaaaaaaaaaaaaa"));
        Assert.Equal(HttpStatusCode.OK, retry.StatusCode);
        Assert.True((await MemberCodeClub.JsonAsync(retry)).GetProperty("replayed").GetBoolean());

        var second = await device.SendAsync(club.WalkUp(code, court: 4, nonce: "bbbbbbbbbbbbbbbb"));
        Assert.Equal(HttpStatusCode.Conflict, second.StatusCode);
        Assert.Equal("""{"error":"code_used"}""", await second.Content.ReadAsStringAsync());

        Assert.Equal(200m - 8m, await club.BalanceAsync(app, club.Pam));
        Assert.Equal(1, await club.UsesAsync(app, MemberCodeUseClass.Money));
    }

    [SkippableFact]
    public async Task A_refused_walk_up_gives_its_use_back()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "walkref");
        await club.BookAsync(app, club.Olga, courtIndex: 2, startsInMinutes: -5);
        var device = app.CreateClient();
        var code = club.Code(club.Pam);

        var busy = await device.SendAsync(club.WalkUp(code, court: 3, nonce: "cccccccccccccccc"));
        Assert.Equal(HttpStatusCode.Conflict, busy.StatusCode);
        Assert.Equal(0, await club.UsesAsync(app));

        var free = await device.SendAsync(club.WalkUp(code, court: 4, nonce: "dddddddddddddddd"));
        Assert.Equal(HttpStatusCode.OK, free.StatusCode);
    }

    // ---- Legacy codes across the phases (§8) -----------------------------------------------------

    [SkippableFact]
    public async Task Legacy_codes_work_until_the_cut_off_and_are_refused_everywhere_after_it()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "legacy");
        var device = app.CreateClient();

        var ident = new AccessCode
        {
            TenantId = club.TenantId, Code = AccessCodeService.NewCode(), Purpose = AccessCodePurpose.MemberIdent,
            UserId = club.Pam, ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(10),
        };
        await club.WriteAsync(app, db => { db.AccessCodes.Add(ident); return Task.CompletedTask; });

        await club.SetPhaseAsync(app, MemberCodeSettings.V1);
        Assert.True((await MemberCodeClub.JsonAsync(await device.SendAsync(club.Gate(ident.Code)))).GetProperty("opened").GetBoolean());

        await club.SetPhaseAsync(app, MemberCodeSettings.V1Only);
        Assert.Equal("not_recognised", (await MemberCodeClub.JsonAsync(await device.SendAsync(club.Gate(ident.Code)))).GetProperty("reason").GetString());
        Assert.Equal(HttpStatusCode.BadRequest, (await device.SendAsync(club.WalkUp(ident.Code, 3, "eeeeeeeeeeeeeeee"))).StatusCode);
        Assert.True((await MemberCodeClub.JsonAsync(await device.SendAsync(club.Gate(club.Code(club.Pam))))).GetProperty("opened").GetBoolean());

        var qr = await club.Member(app, club.Pam).PostAsync("/api/v1/me/qr/generate", null);
        Assert.Equal(HttpStatusCode.Gone, qr.StatusCode);
    }

    [SkippableFact]
    public async Task After_the_cut_over_bookings_stop_minting_codes_and_the_qr_screen_shows_an_ident_code()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "nomint");
        await club.BookAsync(app, club.Olga, courtIndex: 0, startsInMinutes: 20);
        await club.SetPhaseAsync(app, MemberCodeSettings.V1);

        var qr = await MemberCodeClub.JsonAsync(await club.Member(app, club.Olga).PostAsync("/api/v1/me/qr/generate", null));
        Assert.Equal("ident", qr.GetProperty("kind").GetString());

        // A legacy-firmware box's heartbeat after cut-over mints nothing either.
        await app.CreateClient().SendAsync(club.Heartbeat(club.BoxMac, m1: false));
        var bookingCodes = await club.ReadAsync(app, db => db.AccessCodes.IgnoreQueryFilters()
            .CountAsync(c => c.TenantId == club.TenantId && c.Purpose == AccessCodePurpose.BookingActivation));
        Assert.Equal(0, bookingCodes);
    }

    /// <summary>Reads the accessor's defaults for a club that has set nothing.</summary>
    private sealed class TenantSettingsAccessorShim
    {
        public TenantSettingsView Defaults { get; } = new(
            15, 8m, 30m, 5, 15, 14, "UTC", 1.6m, 100m, 1000m, 60, "16:00-19:00", 1, 2, 0, 1440, 7, ButtonMap.Default());
    }
}

using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// B10 / C12 / D8 — the club's public contact: what may be stored as one, and the one refusal
/// that carries it.
///
/// <para>
/// <b>It is stored unvalidated and rendered as a link.</b> The settings page's two inputs are
/// not inside a <c>&lt;form&gt;</c> and nothing on the server looked, so "ask at the desk" was a
/// valid club phone number — printed on a door card that hangs on a wall, and handed to a member
/// standing outside a building at night as a <c>tel:</c> link that dials nothing.
/// </para>
///
/// <para>
/// <b>And the people who most need it could not reach it.</b> A pending or suspended member is
/// told on the login screen to speak to the club, and every surface carrying the club's contact
/// is behind the door they are locked out of. The <c>not_approved</c> refusal now carries it —
/// that refusal only, those two fields only, and nothing about an unknown address or a wrong
/// password changes at all, because a contact block appearing for either would turn this route
/// into an account oracle.
/// </para>
/// </summary>
public sealed class DoorContactHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public DoorContactHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string SettingsPath = "/api/v1/admin/settings";
    private const string LoginPath = "/api/v1/auth/login";
    private const string Password = "Review!2345";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    /// <summary>
    /// The settings PUT is a WHOLE document — every economics field is required and bounded —
    /// so a partial body is refused before it reaches the door block. Same helper shape as
    /// <c>DoorSettingsHttpTests</c>, for the same reason.
    /// </summary>
    private const string Required =
        "\"sliceMinutes\":15,\"slicePriceCredits\":8,\"advanceBookingDays\":14,"
        + "\"dayStartMinute\":0,\"dayEndMinute\":1440,\"penaltyPct\":30,"
        + "\"graceWindowMinutes\":5,\"penaltyWindowMinutes\":15";

    private static Task<HttpResponseMessage> PutAsync(HttpClient client, string extra)
        => client.PutAsync(
            SettingsPath, new StringContent($"{{{Required},{extra}}}", Encoding.UTF8, "application/json"));

    /// <summary>The tenant of an ANONYMOUS request is its host, not a claim it has not got.</summary>
    private static HttpClient AnonymousClient(TestWebAppFactory factory, DoorClub club)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Host = $"{club.Slug}.crusaders.test";
        return client;
    }

    /// <summary>A sentence is not a phone number, and an address with no domain is not one.</summary>
    [SkippableTheory]
    [InlineData("club_contact_phone", "ask at the desk", "club_contact_phone_invalid")]
    [InlineData("club_contact_phone", "call Jane on 021 555 0100", "club_contact_phone_invalid")]
    [InlineData("club_contact_phone", "12", "club_contact_phone_invalid")]
    [InlineData("club_contact_phone", "<script>alert(1)</script>", "club_contact_phone_invalid")]
    [InlineData("club_contact_email", "not-an-email", "club_contact_email_invalid")]
    [InlineData("club_contact_email", "desk@club", "club_contact_email_invalid")]
    [InlineData("club_contact_email", "Desk <desk@club.test>", "club_contact_email_invalid")]
    [InlineData("club_contact_email", "desk@club.test, other@club.test", "club_contact_email_invalid")]
    public async Task A_contact_that_is_not_one_is_refused_by_name(string key, string value, string error)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, $"contact{value.Length}");
        var admin = club.AdminClient(factory);

        // Both spellings, because every configurable value in this tree binds both and a rule
        // enforced on one of them is a rule an admin gets past by using the other.
        foreach (var spelling in new[] { key, Camel(key) })
        {
            var res = await PutAsync(admin, $"\"{spelling}\":\"{value}\"");

            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
            Assert.Equal(
                error,
                (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
        }

        // And nothing was written: a refused PUT leaves the club exactly as it was.
        var stored = await admin.GetFromJsonAsync<JsonElement>(SettingsPath);
        Assert.Equal("", stored.GetProperty(key).GetString());
    }

    /// <summary>What a club may legitimately set, including nothing at all.</summary>
    [SkippableTheory]
    [InlineData("club_contact_phone", "+27 21 555 0100")]
    [InlineData("club_contact_phone", "(021) 555-0100")]
    [InlineData("club_contact_phone", "021 555 0100,4")]
    [InlineData("club_contact_phone", "")]
    [InlineData("club_contact_email", "desk@club.test")]
    [InlineData("club_contact_email", "the.desk+doors@squash.co.za")]
    [InlineData("club_contact_email", "")]
    public async Task A_contact_a_member_could_use_is_accepted(string key, string value)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, $"contactok{value.Length}");
        var admin = club.AdminClient(factory);

        var res = await PutAsync(admin, $"\"{Camel(key)}\":\"{value}\"");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(
            value,
            (await admin.GetFromJsonAsync<JsonElement>(SettingsPath)).GetProperty(key).GetString());
    }

    /// <summary>
    /// D8: a member the club has not approved is told to speak to the club, and is given the
    /// two ways to do it. Nothing else about the club or the membership is on that response.
    /// </summary>
    [SkippableTheory]
    [InlineData(MembershipStatus.PendingApproval)]
    [InlineData(MembershipStatus.Suspended)]
    [InlineData(MembershipStatus.Rejected)]
    public async Task A_member_the_club_has_not_approved_is_given_the_clubs_contact(MembershipStatus status)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(
            factory, $"d8{(int)status}",
            """{"timezone":"UTC","grace_window_minutes":5,"club_contact_phone":"+27 21 555 0100","club_contact_email":"desk@club.test"}""");

        var email = await BarredMemberAsync(factory, club, status);

        var res = await AnonymousClient(factory, club).PostAsJsonAsync(
            LoginPath, new { email, password = Password });

        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
        var body = await res.Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal("not_approved", body.GetProperty("error").GetString());
        Assert.Equal(status.ToString(), body.GetProperty("status").GetString());
        Assert.Equal("+27 21 555 0100", body.GetProperty("contact").GetProperty("phone").GetString());
        Assert.Equal("desk@club.test", body.GetProperty("contact").GetProperty("email").GetString());

        // Only that, and nothing more. The refusal names no person, no membership number, no
        // club name and no count of anything.
        Assert.Equal(["error", "status", "contact"], body.EnumerateObject().Select(p => p.Name).ToArray());
        Assert.Equal(
            ["phone", "email"],
            body.GetProperty("contact").EnumerateObject().Select(p => p.Name).ToArray());
    }

    /// <summary>A club that has set neither gets two nulls, which is not a failed read.</summary>
    [SkippableFact]
    public async Task A_club_that_has_set_no_contact_says_so_rather_than_inventing_one()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "d8none");
        var email = await BarredMemberAsync(factory, club, MembershipStatus.PendingApproval);

        var body = await (await AnonymousClient(factory, club).PostAsJsonAsync(
            LoginPath, new { email, password = Password }))
            .Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal(JsonValueKind.Null, body.GetProperty("contact").GetProperty("phone").ValueKind);
        Assert.Equal(JsonValueKind.Null, body.GetProperty("contact").GetProperty("email").ValueKind);
    }

    /// <summary>
    /// The refusals that are NOT this one are unchanged — an unknown address and a wrong
    /// password answer 401 with an empty body, exactly as before. A contact block on either of
    /// them would make this route say which addresses are real.
    /// </summary>
    [SkippableFact]
    public async Task An_unknown_address_and_a_wrong_password_are_unchanged()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(
            factory, "d8oracle",
            """{"timezone":"UTC","grace_window_minutes":5,"club_contact_phone":"+27 21 555 0100","club_contact_email":"desk@club.test"}""");
        var known = await BarredMemberAsync(factory, club, MembershipStatus.Active);
        var client = AnonymousClient(factory, club);

        var unknown = await client.PostAsJsonAsync(
            LoginPath, new { email = "nobody@club.test", password = Password });
        var wrong = await client.PostAsJsonAsync(LoginPath, new { email = known, password = "Wrong!2345" });

        foreach (var res in new[] { unknown, wrong })
        {
            Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
            var text = await res.Content.ReadAsStringAsync();
            Assert.DoesNotContain("+27 21 555 0100", text, StringComparison.Ordinal);
            Assert.DoesNotContain("desk@club.test", text, StringComparison.Ordinal);
            Assert.DoesNotContain("contact", text, StringComparison.Ordinal);
        }
    }

    /// <summary>The contact is the club the request ARRIVED at, and never a sibling club's.</summary>
    [SkippableFact]
    public async Task Another_clubs_contact_never_reaches_this_clubs_refusal()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var mine = await DoorClub.SeedAsync(
            factory, "d8mine",
            """{"timezone":"UTC","grace_window_minutes":5,"club_contact_phone":"+27 21 555 0100"}""");
        await DoorClub.SeedAsync(
            factory, "d8theirs",
            """{"timezone":"UTC","grace_window_minutes":5,"club_contact_phone":"+44 20 7946 0000","club_contact_email":"desk@theirs.test"}""");

        var email = await BarredMemberAsync(factory, mine, MembershipStatus.PendingApproval);

        var text = await (await AnonymousClient(factory, mine).PostAsJsonAsync(
            LoginPath, new { email, password = Password }))
            .Content.ReadAsStringAsync();

        Assert.Contains("+27 21 555 0100", text, StringComparison.Ordinal);
        Assert.DoesNotContain("+44 20 7946 0000", text, StringComparison.Ordinal);
        Assert.DoesNotContain("theirs.test", text, StringComparison.Ordinal);
    }

    private static string Camel(string snake)
        => string.Concat(snake.Split('_').Select((p, i) => i == 0 ? p : char.ToUpperInvariant(p[0]) + p[1..]));

    /// <summary>
    /// A verified member of this club whose membership is in the named state, with a real
    /// password hash so the refusal reached is the membership one and not the credential one.
    /// </summary>
    private static async Task<string> BarredMemberAsync(
        TestWebAppFactory factory, DoorClub club, MembershipStatus status)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var email = $"{club.Slug}-{(int)status}@test.local";
        var user = new User
        {
            TenantId = club.TenantId,
            Email = email,
            PasswordHash = scope.ServiceProvider.GetRequiredService<IPasswordHasher>().Hash(Password),
            EmailVerified = true,
            IsAdmin = false,
        };
        db.Users.Add(user);
        db.Memberships.Add(new Membership
        {
            TenantId = club.TenantId,
            UserId = user.Id,
            FullName = "Barred Member",
            MembershipNumber = $"{club.Slug}-b",
            Status = status,
        });
        await db.SaveChangesAsync();
        return email;
    }
}

using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Endpoints;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// <b>The P3 pair.</b> Item 6 supersedes the doors contract's P5 for the trace surface and for
/// nothing else, and the two tests that keep both statements true are kept together.
///
/// <para>
/// The first half already exists and must not move:
/// <c>AdminDoorLogHttpTests.No_parameter_named_after_a_member_changes_anything</c> drives five
/// plausible member-ish spellings through <c>/api/v1/admin/doors/activity</c> and asserts the
/// bytes are identical. This file is the second half — that the trace, which CAN answer about a
/// person, refuses rather than widening when it is asked about nobody in particular.
/// </para>
///
/// <para>
/// The distinction that keeps both true is one sentence:
/// </para>
///
/// <para>
/// <i>You cannot discover a person from the door log. You can only ask about a person you
/// already named.</i>
/// </para>
/// </summary>
public sealed class TraceP3HttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public TraceP3HttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string LogPath = "/api/v1/admin/doors/activity";

    private const string Unwired = "The trace route is not registered — Program.cs needs app.MapAdminMemberTraceEndpoints().";

    private TestWebAppFactory CreateFactory() => _pg.SharedHost;

    /// <summary>
    /// Whether this application has the trace route at all.
    ///
    /// <para>
    /// Both tests below are skipped without it, rather than allowed to pass vacuously: with no
    /// route registered every assertion about "the trace refuses" is satisfied by the router's
    /// own 404, and a P3 test that is green because the feature is absent is the most dangerous
    /// kind of green there is.
    /// </para>
    /// </summary>
    private static bool Wired(TestWebAppFactory factory)
    {
        _ = factory.CreateClient();
        return factory.Services.GetServices<EndpointDataSource>()
            .SelectMany(s => s.Endpoints)
            .OfType<RouteEndpoint>()
            .Any(e => e.RoutePattern.RawText?.EndsWith("/trace", StringComparison.Ordinal) == true);
    }

    /// <summary>
    /// <b><c>A_trace_route_never_widens_the_door_log</c>.</b>
    ///
    /// <para>
    /// Four claims, kept in one test because each is only worth anything beside the others:
    /// a malformed member id does not resolve to a club-wide view; a foreign club's member id
    /// does not either; the trace's own route carries a <c>{userId}</c> in EVERY pattern, so
    /// there is nothing to omit; and the door log still has no parameter named after a person.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_trace_route_never_widens_the_door_log()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        Skip.IfNot(Wired(factory), Unwired);

        var ours = await DoorClub.SeedAsync(factory, "p3ours");
        var theirs = await DoorClub.SeedAsync(factory, "p3thrs");
        var doorId = await ours.AddDoorAsync(factory, "gate-p300001", "front-door");
        var now = DateTimeOffset.UtcNow;

        await ours.WriteRowAsync(
            factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-5),
            subjectUserId: ours.MemberUserId, gateKey: "front-door");

        var client = ours.AdminClient(factory);

        // 1. A MALFORMED member id is a 404, never a club-wide view. The route constraint is
        //    what refuses it, which is stronger than a handler that could be changed to fall
        //    back: there is no code path from "unreadable id" to "every member".
        foreach (var bad in new[] { "not-a-guid", "", "0", "%20", "*" })
        {
            var response = await client.GetAsync($"/api/v1/admin/members/{bad}/trace");
            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        }

        // 2. A FOREIGN club's member is the same 404. "Not ours" and "nobody" are one answer.
        var foreign = await client.GetAsync($"/api/v1/admin/members/{theirs.MemberUserId}/trace");
        Assert.Equal(HttpStatusCode.NotFound, foreign.StatusCode);

        // 3. There is no route on this surface without a member in its PATH — no index, no
        //    search, no list. §6.6.5 is structural or it is nothing.
        var traceRoutes = factory.Services.GetServices<EndpointDataSource>()
            .SelectMany(s => s.Endpoints)
            .OfType<RouteEndpoint>()
            .Select(e => e.RoutePattern.RawText ?? "")
            .Where(p => p.Contains("trace", StringComparison.OrdinalIgnoreCase))
            .ToList();
        Assert.All(traceRoutes, p => Assert.Contains("{userId", p, StringComparison.Ordinal));

        // 4. And the door log still has nowhere to put a person. The existing test asserts the
        //    BYTES are identical for five spellings; this one asserts the type has no field,
        //    which is the reason those bytes are identical and the thing a convenience would
        //    change first.
        var fields = typeof(DoorLogQuery).GetProperties()
            .Select(p => p.Name)
            .Concat(typeof(DoorLogQuery).GetConstructors().SelectMany(c => c.GetParameters()).Select(p => p.Name!))
            .ToList();
        foreach (var forbidden in new[] { "member", "user", "subject", "person", "q", "search" })
        {
            Assert.DoesNotContain(fields, f => f.Contains(forbidden, StringComparison.OrdinalIgnoreCase));
        }

        // 5. The door log answers the same thing it did before any of this existed.
        var log = await client.GetFromJsonAsync<JsonElement>(LogPath);
        Assert.Equal(1, log.GetProperty("total").GetInt32());
    }

    /// <summary>
    /// The member's own half of P3 is untouched: <c>GET /api/v1/me/door/history</c> remains the
    /// only place a member sees their own door history, and the trace did not become a second
    /// one by being readable with a member's token.
    /// </summary>
    [SkippableFact]
    public async Task The_members_own_history_is_still_the_only_one_they_can_read()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        Skip.IfNot(Wired(factory), Unwired);

        var club = await DoorClub.SeedAsync(factory, "p3self");
        var member = club.MemberClient(factory);

        var own = await member.GetAsync("/api/v1/me/door/history");
        Assert.Equal(HttpStatusCode.OK, own.StatusCode);

        var trace = await member.GetAsync($"/api/v1/admin/members/{club.MemberUserId}/trace");
        Assert.Equal(HttpStatusCode.Forbidden, trace.StatusCode);
    }
}

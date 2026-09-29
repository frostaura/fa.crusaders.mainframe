using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Services.Realtime;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The control board's live stream — GOAL items 8 and 10.
///
/// <para>
/// <b>This suite exists because its absence shipped a route that was 403 for everybody.</b>
/// The ticket is purpose-scoped and the handler also checks the admin role, which is right —
/// a purpose says which PATH a ticket opens, not who may open it. But the ticket was minted
/// with no role claims at all, so the check could never pass, and nothing anywhere would have
/// said so: the page would simply never have gone live, and the poll fallback would have
/// covered for it indefinitely. A stream with no test is a stream nobody has watched connect.
/// </para>
/// </summary>
public sealed class ControlBoardStreamTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public ControlBoardStreamTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string TicketPath = "/api/v1/admin/control-board/stream-ticket";
    private const string StreamPath = "/api/v1/admin/control-board/stream";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static async Task<string> TicketAsync(HttpClient client)
    {
        var res = await client.PostAsync(TicketPath, new StringContent("", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        return body.GetProperty("ticket").GetString()!;
    }

    /// <summary>
    /// Reads SSE frames until <paramref name="want"/> of the named event have arrived or the
    /// deadline passes, and returns every named event seen in order.
    ///
    /// <para>
    /// Reads the response as a STREAM rather than awaiting the whole body, which never
    /// completes: an SSE response is open until somebody closes it, so
    /// <c>ReadAsStringAsync</c> on one is a test that hangs until its own timeout.
    /// </para>
    /// </summary>
    private static async Task<List<string>> FramesAsync(
        HttpClient client, string url, string want, int count, TimeSpan deadline)
    {
        using var cts = new CancellationTokenSource(deadline);
        var events = new List<string>();

        try
        {
            using var res = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cts.Token);
            if (res.StatusCode != HttpStatusCode.OK) return [$"status:{(int)res.StatusCode}"];

            using var reader = new StreamReader(await res.Content.ReadAsStreamAsync(cts.Token));
            while (!cts.IsCancellationRequested)
            {
                var line = await reader.ReadLineAsync(cts.Token);
                if (line is null) break;
                if (!line.StartsWith("event: ", StringComparison.Ordinal)) continue;

                events.Add(line["event: ".Length..]);
                if (events.Count(e => e == want) >= count) break;
            }
        }
        catch (OperationCanceledException) { /* the deadline is the test's own bound */ }

        return events;
    }

    /// <summary>
    /// The route an admin can actually open, and the snapshot it opens on.
    ///
    /// <para><b>Mutant:</b> mint the ticket without the role claims. The page never goes live
    /// and nothing says why.</para>
    /// </summary>
    [SkippableFact]
    public async Task An_admin_opens_the_stream_and_the_first_frame_is_a_whole_snapshot()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "cbstream");
        await club.AddCourtAsync(factory, 1);

        var admin = club.AdminClient(factory);
        var ticket = await TicketAsync(admin);

        using var anonymous = factory.CreateClient();
        var frames = await FramesAsync(
            anonymous, $"{StreamPath}?ticket={ticket}", "snapshot", 1, TimeSpan.FromSeconds(20));

        Assert.Equal("snapshot", frames.FirstOrDefault());
    }

    /// <summary>
    /// A MEMBER'S ticket does not open it, and neither does a member's access token.
    ///
    /// <para>
    /// The board names every member playing tonight. The purpose-scoped ticket says which path
    /// a credential may be used on; the role is what says who.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_member_cannot_open_the_control_board_stream()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(factory, "cbstrmem");
        await club.AddCourtAsync(factory, 1);

        var refusedTicket = await club.MemberClient(factory)
            .PostAsync(TicketPath, new StringContent("", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.Forbidden, refusedTicket.StatusCode);

        // …and a member's own access token on the stream path is refused by the purpose check.
        using var member = factory.CreateClient();
        member.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", club.TokenFor(club.MemberUserId, null));
        var withToken = await member.GetAsync(StreamPath);

        Assert.NotEqual(HttpStatusCode.OK, withToken.StatusCode);
    }

    /// <summary>
    /// The periodic resync — how a client that missed a delta heals itself.
    ///
    /// <para>
    /// Deltas alone are a state machine the browser has to get right for hours on an
    /// unattended wall screen. A resync makes a dropped frame cost at most one interval of
    /// staleness rather than a permanently wrong court, and every snapshot carries
    /// <c>generated_at</c> so the screen can say when it was last right.
    /// </para>
    ///
    /// <para>
    /// The fixture sets <c>control_board_resync_seconds</c> to its floor of 30, which is still
    /// too slow for a test, so this club overrides it — the clamp's lower bound is exercised by
    /// the settings suite, and what is asserted here is that the loop RUNS.
    /// </para>
    ///
    /// <para><b>Mutant:</b> delete the resync loop. The first snapshot still arrives, which is
    /// why the assertion is on the SECOND one.</para>
    /// </summary>
    [SkippableFact]
    public async Task The_board_sends_a_fresh_snapshot_every_resync_interval()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(
            factory, "cbresync",
            """
            {"slice_minutes":15,"timezone":"UTC","heartbeat_seconds":60,
             "sse_keepalive_seconds":5,"control_board_resync_seconds":30,
             "control_board_stale_multiplier":2,"realtime_poll_seconds_control_board":10}
            """);
        await club.AddCourtAsync(factory, 1);

        var ticket = await TicketAsync(club.AdminClient(factory));

        using var anonymous = factory.CreateClient();
        var frames = await FramesAsync(
            anonymous, $"{StreamPath}?ticket={ticket}", "snapshot", 2, TimeSpan.FromSeconds(50));

        Assert.True(
            frames.Count(f => f == "snapshot") >= 2,
            $"the stream never sent a second snapshot, so a client that missed a delta would stay wrong for ever — frames seen: {string.Join(", ", frames)}");

        // …and it kept the connection warm in between, which is what the client's silence
        // watchdog arms on.
        Assert.Contains("ping", frames);
    }

    /// <summary>
    /// ZERO BYTES beyond the keep-alive when another club publishes.
    ///
    /// <para>
    /// The non-negotiable cross-tenant test, and it asserts SILENCE rather than a different
    /// payload: a fan-out keyed on anything but the tenant would deliver the other club's
    /// courts here, and "the payload differs" is a test that passes on a leak of a court with
    /// the same number.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task Another_clubs_court_delta_reaches_this_clubs_stream_as_nothing_at_all()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var mine = await ControlBoardClub.SeedAsync(factory, "cbmineST");
        var theirs = await ControlBoardClub.SeedAsync(factory, "cbtheirST");
        await mine.AddCourtAsync(factory, 1);
        await theirs.AddCourtAsync(factory, 1);

        var ticket = await TicketAsync(mine.AdminClient(factory));

        // Publish on the OTHER club's topic for the whole time this stream is open.
        var bus = factory.Services.GetRequiredService<IRealtimeBus>();
        using var publishing = new CancellationTokenSource();
        var noise = Task.Run(async () =>
        {
            while (!publishing.IsCancellationRequested)
            {
                bus.Publish(
                    RealtimeTopic.ControlBoard(theirs.TenantId),
                    new RealtimeMessage("court", """{"court_number":1,"name":"Their court"}"""));
                await Task.Delay(100, CancellationToken.None);
            }
        }, CancellationToken.None);

        using var anonymous = factory.CreateClient();
        var frames = await FramesAsync(
            anonymous, $"{StreamPath}?ticket={ticket}", "court", 1, TimeSpan.FromSeconds(12));

        await publishing.CancelAsync();
        await noise;

        Assert.DoesNotContain("court", frames);
        Assert.Equal("snapshot", frames.FirstOrDefault());
    }
}

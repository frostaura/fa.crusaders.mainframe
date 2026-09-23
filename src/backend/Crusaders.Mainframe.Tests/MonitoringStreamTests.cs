using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Services.Realtime;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// <c>/api/v1/admin/monitoring/stream</c> — GOAL item 8's third route.
///
/// <para>
/// <b>The assertion that matters most here is a SILENCE.</b> Tenant isolation on a query is
/// proved by comparing two result sets; on a transport there is no result set to compare, so
/// the test opens the stream as one club's admin, publishes on another club's topic, and asserts
/// that <b>no bytes arrive beyond the keep-alive</b>. "The payload differs" would pass for a
/// stream that delivered the other club's frame and rendered it wrong.
/// </para>
///
/// <para>
/// The second is the ticket. <c>EventSource</c> cannot set an <c>Authorization</c> header, so
/// the credential travels in the query string — where every proxy in front of this logs it
/// verbatim, on every reconnect. It is minted by a POST, lives about a minute, opens THIS stream
/// and nothing else, and the role is still checked inside the handler.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class MonitoringStreamTests
{
    private readonly PostgresFixture _pg;

    public MonitoringStreamTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private Task<ControlBoardClub> SeedAsync(TestWebAppFactory factory, string prefix)
        => ControlBoardClub.SeedAsync(factory, prefix, MonitoringFixture.Settings);

    /// <summary>Mints a ticket the way a console does, and fails loudly rather than returning a null.</summary>
    private static async Task<string> TicketAsync(HttpClient client)
    {
        var minted = await client.PostAsync(MonitoringFixture.TicketPath, content: null);
        Assert.Equal(HttpStatusCode.OK, minted.StatusCode);

        var body = await minted.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(
            (int)TokenPurposes.WalletStreamTicketTtl.TotalSeconds,
            body.GetProperty("expires_in_seconds").GetInt32());
        return body.GetProperty("ticket").GetString()!;
    }

    private static void Publish(TestWebAppFactory factory, Guid tenantId, RealtimeMessage message)
        => factory.Services.GetRequiredService<IRealtimeBus>().Publish(RealtimeTopic.Monitoring(tenantId), message);

    /// <summary>
    /// The first frame of the named event, parsed. Parsed rather than matched as a substring,
    /// because the serialiser escapes non-ASCII and an apostrophe alike — a headline asserted by
    /// <c>Assert.Contains</c> fails on the escaping rather than on the server.
    /// </summary>
    private static JsonElement Payload(string frames, string name)
    {
        var frame = frames.Split("\n\n", StringSplitOptions.RemoveEmptyEntries)
            .First(f => f.Contains($"event: {name}", StringComparison.Ordinal));
        return JsonDocument.Parse(frame.Split("data: ")[1]).RootElement.Clone();
    }

    /// <summary>
    /// Opens the stream with a freshly minted ticket and starts reading it.
    ///
    /// <para>
    /// The response, the body and the reader are one lifetime, so a test cannot accidentally
    /// keep a pump alive over a disposed response.
    /// </para>
    /// </summary>
    private static async Task<SseSession> OpenAsync(TestWebAppFactory factory, ControlBoardClub club)
    {
        var ticket = await TicketAsync(club.AdminClient(factory));

        var cts = new CancellationTokenSource(TimeSpan.FromMinutes(1));
        var request = new HttpRequestMessage(
            HttpMethod.Get, $"{MonitoringFixture.StreamPath}?ticket={Uri.EscapeDataString(ticket)}");
        var response = await factory.CreateClient()
            .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        return new SseSession(request, response, await response.Content.ReadAsStreamAsync(cts.Token), cts);
    }

    /// <summary>
    /// One open stream, read by a background pump for as long as the test holds it.
    ///
    /// <para>
    /// <b>A read with its own deadline cannot be used here, and finding that out is worth
    /// writing down.</b> Cancelling a read on the test host's response body ABORTS the body —
    /// every subsequent read throws — so "read for two seconds, act, read for four more" makes
    /// the second read fail for a reason that has nothing to do with the server. One pump for
    /// the stream's whole life, with the test waiting on what it has accumulated, is the only
    /// shape that can assert both an arrival and a silence on one connection.
    /// </para>
    /// </summary>
    private sealed class SseSession : IAsyncDisposable
    {
        private readonly HttpRequestMessage _request;
        private readonly HttpResponseMessage _response;
        private readonly CancellationTokenSource _cts;
        private readonly System.Text.StringBuilder _text = new();
        private readonly Task _pump;

        public SseSession(
            HttpRequestMessage request, HttpResponseMessage response, Stream body, CancellationTokenSource cts)
        {
            _request = request;
            _response = response;
            _cts = cts;
            _pump = Task.Run(() => PumpAsync(body, cts.Token));
        }

        public HttpResponseMessage Response => _response;

        /// <summary>Everything the stream has said so far.</summary>
        public string Text { get { lock (_text) { return _text.ToString(); } } }

        /// <summary>Where the stream is now, so a later assertion can be about what came AFTER an action.</summary>
        public int Mark() => Text.Length;

        /// <summary>Everything said since <paramref name="mark"/>.</summary>
        public string Since(int mark)
        {
            var text = Text;
            return mark >= text.Length ? "" : text[mark..];
        }

        /// <summary>
        /// Waits for <paramref name="needle"/> to appear, up to <paramref name="timeout"/>, and
        /// returns what has arrived either way — so the assertion that follows reports the real
        /// text rather than a bare timeout.
        /// </summary>
        public async Task<string> WaitForAsync(string needle, TimeSpan timeout, int mark = 0)
        {
            var deadline = DateTime.UtcNow + timeout;
            while (DateTime.UtcNow < deadline)
            {
                if (Since(mark).Contains(needle, StringComparison.Ordinal)) return Since(mark);
                await Task.Delay(50);
            }
            return Since(mark);
        }

        /// <summary>Everything said in <paramref name="window"/> — the shape a SILENCE is asserted with.</summary>
        public async Task<string> SettleAsync(TimeSpan window, int mark)
        {
            await Task.Delay(window);
            return Since(mark);
        }

        private async Task PumpAsync(Stream body, CancellationToken ct)
        {
            var buffer = new byte[8192];
            try
            {
                while (!ct.IsCancellationRequested)
                {
                    var read = await body.ReadAsync(buffer, ct);
                    if (read == 0) break;
                    lock (_text) { _text.Append(System.Text.Encoding.UTF8.GetString(buffer, 0, read)); }
                }
            }
            catch (OperationCanceledException) { /* the test let go */ }
            catch (IOException) { /* the test host aborts the body on cancellation */ }
            catch (ObjectDisposedException) { /* the response went first */ }
        }

        public async ValueTask DisposeAsync()
        {
            await _cts.CancelAsync();
            try { await _pump; } catch (Exception) { /* the pump's own exits are all expected */ }
            _response.Dispose();
            _request.Dispose();
            _cts.Dispose();
        }
    }

    // ---- who may open it -------------------------------------------------------------

    /// <summary>A member cannot mint a monitoring ticket — the estate is not a member's page.</summary>
    [SkippableFact]
    public async Task A_member_may_not_mint_a_monitoring_ticket()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "strrole");

        Assert.Equal(
            HttpStatusCode.Forbidden,
            (await club.MemberClient(factory).PostAsync(MonitoringFixture.TicketPath, content: null)).StatusCode);
    }

    /// <summary>
    /// <b>And if a member somehow held one anyway, the handler still refuses.</b> The purpose is
    /// what admits the request to the route — the role policy cannot be, because the credential
    /// is in the query string — so the role check has to live INSIDE the handler or a leaked
    /// ticket reads the club's whole estate.
    /// </summary>
    [SkippableFact]
    public async Task A_monitoring_ticket_held_by_a_member_still_cannot_open_the_stream()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "strmemtkt");

        // A well-formed monitoring-purpose token for a member, which is exactly what a leak
        // looks like: the signature is valid, the purpose is right, the role is not.
        var forged = club.TokenFor(club.MemberUserId, role: null, purpose: TokenPurposes.MonitoringStream);

        using var request = new HttpRequestMessage(
            HttpMethod.Get, $"{MonitoringFixture.StreamPath}?ticket={Uri.EscapeDataString(forged)}");
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var response = await factory.CreateClient()
            .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cts.Token);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    /// <summary>
    /// The ticket opens THIS stream and nothing else — not the fault list it belongs to, not the
    /// control board's stream, and not another ticket. Separate purposes on separate paths is
    /// what makes that a property of the token rather than a rule somebody has to remember.
    /// </summary>
    [SkippableFact]
    public async Task A_monitoring_ticket_opens_the_monitoring_stream_and_nothing_else()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "strscope");
        var ticket = await TicketAsync(club.AdminClient(factory));

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        using var open = new HttpRequestMessage(
            HttpMethod.Get, $"{MonitoringFixture.StreamPath}?ticket={Uri.EscapeDataString(ticket)}");
        using var streamed = await factory.CreateClient()
            .SendAsync(open, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        Assert.Equal(HttpStatusCode.OK, streamed.StatusCode);

        // The four headers this deployment needs. X-Accel-Buffering is not belt-and-braces:
        // nginx buffers proxied responses by default, and a buffered SSE stream delivers
        // nothing until the buffer fills — which on this channel is never.
        Assert.Equal("text/event-stream", streamed.Content.Headers.ContentType!.MediaType);
        Assert.Equal("no", streamed.Headers.GetValues("X-Accel-Buffering").Single());
        streamed.Dispose();

        var bearer = factory.CreateClient();
        bearer.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", ticket);

        Assert.NotEqual(HttpStatusCode.OK, (await bearer.GetAsync(MonitoringFixture.ErrorsPath)).StatusCode);
        Assert.NotEqual(HttpStatusCode.OK, (await bearer.GetAsync(MonitoringFixture.SummaryPath)).StatusCode);
        Assert.NotEqual(
            HttpStatusCode.OK,
            (await bearer.PostAsync(MonitoringFixture.TicketPath, content: null)).StatusCode);

        // And it is not a control-board ticket: one purpose, one path.
        using var wrongPath = new HttpRequestMessage(
            HttpMethod.Get, $"{TokenPurposes.ControlBoardStreamPath}?ticket={Uri.EscapeDataString(ticket)}");
        using var refused = await factory.CreateClient()
            .SendAsync(wrongPath, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        Assert.NotEqual(HttpStatusCode.OK, refused.StatusCode);
    }


    // ---- what it sends ---------------------------------------------------------------

    /// <summary>
    /// <b>The opening frame is <c>counts</c>, and it is the club's real numbers.</b> A page's
    /// headline number has to be right the instant the stream opens; the rows behind it are
    /// already on screen from the paired <c>GET</c>, which is why the opening frame is not the
    /// whole list — <c>EventSource</c> reconnects on its own, repeatedly, and every reconnect
    /// would otherwise re-send a club's entire fault log.
    /// </summary>
    [SkippableFact]
    public async Task The_opening_frame_is_the_clubs_open_counts()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "strcounts");
        var box = await club.AddBoxAsync(factory, "box-str01", [1], lastSeenAt: DateTimeOffset.UtcNow);

        await MonitoringFixture.AddErrorAsync(factory, club, DeviceErrorCodes.MegaLinkLost, new ErrorRow { DeviceId = box });
        await MonitoringFixture.AddErrorAsync(factory, club, DeviceErrorCodes.WdtReset, new ErrorRow { DeviceId = box });
        await MonitoringFixture.AddErrorAsync(factory, club, DeviceErrorCodes.HttpTimeout, new ErrorRow { DeviceId = box });
        await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.RelayCmdDropped,
            new ErrorRow { DeviceId = box, ResolvedAt = DateTimeOffset.UtcNow, ResolvedByUserId = club.AdminUserId });

        await using var sse = await OpenAsync(factory, club);
        var text = await sse.WaitForAsync("event: counts", TimeSpan.FromSeconds(10));

        Assert.StartsWith("event: counts", text, StringComparison.Ordinal);

        var payload = JsonDocument.Parse(text.Split("data: ")[1].Split("\n\n")[0]).RootElement;
        Assert.Equal(1, payload.GetProperty("critical").GetInt32());
        Assert.Equal(1, payload.GetProperty("error").GetInt32());
        Assert.Equal(1, payload.GetProperty("warning").GetInt32());

        // The resolved critical one is not open, and the opening frame must not count it — a
        // headline that counts closed faults is a headline that never falls.
        Assert.Equal(0, payload.GetProperty("info").GetInt32());
    }

    /// <summary>
    /// The four headers this deployment needs. <c>X-Accel-Buffering: no</c> is not
    /// belt-and-braces: nginx buffers proxied responses by default, and a buffered SSE stream
    /// delivers nothing until the buffer fills — which on a channel that sends one small frame
    /// when a board breaks is never.
    /// </summary>
    [SkippableFact]
    public async Task The_stream_carries_the_headers_this_deployments_proxies_need()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "strheaders");

        await using var sse = await OpenAsync(factory, club);

        Assert.Equal("text/event-stream", sse.Response.Content.Headers.ContentType!.MediaType);
        Assert.Equal("no", sse.Response.Headers.GetValues("X-Accel-Buffering").Single());
        Assert.Contains(
            "no-transform",
            sse.Response.Headers.GetValues("Cache-Control").Single(),
            StringComparison.Ordinal);
    }

    /// <summary>
    /// Resolving a fault reaches an open stream as <c>error_resolved</c>, carrying the name of
    /// whoever closed it — so a second admin's screen strikes the row through and says who,
    /// rather than silently disagreeing with the first's.
    /// </summary>
    [SkippableFact]
    public async Task Resolving_a_fault_reaches_an_open_stream()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "strresolve");
        var box = await club.AddBoxAsync(factory, "box-str02", [1], lastSeenAt: DateTimeOffset.UtcNow);
        var id = await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.LcdI2cTimeout, new ErrorRow { DeviceId = box });

        var admin = club.AdminClient(factory);
        await using var sse = await OpenAsync(factory, club);

        // The opening frame first, so the subscription is definitely in place before the resolve
        // — SubscribeThenSendAsync takes it before writing, and seeing it proves that happened.
        Assert.Contains(
            "event: counts",
            await sse.WaitForAsync("event: counts", TimeSpan.FromSeconds(10)),
            StringComparison.Ordinal);
        var mark = sse.Mark();

        Assert.Equal(
            HttpStatusCode.OK,
            (await admin.PostAsync(MonitoringFixture.ResolvePath(id), JsonContent.Create(new { note = "swapped the screen" }))).StatusCode);

        var frames = await sse.WaitForAsync("event: error_resolved", TimeSpan.FromSeconds(10), mark);

        Assert.Contains("event: error_resolved", frames, StringComparison.Ordinal);
        Assert.Contains(id.ToString(), frames, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Board Admin", frames, StringComparison.Ordinal);
    }

    // ---- tenancy ---------------------------------------------------------------------

    /// <summary>
    /// <b>Zero bytes beyond the keep-alive.</b> One club's admin holds the stream open while
    /// another club's faults are published on the bus; the only thing that may arrive is
    /// <c>ping</c>. Asserted as silence rather than as a difference, because a transport that
    /// delivered the wrong club's frame and rendered it badly would satisfy "the payload
    /// differs".
    /// </summary>
    [SkippableFact]
    public async Task Another_clubs_faults_never_reach_this_clubs_stream()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var mine = await SeedAsync(factory, "strmine");
        var theirs = await SeedAsync(factory, "strtheirs");

        await using var sse = await OpenAsync(factory, mine);
        Assert.Contains(
            "event: counts",
            await sse.WaitForAsync("event: counts", TimeSpan.FromSeconds(10)),
            StringComparison.Ordinal);
        var mark = sse.Mark();

        Publish(factory, theirs.TenantId, new RealtimeMessage(
            "error_opened", JsonSerializer.Serialize(new { device_code = "box-strtheirs", code = "mega_link_lost" })));
        Publish(factory, theirs.TenantId, new RealtimeMessage(
            "error_resolved", JsonSerializer.Serialize(new { resolved_by_name = "Their Admin" })));

        // Long enough for the fixture's five-second keep-alive to fire at least once, so the
        // stream is demonstrably ALIVE and merely silent rather than dead — which is the reading
        // that makes "no bytes" mean anything.
        var heard = await sse.SettleAsync(TimeSpan.FromSeconds(8), mark);

        Assert.DoesNotContain("box-strtheirs", heard, StringComparison.Ordinal);
        Assert.DoesNotContain("Their Admin", heard, StringComparison.Ordinal);
        Assert.DoesNotContain("error_opened", heard, StringComparison.Ordinal);
        Assert.DoesNotContain("error_resolved", heard, StringComparison.Ordinal);

        Assert.Contains("event: ping", heard, StringComparison.Ordinal);
        Assert.All(
            heard.Split("\n\n", StringSplitOptions.RemoveEmptyEntries),
            frame => Assert.Contains("event: ping", frame, StringComparison.Ordinal));
    }

    /// <summary>
    /// And the club's OWN faults do reach it — the other half of the isolation claim, without
    /// which the test above would pass against a stream that delivers nothing at all.
    /// </summary>
    [SkippableFact]
    public async Task This_clubs_own_faults_do_reach_its_stream()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "strown");

        await using var sse = await OpenAsync(factory, club);
        Assert.Contains(
            "event: counts",
            await sse.WaitForAsync("event: counts", TimeSpan.FromSeconds(10)),
            StringComparison.Ordinal);
        var mark = sse.Mark();

        Publish(factory, club.TenantId, new RealtimeMessage(
            "error_opened", JsonSerializer.Serialize(new { device_code = "box-strown", code = DeviceErrorCodes.MegaLinkLost })));

        var heard = await sse.WaitForAsync("event: error_opened", TimeSpan.FromSeconds(10), mark);

        Assert.Contains("event: error_opened", heard, StringComparison.Ordinal);
        Assert.Contains("box-strown", heard, StringComparison.Ordinal);
    }

    /// <summary>
    /// An admin demoted while their stream is open stops receiving the club's frames. The role
    /// was checked once, when the stream opened, and the stream then ran until the connection
    /// dropped — a demoted admin's <c>EventSource</c> went on delivering device faults after every
    /// other request of theirs was answered 403 (review finding authz P3-2). The role is now
    /// re-asked before every frame, and a "no" ends the stream.
    /// </summary>
    [SkippableFact]
    public async Task A_demoted_admins_open_stream_stops_delivering()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "strdemote");

        await using var sse = await OpenAsync(factory, club);
        Assert.Contains(
            "event: counts",
            await sse.WaitForAsync("event: counts", TimeSpan.FromSeconds(10)),
            StringComparison.Ordinal);

        // What the R20 revoke does: the flag, committed, then the live role's eviction.
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Persistence.MainframeDbContext>();
            var admin = await Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions.FirstAsync(
                Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions.IgnoreQueryFilters(db.Users),
                u => u.Id == club.AdminUserId);
            admin.IsAdmin = false;
            await db.SaveChangesAsync();
        }
        factory.Services.GetRequiredService<LiveAdminRole>().Invalidate(club.TenantId, club.AdminUserId);
        var mark = sse.Mark();

        Publish(factory, club.TenantId, new RealtimeMessage(
            "error_opened", JsonSerializer.Serialize(new { device_code = "box-strdemote", code = DeviceErrorCodes.MegaLinkLost })));

        var heard = await sse.SettleAsync(TimeSpan.FromSeconds(3), mark);
        Assert.DoesNotContain("error_opened", heard, StringComparison.Ordinal);
    }

    /// <summary>
    /// A fault RECORDED while a stream is open announces itself, through the writer the device
    /// routes actually use — so the wire this page listens on is the wire the ingest publishes
    /// on, rather than two shapes that agree in a doc comment.
    /// </summary>
    [SkippableFact]
    public async Task A_newly_recorded_fault_announces_itself_once_however_often_it_repeats()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "stringest");
        var box = await club.AddBoxAsync(factory, "box-str03", [1], lastSeenAt: DateTimeOffset.UtcNow);

        await using var sse = await OpenAsync(factory, club);
        Assert.Contains(
            "event: counts",
            await sse.WaitForAsync("event: counts", TimeSpan.FromSeconds(10)),
            StringComparison.Ordinal);
        var mark = sse.Mark();

        var report = new DeviceErrorReport(
            Code: DeviceErrorCodes.MegaLinkLost, Source: DeviceErrorSource.Device,
            DeviceId: box, Detail: "no reply on the bridge");
        await MonitoringFixture.RecordAsync(factory, club, report);

        var heard = await sse.WaitForAsync("event: error_opened", TimeSpan.FromSeconds(10), mark);
        Assert.Contains("event: error_opened", heard, StringComparison.Ordinal);

        // Parsed rather than matched as a substring: the serialiser escapes an apostrophe as
        // ', so "The court box's two halves have stopped talking" is not in these bytes
        // literally — and a test that quietly weakened to matching the CODE would stop checking
        // that the frame carries a sentence at all.
        var opened = Payload(heard, "error_opened");
        Assert.Equal(DeviceErrorCodes.HeadlineOf(DeviceErrorCodes.MegaLinkLost), opened.GetProperty("headline").GetString());
        Assert.Equal(DeviceErrorCodes.MegaLinkLost, opened.GetProperty("code").GetString());
        Assert.Equal("critical", opened.GetProperty("severity").GetString());

        // A second report of the SAME fault is a count climbing, not a second announcement: a
        // page that shouts once a second while one fault repeats is a page an admin mutes, and
        // a muted monitoring page is worse than none.
        var second = sse.Mark();
        await MonitoringFixture.RecordAsync(factory, club, report);

        var again = await sse.SettleAsync(TimeSpan.FromSeconds(3), second);
        Assert.DoesNotContain("event: error_opened", again, StringComparison.Ordinal);
    }
}

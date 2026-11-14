using System.Net;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security.Outbound;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Regression tests for a retry mechanism that <b>was never implemented</b>.
///
/// <para>
/// <c>WebhookDeliveryWorker</c> has always written <c>FinalState = "pending"</c> and a
/// <c>NextRetryAt</c> on failure, and no code anywhere read either column. The
/// documented 1m/5m/30m/2h/12h/24h schedule described a mechanism that did not exist:
/// a receiver down for thirty seconds lost the event permanently, and the delivery row
/// sat "pending" forever, looking like it was about to be retried.
/// </para>
///
/// <para>
/// The invariant is not convenience. <c>CLAUDE.md</c> requires webhooks to be a
/// programmatic mirror of the same event stream players receive by email. A mirror
/// that drops events on the first transient failure is not a mirror.
/// </para>
/// </summary>
public class WebhookRetryTests
{
    /// <summary>
    /// A stub transport that answers with a scripted sequence of statuses, so a
    /// fail-then-succeed run can be driven deterministically.
    /// </summary>
    private sealed class ScriptedHandler : HttpMessageHandler
    {
        private readonly Queue<HttpStatusCode?> _script;

        public ScriptedHandler(params HttpStatusCode?[] script) => _script = new Queue<HttpStatusCode?>(script);

        public List<HttpRequestMessage> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Requests.Add(request);

            // Beyond the script, keep answering with the last outcome rather than
            // throwing — a test that runs one sweep too many should not fail for that.
            var status = _script.Count > 0 ? _script.Dequeue() : HttpStatusCode.InternalServerError;

            if (status is null) throw new HttpRequestException("simulated connection failure");

            return Task.FromResult(new HttpResponseMessage(status.Value)
            {
                Content = new StringContent("ok"),
            });
        }
    }

    /// <summary>A transport that always refuses the way the outbound guard refuses.</summary>
    private sealed class BlockingHandler : HttpMessageHandler
    {
        public int Attempts { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Attempts++;

            // Wrapped, exactly as HttpClient wraps a ConnectCallback throw in the real
            // pipeline. If the unwrapping in WebhookSender is wrong, this test catches it.
            throw new HttpRequestException(
                "connect failed", new OutboundBlockedException("169.254.169.254", "destination_not_permitted"));
        }
    }

    private sealed class SingleClientFactory : IHttpClientFactory
    {
        private readonly HttpMessageHandler _handler;
        public SingleClientFactory(HttpMessageHandler handler) => _handler = handler;
        public HttpClient CreateClient(string name) => new(_handler, disposeHandler: false);
    }

    private static WebhookSender Sender(HttpMessageHandler handler) =>
        new(new SingleClientFactory(handler), NullLogger<WebhookSender>.Instance);

    private static (WebhookEndpoint Endpoint, WebhookDelivery Delivery) Fixture(Guid tenantId) =>
    (
        new WebhookEndpoint
        {
            TenantId = tenantId,
            OwnerKind = WebhookOwnerKind.Tenant,
            UrlTemplate = "https://hooks.example.com/crusaders",
            EventFilter = "*",
            Secret = "test-secret",
        },
        new WebhookDelivery
        {
            TenantId = tenantId,
            EventId = Guid.NewGuid().ToString(),
            EventType = "booking.created",
            Url = "https://hooks.example.com/crusaders",
            RequestBody = """{"type":"booking.created"}""",
            Attempt = 1,
        }
    );

    // ---- Sender bookkeeping ------------------------------------------------

    [Fact]
    public async Task A_failure_schedules_a_retry_at_the_documented_first_backoff()
    {
        var (endpoint, delivery) = Fixture(Guid.NewGuid());
        var before = DateTimeOffset.UtcNow;

        await Sender(new ScriptedHandler(HttpStatusCode.InternalServerError))
            .AttemptAsync(delivery, endpoint, delivery.RequestBody, default);

        Assert.Equal("pending", delivery.FinalState);
        Assert.NotNull(delivery.NextRetryAt);
        Assert.Equal(1, endpoint.FailureCount);

        // First backoff is one minute. Asserted as a window, not an instant, because
        // the wall clock moves between the call and the assertion.
        Assert.InRange(delivery.NextRetryAt!.Value, before.AddSeconds(55), before.AddSeconds(70));
    }

    [Fact]
    public async Task Backoffs_lengthen_in_the_documented_order()
    {
        var (endpoint, _) = Fixture(Guid.NewGuid());
        var sender = Sender(new ScriptedHandler(Enumerable.Repeat((HttpStatusCode?)HttpStatusCode.BadGateway, 6).ToArray()));

        var gaps = new List<TimeSpan>();
        for (var i = 0; i < 5; i++)
        {
            var (_, delivery) = Fixture(endpoint.TenantId);
            var at = DateTimeOffset.UtcNow;
            await sender.AttemptAsync(delivery, endpoint, delivery.RequestBody, default);
            gaps.Add(delivery.NextRetryAt!.Value - at);
        }

        Assert.Equal(
            new[] { 1.0, 5.0, 30.0, 120.0, 720.0 },
            gaps.Select(g => Math.Round(g.TotalMinutes)).ToArray());
    }

    [Fact]
    public async Task Success_clears_the_failure_count_and_the_retry()
    {
        var (endpoint, delivery) = Fixture(Guid.NewGuid());
        endpoint.FailureCount = 3;

        await Sender(new ScriptedHandler(HttpStatusCode.OK))
            .AttemptAsync(delivery, endpoint, delivery.RequestBody, default);

        Assert.Equal("delivered", delivery.FinalState);
        Assert.Null(delivery.NextRetryAt);
        Assert.Equal(0, endpoint.FailureCount);
        Assert.NotNull(endpoint.LastSuccessAt);
    }

    [Fact]
    public async Task The_endpoint_is_auto_disabled_after_the_documented_number_of_failures()
    {
        var (endpoint, _) = Fixture(Guid.NewGuid());
        var sender = Sender(new ScriptedHandler(Enumerable.Repeat((HttpStatusCode?)HttpStatusCode.BadGateway, 6).ToArray()));

        WebhookDelivery? last = null;
        for (var i = 0; i < WebhookSender.Backoffs.Length; i++)
        {
            var (_, delivery) = Fixture(endpoint.TenantId);
            await sender.AttemptAsync(delivery, endpoint, delivery.RequestBody, default);
            last = delivery;
        }

        Assert.False(endpoint.Enabled);
        Assert.Equal("abandoned", last!.FinalState);
        Assert.Null(last.NextRetryAt);
    }

    /// <summary>
    /// A connection that never opens is still a transient failure — a receiver that is
    /// down is the case retries exist for.
    /// </summary>
    [Fact]
    public async Task A_connection_failure_is_retried()
    {
        var (endpoint, delivery) = Fixture(Guid.NewGuid());

        await Sender(new ScriptedHandler([null])).AttemptAsync(delivery, endpoint, delivery.RequestBody, default);

        Assert.Equal("pending", delivery.FinalState);
        Assert.NotNull(delivery.NextRetryAt);
    }

    /// <summary>
    /// A blocked destination is not transient. Retrying it six times over 41 hours
    /// re-runs a decision that cannot change and buries the reason under a retry
    /// history — so it is abandoned at once, exactly as a missing template variable is.
    /// </summary>
    [Fact]
    public async Task A_blocked_destination_is_abandoned_immediately_rather_than_retried()
    {
        var (endpoint, delivery) = Fixture(Guid.NewGuid());
        var handler = new BlockingHandler();

        await Sender(handler).AttemptAsync(delivery, endpoint, delivery.RequestBody, default);

        Assert.Equal("abandoned", delivery.FinalState);
        Assert.Null(delivery.NextRetryAt);
        Assert.False(endpoint.Enabled);
        Assert.Equal(1, handler.Attempts);
    }

    // ---- The sweep ---------------------------------------------------------

    private static WebhookRetryWorker WorkerFor(TestHost host, HttpMessageHandler handler)
    {
        var services = new ServiceCollection();
        services.AddSingleton(host.Services.GetRequiredService<IServiceScopeFactory>());
        return new WebhookRetryWorker(host.Services, Sender(handler), NullLogger<WebhookRetryWorker>.Instance);
    }

    private static async Task<(WebhookEndpoint, WebhookDelivery)> SeedDueAsync(TestHost host, DateTimeOffset dueAt)
    {
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var (endpoint, delivery) = Fixture(host.Tenant.Id);
        delivery.EndpointId = endpoint.Id;
        delivery.FinalState = "pending";
        delivery.NextRetryAt = dueAt;

        db.WebhookEndpoints.Add(endpoint);
        db.WebhookDeliveries.Add(delivery);
        await db.SaveChangesAsync();

        return (endpoint, delivery);
    }

    [Fact]
    public async Task A_due_delivery_is_re_sent_and_marked_delivered()
    {
        await using var host = await TestHost.CreateAsync();
        var (_, delivery) = await SeedDueAsync(host, DateTimeOffset.UtcNow.AddMinutes(-1));

        var handler = new ScriptedHandler(HttpStatusCode.OK);
        Assert.Equal(1, await WorkerFor(host, handler).SweepAsync(default));
        Assert.Single(handler.Requests);

        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var row = await db.WebhookDeliveries.SingleAsync(d => d.Id == delivery.Id);

        Assert.Equal("delivered", row.FinalState);
        Assert.Null(row.NextRetryAt);
    }

    /// <summary>The backoff must actually hold the delivery back — that is the point of it.</summary>
    [Fact]
    public async Task A_delivery_whose_backoff_has_not_elapsed_is_left_alone()
    {
        await using var host = await TestHost.CreateAsync();
        await SeedDueAsync(host, DateTimeOffset.UtcNow.AddMinutes(5));

        var handler = new ScriptedHandler(HttpStatusCode.OK);
        Assert.Equal(0, await WorkerFor(host, handler).SweepAsync(default));
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task A_delivered_row_is_never_re_sent()
    {
        await using var host = await TestHost.CreateAsync();
        var (_, delivery) = await SeedDueAsync(host, DateTimeOffset.UtcNow.AddMinutes(-1));

        using (var scope = host.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.WebhookDeliveries.SingleAsync(d => d.Id == delivery.Id);
            row.FinalState = "delivered";
            await db.SaveChangesAsync();
        }

        var handler = new ScriptedHandler(HttpStatusCode.OK);
        Assert.Equal(0, await WorkerFor(host, handler).SweepAsync(default));
        Assert.Empty(handler.Requests);
    }

    /// <summary>
    /// A day-old delivery coming due must not resurrect an endpoint an admin turned
    /// off. Abandon it instead — that is the right way round.
    /// </summary>
    [Fact]
    public async Task A_delivery_for_a_disabled_endpoint_is_abandoned_not_sent()
    {
        await using var host = await TestHost.CreateAsync();
        var (endpoint, delivery) = await SeedDueAsync(host, DateTimeOffset.UtcNow.AddMinutes(-1));

        using (var scope = host.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.WebhookEndpoints.SingleAsync(e => e.Id == endpoint.Id);
            row.Enabled = false;
            await db.SaveChangesAsync();
        }

        var handler = new ScriptedHandler(HttpStatusCode.OK);
        Assert.Equal(0, await WorkerFor(host, handler).SweepAsync(default));
        Assert.Empty(handler.Requests);

        using (var scope = host.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.WebhookDeliveries.SingleAsync(d => d.Id == delivery.Id);
            Assert.Equal("abandoned", row.FinalState);
            Assert.Null(row.NextRetryAt);
        }
    }

    /// <summary>
    /// The end-to-end shape the mechanism exists for: a receiver is down, comes back,
    /// and the event is delivered rather than lost.
    /// </summary>
    [Fact]
    public async Task A_receiver_that_recovers_gets_the_event()
    {
        await using var host = await TestHost.CreateAsync();
        var (_, delivery) = await SeedDueAsync(host, DateTimeOffset.UtcNow.AddMinutes(-1));

        var handler = new ScriptedHandler(HttpStatusCode.ServiceUnavailable, HttpStatusCode.OK);
        var worker = WorkerFor(host, handler);

        Assert.Equal(1, await worker.SweepAsync(default));

        // The first sweep re-scheduled it a minute out. Pull that forward rather than
        // waiting — the schedule is asserted elsewhere; this is about the outcome.
        using (var scope = host.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.WebhookDeliveries.SingleAsync(d => d.Id == delivery.Id);
            Assert.Equal("pending", row.FinalState);
            row.NextRetryAt = DateTimeOffset.UtcNow.AddSeconds(-1);
            await db.SaveChangesAsync();
        }

        Assert.Equal(1, await worker.SweepAsync(default));

        using (var scope = host.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.WebhookDeliveries.SingleAsync(d => d.Id == delivery.Id);
            Assert.Equal("delivered", row.FinalState);
            Assert.Equal(2, handler.Requests.Count);
        }
    }

    // ---- R23: the owner is told --------------------------------------------

    private static async Task<List<AdminNotification>> DisableNoticesAsync(TestHost host)
    {
        using var scope = host.NewScope();
        return await scope.ServiceProvider.GetRequiredService<MainframeDbContext>().AdminNotifications
            .IgnoreQueryFilters().Where(n => n.Kind == AdminEventCatalogue.WebhookAutoDisabled).ToListAsync();
    }

    /// <summary>
    /// The sixth failure switches a club endpoint off, and the admins are mailed — the email to
    /// the owner <c>webhooks.md</c> documented and nothing sent. Staged in the sweep's own save,
    /// so the disable and the notice cannot come apart; and named by host only, never the path.
    /// </summary>
    [Fact]
    public async Task The_sixth_failure_switches_a_club_endpoint_off_and_the_admins_are_told_once()
    {
        await using var host = await TestHost.CreateAsync();
        var (endpoint, _) = await SeedDueAsync(host, DateTimeOffset.UtcNow.AddMinutes(-1));
        using (var scope = host.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.WebhookEndpoints.SingleAsync(e => e.Id == endpoint.Id);
            row.FailureCount = WebhookSender.Backoffs.Length - 1;
            row.Description = "Results board";
            await db.SaveChangesAsync();
        }

        await WorkerFor(host, new ScriptedHandler(HttpStatusCode.InternalServerError)).SweepAsync(default);

        var notice = Assert.Single(await DisableNoticesAsync(host));
        Assert.Equal(host.Tenant.Id, notice.TenantId);
        await host.DeliverAdminNoticesAsync();
        await host.DeliverAdminNoticesAsync();

        var mail = Assert.Single(host.EmailService.Sent);
        Assert.Equal(host.AdminUser.Email, mail.To);
        Assert.Equal("A webhook has been switched off", mail.Subject);
        Assert.Contains("https://hooks.example.com", mail.HtmlBody, StringComparison.Ordinal);
        // The destination's path (the receiver's own) is never in the mail. Probed with the host in
        // front: the club's console link now carries the club's slug in its host (BP-03), and a
        // bare "/crusaders" matched "//crusaders.localhost".
        Assert.DoesNotContain("hooks.example.com/crusaders", mail.HtmlBody, StringComparison.Ordinal);
        Assert.Contains("failed 6 deliveries", MailText.Unwrap(mail.PlainBody), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_failure_that_only_schedules_a_retry_tells_nobody()
    {
        await using var host = await TestHost.CreateAsync();
        await SeedDueAsync(host, DateTimeOffset.UtcNow.AddMinutes(-1));

        await WorkerFor(host, new ScriptedHandler(HttpStatusCode.InternalServerError)).SweepAsync(default);

        Assert.Empty(await DisableNoticesAsync(host));
    }

    /// <summary>
    /// A member's own endpoint is the member's: switching it off is not reported to every admin.
    /// </summary>
    [Fact]
    public async Task A_members_endpoint_switched_off_is_not_reported_to_the_admins()
    {
        await using var host = await TestHost.CreateAsync();
        var (endpoint, _) = await SeedDueAsync(host, DateTimeOffset.UtcNow.AddMinutes(-1));
        using (var scope = host.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.WebhookEndpoints.SingleAsync(e => e.Id == endpoint.Id);
            row.FailureCount = WebhookSender.Backoffs.Length - 1;
            row.OwnerKind = WebhookOwnerKind.User;
            row.OwnerUserId = host.PlayerUser.Id;
            await db.SaveChangesAsync();
        }

        await WorkerFor(host, new ScriptedHandler(HttpStatusCode.InternalServerError)).SweepAsync(default);

        Assert.Empty(await DisableNoticesAsync(host));
    }

    // ---- First delivery: durable before the attempt, endpoints in parallel (BP-08) ----

    /// <summary>A transport that holds every request until released, counting how many wait at once.</summary>
    private sealed class GateHandler : HttpMessageHandler
    {
        private readonly TaskCompletionSource _open = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _waiting;

        public int MaxWaiting { get; private set; }

        public void Open() => _open.TrySetResult();

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            lock (this) { _waiting++; MaxWaiting = Math.Max(MaxWaiting, _waiting); }
            try
            {
                await _open.Task.WaitAsync(ct);
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("ok") };
            }
            finally
            {
                lock (this) _waiting--;
            }
        }
    }

    private static WebhookDeliveryWorker DeliveryWorkerFor(TestHost host, HttpMessageHandler handler) =>
        new(new InMemoryEventBus(), host.Services, Sender(handler), NullLogger<WebhookDeliveryWorker>.Instance);

    private static DomainEvent EventFor(TestHost host) => new(
        Guid.NewGuid().ToString(), "booking.created", host.Tenant.Id, host.Tenant.Slug, DateTimeOffset.UtcNow,
        host.PlayerUser.Id, false, host.PlayerUser.Id, new Dictionary<string, object?>());

    private static async Task<List<WebhookEndpoint>> SeedEndpointsAsync(TestHost host, int count)
    {
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var made = Enumerable.Range(0, count).Select(i => new WebhookEndpoint
        {
            TenantId = host.Tenant.Id,
            OwnerKind = WebhookOwnerKind.Tenant,
            UrlTemplate = $"https://hooks{i}.example.com/crusaders",
            EventFilter = "*",
            Secret = "test-secret",
        }).ToList();
        db.WebhookEndpoints.AddRange(made);
        await db.SaveChangesAsync();
        return made;
    }

    /// <summary>
    /// A process that dies while the first attempt is out loses nothing: the delivery row was
    /// saved pending, due for the retry sweep, before anything was sent. It used to be saved
    /// only after the whole loop, so a deploy mid-fan-out dropped the event for every endpoint.
    /// </summary>
    [Fact]
    public async Task A_dispatch_interrupted_mid_attempt_leaves_a_pending_row_the_sweep_delivers()
    {
        await using var host = await TestHost.CreateAsync();
        await SeedEndpointsAsync(host, 1);
        var gate = new GateHandler();
        using var crash = new CancellationTokenSource();

        var dispatch = DeliveryWorkerFor(host, gate).DispatchAsync(EventFor(host), crash.Token);
        await WaitUntilAsync(() => gate.MaxWaiting == 1);
        crash.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => dispatch);

        using (var scope = host.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.WebhookDeliveries.SingleAsync();
            Assert.Equal("pending", row.FinalState);
            Assert.NotNull(row.NextRetryAt);
            Assert.InRange(row.NextRetryAt!.Value, DateTimeOffset.UtcNow.AddSeconds(30), DateTimeOffset.UtcNow.Add(WebhookDeliveryWorker.FirstAttemptGrace));
            row.NextRetryAt = DateTimeOffset.UtcNow.AddSeconds(-1); // the grace has passed
            await db.SaveChangesAsync();
        }

        var handler = new ScriptedHandler(HttpStatusCode.OK);
        Assert.Equal(1, await WorkerFor(host, handler).SweepAsync(default));
        using var check = host.NewScope();
        Assert.Equal("delivered", (await check.ServiceProvider.GetRequiredService<MainframeDbContext>().WebhookDeliveries.SingleAsync()).FinalState);
    }

    /// <summary>
    /// One slow receiver no longer holds the others: every endpoint's attempt for an event is out
    /// at once (they were awaited one after another, ten seconds each at worst).
    /// </summary>
    [Fact]
    public async Task Every_endpoint_of_an_event_is_attempted_at_once_and_each_row_finishes_delivered()
    {
        await using var host = await TestHost.CreateAsync();
        await SeedEndpointsAsync(host, 3);
        var gate = new GateHandler();

        var dispatch = DeliveryWorkerFor(host, gate).DispatchAsync(EventFor(host), default);
        await WaitUntilAsync(() => gate.MaxWaiting == 3);
        gate.Open();
        await dispatch;

        using var scope = host.NewScope();
        var rows = await scope.ServiceProvider.GetRequiredService<MainframeDbContext>().WebhookDeliveries.ToListAsync();
        Assert.Equal(3, rows.Count);
        Assert.All(rows, r => { Assert.Equal("delivered", r.FinalState); Assert.Null(r.NextRetryAt); });
    }

    /// <summary>A member-owned endpoint left in a database from before BP-08 receives nothing.</summary>
    [Fact]
    public async Task A_member_owned_endpoint_is_never_delivered_to()
    {
        await using var host = await TestHost.CreateAsync();
        var endpoints = await SeedEndpointsAsync(host, 1);
        using (var scope = host.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.WebhookEndpoints.SingleAsync(e => e.Id == endpoints[0].Id);
            row.OwnerKind = WebhookOwnerKind.User;
            row.OwnerUserId = host.PlayerUser.Id;
            await db.SaveChangesAsync();
        }

        var handler = new ScriptedHandler(HttpStatusCode.OK);
        await DeliveryWorkerFor(host, handler).DispatchAsync(EventFor(host), default);

        Assert.Empty(handler.Requests);
        using var check = host.NewScope();
        Assert.Empty(await check.ServiceProvider.GetRequiredService<MainframeDbContext>().WebhookDeliveries.ToListAsync());
    }

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        for (var i = 0; i < 200 && !condition(); i++) await Task.Delay(25);
        Assert.True(condition(), "the condition never held within 5 s");
    }

    [Fact]
    public async Task A_blocked_destination_is_reported_as_blocked()
    {
        var (endpoint, delivery) = Fixture(Guid.NewGuid());
        var outcome = await Sender(new BlockingHandler()).AttemptAsync(delivery, endpoint, delivery.RequestBody, default);

        Assert.Equal(WebhookAttemptOutcome.DisabledBlocked, outcome);
        Assert.Equal("https://hooks.example.com", WebhookSender.DestinationOf("https://hooks.example.com/x/y?token=secret"));
        Assert.Equal("http://10.0.0.4:8080", WebhookSender.DestinationOf("http://10.0.0.4:8080/relay"));
    }
}

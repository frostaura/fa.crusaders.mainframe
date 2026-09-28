using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Services.Realtime;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// D2-B07 end to end, against a real transaction rather than against the outbox's own unit
/// tests.
///
/// <para>
/// The unit tests in <see cref="RealtimeOutboxTests"/> pin what the outbox does when it is told
/// a transaction committed or rolled back. They cannot pin that <see cref="PayerLock"/> tells
/// it — and the wiring is the whole bug. This drives a real advisory-locked transaction on
/// Postgres, because the in-memory provider has no transactions at all and would report the
/// opposite (<c>memory/gotchas.md</c>: a concurrency test on the in-memory provider proves the
/// opposite of what it claims).
/// </para>
/// </summary>
public sealed class PayerLockPublishTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public PayerLockPublishTests(PostgresFixture pg) => _pg = pg;

    private sealed record Seeded(Guid TenantId, string Slug, Guid MemberUserId);

    private static async Task<Seeded> SeedAsync(TestWebAppFactory factory)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"pl-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant { Slug = slug, DisplayName = "Payer Lock Club" };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = "{}" });

        var member = new User
        {
            TenantId = tenant.Id, Email = $"{slug}@test.local", PasswordHash = "x", EmailVerified = true,
        };
        db.Users.Add(member);
        await db.SaveChangesAsync();

        return new Seeded(tenant.Id, slug, member.Id);
    }

    /// <summary>
    /// The finding. A ledger row posted inside a <see cref="PayerLock"/> that is never committed
    /// leaves the database untouched — and must leave the member's live wallet untouched too.
    /// Before the fix the balance frame and every webhook went out the moment
    /// <c>SaveChangesAsync</c> returned, which on this path is inside the uncommitted
    /// transaction: the chip showed money that did not move, and stayed wrong until something
    /// unrelated posted.
    /// </summary>
    [SkippableFact]
    public async Task A_rolled_back_payer_lock_publishes_no_balance()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };
        var seeded = await SeedAsync(factory);

        var bus = factory.Services.GetRequiredService<IRealtimeBus>();
        var topic = RealtimeTopic.Wallet(seeded.TenantId, seeded.MemberUserId);
        var channel = bus.Subscribe(topic);

        try
        {
            using var scope = factory.Services.CreateScope();
            scope.ServiceProvider.GetRequiredService<ITenantContext>().Set(seeded.TenantId, seeded.Slug);
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
            var outbox = scope.ServiceProvider.GetRequiredService<RealtimeOutbox>();

            await using (await PayerLock.BeginAsync(db, seeded.TenantId, seeded.MemberUserId, outbox, default))
            {
                await ledger.PostAsync(new LedgerPosting(
                    UserId: seeded.MemberUserId,
                    Type: LedgerEntryType.TopUp,
                    AmountCredits: 500m,
                    ActorUserId: seeded.MemberUserId,
                    Reason: "a movement that is about to be rolled back"), default);

                // The save has happened. Nothing may have been told about it yet.
                Assert.False(channel.Reader.TryRead(out _),
                    "the balance was published from inside an uncommitted transaction");
                Assert.Equal(1, outbox.PendingCount);

                // No CommitAsync: disposing rolls it back, which is what every refusal path does.
            }

            Assert.False(channel.Reader.TryRead(out _),
                "a rolled-back movement was published to the member's live wallet");

            // And the ledger agrees with the stream, which is the only state worth having.
            using var check = factory.Services.CreateScope();
            var fresh = check.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Empty(await fresh.LedgerEntries.IgnoreQueryFilters()
                .Where(l => l.UserId == seeded.MemberUserId).ToListAsync());
        }
        finally
        {
            bus.Unsubscribe(topic, channel);
        }
    }

    /// <summary>
    /// The other half, and the one that would hide a fix that simply never published: a
    /// committed lock publishes <b>exactly once</b>, and the named frame carries the delta and
    /// the reason GOAL item 8 asks the badge to animate on.
    /// </summary>
    [SkippableFact]
    public async Task A_committed_payer_lock_publishes_once_with_the_delta_and_the_reason()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };
        var seeded = await SeedAsync(factory);

        var bus = factory.Services.GetRequiredService<IRealtimeBus>();
        var topic = RealtimeTopic.Wallet(seeded.TenantId, seeded.MemberUserId);
        var channel = bus.Subscribe(topic);

        try
        {
            using var scope = factory.Services.CreateScope();
            scope.ServiceProvider.GetRequiredService<ITenantContext>().Set(seeded.TenantId, seeded.Slug);
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
            var outbox = scope.ServiceProvider.GetRequiredService<RealtimeOutbox>();

            await using (var payerLock = await PayerLock.BeginAsync(
                db, seeded.TenantId, seeded.MemberUserId, outbox, default))
            {
                await ledger.PostAsync(new LedgerPosting(
                    UserId: seeded.MemberUserId,
                    Type: LedgerEntryType.TopUp,
                    AmountCredits: 500m,
                    ActorUserId: seeded.MemberUserId,
                    Reason: "a movement that commits"), default);

                await payerLock.CommitAsync(default);
            }

            var frames = new List<RealtimeMessage>();
            while (channel.Reader.TryRead(out var frame)) frames.Add(frame);

            // Two frames for one movement: the legacy unnamed one today's client listens for,
            // and the named one item 8 needs. Not two movements.
            Assert.Equal(2, frames.Count);

            var legacy = Assert.Single(frames, f => f.Event.Length == 0);
            Assert.Contains("\"balance_credits\":500", legacy.JsonPayload);

            var named = Assert.Single(frames, f => f.Event == LedgerService.BalanceEvent);
            Assert.Contains("\"delta_credits\":500", named.JsonPayload);
            Assert.Contains("\"reason\":\"top_up\"", named.JsonPayload);
        }
        finally
        {
            bus.Unsubscribe(topic, channel);
        }
    }
}

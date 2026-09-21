using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services.Realtime;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The seam that decides whether the world is told about money that moved, or money that was
/// about to.
///
/// <para>
/// <b>D2-B07.</b> <c>LedgerService</c> published the member's balance and mirrored every webhook
/// the moment <c>SaveChangesAsync</c> returned — and on the four <c>PayerLock</c> paths that
/// save is inside an uncommitted transaction. A rollback then left the member's wallet chip and
/// every webhook consumer asserting a movement that never happened, and the chip stayed wrong
/// until something unrelated posted. Nothing retracts a webhook.
/// </para>
/// </summary>
public class RealtimeOutboxTests
{
    private static Task<int> CountingAsync(RealtimeOutbox outbox, List<string> published, string name)
        => Task.FromResult(0).ContinueWith(async _ =>
        {
            await outbox.EnqueueAsync(_ => { published.Add(name); return Task.CompletedTask; }, default);
            return 0;
        }).Unwrap();

    /// <summary>With no transaction open — the admin adjust path, the ITN — nothing changes.</summary>
    [Fact]
    public async Task Outside_a_transaction_an_enqueue_publishes_immediately()
    {
        var outbox = new RealtimeOutbox();
        var published = new List<string>();

        await CountingAsync(outbox, published, "now");

        Assert.Equal(["now"], published);
        Assert.Equal(0, outbox.PendingCount);
    }

    /// <summary>Inside one, nothing reaches anybody until the commit.</summary>
    [Fact]
    public async Task Inside_a_transaction_nothing_is_published_until_the_commit()
    {
        var outbox = new RealtimeOutbox();
        var published = new List<string>();

        outbox.Enter();
        await CountingAsync(outbox, published, "balance");
        await CountingAsync(outbox, published, "webhook");

        Assert.Empty(published);
        Assert.Equal(2, outbox.PendingCount);

        await outbox.LeaveAsync(committed: true, default);

        Assert.Equal(["balance", "webhook"], published);
        Assert.Equal(0, outbox.PendingCount);
    }

    /// <summary>
    /// The finding itself: a rolled-back unit of work publishes <b>nothing</b>. Not a
    /// correction, not a retraction — nothing, because there is nothing to say.
    /// </summary>
    [Fact]
    public async Task A_rolled_back_transaction_publishes_nothing()
    {
        var outbox = new RealtimeOutbox();
        var published = new List<string>();

        outbox.Enter();
        await CountingAsync(outbox, published, "balance");
        await outbox.LeaveAsync(committed: false, default);

        Assert.Empty(published);
        Assert.Equal(0, outbox.PendingCount);
    }

    /// <summary>
    /// Locks nest, because <c>PayerLock.BeginAsync</c> joins an ambient transaction rather than
    /// opening a second one. Only the outermost frame publishes.
    /// </summary>
    [Fact]
    public async Task Only_the_outermost_transaction_publishes()
    {
        var outbox = new RealtimeOutbox();
        var published = new List<string>();

        outbox.Enter();
        outbox.Enter();
        await CountingAsync(outbox, published, "inner");
        await outbox.LeaveAsync(committed: true, default);

        Assert.Empty(published);

        await CountingAsync(outbox, published, "outer");
        await outbox.LeaveAsync(committed: true, default);

        Assert.Equal(["inner", "outer"], published);
    }

    /// <summary>
    /// And a nested rollback poisons the whole queue, because a nested lock's rollback takes the
    /// outer transaction down with it — they are one transaction. Publishing the outer frames
    /// would describe a commit that did not happen.
    /// </summary>
    [Fact]
    public async Task A_nested_rollback_discards_the_outer_frames_too()
    {
        var outbox = new RealtimeOutbox();
        var published = new List<string>();

        outbox.Enter();
        await CountingAsync(outbox, published, "outer");
        outbox.Enter();
        await CountingAsync(outbox, published, "inner");
        await outbox.LeaveAsync(committed: false, default);
        await outbox.LeaveAsync(committed: true, default);

        Assert.Empty(published);
    }

    /// <summary>
    /// A channel write that throws must not fail the money path. The booking is already
    /// committed by the time the drain runs; turning a slow socket into a 500 would tell a
    /// member who paid for a court that they did not get it.
    /// </summary>
    [Fact]
    public async Task A_failing_publish_does_not_escape_the_drain()
    {
        var outbox = new RealtimeOutbox();
        var published = new List<string>();

        outbox.Enter();
        await outbox.EnqueueAsync(_ => throw new InvalidOperationException("socket gone"), default);
        await CountingAsync(outbox, published, "after");

        await outbox.LeaveAsync(committed: true, default);

        Assert.Equal(["after"], published);
    }
}

/// <summary>
/// The bus itself: tenant isolation as a structural property of the KEY, and no leaked
/// dictionary entries.
/// </summary>
public class RealtimeBusTests
{
    private static RealtimeMessage Frame(decimal balance)
        => new(string.Empty, JsonSerializer.Serialize(new { balance_credits = balance }));

    /// <summary>
    /// <b>D2-B22, and the test shape D2 §8.5 asks for: assert SILENCE, not a different payload.</b>
    /// Two clubs, the same user id — which is impossible with GUIDs and is exactly the point,
    /// because isolation here must be structural rather than a collision argument. Tenant A's
    /// subscriber receives nothing at all when tenant B publishes.
    /// </summary>
    [Fact]
    public void A_topic_is_silent_when_another_tenant_publishes_on_the_same_subject()
    {
        var bus = new InProcessRealtimeBus();
        var userId = Guid.NewGuid();
        var clubA = RealtimeTopic.Wallet(Guid.NewGuid(), userId);
        var clubB = RealtimeTopic.Wallet(Guid.NewGuid(), userId);

        var channel = bus.Subscribe(clubA);
        bus.Publish(clubB, Frame(1000m));

        Assert.False(channel.Reader.TryRead(out _), "a frame published by another club reached this club's stream");
    }

    /// <summary>The same for the two club-wide scopes, which carry no subject at all.</summary>
    [Theory]
    [InlineData(RealtimeScope.ControlBoard)]
    [InlineData(RealtimeScope.Monitoring)]
    public void A_club_wide_topic_is_silent_when_another_club_publishes(RealtimeScope scope)
    {
        var bus = new InProcessRealtimeBus();
        var mine = new RealtimeTopic(Guid.NewGuid(), scope, null);
        var theirs = new RealtimeTopic(Guid.NewGuid(), scope, null);

        var channel = bus.Subscribe(mine);
        bus.Publish(theirs, new RealtimeMessage("snapshot", "{}"));

        Assert.False(channel.Reader.TryRead(out _));
    }

    /// <summary>And one scope does not hear another's traffic inside the same club.</summary>
    [Fact]
    public void One_scope_does_not_hear_another()
    {
        var bus = new InProcessRealtimeBus();
        var tenantId = Guid.NewGuid();

        var wallet = bus.Subscribe(RealtimeTopic.Wallet(tenantId, Guid.NewGuid()));
        bus.Publish(RealtimeTopic.ControlBoard(tenantId), new RealtimeMessage("court", "{}"));

        Assert.False(wallet.Reader.TryRead(out _));
    }

    /// <summary>
    /// <b>D2-B44.</b> <c>BalanceBroadcaster.Unsubscribe</c> removed the channel and never the
    /// key, in a singleton — one dictionary entry per member who ever opened the app, for the
    /// life of the process.
    /// </summary>
    [Fact]
    public void Unsubscribing_the_last_subscriber_removes_the_topic()
    {
        var bus = new InProcessRealtimeBus();
        var topic = RealtimeTopic.Wallet(Guid.NewGuid(), Guid.NewGuid());

        var first = bus.Subscribe(topic);
        var second = bus.Subscribe(topic);
        Assert.Equal(2, bus.SubscriberCount(topic));

        bus.Unsubscribe(topic, first);
        Assert.Equal(1, bus.SubscriberCount(topic));

        bus.Unsubscribe(topic, second);
        Assert.Equal(0, bus.SubscriberCount(topic));

        // The assertion that actually discriminates. SubscriberCount answers zero for an empty
        // list AND for an absent key, so it cannot tell a released subscription from a leaked
        // entry — which is the whole of D2-B44.
        Assert.Equal(0, bus.TopicCount);

        // And publishing to a topic nobody holds is a no-op rather than a resurrection.
        bus.Publish(topic, Frame(1m));
        Assert.Equal(0, bus.TopicCount);
    }
}

/// <summary>
/// Who a webhook says performed a movement.
///
/// <para>
/// <b>D2-B41.</b> <c>ActorIsAdmin: entry.ActorUserId != entry.UserId</c> is wrong in both
/// directions. Every system posting carries <c>ActorUserId = Guid.Empty</c>, so every no-show
/// penalty, every reversal leg, every displacement refund went out as
/// <c>actor.is_admin: true</c> with an all-zero actor id — a phantom administrator issuing every
/// automatic penalty the club has ever applied, to any consumer reconciling by actor.
/// </para>
/// </summary>
public class LedgerActorTests
{
    private static LedgerEntry Entry(Guid actor, Guid subject) => new()
    {
        TenantId = Guid.NewGuid(),
        UserId = subject,
        ActorUserId = actor,
        Type = LedgerEntryType.NoShowPenalty,
        AmountCredits = -3m,
    };

    /// <summary>The finding: a system posting is a system posting, not an admin.</summary>
    [Fact]
    public void A_system_posting_has_no_actor_and_is_not_an_admin()
    {
        var (actorUserId, actorIsAdmin) =
            Crusaders.Mainframe.Api.Services.LedgerService.ActorOf(Entry(Guid.Empty, Guid.NewGuid()));

        Assert.Null(actorUserId);
        Assert.False(actorIsAdmin);
    }

    /// <summary>A member's own movement names them and claims nothing.</summary>
    [Fact]
    public void A_members_own_movement_is_not_an_admin_action()
    {
        var member = Guid.NewGuid();
        var (actorUserId, actorIsAdmin) = Crusaders.Mainframe.Api.Services.LedgerService.ActorOf(Entry(member, member));

        Assert.Equal(member, actorUserId);
        Assert.False(actorIsAdmin);
    }

    /// <summary>And a real actor acting on somebody else is named and reported as such.</summary>
    [Fact]
    public void A_desk_movement_names_the_person_who_made_it()
    {
        var admin = Guid.NewGuid();
        var (actorUserId, actorIsAdmin) = Crusaders.Mainframe.Api.Services.LedgerService.ActorOf(
            Entry(admin, Guid.NewGuid()));

        Assert.Equal(admin, actorUserId);
        Assert.True(actorIsAdmin);
    }
}

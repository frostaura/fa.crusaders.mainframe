using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 13, E13-2: a <c>minutes.*</c> webhook's <c>actor.is_admin</c> is the actor's ROLE,
/// read, never "the actor is somebody other than the wallet's owner". A member paying for another
/// member's court at the box moved somebody else's money and is not an administrator; the
/// box pay-for's <c>minutes.refunded</c> said <c>is_admin: true</c> for them.
/// </summary>
public class R13LedgerActorRoleTests
{
    private static List<DomainEvent> Drain(TestHost host)
    {
        var bus = host.Services.GetRequiredService<IEventBus>();
        var emitted = new List<DomainEvent>();
        while (bus.Reader.TryRead(out var evt)) emitted.Add(evt);
        return emitted;
    }

    /// <summary>A refund to one member, moved by another member who is no admin: named, and not an admin.</summary>
    [Fact]
    public async Task A_member_moving_another_members_minutes_is_not_reported_as_an_admin()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        Drain(host);

        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.CancellationRefund, 30, host.LeaguePlayerUser.Id,
            Reason: "Refunded — paid for at the box"), default);

        var evt = Assert.Single(Drain(host), e => e.Type == MinutesEvents.Refunded);
        Assert.Equal(host.LeaguePlayerUser.Id, evt.ActorUserId);
        Assert.False(evt.ActorIsAdmin);
    }

    /// <summary>The same movement through the batch path — one pay-for posts several rows at once.</summary>
    [Fact]
    public async Task The_batch_path_reads_the_role_too()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        Drain(host);

        await ledger.PostManyAsync(
        [
            new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.CancellationRefund, 30, host.LeaguePlayerUser.Id),
            new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.LateCancellationPenalty, -5, host.AdminUser.Id),
        ], default);

        var events = Drain(host);
        Assert.False(Assert.Single(events, e => e.Type == MinutesEvents.Refunded).ActorIsAdmin);
        Assert.True(Assert.Single(events, e => e.Type == MinutesEvents.PenaltyApplied).ActorIsAdmin);
    }

    /// <summary>An administrator moving their OWN minutes acted as an administrator all the same — the role is the test.</summary>
    [Fact]
    public async Task An_admin_is_an_admin_on_their_own_wallet_too()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        Drain(host);

        await ledger.PostAsync(new LedgerPosting(
            host.AdminUser.Id, LedgerEntryType.AdminAdjustment, 10, host.AdminUser.Id), default);

        var evt = Assert.Single(Drain(host), e => e.Type == MinutesEvents.Adjusted);
        Assert.Equal(host.AdminUser.Id, evt.ActorUserId);
        Assert.True(evt.ActorIsAdmin);
    }
}

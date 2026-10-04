using System.Collections.Concurrent;

namespace Crusaders.Mainframe.Api.Services.Realtime;

/// <summary>
/// One live wallet frame before it is sent: what moved, why, and the rows behind it. Built by
/// <see cref="LedgerService"/> for every movement; a held one is merged with the frames that follow
/// it for the same member and booking (review round 12, X12-1, contract C1).
/// </summary>
public sealed record WalletFrame(
    int DeltaMinutes, string Reason, IReadOnlyList<BalancePart> Parts, ShareWhy? Share, bool MoneyIn)
{
    /// <summary>On a cancellation's movements: <see cref="WalletCancelledBy"/> — who cancelled. Null elsewhere.</summary>
    public string? CancelledBy { get; init; }

    /// <summary>On a late check-in's reversal (and its share): the member whose scan reversed it (R12 E12-2, C2).</summary>
    public Guid? CheckedInBy { get; init; }

    /// <summary>
    /// This frame and a later one for the same member as ONE: the first frame's reason is the
    /// primary one, the delta is the net, and the parts are every row in order.
    /// </summary>
    public WalletFrame Merge(WalletFrame later)
    {
        return this with
        {
            DeltaMinutes = DeltaMinutes + later.DeltaMinutes,
            Parts = [.. Parts, .. later.Parts],
            Share = Share ?? later.Share,
            MoneyIn = MoneyIn || later.MoneyIn,
            CancelledBy = CancelledBy ?? later.CancelledBy,
            CheckedInBy = CheckedInBy ?? later.CheckedInBy,
        };
    }
}

/// <summary>Who cancelled, on a cancellation's wallet frame (contract C1). Club = an admin or the system.</summary>
public static class WalletCancelledBy
{
    public const string Club = "club";
    public const string Member = "member";
}

/// <summary>
/// Holds the live wallet frames one ACTION produces across several units of work, so the member
/// is told once (review round 12, X12-1).
///
/// <para>
/// <b>Why it exists.</b> A cancellation of a shared booking posts the organiser's refund in its own
/// save, and the share going back to the partner follows in a fresh scope (<see cref="ShareHook"/>)
/// — two commits, two frames, two toasts 70 ms apart: "A cancelled booking put 32 minutes back",
/// then "16 minutes went back to a partner". The endpoint that performs the action opens a hold on
/// the booking; every frame for that booking — from any scope, after its own commit — is merged
/// per member instead of sent; closing the hold sends one frame each.
/// </para>
///
/// <para>
/// <b>A singleton, keyed by (tenant, booking).</b> Scoped state cannot see the follow-up's scope.
/// A frame is held only when every row behind it names that booking, so an unrelated movement of
/// the same member in the same instant is never folded in. Only one hold per booking: a second,
/// concurrent action on it (which loses its race anyway) holds nothing and sends as before.
/// </para>
/// </summary>
public sealed class WalletFrameHolds
{
    private readonly ConcurrentDictionary<(Guid Tenant, Guid Booking), Hold> _holds = new();

    /// <summary>An open hold. Frames merge per member under its lock.</summary>
    public sealed class Hold
    {
        internal object Gate { get; } = new();
        internal Dictionary<Guid, WalletFrame> Frames { get; } = [];
        internal List<Guid> Order { get; } = [];
        internal string? CancelledBy { get; set; }
    }

    /// <summary>Opens a hold on the booking, or null when one is already open.</summary>
    public Hold? Begin(Guid tenantId, Guid bookingId)
    {
        var hold = new Hold();
        return _holds.TryAdd((tenantId, bookingId), hold) ? hold : null;
    }

    /// <summary>Keeps <paramref name="frame"/> when a hold is open on its booking; false means send it now.</summary>
    public bool TryHold(Guid tenantId, Guid? bookingId, Guid userId, WalletFrame frame)
    {
        if (bookingId is not { } booking || !_holds.TryGetValue((tenantId, booking), out var hold)) return false;
        lock (hold.Gate)
        {
            hold.CancelledBy ??= frame.CancelledBy;
            if (hold.Frames.TryGetValue(userId, out var earlier))
            {
                hold.Frames[userId] = earlier.Merge(frame);
            }
            else
            {
                hold.Frames[userId] = frame;
                hold.Order.Add(userId);
            }
        }
        return true;
    }

    /// <summary>
    /// Closes the hold and answers one frame per member, in the order they first moved. A cancellation
    /// tells every member it touched who cancelled — the partner's share frame carries it too.
    /// </summary>
    public IReadOnlyList<(Guid UserId, WalletFrame Frame)> Release(Guid tenantId, Guid bookingId, Hold hold)
    {
        _holds.TryRemove(new KeyValuePair<(Guid, Guid), Hold>((tenantId, bookingId), hold));
        lock (hold.Gate)
        {
            return [.. hold.Order.Select(u => (u, hold.Frames[u] with { CancelledBy = hold.Frames[u].CancelledBy ?? hold.CancelledBy }))];
        }
    }
}

/// <summary>
/// One action's hold, closed by disposal: everything held is sent through the caller's
/// <see cref="LedgerService"/>, money having already committed — so it sends even when the action
/// threw after its first commit.
/// </summary>
public sealed class WalletFrameScope : IAsyncDisposable
{
    private readonly WalletFrameHolds? _holds;
    private readonly WalletFrameHolds.Hold? _hold;
    private readonly LedgerService _ledger;
    private readonly (Guid Tenant, Guid Booking) _key;

    private WalletFrameScope(WalletFrameHolds? holds, WalletFrameHolds.Hold? hold, LedgerService ledger, (Guid, Guid) key)
    {
        _holds = holds; _hold = hold; _ledger = ledger; _key = key;
    }

    /// <summary>Holds the booking's frames until disposal. A host without the registry holds nothing.</summary>
    public static WalletFrameScope Open(IServiceProvider services, Guid tenantId, Guid bookingId)
    {
        var holds = services.GetService<WalletFrameHolds>();
        return new WalletFrameScope(holds, holds?.Begin(tenantId, bookingId), services.GetRequiredService<LedgerService>(), (tenantId, bookingId));
    }

    public async ValueTask DisposeAsync()
    {
        if (_holds is null || _hold is null) return;
        foreach (var (user, frame) in _holds.Release(_key.Tenant, _key.Booking, _hold))
        {
            await _ledger.PublishFrameAsync(user, frame, CancellationToken.None);
        }
    }
}

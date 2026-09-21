namespace Crusaders.Mainframe.Api.Domain;

/// <summary>What the server believes a court's relay is doing.</summary>
public enum LightState
{
    /// <summary>The server has seen the lights go out, or has never seen them come on since it last knew.</summary>
    Off = 0,

    /// <summary>The server has seen the lights cued and has not seen them released.</summary>
    On = 1,

    /// <summary>
    /// The server cannot make a claim either way. Written when the board driving this court
    /// goes dark: the previous belief was formed from events that board sent, and a board that
    /// has stopped talking is a board whose relay may have been cut by the same power event
    /// that silenced it.
    /// </summary>
    Unknown = 2,
}

/// <summary>Who or what put the lights on — the answer to GOAL item 10's "lights on by".</summary>
public enum LightCause
{
    /// <summary>A member scanning their own booking's code at the box.</summary>
    Member = 0,

    /// <summary>Somebody buying time at the box with no prior booking.</summary>
    WalkUp = 1,

    /// <summary>An admin, through a console path.</summary>
    Admin = 2,

    /// <summary>
    /// The box came back from a power dip and the API told it what should be on
    /// (GOAL item 17). Distinct from <see cref="Member"/> because the member is not
    /// standing at the box — nobody scanned — and the control board and the night
    /// trace must both be able to say "restored after power loss" rather than
    /// inventing a scan that never happened.
    /// </summary>
    RestoreAfterPowerDip = 3,

    /// <summary>No cause the server can name. The initial state of every backfilled row.</summary>
    Unknown = 4,
}

/// <summary>
/// The server's belief about one court's lights: on or off, until when, and who caused it.
///
/// <para>
/// <b>Why a table and not a query.</b> The server knew nothing about relay state at all — no
/// column anywhere — so "is Court 2 lit" could only be answered by replaying the last
/// <c>activate</c>/<c>release</c> receipt pair per <c>(device, relay)</c>. That is a subquery
/// per court on a wall screen refreshing every few seconds, and it still cannot answer the
/// case that matters most: <b>a box that died with the lights on and never sent a
/// release</b>. Replay can only ever say on or off; this row can say
/// <see cref="LightState.Unknown"/>, which is the honest answer and the one an admin needs.
/// </para>
///
/// <para>
/// <b>It is load-bearing for two GOAL items.</b> Item 10's control board reads it, and item
/// 17's power-dip restore is broken precisely BECAUSE there was no such state: the heartbeat
/// returns no relay field, and it could not, because nothing on the server knew the answer.
/// The heartbeat's <c>relays</c> block is computed from bookings, and this row is what records
/// that a restore was served and confirmed.
/// </para>
///
/// <para>
/// <b>Keyed on <see cref="CourtId"/>, never on a relay index.</b> Relay-index validity is
/// defined four different ways across the device endpoints today; this table declines to
/// become the fifth. <see cref="Relay"/> is carried for diagnosis only and is never a key.
/// </para>
///
/// <para>
/// <b><c>seconds_remaining</c> is not here and never will be.</b> A stored countdown is wrong
/// the instant it is written. <see cref="OnUntil"/> is the grant's end, and the remaining
/// seconds are computed at read time against the reader's own clock.
/// </para>
/// </summary>
public sealed class CourtLightState : ITenantScoped
{
    public Guid TenantId { get; set; }

    /// <summary>The court. Half of the composite primary key <c>(TenantId, CourtId)</c>.</summary>
    public Guid CourtId { get; set; }

    public LightState State { get; set; } = LightState.Unknown;

    /// <summary>When the lights were cued. Null whenever <see cref="State"/> is not <see cref="LightState.On"/>.</summary>
    public DateTimeOffset? OnSince { get; set; }

    /// <summary>
    /// When the grant ends — the booking's end, or the walk-up's, clamped by the relay hard cap
    /// upstream. <b>Not</b> a countdown; see the type's remarks.
    /// </summary>
    public DateTimeOffset? OnUntil { get; set; }

    /// <summary>The booking the grant came from, when there is one.</summary>
    public Guid? BookingId { get; set; }

    public LightCause Cause { get; set; } = LightCause.Unknown;

    /// <summary>Who caused it, when a person did. Null for a restore and for an unknown cause.</summary>
    public Guid? CausedByUserId { get; set; }

    /// <summary>The board that last reported on this court.</summary>
    public Guid? DeviceId { get; set; }

    /// <summary>The relay index that board used, for diagnosis. Never a lookup key.</summary>
    public int? Relay { get; set; }

    /// <summary>
    /// When the event behind the current belief happened — the SCAN or the release, not the
    /// upload. What <c>stale</c> is computed against on the control board.
    /// </summary>
    public DateTimeOffset LastEventAt { get; set; }

    /// <summary>
    /// The device sequence number behind the current belief, for out-of-order delivery.
    ///
    /// <para>
    /// A board back from an outage uploads a full ring, and the batch is ordered but two
    /// batches in flight together are not. An event carrying a LOWER seq than the stored one,
    /// from the same board and the same boot, describes an older world and is ignored. Per-device
    /// monotonicity is already this system's assumption — the unique
    /// <c>(TenantId, DeviceId, BootId, Seq)</c> index is what makes a retried upload idempotent —
    /// so this borrows an invariant that already holds rather than inventing one.
    /// </para>
    ///
    /// <para>
    /// The comparison resets when <see cref="DeviceId"/> or <see cref="LastEventBootId"/>
    /// changes: a replaced board, or the same board after a torn sequence checkpoint, numbers
    /// from wherever it likes and its first event must not be discarded as stale.
    /// </para>
    /// </summary>
    public long LastEventSeq { get; set; }

    /// <summary>Which boot of <see cref="DeviceId"/> <see cref="LastEventSeq"/> belongs to. See there.</summary>
    public long LastEventBootId { get; set; }

    /// <summary>When this row was last written. The read model's <c>as_of</c> when nothing else applies.</summary>
    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>
    /// Seconds left on the grant at <paramref name="now"/>, floored at zero, or null when the
    /// lights are not believed on or the grant has no end.
    ///
    /// <para>
    /// Never negative: an expired grant that no release has corrected yet reads as zero
    /// remaining, which is true, rather than as a negative countdown, which is nonsense on a
    /// screen.
    /// </para>
    /// </summary>
    public int? SecondsRemainingAt(DateTimeOffset now)
    {
        if (State != LightState.On || OnUntil is not { } until) return null;
        var seconds = (until - now).TotalSeconds;
        return seconds <= 0 ? 0 : (int)Math.Ceiling(seconds);
    }
}

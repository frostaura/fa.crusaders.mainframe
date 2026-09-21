namespace Crusaders.Mainframe.Api.Domain;

/// <summary>
/// One stretch of silence from a court box: it stopped heart-beating, and either it has not
/// come back yet or the row records when it did.
///
/// <para>
/// <b>Why a row and not a flag on <see cref="Device"/>.</b> Two questions need answering and a
/// flag answers only the first. "Is this box unreachable right now?" is the open row, and it is
/// what makes <c>peripheral.unhealthy</c> fire once per outage rather than once per sweep —
/// exactly the job <c>Booking.LightsOffCuedAt</c> does for the lights-off cue. "Was this box
/// unreachable while that booking's grace window elapsed?" is a question about the past, and
/// <see cref="Device.LastSeenAt"/> cannot answer it: the first heartbeat after the outage moves
/// it forward and the outage is gone from the record. The no-show sweep asks the second question
/// on money (<c>feature-spec.md</c> §6a, <c>settlement-model.md</c> S5a), so the history has to
/// survive the recovery.
/// </para>
///
/// <para>
/// <b>The row is evidence, never an authorisation input.</b> Nothing here is checked before a
/// device request is authorised — the club key does that. An outage row says only "the API heard
/// nothing from this board between these two instants".
/// </para>
/// </summary>
public sealed class DeviceOutage : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }

    public Guid DeviceId { get; set; }

    /// <summary>
    /// When the box was last heard from — the instant the silence began.
    ///
    /// <para>
    /// Deliberately the last heartbeat rather than the moment the sweep noticed. A box is
    /// declared unreachable only after <c>offline_after_seconds</c> of quiet, so dating the
    /// outage from the detection would leave the three missed beats outside it — and those are
    /// precisely the minutes a member was standing at a dark court.
    /// </para>
    /// </summary>
    public DateTimeOffset StartedAt { get; set; }

    /// <summary>When the sweep declared it, which is what the alert and the webhook are stamped with.</summary>
    public DateTimeOffset DetectedAt { get; set; }

    /// <summary>
    /// The first heartbeat after the silence, or null while the box is still quiet.
    /// A null here is the "already alerted, do not alert again" marker.
    /// </summary>
    public DateTimeOffset? EndedAt { get; set; }

    /// <summary>
    /// Whether <see cref="EndedAt"/> is an instant the API actually HEARD from this board, or
    /// merely the instant the row stopped being open. True on every row a heartbeat closed;
    /// false on a row closed because an admin took the board out of service.
    ///
    /// <para>
    /// <b>Without it one continuous silence was recorded as four outages, three of them
    /// claiming the board came back (E9 / R3-2).</b> Taking a board out of service closes its
    /// open outage — it has to, or a guard nobody can clear eventually mails the club "Door gate
    /// is back after 43 200 minutes" about a board they unplugged themselves. But the close
    /// wrote an <c>EndedAt</c> indistinguishable from a recovery, so every shut/reopen of a door
    /// that was ALREADY dark minted another closed row over the same unbroken silence, while
    /// <see cref="Device.LastSeenAt"/> never moved once. The page then read a fleet of
    /// short outages that had each "recovered" where there was one that never had.
    /// </para>
    ///
    /// <para>
    /// <b>It is a fact about evidence, and the settlement is what needs it.</b>
    /// <c>DeviceOutageIndex</c> reads a closed outage's <c>EndedAt</c> as a WITNESS that the API
    /// heard from the board at that instant, and prices no-show waivers off it. A close that
    /// nobody was present for is not a witness to anything, so it must not be read as one — the
    /// instants after an out-of-service switch are decided by <see cref="Device.OutOfServiceSince"/>
    /// instead, which is what that column is for.
    /// </para>
    ///
    /// <para>
    /// Defaults to true, which is the status quo reading for every row written before this
    /// column existed: the sweep and the heartbeat, which wrote nearly all of them, close on
    /// real contact. The handful of pre-existing rows closed by a switch cannot be told apart
    /// retrospectively and are left claiming contact rather than having a claim invented for
    /// them in the other direction.
    /// </para>
    /// </summary>
    public bool EndedByContact { get; set; } = true;

    /// <summary>Whether this outage covers <paramref name="instant"/>.</summary>
    public bool Covers(DateTimeOffset instant) =>
        instant >= StartedAt && (EndedAt is null || instant < EndedAt);
}

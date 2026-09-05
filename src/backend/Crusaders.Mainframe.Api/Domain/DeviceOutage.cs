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

    /// <summary>Whether this outage covers <paramref name="instant"/>.</summary>
    public bool Covers(DateTimeOffset instant) =>
        instant >= StartedAt && (EndedAt is null || instant < EndedAt);
}

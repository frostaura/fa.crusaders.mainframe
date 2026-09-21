namespace Crusaders.Mainframe.Api.Domain;

public enum DeviceKind
{
    /// <summary>The court-control panel: relays, LCD, keypad, QR scanner.</summary>
    CourtBox = 0,

    /// <summary>A door controller: one ESP32, a QR scanner on a UART, one relay on the lock, one LED.</summary>
    Gate = 1,
}

/// <summary>
/// <see cref="DeviceKind"/> as it appears on the wire, and the parse of the heartbeat's
/// <c>kind</c> hint.
///
/// <para>
/// The enum is persisted as an int and the wire form is snake_case, so the two have to be
/// mapped somewhere; doing it here rather than with <c>ToString()</c> means renaming the C#
/// member is not silently an API change. (<c>DeviceView</c> still sends
/// <c>Kind.ToString()</c> — "CourtBox", "Gate" — to the admin console, which is a separate,
/// older wire shape the frontend is typed against. The device wire is these strings.)
/// </para>
/// </summary>
public static class DeviceKinds
{
    /// <summary>What a court box calls itself. Sending it is the same as sending nothing.</summary>
    public const string CourtBox = "court_box";

    /// <summary>What a door gate calls itself, and the only hint that changes anything.</summary>
    public const string Gate = "gate";

    /// <summary>The wire name of a kind.</summary>
    public static string Wire(DeviceKind kind) => kind == DeviceKind.Gate ? Gate : CourtBox;

    /// <summary>
    /// The kind a heartbeat's <c>kind</c> hint names, or false when it names nothing known.
    ///
    /// <para>
    /// <b>Absent is not unknown.</b> Every court box in the field predates this field and
    /// sends no <c>kind</c> at all, so absent has to mean <see cref="DeviceKind.CourtBox"/>
    /// exactly — the hint is additive and the existing wire is untouched. An unrecognised
    /// string is a different thing: it is a firmware that believes in a device kind this
    /// server does not have, and answering 400 tells it so at the one moment somebody is
    /// holding it. Silently registering such a board as a court box would give it a court
    /// list, a button map and a place in the settlement model it has no business in.
    /// </para>
    /// </summary>
    public static bool TryParseHint(string? hint, out DeviceKind kind)
    {
        kind = DeviceKind.CourtBox;
        if (string.IsNullOrWhiteSpace(hint) || hint == CourtBox) return true;
        if (hint != Gate) return false;

        kind = DeviceKind.Gate;
        return true;
    }
}

/// <summary>
/// What a door's lock does when the power is off.
///
/// <para>
/// <b>Admin-entered, never inferred.</b> Nothing the firmware reports bears on this: the
/// relay's polarity flags say what the board drives while it is running, and a board with no
/// power drives nothing at all. <c>door-gate.md</c> §11 makes the point in those words —
/// whether the lock falls open or falls shut is a property of the lock, not of this software
/// — and <c>memory/watch-doors.md</c> carries it as an open debt against a real building.
/// So this column records an answer a person gave after standing in front of the door with
/// the breaker off, and it says so when nobody has.
/// </para>
/// </summary>
public enum DoorPowerLossBehaviour
{
    /// <summary>
    /// Nobody has measured it. The default, and the honest state of every door in the field
    /// today — which is why it is <c>0</c>: a migration that backfilled anything else would
    /// be inventing a measurement.
    /// </summary>
    NotEstablished = 0,

    /// <summary>The lock releases and the door can be pushed open. What the owner expects and nobody has confirmed.</summary>
    Released = 1,

    /// <summary>The lock holds and the door stays shut from outside. Egress stays mechanical either way — see §11.</summary>
    Locked = 2,
}

/// <summary>
/// <see cref="DoorPowerLossBehaviour"/> on the wire, snake_case.
///
/// <para>
/// Mapped here rather than by <c>ToString()</c> for the reason <see cref="DeviceKinds"/>
/// gives: renaming the C# member must not silently be an API change, and the closed set has
/// to be validated on the way in from a console that could otherwise invent a fourth answer.
/// </para>
/// </summary>
public static class DoorPowerLoss
{
    public const string NotEstablished = "not_established";
    public const string Released = "released";
    public const string Locked = "locked";

    /// <summary>Every value, for validation and for the admin screen.</summary>
    public static readonly string[] All = [NotEstablished, Released, Locked];

    /// <summary>The wire name of a behaviour.</summary>
    public static string Wire(DoorPowerLossBehaviour value) => value switch
    {
        DoorPowerLossBehaviour.Released => Released,
        DoorPowerLossBehaviour.Locked => Locked,
        _ => NotEstablished,
    };

    /// <summary>
    /// The behaviour this wire value names, or false when it names none.
    ///
    /// <para>
    /// Strict, including on <c>not_established</c>: a console SETTING a door back to
    /// unmeasured is a real instruction — somebody rewired the lock and the old answer is no
    /// longer known — so it is accepted rather than treated as "leave it alone". Absence is
    /// what leaves it alone, and absence never reaches here.
    /// </para>
    /// </summary>
    public static bool TryParse(string? wire, out DoorPowerLossBehaviour value)
    {
        value = DoorPowerLossBehaviour.NotEstablished;
        switch (wire)
        {
            case NotEstablished: return true;
            case Released: value = DoorPowerLossBehaviour.Released; return true;
            case Locked: value = DoorPowerLossBehaviour.Locked; return true;
            default: return false;
        }
    }
}

public enum DeviceHardware
{
    /// <summary>ATmega2560 — thin I/O layer, USB-flashed.</summary>
    Mega2560 = 0,

    /// <summary>ESP8266 — the court box's brain.</summary>
    Esp8266 = 1,

    /// <summary>ESP32 — gate controllers.</summary>
    Esp32 = 2,
}

/// <summary>
/// A physical device that has talked to this tenant's API.
///
/// <para>
/// <b>This row is a record, not a credential.</b> Authentication is the club's single
/// <see cref="Tenant.DeviceApiKey"/>, presented as a bearer token; a row here says only
/// "a board with this MAC belongs to this club, drives these courts and last called at
/// this time". Nothing about it is checked before a request is authorised, which is why
/// there is no key, no key version and no revocation state on it any more — revoking a
/// row could not have stopped a board that still held the club key, so it was a control
/// that read as one and was not.
/// </para>
///
/// <para>
/// Rows are created by the box itself: an unknown MAC on a heartbeat auto-registers (see
/// <c>DeviceRegistryService.AutoRegisterAsync</c>). Deleting a row is therefore not
/// destructive — the board re-registers on its next heartbeat, with default courts — and
/// that is the intended way to reset a box an admin has misconfigured.
/// </para>
/// </summary>
public sealed class Device : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }

    /// <summary>
    /// Short human-readable identifier, unique within the tenant. Auto-registration writes
    /// <c>box-&lt;last six hex of the MAC&gt;</c>; an admin may rename it.
    /// </summary>
    public required string DeviceCode { get; set; }

    public required string Name { get; set; }
    public DeviceKind Kind { get; set; } = DeviceKind.CourtBox;
    public DeviceHardware Hardware { get; set; } = DeviceHardware.Esp8266;

    /// <summary>
    /// The courts this box drives, for a <see cref="DeviceKind.CourtBox"/>. Empty for gates.
    ///
    /// <para>
    /// <b>The list order is the relay mapping.</b> Index 0 is relay A, index 1 relay B,
    /// index 2 relay C, index 3 relay D. The wiring is fixed — relays A–D are screwed
    /// to pins 2–5 in a cupboard — and it is the list that adapts to it: a box wired to
    /// courts 3 and 4 on relays A and B carries <c>[3, 4]</c>, and a
    /// <c>ButtonAction.SelectCourt(1)</c> on the tenant's button map means "the second
    /// entry here", whatever court number that happens to be.
    /// </para>
    ///
    /// <para>
    /// A list rather than the single <c>CourtNumber</c> this replaced because one
    /// physical box has one scanner and four relays (review C4): the per-court model
    /// could structurally light at most one court at the club's only scanner, and
    /// members booked on the other three were refused as WrongCourt.
    /// </para>
    /// </summary>
    public List<int> CourtNumbers { get; set; } = [];

    /// <summary>
    /// Which door this controller opens, for a <see cref="DeviceKind.Gate"/>. Null for court
    /// boxes, and null on a gate until an admin names it.
    ///
    /// <para>
    /// <b>It is a label, not an access-control input.</b> Every gate in a club is handed the
    /// same roster and applies the same policy; this is what makes a <c>gate.opened</c> audit
    /// row say "front door" rather than "gate-0a1b2c", and what a club would group doors by
    /// if it ever had per-door rules. Nothing reads it to decide anything, and one firmware
    /// image serves every door precisely because nothing per-door is compiled in.
    /// </para>
    /// </summary>
    public string? GateKey { get; set; }

    /// <summary>
    /// Longest <see cref="GateKey"/> accepted, matching the column. Named once so the
    /// validation an admin meets and the width the database enforces cannot drift — a door
    /// whose name is silently truncated is a door nobody can find in the audit trail.
    /// </summary>
    public const int GateKeyMaxLength = 64;

    /// <summary>
    /// Where this door physically is, in a sentence somebody wrote down. Null until they did,
    /// and null on a court box.
    ///
    /// <para>
    /// <b>It is not <see cref="GateKey"/> and it is not a second name.</b> The gate key is a
    /// short machine-ish label that appears in every audit row a club will ever read back and
    /// is what a firmware-facing roster is keyed by; this is prose for the person who has to
    /// walk to the door — "Reception, left of the desk", "service yard, behind the bins" —
    /// and it exists because <c>gate-0a1b2c</c> on a printed card tells a locksmith nothing.
    /// W1.4 puts it on the printable door card beside the device code, the MAC and the club's
    /// contact details, which is the one artefact that leaves this system on paper.
    /// </para>
    ///
    /// <para>
    /// Two-valued on the PATCH exactly like <see cref="GateKey"/>: an empty string clears it,
    /// absent leaves it alone. Bounded by the caller, where there is a person to refuse,
    /// rather than truncated at the column — a location silently shortened is a location
    /// somebody follows to the wrong end of a corridor.
    /// </para>
    /// </summary>
    public string? LocationNote { get; set; }

    /// <summary>
    /// Longest <see cref="LocationNote"/> accepted, matching the column. Named once for the
    /// same reason <see cref="GateKeyMaxLength"/> is.
    /// </summary>
    public const int LocationNoteMaxLength = 200;

    /// <summary>
    /// What this door's lock does with no power, as an admin recorded it. See
    /// <see cref="DoorPowerLossBehaviour"/> — it is measured, never inferred.
    /// </summary>
    public DoorPowerLossBehaviour PowerLossBehaviour { get; set; } = DoorPowerLossBehaviour.NotEstablished;

    /// <summary>
    /// When this door was shut by a club-wide "shut all doors", or null.
    ///
    /// <para>
    /// <b>It is what makes "reopen all" an undo rather than an unlock.</b> Without it the
    /// only state a reopen could read is <see cref="Enabled"/>, and reopening every disabled
    /// gate would silently reverse a decision an admin made about ONE door for a reason this
    /// system knows nothing about — a broken scanner, a lock being replaced, a door the club
    /// has closed for the season. A door an admin shut individually has to stay shut through
    /// a fleet reopen, and the only way to tell the two apart is to record which of them this
    /// software did.
    /// </para>
    ///
    /// <para>
    /// Cleared whenever the door goes back INTO service, by either route, because the column
    /// says what is true of this row now: a door that is open was not shut by anything. It is
    /// deliberately not a history — one column cannot hold one — and nothing settles on it,
    /// unlike <see cref="OutOfServiceSince"/>, which the money reads.
    /// </para>
    /// </summary>
    public DateTimeOffset? ShutByShutAllAt { get; set; }

    /// <summary>
    /// The admin who took this board out of service, or null while it is in service.
    ///
    /// <para>
    /// <b>"You shut this door." was shown to every admin in the club (A5).</b> The console had
    /// <see cref="OutOfServiceSince"/> and nothing else, so it addressed whoever was reading as
    /// the person who had done it — to a committee of six, five of whom had not. Who shut a door
    /// is exactly the fact a second admin needs before reopening it, and it is also what makes
    /// a stale tab's no-op PATCH answerable: "it was already shut — by Priya Naidoo at 21:48"
    /// (B10).
    /// </para>
    ///
    /// <para>
    /// <b>A column rather than a derivation from the audit trail, and the fleet shut is why.</b>
    /// An individual shut writes a <c>device.updated</c> row carrying this board's id, so it
    /// could be found; a <c>doors.shut_all</c> writes ONE row for the whole club and carries no
    /// <c>device_id</c> at all, so a door shut by the fleet could not be attributed by any
    /// query. The same argument <see cref="ShutByShutAllAt"/> already makes: the state of this
    /// row now is a property of this row.
    /// </para>
    ///
    /// <para>
    /// Cleared on the way back into service, by either route — a board in service was not shut
    /// by anybody. It is deliberately not a history; the trail is the history.
    /// </para>
    /// </summary>
    public Guid? ShutByUserId { get; set; }

    /// <summary>
    /// This box's own button map, as the eight-entry wire array (<c>ButtonMap.ToWire()</c>)
    /// serialised to JSON — or null to use the club's map from <c>tenant_settings</c>.
    ///
    /// <para>
    /// The map used to be tenant-wide only, and validated against every box's court count
    /// at both save points, so a club with a four-court box and a one-court annex box had
    /// no valid configuration at all: a map the annex could honour left three buttons on
    /// the main box inert, and the default map refused to register the annex (closing
    /// re-review #17). The invariant "a court button selects a wired court" is a property
    /// of one box, so it is held per box: the EFFECTIVE map — this override, else the
    /// tenant's — is what a device save is checked against, what the tenant-map save
    /// checks only for boxes with no override, and what the heartbeat sends.
    /// </para>
    /// </summary>
    public string? ButtonMapJson { get; set; }

    /// <summary>
    /// The board's MAC address, lowercase hex without separators, as it announces itself
    /// in every device request body.
    ///
    /// <para>
    /// This is the whole of a device's identity. The club key says which club is calling;
    /// the MAC says which board. It is required rather than nullable because there is no
    /// longer any way to create a row without one — every row is created by a heartbeat
    /// that carried a MAC.
    /// </para>
    /// </summary>
    public required string MacAddress { get; set; }

    /// <summary>Last address the device called from. Observability only — never an authorisation input.</summary>
    public string? LastIpAddress { get; set; }

    public bool Enabled { get; set; } = true;

    /// <summary>
    /// When an admin last took this board <b>out of service</b> — null while it is in service.
    ///
    /// <para>
    /// <b>It exists because <see cref="Enabled"/> carries no history, and the money needs one.</b>
    /// Taking the last board off a court takes that court's own door away for good:
    /// <c>DeviceIdentity.ResolveAsync</c> answers 403 for a disabled board on all five
    /// <c>/api/v1/device/*</c> routes — <c>/heartbeat</c>, <c>/activate</c>, <c>/walkup</c>,
    /// <c>/events</c> and <c>/gate</c> — so the board is refused everything it calls, is no
    /// longer sent the roster that says which bookings it may open, and can never report anyone
    /// who played, and <c>settlement-model.md</c> S5a waives the no-show penalty for the bookings
    /// that fall after it. Deciding whether the door was shut from <see cref="Enabled"/> alone
    /// answers "was this court shut at <c>T</c>?" with today's value of a boolean, so one click
    /// re-priced every unsettled deadline behind it.
    ///
    /// <para>
    /// <b>"So the box admits nobody" is what this said for two rounds, and it is false.</b> The
    /// 403 only reaches a board that can still reach us. A board that has been CUT OFF — the
    /// uplink pulled, the switch dead, the club's line down — never hears it, and goes on
    /// admitting whatever its cached roster still carries until that roster goes stale six hours
    /// after it was fetched. Taking a board out of service is therefore a withdrawal that takes
    /// effect at the server immediately and at the board only when the board next asks. The
    /// money above is unaffected — it is decided here, from this column — but anybody reading
    /// this to answer "can somebody still get in?" was reading a sentence that was not true. The
    /// same correction applies to a gate, where the question is literally about a door.
    /// </para>
    /// Deciding it from <see cref="LastSeenAt"/> instead — the board's last heartbeat — is not the
    /// same instant: the switch is thrown some seconds or minutes AFTER the last heartbeat, and
    /// reading the two as one moves money in whichever direction the gap happens to point.
    /// </para>
    ///
    /// <para>
    /// <b>It is the box that is shut, not the court, and this comment said otherwise for two
    /// rounds.</b> It enumerated "heartbeat, activation, walk-up, PIN, QR or biometric" as the
    /// ways a switched-off court refuses everyone, and the last three of those are
    /// <c>/api/v1/court/{n}/…</c> routes on the shared courtside terminal, which resolve a
    /// <c>Courts.CourtNumber</c>, never look at a <see cref="Device"/> row and still set
    /// <c>CheckedInAt</c>. A member at that court can still identify at the terminal. The rule
    /// this column serves is unchanged by that; why the waiver survives the correction, and what
    /// keeping it costs, is argued in <c>settlement-model.md</c> S5a rather than asserted here.
    /// </para>
    ///
    /// <para>
    /// So the instant is recorded when the switch is thrown (<c>DeviceRegistryService.UpdateAsync</c>)
    /// and read as evidence about the past, exactly like <see cref="LastSeenAt"/> and a
    /// <see cref="DeviceOutage"/> row. Putting the board back in service clears it, because the
    /// column says what is true of this row now and one column cannot hold a history of
    /// switch-offs; what that costs is written down in <c>settlement-model.md</c> S5a.
    /// </para>
    /// </summary>
    public DateTimeOffset? OutOfServiceSince { get; set; }

    public DateTimeOffset? LastSeenAt { get; set; }

    /// <summary>Firmware version last reported by heartbeat. Null until it first checks in.</summary>
    public string? RunningVersion { get; set; }

    /// <summary>
    /// For a court box, the version of the ATmega firmware behind the ESP. Tracked
    /// separately because the Mega is USB-flashed and can lag the ESP.
    /// </summary>
    public string? MegaVersion { get; set; }

    /// <summary>
    /// True while this row is still exactly as auto-registration left it — nobody has
    /// confirmed the courts it was given or the name it was called.
    ///
    /// <para>
    /// It is surfaced on the Devices page so a box that appeared by itself reads as
    /// "check me" rather than as configuration somebody chose. The first admin edit
    /// clears it; deleting the row and letting the box re-register sets it again.
    /// </para>
    /// </summary>
    public bool AutoRegistered { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    /// <summary>A device may act only while enabled.</summary>
    public bool IsActive => Enabled;
}

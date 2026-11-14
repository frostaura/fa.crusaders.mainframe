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

    /// <summary>
    /// What the club calls this board. <b>May be empty, which means "nobody has named it"</b> —
    /// see <see cref="NameMaxLength"/>.
    /// </summary>
    public required string Name { get; set; }

    /// <summary>
    /// Longest <see cref="Name"/> accepted, matching the column.
    ///
    /// <para>
    /// <b>It was not checked anywhere and the column threw (A-M4 / B2, R3-15).</b> A name of 129
    /// characters reached <c>SaveChangesAsync</c>, Postgres refused the <c>varchar(128)</c>, and
    /// the <c>DbUpdateException</c> came back to the console as a <c>500</c> — in Development, as
    /// a developer exception page naming types, assemblies and the absolute source path of the
    /// machine that built it. Named once, beside <see cref="GateKeyMaxLength"/> and
    /// <see cref="LocationNoteMaxLength"/>, so the bound an admin meets and the width the
    /// database enforces cannot drift.
    /// </para>
    ///
    /// <para>
    /// <b>An empty name is a state and not a refusal.</b> Clearing the field is how an admin says
    /// the club has no name for this board yet, and the PATCH stores exactly that; every door
    /// projection answers <c>name: null</c> for it so a console has ONE unnamed case to render
    /// rather than a blank string that looks like a rendering bug. Refusing a blank would leave
    /// the old name in place, which is what the endpoint used to do silently — success reported,
    /// nothing written (B3).
    /// </para>
    /// </summary>
    public const int NameMaxLength = 128;
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
    /// The first time this server answered this board <c>403</c> AFTER the current shut began —
    /// which is the only evidence that exists that the board has HEARD it is shut. Null while
    /// the door is open, and null while it is shut and has not called since.
    ///
    /// <para>
    /// <b>This column is R3-1, and the defect it closes is the console saying the opposite of
    /// what happened.</b> <c>DeviceIdentity</c> answered a shut board <c>403</c> before anything
    /// recorded the contact, so <see cref="LastSeenAt"/> froze at the last call before the shut.
    /// Three minutes later the sweep declared the door unreachable and the page said: "Nothing
    /// can reach Front door, so it has not been told. It may still be admitting booked members
    /// from its saved list" — about a board that had heard the 403 inside one heartbeat and
    /// emptied its roster on the spot. The reopen confirmation then said it had been "admitting
    /// booked members all along". Every one of those sentences was false, and each was reasoned
    /// from silence the server itself had manufactured by refusing to write down that the board
    /// was talking to it.
    /// </para>
    ///
    /// <para>
    /// <b>Silence alone can never answer this question and that is why it is a column.</b>
    /// "Not heard from" and "has not been told" are two different facts: a board can be silent
    /// because its uplink is down, or because it is sitting there being refused. Only the second
    /// is safe to report as "confirmed shut", and only a record written AT the refusal can tell
    /// them apart afterwards.
    /// </para>
    ///
    /// <para>
    /// Cleared on the way back into service, like <see cref="ShutByUserId"/> and
    /// <see cref="ShutByShutAllAt"/>: it is about the shut that is in force now, and a door that
    /// is open has not been told anything. It is deliberately not a history — the trail is the
    /// history — and nothing settles on it.
    /// </para>
    /// </summary>
    public DateTimeOffset? ShutHeardAt { get; set; }

    /// <summary>
    /// The board's own count of queued records it had to drop, since it last booted, as of the
    /// last heartbeat that reported one. Zero when it has never reported a loss.
    ///
    /// <para>
    /// <b>It arrived on every heartbeat and was written to a log file (R3-33).</b> The board's
    /// event queue is a fixed ring; a door that scans faster than it can upload — or that stays
    /// offline long enough — overwrites its own oldest entries, and this is the only number
    /// anywhere that says the club's door history has holes in it. A warning in the API's
    /// container log is not a place a club can read, and no screen carried it, so "why is there
    /// nothing in the log between 19:00 and 21:00" had no answer at all.
    /// </para>
    ///
    /// <para>
    /// <b>A SINCE-BOOT TOTAL, not a delta,</b> which every reader has to say in words: a
    /// technician reading it as a per-interval count sees a board that looks worse every hour it
    /// stays up. It resets when the board does, which is why the instant beside it matters —
    /// a zero from a board that rebooted an hour ago is not the same fact as a zero from one
    /// that has been up a month.
    /// </para>
    /// </summary>
    public int EventsLost { get; set; }

    /// <summary>
    /// When <see cref="EventsLost"/> was last reported, or null if this board has never reported
    /// the counter at all. See that field for why the pair is needed and a bare zero is not.
    /// </summary>
    public DateTimeOffset? EventsLostReportedAt { get; set; }

    /// <summary>
    /// The board's since-boot count of heartbeats it could not push, as last reported — the
    /// companion to <see cref="EventsLost"/> and read the same way.
    ///
    /// <para>
    /// It used to be logged to the container log and stored nowhere, on the stated grounds
    /// that "a column on Device would be an EF migration for a counter nothing decides
    /// anything on". <b>That was correct and has stopped being true</b>: GOAL item 7's error
    /// log is something that decides on it. The column exists so the RISE between two
    /// heartbeats can be computed — a since-boot total re-reported every minute would
    /// otherwise open one row per beat carrying the same number, which is the opposite of a
    /// monitoring page.
    /// </para>
    /// </summary>
    public int NoPush { get; set; }

    /// <summary>When <see cref="NoPush"/> was last reported. Null on a board that has never sent the counter.</summary>
    public DateTimeOffset? NoPushReportedAt { get; set; }

    /// <summary>
    /// What the board said it speaks on its LATEST heartbeat — <c>caps</c>, e.g.
    /// <c>codes:m1</c> (<c>docs/specs/member-code.md</c> §5.1). Empty for a board that named
    /// nothing, which is every image flashed before member codes.
    ///
    /// <para>
    /// <b>Latest, replaced wholesale, never merged.</b> Two things key on it: what the next
    /// heartbeat answer carries for this board, and the club's automatic cut-over, which waits
    /// until every enabled board reports <c>codes:m1</c>. A spare flashed back to old firmware
    /// has to be seen as NOT speaking it the moment it says so, which a merged set would hide.
    /// </para>
    /// </summary>
    public List<string> Capabilities { get; set; } = [];

    /// <summary>When <see cref="Capabilities"/> was last written — the instant of the heartbeat it came from.</summary>
    public DateTimeOffset? CapabilitiesReportedAt { get; set; }

    /// <summary>Whether the latest heartbeat named the member-code capability.</summary>
    public bool SpeaksMemberCodes => Capabilities.Contains(Services.MemberCodeWire.Capability);

    /// <summary>
    /// When this board was last SERVED a non-empty power-dip restore that it has not yet
    /// answered for — null when there is nothing outstanding.
    ///
    /// <para>
    /// <b>Why an expectation has to be recorded at all.</b> The API serves the restore answer
    /// on every heartbeat, because only the box knows whether it has just booted. The box
    /// applies it exactly once and reports what it did on the NEXT heartbeat. Without a marker,
    /// a <c>restored_relays: 0</c> from a box that has been up for a week is indistinguishable
    /// from a box that was told to light two courts and did not — and the second is the one an
    /// admin must see, because it means a court is dark that the club believes is lit, with a
    /// member on it who has already been charged.
    /// </para>
    ///
    /// <para>
    /// It is set only when the board looks freshly booted, so an ordinary running box with a
    /// lit court is never asked to confirm a restore it was never going to perform.
    /// </para>
    /// </summary>
    public DateTimeOffset? RestoreServedAt { get; set; }

    /// <summary>How many relays the outstanding restore named. Zero when nothing is outstanding.</summary>
    public int RestoreServedRelays { get; set; }

    /// <summary>
    /// When the board booted — the server's clock at the heartbeat less the board's own
    /// <c>uptime_ms</c> — for the boot the last non-empty restore was served to. Unlike
    /// <see cref="RestoreServedAt"/> it is KEPT once that restore is settled. Null before the first
    /// restore, or when the board that was served reported no readable uptime.
    ///
    /// <para>
    /// <b>R19 E19-1: one restore per boot.</b> The box applies a restore once per boot and its
    /// <c>restored_relays</c> then rides every heartbeat of that boot unchanged — it never resets
    /// it. Without knowing which boot was served, the fresh-boot window re-served the plan and the
    /// box's unchanged count confirmed it again on every beat: a <c>court.lights_restored</c> row
    /// per lit court per beat and the court's "on since" moved each time. A confirmation now
    /// counts only against a restore outstanding for the board's CURRENT boot, and a boot that has
    /// been served is never served again.
    /// </para>
    /// </summary>
    public DateTimeOffset? RestoreServedBootAt { get; set; }

    // ---- Device contract v3 (docs/specs/device-api.md) — what a v3 board reports, and the
    //      per-board overrides an admin sets. Every column is nullable or defaulted, so a 2.x
    //      board's row is untouched and a v3 board on its first beat fills them in. ----

    /// <summary>The network configuration version the board has applied (§8). 0 = compiled defaults or the setup portal's.</summary>
    public long? NetVer { get; set; }

    /// <summary>Where that configuration came from: <c>server</c>, <c>local</c> (the setup portal) or <c>compiled</c>.</summary>
    public string? NetSrc { get; set; }

    /// <summary>
    /// An admin asked for the club's network to be pushed to this board although its
    /// configuration is <c>local</c> (§8: "never overwritten … until an admin explicitly pushes").
    /// Cleared once the board reports the club's version from the server.
    /// </summary>
    public bool NetPushRequested { get; set; }

    /// <summary>The layout the Mega last ACKNOWLEDGED, as the bridge echoes it (§5): <c>compact</c> or <c>expanded</c>.</summary>
    public string? LcdLayoutAcknowledged { get; set; }

    /// <summary>When <see cref="LcdLayoutAcknowledged"/> last changed — "showing expanded since 18:05".</summary>
    public DateTimeOffset? LcdLayoutAcknowledgedAt { get; set; }

    /// <summary>
    /// This board's own layout, overriding the club's <c>lcd_layout</c>; null = the club's. Three-
    /// valued on the admin PATCH exactly like <see cref="ButtonMapJson"/>.
    /// </summary>
    public string? LcdLayoutOverride { get; set; }

    /// <summary>This board's own marquee switch, overriding <c>lcd_marquee_enabled</c>; null = the club's.</summary>
    public bool? LcdMarqueeOverride { get; set; }

    /// <summary>The <c>restore</c> report of the board's latest first-of-boot beat: <c>warm</c>, <c>cold</c>, <c>none</c> or <c>unknown</c>.</summary>
    public string? RestoreReport { get; set; }

    /// <summary>When <see cref="RestoreReport"/> was received.</summary>
    public DateTimeOffset? RestoreReportedAt { get; set; }

    /// <summary>
    /// The id number of the club key this board last authenticated with (§6: k1, k2, … as 1, 2, …).
    /// How the console says "on the new key" or "still on the old key", and how the server knows a
    /// board no longer needs <c>key_next</c>.
    /// </summary>
    public int? LastKeyId { get; set; }

    /// <summary>When <see cref="LastKeyId"/> was last confirmed.</summary>
    public DateTimeOffset? LastKeyAt { get; set; }

    // ---- §12: the hardware facts, per board. Null = the club's tenant setting. Three-valued on
    //      the admin PATCH (absent = unchanged, null = the club's, a value = the board's). ----

    /// <summary>This board's relay drive level (<c>high</c>/<c>low</c>), overriding <c>hw_relay_active_level</c>.</summary>
    public string? HwRelayActiveLevel { get; set; }

    /// <summary>This board's LCD backpack address (0 = probe), overriding <c>hw_lcd_i2c_address</c>.</summary>
    public int? HwLcdI2cAddress { get; set; }

    /// <summary>This board's scanner rate (0 = auto), overriding <c>hw_scanner_baud</c>.</summary>
    public int? HwScannerBaud { get; set; }

    /// <summary>This board's scan line end (<c>auto</c>/<c>crlf</c>), overriding <c>hw_scanner_line_end</c>.</summary>
    public string? HwScannerLineEnd { get; set; }

    /// <summary>This board's scan idle gap in ms, overriding <c>hw_scanner_gap_ms</c>.</summary>
    public int? HwScannerGapMs { get; set; }

    // ---- §13: what the board reports about itself, latest beat only. Stored as the JSON the
    //      board sent, re-serialised from the server's own reading (unknown keys dropped). ----

    /// <summary>The court box's <c>mega</c> object (<c>reset</c>, <c>lcd</c>, <c>relay</c>, <c>scan_baud</c>, <c>scan_end</c>, <c>keys</c>, <c>diag</c>), as JSON; null until heard.</summary>
    public string? MegaJson { get; set; }

    /// <summary>The board's <c>diag</c> object (reset reason, heap, block, stack low-water mark, …), as JSON; null until reported.</summary>
    public string? DiagJson { get; set; }

    /// <summary>The <c>drift</c> list of the latest beat: keys of the previous answer the board could not read. Empty when none.</summary>
    public List<string> Drift { get; set; } = [];

    /// <summary>When <see cref="MegaJson"/>, <see cref="DiagJson"/> or <see cref="Drift"/> was last written.</summary>
    public DateTimeOffset? TelemetryAt { get; set; }

    // ---- §11.3/§11.4, member-code.md §5.4: the server's own shedding, counted per board. ----

    /// <summary>How many <c>code_keys</c> the latest answer carried.</summary>
    public int? CodeKeysSent { get; set; }

    /// <summary>How many keys the latest answer left out (the ring's cap and the body budget together).</summary>
    public int? CodeKeysTrimmed { get; set; }

    /// <summary>When the latest answer carrying <c>code_keys</c> to this board was produced.</summary>
    public DateTimeOffset? CodeKeysAt { get; set; }

    /// <summary>When the first trim was raised as a device notice; null until one happened.</summary>
    public DateTimeOffset? CodeKeysTrimNoticedAt { get; set; }

    /// <summary>
    /// Per relay, how many consecutive beats of this <c>hb:3</c> board the snapshot has said the
    /// court is lit while <c>relay_state</c> said it is dark (§4). Two files
    /// <c>restore_not_confirmed</c> for that court; a confirming or dark beat resets it.
    /// </summary>
    public List<int> RelayDarkStreak { get; set; } = [];

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

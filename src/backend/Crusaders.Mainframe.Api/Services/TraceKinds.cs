using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// What kind of person the actor on one trace row was. Four states, and the fourth is the one
/// that matters.
///
/// <para>
/// <b>It is never <c>ActorUserId != SubjectUserId</c></b> — D2-B41, which
/// <see cref="LedgerService"/> still computes that way and which makes every automatic no-show
/// sweep claim an administrator did it. <see cref="Guid.Empty"/> is what the no-show sweep and
/// the booking settlement actually write, so <see cref="System"/> is a real state and not a
/// defensive one, and a member disputing a penalty is entitled to a screen that says so.
/// </para>
/// </summary>
public static class TraceActors
{
    /// <summary>Nobody: a worker, a sweep, a settlement. <see cref="Guid.Empty"/>.</summary>
    public const string System = "system";

    /// <summary>A board. The row names a device and no user.</summary>
    public const string Device = "device";

    /// <summary>A person this club has marked as an administrator.</summary>
    public const string Admin = "admin";

    /// <summary>An ordinary member — including the person whose night this is.</summary>
    public const string Member = "member";

    /// <summary>Every kind, for the console that renders a chip per one.</summary>
    public static readonly string[] All = [System, Device, Admin, Member];
}

/// <summary>
/// What one trace row knows about itself, as the headline composer needs it. Everything is
/// optional: a sentence has to read correctly when a detail is missing, because rows written
/// before a field existed are exactly the rows an admin looks at after an incident.
/// </summary>
public readonly record struct TraceFacts
{
    /// <summary>The board's display name, for a door sentence.</summary>
    public string? DoorName { get; init; }

    /// <summary>The court's name, for a booking, court or lights sentence.</summary>
    public string? CourtName { get; init; }

    /// <summary>The movement, in credits, unsigned — the sentence carries the direction.</summary>
    public decimal? AmountCredits { get; init; }

    /// <summary>Who did it, when naming them makes the sentence say something.</summary>
    public string? ActorName { get; init; }

    /// <summary>One of <see cref="TraceActors"/>. A <see cref="TraceActors.System"/> row says so.</summary>
    public string? ActorKind { get; init; }

    /// <summary>The raw action, for <see cref="TraceKinds.Unrecognised"/> and nothing else.</summary>
    public string? RawAction { get; init; }
}

/// <summary>
/// The night trace's closed vocabulary, and the sentence each word renders as.
///
/// <para>
/// <b>Composed on the SERVER, for the reason <see cref="DoorAuditActions"/> is named after.</b>
/// The doors console held its own dictionary; an action it had never heard of fell through to
/// whichever branch was first, so <c>device.updated</c> — an admin renaming a door — was painted
/// as a green "Refused" scan and a door with thirteen admin edits and no scans at all read
/// "13 refused scans, newest 1 min ago". A per-person night trace is the last surface in this
/// product that should be guessing, so it does not: the word and the sentence are decided here,
/// together, and <c>TraceKindsTests</c> pins them against the actions the writers actually emit.
/// </para>
///
/// <para>
/// <b>Three answers, not two.</b> <see cref="OfAudit"/> returns a word for a row that belongs on
/// a member's night; <c>null</c> for one that is declared NOT to be — the settlement's own
/// bookkeeping, a board's boot, the clock-correction twin — and <see cref="Unrecognised"/> for an
/// action nobody has met. Collapsing the middle answer into the last is how a trace fills with
/// "no word for this" rows that somebody already decided about; collapsing it into a silent drop
/// is how a reader stops being able to reason about what is missing.
/// </para>
///
/// <para>
/// <b>Deviations from D2 §6.2, each deliberate.</b> D2's twenty-one words are all present
/// (<c>TraceKindsTests.The_design_documents_vocabulary_survives_in_full</c>). Four are added,
/// because the actions behind them are written today and every one of them is something that
/// happened to the member rather than to the club's books:
/// <see cref="BookingDisplaced"/>, <see cref="BookingDisplacementReversed"/>,
/// <see cref="BookingNoShowReversed"/> and <see cref="WalletReversed"/>. Rendering any of those
/// as <see cref="Unrecognised"/> would put "this club has no word for it" in front of an admin
/// about four things the club does routinely.
/// </para>
/// </summary>
public static class TraceKinds
{
    // ------------------------------------------------------------------ strands

    /// <summary>Somebody at a door.</summary>
    public const string DoorStrand = "door";

    /// <summary>A court reserved, released or taken away.</summary>
    public const string BookingStrand = "booking";

    /// <summary>Somebody at a court box.</summary>
    public const string CourtStrand = "court";

    /// <summary>What the relays did.</summary>
    public const string LightsStrand = "lights";

    /// <summary>Money.</summary>
    public const string WalletStrand = "wallet";

    /// <summary>A row this vocabulary has no word for. Its own strand, so a console can group it away.</summary>
    public const string OtherStrand = "other";

    /// <summary>Every strand, in the order a night reads.</summary>
    public static readonly string[] Strands =
        [DoorStrand, BookingStrand, CourtStrand, LightsStrand, WalletStrand, OtherStrand];

    // ------------------------------------------------------------------ the words

    /// <summary>The server decided, and the lock released.</summary>
    public const string DoorOpened = "door.opened";

    /// <summary>Somebody was turned away at a door.</summary>
    public const string DoorRefused = "door.refused";

    /// <summary>A board decided it alone, from its cached roster, and told us afterwards.</summary>
    public const string DoorOpenedOffline = "door.opened_offline";

    /// <summary>They booked a court themselves.</summary>
    public const string BookingMade = "booking.made";

    /// <summary>Somebody else booked a court for them.</summary>
    public const string BookingMadeForThem = "booking.made_for_them";

    /// <summary>They cancelled it themselves.</summary>
    public const string BookingCancelled = "booking.cancelled";

    /// <summary>The club cancelled it. Includes the automatic sweep — see <see cref="TraceActors"/>.</summary>
    public const string BookingCancelledByClub = "booking.cancelled_by_club";

    /// <summary>
    /// The club's automatic check marked a booking as missed.
    ///
    /// <para>
    /// <b>Nothing writes an audit row for this today</b> — <c>NoShowWorker</c> moves money and a
    /// status and writes no <c>audit_log</c> row at all — so the only trace of a no-show is the
    /// penalty on the wallet strand. The word is here, as D2 §6.2 declares it, so the lane that
    /// adds the row has somewhere to put it; until then nothing emits it, which is honest.
    /// </para>
    /// </summary>
    public const string BookingNoShow = "booking.no_show";

    /// <summary>The club blocked out the court this booking was on.</summary>
    public const string BookingBlockedOver = "booking.blocked_over";

    /// <summary>The club moved a booking aside. <b>Added beyond D2 §6.2</b> — see the type summary.</summary>
    public const string BookingDisplaced = "booking.displaced";

    /// <summary>And put it back. <b>Added beyond D2 §6.2.</b></summary>
    public const string BookingDisplacementReversed = "booking.displacement_reversed";

    /// <summary>A no-show was taken back and the penalty returned. <b>Added beyond D2 §6.2.</b></summary>
    public const string BookingNoShowReversed = "booking.no_show_reversed";

    /// <summary>They bought light time at the court rather than reserving it.</summary>
    public const string WalkUpBought = "walkup.bought";

    /// <summary>That purchase was voided.</summary>
    public const string WalkUpRefunded = "walkup.refunded";

    /// <summary>They identified at a court box and the lights were theirs.</summary>
    public const string CourtCheckedIn = "court.checked_in";

    /// <summary>They stood at a court box and were refused.</summary>
    public const string CourtRefused = "court.refused";

    /// <summary>A court's lights came on.</summary>
    public const string LightsOn = "lights.on";

    /// <summary>A court's lights went off.</summary>
    public const string LightsOff = "lights.off";

    /// <summary>Money in.</summary>
    public const string WalletToppedUp = "wallet.topped_up";

    /// <summary>
    /// Money in, taken by hand at the desk — cash, an EFT that cleared, a card taken offline.
    ///
    /// <para>
    /// <b>Its own word rather than <see cref="WalletToppedUp"/>'s, and not
    /// <see cref="WalletAdjustedByAdmin"/>'s either.</b> The member did not do it, so "Topped up
    /// 200 credits" is a sentence about somebody who was not there; and it is not an adjustment,
    /// because <see cref="LedgerEntryType.AdminTopUp"/> is money the club TOOK and counts as
    /// revenue, while an adjustment is a book correction. Borrowing either word is the
    /// guessed-sentence failure the vocabulary exists to prevent — a member disputing a figure
    /// is entitled to the sentence that says who handed over what.
    /// </para>
    /// </summary>
    public const string WalletToppedUpAtTheDesk = "wallet.topped_up_at_the_desk";

    /// <summary>Money out for court time.</summary>
    public const string WalletSpent = "wallet.spent";

    /// <summary>Money back.</summary>
    public const string WalletRefunded = "wallet.refunded";

    /// <summary>Money kept by the club for a missed or late-cancelled booking.</summary>
    public const string WalletPenalised = "wallet.penalised";

    /// <summary>An admin moved credits by hand.</summary>
    public const string WalletAdjustedByAdmin = "wallet.adjusted_by_admin";

    /// <summary>A payment was clawed back after the fact. <b>Added beyond D2 §6.2.</b></summary>
    public const string WalletReversed = "wallet.reversed";

    /// <summary>
    /// A partner's share of a split booking moved between two members (D11) — paid to the
    /// organiser, or handed back. Its own word, because it is none of the club's: the club took
    /// nothing and gave nothing back.
    /// </summary>
    public const string WalletShareMoved = "wallet.share_moved";

    /// <summary>
    /// A row this server wrote that this vocabulary has no word for.
    ///
    /// <para>
    /// It is ON the wire rather than omitted, and its sentence NAMES THE RAW ACTION rather than
    /// describing it. Those are the two halves of one rule: a feed that silently drops rows is a
    /// feed nobody can reason about, and a feed that guesses at one is how "13 admin edits"
    /// became "13 refused scans".
    /// </para>
    /// </summary>
    public const string Unrecognised = "unrecognised";

    /// <summary>Every word, in the order a night reads. A set; <c>TraceKindsTests</c> pins that.</summary>
    public static readonly string[] All =
    [
        DoorOpened, DoorRefused, DoorOpenedOffline,
        BookingMade, BookingMadeForThem, BookingCancelled, BookingCancelledByClub, BookingNoShow,
        BookingNoShowReversed, BookingBlockedOver, BookingDisplaced, BookingDisplacementReversed,
        WalkUpBought, WalkUpRefunded,
        CourtCheckedIn, CourtRefused,
        LightsOn, LightsOff,
        WalletToppedUp, WalletToppedUpAtTheDesk, WalletSpent, WalletRefunded, WalletPenalised,
        WalletAdjustedByAdmin, WalletReversed, WalletShareMoved,
        Unrecognised,
    ];

    // ------------------------------------------------------------------ not a person's night

    /// <summary>
    /// The actions that are deliberately NOT on a member's night, each with its reason.
    ///
    /// <para>
    /// <b>Declared rather than omitted.</b> An action missing from a switch and an action decided
    /// against look identical six months later, and the first one anybody forgets is how a trace
    /// quietly stops showing something. <c>TraceKindsTests</c> reads this list, so removing an
    /// entry without giving the action a word turns the suite red rather than the trace wrong.
    /// </para>
    ///
    /// <para>
    /// The settlement rows are excluded because <b>the money is already on the wallet strand with
    /// a balance beside it</b>, and a night that showed both would count one payment twice.
    /// <c>device.event_time_clamped</c> is excluded because it is written BESIDE the scan it
    /// describes carrying the identical details — the exact double that
    /// <see cref="DoorAuditActions.EventTimeClamped"/> documents — and it is a fact about a
    /// board's clock, never about a person.
    /// </para>
    ///
    /// <para>
    /// <c>member.door_history_viewed</c> (D9) is excluded because it is something an ADMIN did
    /// while reading about the member, not something the member did or had done to them that
    /// night — and it is written on every read, so a trace would otherwise grow a row each time
    /// somebody looked at it. It stays in <c>audit_log</c> as the access record it is.
    /// </para>
    /// </summary>
    public static readonly string[] NotAPersonsNight =
    [
        "booking.charged",
        "booking.charged_by_payer_override",
        "booking.cancelled_lights_charged",
        "booking.cancelled_lights_adjusted",
        "booking.lit_window_narrowed",
        "booking.payer_reassigned",
        "booking.block_lifted",
        DoorAuditActions.EventTimeClamped,
        Endpoints.AdminMemberDoorEndpoints.ViewedAction,
    ];

    // ------------------------------------------------------------------ mapping

    /// <summary>
    /// The word for one <c>audit_log</c> action, <c>null</c> when the action is declared not to
    /// be a person's night, and <see cref="Unrecognised"/> when nobody has met it.
    /// </summary>
    /// <param name="action">The row's raw action string.</param>
    /// <param name="actorIsSubject">
    /// Whether the person whose night this is did it themselves. <b>The one input that decides
    /// "cancelled" from "cancelled by the club", and it is NOT
    /// <c>ActorUserId != SubjectUserId</c></b> — see <see cref="TraceActors"/> and D2-B41.
    /// </param>
    public static string? OfAudit(string action, bool actorIsSubject)
    {
        if (Array.IndexOf(NotAPersonsNight, action) >= 0) return null;
        if (action.StartsWith(DoorTrail.DeniedPrefix, StringComparison.Ordinal)) return DoorRefused;
        if (action.StartsWith(DevicePrefix, StringComparison.Ordinal)) return OfDeviceAction(action);

        return action switch
        {
            DoorTrail.OpenedAction => DoorOpened,

            "court.activated" => CourtCheckedIn,
            LightsOnAction => LightsOn,
            LightsOffAction => LightsOff,
            ActivationRefusedAction => CourtRefused,

            "booking.created" or "booking.created_overdrawn" => BookingMade,
            "booking.created_on_behalf" or "booking.created_on_behalf_overdrawn" => BookingMadeForThem,
            "booking.walk_up_created" => WalkUpBought,
            "booking.walk_up_voided" => WalkUpRefunded,
            "booking.cancelled" => actorIsSubject ? BookingCancelled : BookingCancelledByClub,
            "booking.cancelled_by_club" => BookingCancelledByClub,
            "booking.no_show" => BookingNoShow,
            "booking.no_show_reversed" => BookingNoShowReversed,
            "booking.displaced" => BookingDisplaced,
            "booking.displacement_reversed" => BookingDisplacementReversed,
            "booking.blocked" => BookingBlockedOver,

            _ => Unrecognised,
        };
    }

    /// <summary>The namespace every row an uploaded device event writes is under.</summary>
    private const string DevicePrefix = "device.";

    /// <summary>
    /// D2 §6.4's new lights rows. Declared here so the word exists before the lane that writes
    /// the row lands — the trace renders it the day it appears rather than a release later.
    /// </summary>
    public const string LightsOnAction = "court.lights_on";

    /// <summary>The other half of the pair. See <see cref="LightsOnAction"/>.</summary>
    public const string LightsOffAction = "court.lights_off";

    /// <summary>D2 §6.4's refusal row — today every refusal branch writes nothing at all (§1.6).</summary>
    public const string ActivationRefusedAction = "court.activation_refused";

    /// <summary>
    /// The word for one <c>device.*</c> row.
    ///
    /// <para>
    /// The upload path writes <c>device.{kind}</c> for the event and a second
    /// <c>device.{kind}_{outcome}</c> beside it whenever the outcome was not <c>ok</c>, so the
    /// EXACT string is the success and anything longer is the refusal. Matched by prefix and
    /// then by exact equality rather than by <c>Contains</c>: <c>device.activation</c> and
    /// <c>device.activation_no_booking</c> differ by a suffix and mean opposite things.
    /// A board's own story — boot, fault, an unreadable kind — is not a person's night and
    /// reaches <c>null</c>. Block body for the lizard reason in <c>memory/gotchas.md</c>.
    /// </para>
    /// </summary>
    private static string? OfDeviceAction(string action)
    {
        if (Matches(action, DoorTrail.OfflineOpenAction)) return action == DoorTrail.OfflineOpenAction
            ? DoorOpenedOffline
            : DoorRefused;
        if (Matches(action, DoorTrail.OfflineUnknownScanAction)) return DoorRefused;
        if (Matches(action, ActivationAction)) return action == ActivationAction ? CourtCheckedIn : CourtRefused;
        if (Matches(action, ReleaseAction)) return LightsOff;
        return null;
    }

    /// <summary>The uploaded activation's own action.</summary>
    private const string ActivationAction = "device.activation";

    /// <summary>The uploaded release's own action — the only measurement of what the lights did.</summary>
    private const string ReleaseAction = "device.release";

    /// <summary>
    /// Whether an action is this base one or this base one with an outcome appended — and never
    /// merely one that starts with the same letters, which is why the boundary character is
    /// checked rather than trusted to <c>StartsWith</c>.
    /// </summary>
    private static bool Matches(string action, string baseAction)
        => action == baseAction
           || (action.Length > baseAction.Length
               && action[baseAction.Length] == '_'
               && action.StartsWith(baseAction, StringComparison.Ordinal));

    /// <summary>
    /// The word for one ledger movement. Every member of the enum reaches one — a type with no
    /// word would render a member's own money as "no word for this", which
    /// <c>TraceKindsTests</c> refuses.
    /// </summary>
    public static string OfLedger(LedgerEntryType type)
    {
        // Block body for the lizard reason in `memory/gotchas.md`: lizard's C# parser cannot
        // follow `=> x switch { … }`, loses scope, and emits a `*global*` pseudo-function
        // spanning the whole FILE, which then trips the function-length gate.
        return type switch
        {
            LedgerEntryType.TopUp => WalletToppedUp,
            LedgerEntryType.AdminTopUp => WalletToppedUpAtTheDesk,
            LedgerEntryType.BookingCharge or LedgerEntryType.LightsPurchase => WalletSpent,
            LedgerEntryType.CancellationRefund => WalletRefunded,
            LedgerEntryType.NoShowPenalty or LedgerEntryType.LateCancellationPenalty => WalletPenalised,
            LedgerEntryType.AdminAdjustment => WalletAdjustedByAdmin,
            LedgerEntryType.PaymentReversal => WalletReversed,
            LedgerEntryType.ShareTransfer => WalletShareMoved,
            _ => Unrecognised,
        };
    }

    /// <summary>The strand one word belongs to, derived from its namespace rather than listed twice.</summary>
    public static string StrandOf(string kind)
    {
        if (kind.StartsWith("door.", StringComparison.Ordinal)) return DoorStrand;
        if (kind.StartsWith("booking.", StringComparison.Ordinal)) return BookingStrand;
        if (kind.StartsWith("walkup.", StringComparison.Ordinal)) return BookingStrand;
        if (kind.StartsWith("court.", StringComparison.Ordinal)) return CourtStrand;
        if (kind.StartsWith("lights.", StringComparison.Ordinal)) return LightsStrand;
        if (kind.StartsWith("wallet.", StringComparison.Ordinal)) return WalletStrand;
        return OtherStrand;
    }

    // ------------------------------------------------------------------ sentences

    /// <summary>
    /// The sentence a volunteer admin reads, composed here rather than in the browser.
    ///
    /// <para>
    /// Every sentence is a statement about the person whose night this is, in the third person
    /// and in the past tense, because that is how somebody reads a log of an evening. A missing
    /// detail degrades the sentence rather than breaking it — "Came in through a door" is true
    /// where "Came in through " is not.
    /// </para>
    /// </summary>
    public static string Headline(string kind, TraceFacts facts)
    {
        var door = string.IsNullOrWhiteSpace(facts.DoorName) ? "a door" : facts.DoorName.Trim();
        var court = string.IsNullOrWhiteSpace(facts.CourtName) ? "a court" : facts.CourtName.Trim();

        return kind switch
        {
            DoorOpened => $"Came in through {door}",
            DoorOpenedOffline => $"Came in through {door} while it was offline",
            DoorRefused => $"Was turned away at {door}",

            BookingMade => $"Booked {court}",
            BookingMadeForThem => BookedForThem(court, facts),
            BookingCancelled => $"Cancelled {court}",
            BookingCancelledByClub => CancelledByClub(court, facts),
            BookingNoShow => "The club's automatic check marked this as a no-show",
            BookingNoShowReversed => "The club took a no-show back",
            BookingBlockedOver => $"The club blocked out {court}",
            BookingDisplaced => $"The club moved this booking on {court} aside",
            BookingDisplacementReversed => $"The club put this booking on {court} back",

            WalkUpBought => $"Bought light time at {court}",
            WalkUpRefunded => $"Light time at {court} was given back",

            CourtCheckedIn => $"Checked in at {court}",
            CourtRefused => $"Was refused at {court}",

            LightsOn => $"{court} lights came on",
            LightsOff => $"{court} lights went off",

            WalletToppedUp => $"Topped up {Credits(facts)} credits",
            WalletToppedUpAtTheDesk => ToppedUpAtTheDesk(facts),
            WalletSpent => Spent(facts),
            WalletRefunded => Refunded(facts),
            WalletPenalised => Penalised(facts),
            WalletAdjustedByAdmin => AdjustedByAdmin(facts),
            WalletReversed => $"A payment of {Credits(facts)} credits was reversed",
            WalletShareMoved => $"A share of a split booking moved: {Credits(facts)} credits",

            _ => $"Something this club's records have no word for ({facts.RawAction ?? kind})",
        };
    }

    /// <summary>The movement as a club reads it, or a dash when the row carries none.</summary>
    private static string Credits(TraceFacts facts)
    {
        // Block body for the lizard reason in `memory/gotchas.md`: a `{ }` property pattern in
        // an expression-bodied member costs this file its scope in lizard's C# parser.
        return facts.AmountCredits is { } amount
            ? Math.Abs(amount).ToString("0.00", System.Globalization.CultureInfo.InvariantCulture)
            : "—";
    }

    /// <summary>Whether the club's own machinery did this, rather than a person.</summary>
    private static bool BySystem(TraceFacts facts) => facts.ActorKind == TraceActors.System;

    /// <summary>The actor, named where naming them says something. Block body for the lizard reason.</summary>
    private static string Who(TraceFacts facts)
    {
        if (BySystem(facts)) return "The club's automatic check";
        return string.IsNullOrWhiteSpace(facts.ActorName) ? "Somebody at the club" : facts.ActorName.Trim();
    }

    private static string BookedForThem(string court, TraceFacts facts)
        => $"{Who(facts)} booked {court} for them";

    private static string CancelledByClub(string court, TraceFacts facts)
        => BySystem(facts)
            ? $"The club's automatic check cancelled {court}"
            : $"{Who(facts)} cancelled {court} for them";

    private static string Refunded(TraceFacts facts)
        => BySystem(facts)
            ? $"The club's automatic check returned {Credits(facts)} credits"
            : $"Got {Credits(facts)} credits back";

    private static string Penalised(TraceFacts facts)
        => BySystem(facts)
            ? $"The club's automatic check charged a penalty of {Credits(facts)} credits"
            : $"Was charged a penalty of {Credits(facts)} credits";

    private static string AdjustedByAdmin(TraceFacts facts)
        => $"{Who(facts)} changed their credits by {Credits(facts)}";

    /// <summary>
    /// A top-up the club took by hand. It names the actor for the reason
    /// <see cref="AdjustedByAdmin"/> does: the member was not the one who did it, and a night
    /// that says "Topped up 200 credits" about a payment somebody else keyed in is a sentence
    /// the member cannot check.
    /// </summary>
    private static string ToppedUpAtTheDesk(TraceFacts facts)
        => $"{Who(facts)} added {Credits(facts)} credits at the desk";

    /// <summary>
    /// What they paid for, named when the row knows it. D2 §6.2's own example sentence is
    /// "Paid 36.00 credits for Court 2", and the court is what makes it answer a question — but
    /// a ledger row carries no court of its own, so the sentence degrades rather than inventing
    /// one. Block body for the lizard reason in <c>memory/gotchas.md</c>.
    /// </summary>
    private static string Spent(TraceFacts facts)
    {
        var paid = $"Paid {Credits(facts)} credits";
        return string.IsNullOrWhiteSpace(facts.CourtName) ? paid : $"{paid} for {facts.CourtName.Trim()}";
    }
}

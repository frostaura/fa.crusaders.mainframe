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

    /// <summary>The movement, in minutes, unsigned — the sentence carries the direction.</summary>
    public int? AmountMinutes { get; init; }

    /// <summary>Who did it, when naming them makes the sentence say something.</summary>
    public string? ActorName { get; init; }

    /// <summary>One of <see cref="TraceActors"/>. A <see cref="TraceActors.System"/> row says so.</summary>
    public string? ActorKind { get; init; }

    /// <summary>The raw action, for <see cref="TraceKinds.Unrecognised"/> and nothing else.</summary>
    public string? RawAction { get; init; }

    /// <summary>The person the row is ABOUT, when the sentence has to name them — see <see cref="OthersMoney"/>.</summary>
    public string? SubjectName { get; init; }

    /// <summary>
    /// The movement is somebody else's money: the person whose night this is only ACTED on it
    /// (review round 6, E6-1). "Got 60 minutes back" on a payer's night was the booker's refund
    /// read as the payer's own; the sentence names whose minutes moved instead.
    /// </summary>
    public bool OthersMoney { get; init; }

    /// <summary>
    /// The no-show sweep refunded the booking in full because no box on its court could be
    /// reached (§6a) — the club's outage, not the member's absence (review round 7, E7-1/E7-2).
    /// On a <c>booking.no_show_reversed</c> row: the refund being taken back was that outage
    /// refund, so the row never calls it a no-show (review round 9, E9-2).
    /// </summary>
    public bool CourtWasDark { get; init; }

    /// <summary>
    /// The refusal was <c>code_used</c> — a code already acted on, as a photo of one is. Said in
    /// the headline at a door and at a court box alike (review round 9, E9-6), never the code.
    /// </summary>
    public bool CodeUsed { get; init; }

    /// <summary>
    /// What a court-box refusal was asked to do, as its writer stored it — <c>activate</c>,
    /// <c>walkup</c> or <c>pay_for</c> (review round 11, E11-4). A walk-up and a pay-for refused at
    /// one court read as the same "Was turned away" row and the Night folded them into one.
    /// </summary>
    public string? Attempt { get; init; }

    /// <summary>
    /// A board refused the member's genuine code while it was offline (review round 11, D11-2) —
    /// said neutrally, because the board's own reason is not uploaded.
    /// </summary>
    public bool RefusedOffline { get; init; }

    /// <summary>
    /// The server's verdict on an uploaded court-box <c>activation</c> it did not accept — the
    /// stored <c>outcome</c> of a <c>device.activation_{outcome}</c> row (review round 12, E12-1):
    /// <c>forgery_suspected</c>, <c>unresolved</c>, <c>unverifiable</c>, <c>wrong_court</c>. Said as
    /// the reason, neutrally — a forgery is "the code could not be verified", never an accusation.
    /// </summary>
    public string? Verdict { get; init; }

    /// <summary>
    /// A court box's own name, for a court-box row that happened at no court (relay -1) — review
    /// round 12, D12-2: the relay index is the board's wiring, never a court. Null when the box is
    /// unnamed, and the sentence says "the court box".
    /// </summary>
    public string? BoxName { get; init; }

    /// <summary>
    /// The club took no rand for this desk top-up — a free package (<c>package_free</c>) or a sale
    /// recorded at R0.00 — so it was given, not sold (review round 8, E8-5).
    /// </summary>
    public bool NoCharge { get; init; }

    /// <summary>
    /// The organiser of the game a partner withdrew from, named on the partner's own row (review
    /// round 13, E13-4). Null when the record does not say, and the sentence says "a game".
    /// </summary>
    public string? OrganiserName { get; init; }

    /// <summary>
    /// A share returned BECAUSE this partner withdrew from the game — the partner's name (E13-4).
    /// Null on every other share movement, which keeps its own words.
    /// </summary>
    public string? WithdrewName { get; init; }

    /// <summary>
    /// A displaced booking's cause: whose earlier booking's late check-in took the court back
    /// (review round 13, E13-8). Null when the record cannot say, and the sentence stays neutral.
    /// </summary>
    public string? CausedByName { get; init; }

    /// <summary>
    /// R15 E15-3: on a club add, the club placed them as playing rather than inviting them —
    /// "put them in" rather than "added them to".
    /// </summary>
    public bool Placed { get; init; }

    /// <summary>
    /// R15 E15-3 / J15-4: why a share row moved — one of <see cref="WalletShareCauses"/>, read off
    /// the record (<c>ShareRowCauses</c>). Null on a row nobody derived one for, which keeps the
    /// pre-R15 words.
    /// </summary>
    public string? ShareCause { get; init; }

    /// <summary>R15: the share row's partner, named — null when it is the person whose night this is ("they").</summary>
    public string? PartnerName { get; init; }

    /// <summary>R15: the share row's organiser, named — null when it is the person whose night this is ("they").</summary>
    public string? OrganiserSideName { get; init; }

    /// <summary>R15: the share row is a COLLECTION (partner to organiser) rather than a return.</summary>
    public bool Collection { get; init; }

    /// <summary>
    /// R16 J16-2: who joined the game, on a share row whose cause is <see cref="WalletShareCauses.PlayerAdded"/>
    /// and on the split change that recorded it. Null everywhere else.
    /// </summary>
    public string? JoinedName { get; init; }

    /// <summary>
    /// R16 E16-6: the row's actor is somebody other than the person whose night this is, and the row
    /// is about them — "Pat checked in at Court 1" on the booker's night, never "Checked in".
    /// </summary>
    public bool ByOther { get; init; }

    /// <summary>
    /// R16 E16-6: the person whose night this is did it to somebody else's booking — the scanning
    /// partner's own reversal reads in their voice, naming whose game it was.
    /// </summary>
    public bool ForOther { get; init; }

    /// <summary>
    /// R17 J17-4: the person whose night this is checked in on their own seat of somebody else's game —
    /// that game's organiser, named ("Checked in at Court 1 for Olive's booking"). Null otherwise.
    /// </summary>
    public string? SeatOfName { get; init; }

    /// <summary>
    /// R18 E18-8: the person whose night this is did it themselves — their own late check-in reads
    /// "Their check-in reached the club late", never their own name in the third person.
    /// </summary>
    public bool BySelf { get; init; }

    /// <summary>
    /// R19 E19-3: the row is a pay-for at the box by a member with no accepted seat on the booking — they
    /// paid for the court and lit it ("Pons Partner paid for Court 1 at the court box and lit it"), and
    /// never "checked in": they were not a player on it.
    /// </summary>
    public bool PaidAndLit { get; init; }
}

/// <summary>
/// R15 E15-3 / J15-4: from where the person whose night it is sees an audit row. A seat act or a
/// booking-level act reaches a night three ways, and the same row needs a different sentence on each.
/// </summary>
public enum TraceView
{
    /// <summary>They are the row's actor or its subject — the sentence every row always had.</summary>
    Own,

    /// <summary>They organised the game the row's seat is on, and neither did it nor had it done to them (an admin's act on their partner).</summary>
    Organiser,

    /// <summary>They held a partner's seat on the booking the row is about (its no-show, its reversal).</summary>
    Partner,
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
    /// The club's automatic check marked a booking as missed — or refunded it in full because the
    /// court's box was offline, which the row's <c>peripheral_outage</c> says.
    ///
    /// <para>
    /// <c>NoShowWorker</c> writes the row in the sweep's own save (review round 7, E7-1). Before
    /// it did, a late upload's "The club took a no-show back" followed no row saying one was ever
    /// marked.
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

    /// <summary>
    /// They paid for somebody else's court at the box (D10). <b>Added beyond D2 §6.2</b> — review
    /// round 6, E6-3: the pay-for's own row read "no word for this" on both members' nights.
    /// </summary>
    public const string BookingPaidForSomebody = "booking.paid_for_somebody";

    /// <summary>Somebody else paid for their court at the box (D10). <b>Added beyond D2 §6.2.</b></summary>
    public const string BookingPaidForThem = "booking.paid_for_them";

    /// <summary>
    /// They withdrew from somebody else's game — a partner's own act (review round 13, E13-4).
    /// <b>Added beyond D2 §6.2</b>: the withdrawal wrote nothing, and its share return read as the
    /// club's automatic check.
    /// </summary>
    public const string BookingWithdrew = "booking.withdrew";

    /// <summary>A partner withdrew from THEIR game (E13-4) — the organiser's side of the same row.</summary>
    public const string BookingPartnerWithdrew = "booking.partner_withdrew";

    /// <summary>The audit action a partner's withdrawal writes (C13-4, <c>PlayersService.WithdrewAction</c>).</summary>
    public const string PartnerWithdrewAction = "players.withdrew";

    /// <summary>
    /// Somebody took them off a game — the organiser, or the club (R14 E14-2). <b>Added beyond D2
    /// §6.2</b>: the removal wrote nothing, and its share return read as the club's automatic check.
    /// </summary>
    public const string BookingTakenOff = "booking.taken_off";

    /// <summary>They took a player off a game (R14 E14-2) — the remover's side of the same row.</summary>
    public const string BookingTookPlayerOff = "booking.took_player_off";

    /// <summary>The organiser changed how their game is split, and their share moved (R14 E14-2).</summary>
    public const string BookingSplitChanged = "booking.split_changed";

    /// <summary>They changed how their game is split (R14 E14-2) — the organiser's side.</summary>
    public const string BookingChangedSplit = "booking.changed_split";

    /// <summary>A game they were a partner in was cancelled — by the organiser or the club (R14 E14-2).</summary>
    public const string BookingGameCancelled = "booking.game_cancelled";

    /// <summary>R15 E15-3: the club took a partner off THEIR game — the organiser's side of an admin's removal.</summary>
    public const string BookingClubTookPlayerOff = "booking.club_took_player_off";

    /// <summary>R15 E15-3: the club recorded their share as paid by hand (the partner's side).</summary>
    public const string BookingShareSettledOutside = "booking.share_settled_outside";

    /// <summary>R15 E15-3: the club recorded a partner's share of THEIR game as paid by hand (the organiser's side).</summary>
    public const string BookingPartnerShareSettledOutside = "booking.partner_share_settled_outside";

    /// <summary>R15 E15-3: they (an admin) recorded a partner's share as paid by hand.</summary>
    public const string BookingSettledShareOutside = "booking.settled_share_outside";

    /// <summary>R15 E15-3: the club collected their share by hand (the partner's side).</summary>
    public const string BookingShareCollected = "booking.share_collected";

    /// <summary>R15 E15-3: the club collected a partner's share of THEIR game (the organiser's side).</summary>
    public const string BookingPartnerShareCollected = "booking.partner_share_collected";

    /// <summary>R15 E15-3: they (an admin) collected a partner's share.</summary>
    public const string BookingCollectedShare = "booking.collected_share";

    /// <summary>R16 E16-1: the club accepted their invite to somebody's game for them (the partner's side).</summary>
    public const string BookingAcceptedForThem = "booking.accepted_for_them";

    /// <summary>R16 E16-1: the club accepted a partner's invite to THEIR game (the organiser's side).</summary>
    public const string BookingClubAcceptedPlayer = "booking.club_accepted_player";

    /// <summary>R16 E16-1: they (an admin) accepted a partner's invite on the partner's behalf.</summary>
    public const string BookingAcceptedForPlayer = "booking.accepted_for_player";

    /// <summary>R17 E17-8: they were invited to somebody's game (the invitee's side).</summary>
    public const string BookingInvited = "booking.invited";

    /// <summary>R17 E17-8: they invited a member to their game (the organiser's side).</summary>
    public const string BookingInvitedPlayer = "booking.invited_player";

    /// <summary>R17 E17-8: they accepted their place in somebody's game.</summary>
    public const string BookingAccepted = "booking.accepted";

    /// <summary>R17 E17-8: a member accepted a place in THEIR game (the organiser's side).</summary>
    public const string BookingPartnerAccepted = "booking.partner_accepted";

    /// <summary>R17 E17-8: they declined a place in somebody's game.</summary>
    public const string BookingDeclined = "booking.declined";

    /// <summary>R17 E17-8: a member declined a place in THEIR game (the organiser's side).</summary>
    public const string BookingPartnerDeclined = "booking.partner_declined";

    /// <summary>R17 E17-8: the organiser invited a member (<c>PlayersService.InvitedAction</c>; actor the organiser, subject the invitee).</summary>
    public const string InvitedAction = "players.invited";

    /// <summary>R17 E17-8: a member accepted their invite themselves (<c>PlayersService.AcceptedAction</c>; actor and subject the member).</summary>
    public const string AcceptedAction = "players.accepted";

    /// <summary>R17 E17-8: a member declined their invite (<c>PlayersService.DeclinedAction</c>; actor and subject the member).</summary>
    public const string DeclinedAction = "players.declined";

    /// <summary>
    /// R17 J17-4: one seat's check-in (BE17b, written beside every seat stamp; actor and subject the
    /// scanner, the organiser in the details, <c>lit_court</c> when the same scan also wrote
    /// <c>court.activated</c>). Mapped to <see cref="CourtCheckedIn"/>; a lit-court row folds into its twin.
    /// </summary>
    public const string SeatCheckedInAction = "court.checked_in";

    /// <summary>R16 E16-1: the desk accepted a partner's invite for them (<c>PlayersService.AcceptedByClubAction</c>).</summary>
    public const string AcceptedByClubAction = "players.accepted_by_club";

    /// <summary>R15 E15-3: the club added them to somebody's game, or put them in it (the member's side).</summary>
    public const string BookingAddedToGame = "booking.added_to_game";

    /// <summary>R15 E15-3: the club added a member to THEIR game (the organiser's side).</summary>
    public const string BookingClubAddedPlayer = "booking.club_added_player";

    /// <summary>R15 E15-3: they (an admin) added a member to somebody's game.</summary>
    public const string BookingAddedPlayer = "booking.added_player";

    /// <summary>R15 J15-4: a game they were a partner in was settled as a no-show, or refunded for an outage.</summary>
    public const string BookingGameNoShow = "booking.game_no_show";

    /// <summary>R15 J15-4: that no-show or outage refund was reversed by a late check-in.</summary>
    public const string BookingGameNoShowReversed = "booking.game_no_show_reversed";

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

    /// <summary>
    /// R18 E18-3: a box re-energised a court's relay after a power cut, from the heartbeat's restore
    /// answer (<c>court.lights_restored</c>). <b>Added beyond D2 §6.2</b>: it read "no word for
    /// this" on the booker's Night, once per confirmed restore.
    /// </summary>
    public const string LightsRestored = "lights.restored";

    /// <summary>Money in.</summary>
    public const string WalletToppedUp = "wallet.topped_up";

    /// <summary>
    /// Money in, taken by hand at the desk — cash, an EFT that cleared, a card taken offline.
    ///
    /// <para>
    /// <b>Its own word rather than <see cref="WalletToppedUp"/>'s, and not
    /// <see cref="WalletAdjustedByAdmin"/>'s either.</b> The member did not do it, so "Bought
    /// 5 hours" is a sentence about somebody who was not there; and it is not an adjustment,
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

    /// <summary>An admin moved minutes by hand.</summary>
    public const string WalletAdjustedByAdmin = "wallet.adjusted_by_admin";

    /// <summary>A payment was clawed back after the fact. <b>Added beyond D2 §6.2.</b></summary>
    public const string WalletReversed = "wallet.reversed";

    /// <summary>
    /// A partner's share of a split booking moved between two members (D11) — paid to the
    /// organiser, or handed back. Its own word, because it is none of the club's: the club took
    /// nothing and gave nothing back.
    /// </summary>
    public const string WalletShareMoved = "wallet.share_moved";

    // ---- the account (review round 1, lane F3: the Night tab printed raw codes for these) ----

    public const string AccountApplied = "account.applied";
    public const string AccountApproved = "account.approved";
    public const string AccountRejected = "account.rejected";
    public const string AccountSuspended = "account.suspended";
    public const string AccountReactivated = "account.reactivated";

    /// <summary>The club deleted the account: erased in place, the history kept under "Deleted member".</summary>
    public const string AccountDeleted = "account.deleted";
    public const string AccountMadeAdmin = "account.made_admin";
    public const string AccountAdminRemoved = "account.admin_removed";
    public const string AccountCodeReset = "account.code_reset";
    public const string AccountPasskeysRemoved = "account.passkeys_removed";
    public const string AccountPasswordChanged = "account.password_changed";
    public const string AccountPasswordReset = "account.temporary_password";

    /// <summary>The club moved them into or out of member groups — their tariff (review round 8, E8-3).</summary>
    public const string AccountGroupsChanged = "account.groups_changed";

    /// <summary>They put their member code on a phone for the first time (review round 8, E8-3).</summary>
    public const string AccountCodeSetUp = "account.code_set_up";

    /// <summary>R18 E18-3 sweep: they set their own court PIN (<c>user.pin_set</c>).</summary>
    public const string AccountPinSet = "account.pin_set";

    /// <summary>R18 E18-3 sweep: the desk set their court PIN for them (<c>user.pin_set_by_admin</c>).</summary>
    public const string AccountPinSetForThem = "account.pin_set_for_them";

    /// <summary>R18 E18-3 sweep: they cleared their own court PIN (<c>user.pin_cleared</c>).</summary>
    public const string AccountPinCleared = "account.pin_cleared";

    /// <summary>R18 E18-3 sweep: the desk enrolled their fingerprint (<c>biometric.enrolled</c>).</summary>
    public const string AccountFingerprintEnrolled = "account.fingerprint_enrolled";

    /// <summary>
    /// R18 E18-3 sweep: they became an administrator because the club's configuration names their
    /// address (<c>user.admin_inherited</c>, written by their own sign-in) — nobody granted it.
    /// </summary>
    public const string AccountAdminInherited = "account.admin_inherited";

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
        BookingPaidForSomebody, BookingPaidForThem, BookingWithdrew, BookingPartnerWithdrew,
        BookingTakenOff, BookingTookPlayerOff, BookingSplitChanged, BookingChangedSplit, BookingGameCancelled,
        BookingClubTookPlayerOff, BookingShareSettledOutside, BookingPartnerShareSettledOutside, BookingSettledShareOutside,
        BookingShareCollected, BookingPartnerShareCollected, BookingCollectedShare,
        BookingAddedToGame, BookingClubAddedPlayer, BookingAddedPlayer, BookingGameNoShow, BookingGameNoShowReversed,
        BookingAcceptedForThem, BookingClubAcceptedPlayer, BookingAcceptedForPlayer,
        BookingInvited, BookingInvitedPlayer, BookingAccepted, BookingPartnerAccepted, BookingDeclined, BookingPartnerDeclined,
        WalkUpBought, WalkUpRefunded,
        CourtCheckedIn, CourtRefused,
        LightsOn, LightsOff, LightsRestored,
        WalletToppedUp, WalletToppedUpAtTheDesk, WalletSpent, WalletRefunded, WalletPenalised,
        WalletAdjustedByAdmin, WalletReversed, WalletShareMoved,
        AccountApplied, AccountApproved, AccountRejected, AccountSuspended, AccountReactivated, AccountDeleted,
        AccountMadeAdmin, AccountAdminRemoved, AccountCodeReset, AccountPasskeysRemoved,
        AccountPasswordChanged, AccountPasswordReset, AccountGroupsChanged, AccountCodeSetUp,
        AccountPinSet, AccountPinSetForThem, AccountPinCleared, AccountFingerprintEnrolled, AccountAdminInherited,
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
        // The desk's minutes movement is on the wallet strand already (its ledger row, with the
        // balance beside it); its audit twin made one desk sale read twice (review round 1, F3).
        // The stored audit code is kept (contract §2.5).
        "credit.adjusted",
        DoorAuditActions.EventTimeClamped,
        Endpoints.AdminMemberDoorEndpoints.ViewedAction,
        // R18 E18-3 sweep: the club's own console acts — no member is their subject. Each is on the
        // club's change log already; on the acting admin's Night they read "no word for this".
        Endpoints.AdminDoorFleetEndpoint.ShutAllAction,
        Endpoints.AdminDoorFleetEndpoint.ReopenedAllAction,
        Endpoints.AdminDoorLogEndpoint.ExportedAction,
        Endpoints.AdminMonitoringEndpoints.ResolvedAction,
        Endpoints.AdminMonitoringEndpoints.ExportedAction,
        MemberCodeRollout.PhaseChangedAction,
        // The retention sweep's own record — its actor is the anonymised sentinel, never a person.
        "retention.anonymised",
        // An extension bought at the box: the extension IS a walk-up-shaped booking, whose own
        // `booking.walk_up_created` row (written by CommitAsync, same actor and subject) already puts
        // the purchase on the scanner's Night and its LightsPurchase row on the wallet strand. This
        // twin only names which session was extended; worded too, one purchase would read twice.
        Endpoints.DeviceExtendEndpoint.ExtendedAction,
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
    public static string? OfAudit(string action, bool actorIsSubject) => OfAudit(action, actorIsSubject, TraceView.Own);

    /// <summary>
    /// R15 E15-3 / J15-4: <see cref="OfAudit(string, bool)"/> from where the person whose night it is
    /// stands. <see cref="TraceView.Own"/> is the plain answer; the organiser of the game an admin
    /// acted on, and a partner on a booking the club settled, each get their own word — or none,
    /// for a row that is not theirs to see that way.
    /// </summary>
    public static string? OfAudit(string action, bool actorIsSubject, TraceView view)
    {
        return view switch
        {
            TraceView.Organiser => OfOrganisersView(action),
            TraceView.Partner => OfPartnersView(action),
            _ => OfOwnAudit(action, actorIsSubject),
        };
    }

    /// <summary>R15 E15-3: a seat act an admin did on a partner of THEIR game.</summary>
    private static string? OfOrganisersView(string action)
    {
        return action switch
        {
            PartnerWithdrewAction => BookingPartnerWithdrew,
            PlayerRemovedAction => BookingClubTookPlayerOff,
            SettledOutsideAction => BookingPartnerShareSettledOutside,
            ShareCollectedAction => BookingPartnerShareCollected,
            AddedByClubAction => BookingClubAddedPlayer,
            AcceptedByClubAction => BookingClubAcceptedPlayer,
            AcceptedAction => BookingPartnerAccepted,
            DeclinedAction => BookingPartnerDeclined,
            SeatCheckedInAction => CourtCheckedIn,
            _ => null,
        };
    }

    /// <summary>R15 J15-4: what the club did to the booking a partner paid into.</summary>
    private static string? OfPartnersView(string action)
    {
        return action switch
        {
            "booking.no_show" => BookingGameNoShow,
            "booking.no_show_reversed" => BookingGameNoShowReversed,
            // R17 E17-4: the court they played on lit — the lights row is about the booker.
            LightsOnAction => LightsOn,
            // R18 E18-3: and came back on after a power cut — the same booker's row, the same players.
            LightsRestoredAction => LightsRestored,
            // R19 E19-2: and went off — a session the partner played ends on their Night too.
            LightsOffAction => LightsOff,
            _ => null,
        };
    }

    /// <summary>
    /// The audit actions a partner's Night reads off the booking they paid into (R15 J15-4) — and
    /// R17 E17-4 the lights coming on (R19 E19-2: and going off), for an accepted partner and the payer
    /// at the box only.
    /// </summary>
    public static readonly string[] PartnersViewActions = ["booking.no_show", "booking.no_show_reversed", LightsOnAction, LightsRestoredAction, LightsOffAction];

    /// <summary>
    /// The seat acts an organiser's Night reads off the game's partners (R13 E13-4, R15 E15-3) — and
    /// R17 their own answers (E17-8) and their check-ins (J17-4).
    /// </summary>
    public static readonly string[] OrganisersViewActions =
    [
        PartnerWithdrewAction, PlayerRemovedAction, SettledOutsideAction, ShareCollectedAction, AddedByClubAction, AcceptedByClubAction,
        AcceptedAction, DeclinedAction, SeatCheckedInAction,
    ];

    private static string? OfOwnAudit(string action, bool actorIsSubject)
    {
        if (Array.IndexOf(NotAPersonsNight, action) >= 0) return null;
        if (action.StartsWith(DoorTrail.DeniedPrefix, StringComparison.Ordinal)) return DoorRefused;
        if (action.StartsWith(DevicePrefix, StringComparison.Ordinal)) return OfDeviceAction(action);

        return action switch
        {
            DoorTrail.OpenedAction => DoorOpened,

            "court.activated" => CourtCheckedIn,
            SeatCheckedInAction => CourtCheckedIn,
            LightsOnAction => LightsOn,
            LightsOffAction => LightsOff,
            LightsRestoredAction => LightsRestored,
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
            Endpoints.DevicePayForEndpoint.PaidAction => actorIsSubject ? BookingPaidForSomebody : BookingPaidForThem,
            PartnerWithdrewAction => actorIsSubject ? BookingWithdrew : BookingPartnerWithdrew,
            PlayerRemovedAction => actorIsSubject ? BookingTookPlayerOff : BookingTakenOff,
            SplitChangedAction => actorIsSubject ? BookingChangedSplit : BookingSplitChanged,
            // The canceller's own night has their booking.cancelled row already; one per partner would repeat it.
            GameCancelledAction => actorIsSubject ? null : BookingGameCancelled,
            SettledOutsideAction => actorIsSubject ? BookingSettledShareOutside : BookingShareSettledOutside,
            ShareCollectedAction => actorIsSubject ? BookingCollectedShare : BookingShareCollected,
            AddedByClubAction => actorIsSubject ? BookingAddedPlayer : BookingAddedToGame,
            AcceptedByClubAction => actorIsSubject ? BookingAcceptedForPlayer : BookingAcceptedForThem,
            InvitedAction => actorIsSubject ? BookingInvitedPlayer : BookingInvited,
            AcceptedAction => BookingAccepted,
            DeclinedAction => BookingDeclined,

            _ => OfAccountAction(action),
        };
    }

    /// <summary>The audit action a seat's removal writes (R14, <c>SeatFacts.RemovedAction</c>).</summary>
    public const string PlayerRemovedAction = "players.removed";

    /// <summary>The audit action a split change writes per partner (R14, <c>PlayersService.SplitChangedAction</c>).</summary>
    public const string SplitChangedAction = "players.split_changed";

    /// <summary>The audit action a cancelled game writes per partner (R14, <c>ShareSweep.GameCancelledAction</c>).</summary>
    public const string GameCancelledAction = "players.game_cancelled";

    /// <summary>R15 E15-3: the desk recorded a share paid by hand (<c>PlayersService.SettledOutsideAction</c>).</summary>
    public const string SettledOutsideAction = "players.settled_outside";

    /// <summary>R15 E15-3: the desk collected a share (<c>PlayersService.ShareCollectedAction</c>).</summary>
    public const string ShareCollectedAction = "players.share_collected";

    /// <summary>R15 E15-3: the desk added a member to a game (<c>PlayersService.AddedByClubAction</c>).</summary>
    public const string AddedByClubAction = "players.added_by_club";

    /// <summary>
    /// The account's own story — applying, the club's decisions, admin rights, the code, passkeys
    /// and passwords (review round 1, F3). Anything else is <see cref="Unrecognised"/>.
    /// Block body for the lizard reason in <c>memory/gotchas.md</c>.
    /// </summary>
    private static string OfAccountAction(string action)
    {
        return action switch
        {
            "member.registered" => AccountApplied,
            "member.approved" => AccountApproved,
            "member.rejected" => AccountRejected,
            "member.suspended" => AccountSuspended,
            "member.reactivated" => AccountReactivated,
            "member.deleted" => AccountDeleted,
            "user.admin_granted" => AccountMadeAdmin,
            "user.admin_revoked" => AccountAdminRemoved,
            "member_code.rotated" => AccountCodeReset,
            "member.passkeys_revoked" => AccountPasskeysRemoved,
            "user.password_changed" => AccountPasswordChanged,
            "user.password_reset_by_admin" => AccountPasswordReset,
            Endpoints.MemberGroupAudit.GroupsChanged => AccountGroupsChanged,
            MemberCodeService.EnrolledAction => AccountCodeSetUp,
            "user.pin_set" => AccountPinSet,
            "user.pin_set_by_admin" => AccountPinSetForThem,
            "user.pin_cleared" => AccountPinCleared,
            "biometric.enrolled" => AccountFingerprintEnrolled,
            InherentAdminService.PromotionAction => AccountAdminInherited,
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

    /// <summary>R18 E18-3: a box re-energised the relay after a power cut (<c>CourtLightStateService.LightsRestoredAction</c>).</summary>
    public const string LightsRestoredAction = CourtLightStateService.LightsRestoredAction;

    /// <summary>D2 §6.4's refusal row — today every refusal branch writes nothing at all (§1.6).</summary>
    public const string ActivationRefusedAction = "court.activation_refused";

    /// <summary>A court box's offline refusal, as stored (<c>DeviceEventEndpoints.CourtUnknownScanKind</c>; R11 D11-2).</summary>
    public const string CourtOfflineRefusalAction = "device.court_unknown_scan";

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
        // R11 D11-2: a court box's offline refusal reaches a member's night only once the server named them.
        if (action == CourtOfflineRefusalAction) return CourtRefused;
        // R12 E12-1: the uploaded event's OWN row is never the member's story. Its subject is set only
        // when the server refused it, and then its verdict row (`device.activation_{outcome}`) says
        // so; an accepted one is `court.activated` (the check-in) and the receipt (the lights). Read
        // as "Checked in", a forged or bookingless upload claimed a check-in that never counted.
        if (action == ActivationAction) return null;
        // R18 E18-8: a verdict the server ACCEPTED — a late scan that reversed a no-show, lit time
        // charged after a cancel, a displaced booking's collision — names its member (the device
        // activity shows who), and is no refusal: court.activated, the reversal and the money tell it.
        if (Array.IndexOf(AcceptedVerdictActions, action) >= 0) return null;
        if (Matches(action, ActivationAction)) return CourtRefused;
        if (Matches(action, ReleaseAction)) return LightsOff;
        return null;
    }

    /// <summary>The uploaded activation's own action.</summary>
    public const string ActivationAction = "device.activation";

    /// <summary>
    /// R18 E18-8: the verdict rows of uploaded activations the server ACCEPTED (<c>DeviceEventEndpoints.ActivationOutcome</c>'s
    /// non-refusal codes) — every other <c>device.activation_{outcome}</c> is a refusal.
    /// </summary>
    public static readonly string[] AcceptedVerdictActions =
    [
        ActivationAction + "_reversed_no_show",
        ActivationAction + "_after_cancel",
        ActivationAction + "_displaced_collision",
    ];

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
        if (facts.OthersMoney && StrandOf(kind) == WalletStrand) return OthersMoneyHeadline(kind, facts);

        var door = string.IsNullOrWhiteSpace(facts.DoorName) ? "a door" : facts.DoorName.Trim();
        var court = string.IsNullOrWhiteSpace(facts.CourtName) ? "a court" : facts.CourtName.Trim();

        return kind switch
        {
            DoorOpened => $"Came in through {door}",
            DoorOpenedOffline => $"Came in through {door} while it was offline",
            DoorRefused => $"Was turned away at {door}{UsedCode(facts)}{Offline(facts)}",

            BookingMade => $"Booked {court}",
            BookingMadeForThem => BookedForThem(court, facts),
            BookingCancelled => $"Cancelled {court}",
            BookingCancelledByClub => CancelledByClub(court, facts),
            BookingNoShow => facts.CourtWasDark
                ? $"The club refunded {court} in full — its box was offline"
                : "The club's automatic check marked this as a no-show",
            BookingNoShowReversed => NoShowReversed(facts),
            BookingBlockedOver => $"The club blocked out {court}",
            BookingDisplaced => Displaced(court, facts),
            BookingDisplacementReversed => $"The club put this booking on {court} back",
            BookingPaidForSomebody => $"Paid for {Subject(facts)}'s booking on {court} at the box",
            BookingPaidForThem => $"{Who(facts)} paid for their booking on {court} at the box",
            BookingWithdrew => string.IsNullOrWhiteSpace(facts.OrganiserName)
                ? $"Withdrew from a game on {court}"
                : $"Withdrew from {facts.OrganiserName.Trim()}'s game on {court}",
            BookingPartnerWithdrew => $"{ActorOr(facts, "A partner")} withdrew from their game on {court}",
            BookingTakenOff => $"{ActorOr(facts, "Somebody")} took them off {Whose(facts)}{court}",
            BookingTookPlayerOff => $"Took {Subject(facts)} off {Whose(facts)}{court}",
            BookingSplitChanged => SplitChanged(court, facts),
            BookingChangedSplit => ChangedSplit(court, facts),
            BookingGameCancelled => GameCancelled(court, facts),

            WalkUpBought => $"Bought light time at {court}",
            WalkUpRefunded => $"Light time at {court} was given back",

            CourtCheckedIn => CheckedIn(court, facts),
            CourtRefused => CourtRefusedHeadline(facts, court),

            LightsOn => $"{court} lights came on",
            LightsOff => $"{court} lights went off",
            LightsRestored => $"{court} lights came back on after a power cut",

            WalletToppedUp => $"Bought {Amount(facts)}",
            WalletToppedUpAtTheDesk => ToppedUpAtTheDesk(facts),
            WalletSpent => Spent(facts),
            WalletRefunded => Refunded(facts),
            WalletPenalised => Penalised(facts),
            WalletAdjustedByAdmin => AdjustedByAdmin(facts),
            WalletReversed => $"A payment for {Amount(facts)} was reversed",
            WalletShareMoved => ShareMoved(facts),

            _ => ClubSeatHeadline(kind, court, facts) ?? AccountHeadline(kind, facts),
        };
    }

    /// <summary>
    /// R15 E15-3 / J15-4: the club's seat acts from each side, and the club's settlement of a game
    /// as its partner reads it; null for any other word.
    /// </summary>
    private static string? ClubSeatHeadline(string kind, string court, TraceFacts facts)
    {
        var actor = ActorOr(facts, "Somebody at the club");
        var partner = Subject(facts);
        var theirs = OrganisersGame(facts, court);
        return kind switch
        {
            BookingClubTookPlayerOff => $"{actor} took {partner} off their game on {court}",
            BookingShareSettledOutside => $"{actor} recorded their share of {theirs} as paid by hand",
            BookingPartnerShareSettledOutside => $"{actor} recorded {partner}'s share of their game on {court} as paid by hand",
            BookingSettledShareOutside => $"Recorded {partner}'s share of {theirs} as paid by hand",
            BookingShareCollected => $"{actor} collected {Amount(facts)} from them for their share of {theirs}",
            BookingPartnerShareCollected => $"{actor} collected {partner}'s share of their game on {court}: {Amount(facts)}",
            BookingCollectedShare => $"Collected {Amount(facts)} from {partner} for their share of {theirs}",
            BookingAddedToGame => facts.Placed ? $"{actor} put them in {theirs}" : $"{actor} added them to {theirs}",
            BookingClubAddedPlayer => facts.Placed ? $"{actor} put {partner} in their game on {court}" : $"{actor} added {partner} to their game on {court}",
            BookingAddedPlayer => facts.Placed ? $"Put {partner} in {theirs}" : $"Added {partner} to {theirs}",
            BookingAcceptedForThem => $"{actor} accepted their place in {theirs} for them",
            BookingClubAcceptedPlayer => $"{actor} accepted {partner}'s place in their game on {court} for them",
            BookingAcceptedForPlayer => $"Accepted {partner}'s place in {theirs} for them",
            BookingGameNoShow => facts.CourtWasDark
                ? $"The club refunded {theirs} in full — its box was offline"
                : $"The club's automatic check marked {theirs} as a no-show",
            BookingGameNoShowReversed => GameNoShowReversed(theirs, facts),
            _ => SeatAnswerHeadline(kind, court, facts),
        };
    }

    /// <summary>R17 E17-8: a member's own invite, accept and decline — from their side and the organiser's; null for any other word.</summary>
    private static string? SeatAnswerHeadline(string kind, string court, TraceFacts facts)
    {
        var theirs = OrganisersGame(facts, court);
        var partner = ActorOr(facts, "A member");
        return kind switch
        {
            BookingInvited => $"{ActorOr(facts, "Somebody")} invited them to a game on {court}",
            BookingInvitedPlayer => $"Invited {Subject(facts)} to their game on {court}",
            BookingAccepted => $"Accepted their place in {theirs}",
            BookingPartnerAccepted => $"{partner} accepted a place in their game on {court}",
            BookingDeclined => $"Declined a place in {theirs}",
            BookingPartnerDeclined => $"{partner} declined a place in their game on {court}",
            _ => null,
        };
    }

    /// <summary>"Olive Organiser's game on Court 1" — or "a game on Court 1" when the record names no organiser.</summary>
    private static string OrganisersGame(TraceFacts facts, string court)
    {
        var organiser = facts.OrganiserName?.Trim();
        return string.IsNullOrEmpty(organiser) ? $"a game on {court}" : $"{organiser}'s game on {court}";
    }

    /// <summary>R15 J15-4: a partner's view of a late check-in reversing the club's settlement of the game they paid into.</summary>
    private static string GameNoShowReversed(string theirs, TraceFacts facts)
    {
        var what = facts.CourtWasDark ? "outage refund" : "no-show";
        var who = string.IsNullOrWhiteSpace(facts.ActorName) || BySystem(facts) ? "A check-in" : $"{facts.ActorName.Trim()}'s check-in";
        return $"{who} reached the club late — the {what} on {theirs} was reversed";
    }

    /// <summary>R11 D11-2: an offline refusal of a genuine code, said neutrally; empty otherwise.</summary>
    private static string Offline(TraceFacts facts) => facts.RefusedOffline ? " — refused offline" : "";

    /// <summary>
    /// A court-box refusal (review round 12, E12-1 / D12-2): a used code by what was attempted; an
    /// offline refusal said once ("while its box was offline", never "refused … refused offline");
    /// an uploaded activation the server did not accept, with the server's reason. A row at no
    /// court names the box, never the relay index.
    /// </summary>
    private static string CourtRefusedHeadline(TraceFacts facts, string court)
    {
        var known = !string.IsNullOrWhiteSpace(facts.CourtName);
        var box = string.IsNullOrWhiteSpace(facts.BoxName) ? null : facts.BoxName.Trim();
        if (facts.CodeUsed) return TurnedAway(facts, known ? court : box ?? CourtBoxWords);
        if (facts.RefusedOffline)
        {
            return known
                ? $"Was refused at {court} while its box was offline"
                : $"Was refused at {box ?? CourtBoxWords} while it was offline";
        }
        return $"Was refused at {(known ? court : box ?? CourtBoxWords)}{VerdictWords(facts.Verdict)}";
    }

    /// <summary>
    /// A court box with only its placeholder name, on every refusal branch (R12 D12-2, R13 D13-1: the
    /// verdict and used-code branches fell back to "a court").
    /// </summary>
    private const string CourtBoxWords = "the court box";

    /// <summary>
    /// R13 E13-8: a booking the club displaced — cancelled and refunded in full because an earlier
    /// booking's late check-in restored that session over its slot. Names the court, says both, and
    /// names whose earlier booking it was when the record knows; never "moved aside".
    /// </summary>
    private static string Displaced(string court, TraceFacts facts)
    {
        var cause = string.IsNullOrWhiteSpace(facts.CausedByName)
            ? "an earlier booking there was checked in late"
            : $"{facts.CausedByName.Trim()}'s earlier booking there was checked in late";
        return $"The club cancelled this booking on {court} and refunded it — {cause}";
    }

    /// <summary>
    /// A share of a split booking moving — and, when it went back because the partner withdrew (R13
    /// E13-4), said as the withdrawal's: "7 minutes went back to Sam — they withdrew from the game".
    /// </summary>
    private static string ShareMoved(TraceFacts facts)
    {
        // R16 E16-4: a row whose cause the record names says it through OwnShareMoved — the withdrawal
        // too, with its court and in the right voice ("they withdrew" on the organiser's night was wrong).
        if (facts.ShareCause is not null) return OwnShareMoved(facts);
        if (string.IsNullOrWhiteSpace(facts.WithdrewName)) return $"A share of a split booking moved: {Amount(facts)}";
        return facts.AmountMinutes > 0
            ? $"{Amount(facts)} of their share came back — they withdrew from the game"
            : $"{Amount(facts)} went back to {facts.WithdrewName.Trim()} — they withdrew from the game";
    }

    /// <summary>
    /// R15 E15-3 / J15-4: the person whose night this is moved their own money for a share — which
    /// way, with whom, and why ("A share of a split booking moved: 7 minutes" said none of it). They
    /// are "they"/"them" in the sentence; the other side is named.
    /// </summary>
    private static string OwnShareMoved(TraceFacts facts)
    {
        var court = ShareCourt(facts);
        var tracedIsPartner = facts.Collection == (facts.AmountMinutes < 0);
        var partner = tracedIsPartner ? ShareSide.Them : ShareSide.Named(facts.PartnerName);
        var organiser = tracedIsPartner ? ShareSide.Named(facts.OrganiserSideName) : ShareSide.Them;
        var why = ShareClause(facts, partner, organiser);
        var amount = Amount(facts);
        if (facts.Collection)
        {
            return tracedIsPartner
                ? $"Paid {organiser.Name} {amount} for their share of {court}{why}"
                : $"{partner.Name} paid them {amount} for their share of {court}{why}";
        }
        return tracedIsPartner
            ? $"{amount} of their share of {court} came back from {organiser.Name}{why}"
            : $"{amount} went back to {partner.Name} for their share of {court}{why}";
    }

    /// <summary>R15: the other half of a share on this night — somebody else's money, both sides named.</summary>
    private static string TwinShareMoved(string whose, TraceFacts facts)
    {
        var court = ShareCourt(facts);
        var why = ShareClause(facts, ShareSide.Named(facts.PartnerName), ShareSide.Named(facts.OrganiserSideName));
        var amount = Amount(facts);
        var partnersRow = facts.Collection == (facts.AmountMinutes < 0);
        if (facts.Collection)
        {
            return partnersRow
                ? $"{whose} paid {amount} for their share of {court}{why}"
                : $"{whose} received {amount} for the share of {court}{why}";
        }
        return partnersRow
            ? $"{whose} got {amount} of their share of {court} back{why}"
            : $"{amount} went back from {whose} for the share of {court}{why}";
    }

    private static string ShareCourt(TraceFacts facts) =>
        string.IsNullOrWhiteSpace(facts.CourtName) ? "the game" : facts.CourtName.Trim();

    /// <summary>One side of a share in a sentence: a name, or the person whose night it is.</summary>
    private sealed record ShareSide(string Name, string Object, string Possessive)
    {
        public static readonly ShareSide Them = new("they", "them", "their");

        public static ShareSide Named(string? name)
        {
            var n = string.IsNullOrWhiteSpace(name) ? "another member" : name.Trim();
            return new ShareSide(n, n, $"{n}'s");
        }
    }

    /// <summary>
    /// R15: why a share moved, after a dash — off the record's cause (<see cref="WalletShareCauses"/>),
    /// empty for a plain payment or a return no record explains.
    /// </summary>
    private static string ShareClause(TraceFacts facts, ShareSide partner, ShareSide organiser)
    {
        var joined = string.IsNullOrWhiteSpace(facts.JoinedName) ? "another player" : facts.JoinedName.Trim();
        var clause = facts.ShareCause switch
        {
            WalletShareCauses.PlayerAdded => $"{joined} joined, so {partner.Possessive} share went down",
            WalletShareCauses.OrganiserRemoved => $"{organiser.Name} took {partner.Object} off the game",
            WalletShareCauses.ClubRemoved => $"the club took {partner.Object} off the game",
            WalletShareCauses.ShareReturned => $"{partner.Name} withdrew from the game",
            WalletShareCauses.SplitChanged => $"{organiser.Name} lowered {partner.Possessive} share",
            WalletShareCauses.ClubSettled => $"the club recorded {partner.Possessive} share as paid by hand",
            WalletShareCauses.BookingCancelled => "the game was cancelled",
            WalletShareCauses.NoShow => "nobody checked in, so the club settled it as a no-show",
            WalletShareCauses.OutageRefund => "the court's box was offline, so the club refunded the session",
            WalletShareCauses.Displaced => "the court was in use by an earlier booking, so the club refunded the session",
            WalletShareCauses.ClubCollected => "the club collected it",
            WalletShareCauses.Attended => "the session was attended after all",
            _ => null,
        };
        return clause is null ? "" : $" — {clause}";
    }

    /// <summary>The actor's name, or <paramref name="nobody"/> when the row cannot name them.</summary>
    private static string ActorOr(TraceFacts facts, string nobody)
    {
        return string.IsNullOrWhiteSpace(facts.ActorName) ? nobody : facts.ActorName.Trim();
    }

    /// <summary>
    /// E12-1: why the server did not accept a court box's uploaded check-in, in the club's words —
    /// empty when the row carries no verdict (an online refusal says its own reason elsewhere).
    /// Block body for the lizard reason in <c>memory/gotchas.md</c>.
    /// </summary>
    private static string VerdictWords(string? verdict)
    {
        return verdict switch
        {
            null or "" => "",
            "forgery_suspected" => " — the code could not be verified",
            "unresolved" => " — no booking of theirs on that court then",
            "unverifiable" => " — the box's clock was wrong, so the code could not be checked",
            "wrong_court" => " — the box lit a court their booking was not on",
            _ => " — the club did not accept the box's check-in",
        };
    }

    /// <summary>R11 E11-4: a refusal of a used code, worded by what the member was trying to do.</summary>
    private static string TurnedAway(TraceFacts facts, string court)
    {
        var doing = facts.Attempt switch
        {
            "walkup" => " buying light time",
            "extend" => " extending play",
            "pay_for" => " paying for somebody's booking",
            _ => "",
        };
        return $"Was turned away{doing} at {court}{UsedCode(facts)}";
    }

    /// <summary>The reason a refusal of an already-used code is given, in words (E9-6); empty otherwise.</summary>
    private static string UsedCode(TraceFacts facts) => facts.CodeUsed ? " — code already used" : "";

    /// <summary>
    /// A movement of SOMEBODY ELSE's minutes that the person whose night this is performed — an
    /// admin's adjustment, a payer whose box payment refunded the booker (review round 6, E6-1).
    /// Every sentence names whose money it was; none of them reads as the traced member's own.
    /// Block body for the lizard reason in <c>memory/gotchas.md</c>.
    /// </summary>
    private static string OthersMoneyHeadline(string kind, TraceFacts facts)
    {
        var whose = Subject(facts);
        return kind switch
        {
            WalletToppedUp => $"{whose} bought {Amount(facts)}",
            WalletToppedUpAtTheDesk => facts.NoCharge
                ? $"{Who(facts)} gave {whose} {Amount(facts)} at no charge"
                : $"{Who(facts)} sold {whose} {Amount(facts)} at the desk",
            WalletSpent => string.IsNullOrWhiteSpace(facts.CourtName)
                ? $"{whose} paid {Amount(facts)}"
                : $"{whose} paid {Amount(facts)} for {facts.CourtName.Trim()}",
            WalletRefunded => facts.AmountMinutes < 0
                ? $"A refund of {Amount(facts)} to {whose} was taken back"
                : $"{whose} got {Amount(facts)} back",
            WalletPenalised => facts.AmountMinutes > 0
                ? $"A penalty of {Amount(facts)} was returned to {whose}"
                : $"{whose} was charged a penalty of {Amount(facts)}",
            WalletAdjustedByAdmin => $"{Who(facts)} changed {whose}'s minutes by {Amount(facts)}",
            WalletReversed => $"A payment of {whose}'s for {Amount(facts)} was reversed",
            _ => OthersShareMoved(whose, facts),
        };
    }

    /// <summary>
    /// Somebody else's half of a share movement (E7-3) — and, when it went back because the partner
    /// withdrew (R13 E13-4), said as that: the partner got it back, or the organiser returned it.
    /// </summary>
    private static string OthersShareMoved(string whose, TraceFacts facts)
    {
        if (facts.ShareCause is not null) return TwinShareMoved(whose, facts);
        if (string.IsNullOrWhiteSpace(facts.WithdrewName)) return $"A share of a split booking moved for {whose}: {Amount(facts)}";
        return facts.AmountMinutes > 0
            ? $"{whose} got {Amount(facts)} of their share back — they withdrew from the game"
            : $"{whose} returned {Amount(facts)} to them — they withdrew from the game";
    }

    /// <summary>
    /// What a door is called on a night (review round 7, E7-4) — the console's
    /// <c>doorDisplayName</c> rule, said once on the server: the club's name for it, unless that is
    /// still <see cref="DeviceRegistryService.GatePlaceholderName"/>; then "Unnamed scanner" with the
    /// board's code. Null when the row knows neither, and the sentence says "a door".
    /// </summary>
    public static string? DoorLabel(string? name, string? deviceCode)
    {
        var trimmed = name?.Trim();
        if (!string.IsNullOrEmpty(trimmed) && trimmed != DeviceRegistryService.GatePlaceholderName) return trimmed;
        var code = deviceCode?.Trim();
        if (!string.IsNullOrEmpty(code)) return $"{UnnamedScanner} ({code})";
        return string.IsNullOrEmpty(trimmed) ? null : UnnamedScanner;
    }

    /// <summary>The console's word for a door the club has not named (<c>doorsCopy.doorDisplayName</c>).</summary>
    public const string UnnamedScanner = "Unnamed scanner";

    /// <summary>The person a row is about, named, or a neutral phrase when the row cannot say.</summary>
    private static string Subject(TraceFacts facts)
    {
        return string.IsNullOrWhiteSpace(facts.SubjectName) ? "another member" : facts.SubjectName.Trim();
    }

    /// <summary>The account sentences (F3). Block body for the lizard reason in <c>memory/gotchas.md</c>.</summary>
    private static string AccountHeadline(string kind, TraceFacts facts)
    {
        return kind switch
        {
            AccountApplied => "Applied to join the club",
            AccountApproved => $"{Who(facts)} approved their application",
            AccountRejected => $"{Who(facts)} turned their application down",
            AccountSuspended => $"{Who(facts)} suspended their membership",
            AccountReactivated => $"{Who(facts)} reactivated their membership",
            AccountDeleted => $"{Who(facts)} deleted their account",
            AccountMadeAdmin => $"{Who(facts)} made them an administrator",
            AccountAdminRemoved => $"{Who(facts)} removed their administrator rights",
            AccountCodeReset => "Their member code was changed and their sessions ended",
            AccountPasskeysRemoved => "Their passkeys were removed",
            AccountPasswordChanged => "Changed their password",
            AccountPasswordReset => $"{Who(facts)} gave them a temporary password",
            AccountGroupsChanged => $"{Who(facts)} changed their member groups",
            AccountCodeSetUp => "Set up their member code",
            AccountPinSet => "Set their court PIN",
            AccountPinSetForThem => $"{Who(facts)} set their court PIN",
            AccountPinCleared => "Cleared their court PIN",
            AccountFingerprintEnrolled => $"{Who(facts)} enrolled their fingerprint",
            AccountAdminInherited => "Became an administrator — the club's set-up names their address",
            _ => $"Something this club's records have no word for ({facts.RawAction ?? kind})",
        };
    }

    /// <summary>
    /// The movement as a club reads it — "45 minutes", "1 hour 30 minutes", whole minutes in prose
    /// (contract §7.2) — or a dash when the row carries none.
    /// </summary>
    private static string Amount(TraceFacts facts)
    {
        // Block body for the lizard reason in `memory/gotchas.md`: a `{ }` property pattern in
        // an expression-bodied member costs this file its scope in lizard's C# parser.
        return facts.AmountMinutes is { } amount
            ? MoneyFormat.Minutes(Math.Abs(amount))
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

    /// <summary>R14 E14-7: "Erin Chainadmin cancelled their booking on Court 3" — not "cancelled Court 3 for them".</summary>
    private static string CancelledByClub(string court, TraceFacts facts)
        => BySystem(facts)
            ? $"The club's automatic check cancelled their booking on {court}"
            : $"{Who(facts)} cancelled their booking on {court}";

    /// <summary>
    /// R14 E14-3: whose late check-in reversed it — "Sam Partner's check-in reached the club late —
    /// no-show reversed". A row with no person on it (before R14, the system) keeps the club's words.
    /// </summary>
    private static string NoShowReversed(TraceFacts facts)
    {
        // R16 E16-6: the scanning partner's own row — their check-in, on somebody else's booking.
        if (facts.ForOther && !string.IsNullOrWhiteSpace(facts.SubjectName))
        {
            var settled = facts.CourtWasDark ? "outage refund" : "no-show";
            var court = string.IsNullOrWhiteSpace(facts.CourtName) ? "a court" : facts.CourtName.Trim();
            return $"Their check-in reached the club late — the {settled} on {facts.SubjectName.Trim()}'s game on {court} was reversed";
        }
        var what = facts.CourtWasDark ? "outage refund reversed" : "no-show reversed";
        // R18 E18-8: the member's own scan, on their own Night — their voice, as every own row reads.
        if (facts.BySelf && !BySystem(facts)) return $"Their check-in reached the club late — {what}";
        if (BySystem(facts) || string.IsNullOrWhiteSpace(facts.ActorName))
        {
            return facts.CourtWasDark
                ? "The club took back an outage refund — the check-in arrived late"
                : "The club took a no-show back";
        }
        return $"{facts.ActorName.Trim()}'s check-in reached the club late — {what}";
    }

    /// <summary>"Olive Organiser's " before the court when the game was somebody else's and the record names them; empty otherwise.</summary>
    private static string Whose(TraceFacts facts)
    {
        var organiser = facts.OrganiserName?.Trim();
        if (string.IsNullOrEmpty(organiser) || organiser == facts.ActorName?.Trim()) return "";
        return $"{organiser}'s game on ";
    }

    /// <summary>
    /// The partner's side of a split change — R16 J16-2: one an add caused says who joined, whoever
    /// added them ("Jo Partner joined Olive Organiser's game on Court 1, so their share is now 10 minutes").
    /// </summary>
    private static string SplitChanged(string court, TraceFacts facts)
    {
        if (string.IsNullOrWhiteSpace(facts.JoinedName)) return $"{ActorOr(facts, "The organiser")} changed how {court} is split{ShareNow(facts, "their")}";
        var organiser = facts.OrganiserName?.Trim();
        var game = string.IsNullOrEmpty(organiser) ? court : $"{organiser}'s game on {court}";
        return $"{facts.JoinedName.Trim()} joined {game}{SoShareNow(facts, "their")}";
    }

    /// <summary>The organiser's (or the desk's) own side of a split change — R16 J16-2 likewise.</summary>
    private static string ChangedSplit(string court, TraceFacts facts)
    {
        if (string.IsNullOrWhiteSpace(facts.JoinedName)) return $"Changed how {court} is split{ShareNow(facts, $"{Subject(facts)}'s")}";
        return $"{facts.JoinedName.Trim()} joined {court}{SoShareNow(facts, $"{Subject(facts)}'s")}";
    }

    /// <summary>", so their share is now 10 minutes" when the record carries it; ", so the split went down" otherwise.</summary>
    private static string SoShareNow(TraceFacts facts, string whose)
    {
        return facts.AmountMinutes is null ? ", so the split went down" : $", so {whose} share is now {Amount(facts)}";
    }

    /// <summary>
    /// R16 E16-6: a check-in, in the voice of the night it is on — "Checked in at Court 1" for the
    /// scanner's own; "Pat checked in at Court 1" on the booker's night when somebody else scanned;
    /// the scanner's own row at somebody else's booking names whose it was.
    /// </summary>
    private static string CheckedIn(string court, TraceFacts facts)
    {
        if (facts.PaidAndLit) return PaidAndLit(court, facts);
        if (facts.ByOther && !string.IsNullOrWhiteSpace(facts.ActorName)) return $"{facts.ActorName.Trim()} checked in at {court}";
        if (facts.ForOther && !string.IsNullOrWhiteSpace(facts.SubjectName)) return $"Checked in at {court} for {facts.SubjectName.Trim()}'s booking";
        // R17 J17-4: their own seat's check-in on somebody else's game.
        if (!string.IsNullOrWhiteSpace(facts.SeatOfName)) return $"Checked in at {court} for {facts.SeatOfName.Trim()}'s booking";
        return $"Checked in at {court}";
    }

    /// <summary>
    /// R19 E19-3: a payer at the box who holds no seat — "Pons Partner paid for Court 1 at the court box and
    /// lit it" on the organiser's Night, "Paid for Court 1 at the court box and lit it for Olga Organiser's
    /// booking" on their own.
    /// </summary>
    private static string PaidAndLit(string court, TraceFacts facts)
    {
        const string What = " at the court box and lit it";
        if (facts.ByOther && !string.IsNullOrWhiteSpace(facts.ActorName)) return $"{facts.ActorName.Trim()} paid for {court}{What}";
        if (facts.ForOther && !string.IsNullOrWhiteSpace(facts.SubjectName)) return $"Paid for {court}{What} for {facts.SubjectName.Trim()}'s booking";
        return $"Paid for {court}{What}";
    }

    /// <summary>" — their share is now 8 minutes", when the record carries the new share; empty otherwise.</summary>
    private static string ShareNow(TraceFacts facts, string whose)
    {
        return facts.AmountMinutes is null ? "" : $" — {whose} share is now {Amount(facts)}";
    }

    /// <summary>
    /// R14 E14-2: a partner's game cancelled — by its organiser ("Olive Organiser cancelled their game
    /// on Court 1"), by somebody at the desk, or by the club's system.
    /// </summary>
    private static string GameCancelled(string court, TraceFacts facts)
    {
        var organiser = string.IsNullOrWhiteSpace(facts.OrganiserName) ? "the organiser" : facts.OrganiserName.Trim();
        if (BySystem(facts) || string.IsNullOrWhiteSpace(facts.ActorName)) return $"The club cancelled {organiser}'s game on {court}";
        if (facts.ActorName.Trim() == organiser) return $"{organiser} cancelled their game on {court}";
        return $"{facts.ActorName.Trim()} cancelled {organiser}'s game on {court} for the club";
    }

    /// <summary>
    /// Money back — or, on a NEGATIVE refund row, a refund taken back: the late-evidence reversal
    /// of a no-show posts the refund's opposite under the same type, and "Got 45 minutes back"
    /// beside −45 said the opposite of what happened (review round 6, E6-11).
    /// </summary>
    private static string Refunded(TraceFacts facts)
    {
        if (facts.AmountMinutes < 0)
        {
            return BySystem(facts)
                ? $"The club's automatic check took back a refund of {Amount(facts)}"
                : $"A refund of {Amount(facts)} was taken back";
        }
        return BySystem(facts)
            ? $"The club's automatic check returned {Amount(facts)}"
            : $"Got {Amount(facts)} back";
    }

    /// <summary>A penalty — or, on a POSITIVE penalty row, a penalty given back (E6-11, as above).</summary>
    private static string Penalised(TraceFacts facts)
    {
        if (facts.AmountMinutes > 0)
        {
            return BySystem(facts)
                ? $"The club's automatic check returned a penalty of {Amount(facts)}"
                : $"A penalty of {Amount(facts)} was returned";
        }
        return BySystem(facts)
            ? $"The club's automatic check charged a penalty of {Amount(facts)}"
            : $"Was charged a penalty of {Amount(facts)}";
    }

    private static string AdjustedByAdmin(TraceFacts facts)
        => $"{Who(facts)} changed their minutes by {Amount(facts)}";

    /// <summary>
    /// A package the club sold by hand. It names the actor for the reason
    /// <see cref="AdjustedByAdmin"/> does: the member was not the one who did it, and a night
    /// that says "Bought 5 hours" about a payment somebody else keyed in is a sentence the member
    /// cannot check. A top-up the club took no rand for was GIVEN, and says so (review round 8,
    /// E8-5: a free package read "sold them 1 hour").
    /// </summary>
    private static string ToppedUpAtTheDesk(TraceFacts facts)
        => facts.NoCharge
            ? $"{Who(facts)} gave them {Amount(facts)} at no charge"
            : $"{Who(facts)} sold them {Amount(facts)} at the desk";

    /// <summary>
    /// What they paid for, named when the row knows it. D2 §6.2's own example sentence is
    /// "Paid 36 minutes for Court 2", and the court is what makes it answer a question — but
    /// a ledger row carries no court of its own, so the sentence degrades rather than inventing
    /// one. Block body for the lizard reason in <c>memory/gotchas.md</c>.
    /// </summary>
    private static string Spent(TraceFacts facts)
    {
        var paid = $"Paid {Amount(facts)}";
        return string.IsNullOrWhiteSpace(facts.CourtName) ? paid : $"{paid} for {facts.CourtName.Trim()}";
    }
}

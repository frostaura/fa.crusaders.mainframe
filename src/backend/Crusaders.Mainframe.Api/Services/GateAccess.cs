using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Whether this code opens this door — the one rule, in one place, for the same reason
/// <see cref="MembershipAccess"/> exists.
///
/// <para>
/// A door is a smaller decision than a court and a wider one. Smaller because nothing here
/// touches money: an open moves no booking, stamps no <c>CheckedInAt</c> and posts no ledger
/// row, and walking through a door is not attendance — the member may be collecting a
/// racquet. Wider because the default policy admits every active member, not only the ones
/// with a court booked, so this is the first surface in the product where an active
/// membership on its own is sufficient for anything.
/// </para>
///
/// <para>
/// <b>Everything the gate endpoint decides is decided here.</b> The endpoint resolves the
/// board, records the contact and serialises the answer; it makes no judgements of its own.
/// That is deliberate and it is the lesson <c>MembershipAccess</c> records: the rule had been
/// written four times and enforced on three of them, and the fourth door was the expensive
/// one. There will be a second gate surface eventually — an admin "open this door" button,
/// or a second policy — and it has to arrive at this method rather than beside it.
/// </para>
/// </summary>
public static class GateAccess
{
    /// <summary>The door opened. The only reason that comes with <c>opened: true</c>.</summary>
    public const string Ok = "ok";

    /// <summary>
    /// Unknown, expired, or another club's code. One reason for all three on purpose: telling
    /// them apart at a door turns it into an oracle for which codes are real, and there is
    /// nobody standing at a door to be told anything more useful.
    /// </summary>
    public const string NotRecognised = "not_recognised";

    /// <summary>
    /// The club has suspended, rejected or not yet approved this member. Named rather than
    /// folded into <see cref="NotRecognised"/> because the desk needs the distinction from the
    /// audit row afterwards — "the scanner is broken" and "your membership is suspended" are
    /// two different conversations, and the gate itself says neither out loud.
    /// </summary>
    public const string MemberNotActive = "member_not_active";

    /// <summary>
    /// The club has <b>no record of this person at all</b> — ruling 15.
    ///
    /// <para>
    /// Distinct from <see cref="MemberNotActive"/> because the desk's next action is different:
    /// there is nothing to un-suspend and no application to approve, the person needs enrolling.
    /// Before this, such a user was not barred at all — <c>MembershipAccess</c> tested "the club
    /// recorded a decision and it was not approval", recorded none, and under the default
    /// <c>active_member</c> policy the door released for somebody the club had never admitted.
    /// </para>
    /// </summary>
    public const string NoMembership = "no_membership";

    /// <summary>
    /// Policy <see cref="GateAccessPolicies.BookingWindow"/> only: an active member with
    /// nothing booked inside <c>[StartsAt − gate_early_entry_minutes, EndsAt]</c>, and not a
    /// club admin. Unreachable under the default policy.
    /// </summary>
    public const string NoBooking = "no_booking";

    /// <summary>
    /// A <see cref="AccessCodePurpose.BookingActivation"/> code presented before its own
    /// booking's entry window opens — <see cref="BookingCodeWindow.DoorHorizonMinutes"/>
    /// before <c>StartsAt</c>.
    ///
    /// <para>
    /// Named rather than folded into <see cref="NotRecognised"/>, which is the opposite of the
    /// reasoning behind every other refusal here, and deliberately so. The oracle argument
    /// applies to codes whose validity is the secret; this one tells the holder of a code the
    /// club itself minted for them that they are EARLY — a fact they already know, about a
    /// booking that is already theirs, which the door will honour later the same day. Telling
    /// them "not recognised" instead sends a member with a valid booking to a desk that may
    /// not be staffed.
    /// </para>
    ///
    /// <para>
    /// A <see cref="AccessCodePurpose.MemberIdent"/> code never answers this: it names no
    /// booking, and it expires in sixty seconds.
    /// </para>
    /// </summary>
    public const string TooEarly = "too_early";

    /// <summary>
    /// Anything but <c>qr</c> or <c>code</c>. A PIN against the whole membership roll is an
    /// oracle rather than an identification, and unlike a court there is no candidate set
    /// here to check one against — see <see cref="IdentificationResolver"/>.
    /// </summary>
    public const string MethodNotSupported = "method_not_supported";

    /// <summary>
    /// The MAC resolved to a <see cref="DeviceKind.CourtBox"/> row. Answered rather than
    /// 404'd so a board flashed with the wrong image shows a refusal and stops, instead of
    /// retrying an endpoint that will never answer it differently.
    /// </summary>
    public const string NotAGate = "not_a_gate";

    /// <summary>
    /// The mirror refusal, for a <see cref="DeviceKind.Gate"/> row arriving at a court-box
    /// route — <c>/activate</c>, <c>/walkup</c>, or an <c>activation</c>/<c>release</c> event
    /// on <c>/events</c>.
    ///
    /// <para>
    /// <b>It is explicit rather than incidental, and that is the whole point of it.</b> A gate
    /// row carries no court numbers, so every one of those paths already refused it by
    /// accident: the activation path fails its relay-index check against an empty list, and
    /// the walk-up fails <c>court_not_on_device</c>. Both answers are wrong sentences — the
    /// court was not the problem — and, worse, both stop being refusals the moment anybody
    /// puts a court number on a gate row. The rule that matters is "a door never sells court
    /// time and never checks anyone in", and a rule enforced by the emptiness of an unrelated
    /// list is not enforced.
    /// </para>
    /// </summary>
    public const string NotACourtBox = "not_a_court_box";

    /// <summary>
    /// A v1 member code the server already opened a door for inside its step (member-code §4.4).
    /// A decision, not an outage. Kept OUT of <see cref="Reasons"/>: that list is pinned both ways
    /// against the door corpus, which has no <c>gate-scan-response-code-used</c> vector yet — the
    /// door firmware reads any reason off a 200 as a refusal, so it needs no new screen.
    /// </summary>
    public const string CodeUsed = MemberCodeIdentity.CodeUsed;

    /// <summary>
    /// Every reason this decision can answer. Pinned against the corpus, in both directions,
    /// by <c>DeviceGateProtocolCorpusTests</c>: a reason with no vector is a refusal the
    /// firmware has no screen for, and a vector with no reason is a screen for a refusal that
    /// never comes.
    /// </summary>
    public static readonly string[] Reasons =
        [Ok, NotRecognised, MemberNotActive, NoMembership, NoBooking, TooEarly, MethodNotSupported, NotAGate];

    /// <summary>Shortest release the lock is ever given. A zero-second release is a door that clicks and stays shut.</summary>
    public const int MinUnlockSeconds = 1;

    /// <summary>
    /// Longest release. The same number bounds <c>gate_unlock_seconds</c> on the settings PUT
    /// and clamps it again on the way out, because the PUT is not the only way a value reaches
    /// that column — a hand-edited settings document is, and a door held open for an hour by a
    /// typo is the failure this is here to make impossible rather than unlikely.
    /// </summary>
    public const int MaxUnlockSeconds = 30;

    /// <summary>How early a member may be let in for a booking, at the most. Four hours.</summary>
    public const int MaxEarlyEntryMinutes = 240;

    /// <summary>The release the lock is given, in seconds: the club's setting, clamped.</summary>
    public static int UnlockSecondsFor(TenantSettingsView settings)
        => Math.Clamp(settings.GateUnlockSeconds, MinUnlockSeconds, MaxUnlockSeconds);

    /// <summary>
    /// The decision for one scan at one door.
    ///
    /// <para>
    /// The order is not arbitrary. The method is checked before the token is resolved, so an
    /// unsupported method never reaches the code table at all; the membership is checked
    /// before the policy, so a suspended member is told the same thing whichever policy the
    /// club runs; and the board's kind is checked by the caller before any of it, because a
    /// court box asking this question is a misconfiguration rather than a refusal.
    /// </para>
    /// </summary>
    public static async Task<GateDecision> DecideAsync(
        MainframeDbContext db, AccessCodeService codes, GateContext context, CancellationToken ct)
    {
        if (!IdentificationResolver.CanIdentifyGlobally(context.Method))
        {
            return Refused(MethodNotSupported);
        }

        // Tenant-filtered by the context's global query filter, so a code minted at another
        // club resolves to nothing here — the isolation is structural, not a claim compared.
        // A caller that has already resolved the token — the member-code path, which CHECKS a v1
        // code rather than looking it up — hands the answer in; everything below is identical.
        var resolved = context.Resolved ?? await codes.ResolveAsync(context.Token, context.Now, ct);
        if (resolved is null) return Refused(NotRecognised);

        // Not-Active rather than Suspended, and — ruling 15 — a user with NO membership row is
        // barred too, under its own reason. Both rules live in MembershipAccess. This runs before
        // the policy, so a member the club will not admit is told the same thing whichever policy
        // the club runs.
        if (await MembershipAccess.RefusalReasonAsync(db, resolved.UserId, ct) is { } refusal)
        {
            return Refused(
                refusal == MembershipAccess.NoMembership ? NoMembership : MemberNotActive,
                resolved.UserId);
        }

        // A booking code is bounded by its OWN booking, under every policy — see
        // BookingCodeScopeAsync. Before the policy, because it is a property of the credential
        // rather than of the club's rule: a code outside its window opens nothing whichever
        // policy is running, and a club on active_member has no policy check at all.
        if (resolved.Purpose == AccessCodePurpose.BookingActivation
            && await BookingCodeScopeAsync(db, context, resolved, ct) is { } outside)
        {
            return Refused(outside, resolved.UserId);
        }

        if (context.Settings.GateAccessPolicy == GateAccessPolicies.BookingWindow
            && !await MayEnterOnABookingAsync(db, context, resolved, ct))
        {
            return Refused(NoBooking, resolved.UserId);
        }

        return new GateDecision(true, Ok, resolved.UserId, UnlockSecondsFor(context.Settings));
    }

    /// <summary>
    /// Why this booking code opens nothing right now, or null when it does.
    ///
    /// <para>
    /// <b>A booking code is not a standing building key.</b> It is minted with the booking and
    /// lives until the slot ends plus the grace window, and it is a stable token for the whole
    /// of that — which is what a court box deciding offline needs and what makes it dangerous
    /// at a door. Unbounded, the code a member's phone showed them at 17:00 for a 19:00 court
    /// opened every door in the club at 03:00 the same night, and a roster captured off the
    /// LAN bought a building key rather than an entry to one booking.
    /// </para>
    ///
    /// <para>
    /// The bound is the booking's own window: <c>[StartsAt − H, EndsAt]</c>, with <c>H</c>
    /// from <see cref="BookingCodeWindow.DoorHorizonMinutes"/> — the club's entry window under
    /// <c>booking_window</c>, and under <c>active_member</c> the horizon in which the member's
    /// own phone would have shown them that code at all. The two horizons come from one place
    /// so the screen and the door cannot drift.
    /// </para>
    ///
    /// <para>
    /// <b>The two refusals are deliberately asymmetric</b>, and both are
    /// <see cref="OutsideItsOwnWindowAsync"/>'s — what this method adds is the chance to
    /// discard either one. Early is <see cref="TooEarly"/>: the member holds a real booking
    /// and the door will honour it later, and telling them "not recognised" sends somebody
    /// with a valid booking to a desk that may not be staffed. Late, and a booking the club
    /// has cancelled or blocked, is <see cref="NotRecognised"/>, indistinguishable from a code
    /// that never existed, because the row outlives the slot by the grace window and a door
    /// that told "spent" from "unknown" would be the oracle every other refusal here avoids.
    /// </para>
    ///
    /// <para>
    /// The status check is on the BOOKING and not on the code, because nothing revokes a code
    /// when its booking is cancelled — revoking on cancel would strand a court box deciding
    /// offline from a roster it fetched beforehand, which is the one thing the roster is for.
    /// </para>
    /// </summary>
    private static async Task<string?> BookingCodeScopeAsync(
        MainframeDbContext db, GateContext context, ResolvedAccessCode resolved, CancellationToken ct)
    {
        var outside = await OutsideItsOwnWindowAsync(db, context, resolved, ct);
        if (outside is null) return null;

        // The credential is out of scope; the MEMBER may not be. See the summary above.
        return await HoldsALiveBookingAsync(
            db, context, resolved.UserId, BookingCodeWindow.DoorHorizonMinutes(context.Settings), ct)
            ? null
            : outside;
    }

    /// <summary>
    /// Why this code's OWN booking does not admit it right now, or null when it does — the
    /// question about the CREDENTIAL.
    ///
    /// <para>
    /// <b>There is no upper-edge test here, and its absence is the rule rather than an
    /// omission.</b> The window's top is <b>the code's own liveness</b>:
    /// <c>AccessCodeService.ResolveAsync</c> is the only way this decision reaches a
    /// <see cref="ResolvedAccessCode"/> at all and it refuses anything that is not
    /// <c>IsLiveAt(now)</c>, so a code that is here is a code that is live. Testing
    /// <c>booking.EndsAt</c> as well was a SECOND upper edge, lower than the first and wrong
    /// in two directions at once: the no-show sweep truncates <c>EndsAt</c> to its own clock
    /// five minutes into a slot, and a member whose court simply ran to its end was refused
    /// for the grace window during which the product was still showing them that code.
    /// </para>
    ///
    /// <para>
    /// <b>The STATUS test below is a second upper edge of its own, and that is why it is
    /// narrow.</b> It refuses every status but <c>Booked</c>, which for the two the WORKERS
    /// write — <see cref="BookingStatus.NoShow"/> within grace of a slot's start,
    /// <see cref="BookingStatus.Completed"/> within fifteen seconds of its end — closes the
    /// window long before the code dies. Those two are not refusals: the caller's relief
    /// re-admits the member through <see cref="HoldsALiveBookingAsync"/>, on the same booking,
    /// out to the same instant the code expires. What survives here is the club's own
    /// decision about the booking — <c>Cancelled</c> and <c>AdminBlock</c> — and it survives
    /// the relief too, because that query lists the statuses that count rather than excluding
    /// these. Merging the two tests would be tidier and would put the relief's arithmetic on
    /// the credential path, where a code with no booking row has nothing to measure.
    /// </para>
    ///
    /// <para>
    /// Nothing in this product extends a booking. The two writers of <c>EndsAt</c> after a
    /// mint — the no-show sweep and <c>BookingService</c>'s reversal narrowing — only shorten
    /// it or restore it toward the end it was sold to, so a code's <c>ExpiresAt</c> (minted
    /// from the sold end plus the grace window) is never behind the row. If an extend-booking
    /// feature ever lands, the mint path has to move with it or this edge silently narrows.
    /// </para>
    ///
    /// <para>
    /// Whether the MEMBER may come in anyway is a different question and is deliberately not
    /// asked here. It is asked once, in <see cref="HoldsALiveBookingAsync"/>, by the caller.
    /// Asking it in both places was measurably the same thing twice: a mutant that put this
    /// method back to its pre-G2 behaviour changed no outcome, because the caller's fallback
    /// already covered every case it had gained.
    /// </para>
    /// </summary>
    private static async Task<string?> OutsideItsOwnWindowAsync(
        MainframeDbContext db, GateContext context, ResolvedAccessCode resolved, CancellationToken ct)
    {
        var booking = resolved.BookingId is { } id
            ? await db.Bookings.AsNoTracking().FirstOrDefaultAsync(b => b.Id == id, ct)
            : null;

        if (booking is null || booking.Status != BookingStatus.Booked) return NotRecognised;

        var latestStart = BookingCodeWindow.LatestStart(
            context.Now, BookingCodeWindow.DoorHorizonMinutes(context.Settings));

        return booking.StartsAt <= latestStart ? null : TooEarly;
    }

    /// <summary>
    /// Whether this member holds any booking whose door window contains
    /// <see cref="GateContext.Now"/> — the one query behind both questions a door asks about
    /// bookings, asked with a different horizon each time.
    ///
    /// <para>
    /// <b>The horizon is the caller's because the two questions are different.</b> Step 6 —
    /// the <c>booking_window</c> policy — asks "is this member due on a court?", and the
    /// answer is the club's entry window. Step 5's relief asks "is this member entitled to be
    /// in the building at all?", and the answer there is the door's own horizon, which under
    /// <c>active_member</c> is wider. Sharing the query rather than the number is what keeps
    /// the <c>NoShow</c> rule above from having to be written twice.
    /// </para>
    ///
    /// <para>
    /// <b>A booking the sweep has written off still counts, and a booking the member ATTENDED
    /// counts in exactly the same way.</b> The no-show sweep sets <c>Status = NoShow</c> and
    /// truncates <c>EndsAt</c> to its own clock five minutes after a slot starts, and both of
    /// those read at a door as "this person has no reason to be here": a member six minutes
    /// late was refused <c>not_recognised</c> on their booking QR and <c>no_booking</c> on
    /// their ident QR, <b>outside the building</b> — while the product's own remedy for a
    /// wrong no-show is that member scanning at the court box inside it. A door that enforces
    /// a penalty by making it impossible to undo is the worst possible place for that rule to
    /// live, and a door settles no money in any case.
    /// </para>
    ///
    /// <para>
    /// <b><c>Completed</c> was the same defect with the sign reversed, and it was worse.</b>
    /// <c>LightsCueWorker</c> runs every fifteen seconds and promotes a CHECKED-IN booking to
    /// <see cref="BookingStatus.Completed"/> the moment its <c>EndsAt</c> passes, so within
    /// about fifteen seconds of a slot ending the member who had actually played was refused
    /// here while the member who had not was still being let in. The relief was reaching
    /// precisely the wrong one of the two. It is not a decision about the booking at all: it
    /// is the record that the member was on the court, and being on the court is a better
    /// reason to be in the building than anything else this method can see. A booking's
    /// status now bears on the door only where the CLUB decided something about the booking —
    /// <c>Cancelled</c> and <c>AdminBlock</c>.
    /// </para>
    ///
    /// <para>
    /// <b>The end is the instant that booking's own code dies</b> —
    /// <c>StartsAt + SliceMinutes × SliceCount + grace_window_minutes</c>, which is exactly
    /// what <c>AccessCodeService.StageForBookingAsync</c> mints <c>ExpiresAt</c> as. It is
    /// written as arithmetic rather than read off the code row because a booking is lazily
    /// minted and may not have one yet, and it is measured from the slot as SOLD because the
    /// sweep truncates <c>EndsAt</c> and nothing else. So the door's upper edge is one
    /// sentence — <i>while the member's code for that booking is still live</i> — whether the
    /// code in their hand is that booking's or another's, and whether they played, were late,
    /// or never came.
    /// </para>
    ///
    /// <para>
    /// The grace window is the CURRENT setting rather than the one in force when the code was
    /// minted, so a club that shortens it narrows this edge for codes already in members'
    /// hands. The code's own row is exact (<c>ResolveAsync</c> checks it); this arithmetic is
    /// the club's present rule applied to a booking whose code nobody has asked for yet, and
    /// the two agree except across a settings change.
    /// </para>
    ///
    /// <para>
    /// <c>StartsAt − horizon ≤ now</c> is rearranged to <c>StartsAt ≤ now + horizon</c> for
    /// the provider. There is no admin carve-out here: this is the query, and the carve-out
    /// belongs to the policy step that uses it.
    /// </para>
    ///
    /// <para>
    /// <b>The booking is matched on its member and on nothing else.</b> It used to also match
    /// <c>b.Id == resolved.BookingId</c>, justified by a booking an admin made on a member's
    /// behalf carrying a different <c>UserId</c> from the code's — a state no mint path
    /// produces. <c>AccessCodeService.StageForBookingAsync</c> now takes the booking's own
    /// user and refuses a booking without one, so the code's user and the booking's user are
    /// the same person by construction, and the disjunct matched nothing it could reach. It
    /// also silently widened the query past the barred check: the cached roster's membership
    /// filter keys on the BOOKING's user, so a disjunct that could admit a booking belonging
    /// to somebody else would have let the two rules disagree about whom a suspension binds.
    /// </para>
    /// </summary>
    private static async Task<bool> HoldsALiveBookingAsync(
        MainframeDbContext db, GateContext context, Guid userId, int horizonMinutes, CancellationToken ct)
    {
        var latestStart = BookingCodeWindow.LatestStart(context.Now, horizonMinutes);
        var tail = context.Settings.GraceWindowMinutes;

        return await db.Bookings.AnyAsync(
            b => b.UserId == userId
                 && (b.Status == BookingStatus.Booked
                     || b.Status == BookingStatus.NoShow
                     || b.Status == BookingStatus.Completed)
                 && b.StartsAt <= latestStart
                 && b.StartsAt.AddMinutes((b.SliceMinutes * b.SliceCount) + tail) >= context.Now,
            ct);
    }

    /// <summary>
    /// The <see cref="GateAccessPolicies.BookingWindow"/> test: is this member due on a court?
    ///
    /// <para>
    /// Any court of the club, because a door is not on a court — the member walking through
    /// the front door has not chosen one yet. The window opens <c>gate_early_entry_minutes</c>
    /// before the slot and closes at its end; the same window the roster is built from, so a
    /// member admitted online and a member admitted from the gate's cache are admitted on one
    /// rule rather than two that drift.
    /// </para>
    ///
    /// <para>
    /// <b>Club admins always pass.</b> A club that switches to <c>booking_window</c> must not
    /// thereby lock its own staff out of the building, and staff do not hold bookings for the
    /// hours they are working.
    /// </para>
    ///
    /// <para>
    /// The window's top is the same one step 5 uses — the instant that booking's own code
    /// dies, i.e. the sold end plus the grace window — rather than the slot's bare end. One
    /// upper edge for the whole door, so "while your code for that booking is still live" is
    /// literally true whichever policy the club runs and whichever credential is presented.
    /// It also matches the sweep: the grace window is precisely how long the product waits
    /// before deciding somebody did not come, and refusing them at the door inside it is the
    /// product contradicting itself.
    /// </para>
    ///
    /// <para>
    /// <b>It is keyed on <see cref="User.IsAdmin"/>, and it used to be keyed on the ABSENCE of
    /// a membership row.</b> That was a state no production path creates: registration writes
    /// a membership, an admin promoted off the member roll keeps theirs, and there is no
    /// screen or service that makes a user without one. So the carve-out fired for nobody —
    /// the club's own admins were refused the day it changed policy — and the test that said
    /// otherwise passed only because it deleted the row first, which is a fixture the product
    /// cannot produce. The narrower reading it was protecting ("an admin who is also a member
    /// is a member") turned out to protect nothing, because there is no other kind of admin.
    /// </para>
    ///
    /// <para>
    /// This is the BOOKING check only. An admin is held to <see cref="MembershipAccess"/>
    /// exactly as everybody is, one step earlier in <see cref="DecideAsync"/>: a club that has
    /// suspended an admin's membership has said something about that person, and a door is not
    /// where it gets quietly undone.
    /// </para>
    /// </summary>
    private static async Task<bool> MayEnterOnABookingAsync(
        MainframeDbContext db, GateContext context, ResolvedAccessCode resolved, CancellationToken ct)
    {
        if (await db.Users.AnyAsync(u => u.Id == resolved.UserId && u.IsAdmin, ct)) return true;

        // The club's entry window, clamped to the range its own PUT declares — see
        // BookingCodeWindow.EntryWindowMinutes.
        return await HoldsALiveBookingAsync(
            db, context, resolved.UserId, BookingCodeWindow.EntryWindowMinutes(context.Settings), ct);
    }

    /// <summary>
    /// A refusal, which is always <c>unlock_seconds: 0</c>. Block body rather than an
    /// expression one: lizard's C# parser mis-scopes an expression-bodied member containing
    /// braces into a <c>*global*</c> pseudo-function the length of the file — see
    /// <c>memory/gotchas.md</c>.
    /// </summary>
    public static GateDecision Refused(string reason, Guid? subjectUserId = null)
    {
        return new GateDecision(false, reason, subjectUserId, 0);
    }
}

/// <summary>
/// What the gate decision is asked about: the board, the club's settings, what was presented
/// and when.
///
/// <para>
/// <paramref name="Now"/> is threaded rather than read inside, so the window arithmetic can be
/// driven at every minute of the day instead of at whatever minute the suite happens to run —
/// the trap <c>memory/gotchas.md</c> records six live tests falling into.
/// </para>
///
/// <para>
/// Top-level and bodyless, like <c>CourtAssignment</c>, for the lizard reason recorded there.
/// </para>
/// </summary>
public sealed record GateContext(
    Device Device, TenantSettingsView Settings, string? Method, string? Token, DateTimeOffset Now,
    ResolvedAccessCode? Resolved = null);

/// <summary>
/// One door decision. <paramref name="SubjectUserId"/> is set as soon as the code resolved,
/// including on the refusals after that point, because the audit row's whole value is naming
/// who was turned away.
/// </summary>
public sealed record GateDecision(bool Opened, string Reason, Guid? SubjectUserId, int UnlockSeconds);

/// <summary>
/// Who may open a door: the <c>gate_access_policy</c> vocabulary.
///
/// <para>
/// A closed string enum rather than a boolean because a third policy is foreseeable — by
/// membership class, or by time of day — and a boolean named <c>gate_requires_booking</c>
/// would have to be deprecated to get there.
/// </para>
/// </summary>
public static class GateAccessPolicies
{
    /// <summary>The settings key. Named once, here, so the reader and the writer cannot disagree about it.</summary>
    public const string Key = "gate_access_policy";

    /// <summary>The default: any member the club has approved, booking or not.</summary>
    public const string ActiveMember = "active_member";

    /// <summary>Only a member with a booking whose entry window is open. See <see cref="GateAccess"/>.</summary>
    public const string BookingWindow = "booking_window";

    /// <summary>Every policy that exists, for validation and for the admin screen.</summary>
    public static readonly string[] All = [ActiveMember, BookingWindow];

    /// <summary>Whether this is one of the two. Strict — the settings PUT refuses anything else.</summary>
    public static bool IsKnown(string? policy) => Array.IndexOf(All, policy) >= 0;

    /// <summary>
    /// The stored policy, or the default when the club has not set one.
    ///
    /// <para>
    /// <b>This is the one setting in the tree that fails CLOSED rather than to its default,
    /// and the asymmetry is deliberate.</b> Everywhere else — the button map, the operating
    /// hours — a settings document somebody has broken falls back to something permissive,
    /// because the alternative is a club whose courts all stop working over a typo and nobody
    /// to ask. A door is the other way round: the two failure modes are "a member is sent to
    /// the desk" and "the building is open to whoever has any live code", and only one of
    /// those is recoverable by a person.
    /// </para>
    ///
    /// <para>
    /// So an ABSENT key is the documented default, <see cref="ActiveMember"/> — that is the
    /// overwhelmingly common case and it is not a failure at all. A key that is PRESENT and is
    /// not one of the two is corruption: the PUT validates strictly, so the only way such a
    /// value exists is a hand-edited column, and the safe reading of a hand-edited door policy
    /// is the narrower one.
    /// </para>
    /// </summary>
    public static string FromSettings(JsonElement root)
    {
        if (!root.TryGetProperty(Key, out var value)) return ActiveMember;

        var policy = value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        return IsKnown(policy) ? policy! : BookingWindow;
    }
}

namespace Crusaders.Mainframe.Api.Email;

/// <summary>
/// Which club is writing, and how a reader reaches a human there.
///
/// <para>
/// <b>Every mail this system sends is sent by a club, not by the platform.</b> Before this
/// record existed the footer of every message read "You received this because you registered
/// for Crusaders Mainframe", four subject lines ended in "— Crusaders Mainframe", and
/// <c>BookingService</c> fell back to the literal <c>"Crusaders Mainframe"</c> when it could
/// not resolve a tenant. "Crusaders Mainframe" is the repository's name for the software. It
/// is not the name of any club, it is not a name the first club's own members would recognise,
/// and on the second club's mail it is a different club's name — which is the multi-tenancy
/// invariant failing on the one surface that leaves the building.
/// </para>
///
/// <para>
/// The contact pair is <c>tenant_settings.club_contact_phone</c> / <c>club_contact_email</c>,
/// the same two values <c>/my-code</c> and the sign-in refusal already show. Both default to
/// empty and <b>an empty one renders nothing at all</b>: a club that has not set a number must
/// not be given an invented one, which is the rule <see cref="Services.TenantSettingsView"/>
/// states about the same two fields and the reason the login screen stays quiet rather than
/// printing "Call the club on null".
/// </para>
/// </summary>
/// <param name="Name">The club's own <c>Tenant.DisplayName</c>. Never a literal.</param>
public sealed record ClubIdentity(string Name, string ContactPhone, string ContactEmail)
{
    /// <summary>True when the club has given a reader at least one way to reach a person.</summary>
    public bool HasContact => !string.IsNullOrWhiteSpace(ContactPhone) || !string.IsNullOrWhiteSpace(ContactEmail);
}

/// <summary>
/// One piece of an email's body.
///
/// <para>
/// <b>The point of the model is that HTML and plain text are rendered from the same blocks.</b>
/// Every message this system sends went out as a single <c>text/html</c> part with no
/// alternative, so a client that shows text — or a screen reader walking a message it could
/// not parse — got markup. The obvious fix, hand-writing a second body per template, is how
/// the two halves drift: the figure is corrected in one and not the other, and the half nobody
/// looks at is the half that then lies about money. Neither body is authored here. Both are
/// derived, so they cannot disagree.
/// </para>
///
/// <para>
/// <b>There is no inline markup and no inline link.</b> Every string on every block is escaped
/// at render, once, by <see cref="EmailChrome"/> — court names, club names, an admin's typed
/// reason and a membership number alike — which is what makes a template physically unable to
/// repeat the injection the old templates left open by escaping some interpolations and not
/// others. Emphasis is therefore structural: a number that matters goes in a
/// <see cref="Facts"/> row, a sentence that matters goes in a <see cref="Callout"/>, and a URL
/// goes in a <see cref="CallToAction"/>, which prints the address as text beside the button.
/// </para>
/// </summary>
public abstract record EmailBlock;

/// <summary>A sentence or two of body copy.</summary>
public sealed record Paragraph(string Text) : EmailBlock;

/// <summary>One labelled figure. The label is a real <c>th</c>, so a screen reader reads the pair.</summary>
public sealed record FactRow(string Label, string Value);

/// <summary>The figures, as a table a reader can scan — what was charged, what is left, the reference.</summary>
public sealed record Facts(IReadOnlyList<FactRow> Rows) : EmailBlock;

/// <summary>What a callout is saying about the news it carries.</summary>
public enum CalloutTone
{
    /// <summary>Neutral context.</summary>
    Info,

    /// <summary>Something went the reader's way.</summary>
    Success,

    /// <summary>A condition, a deadline, or a cost they have not paid yet.</summary>
    Warning,

    /// <summary>Money lost, access lost, or something the club must act on now.</summary>
    Danger,
}

/// <summary>
/// The one sentence of a message that must not be skimmed past — a penalty, a deadline, a
/// balance that has gone negative, the warning not to power-cycle a box that is holding scans.
/// </summary>
/// <remarks>
/// Deliberately scarce. A message with three callouts has none: the whole mechanism is that it
/// is the only thing on the page wearing a colour, so a template that wants two is usually a
/// template whose ordinary paragraphs are in the wrong order.
/// </remarks>
public sealed record Callout(CalloutTone Tone, string Text) : EmailBlock;

/// <summary>
/// The action, as a button and as an address.
/// </summary>
/// <remarks>
/// <para>
/// <paramref name="Label"/> says what the link does — "Verify your email address", never "click
/// here" — because it is what a screen reader announces out of context and what the plain-text
/// part has to stand on. Nothing essential may live in the button: images are blocked by
/// default in most clients, and this one is text on a table cell so it survives that, but the
/// URL is printed underneath in both bodies regardless, for the reader whose client ate the
/// anchor and for the one who is reading the text part.
/// </para>
/// </remarks>
public sealed record CallToAction(string Label, string Url) : EmailBlock;

/// <summary>Small print — the sentence that qualifies what is above it without competing with it.</summary>
public sealed record Footnote(string Text) : EmailBlock;

/// <summary>
/// Everything an email says, before it is a message.
/// </summary>
/// <remarks>
/// <para>
/// A record rather than five parameters on <see cref="EmailChrome.Compose"/>: six is the
/// complexity gate's argument limit, the club, the recipient and the attachment already take
/// three of them, and four of these five are strings that would transpose silently — a subject
/// passed as a heading compiles.
/// </para>
/// </remarks>
/// <param name="Preheader">
/// The line the inbox shows beside the subject, before anything is opened. It is not repeated
/// in the body — a preheader that restates the heading wastes the one piece of text most
/// members actually read, so it carries the next most useful fact instead.
/// </param>
/// <param name="WhyThis">
/// Why this person is holding this message. Required on every template, because a
/// transactional mail nobody asked for and that explains nothing about itself is
/// indistinguishable from a phishing attempt — which, on a mail carrying a sign-in link, is the
/// failure that matters. There is no unsubscribe: a club cannot stop telling a member that
/// their money moved, and offering a link that pretends otherwise would be a lie.
/// </param>
public sealed record EmailContent(
    string Subject,
    string Preheader,
    string Heading,
    IReadOnlyList<EmailBlock> Blocks,
    string WhyThis);

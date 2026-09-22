using System.Globalization;
using System.Net;
using System.Text;

namespace Crusaders.Mainframe.Api.Email;

/// <summary>
/// The club's own stationery — one layout, rendered twice, for every message the product sends.
///
/// <para>
/// <b>Email HTML is not web HTML, and the previous templates were web HTML.</b> Each was a bare
/// <c>&lt;div&gt;</c> with a <c>max-width</c> and a <c>font-family</c> — no document, no
/// <c>&lt;head&gt;</c>, no charset, no table, and no width Outlook can see, because Word's
/// rendering engine ignores <c>max-width</c> on a <c>div</c> and lays the content out at the
/// full width of the reading pane. Everything here is instead a nested
/// <c>&lt;table role="presentation"&gt;</c> with inline styles, which is the only construction
/// every client in the room agrees on.
/// </para>
///
/// <para>
/// <b>Nothing essential lives in an image, because there is no image.</b> Most clients block
/// them by default, and a masthead that has to load is a masthead a member does not see. The
/// club's mark in the product is already text — the wordmark on a solid
/// <see cref="BrandStrong"/> band in <c>AuthShell</c> — so the email reproduces exactly that,
/// in type, over the club's second colour as a rule beneath it. It renders identically with
/// images off, which is the only state that matters.
/// </para>
///
/// <para>
/// <b>Dark mode is defended against rather than supported.</b> The product has one light
/// palette and asserts in two posture tests that it has no dark one, so there is nothing to
/// mirror here. What a client does instead is invert, so every cell that carries text paints
/// its own background — as a <c>bgcolor</c> attribute <i>and</i> an inline
/// <c>background-color</c>, because the clients that honour one ignore the other — and the
/// <c>color-scheme</c> pair in the head asks the ones that ask to leave it alone. Dark text on
/// an assumed-white page is the failure this avoids: it is invisible, and the member cannot
/// tell the difference between a message they cannot read and one that did not arrive.
/// </para>
/// </summary>
public static partial class EmailChrome
{
    // ---- The club's palette, from src/frontend/src/lib/tokens.ts ----
    //
    // Literals, not references: an email is rendered once and read months later in a client
    // that has never heard of a CSS custom property, so every colour resolves here or nowhere.
    // The values are the frontend's own and are named after its tokens so the two can be
    // diffed by eye. They are NOT the values docs/specs/design-system.md's colour table
    // prints — that table still carries the retired sky-blue accent and a #94A3B8 muted that
    // measured 2.56:1; tokens.ts is the source and tokens.test.ts pins it.

    /// <summary>The crest royal blue — the masthead band, and the one button colour.</summary>
    internal const string BrandStrong = "#00498D";

    /// <summary>The tin. The club's second colour, and the rule under the wordmark.</summary>
    internal const string BrandTin = "#CF2E30";

    /// <summary>The page behind the card.</summary>
    internal const string PageBg = "#F1F5F9";

    /// <summary>The card itself.</summary>
    internal const string SurfaceBg = "#FFFFFF";

    /// <summary>Table-row banding and the footer's ground.</summary>
    internal const string MutedBg = "#F8FAFC";

    /// <summary>Hairlines.</summary>
    internal const string Border = "#E2E8F0";

    /// <summary>Body and heading text.</summary>
    internal const string TextPrimary = "#0F172A";

    /// <summary>Labels and qualifying sentences.</summary>
    internal const string TextSecondary = "#475569";

    /// <summary>Small print. 4.6:1 on white — the token that replaced a #94A3B8 measuring 2.56:1.</summary>
    internal const string TextMuted = "#5B6879";

    /// <summary>
    /// The stack, in the order a client will find something it has.
    /// </summary>
    /// <remarks>
    /// <b>No webfont is linked.</b> The product self-hosts Figtree through
    /// <c>@fontsource</c> specifically to avoid the Google Fonts CDN, and a mail client is a
    /// worse place to depend on one than a browser is — Outlook ignores <c>@font-face</c>
    /// outright and falls back to Times New Roman if the stack has no serif-free member it
    /// recognises. Figtree is named first so a reader who has it sees the club's own type, and
    /// everything after it is a font their machine already has.
    /// </remarks>
    internal const string FontStack = "Figtree,'Segoe UI',Roboto,'Helvetica Neue',Helvetica,Arial,sans-serif";

    private const int BodyWidth = 600;

    /// <summary>
    /// The head's style block — mobile only, and never load-bearing.
    /// </summary>
    /// <remarks>
    /// Gmail's web client keeps it; several others strip <c>&lt;head&gt;</c> wholesale. Every
    /// rule here therefore only <i>improves</i> a layout that is already correct from the
    /// inline styles: the card is full-width below 620px, the gutters narrow, the heading
    /// steps down, and the button goes full-bleed so it is a thumb-sized target rather than a
    /// word. A client that drops all of it renders the 600px desktop layout on a phone, which
    /// is legible — the body copy is 16px — rather than broken.
    /// </remarks>
    private const string HeadStyle = """
        <style type="text/css">
          body { margin:0 !important; padding:0 !important; width:100% !important; }
          table { border-collapse:collapse; }
          img { border:0; outline:none; text-decoration:none; }
          a { color:#00498D; }
          @media only screen and (max-width:620px) {
            .fx-wrap { width:100% !important; max-width:100% !important; }
            .fx-gutter { padding-left:20px !important; padding-right:20px !important; }
            .fx-h1 { font-size:24px !important; line-height:31px !important; }
            .fx-btn, .fx-btn a { display:block !important; width:auto !important; text-align:center !important; }
          }
        </style>
        """;

    /// <summary>
    /// A club's message, as a message — both bodies, from one set of blocks.
    /// </summary>
    /// <param name="club">Whose stationery this is. Its name reaches the masthead, the footer and nowhere else it could be missed.</param>
    /// <param name="to">The recipient.</param>
    /// <param name="content">What the message says.</param>
    /// <param name="attachment">A receipt, where the template carries one.</param>
    /// <param name="highPriority">A real <c>X-Priority</c> header, for the two device alerts.</param>
    public static EmailMessage Compose(
        ClubIdentity club,
        string to,
        EmailContent content,
        EmailAttachment? attachment = null,
        bool highPriority = false) => new(
            To: to,
            Subject: content.Subject,
            HtmlBody: Html(club, content),
            PlainBody: Text(club, content),
            Attachments: attachment is null ? null : [attachment],
            HighPriority: highPriority,
            FromName: club.Name);

    // ---- HTML ----

    private static string Html(ClubIdentity club, EmailContent content)
    {
        var sb = new StringBuilder(4096);
        sb.Append(HtmlHead(content.Subject));
        sb.Append(Preheader(content.Preheader));
        sb.Append(PageOpen());
        sb.Append(Masthead(club));
        sb.Append(CardOpen());
        sb.Append(HtmlHeading(content.Heading));
        foreach (var block in content.Blocks) sb.Append(HtmlBlock(block));
        sb.Append(CardClose());
        sb.Append(Footer(club, content.WhyThis));
        sb.Append(PageClose());
        return sb.ToString();
    }
}

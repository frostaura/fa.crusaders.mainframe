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
public static class EmailChrome
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
            HighPriority: highPriority);

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

    private static string HtmlHead(string subject) =>
        $"""
        <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
        <html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">
        <head>
        <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="x-apple-disable-message-reformatting" />
        <meta name="format-detection" content="telephone=no,date=no,address=no,email=no" />
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
        <title>{E(subject)}</title>
        <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
        {HeadStyle}
        </head>
        <body style="margin:0;padding:0;width:100%;background-color:{PageBg};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
        """;

    /// <summary>
    /// The line the inbox lists beside the subject.
    /// </summary>
    /// <remarks>
    /// Hidden six ways because no two clients hide it the same way, and the trailing run of
    /// zero-width non-joiners is the standard defence against the client helpfully filling the
    /// rest of the preview with whatever markup comes next — which, without it, is the
    /// masthead's own wordmark repeated into the preview of every message the club sends.
    /// </remarks>
    private static string Preheader(string text) =>
        $"""
        <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">{E(text)}</div>
        <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;</div>
        """;

    private static string PageOpen() =>
        $"""
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="{PageBg}" style="background-color:{PageBg};width:100%;">
        <tr><td align="center" style="padding:24px 10px;background-color:{PageBg};">
        <!--[if mso]><table role="presentation" width="{BodyWidth}" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
        <table role="presentation" class="fx-wrap" width="{BodyWidth}" cellpadding="0" cellspacing="0" border="0" style="width:{BodyWidth}px;max-width:{BodyWidth}px;">
        """;

    private static string PageClose() =>
        """
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
        </td></tr></table>
        </body></html>
        """;

    /// <summary>
    /// The club, in type, over its own two colours.
    /// </summary>
    /// <remarks>
    /// This is the whole of the identity and it is deliberately the whole of it: a wordmark in
    /// Figtree 600 on the crest blue, with the tin as a 4px rule beneath. It is the same
    /// lockup <c>AuthShell</c> puts over the sign-in screen, it costs nothing to load, it
    /// cannot be blocked, and it is the club's name rather than the platform's — which is what
    /// makes the second club's mail the second club's.
    /// </remarks>
    private static string Masthead(ClubIdentity club) =>
        $"""
        <tr><td align="center" bgcolor="{BrandStrong}" class="fx-gutter" style="background-color:{BrandStrong};padding:26px 32px 22px 32px;border-radius:12px 12px 0 0;">
          <p style="margin:0;font-family:{FontStack};font-size:19px;line-height:25px;font-weight:600;letter-spacing:-0.2px;color:#FFFFFF;">{E(club.Name)}</p>
        </td></tr>
        <tr><td bgcolor="{BrandTin}" style="background-color:{BrandTin};font-size:0;line-height:0;height:4px;">&nbsp;</td></tr>
        """;

    private static string CardOpen() =>
        $"""
        <tr><td bgcolor="{SurfaceBg}" class="fx-gutter" style="background-color:{SurfaceBg};padding:32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        """;

    private static string CardClose() =>
        """
        </table>
        </td></tr>
        """;

    private static string HtmlHeading(string heading) =>
        $"""
        <tr><td style="padding:0 0 14px 0;">
          <h1 class="fx-h1" style="margin:0;font-family:{FontStack};font-size:27px;line-height:34px;font-weight:700;letter-spacing:-0.5px;color:{TextPrimary};">{E(heading)}</h1>
        </td></tr>
        """;

    private static string HtmlBlock(EmailBlock block) => block switch
    {
        Paragraph p => HtmlParagraph(p.Text),
        Facts f => HtmlFacts(f.Rows),
        Callout c => HtmlCallout(c),
        CallToAction a => HtmlAction(a),
        Footnote n => HtmlFootnote(n.Text),
        _ => "",
    };

    private static string HtmlParagraph(string text) =>
        $"""
        <tr><td style="padding:0 0 14px 0;font-family:{FontStack};font-size:16px;line-height:25px;color:{TextPrimary};">{E(text)}</td></tr>
        """;

    private static string HtmlFootnote(string text) =>
        $"""
        <tr><td style="padding:4px 0 14px 0;font-family:{FontStack};font-size:13px;line-height:20px;color:{TextMuted};">{E(text)}</td></tr>
        """;

    /// <summary>
    /// The figures, as a real table with real row headers.
    /// </summary>
    /// <remarks>
    /// <c>th scope="row"</c> rather than a second <c>td</c>: these are the money rows, they are
    /// the reason the message exists, and a screen reader reading "50.00 credits" with no idea
    /// which of four numbers it is has told the member nothing. The banding is a painted
    /// background on the cell rather than a CSS class, because <c>:nth-child</c> reaches
    /// roughly none of the clients this has to survive.
    /// </remarks>
    private static string HtmlFacts(IReadOnlyList<FactRow> rows)
    {
        var sb = new StringBuilder();
        sb.Append($"""
            <tr><td style="padding:4px 0 18px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border:1px solid {Border};border-radius:8px;">
            """);
        for (var i = 0; i < rows.Count; i++)
        {
            var bg = i % 2 == 0 ? SurfaceBg : MutedBg;
            sb.Append($"""
                <tr>
                  <th scope="row" align="left" bgcolor="{bg}" style="background-color:{bg};padding:11px 16px;font-family:{FontStack};font-size:14px;line-height:20px;font-weight:400;color:{TextSecondary};text-align:left;">{E(rows[i].Label)}</th>
                  <td align="right" bgcolor="{bg}" style="background-color:{bg};padding:11px 16px;font-family:{FontStack};font-size:15px;line-height:20px;font-weight:600;color:{TextPrimary};text-align:right;">{E(rows[i].Value)}</td>
                </tr>
                """);
        }
        sb.Append("</table></td></tr>");
        return sb.ToString();
    }

    private static string HtmlCallout(Callout callout)
    {
        var (bg, bar, ink) = ToneColours(callout.Tone);
        return $"""
            <tr><td style="padding:2px 0 18px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
              <tr>
                <td bgcolor="{bar}" style="background-color:{bar};width:4px;font-size:0;line-height:0;">&nbsp;</td>
                <td bgcolor="{bg}" style="background-color:{bg};padding:13px 16px;font-family:{FontStack};font-size:15px;line-height:23px;font-weight:500;color:{ink};">{E(callout.Text)}</td>
              </tr>
            </table>
            </td></tr>
            """;
    }

    /// <summary>The soft ground, the rule, and the ink for each tone. All four pairs are the frontend's.</summary>
    private static (string Bg, string Bar, string Ink) ToneColours(CalloutTone tone) => tone switch
    {
        CalloutTone.Success => ("#DCFCE7", "#15803D", "#14532D"),
        CalloutTone.Warning => ("#FEF9C3", "#A16207", "#713F12"),
        CalloutTone.Danger => ("#FEE2E2", "#B91C1C", "#7F1D1D"),
        _ => ("#DBEAFE", "#1D4ED8", "#1E3A8A"),
    };

    /// <summary>
    /// The button, and the address under it.
    /// </summary>
    /// <remarks>
    /// The VML block is what gives Outlook a button at all — Word draws no padding on an
    /// anchor, so without it the "button" is a blue word. The address is printed below in
    /// every case rather than only when something fails, because the reader who needs it
    /// cannot tell you their client ate the anchor, and because a member who is unsure whether
    /// a sign-in mail is genuine should be able to read where it goes before pressing it.
    /// </remarks>
    private static string HtmlAction(CallToAction action)
    {
        var url = E(action.Url);
        var label = E(action.Label);
        return $"""
            <tr><td style="padding:6px 0 16px 0;">
            <!--[if mso]>
            <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="{url}" style="height:48px;v-text-anchor:middle;width:280px;" arcsize="17%" strokecolor="{BrandStrong}" fillcolor="{BrandStrong}">
              <w:anchorlock/><center style="color:#FFFFFF;font-family:{FontStack};font-size:16px;font-weight:600;">{label}</center>
            </v:roundrect>
            <![endif]-->
            <!--[if !mso]><!-- -->
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" class="fx-btn" style="border-radius:8px;">
              <tr><td align="center" bgcolor="{BrandStrong}" class="fx-btn" style="background-color:{BrandStrong};border-radius:8px;">
                <a href="{url}" style="display:inline-block;padding:14px 28px;font-family:{FontStack};font-size:16px;line-height:20px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px;">{label}</a>
              </td></tr>
            </table>
            <!--<![endif]-->
            </td></tr>
            <tr><td style="padding:0 0 16px 0;font-family:{FontStack};font-size:13px;line-height:20px;color:{TextMuted};word-break:break-all;">
              Or open this address in your browser:<br /><span style="color:{TextSecondary};">{url}</span>
            </td></tr>
            """;
    }

    /// <summary>
    /// Who sent this, how to reach them, and why this person has it.
    /// </summary>
    /// <remarks>
    /// The club's name appears here a second time, under the one it appears in at the top,
    /// because a forwarded message is usually forwarded from the bottom up and because the
    /// masthead is the half a dark-mode client is most likely to have repainted. Contact lines
    /// are omitted entirely when the club has not set them — see <see cref="ClubIdentity"/>.
    /// </remarks>
    private static string Footer(ClubIdentity club, string whyThis)
    {
        var sb = new StringBuilder();
        sb.Append($"""
            <tr><td bgcolor="{MutedBg}" class="fx-gutter" style="background-color:{MutedBg};padding:20px 32px 26px 32px;border-top:1px solid {Border};border-radius:0 0 12px 12px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="padding:0 0 6px 0;font-family:{FontStack};font-size:14px;line-height:21px;font-weight:600;color:{TextPrimary};">{E(club.Name)}</td></tr>
            """);
        if (club.HasContact) sb.Append(FooterContact(club));
        sb.Append($"""
              <tr><td style="padding:10px 0 0 0;font-family:{FontStack};font-size:12px;line-height:19px;color:{TextMuted};">{E(whyThis)}</td></tr>
            </table>
            </td></tr>
            """);
        return sb.ToString();
    }

    private static string FooterContact(ClubIdentity club)
    {
        var parts = new List<string>(2);
        if (!string.IsNullOrWhiteSpace(club.ContactPhone))
        {
            var dialled = E(club.ContactPhone.Replace(" ", ""));
            parts.Add($"""<a href="tel:{dialled}" style="color:{TextSecondary};text-decoration:underline;">{E(club.ContactPhone)}</a>""");
        }
        if (!string.IsNullOrWhiteSpace(club.ContactEmail))
        {
            var address = E(club.ContactEmail.Trim());
            parts.Add($"""<a href="mailto:{address}" style="color:{TextSecondary};text-decoration:underline;">{address}</a>""");
        }
        return $"""
            <tr><td style="padding:0;font-family:{FontStack};font-size:13px;line-height:21px;color:{TextSecondary};">{string.Join(" &nbsp;·&nbsp; ", parts)}</td></tr>
            """;
    }

    private static string E(string? value) => WebUtility.HtmlEncode(value ?? "");

    // ---- text/plain ----

    /// <summary>
    /// The same message, for a client that shows text.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Reading order is the block order, which is the reading order of the HTML, because both
    /// walk the same list. Figures keep their labels — <c>Charged: 50.00 credits</c> rather
    /// than a column that has lost its header to a line break — and the action prints its
    /// address in full, since a text client has no button to press.
    /// </para>
    /// <para>
    /// Wrapped at 72 columns. Not for the terminal: a phone showing a text part at a fixed
    /// width re-wraps a 200-character line into something unreadable, and the plain part is
    /// disproportionately what a member on a bad connection in a car park is served.
    /// </para>
    /// </remarks>
    private static string Text(ClubIdentity club, EmailContent content)
    {
        var sb = new StringBuilder(2048);
        sb.Append(club.Name.ToUpper(CultureInfo.InvariantCulture)).Append('\n');
        sb.Append(new string('=', Math.Min(72, Math.Max(3, club.Name.Length)))).Append("\n\n");
        sb.Append(Wrap(content.Heading)).Append("\n\n");
        foreach (var block in content.Blocks) sb.Append(TextBlock(block));
        sb.Append("-- \n").Append(club.Name).Append('\n');
        if (!string.IsNullOrWhiteSpace(club.ContactPhone)) sb.Append("Phone: ").Append(club.ContactPhone.Trim()).Append('\n');
        if (!string.IsNullOrWhiteSpace(club.ContactEmail)) sb.Append("Email: ").Append(club.ContactEmail.Trim()).Append('\n');
        sb.Append('\n').Append(Wrap(content.WhyThis)).Append('\n');
        return sb.ToString();
    }

    private static string TextBlock(EmailBlock block) => block switch
    {
        Paragraph p => Wrap(p.Text) + "\n\n",
        Facts f => TextFacts(f.Rows),
        Callout c => Wrap(c.Text) + "\n\n",
        CallToAction a => a.Label + ":\n" + a.Url + "\n\n",
        Footnote n => Wrap(n.Text) + "\n\n",
        _ => "",
    };

    private static string TextFacts(IReadOnlyList<FactRow> rows)
    {
        var sb = new StringBuilder();
        foreach (var row in rows) sb.Append("  ").Append(row.Label).Append(": ").Append(row.Value).Append('\n');
        sb.Append('\n');
        return sb.ToString();
    }

    /// <summary>Greedy wrap at 72 columns, preserving the words. Long tokens — a URL, a token — are left whole.</summary>
    private static string Wrap(string text)
    {
        const int width = 72;
        var sb = new StringBuilder(text.Length + 16);
        var column = 0;
        foreach (var word in text.Split(' ', StringSplitOptions.RemoveEmptyEntries))
        {
            if (column > 0 && column + 1 + word.Length > width)
            {
                sb.Append('\n');
                column = 0;
            }
            else if (column > 0)
            {
                sb.Append(' ');
                column++;
            }
            sb.Append(word);
            column += word.Length;
        }
        return sb.ToString();
    }
}

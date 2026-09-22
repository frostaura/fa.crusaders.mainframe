using System.Globalization;
using System.Net;
using System.Text;

namespace Crusaders.Mainframe.Api.Email;

/// <summary>
/// One block, rendered into each of the two bodies.
/// </summary>
/// <remarks>
/// <b>Part of <see cref="EmailChrome"/>, split across files for the complexity gate.</b>
/// lizard's C# reader cannot track scope through a file this dense in raw string literals full
/// of markup: it loses the class at some point partway down and reports the remainder as one
/// <c>*global*</c> pseudo-function the length of the file, which fails <c>-L 200</c> with a
/// warning naming no function anybody wrote. Removing any single member does not fix it — the
/// density does — so the fix is smaller files rather than a whitelist entry. See
/// <c>memory/gotchas-gates.md</c>.
/// </remarks>
public static partial class EmailChrome
{

    // Block body, not an expression one: lizard's C# parser reads the `{` of a switch
    // EXPRESSION as the END of the member and dumps the remainder of the file into a *global*
    // pseudo-function the length of the file, failing `-L 200` with a warning naming no real
    // function. Three members in this file are written this way for that reason alone.
    // See memory/gotchas-gates.md.
    private static string HtmlBlock(EmailBlock block)
    {
        switch (block)
        {
            case Paragraph p: return HtmlParagraph(p.Text);
            case Facts f: return HtmlFacts(f.Rows);
            case Callout c: return HtmlCallout(c);
            case CallToAction a: return HtmlAction(a);
            case Footnote n: return HtmlFootnote(n.Text);
            default: return "";
        }
    }

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

            // A value short enough to sit on one line is a figure, and figures line up on the
            // right where a reader compares them. A value long enough to wrap is prose — a
            // reason an admin typed, a reference — and right-aligned prose on a 375px phone
            // breaks into a ragged staircase that is harder to read than the sentence it came
            // from. The label never wraps, because "Balance after" split across two lines beside
            // a one-line figure is the row looking broken rather than full.
            var align = rows[i].Value.Length <= 24 ? "right" : "left";
            sb.Append($"""
                <tr>
                  <th scope="row" align="left" bgcolor="{bg}" style="background-color:{bg};padding:11px 16px;font-family:{FontStack};font-size:14px;line-height:20px;font-weight:400;color:{TextSecondary};text-align:left;white-space:nowrap;">{E(rows[i].Label)}</th>
                  <td align="{align}" bgcolor="{bg}" style="background-color:{bg};padding:11px 16px;font-family:{FontStack};font-size:15px;line-height:21px;font-weight:600;color:{TextPrimary};text-align:{align};">{E(rows[i].Value)}</td>
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
    // Block body — see HtmlBlock.
    private static (string Bg, string Bar, string Ink) ToneColours(CalloutTone tone)
    {
        switch (tone)
        {
            case CalloutTone.Success: return ("#DCFCE7", "#15803D", "#14532D");
            case CalloutTone.Warning: return ("#FEF9C3", "#A16207", "#713F12");
            case CalloutTone.Danger: return ("#FEE2E2", "#B91C1C", "#7F1D1D");
            default: return ("#DBEAFE", "#1D4ED8", "#1E3A8A");
        }
    }

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

    // Block body — see HtmlBlock.
    private static string TextBlock(EmailBlock block)
    {
        switch (block)
        {
            case Paragraph p: return Wrap(p.Text) + "\n\n";
            case Facts f: return TextFacts(f.Rows);
            case Callout c: return Wrap(c.Text) + "\n\n";
            case CallToAction a: return a.Label + ":\n" + a.Url + "\n\n";
            case Footnote n: return Wrap(n.Text) + "\n\n";
            default: return "";
        }
    }

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
using System.Net;
using System.Text;

namespace Crusaders.Mainframe.Api.Email;

/// <summary>
/// The document a client actually renders — head, page, masthead, card and footer.
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
}

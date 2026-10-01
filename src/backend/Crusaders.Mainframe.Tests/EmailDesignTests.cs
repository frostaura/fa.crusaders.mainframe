using System.Text.RegularExpressions;
using Crusaders.Mainframe.Api.Email;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The house rules for every message the product sends, asserted across the whole set at once.
///
/// <para>
/// <b>Why the set and not the template.</b> Each of these rules was already true of somewhere
/// between none and one of the twenty-three templates, and the ones it was true of were the
/// ones somebody had recently looked at. A member's inbox holds several of these at a time —
/// a booking, a top-up, a no-show, a password change — and an inconsistent set is worse than a
/// uniformly plain one, because a message that does not match its siblings is the one a
/// cautious reader treats as a forgery. So every rule here is asserted over
/// <see cref="EmailCatalogue"/>, and the catalogue is checked against reflection so a new
/// template cannot quietly opt out.
/// </para>
///
/// <para>
/// <b>These are constraints of the medium, not preferences.</b> Email HTML is rendered by Word
/// in Outlook, by a stripped subset in Gmail, and by nothing at all in a text client. Each
/// test below names the client behaviour it exists for, because a future reader who does not
/// know why a rule is there will delete it the first time it is inconvenient.
/// </para>
/// </summary>
public class EmailDesignTests
{
    private static IReadOnlyList<(string Name, EmailMessage Message)> Catalogue() =>
        EmailCatalogue.All(EmailCatalogue.Riverside);

    // ---- the catalogue is complete ----

    /// <summary>
    /// The anti-drift test. Everything below is only as good as the list it runs over, and a
    /// template added without a catalogue entry is a template none of these rules touch.
    /// </summary>
    [Fact]
    public void Every_template_the_product_can_send_is_in_the_catalogue()
    {
        var covered = Catalogue().Select(c => c.Name).ToHashSet(StringComparer.Ordinal);
        var missing = EmailCatalogue.DeclaredTemplateNames()
            .Where(name => !covered.Contains(name))
            .ToList();

        Assert.True(missing.Count == 0,
            "EmailTemplates declares templates the catalogue never renders, so no design rule "
            + "in this file has ever been applied to them: " + string.Join(", ", missing));
    }

    // ---- the medium ----

    /// <summary>
    /// A text-only client, a screen reader that could not parse the HTML part, and a spam
    /// filter that scores HTML-only mail all get the same thing today: nothing, or markup.
    /// <c>SmtpEmailService</c> has built a <c>multipart/alternative</c> since the day it was
    /// written and not one template ever gave it a second body to put in one.
    /// </summary>
    [Fact]
    public void Every_message_carries_a_plain_text_alternative()
    {
        foreach (var (name, message) in Catalogue())
        {
            Assert.False(string.IsNullOrWhiteSpace(message.PlainBody),
                $"{name} has no text/plain part, so it is sent single-part text/html.");
            Assert.DoesNotContain("<", message.PlainBody!, StringComparison.Ordinal);
        }
    }

    /// <summary>
    /// A loose <c>&lt;div&gt;</c> is not an email. Outlook's Word engine ignores
    /// <c>max-width</c> on one entirely and lays it out at the full width of the reading pane;
    /// a client with no charset declaration renders the em dashes this product's voice is
    /// built on as mojibake.
    /// </summary>
    [Fact]
    public void Every_message_is_a_whole_html_document_with_a_declared_charset()
    {
        foreach (var (name, message) in Catalogue())
        {
            Assert.Contains("<!DOCTYPE", message.HtmlBody, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("<html", message.HtmlBody, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("</body>", message.HtmlBody, StringComparison.OrdinalIgnoreCase);
            Assert.True(message.HtmlBody.Contains("charset=utf-8", StringComparison.OrdinalIgnoreCase),
                $"{name} declares no charset.");
        }
    }

    /// <summary>
    /// Tables, because Outlook supports no flexbox, no grid, and no modern box model. A layout
    /// that depends on any of the three renders as a single unstyled column there — which is
    /// the client most club committees read their mail in.
    /// </summary>
    [Fact]
    public void Every_message_lays_itself_out_in_tables_and_never_in_flexbox_or_grid()
    {
        foreach (var (name, message) in Catalogue())
        {
            Assert.Contains("role=\"presentation\"", message.HtmlBody, StringComparison.Ordinal);
            foreach (var banned in new[] { "display:flex", "display:grid", "display: flex", "display: grid", "position:absolute" })
            {
                Assert.False(message.HtmlBody.Contains(banned, StringComparison.OrdinalIgnoreCase),
                    $"{name} uses {banned}, which Outlook does not support.");
            }
        }
    }

    /// <summary>
    /// Gmail strips <c>&lt;link&gt;</c> and most clients strip <c>@import</c>, so a stylesheet
    /// is a layout that exists on the developer's machine only. The product self-hosts Figtree
    /// precisely to avoid a font CDN; an email that reached for one would be both slower and
    /// less private than the app it belongs to.
    /// </summary>
    [Fact]
    public void Every_message_styles_itself_inline_and_links_no_stylesheet_or_webfont()
    {
        foreach (var (name, message) in Catalogue())
        {
            Assert.DoesNotContain("<link", message.HtmlBody, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("@import", message.HtmlBody, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("fonts.googleapis", message.HtmlBody, StringComparison.OrdinalIgnoreCase);
            Assert.True(message.HtmlBody.Contains("font-family:Figtree", StringComparison.Ordinal),
                $"{name} does not name the club's own typeface first, with fallbacks after it.");
        }
    }

    /// <summary>
    /// Images are blocked by default in Outlook, in Gmail's app for a new sender, and on most
    /// corporate mail. Nothing essential may depend on one — and the simplest way to hold that
    /// line is to ship none at all, which the club's text wordmark makes possible.
    /// </summary>
    [Fact]
    public void No_message_depends_on_an_image_because_no_message_contains_one()
    {
        foreach (var (name, message) in Catalogue())
        {
            Assert.DoesNotContain("<img", message.HtmlBody, StringComparison.OrdinalIgnoreCase);
            Assert.False(message.HtmlBody.Contains("background-image", StringComparison.OrdinalIgnoreCase),
                $"{name} carries a background image, which will not load.");
        }
    }

    /// <summary>
    /// Many clients invert a message they believe is light-on-dark-capable. Dark body text on
    /// a background the message never painted is then invisible, and a member cannot tell a
    /// message they cannot read from one that never arrived. Every cell carrying text paints
    /// its own ground, as an attribute and as a style, because the clients that honour one
    /// ignore the other.
    /// </summary>
    [Fact]
    public void Every_message_paints_its_own_background_rather_than_assuming_a_light_one()
    {
        foreach (var (name, message) in Catalogue())
        {
            Assert.Contains("color-scheme", message.HtmlBody, StringComparison.OrdinalIgnoreCase);
            var painted = Regex.Matches(message.HtmlBody, "bgcolor=", RegexOptions.IgnoreCase).Count;
            Assert.True(painted >= 4, $"{name} paints only {painted} backgrounds; an inverting client will lose its text.");
            Assert.Contains("<body style=\"margin:0;padding:0;width:100%;background-color:", message.HtmlBody, StringComparison.Ordinal);
        }
    }

    /// <summary>
    /// Six hundred pixels is what a desktop reading pane shows without a horizontal scrollbar,
    /// and the viewport tag plus a 16px body is what keeps it legible on a phone — which,
    /// for this club, is where most of these are read.
    /// </summary>
    [Fact]
    public void Every_message_fits_a_600px_column_and_stays_legible_on_a_phone()
    {
        foreach (var (name, message) in Catalogue())
        {
            Assert.Contains("max-width:600px", message.HtmlBody, StringComparison.Ordinal);
            Assert.Contains("width=device-width", message.HtmlBody, StringComparison.Ordinal);
            Assert.True(message.HtmlBody.Contains("font-size:16px", StringComparison.Ordinal),
                $"{name} sets no 16px body copy; smaller than that is not readable at arm's length.");
        }
    }

    // ---- accessibility ----

    /// <summary>
    /// One <c>h1</c>, so a screen reader announces a heading structure rather than a wall. The
    /// old templates opened on an <c>h2</c> with no <c>h1</c> above it anywhere.
    /// </summary>
    [Fact]
    public void Every_message_has_exactly_one_level_one_heading()
    {
        foreach (var (name, message) in Catalogue())
        {
            var count = Regex.Matches(message.HtmlBody, "<h1[ >]", RegexOptions.IgnoreCase).Count;
            Assert.True(count == 1, $"{name} has {count} h1 elements.");
        }
    }

    /// <summary>
    /// "Click here" is the canonical unusable link: a screen reader lists a page's links out of
    /// context, and a member deciding whether a sign-in mail is genuine needs to read where it
    /// goes before pressing it. Every link therefore says what it does and prints its address.
    /// </summary>
    [Fact]
    public void Every_link_says_where_it_goes_and_no_message_says_click_here()
    {
        foreach (var (name, message) in Catalogue())
        {
            foreach (var banned in new[] { "click here", "tap here", "here to" })
            {
                Assert.False(message.HtmlBody.Contains(banned, StringComparison.OrdinalIgnoreCase),
                    $"{name} uses the phrase '{banned}'.");
            }

            foreach (Match link in Regex.Matches(message.HtmlBody, "href=\"(https?://[^\"]+)\""))
            {
                var url = link.Groups[1].Value;
                Assert.True(message.PlainBody!.Contains(url, StringComparison.Ordinal),
                    $"{name} links to {url} but the text part never prints the address, so a "
                    + "reader whose client dropped the anchor has nowhere to go.");
            }
        }
    }

    // ---- the two bodies cannot drift ----

    /// <summary>
    /// <b>The test that makes the second body safe to have.</b> Two hand-written bodies drift:
    /// a figure is corrected in the HTML, the text part keeps the old one, and the half nobody
    /// looks at is the half that then lies about money. Every money-shaped figure rendered into
    /// the HTML must appear in the text, which holds only if both are derived from one source.
    /// </summary>
    [Fact]
    public void Every_figure_the_html_states_is_stated_in_the_plain_text_too()
    {
        foreach (var (name, message) in Catalogue())
        {
            var visible = Regex.Replace(message.HtmlBody, "<[^>]+>", " ");
            foreach (Match figure in Regex.Matches(visible, @"\b\d+\.\d{2}\b"))
            {
                Assert.True(message.PlainBody!.Contains(figure.Value, StringComparison.Ordinal),
                    $"{name} shows {figure.Value} in the HTML and nowhere in the text part.");
            }
        }
    }

    // ---- the two units ----

    /// <summary>
    /// <b>No minutes figure anywhere in the catalogue carries the club's money symbol.</b>
    /// </summary>
    /// <remarks>
    /// <para>
    /// This product renders two quantities and only one of them is money. Rand is what a member
    /// hands PayFast or the desk for a package; minutes are the unit of account (P13). A minutes
    /// figure wearing a money sign is a unit lie on the one artifact a member reconciles a bank
    /// statement against. That is not hypothetical: every money email once printed
    /// "Charged R50,00" for a court the member had not paid R50 for.
    /// </para>
    /// <para>
    /// <b>Swept over the whole catalogue rather than asserted template by template.</b> The two
    /// lanes that produced this file arrived independently — one made the symbol configurable,
    /// the other rewrote every template onto shared stationery — and neither could see the
    /// other's templates. A rule that holds only where somebody last looked is a rule a merge
    /// drops silently, so this one is stated once, over everything the product can send.
    /// </para>
    /// <para>
    /// Rendered with <see cref="EmailCatalogue.ProbeSymbol"/> rather than the default: "R" is
    /// the first letter of "Riverside", "Refunded" and "Reason", so against the default this
    /// sweep would be measuring its own regex. Subject and both bodies, because the text part
    /// is the half nobody reads and therefore the half that would go on lying about money.
    /// </para>
    /// </remarks>
    [Fact]
    public void No_minutes_figure_in_any_message_carries_the_clubs_money_symbol()
    {
        const string symbol = EmailCatalogue.ProbeSymbol;

        // The rand figures the catalogue legitimately states: list prices, the discounted price
        // paid, and what the desk received. Anything else the symbol touches is a minutes
        // figure, which is the defect.
        var money = new HashSet<string>(StringComparer.Ordinal)
        {
            symbol + "550.00", symbol + "495.00", symbol + "120.00", symbol + "900.00",
        };

        // The symbol, then an amount. The decimal group is anchored on digits so a sentence's
        // full stop is not swallowed into the match and reported as a different figure.
        var attached = new Regex(Regex.Escape(symbol) + @"\s*-?\d+(?:[.,]\d+)*");

        var carriesMoney = new List<string>();

        foreach (var (name, message) in EmailCatalogue.All(EmailCatalogue.Riverside, symbol))
        {
            var visible = Regex.Replace(message.HtmlBody, "<[^>]+>", " ");
            foreach (var body in new[] { message.Subject, visible, MailText.Unwrap(message.PlainBody) })
            {
                foreach (Match figure in attached.Matches(body))
                {
                    Assert.True(money.Contains(figure.Value),
                        $"{name} prints {figure.Value}. The club's money symbol may only denominate "
                        + "rand — what the member paid for a package. Every other figure this product "
                        + "renders is minutes, and a minutes figure never wears a currency sign.");
                    carriesMoney.Add(name);
                }
            }
        }

        // The control, and the half that makes the sweep mean something: the symbol does reach
        // the templates that state real money, so a renderer that simply stopped printing it
        // does not pass this test by rendering nothing.
        Assert.Equal(
            ["AdminTopUpFailed", "PackageSoldAtDesk", "PurchaseCancelled", "PurchaseConfirmation",
             "PurchaseConfirmationNoDiscount", "PurchaseMismatched", "PurchaseNotCompleted"],
            carriesMoney.Distinct().OrderBy(n => n, StringComparer.Ordinal).ToList());

        // And the minutes figures on the template that shows both quantities are stated as
        // minutes, in both bodies — 300 added and 1 530 after, against 495 of money.
        var receipt = EmailCatalogue.All(EmailCatalogue.Riverside, symbol)
            .Single(c => c.Name == "PurchaseConfirmation").Message;
        foreach (var body in new[] { receipt.HtmlBody, MailText.Unwrap(receipt.PlainBody) })
        {
            Assert.Contains("5 hours", body, StringComparison.Ordinal);
            Assert.Contains("1 day 1 hour 30 minutes", body, StringComparison.Ordinal);
            Assert.DoesNotContain(symbol + "300", body, StringComparison.Ordinal);
            Assert.DoesNotContain(symbol + "1530", body, StringComparison.Ordinal);
        }
    }

    /// <summary>
    /// <b>No message the product can send says "credit" or "cr", or tells a member to "top up"</b>
    /// (contract §6). Swept over the whole catalogue, subject and both bodies, for the reason the
    /// symbol sweep above is: a word that holds only where somebody last looked comes back in
    /// the template nobody looked at. "credential" is not a hit; the scan is on whole words.
    /// </summary>
    [Fact]
    public void No_message_speaks_of_credits_or_topping_up()
    {
        var banned = new Regex(@"\bcredit(s|ed|ing)?\b|\bcr\b|\btop(ped)?[- ]?up", RegexOptions.IgnoreCase);
        foreach (var (name, message) in Catalogue())
        {
            var visible = Regex.Replace(message.HtmlBody, "<[^>]+>", " ");
            foreach (var body in new[] { message.Subject, visible, MailText.Unwrap(message.PlainBody) })
            {
                var hit = banned.Match(body);
                Assert.False(hit.Success, $"{name} says \"{hit.Value}\": …{Around(body, hit.Index)}…");
            }
        }
    }

    private static string Around(string body, int at) =>
        body.Substring(Math.Max(0, at - 40), Math.Min(80, body.Length - Math.Max(0, at - 40)));

    // ---- the club, and only the club ----

    /// <summary>
    /// Every message is sent by a club, and the club it names must be the one that sent it.
    /// The masthead and the footer both carry the name: a forwarded message is read from the
    /// bottom, and the masthead is what a dark-mode client is most likely to have repainted.
    /// </summary>
    [Fact]
    public void Every_message_names_the_club_that_sent_it_in_both_bodies()
    {
        var club = EmailCatalogue.Riverside;
        foreach (var (name, message) in EmailCatalogue.All(club))
        {
            Assert.True(message.HtmlBody.Contains(club.Name, StringComparison.Ordinal),
                $"{name} never names {club.Name}, so a member cannot tell who sent it.");
            Assert.True(message.PlainBody!.Contains(club.Name, StringComparison.Ordinal),
                $"{name}'s text part never names {club.Name}.");
        }
    }

    /// <summary>
    /// <b>The cross-tenant pass, on the one surface that leaves the building.</b> Tenant
    /// isolation is structural everywhere else in this system; it was not true of email, where
    /// four subject lines ended "— Crusaders Mainframe", every footer said a member had
    /// registered for it, and <c>BookingService</c> fell back to that literal when it could not
    /// resolve a tenant. "Crusaders Mainframe" is the software's name. On the second club's
    /// mail it is a different club's.
    /// </summary>
    [Fact]
    public void No_message_hardcodes_the_first_clubs_name_or_the_products_own()
    {
        foreach (var (name, message) in Catalogue())
        {
            var whole = message.Subject + "\n" + message.HtmlBody + "\n" + message.PlainBody;
            foreach (var literal in new[] { "Crusaders", "Mainframe" })
            {
                Assert.False(whole.Contains(literal, StringComparison.OrdinalIgnoreCase),
                    $"{name} hardcodes '{literal}' while rendering for {EmailCatalogue.Riverside.Name}.");
            }
        }
    }

    /// <summary>
    /// The control for the test above, and the stronger claim: a second club's mail carries the
    /// second club's name and contact details and not one trace of the first's. Without this an
    /// implementation that simply deleted every club name would pass.
    /// </summary>
    [Fact]
    public void A_second_clubs_mail_carries_only_the_second_clubs_name_and_contact_details()
    {
        var first = EmailCatalogue.Riverside;
        var second = EmailCatalogue.Kestrel;

        foreach (var (name, message) in EmailCatalogue.All(second))
        {
            var whole = message.Subject + "\n" + message.HtmlBody + "\n" + message.PlainBody;

            Assert.True(whole.Contains(second.Name, StringComparison.Ordinal),
                $"{name} does not name {second.Name}.");
            Assert.True(whole.Contains(second.ContactPhone, StringComparison.Ordinal),
                $"{name} does not carry {second.Name}'s own phone number.");
            Assert.True(whole.Contains(second.ContactEmail, StringComparison.Ordinal),
                $"{name} does not carry {second.Name}'s own address.");

            Assert.False(whole.Contains(first.Name, StringComparison.Ordinal),
                $"{name}, sent by {second.Name}, names {first.Name}.");
            Assert.False(whole.Contains(first.ContactPhone, StringComparison.Ordinal),
                $"{name}, sent by {second.Name}, carries {first.Name}'s phone number.");
            Assert.False(whole.Contains(first.ContactEmail, StringComparison.Ordinal),
                $"{name}, sent by {second.Name}, carries {first.Name}'s address.");
        }
    }

    /// <summary>
    /// <c>club_contact_phone</c> and <c>club_contact_email</c> both default to empty, and the
    /// rule the settings record states about them is that a club which has not set one must not
    /// be given an invented one. The sign-in screen already honours it by staying quiet rather
    /// than printing "Call the club on null"; a footer must not be the place that breaks it.
    /// </summary>
    [Fact]
    public void A_club_that_has_set_no_contact_details_is_not_given_invented_ones()
    {
        foreach (var (name, message) in EmailCatalogue.All(EmailCatalogue.Silent))
        {
            Assert.DoesNotContain("tel:", message.HtmlBody, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("mailto:", message.HtmlBody, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("&nbsp;·&nbsp;", message.HtmlBody, StringComparison.Ordinal);
            foreach (var artefact in new[] { "Phone: \n", "Email: \n", "null", "()" })
            {
                Assert.False(message.PlainBody!.Contains(artefact, StringComparison.Ordinal),
                    $"{name} renders '{artefact.Trim()}' for a club with no contact details.");
            }
        }
    }

    /// <summary>
    /// <b>Omitted means omitted, not emitted empty.</b>
    /// </summary>
    /// <remarks>
    /// The test above was satisfied by a footer that printed the contact row anyway and simply
    /// had nothing to put in it: no <c>tel:</c>, no <c>mailto:</c>, and a blank cell holding an
    /// empty string. A mutation that dropped the <c>HasContact</c> guard survived it — the club
    /// was not given an invented number, but it was given a hole where one goes, which on a
    /// table-laid-out message is a visible gap in the footer of every mail the club sends.
    /// Nothing in this design has a legitimate empty cell: the two that look empty — the tin
    /// rule and the callout's coloured bar — both carry a non-breaking space precisely so they
    /// have height in clients that collapse an empty cell.
    /// </remarks>
    [Fact]
    public void No_message_renders_an_empty_table_cell_where_something_was_omitted()
    {
        foreach (var club in new[] { EmailCatalogue.Riverside, EmailCatalogue.Silent })
        {
            foreach (var (name, message) in EmailCatalogue.All(club))
            {
                var empty = Regex.Match(message.HtmlBody, @"<t[dh][^>]*>\s*</t[dh]>");
                Assert.False(empty.Success,
                    $"{name}, for {club.Name}, renders an empty cell — something was omitted by "
                    + $"leaving it blank rather than by leaving it out: {empty.Value}");
            }
        }
    }

    // ---- the footer ----

    /// <summary>
    /// A transactional mail that explains nothing about itself is indistinguishable from a
    /// phishing attempt — which, on the mails carrying a sign-in link and a temporary password,
    /// is the failure that matters. Every message therefore closes with who sent it and why
    /// this person is holding it.
    /// </summary>
    /// <remarks>
    /// Asserted structurally rather than by wording: the signature block exists, the club is
    /// named in it, and there is a sentence after it that is not the club's name or its contact
    /// lines. Pinning the words instead would make the rule unfixable without editing a test.
    /// </remarks>
    [Fact]
    public void Every_message_closes_by_saying_who_sent_it_and_why_the_reader_has_it()
    {
        var club = EmailCatalogue.Riverside;
        foreach (var (name, message) in EmailCatalogue.All(club))
        {
            var cut = message.PlainBody!.LastIndexOf("-- \n", StringComparison.Ordinal);
            Assert.True(cut > 0, $"{name}'s text part has no signature block.");

            var footer = message.PlainBody[cut..];
            Assert.Contains(club.Name, footer, StringComparison.Ordinal);

            var reason = footer
                .Split('\n')
                .Select(line => line.Trim())
                .Where(line => line.Length >= 40 && !line.Contains(club.ContactEmail, StringComparison.Ordinal))
                .ToList();
            Assert.True(reason.Count > 0,
                $"{name} never tells the reader why they received it.");
        }
    }

    // ---- subjects ----

    /// <summary>
    /// The subject is the part most people actually read, and often the only part. It says what
    /// happened; it fits in a phone's list without being cut mid-word; and it does not end in
    /// the name of a piece of software.
    /// </summary>
    [Fact]
    public void Every_subject_says_what_happened_and_fits_in_a_phones_inbox_list()
    {
        foreach (var (name, message) in Catalogue())
        {
            Assert.False(string.IsNullOrWhiteSpace(message.Subject), $"{name} has no subject.");
            // 72 characters for the template's OWN words. The one variable a subject carries
            // is the club's name, and the two templates that use it lead with it, so a club
            // with a long name loses the tail rather than the point.
            Assert.True(message.Subject.Length <= 72,
                $"{name}'s subject is {message.Subject.Length} characters and will be cut: {message.Subject}");
            Assert.Equal(message.Subject.Trim(), message.Subject);
            Assert.False(message.Subject.EndsWith('.'), $"{name}'s subject ends in a full stop.");
        }
    }

    // ---- injection ----

    /// <summary>
    /// A cancellation reason, a rejection reason and an adjustment reason are all free text one
    /// person types into a message sent to another. The old templates escaped some
    /// interpolations and not others — <c>BookingConfirmation</c> printed a court name raw
    /// while <c>WalkUpNotStarted</c> encoded one — which is the kind of inconsistency that is
    /// invisible until it is a payload. The block model escapes once, centrally, so a template
    /// cannot get it wrong.
    /// </summary>
    [Theory]
    [InlineData("<script>alert(1)</script>")]
    [InlineData("\"><b>bold</b>")]
    public void Anything_a_person_typed_is_escaped_before_it_reaches_another_persons_inbox(string payload)
    {
        var club = EmailCatalogue.Riverside;
        var messages = new[]
        {
            EmailTemplates.MembershipRejected(club, "m@riverside.review.test", payload),
            EmailTemplates.MinutesAdjusted(club, "m@riverside.review.test", 10, 20, payload),
            EmailTemplates.BookingCancellation(club, "m@riverside.review.test", payload, 5, null, new ClubCancellation(payload, false)),
        };

        foreach (var message in messages)
        {
            Assert.DoesNotContain("<script", message.HtmlBody, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("<b>", message.HtmlBody, StringComparison.OrdinalIgnoreCase);
        }
    }
}

using System.Text;

namespace Crusaders.Mainframe.Api.Email;

/// <summary>
/// The booking receipt, as a PDF, written by hand.
/// </summary>
/// <remarks>
/// <para>
/// <c>docs/specs/feature-spec.md</c> §11 lists "Booking confirmation + receipt PDF attached" among
/// the required emails, and the confirmation shipped as a single-part HTML message with no
/// attachment of any kind. A receipt is the artefact a member forwards to a treasurer or keeps
/// against a disputed charge, and the invariant that disputes are resolved by replaying the
/// ledger only helps somebody who can say which movement they are disputing.
/// </para>
/// <para>
/// <b>Hand-written rather than a library, deliberately.</b> A receipt is one page of left-aligned
/// text in one standard font. Every PDF library that would draw it also brings a rendering engine,
/// a licence to read and a supply-chain surface, against a repo whose rule is free-tier-first and
/// whose only paid third parties are SMTP and PayFast. What is below is the smallest complete PDF
/// that a reader will open: a catalogue, a pages node, one page, one Helvetica font resource, and
/// one uncompressed content stream. Uncompressed is a feature — the receipt's own numbers are
/// greppable in the bytes, which is what lets a test assert the amount rather than assert that
/// some bytes exist.
/// </para>
/// <para>
/// The output is deliberately plain: WinAnsi text, no images, no embedded fonts. Helvetica is one
/// of the fourteen standard faces every conforming reader has, so nothing has to be embedded and
/// the file stays a couple of kilobytes — which matters, because it travels on every booking
/// confirmation.
/// </para>
/// </remarks>
/// <summary>
/// Everything one booking receipt states, as named members.
/// </summary>
/// <remarks>
/// <para>
/// Its own record rather than ten positional parameters, on the argument
/// <see cref="BookingConfirmationDetails"/> already makes: nine of the ten are a string or a
/// decimal, so a transposed pair — the member and the court, the charge and the balance —
/// would have compiled and printed a wrong receipt. Named members make that a compile error.
/// </para>
/// <para>
/// <b>Both</b> times are the club's own wall clock, and that is why <see cref="IssuedAtLocal"/>
/// arrives already formatted rather than as a <c>DateTimeOffset</c> this file would stamp
/// itself. It used to render <c>UtcNow</c> with a literal "UTC" two lines above a "Starts" that
/// had been converted to <c>tenant_settings.timezone</c>, so every receipt carried two times
/// two hours apart for the same booking — on the one artefact a member keeps against a
/// disputed charge.
/// </para>
/// </remarks>
/// <param name="CurrencySymbol">
/// The club's own symbol, from <see cref="Services.CurrencySymbol.For"/>. <b>Required, and
/// carried on the record rather than assumed here</b>: this is the document a member reconciles
/// a bank statement against, so a hardcoded sign on it is the worst possible place for one.
/// </param>
public sealed record BookingReceipt(
    string ClubName,
    string MemberName,
    string BookingReference,
    string CourtName,
    string StartsAtLocal,
    string Duration,
    decimal AmountCredits,
    decimal BalanceAfterCredits,
    string IssuedAtLocal,
    string CurrencySymbol);

public static class ReceiptPdf
{
    /// <summary>One line of the receipt: a label and its value, or a bare heading.</summary>
    public sealed record Line(string Label, string? Value = null);

    /// <summary>A4 in PDF points (72dpi), which is what every reader defaults to.</summary>
    private const int PageWidth = 595;
    private const int PageHeight = 842;

    /// <summary>
    /// Renders the receipt for one booking.
    /// </summary>
    /// <remarks>
    /// Every figure is written in the club's own symbol, which is the owner's ruling: one
    /// symbol in front of every amount the product prints, and no unit word after any of them.
    /// The rendering is <see cref="EmailTemplates.Money"/>'s, so the receipt and the mail it
    /// travels attached to cannot format the same number two ways.
    /// </remarks>
    public static byte[] ForBooking(BookingReceipt r)
    {
        var lines = new List<Line>
        {
            new(r.ClubName),
            new("Booking receipt"),
            new(""),
            new("Receipt no.", r.BookingReference),
            new("Issued", r.IssuedAtLocal),
            new("Member", r.MemberName),
            new(""),
            new("Court", r.CourtName),
            new("Starts", r.StartsAtLocal),
            new("Duration", r.Duration),
            new(""),
            new("Charged", EmailTemplates.Money(r.AmountCredits, r.CurrencySymbol)),
            new("Balance after", EmailTemplates.Money(r.BalanceAfterCredits, r.CurrencySymbol)),
            new(""),
            new("Times and amounts are this club's own."),
            new("This receipt records one ledger movement; your wallet holds the full history."),
        };
        return Render(lines);
    }

    /// <summary>Draws the lines onto a single page and assembles the file.</summary>
    private static byte[] Render(IReadOnlyList<Line> lines)
    {
        var content = BuildContentStream(lines);
        return Assemble(content);
    }

    private static string BuildContentStream(IReadOnlyList<Line> lines)
    {
        var sb = new StringBuilder();
        var y = PageHeight - 72;
        for (var i = 0; i < lines.Count; i++)
        {
            var line = lines[i];
            if (string.IsNullOrEmpty(line.Label) && line.Value is null) { y -= 12; continue; }

            // The first two lines are the club and the document type; everything after is body.
            var size = i switch { 0 => 20, 1 => 13, _ => 11 };
            var font = i <= 1 ? "F2" : "F1";
            sb.Append(Text(font, size, 72, y, line.Label));
            if (line.Value is not null) sb.Append(Text("F2", size, 220, y, line.Value));
            y -= size + 10;
        }
        return sb.ToString();
    }

    private static string Text(string font, int size, int x, int y, string value)
        => $"BT /{font} {size} Tf {x} {y} Td ({EscapeText(value)}) Tj ET\n";

    /// <summary>
    /// The one code point WinAnsi and Latin-1 disagree about that this document needs.
    ///
    /// <para>
    /// WinAnsi puts the euro sign at <c>0x80</c>, which Latin-1 leaves as a control byte, so the
    /// <see cref="Encoding.Latin1"/> writer in <see cref="Assemble"/> emits <c>0x80</c> for
    /// <c>U+0080</c> and the reader decodes it back as <c>€</c>. Mapping it here rather than in
    /// the writer keeps the offset arithmetic honest — one char in, one byte out, as every other
    /// character on the page already is.
    /// </para>
    /// </summary>
    private const char WinAnsiEuro = '';

    /// <summary>
    /// Escapes a string for a PDF literal.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Backslash, and both parentheses, end a literal early — a court called "Court (old)" would
    /// otherwise produce a file no reader can parse, and a member's own name is attacker-adjacent
    /// input on a document the club emails out.
    /// </para>
    /// <para>
    /// <b>The accepted range is WinAnsi's, not ASCII's, and that is load-bearing since the
    /// club's currency symbol started printing here.</b> It used to drop everything above
    /// <c>~</c>, which was harmless while the unit was the literal "cr" and is not now: a club
    /// on <c>£</c> or <c>€</c> would have been handed a receipt reading "100.00" with the sign
    /// silently gone, on the one document it is reconciled from. <c>0xA0</c>–<c>0xFF</c> is the
    /// range WinAnsi and Latin-1 agree on byte for byte, so it passes through the writer
    /// unchanged; the euro is the single exception and is mapped to the slot WinAnsi gives it.
    /// Anything else outside the range is still dropped rather than guessed at, because a
    /// mis-encoded byte renders as a wrong character rather than as nothing, which is worse on
    /// a receipt.
    /// </para>
    /// </remarks>
    private static string EscapeText(string value)
    {
        var sb = new StringBuilder(value.Length + 8);
        foreach (var ch in value)
        {
            if (ch is '(' or ')' or '\\') sb.Append('\\').Append(ch);
            else if (ch >= ' ' && ch <= '~') sb.Append(ch);
            else if (ch == '€') sb.Append(WinAnsiEuro);
            else if (ch >= ' ' && ch <= 'ÿ') sb.Append(ch);
        }
        return sb.ToString();
    }

    /// <summary>
    /// Assembles the five objects and the cross-reference table.
    /// </summary>
    /// <remarks>
    /// The xref table holds a byte offset per object and a reader will refuse the file outright
    /// if one is wrong, so the offsets are measured off the buffer as it is written rather than
    /// computed from the lengths of the strings. Latin-1 throughout: PDF syntax is byte-oriented,
    /// and writing the body as UTF-8 would shift every offset after the first non-ASCII byte.
    /// </remarks>
    private static byte[] Assemble(string content)
    {
        var latin1 = Encoding.Latin1;
        var objects = new[]
        {
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            $"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PageWidth} {PageHeight}] "
                + "/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>",
            $"<< /Length {latin1.GetByteCount(content)} >>\nstream\n{content}endstream",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
        };

        using var buffer = new MemoryStream();
        void Write(string s) { var b = latin1.GetBytes(s); buffer.Write(b, 0, b.Length); }

        Write("%PDF-1.4\n");
        var offsets = new long[objects.Length + 1];
        for (var i = 0; i < objects.Length; i++)
        {
            offsets[i + 1] = buffer.Length;
            Write($"{i + 1} 0 obj\n{objects[i]}\nendobj\n");
        }

        var xrefAt = buffer.Length;
        Write($"xref\n0 {objects.Length + 1}\n");
        Write("0000000000 65535 f \n");
        for (var i = 1; i <= objects.Length; i++)
        {
            Write($"{offsets[i]:D10} 00000 n \n");
        }
        Write($"trailer\n<< /Size {objects.Length + 1} /Root 1 0 R >>\nstartxref\n{xrefAt}\n%%EOF\n");

        return buffer.ToArray();
    }
}

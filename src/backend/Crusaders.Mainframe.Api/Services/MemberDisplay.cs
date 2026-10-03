using System.Globalization;
using System.Text;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The member's name as a court box's LCD can print it — GOAL item 4's greeting line.
///
/// <para>
/// <b>The server truncates, and the reason is a property of the board rather than of taste.</b>
/// The firmware's JSON reader REFUSES a string that will not fit the caller's buffer instead of
/// truncating it — half a value is a different value — and that buffer is sized to the LCD's
/// twenty columns. So a forty-character name does not arrive shortened at the box; it arrives
/// and is thrown away, and the member is greeted with <c>HI THERE</c> while the club wonders
/// why only some names show. Capping here is the only place the cap can be applied without the
/// board inventing a name it was not given.
/// </para>
///
/// <para>
/// <b>Absent is a real and ordinary state.</b> A club that has not filled in a member's name,
/// and a scan that identified nobody, both produce no field at all — and an unnamed member
/// still gets their court. Absence changes the greeting and nothing else.
/// </para>
/// </summary>
public static class MemberDisplay
{
    /// <summary>
    /// The longest name the box will accept. Sixteen rather than the panel's twenty, because
    /// the greeting line carries a few characters of its own and a name that fills the row
    /// leaves the member reading a word with no sentence around it.
    /// </summary>
    public const int MaxLength = 16;

    /// <summary>The word shown when a name has nothing printable left in it.</summary>
    public const string Fallback = "MEMBER";

    /// <summary>
    /// The display name for a member, or null when there is nothing worth showing.
    ///
    /// <para>
    /// Upper-cased because the fitted panel's character set renders lower-case descenders
    /// badly at this size, and because every other string the box prints is upper-case — a
    /// single mixed-case line reads as a rendering fault rather than as a name.
    /// </para>
    /// </summary>
    public static async Task<string?> ForAsync(MainframeDbContext db, Guid? userId, CancellationToken ct)
    {
        if (userId is not { } id || id == Guid.Empty) return null;

        var full = await db.Memberships.AsNoTracking()
            .Where(m => m.UserId == id)
            .Select(m => m.FullName)
            .FirstOrDefaultAsync(ct);

        return Shorten(full);
    }

    /// <summary>
    /// A full name reduced to something that fits: first name plus a surname initial, and only
    /// then a hard cut.
    ///
    /// <para>
    /// "PRIYA N" is a person a club recognises; "PRIYA NAIDOO-VAN DER" is a string that has
    /// been damaged. Dropping to an initial is what makes the common long name readable rather
    /// than merely short, and the hard cut is the last resort for a single word longer than the
    /// panel.
    /// </para>
    /// </summary>
    public static string? Shorten(string? fullName)
    {
        if (string.IsNullOrWhiteSpace(fullName)) return null;

        var name = FoldToAscii(fullName).ToUpperInvariant();
        if (name.Length == 0) return Fallback;
        if (name.Length <= MaxLength) return name;

        var space = name.IndexOf(' ');
        if (space > 0)
        {
            var initialled = $"{name[..space]} {name[space + 1]}";
            if (initialled.Length <= MaxLength) return initialled;
        }

        return name[..MaxLength];
    }

    /// <summary>
    /// The name in printable ASCII only (R11 D11-1): decomposed, its accents dropped, the few
    /// letters that do not decompose spelled out, and anything else — an emoji, a script the
    /// panel has no glyphs for — removed, with the spaces it leaves collapsed.
    ///
    /// <para>
    /// The panel is an HD44780: every byte past <c>0x7E</c> is a glyph from its own ROM, and the
    /// bridge counts a two-byte UTF-8 letter as two columns. "ZOË NEL" printed as "ZO", two
    /// unrelated symbols and " NEL", one column longer than the server measured. "ZOE NEL" is
    /// the name a club recognises; a symbol in the middle of it is a fault.
    /// </para>
    /// </summary>
    private static string FoldToAscii(string text)
    {
        var kept = new StringBuilder(text.Length);
        foreach (var c in text.Normalize(NormalizationForm.FormD))
        {
            if (CharUnicodeInfo.GetUnicodeCategory(c) == UnicodeCategory.NonSpacingMark) continue;
            if (c is >= ' ' and <= '~') kept.Append(c);
            else if (Spelled.TryGetValue(c, out var spelled)) kept.Append(spelled);
            else kept.Append(' ');
        }
        return string.Join(' ', kept.ToString().Split(' ', StringSplitOptions.RemoveEmptyEntries));
    }

    /// <summary>Letters and marks with no ASCII decomposition, spelled the way the name is said.</summary>
    private static readonly Dictionary<char, string> Spelled = new()
    {
        ['ß'] = "ss",
        ['Æ'] = "AE",
        ['æ'] = "ae",
        ['Œ'] = "OE",
        ['œ'] = "oe",
        ['Ø'] = "O",
        ['ø'] = "o",
        ['Ł'] = "L",
        ['ł'] = "l",
        ['Đ'] = "D",
        ['đ'] = "d",
        ['Ð'] = "D",
        ['ð'] = "d",
        ['Þ'] = "TH",
        ['þ'] = "th",
        ['ı'] = "i",
        ['\u2018'] = "'",
        ['\u2019'] = "'",
        ['\u02BC'] = "'",
        ['\u201C'] = "\"",
        ['\u201D'] = "\"",
        ['\u2010'] = "-",
        ['\u2011'] = "-",
        ['\u2013'] = "-",
        ['\u2014'] = "-",
    };
}

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// One cell of a CSV this product hands to a club: defused against a spreadsheet's formula
/// parser, then quoted against the CSV grammar.
///
/// <para>
/// <b>Both, in that order.</b> A value quoted first would still begin with <c>=</c> once the
/// quotes were stripped by the reader, and a cell beginning <c>=</c>, <c>+</c>, <c>-</c> or
/// <c>@</c> is executed by Excel, Numbers and LibreOffice alike — with a member's own name as
/// the payload, in a file a club opens without thinking about it.
/// </para>
///
/// <para>
/// <b>Here rather than private to one endpoint, because there are now three exports.</b> The
/// door log's copy was the original and is the one that was got right; the wallet export does
/// not use it at all, and the admin change record is the third. A rule that has to be
/// re-derived per export is a rule one export will get wrong, and this one is invisible until
/// somebody's spreadsheet runs a formula out of a name field.
/// </para>
/// </summary>
public static class CsvCell
{
    /// <summary>The characters a spreadsheet treats as the start of a formula.</summary>
    private const string FormulaStarters = "=+-@";

    /// <summary>One cell, safe to concatenate into a CSV line.</summary>
    public static string Of(string value)
    {
        var safe = value.Length > 0 && FormulaStarters.Contains(value[0]) ? "'" + value : value;
        return safe.Contains(',') || safe.Contains('"') || safe.Contains('\n') || safe.Contains('\r')
            ? "\"" + safe.Replace("\"", "\"\"") + "\""
            : safe;
    }

    /// <summary>One line, CRLF-terminated as RFC 4180 wants.</summary>
    public static string Line(params string?[] cells)
        => string.Join(",", cells.Select(c => Of(c ?? ""))) + "\r\n";
}

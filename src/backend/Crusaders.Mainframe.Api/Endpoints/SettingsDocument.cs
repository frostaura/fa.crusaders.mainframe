using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The club settings document as a thing two admins can both have open (review round 4, A4-1).
///
/// <para>
/// <b>The version is a hash of the stored document's MEANING, not of its text.</b> The column
/// is <c>jsonb</c>, so Postgres re-orders keys and re-spaces what it hands back; a hash of the
/// text EF reads would differ from a hash of the document the handler just serialised, and the
/// save's reply could never name the version the next GET reports. Canonical form — keys in
/// ordinal order, strings by value, numbers by their decimal value — is the same on both sides.
/// </para>
///
/// <para>
/// A content hash rather than a counter or <c>UpdatedAt</c>: a save that changes nothing leaves
/// the version where it was, so a colleague who pressed save on an unchanged page does not
/// make everybody else's open page stale. No column, so no migration.
/// </para>
/// </summary>
internal static class SettingsDocument
{
    /// <summary>The 409 a stale save answers with.</summary>
    public const string Changed = "settings_changed";

    /// <summary>The version of a stored document; an absent row is the empty document.</summary>
    public static string VersionOf(string? storedJson)
    {
        if (string.IsNullOrWhiteSpace(storedJson)) return VersionOf(new Dictionary<string, JsonElement>());
        using var doc = JsonDocument.Parse(storedJson);
        return Hash(Canonical(doc.RootElement));
    }

    /// <summary>The version of a document the handler holds in memory.</summary>
    public static string VersionOf(IReadOnlyDictionary<string, JsonElement> doc)
    {
        return Hash(Canonical(JsonSerializer.SerializeToElement(doc)));
    }

    /// <summary>
    /// Whether two stored values MEAN the same thing — key order, whitespace and a number's
    /// trailing zeros aside.
    ///
    /// <para>
    /// The change record compared raw text, and the stored form of <c>operating_hours</c> is
    /// Postgres' (keys by length, spaced) while the sent form is the serialiser's, so the map
    /// was "changed" on every save and rewritten each time (A4-1).
    /// </para>
    /// </summary>
    public static bool SameValue(JsonElement a, JsonElement b)
    {
        return Canonical(a) == Canonical(b);
    }

    /// <summary>
    /// Takes the club's settings row for the length of a transaction, so a save reads, checks
    /// and writes a document nobody else is writing.
    ///
    /// <para>
    /// A ROW lock, not only an advisory one: the member-code rollout patches this row with its
    /// own <c>UPDATE … ||</c>, and a row lock is what that statement waits on. Two saves with the
    /// same version therefore run one after the other, and the second is refused as stale
    /// instead of both being accepted. Null on a provider with no transactions (the in-memory
    /// unit suites), where the Postgres suite proves the lock instead.
    /// </para>
    /// </summary>
    public static async Task<IDbContextTransaction?> LockAsync(
        MainframeDbContext db, Guid tenantId, CancellationToken ct)
    {
        if (!db.Database.IsNpgsql()) return null;

        var tx = await db.Database.BeginTransactionAsync(ct);
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""SELECT 1 FROM tenant_settings WHERE "TenantId" = {tenantId} FOR UPDATE""", ct);
        return tx;
    }

    private static string Hash(string canonical)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(canonical));
        return Convert.ToHexString(bytes, 0, 8).ToLowerInvariant();
    }

    private static string Canonical(JsonElement element)
    {
        var buffer = new StringBuilder();
        Write(buffer, element);
        return buffer.ToString();
    }

    private static void Write(StringBuilder into, JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                WriteObject(into, element);
                break;
            case JsonValueKind.Array:
                into.Append('[');
                var first = true;
                foreach (var item in element.EnumerateArray())
                {
                    if (!first) into.Append(',');
                    first = false;
                    Write(into, item);
                }
                into.Append(']');
                break;
            case JsonValueKind.String:
                into.Append(JsonSerializer.Serialize(element.GetString()));
                break;
            case JsonValueKind.Number:
                into.Append(Number(element));
                break;
            default:
                into.Append(element.GetRawText());
                break;
        }
    }

    private static void WriteObject(StringBuilder into, JsonElement element)
    {
        into.Append('{');
        var first = true;
        foreach (var property in element.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
        {
            if (!first) into.Append(',');
            first = false;
            into.Append(JsonSerializer.Serialize(property.Name)).Append(':');
            Write(into, property.Value);
        }
        into.Append('}');
    }

    private static string Number(JsonElement element)
    {
        if (!element.TryGetDecimal(out var value)) return element.GetRawText();
        return value.ToString("G29", CultureInfo.InvariantCulture);
    }
}

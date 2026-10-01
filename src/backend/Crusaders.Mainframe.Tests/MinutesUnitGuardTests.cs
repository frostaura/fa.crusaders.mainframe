using System.Reflection;
using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// P13 invariant 9 (<c>docs/specs/minutes-and-packages.md</c> §1.3): a property's name states its
/// unit, and the type must agree. Minutes are whole (<see cref="int"/>), rand is
/// <see cref="decimal"/>. A <c>*Minutes</c> property typed <c>decimal</c> is a field that can hold
/// a fraction of the unit of account; a <c>*Zar</c> property typed <c>int</c> drops the cents.
/// Both are the "field whose name implies one unit while it holds another" defect CLAUDE.md
/// forbids, caught by reflection over the whole API assembly rather than by review.
/// </summary>
public class MinutesUnitGuardTests
{
    private static IEnumerable<PropertyInfo> AllProperties() =>
        typeof(LedgerEntry).Assembly.GetTypes()
            .SelectMany(t => t.GetProperties(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly));

    private static string Name(PropertyInfo p) => $"{p.DeclaringType!.FullName}.{p.Name}";

    [Fact]
    public void No_minutes_property_is_typed_decimal()
    {
        var offenders = AllProperties()
            .Where(p => p.Name.EndsWith("Minutes", StringComparison.Ordinal))
            .Where(p => p.PropertyType == typeof(decimal) || p.PropertyType == typeof(decimal?))
            .Select(Name).OrderBy(n => n, StringComparer.Ordinal).ToList();

        Assert.True(offenders.Count == 0, "decimal *Minutes: " + string.Join(", ", offenders));
    }

    [Fact]
    public void No_rand_property_is_typed_int()
    {
        var offenders = AllProperties()
            .Where(p => p.Name.EndsWith("Zar", StringComparison.Ordinal))
            .Where(p => p.PropertyType == typeof(int) || p.PropertyType == typeof(int?))
            .Select(Name).OrderBy(n => n, StringComparer.Ordinal).ToList();

        Assert.True(offenders.Count == 0, "int *Zar: " + string.Join(", ", offenders));
    }

    /// <summary>The guard sees what it claims to: the ledger's own amount and a purchase's price.</summary>
    [Fact]
    public void The_guard_reads_the_money_path()
    {
        var names = AllProperties().Select(Name).ToHashSet(StringComparer.Ordinal);
        Assert.Contains($"{typeof(LedgerEntry).FullName}.{nameof(LedgerEntry.AmountMinutes)}", names);
        Assert.Contains($"{typeof(PendingTopup).FullName}.{nameof(PendingTopup.ListPriceZar)}", names);
        Assert.Equal(typeof(int), typeof(LedgerEntry).GetProperty(nameof(LedgerEntry.AmountMinutes))!.PropertyType);
    }
}

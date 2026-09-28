using System.Reflection;
using Xunit.Abstractions;
using Xunit.Sdk;

[assembly: TestCollectionOrderer("Crusaders.Mainframe.Tests.LongestClassFirst", "Crusaders.Mainframe.Tests")]

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Starts the most expensive test classes first, so the run ends when the work runs out rather
/// than when the biggest class, started last, finally finishes.
///
/// <para>
/// Every class is its own xUnit collection and collections run in parallel, so the wall clock is
/// at least the longest single class — and xUnit's default order is effectively random. Measured
/// 2026-09-28: <c>AdminSettingsHttpTests</c> (129 tests, the longest class) started four minutes
/// into an 18-minute run and was the only thing still running for its last six. Longest-first is
/// the textbook fix for that (LPT scheduling).
/// </para>
///
/// <para>
/// The cost of a class is estimated, not measured: its number of test cases, times ten when it is
/// Postgres-backed (<see cref="PostgresFixture"/>), because almost every such test boots a whole
/// host and an in-memory one does not. Order changes nothing about what runs or what it asserts —
/// a test that depends on running before or after another class is broken whatever this does.
/// </para>
/// </summary>
public sealed class LongestClassFirst : ITestCollectionOrderer
{
    private const int PostgresWeight = 10;

    public IEnumerable<ITestCollection> OrderTestCollections(IEnumerable<ITestCollection> testCollections)
    {
        var assembly = typeof(LongestClassFirst).Assembly;
        return testCollections
            .Select((collection, index) => (collection, index, cost: Cost(assembly, collection)))
            .OrderByDescending(c => c.cost)
            .ThenBy(c => c.index)
            .Select(c => c.collection)
            .ToList();
    }

    // A class's collection is named "Test collection for <full type name>", optionally followed by
    // " (id: …)". Anything that does not resolve to a type costs nothing and keeps its place.
    private static int Cost(Assembly assembly, ITestCollection collection)
    {
        const string prefix = "Test collection for ";
        var name = collection.DisplayName;
        if (!name.StartsWith(prefix, StringComparison.Ordinal))
        {
            return 0;
        }

        name = name[prefix.Length..];
        var paren = name.IndexOf(" (", StringComparison.Ordinal);
        if (paren >= 0)
        {
            name = name[..paren];
        }

        var type = assembly.GetType(name);
        if (type is null)
        {
            return 0;
        }

        var cases = type
            .GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static)
            .Sum(CasesOf);
        var postgres = typeof(IClassFixture<PostgresFixture>).IsAssignableFrom(type);
        return cases * (postgres ? PostgresWeight : 1);
    }

    private static int CasesOf(MethodInfo method)
    {
        var attributes = method.GetCustomAttributes(inherit: true);
        if (!attributes.OfType<FactAttribute>().Any())
        {
            return 0;
        }

        // A theory is one case per data row; MemberData rows are not counted without running
        // them, so such a theory counts as one — an estimate is all ordering needs.
        var rows = attributes.OfType<InlineDataAttribute>().Count();
        return Math.Max(rows, 1);
    }
}

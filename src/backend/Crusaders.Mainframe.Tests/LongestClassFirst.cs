using System.Reflection;
using System.Text.Json;
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
/// The cost of a class is its MEASURED duration from <c>src/backend/tools/test-timings.json</c>
/// (the same file CI's shards are balanced by, copied beside the test assembly). A class that file
/// does not know is estimated: its number of test cases, times ten when it is Postgres-backed
/// (<see cref="PostgresFixture"/>), in the same unit as a measured tenth of a second per case.
/// The estimate alone put a one-test, three-minute class (<c>PlayersPropertyHttpTests</c>) near
/// the end of the queue, where it became the run's tail — measured 2026-09-30. Order changes
/// nothing about what runs or what it asserts — a test that depends on running before or after
/// another class is broken whatever this does.
/// </para>
/// </summary>
public sealed class LongestClassFirst : ITestCollectionOrderer
{
    private const int PostgresWeight = 10;

    // An estimated case costs this many seconds, so estimates and measurements share one scale.
    private const double SecondsPerEstimatedCase = 0.1;

    public IEnumerable<ITestCollection> OrderTestCollections(IEnumerable<ITestCollection> testCollections)
    {
        var assembly = typeof(LongestClassFirst).Assembly;
        var measured = MeasuredSeconds();
        return testCollections
            .Select((collection, index) => (collection, index, cost: Cost(assembly, collection, measured)))
            .OrderByDescending(c => c.cost)
            .ThenBy(c => c.index)
            .Select(c => c.collection)
            .ToList();
    }

    // A class's collection is named "Test collection for <full type name>", optionally followed by
    // " (id: …)". Anything that does not resolve to a type costs nothing and keeps its place.
    // Missing or unreadable is not an error: ordering is an optimisation, and every class runs
    // whatever it costs.
    private static Dictionary<string, double> MeasuredSeconds()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "test-timings.json");
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            return doc.RootElement.GetProperty("classes").EnumerateObject()
                .ToDictionary(p => p.Name, p => p.Value.GetDouble(), StringComparer.Ordinal);
        }
        catch (Exception e) when (e is IOException or JsonException or KeyNotFoundException or InvalidOperationException)
        {
            return [];
        }
    }

    private static double Cost(Assembly assembly, ITestCollection collection, Dictionary<string, double> measured)
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

        if (measured.TryGetValue(name, out var seconds))
        {
            return seconds;
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
        return cases * (postgres ? PostgresWeight : 1) * SecondsPerEstimatedCase;
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

using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// <see cref="BookingRefusals.CodeOf"/> is the ONE spelling of every booking refusal. These pin
/// that no refusal the service can return falls to <c>booking_failed</c>, and that the single
/// route's wire word is the mapping's word — so adding a <see cref="BookingResult"/> without a
/// word, or re-spelling one on one route, goes red here rather than on a member's screen.
/// </summary>
public sealed class BookingRefusalsTests
{
    /// <summary>Every refusal <see cref="BookingResult"/> declares — every nested type except <c>Ok</c>.</summary>
    public static TheoryData<string> Refusals()
    {
        var data = new TheoryData<string>();
        foreach (var type in RefusalTypes()) data.Add(type.Name);
        return data;
    }

    private static IEnumerable<Type> RefusalTypes()
    {
        return typeof(BookingResult).GetNestedTypes()
            .Where(t => t.IsSubclassOf(typeof(BookingResult)) && t != typeof(BookingResult.Ok))
            .OrderBy(t => t.Name);
    }

    /// <summary>An instance of a refusal type, built through its widest public constructor with neutral values.</summary>
    private static BookingResult Instance(string typeName)
    {
        var type = typeof(BookingResult).GetNestedType(typeName)!;
        var ctor = type.GetConstructors().OrderByDescending(c => c.GetParameters().Length).First();
        var args = ctor.GetParameters().Select(p => Neutral(p.ParameterType)).ToArray();
        return (BookingResult)ctor.Invoke(args);
    }

    private static object? Neutral(Type type)
    {
        if (type == typeof(string)) return "";
        if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(IReadOnlyList<>))
        {
            return Array.CreateInstance(type.GetGenericArguments()[0], 0);
        }
        return type.IsValueType ? Activator.CreateInstance(type) : null;
    }

    [Theory]
    [MemberData(nameof(Refusals))]
    public void Every_refusal_has_its_own_word_and_never_the_fallback(string typeName)
    {
        var code = BookingRefusals.CodeOf(Instance(typeName));

        Assert.NotEqual(BookingRefusals.Unmapped, code);
        Assert.False(string.IsNullOrWhiteSpace(code));
    }

    [Fact]
    public void No_two_refusals_share_a_word()
    {
        var codes = RefusalTypes().Select(t => BookingRefusals.CodeOf(Instance(t.Name))).ToList();
        Assert.Equal(codes.Count, codes.Distinct().Count());
    }

    /// <summary>
    /// The single route answers the mapping's word verbatim, with a real status — never the
    /// logged 500 an unmapped result gets.
    /// </summary>
    [Theory]
    [MemberData(nameof(Refusals))]
    public void The_single_route_answers_the_same_word_the_batches_do(string typeName)
    {
        var refusal = Instance(typeName);
        var result = BookingEndpoints.ToHttpResult(refusal, new DefaultHttpContext());

        Assert.IsNotType<ProblemHttpResult>(result);
        var status = Assert.IsAssignableFrom<IStatusCodeHttpResult>(result).StatusCode;
        Assert.InRange(status ?? 0, 400, 499);

        var value = Assert.IsAssignableFrom<IValueHttpResult>(result).Value;
        var error = JsonSerializer.SerializeToElement(value).GetProperty("error").GetString();
        Assert.Equal(BookingRefusals.CodeOf(refusal), error);
    }

    /// <summary>Review round 1 contract §9: a window refusal names the group(s) and the day in words.</summary>
    [Fact]
    public void A_window_refusal_names_the_group_and_the_day()
    {
        foreach (var refusal in new BookingResult[]
                 {
                     new BookingResult.NoBookableWindow(["Juniors", "League"], "Tuesday"),
                     new BookingResult.GroupWindow(["Juniors"], "Tuesday", [("17:00", "19:00")]),
                 })
        {
            var value = Assert.IsAssignableFrom<IValueHttpResult>(BookingEndpoints.ToHttpResult(refusal, new DefaultHttpContext())).Value;
            var body = JsonSerializer.SerializeToElement(value);
            Assert.StartsWith("Juniors", body.GetProperty("group_name").GetString());
            Assert.Equal("Tuesday", body.GetProperty("day").GetString());
        }
    }
}

/// <summary>
/// The same refused item, sent down all four booking paths — the single member route, the member
/// bulk book, the admin bulk book and the admin bulk quote — answers the same word on each.
/// </summary>
public sealed class BookingRefusalPathsHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public BookingRefusalPathsHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => _pg.SharedHost;

    [SkippableFact]
    public async Task A_refusal_reads_the_same_on_the_single_route_both_bulks_and_the_quote()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "refusalwords");
        var yesterday = new DateTimeOffset(DateTimeOffset.UtcNow.AddDays(-1).Date.AddHours(8), TimeSpan.Zero);
        var tomorrow = new DateTimeOffset(DateTimeOffset.UtcNow.AddDays(2).Date.AddHours(8), TimeSpan.Zero);

        var cases = new (Guid CourtId, DateTimeOffset StartsAt, string Expected)[]
        {
            (club.CourtId, yesterday, "past_time"),
            (Guid.NewGuid(), tomorrow, "court_not_found"),
        };

        var member = club.MemberClient(factory);
        var admin = club.AdminClient(factory);
        var items = cases.Select(c => new { courtId = c.CourtId, startsAt = c.StartsAt, sliceCount = 4 }).ToArray();

        var memberBulk = await Json(await member.PostAsJsonAsync("/api/v1/bookings/bulk",
            new { idempotencyKey = "rw_member", items }));
        var adminBulk = await Json(await admin.PostAsJsonAsync("/api/v1/admin/bookings/bulk",
            new { idempotencyKey = "rw_admin", onBehalf = new { userId = club.MemberUserId }, items }));
        var quote = await Json(await admin.PostAsJsonAsync("/api/v1/admin/bookings/bulk/quote",
            new { userId = club.MemberUserId, items }));

        for (var i = 0; i < cases.Length; i++)
        {
            var single = await member.PostAsJsonAsync("/api/v1/bookings/", items[i]);
            Assert.NotEqual(HttpStatusCode.OK, single.StatusCode);
            Assert.Equal(cases[i].Expected, (await Json(single)).GetProperty("error").GetString());

            Assert.Equal(cases[i].Expected, memberBulk.GetProperty("results")[i].GetProperty("reason").GetString());
            Assert.Equal(cases[i].Expected, adminBulk.GetProperty("results")[i].GetProperty("error").GetString());
            Assert.Equal(cases[i].Expected, quote.GetProperty("items")[i].GetProperty("reason").GetString());
        }
    }

    private static async Task<JsonElement> Json(HttpResponseMessage response)
        => await response.Content.ReadFromJsonAsync<JsonElement>();
}

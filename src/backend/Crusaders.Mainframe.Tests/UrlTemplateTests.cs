using System.Text.Json;
using Crusaders.Mainframe.Api.Webhooks;

namespace Crusaders.Mainframe.Tests;

public class UrlTemplateTests
{
    private static JsonElement Envelope(object obj)
    {
        var json = JsonSerializer.Serialize(obj);
        return JsonDocument.Parse(json).RootElement;
    }

    [Fact]
    public void Substitutes_top_level_and_data_keys()
    {
        var env = Envelope(new
        {
            id = "evt_1",
            type = "booking.lights_on",
            tenant_slug = "crusaders",
            data = new { court_number = 3, user_name = "Dean Martin" },
        });
        var r = UrlTemplate.Render("http://arduino.local/court/{court_number}/turn/on?evt={id}&tenant={tenant_slug}", env);
        Assert.True(r.Ok);
        Assert.Equal("http://arduino.local/court/3/turn/on?evt=evt_1&tenant=crusaders", r.Url);
    }

    [Fact]
    public void Url_encodes_substituted_values()
    {
        var env = Envelope(new { data = new { user_name = "Dean Martin" } });
        var r = UrlTemplate.Render("http://example/{user_name}", env);
        Assert.True(r.Ok);
        Assert.Equal("http://example/Dean%20Martin", r.Url);
    }

    [Fact]
    public void Reports_missing_variable()
    {
        var env = Envelope(new { data = new { court_number = 1 } });
        var r = UrlTemplate.Render("http://example/{user_id}", env);
        Assert.False(r.Ok);
        Assert.Equal("user_id", r.MissingVariable);
    }

    [Fact]
    public void Variables_lists_referenced_names_unique()
    {
        var vars = UrlTemplate.Variables("http://h/{court_number}/{user_id}/{court_number}");
        Assert.Equal(2, vars.Count);
        Assert.Contains("court_number", vars);
        Assert.Contains("user_id", vars);
    }

    /// <summary>
    /// Original review A2-16: the doc on <c>Flatten</c> promised <c>{event_id}</c> and the
    /// envelope's field is <c>id</c>, so a club that followed the comment got a delivery
    /// refused as a missing variable — which is a config error and deliberately not
    /// retryable, so their endpoint simply stopped. It is an alias now rather than a
    /// rename, because <c>id</c> is on the wire in every body delivered so far and in every
    /// signature computed over one.
    /// </summary>
    [Fact]
    public void Event_id_and_event_type_are_aliases_of_the_envelopes_id_and_type()
    {
        var env = Envelope(new { id = "evt_1", type = "booking.lights_on", data = new { court_number = 3 } });

        var r = UrlTemplate.Render("http://h/?evt={event_id}&same={id}&kind={event_type}", env);

        Assert.True(r.Ok, $"missing variable: {r.MissingVariable}");
        Assert.Equal("http://h/?evt=evt_1&same=evt_1&kind=booking.lights_on", r.Url);
    }

    /// <summary>
    /// docs/specs/webhooks.md lists five variables as "always present, regardless of event".
    /// All five must resolve from a bare envelope, or the documentation is again describing
    /// a system that refuses the delivery and does not retry it.
    /// </summary>
    [Fact]
    public void Every_variable_the_spec_calls_always_present_resolves()
    {
        var env = Envelope(new
        {
            id = "evt_1",
            type = "booking.lights_on",
            tenant_id = "11111111-1111-1111-1111-111111111111",
            tenant_slug = "crusaders",
            occurred_at = "2026-09-05T10:00:00+00:00",
            occurred_at_unix = 1788600000L,
            data = new { },
        });

        foreach (var name in new[] { "tenant_id", "tenant_slug", "event_id", "event_type", "occurred_at", "occurred_at_unix" })
        {
            var r = UrlTemplate.Render($"http://h/?v={{{name}}}", env);
            Assert.True(r.Ok, $"{name} did not resolve from a standard envelope");
        }
    }

    /// <summary>An event that carries its own <c>event_id</c> keeps it: the alias only fills a gap.</summary>
    [Fact]
    public void An_events_own_event_id_wins_over_the_alias()
    {
        var env = Envelope(new { id = "evt_1", data = new { event_id = "upstream_42" } });

        var r = UrlTemplate.Render("http://h/?evt={event_id}", env);

        Assert.True(r.Ok);
        Assert.Equal("http://h/?evt=upstream_42", r.Url);
    }

    /// <summary>
    /// The other half of the same stale comment: <c>actor</c> and <c>subject</c> are objects
    /// and are not flattened, so <c>{user_id}</c> resolves only from <c>data</c>. Not
    /// aliased, because two different user ids in one envelope have no single right answer —
    /// the promise was removed instead.
    /// </summary>
    [Fact]
    public void User_id_does_not_resolve_from_the_envelopes_actor_or_subject()
    {
        var env = Envelope(new
        {
            id = "evt_1",
            actor = new { user_id = "a", is_admin = true },
            subject = new { user_id = "b" },
            data = new { court_number = 3 },
        });

        var r = UrlTemplate.Render("http://h/?u={user_id}", env);

        Assert.False(r.Ok);
        Assert.Equal("user_id", r.MissingVariable);
    }
}

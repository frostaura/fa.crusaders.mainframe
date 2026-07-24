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
}

using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Crusaders.Mainframe.Tests;

public class HealthEndpointTests : IClassFixture<TestWebAppFactory>
{
    private readonly TestWebAppFactory _factory;

    public HealthEndpointTests(TestWebAppFactory factory) => _factory = factory;

    [Fact]
    public async Task Healthz_returns_ok_payload()
    {
        var client = _factory.CreateClient();
        var response = await client.GetAsync("/healthz");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var payload = await response.Content.ReadFromJsonAsync<HealthPayload>();
        Assert.NotNull(payload);
        Assert.Equal("ok", payload!.status);
        Assert.Equal("crusaders.mainframe", payload.service);
    }

    private sealed record HealthPayload(string status, string service, DateTimeOffset time);
}

using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Security.Discovery;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The last step of connecting a board: how the derived key actually reaches it.
///
/// <para>
/// The obvious design — the API POSTs the key to the address the board announced from —
/// is the one thing this must not do. That address arrived in an unauthenticated UDP
/// datagram from the club LAN, and dialling it is exactly what <c>OutboundAddressGuard</c>
/// was built to prevent three commits earlier. So the direction is inverted: the board
/// fetches, authenticating with the claim code it generated and is displaying, which has
/// never been on the wire.
/// </para>
/// </summary>
/// <summary>
/// A hand-rolled controllable clock. Microsoft.Extensions.TimeProvider.Testing would do
/// this too, and is not worth a NuGet reference for one advance() — the repo's
/// free-tier-first rule applies to test dependencies as much as to runtime ones.
/// </summary>
internal sealed class TestClock : TimeProvider
{
    private DateTimeOffset _now;
    public TestClock(DateTimeOffset now) => _now = now;
    public override DateTimeOffset GetUtcNow() => _now;
    public void Advance(TimeSpan by) => _now = _now.Add(by);
}

public class ProvisioningGrantTests
{
    private const string Mac = "5ccf7f1a2b3c";
    private const string Code = "K7RM4XPT";

    private static ProvisioningGrant Grant(DateTimeOffset expiresAt, string code = Code) => new()
    {
        Mac = Mac,
        ClaimCodeHash = ProvisioningGrants.HashCode(code),
        DeviceId = Guid.NewGuid(),
        TenantId = Guid.NewGuid(),
        TenantSlug = "crusaders",
        KeyVersion = 1,
        ExpiresAt = expiresAt,
    };

    [Fact]
    public void The_right_code_redeems_the_grant()
    {
        var grants = new ProvisioningGrants();
        grants.Issue(Grant(DateTimeOffset.UtcNow.AddMinutes(10)));

        Assert.NotNull(grants.Redeem(Mac, Code));
    }

    /// <summary>The code is typed off an LCD by a human, so case must not decide it.</summary>
    [Fact]
    public void The_code_is_case_insensitive()
    {
        var grants = new ProvisioningGrants();
        grants.Issue(Grant(DateTimeOffset.UtcNow.AddMinutes(10)));

        Assert.NotNull(grants.Redeem(Mac, "k7rm4xpt"));
    }

    [Fact]
    public void A_wrong_code_does_not_redeem()
    {
        var grants = new ProvisioningGrants();
        grants.Issue(Grant(DateTimeOffset.UtcNow.AddMinutes(10)));

        Assert.Null(grants.Redeem(Mac, "AAAAAAAA"));
    }

    /// <summary>
    /// A wrong guess burns the grant. Otherwise this is an oracle an attacker can hammer
    /// for as long as the window lasts — and the window is sized for a distracted human,
    /// not for the protocol.
    /// </summary>
    [Fact]
    public void A_wrong_guess_costs_the_attacker_the_grant()
    {
        var grants = new ProvisioningGrants();
        grants.Issue(Grant(DateTimeOffset.UtcNow.AddMinutes(10)));

        Assert.Null(grants.Redeem(Mac, "AAAAAAAA"));
        Assert.Null(grants.Redeem(Mac, Code));       // ...even though this one is right
    }

    [Fact]
    public void A_grant_is_single_use()
    {
        var grants = new ProvisioningGrants();
        grants.Issue(Grant(DateTimeOffset.UtcNow.AddMinutes(10)));

        Assert.NotNull(grants.Redeem(Mac, Code));
        Assert.Null(grants.Redeem(Mac, Code));
    }

    [Fact]
    public void An_expired_grant_does_not_redeem()
    {
        var clock = new TestClock(DateTimeOffset.UtcNow);
        var grants = new ProvisioningGrants(clock);
        grants.Issue(Grant(clock.GetUtcNow().Add(ProvisioningGrants.Lifetime)));

        clock.Advance(ProvisioningGrants.Lifetime + TimeSpan.FromSeconds(1));

        Assert.Null(grants.Redeem(Mac, Code));
        Assert.Equal(0, grants.Count);
    }

    [Fact]
    public void An_unknown_mac_does_not_redeem()
    {
        var grants = new ProvisioningGrants();
        grants.Issue(Grant(DateTimeOffset.UtcNow.AddMinutes(10)));

        Assert.Null(grants.Redeem("000000000000", Code));
    }

    /// <summary>
    /// No plaintext code at rest. A memory dump of a mid-claim API should not hand over
    /// the secret that authenticates a board.
    /// </summary>
    [Fact]
    public void The_grant_holds_a_hash_rather_than_the_code()
    {
        var grant = Grant(DateTimeOffset.UtcNow.AddMinutes(10));

        Assert.Equal(32, grant.ClaimCodeHash.Length);
        Assert.DoesNotContain(Code, Convert.ToHexString(grant.ClaimCodeHash), StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Grants are bounded, and at capacity the oldest goes rather than the newest being
    /// refused — unlike the announcer store. The asymmetry is deliberate and the reason
    /// is the threat model: every grant here came from an authenticated admin action, so
    /// refusing new ones would let whoever can spam claims lock out the admin standing at
    /// the cupboard. The announcer store faces unauthenticated UDP and makes the
    /// opposite choice.
    /// </summary>
    [Fact]
    public void Grants_are_bounded_and_evict_the_oldest()
    {
        var grants = new ProvisioningGrants();
        var now = DateTimeOffset.UtcNow;

        for (var i = 0; i < 200; i++)
        {
            grants.Issue(new ProvisioningGrant
            {
                Mac = $"aa00000000{i:x2}",
                ClaimCodeHash = ProvisioningGrants.HashCode(Code),
                DeviceId = Guid.NewGuid(),
                TenantId = Guid.NewGuid(),
                TenantSlug = "crusaders",
                KeyVersion = 1,
                ExpiresAt = now.AddMinutes(10).AddSeconds(i),
            });
        }

        Assert.InRange(grants.Count, 1, 64);

        // The most recent survived; the first did not.
        Assert.NotNull(grants.Redeem("aa000000" + "00c7", Code));
        Assert.Null(grants.Redeem("aa0000000000", Code));
    }
}

/// <summary>The provisioning endpoint over real HTTP, against the real schema.</summary>
[Collection(HttpTestCollection.Name)]
public sealed class ProvisioningHttpTests
{
    private readonly PostgresFixture _pg;

    public ProvisioningHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Path = "/api/v1/device/provision";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static ProvisioningGrant Seed(TestWebAppFactory factory, string mac, string code)
    {
        var grants = (ProvisioningGrants)factory.Services.GetService(typeof(ProvisioningGrants))!;
        var grant = new ProvisioningGrant
        {
            Mac = mac,
            ClaimCodeHash = ProvisioningGrants.HashCode(code),
            DeviceId = Guid.NewGuid(),
            TenantId = Guid.NewGuid(),
            TenantSlug = "crusaders",
            KeyVersion = 1,
            ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(10),
        };
        grants.Issue(grant);
        return grant;
    }

    [SkippableFact]
    public async Task A_board_with_the_right_code_collects_its_key()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var client = factory.CreateClient();
        var grant = Seed(factory, "5ccf7f1a2b3c", "K7RM4XPT");

        var response = await client.PostAsJsonAsync(Path, new { mac = "5ccf7f1a2b3c", claim_code = "K7RM4XPT" });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        Assert.Equal(grant.DeviceId, json.GetProperty("device_id").GetGuid());
        Assert.Equal("crusaders", json.GetProperty("tenant_slug").GetString());
        Assert.Equal(1, json.GetProperty("key_version").GetInt32());
        Assert.Equal(43, json.GetProperty("device_key").GetString()!.Length);   // 32 bytes base64url, unpadded
        Assert.False(string.IsNullOrWhiteSpace(json.GetProperty("api_base_url").GetString()));
    }

    /// <summary>
    /// The first clock seed a fresh board ever sees. The box has no RTC and cannot
    /// sign a request until it knows the time, so a provision response without the
    /// server's clock hands out a key the board can never use — it would deadlock
    /// on 401s until someone reprovisioned it (finding C1).
    /// </summary>
    [SkippableFact]
    public async Task Provision_response_carries_server_unix()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var client = factory.CreateClient();
        Seed(factory, "5ccf7f1a2b3c", "K7RM4XPT");

        var response = await client.PostAsJsonAsync(Path, new { mac = "5ccf7f1a2b3c", claim_code = "K7RM4XPT" });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        Assert.InRange(json.GetProperty("server_unix").GetInt64(), now - 60, now + 60);
        Assert.True(json.TryGetProperty("server_time", out _));
    }

    /// <summary>
    /// The endpoint is anonymous by necessity — a board collecting its first key has no
    /// credential to present. So it must not become an oracle for which boards are
    /// mid-claim: a wrong code, an unknown MAC and no grant at all look identical.
    /// </summary>
    [SkippableTheory]
    [InlineData("5ccf7f1a2b3c", "WRONGCOD")]
    [InlineData("000000000000", "K7RM4XPT")]
    [InlineData("000000000000", "WRONGCOD")]
    public async Task Every_refusal_looks_the_same(string mac, string code)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var client = factory.CreateClient();
        Seed(factory, "5ccf7f1a2b3c", "K7RM4XPT");

        var response = await client.PostAsJsonAsync(Path, new { mac, claim_code = code });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Contains("no_pending_claim", await response.Content.ReadAsStringAsync());
    }

    [SkippableFact]
    public async Task A_key_cannot_be_collected_twice()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var client = factory.CreateClient();
        Seed(factory, "5ccf7f1a2b3c", "K7RM4XPT");

        var first = await client.PostAsJsonAsync(Path, new { mac = "5ccf7f1a2b3c", claim_code = "K7RM4XPT" });
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);

        var second = await client.PostAsJsonAsync(Path, new { mac = "5ccf7f1a2b3c", claim_code = "K7RM4XPT" });
        Assert.Equal(HttpStatusCode.NotFound, second.StatusCode);
    }

    [SkippableFact]
    public async Task A_missing_field_is_a_bad_request_rather_than_a_lookup()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var client = factory.CreateClient();

        var response = await client.PostAsJsonAsync(Path, new { mac = "5ccf7f1a2b3c" });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    /// <summary>
    /// The key handed out here must be the same one the device auth scheme will verify
    /// against. If these two derivations ever disagree the board provisions successfully
    /// and then 401s on every heartbeat — with nothing to point at.
    /// </summary>
    [SkippableFact]
    public async Task The_collected_key_is_the_one_device_auth_will_verify()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var client = factory.CreateClient();
        var grant = Seed(factory, "5ccf7f1a2b3c", "K7RM4XPT");

        var response = await client.PostAsJsonAsync(Path, new { mac = "5ccf7f1a2b3c", claim_code = "K7RM4XPT" });
        var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;

        var deriver = (Crusaders.Mainframe.Api.Security.DeviceAuth.IDeviceKeyDeriver)
            factory.Services.GetService(typeof(Crusaders.Mainframe.Api.Security.DeviceAuth.IDeviceKeyDeriver))!;

        Assert.Equal(
            deriver.DeriveEncoded(grant.TenantId, grant.DeviceId, grant.KeyVersion),
            json.GetProperty("device_key").GetString());
    }
}

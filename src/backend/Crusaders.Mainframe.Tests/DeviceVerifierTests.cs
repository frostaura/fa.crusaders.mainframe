using System.Text;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The security decision itself, exercised without a web host.
///
/// <para>
/// The HTTP tests in <c>DeviceAuthHttpTests</c> prove the pipeline; these prove the
/// rules, and they run everywhere rather than only where Postgres is available. The
/// split exists because the verification logic was pulled out of the authentication
/// handler — a handler that owns its own EF queries can only be tested through a
/// server, which is why the equivalent logic on the JWT path has never been tested at
/// all.
/// </para>
/// </summary>
public class DeviceVerifierTests
{
    private static readonly byte[] EmptyBody = [];

    private static async Task<(TestHost Host, Device Device, byte[] Key)> ProvisionAsync(TestHost? existing = null)
    {
        var host = existing ?? await TestHost.CreateAsync();

        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var device = new Device
        {
            TenantId = host.Tenant.Id,
            DeviceCode = $"court-box-{Guid.NewGuid():N}"[..20],
            Name = "Court 1 box",
            CourtNumber = 1,
        };
        db.Devices.Add(device);
        await db.SaveChangesAsync();

        var keys = scope.ServiceProvider.GetRequiredService<IDeviceKeyDeriver>();
        return (host, device, keys.Derive(device.TenantId, device.Id, device.KeyVersion));
    }

    private static DeviceCredential Credential(
        Device device, byte[] key, long? unixSeconds = null, string? nonce = null,
        string method = "POST", string path = "/api/v1/device/heartbeat", byte[]? body = null,
        string? forceSignature = null)
    {
        var ts = unixSeconds ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var n = nonce ?? Guid.NewGuid().ToString("N");
        var b = body ?? EmptyBody;

        var signature = forceSignature
            ?? DeviceRequestSigner.Sign(key, DeviceRequestSigner.CanonicalString(method, path, ts, n, b));

        return new DeviceCredential(device.Id, ts, n, signature, method, path, b);
    }

    private static DeviceVerifier VerifierIn(IServiceScope scope) =>
        scope.ServiceProvider.GetRequiredService<DeviceVerifier>();

    [Fact]
    public async Task A_valid_credential_verifies()
    {
        var (host, device, key) = await ProvisionAsync();
        await using var _ = host;

        using var scope = host.NewScope();
        var result = await VerifierIn(scope).VerifyAsync(Credential(device, key));

        Assert.True(result.Succeeded);
        Assert.Equal(device.Id, result.Device!.Id);
        Assert.Equal(host.Tenant.Id, result.Tenant!.Id);
    }

    /// <summary>
    /// The reason this class exists at all. A verifier that authenticated but left the
    /// tenant unset would pass every other assertion in this file and still be broken.
    /// </summary>
    [Fact]
    public async Task Verification_sets_the_tenant_context()
    {
        var (host, device, key) = await ProvisionAsync();
        await using var _ = host;

        using var scope = host.NewScope();
        var tenantContext = scope.ServiceProvider
            .GetRequiredService<Crusaders.Mainframe.Api.Multitenancy.ITenantContext>();

        // Start from the empty tenant — the state a request arrives in before anything
        // has resolved it, and the state the courtside endpoints run their whole
        // lifetime in today.
        tenantContext.Set(Guid.Empty, string.Empty);

        var result = await VerifierIn(scope).VerifyAsync(Credential(device, key));

        Assert.True(result.Succeeded);
        Assert.Equal(host.Tenant.Id, tenantContext.TenantId);
        Assert.Equal(host.Tenant.Slug, tenantContext.TenantSlug);
    }

    [Fact]
    public async Task A_wrong_signature_is_refused()
    {
        var (host, device, key) = await ProvisionAsync();
        await using var _ = host;

        using var scope = host.NewScope();
        var result = await VerifierIn(scope).VerifyAsync(
            Credential(device, key, forceSignature: new string('0', 64)));

        Assert.False(result.Succeeded);
    }

    /// <summary>The body is hashed into the signed string, so changing it invalidates.</summary>
    [Fact]
    public async Task A_credential_signed_over_a_different_body_is_refused()
    {
        var (host, device, key) = await ProvisionAsync();
        await using var _ = host;

        var honest = Credential(device, key, body: "{}"u8.ToArray());
        var tampered = honest with { Body = Encoding.UTF8.GetBytes("""{"court":4}""") };

        using var scope = host.NewScope();
        Assert.False((await VerifierIn(scope).VerifyAsync(tampered)).Succeeded);
    }

    [Theory]
    [InlineData(-3600)]
    [InlineData(3600)]
    [InlineData(-121)]
    [InlineData(121)]
    public async Task A_clock_outside_the_skew_window_is_refused(int offsetSeconds)
    {
        var (host, device, key) = await ProvisionAsync();
        await using var _ = host;

        var ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + offsetSeconds;

        using var scope = host.NewScope();
        Assert.False((await VerifierIn(scope).VerifyAsync(Credential(device, key, unixSeconds: ts))).Succeeded);
    }

    [Theory]
    [InlineData(-60)]
    [InlineData(60)]
    [InlineData(0)]
    public async Task A_clock_inside_the_skew_window_is_accepted(int offsetSeconds)
    {
        var (host, device, key) = await ProvisionAsync();
        await using var _ = host;

        var ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + offsetSeconds;

        using var scope = host.NewScope();
        Assert.True((await VerifierIn(scope).VerifyAsync(Credential(device, key, unixSeconds: ts))).Succeeded);
    }

    [Fact]
    public async Task A_replayed_nonce_is_refused()
    {
        var (host, device, key) = await ProvisionAsync();
        await using var _ = host;

        var credential = Credential(device, key);

        using var scope = host.NewScope();
        var verifier = VerifierIn(scope);

        Assert.True((await verifier.VerifyAsync(credential)).Succeeded);
        Assert.False((await verifier.VerifyAsync(credential)).Succeeded);
    }

    /// <summary>
    /// A nonce is burned only on success. Otherwise a device whose clock was briefly
    /// wrong would have spent the nonce it is about to retry with, and every retry
    /// would fail for a second, different reason.
    /// </summary>
    [Fact]
    public async Task A_nonce_from_a_failed_attempt_can_be_reused()
    {
        var (host, device, key) = await ProvisionAsync();
        await using var _ = host;

        var nonce = Guid.NewGuid().ToString("N");

        using var scope = host.NewScope();
        var verifier = VerifierIn(scope);

        var badSignature = Credential(device, key, nonce: nonce, forceSignature: new string('0', 64));
        Assert.False((await verifier.VerifyAsync(badSignature)).Succeeded);

        Assert.True((await verifier.VerifyAsync(Credential(device, key, nonce: nonce))).Succeeded);
    }

    [Fact]
    public async Task A_disabled_device_is_refused()
    {
        var (host, device, key) = await ProvisionAsync();
        await using var _ = host;

        using (var scope = host.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.Devices.SingleAsync(d => d.Id == device.Id);
            row.Enabled = false;
            await db.SaveChangesAsync();
        }

        using (var scope = host.NewScope())
        {
            Assert.False((await VerifierIn(scope).VerifyAsync(Credential(device, key))).Succeeded);
        }
    }

    [Fact]
    public async Task A_revoked_device_is_refused()
    {
        var (host, device, key) = await ProvisionAsync();
        await using var _ = host;

        using (var scope = host.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.Devices.SingleAsync(d => d.Id == device.Id);
            row.RevokedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync();
        }

        using (var scope = host.NewScope())
        {
            Assert.False((await VerifierIn(scope).VerifyAsync(Credential(device, key))).Succeeded);
        }
    }

    [Fact]
    public async Task An_unknown_device_is_refused()
    {
        var (host, device, key) = await ProvisionAsync();
        await using var _ = host;

        var ghost = Credential(device, key) with { DeviceId = Guid.NewGuid() };

        using var scope = host.NewScope();
        Assert.False((await VerifierIn(scope).VerifyAsync(ghost)).Succeeded);
    }

    /// <summary>
    /// A method or path swap must invalidate: otherwise a captured heartbeat signature
    /// is a signature for whatever else the device surface grows later.
    /// </summary>
    [Theory]
    [InlineData("GET", "/api/v1/device/heartbeat")]
    [InlineData("POST", "/api/v1/device/lights/on")]
    [InlineData("POST", "/api/v1/device/heartbeat?tenant=other")]
    public async Task A_signature_does_not_carry_to_another_request(string method, string path)
    {
        var (host, device, key) = await ProvisionAsync();
        await using var _ = host;

        var honest = Credential(device, key);
        var elsewhere = honest with { Method = method, PathAndQuery = path };

        using var scope = host.NewScope();
        Assert.False((await VerifierIn(scope).VerifyAsync(elsewhere)).Succeeded);
    }
}

/// <summary>
/// The admin registry operations, tested directly. Extracting them from the endpoint
/// lambdas is what made this possible; before, the only way to assert that revocation
/// writes an audit row was to drive it over HTTP.
/// </summary>
public class DeviceRegistryServiceTests
{
    private static RegisterDeviceCommand CourtBox(string code = "court-box-1") =>
        new(code, "Court 1 box", DeviceKind.CourtBox, DeviceHardware.Esp8266, 1, null);

    [Fact]
    public async Task Registration_returns_a_key_and_stores_no_secret()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();

        var registered = await scope.ServiceProvider.GetRequiredService<DeviceRegistryService>()
            .RegisterAsync(CourtBox(), host.AdminUser.Id, default);

        Assert.False(string.IsNullOrWhiteSpace(registered.DeviceKey));
        Assert.Equal(1, registered.Device.KeyVersion);

        // The key must not be recoverable from the row — there is nowhere for it to be.
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var stored = await db.Devices.SingleAsync(d => d.Id == registered.Device.Id);
        var serialised = System.Text.Json.JsonSerializer.Serialize(stored);
        Assert.DoesNotContain(registered.DeviceKey, serialised, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Rotation_bumps_the_version_and_yields_a_different_key()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var devices = scope.ServiceProvider.GetRequiredService<DeviceRegistryService>();

        var registered = await devices.RegisterAsync(CourtBox(), host.AdminUser.Id, default);
        var rotated = await devices.RotateKeyAsync(registered.Device, host.AdminUser.Id, default);

        Assert.Equal(2, rotated.Device.KeyVersion);
        Assert.NotEqual(registered.DeviceKey, rotated.DeviceKey);
    }

    [Fact]
    public async Task Revocation_disables_the_device()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var devices = scope.ServiceProvider.GetRequiredService<DeviceRegistryService>();

        var registered = await devices.RegisterAsync(CourtBox(), host.AdminUser.Id, default);
        var revoked = await devices.RevokeAsync(registered.Device, host.AdminUser.Id, default);

        Assert.NotNull(revoked.RevokedAt);
        Assert.False(revoked.Enabled);
        Assert.False(revoked.IsActive);
    }

    /// <summary>
    /// "Admins act on behalf of users" is a stated invariant. A device is not a user,
    /// but the actor half still has to be recorded — a relay in a club is not something
    /// that should be revocable without a name attached.
    /// </summary>
    [Theory]
    [InlineData("register")]
    [InlineData("rotate")]
    [InlineData("update")]
    [InlineData("revoke")]
    public async Task Every_mutation_writes_an_audit_row_naming_the_actor(string operation)
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var devices = scope.ServiceProvider.GetRequiredService<DeviceRegistryService>();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var registered = await devices.RegisterAsync(CourtBox(), host.AdminUser.Id, default);

        var expected = operation switch
        {
            "register" => "device.registered",
            "rotate" => "device.key_rotated",
            "update" => "device.updated",
            _ => "device.revoked",
        };

        switch (operation)
        {
            case "rotate":
                await devices.RotateKeyAsync(registered.Device, host.AdminUser.Id, default);
                break;
            case "update":
                await devices.UpdateAsync(registered.Device, new UpdateDeviceCommand("Renamed", null, null, null, null),
                    host.AdminUser.Id, default);
                break;
            case "revoke":
                await devices.RevokeAsync(registered.Device, host.AdminUser.Id, default);
                break;
        }

        var audit = await db.AuditLogs.Where(a => a.Action == expected).ToListAsync();

        Assert.NotEmpty(audit);
        Assert.All(audit, a =>
        {
            Assert.Equal(host.AdminUser.Id, a.ActorUserId);
            Assert.Equal(host.Tenant.Id, a.TenantId);
            Assert.Contains(registered.Device.Id.ToString(), a.DetailsJson);
        });
    }

    [Fact]
    public async Task A_taken_device_code_is_reported_as_taken()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var devices = scope.ServiceProvider.GetRequiredService<DeviceRegistryService>();

        Assert.False(await devices.DeviceCodeTakenAsync("court-box-1", default));
        await devices.RegisterAsync(CourtBox(), host.AdminUser.Id, default);
        Assert.True(await devices.DeviceCodeTakenAsync("court-box-1", default));
    }
}

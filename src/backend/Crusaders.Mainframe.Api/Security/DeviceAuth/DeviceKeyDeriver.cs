using System.Security.Cryptography;
using System.Text;

namespace Crusaders.Mainframe.Api.Security.DeviceAuth;

/// <summary>
/// Derives a per-device signing key from a single master secret.
///
/// <para>
/// Nothing per-device is stored. The key is a pure function of the master KEK, the
/// tenant, the device id and its key version, so there is no credential in the
/// database to leak and rotation is a version bump rather than a schema write.
/// </para>
///
/// <para>
/// The alternative considered and rejected was storing a random secret per device in
/// <c>tenant_settings</c>. That store holds its contents in plaintext today — its own
/// doc comment concedes the encryption was deferred — so putting a credential that
/// authorises relay control into it would have been a downgrade, not a feature.
/// </para>
/// </summary>
public interface IDeviceKeyDeriver
{
    byte[] Derive(Guid tenantId, Guid deviceId, int keyVersion);

    /// <summary>The key as the device carries it: base64url, safe to paste into a header or a secrets.h.</summary>
    string DeriveEncoded(Guid tenantId, Guid deviceId, int keyVersion);
}

public sealed class DeviceKeyDeriver : IDeviceKeyDeriver
{
    private readonly byte[] _masterKey;

    public DeviceKeyDeriver(IConfiguration config)
    {
        // Flat env-var name first: docker-compose sets single-underscore names, and
        // only a handful of them bind through the nested-key form.
        var master = config["DEVICE_MASTER_KEY"]
                     ?? config["Devices:MasterKey"]
                     ?? throw new InvalidOperationException(
                         "DEVICE_MASTER_KEY is not configured. Device authentication cannot be derived without it; " +
                         "generate 32 random bytes and set it in the environment.");

        _masterKey = Encoding.UTF8.GetBytes(master);

        if (_masterKey.Length < 32)
        {
            throw new InvalidOperationException(
                "DEVICE_MASTER_KEY must be at least 32 bytes. It is the root of every device credential in the deployment.");
        }
    }

    public byte[] Derive(Guid tenantId, Guid deviceId, int keyVersion)
    {
        // HKDF: tenant as salt so two tenants can never derive the same key from the
        // same device id, and the version in the info string so a bump invalidates.
        var salt = tenantId.ToByteArray();
        var info = Encoding.UTF8.GetBytes($"crusaders-device:{deviceId:D}:v{keyVersion}");

        return HKDF.DeriveKey(HashAlgorithmName.SHA256, _masterKey, outputLength: 32, salt, info);
    }

    public string DeriveEncoded(Guid tenantId, Guid deviceId, int keyVersion)
        => Base64UrlEncode(Derive(tenantId, deviceId, keyVersion));

    internal static string Base64UrlEncode(byte[] bytes)
        => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

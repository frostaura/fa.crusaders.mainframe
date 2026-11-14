using System.Security.Cryptography;
using System.Text;
using Crusaders.Mainframe.Api.Security;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Encrypts the club's WiFi passwords at rest (device-api.md §8: "write-only, encrypted at rest").
/// AES-256-GCM under a key derived by HKDF-SHA256 from the deployment's member-code master key,
/// with its own label, so no new secret has to be configured, backed up or rotated for it and the
/// derived key is useless for anything else. The stored text is
/// <c>v1.&lt;base64 nonce‖ciphertext‖tag&gt;</c>; the tenant id is bound in as associated data, so
/// a row copied into another club's network does not decrypt.
/// </summary>
public sealed class DeviceNetworkCipher
{
    private const string Prefix = "v1.";
    private static readonly byte[] Info = Encoding.ASCII.GetBytes("crusaders/device-network-psk/v1");
    private readonly byte[] _key;

    public DeviceNetworkCipher(MemberCodeMasterKey master)
    {
        _key = HKDF.DeriveKey(HashAlgorithmName.SHA256, master.Bytes, 32, salt: [], info: Info);
    }

    /// <summary>The stored form of <paramref name="psk"/>, bound to <paramref name="tenantId"/>.</summary>
    public string Protect(string psk, Guid tenantId)
    {
        var plain = Encoding.UTF8.GetBytes(psk);
        var nonce = RandomNumberGenerator.GetBytes(AesGcm.NonceByteSizes.MaxSize);
        var cipher = new byte[plain.Length];
        var tag = new byte[AesGcm.TagByteSizes.MaxSize];
        using var aes = new AesGcm(_key, tag.Length);
        aes.Encrypt(nonce, plain, cipher, tag, tenantId.ToByteArray());
        return Prefix + Convert.ToBase64String([.. nonce, .. cipher, .. tag]);
    }

    /// <summary>The password, or null when the stored text is not one this key protected for this club.</summary>
    public string? Unprotect(string? stored, Guid tenantId)
    {
        if (stored is null || !stored.StartsWith(Prefix, StringComparison.Ordinal)) return null;
        byte[] all;
        try
        {
            all = Convert.FromBase64String(stored[Prefix.Length..]);
        }
        catch (FormatException)
        {
            return null;
        }

        var nonceSize = AesGcm.NonceByteSizes.MaxSize;
        var tagSize = AesGcm.TagByteSizes.MaxSize;
        if (all.Length < nonceSize + tagSize) return null;
        var nonce = all.AsSpan(0, nonceSize);
        var cipher = all.AsSpan(nonceSize, all.Length - nonceSize - tagSize);
        var tag = all.AsSpan(all.Length - tagSize);
        var plain = new byte[cipher.Length];
        try
        {
            using var aes = new AesGcm(_key, tagSize);
            aes.Decrypt(nonce, cipher, tag, plain, tenantId.ToByteArray());
        }
        catch (CryptographicException)
        {
            return null;
        }
        return Encoding.UTF8.GetString(plain);
    }
}

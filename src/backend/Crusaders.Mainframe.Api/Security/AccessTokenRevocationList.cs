using System.Collections.Concurrent;

namespace Crusaders.Mainframe.Api.Security;

/// <summary>
/// The set of access tokens that have been signed out, keyed by their <c>jti</c>.
/// </summary>
/// <remarks>
/// <para>
/// A JWT is a bearer credential: whoever holds it is the member until it expires. Sign-out was
/// therefore a lie — the client deleted its copy and the token stayed valid for the rest of its
/// fifteen minutes, so a second tab kept working and anything that had captured the token
/// outlived the sign-out entirely. "Sign out" has to mean the credential stops working, not
/// that one browser stopped presenting it.
/// </para>
/// <para>
/// Entries expire with the token they name, so the list is bounded by the number of sign-outs
/// inside one token lifetime and prunes itself. It is checked in-process on every request, which
/// is why it lives in memory rather than behind a database round trip; the durable copy in
/// <c>auth_tokens</c> is what survives a restart, and <see cref="Seed"/> is how it comes back.
/// </para>
/// <para>
/// One deployment shape is out of scope by construction: two API replicas would each hold their
/// own list, so a sign-out on one would not reach the other. Every shipped compose file runs a
/// single API container. A replica set needs this moved behind a shared store, and that is a
/// change to make deliberately rather than to assume.
/// </para>
/// </remarks>
public sealed class AccessTokenRevocationList
{
    private readonly ConcurrentDictionary<string, DateTimeOffset> _revoked = new(StringComparer.Ordinal);
    private readonly TimeProvider _clock;

    public AccessTokenRevocationList(TimeProvider? clock = null) => _clock = clock ?? TimeProvider.System;

    /// <summary>
    /// Marks one token as signed out until <paramref name="expiresAt"/>, when it dies anyway.
    /// </summary>
    /// <remarks>
    /// Keyed by <see cref="TokenHashing.Hash"/> of the jti rather than by the jti itself, so the
    /// in-memory key and the <c>auth_tokens.TokenHash</c> column are the same string. That is what
    /// lets <see cref="SeedHashed"/> refill this from storage after a restart without a second
    /// representation to keep in step.
    /// </remarks>
    public void Revoke(string jti, DateTimeOffset expiresAt)
    {
        if (string.IsNullOrWhiteSpace(jti)) return;
        SeedHashed(TokenHashing.Hash(jti), expiresAt);
    }

    /// <summary>Re-arms a revocation read back from storage, which holds the hash and not the jti.</summary>
    public void SeedHashed(string jtiHash, DateTimeOffset expiresAt)
    {
        if (string.IsNullOrWhiteSpace(jtiHash)) return;
        _revoked[jtiHash] = expiresAt;
        Prune();
    }

    /// <summary>True while the named token is signed out and has not yet expired on its own.</summary>
    public bool IsRevoked(string jti)
    {
        if (string.IsNullOrWhiteSpace(jti)) return false;
        if (_revoked.IsEmpty) return false;
        var key = TokenHashing.Hash(jti);
        if (!_revoked.TryGetValue(key, out var until)) return false;
        if (until > _clock.GetUtcNow()) return true;
        _revoked.TryRemove(key, out _);
        return false;
    }

    /// <summary>How many live revocations are held — for the tests and for diagnostics.</summary>
    public int Count => _revoked.Count;

    private void Prune()
    {
        var now = _clock.GetUtcNow();
        foreach (var (jti, until) in _revoked)
        {
            if (until <= now) _revoked.TryRemove(jti, out _);
        }
    }
}

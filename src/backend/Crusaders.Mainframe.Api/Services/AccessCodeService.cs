using System.Security.Cryptography;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>What a code resolved to. <see cref="BookingId"/> is set only for a booking-activation code.</summary>
public sealed record ResolvedAccessCode(AccessCodePurpose Purpose, Guid UserId, Guid? BookingId);

/// <summary>
/// Mints and resolves <see cref="AccessCode"/>s. See that type for why they exist.
///
/// <para>
/// Every read here is tenant-filtered by the context's global query filter, and that is
/// the isolation: a code minted at one club resolves to nothing at another, structurally,
/// rather than by a claim the caller has to remember to compare.
/// </para>
/// </summary>
public sealed class AccessCodeService
{
    /// <summary>Crockford base32: digits and upper-case letters without I, L, O and U.</summary>
    public const string Alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;

    public AccessCodeService(MainframeDbContext db, ITenantContext tenant)
    { _db = db; _tenant = tenant; }

    /// <summary>A fresh code: <see cref="AccessCode.Length"/> characters from <see cref="Alphabet"/>, CSPRNG-chosen.</summary>
    public static string NewCode() => RandomNumberGenerator.GetString(Alphabet, AccessCode.Length);

    /// <summary>
    /// The booking's code, added to the context but <b>not saved</b> — the caller owns the
    /// unit of work. This is the form <c>BookingService.CommitAsync</c> uses, so the
    /// booking row and its code flush in the same <c>SaveChanges</c> as the charge: a
    /// booking that exists without its code is a member who paid and cannot get in.
    ///
    /// <para>
    /// Idempotent. A live code already on this booking — in the database or already
    /// staged on this context — is returned rather than duplicated.
    /// </para>
    /// </summary>
    public async Task<AccessCode> StageForBookingAsync(Booking booking, TimeSpan grace, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;

        var staged = _db.ChangeTracker.Entries<AccessCode>()
            .Select(e => e.Entity)
            .FirstOrDefault(c => c.BookingId == booking.Id && c.IsLiveAt(now));
        if (staged is not null) return staged;

        var existing = await _db.AccessCodes
            .Where(c => c.BookingId == booking.Id && c.ExpiresAt > now)
            .OrderByDescending(c => c.ExpiresAt)
            .FirstOrDefaultAsync(ct);
        if (existing is not null) return existing;

        var row = new AccessCode
        {
            TenantId = _tenant.TenantId,
            Code = NewCode(),
            Purpose = AccessCodePurpose.BookingActivation,
            UserId = booking.UserId ?? booking.BookedByUserId ?? throw new InvalidOperationException("A booking without a user cannot carry an access code."),
            BookingId = booking.Id,
            ExpiresAt = booking.EndsAt.Add(grace),
        };
        _db.AccessCodes.Add(row);
        return row;
    }

    /// <summary>
    /// The booking's code, saved. Idempotent on an existing live code. A unique
    /// violation (SQLSTATE 23505) is retried once: if it was the per-booking index, two
    /// callers raced and the retry's lookup now finds the winner's row; if it was the
    /// per-tenant code index — a sixty-bit coincidence — the retry mints a fresh code.
    /// A second violation is not a coincidence and is allowed to surface.
    /// </summary>
    public async Task<AccessCode> MintForBookingAsync(Booking booking, TimeSpan grace, CancellationToken ct)
    {
        for (var attempt = 0; ; attempt++)
        {
            var row = await StageForBookingAsync(booking, grace, ct);
            if (_db.Entry(row).State != EntityState.Added) return row;

            try
            {
                await _db.SaveChangesAsync(ct);
                return row;
            }
            catch (DbUpdateException ex) when (IsUniqueViolation(ex) && attempt == 0)
            {
                _db.Entry(row).State = EntityState.Detached;
            }
        }
    }

    /// <summary>
    /// A member-ident code for this user. An unexpired one is reused — the PWA polls
    /// this, and a fresh row per poll would be a table of confetti — else one is minted
    /// with <paramref name="lifetime"/> from now.
    /// </summary>
    public async Task<AccessCode> MintIdentAsync(Guid userId, TimeSpan lifetime, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;

        var existing = await _db.AccessCodes
            .Where(c => c.UserId == userId && c.Purpose == AccessCodePurpose.MemberIdent && c.ExpiresAt > now)
            .OrderByDescending(c => c.ExpiresAt)
            .FirstOrDefaultAsync(ct);
        if (existing is not null) return existing;

        for (var attempt = 0; ; attempt++)
        {
            var row = new AccessCode
            {
                TenantId = _tenant.TenantId,
                Code = NewCode(),
                Purpose = AccessCodePurpose.MemberIdent,
                UserId = userId,
                BookingId = null,
                ExpiresAt = now.Add(lifetime),
            };
            _db.AccessCodes.Add(row);

            try
            {
                await _db.SaveChangesAsync(ct);
                return row;
            }
            catch (DbUpdateException ex) when (IsUniqueViolation(ex) && attempt == 0)
            {
                _db.Entry(row).State = EntityState.Detached;
            }
        }
    }

    /// <summary>
    /// What a presented code identifies, or null. Null covers every failure — unknown,
    /// expired, another club's — on purpose: telling them apart at a court box turns it
    /// into an oracle for which codes are real.
    /// </summary>
    public Task<ResolvedAccessCode?> ResolveAsync(string? code, CancellationToken ct)
        => ResolveAsync(code, DateTimeOffset.UtcNow, ct);

    /// <summary>
    /// The same question asked of a moment other than now. A court box decides scans
    /// offline and uploads them later; a code that was live when the member presented it
    /// and has since expired identified them then, and judging it by the upload clock
    /// turns a member who played into a stranger the moment the link took too long.
    /// </summary>
    public async Task<ResolvedAccessCode?> ResolveAsync(string? code, DateTimeOffset at, CancellationToken ct)
    {
        var normalised = Normalise(code);
        if (normalised is null) return null;

        var row = await _db.AccessCodes.AsNoTracking().FirstOrDefaultAsync(c => c.Code == normalised, ct);
        if (row is null || !row.IsLiveAt(at)) return null;

        return new ResolvedAccessCode(row.Purpose, row.UserId, row.BookingId);
    }

    /// <summary>
    /// Upper-cased and trimmed, or null if it could not be a code at all. A scanner that
    /// emits lower case, or a desk that types it, must not be refused for the case.
    /// </summary>
    private static string? Normalise(string? code)
    {
        if (string.IsNullOrWhiteSpace(code)) return null;
        var text = code.Trim().ToUpperInvariant();
        if (text.Length != AccessCode.Length) return null;
        foreach (var ch in text)
        {
            if (Alphabet.IndexOf(ch) < 0) return null;
        }
        return text;
    }

    private static bool IsUniqueViolation(DbUpdateException ex) =>
        ex.InnerException is Npgsql.PostgresException pg && pg.SqlState == "23505";
}

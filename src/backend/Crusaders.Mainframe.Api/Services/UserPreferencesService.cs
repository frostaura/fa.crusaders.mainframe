using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Reads and writes one person's <see cref="UserPreferences"/>, creating the row on the first
/// write and never on a read.
///
/// <para>
/// <b>Reads never write.</b> The profile load runs on every page of the app; a lazily-inserting
/// read would put an INSERT on the hottest path in the product for a row holding nothing but
/// defaults. No row answers the defaults, and the first real change creates it.
/// </para>
///
/// <para>
/// <b>Every write is tenant-checked against <c>users</c>, not only filtered.</b> The row's
/// tenant comes from the request's own context, so a write can never land in another club — but
/// a token for a user id that is not a member of the resolved tenant would otherwise create a
/// preferences row for a person this club has never heard of. The existence check against the
/// tenant-filtered user set is what makes that a 404 instead.
/// </para>
/// </summary>
public sealed class UserPreferencesService
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;

    public UserPreferencesService(MainframeDbContext db, ITenantContext tenant)
    {
        _db = db; _tenant = tenant;
    }

    /// <summary>This person's preferences, or the defaults when they have never changed one.</summary>
    public async Task<UserPreferencesView> GetAsync(Guid userId, CancellationToken ct)
    {
        var row = await _db.UserPreferences.AsNoTracking().FirstOrDefaultAsync(p => p.UserId == userId, ct);
        return UserPreferencesView.From(row);
    }

    /// <summary>
    /// Applies <paramref name="change"/> to this person's row, creating it if need be, and
    /// answers the result — or null when the person is not a user of this club.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>One retry, on a unique violation only.</b> Two first-ever toggles from two tabs both
    /// find no row and both insert; the unique <c>(TenantId, UserId)</c> index refuses the
    /// second, and replaying it against the row the first created is exactly what the member
    /// meant. A second failure is not a race and is let out.
    /// </para>
    /// <para>
    /// EF writes only the columns a change touched, so two concurrent writes of DIFFERENT
    /// fields both land; there is no whole-row last-writer-wins to lose one of them.
    /// </para>
    /// </remarks>
    public async Task<UserPreferencesView?> UpdateAsync(Guid userId, Action<UserPreferences> change, CancellationToken ct)
    {
        for (var attempt = 0; ; attempt++)
        {
            var row = await _db.UserPreferences.FirstOrDefaultAsync(p => p.UserId == userId, ct);
            if (row is null)
            {
                if (!await _db.Users.AnyAsync(u => u.Id == userId, ct)) return null;
                row = new UserPreferences { TenantId = _tenant.TenantId, UserId = userId };
                _db.UserPreferences.Add(row);
            }

            change(row);
            // Storable: the stamp is answered in this response AND re-read on the next load,
            // which is exactly the case gotchas-postgres-offsets.md says moves by a tick.
            row.UpdatedAt = StorableTime.UtcNow;

            try
            {
                await _db.SaveChangesAsync(ct);
                return UserPreferencesView.From(row);
            }
            catch (DbUpdateException ex) when (attempt == 0 && IsUniqueViolation(ex))
            {
                _db.ChangeTracker.Clear();
            }
        }
    }

    private static bool IsUniqueViolation(DbUpdateException ex)
    {
        return ex.InnerException is Npgsql.PostgresException pg && pg.SqlState == "23505";
    }
}

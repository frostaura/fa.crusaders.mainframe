using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// What a seat act's failed save means (R18 J18-2 / J18-4). Two kinds of loss look alike from the
/// outside and must be told apart:
///
/// <list type="bullet">
/// <item><b>A seat or a member really was taken</b> — the partial unique indexes on
/// <c>booking_participants</c> refused a second live seat on one number, or one member twice.
/// That, and only that, is <c>seat_taken</c>.</item>
/// <item><b>Somebody else decided first</b> — the seat's version moved, or the twin of this very act
/// already wrote the same notice: an inbox line or an outbox row whose dedupe key is unique per club
/// (<c>member_notifications</c>, <c>admin_notifications</c>). A dedupe key colliding is "already
/// said", never a fault. The caller re-reads the seat and answers from what the winner left.</item>
/// </list>
/// </summary>
internal static class SeatRaces
{
    private const string UniqueViolation = "23505";
    private const string SeatsTable = "booking_participants";

    /// <summary>A second live seat on one number, or one member twice on one booking.</summary>
    public static bool IsSeatTaken(DbUpdateException ex)
    {
        return ex.InnerException is Npgsql.PostgresException { SqlState: UniqueViolation, TableName: SeatsTable };
    }

    /// <summary>Anything else a concurrent writer caused: a version miss, or a dedupe key its twin wrote first.</summary>
    public static bool IsLostRace(DbUpdateException ex)
    {
        if (ex is DbUpdateConcurrencyException) return true;
        return ex.InnerException is Npgsql.PostgresException { SqlState: UniqueViolation } && !IsSeatTaken(ex);
    }
}

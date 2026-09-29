namespace Crusaders.Mainframe.Api.Persistence;

/// <summary>
/// The SQL that freezes <c>bookings.ShareDeadlineAt</c> for bookings that already have players
/// (migration <c>AddBookingShareDeadline</c>). Kept here, not inline in the migration, so a test
/// can run the very statement the migration ran and hold it to the C# reader
/// (<c>TenantSettingsAccessor</c> + <c>PlayerSettings.ShareLapseHours</c>) value for value.
///
/// <para>
/// <b>It reads the setting as <c>TryInt</c> does</b>: a JSON NUMBER whose text is an integer in
/// Int32 range (the stored jsonb text, which is what the app parses too), else 48; then the 1–168
/// clamp. A JSON string such as <c>"100"</c> is not a number to the reader, and a ten-digit value
/// is an int only inside Int32 range — the first version got both wrong (review round 2, L1).
/// </para>
/// </summary>
public static class ShareDeadlineBackfill
{
    /// <param name="extraPredicate">An extra <c>AND …</c> on <c>b</c> — a test confines it to its own booking.</param>
    public static string Sql(string extraPredicate = "") => $$"""
        UPDATE bookings AS b
        SET "ShareDeadlineAt" = b."StartsAt"
            + make_interval(mins => b."SliceMinutes" * b."SliceCount")
            + make_interval(hours => LEAST(168, GREATEST(1, COALESCE(
                (SELECT CASE WHEN jsonb_typeof(ts."SettingsJson" -> 'share_lapse_hours') = 'number'
                                  AND (ts."SettingsJson" ->> 'share_lapse_hours') ~ '^-?[0-9]{1,10}$'
                             THEN CASE WHEN (ts."SettingsJson" ->> 'share_lapse_hours')::bigint BETWEEN -2147483648 AND 2147483647
                                       THEN (ts."SettingsJson" ->> 'share_lapse_hours')::int END
                        END
                 FROM tenant_settings AS ts WHERE ts."TenantId" = b."TenantId"),
                48))))
        WHERE b."ShareDeadlineAt" IS NULL
          AND EXISTS (SELECT 1 FROM booking_participants AS p WHERE p."BookingId" = b."Id")
          {{extraPredicate}};
        """;
}

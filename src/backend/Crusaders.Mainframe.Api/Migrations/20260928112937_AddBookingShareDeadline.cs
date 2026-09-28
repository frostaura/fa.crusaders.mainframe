using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddBookingShareDeadline : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "ShareDeadlineAt",
                table: "bookings",
                type: "timestamp with time zone",
                nullable: true);

            // D11 review H2: every booking that already has players gets its deadline frozen at
            // what the club's setting gives it today — the SOLD end (StartsAt + slices) plus
            // share_lapse_hours, clamped 1–168 and 48 when unset or unreadable, exactly as
            // PlayerSettings.ShareLapseHours reads it. Bookings with no players stay null and are
            // stamped when they first get some.
            migrationBuilder.Sql("""
                UPDATE bookings AS b
                SET "ShareDeadlineAt" = b."StartsAt"
                    + make_interval(mins => b."SliceMinutes" * b."SliceCount")
                    + make_interval(hours => LEAST(168, GREATEST(1, COALESCE(
                        (SELECT CASE WHEN (ts."SettingsJson" ->> 'share_lapse_hours') ~ '^-?[0-9]{1,9}$'
                                     THEN (ts."SettingsJson" ->> 'share_lapse_hours')::int END
                         FROM tenant_settings AS ts WHERE ts."TenantId" = b."TenantId"),
                        48))))
                WHERE b."ShareDeadlineAt" IS NULL
                  AND EXISTS (SELECT 1 FROM booking_participants AS p WHERE p."BookingId" = b."Id");
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ShareDeadlineAt",
                table: "bookings");
        }
    }
}

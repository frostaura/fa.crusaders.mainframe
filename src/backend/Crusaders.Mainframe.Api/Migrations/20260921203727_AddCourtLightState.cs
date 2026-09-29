using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddCourtLightState : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "court_light_state",
                columns: table => new
                {
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    CourtId = table.Column<Guid>(type: "uuid", nullable: false),
                    State = table.Column<int>(type: "integer", nullable: false),
                    OnSince = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    OnUntil = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    BookingId = table.Column<Guid>(type: "uuid", nullable: true),
                    Cause = table.Column<int>(type: "integer", nullable: false),
                    CausedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    DeviceId = table.Column<Guid>(type: "uuid", nullable: true),
                    Relay = table.Column<int>(type: "integer", nullable: true),
                    LastEventAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    LastEventSeq = table.Column<long>(type: "bigint", nullable: false),
                    LastEventBootId = table.Column<long>(type: "bigint", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_court_light_state", x => new { x.TenantId, x.CourtId });
                });

            migrationBuilder.CreateIndex(
                name: "IX_court_light_state_TenantId_DeviceId",
                table: "court_light_state",
                columns: new[] { "TenantId", "DeviceId" });

            // A row per existing court, at State = 2 (Unknown).
            //
            // UNKNOWN AND NOT OFF, AND THAT IS THE HONEST VALUE. The server has never held
            // relay state, so at the instant this table appears it genuinely does not know
            // whether any court is lit — backfilling `Off` would be the software asserting
            // something it has no evidence for, on the one screen whose whole purpose is to
            // say what is actually true. The first activation, release or heartbeat corrects
            // each row; until then the control board says "unknown", which is what an admin
            // needs to read on the evening this ships.
            //
            // INACTIVE COURTS GET A ROW TOO. A soft-deleted court can still be carrying a
            // booking somebody paid for — that is a live defect on the grid — and a court
            // reactivated later must not be the one court with no state row.
            migrationBuilder.Sql("""
                INSERT INTO court_light_state
                    ("TenantId", "CourtId", "State", "Cause", "LastEventAt", "LastEventSeq", "LastEventBootId", "UpdatedAt")
                SELECT c."TenantId", c."Id", 2, 4, now(), 0, 0, now()
                FROM courts c
                WHERE NOT EXISTS (
                    SELECT 1 FROM court_light_state s
                    WHERE s."TenantId" = c."TenantId" AND s."CourtId" = c."Id");
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "court_light_state");
        }
    }
}

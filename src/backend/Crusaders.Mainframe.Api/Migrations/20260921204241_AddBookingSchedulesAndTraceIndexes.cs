using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddBookingSchedulesAndTraceIndexes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "AdminNote",
                table: "bookings",
                type: "character varying(128)",
                maxLength: 128,
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "ScheduleId",
                table: "bookings",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<DateOnly>(
                name: "ScheduleOccurrenceDate",
                table: "bookings",
                type: "date",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "booking_schedule_courts",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    ScheduleId = table.Column<Guid>(type: "uuid", nullable: false),
                    CourtId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_booking_schedule_courts", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "booking_schedule_exceptions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    ScheduleId = table.Column<Guid>(type: "uuid", nullable: false),
                    OccurrenceDate = table.Column<DateOnly>(type: "date", nullable: false),
                    Kind = table.Column<int>(type: "integer", nullable: false),
                    StartMinute = table.Column<int>(type: "integer", nullable: true),
                    EndMinute = table.Column<int>(type: "integer", nullable: true),
                    Reason = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: true),
                    CreatedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_booking_schedule_exceptions", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "booking_schedules",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    Label = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    DaysOfWeek = table.Column<int>(type: "integer", nullable: false),
                    StartMinute = table.Column<int>(type: "integer", nullable: false),
                    EndMinute = table.Column<int>(type: "integer", nullable: false),
                    StartDate = table.Column<DateOnly>(type: "date", nullable: false),
                    EndDate = table.Column<DateOnly>(type: "date", nullable: true),
                    IntervalWeeks = table.Column<short>(type: "smallint", nullable: false),
                    Status = table.Column<int>(type: "integer", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    MaterialisedThrough = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_booking_schedules", x => x.Id);
                    table.CheckConstraint("ck_booking_schedules_days", "\"DaysOfWeek\" BETWEEN 1 AND 127");
                    table.CheckConstraint("ck_booking_schedules_interval", "\"IntervalWeeks\" BETWEEN 1 AND 8");
                    table.CheckConstraint("ck_booking_schedules_time_range", "\"EndMinute\" > \"StartMinute\" AND \"EndMinute\" <= 1440 AND \"StartMinute\" >= 0");
                });

            migrationBuilder.CreateIndex(
                name: "IX_ledger_entries_TenantId_ActorUserId_CreatedAt",
                table: "ledger_entries",
                columns: new[] { "TenantId", "ActorUserId", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_bookings_TenantId_ScheduleId_StartsAt",
                table: "bookings",
                columns: new[] { "TenantId", "ScheduleId", "StartsAt" });

            migrationBuilder.CreateIndex(
                name: "IX_audit_log_TenantId_ActorUserId_CreatedAt",
                table: "audit_log",
                columns: new[] { "TenantId", "ActorUserId", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_audit_log_TenantId_SubjectUserId_CreatedAt",
                table: "audit_log",
                columns: new[] { "TenantId", "SubjectUserId", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_booking_schedule_courts_TenantId_ScheduleId_CourtId",
                table: "booking_schedule_courts",
                columns: new[] { "TenantId", "ScheduleId", "CourtId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_booking_schedule_exceptions_TenantId_ScheduleId_OccurrenceD~",
                table: "booking_schedule_exceptions",
                columns: new[] { "TenantId", "ScheduleId", "OccurrenceDate" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_booking_schedules_TenantId_Status",
                table: "booking_schedules",
                columns: new[] { "TenantId", "Status" });

            // A schedule's name is unique per club, CASE-INSENSITIVELY, and EF cannot express a
            // functional index — so it goes through Sql() exactly as the GiST exclusion
            // constraint does. Case-insensitive because "League" and "league" are one league
            // night to everybody in the club, and two rows called that is a screen where an
            // admin cannot tell which one they are ending.
            migrationBuilder.Sql("""
                CREATE UNIQUE INDEX ix_booking_schedules_tenant_name
                  ON booking_schedules ("TenantId", lower("Name"));
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("DROP INDEX IF EXISTS ix_booking_schedules_tenant_name;");

            migrationBuilder.DropTable(
                name: "booking_schedule_courts");

            migrationBuilder.DropTable(
                name: "booking_schedule_exceptions");

            migrationBuilder.DropTable(
                name: "booking_schedules");

            migrationBuilder.DropIndex(
                name: "IX_ledger_entries_TenantId_ActorUserId_CreatedAt",
                table: "ledger_entries");

            migrationBuilder.DropIndex(
                name: "IX_bookings_TenantId_ScheduleId_StartsAt",
                table: "bookings");

            migrationBuilder.DropIndex(
                name: "IX_audit_log_TenantId_ActorUserId_CreatedAt",
                table: "audit_log");

            migrationBuilder.DropIndex(
                name: "IX_audit_log_TenantId_SubjectUserId_CreatedAt",
                table: "audit_log");

            migrationBuilder.DropColumn(
                name: "AdminNote",
                table: "bookings");

            migrationBuilder.DropColumn(
                name: "ScheduleId",
                table: "bookings");

            migrationBuilder.DropColumn(
                name: "ScheduleOccurrenceDate",
                table: "bookings");
        }
    }
}

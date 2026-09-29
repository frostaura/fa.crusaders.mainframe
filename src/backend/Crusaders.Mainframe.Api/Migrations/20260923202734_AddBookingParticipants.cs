using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddBookingParticipants : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropCheckConstraint(
                name: "ck_ledger_entries_type_range",
                table: "ledger_entries");

            migrationBuilder.AddColumn<bool>(
                name: "ShareResults",
                table: "user_preferences",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<int>(
                name: "Audience",
                table: "admin_notifications",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<Guid>(
                name: "RecipientUserId",
                table: "admin_notifications",
                type: "uuid",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "booking_participants",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    BookingId = table.Column<Guid>(type: "uuid", nullable: false),
                    Seat = table.Column<int>(type: "integer", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: true),
                    GuestName = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    Status = table.Column<int>(type: "integer", nullable: false),
                    ShareCredits = table.Column<decimal>(type: "numeric(10,2)", nullable: false),
                    ConsentedCredits = table.Column<decimal>(type: "numeric(10,2)", nullable: false),
                    ShareWeight = table.Column<int>(type: "integer", nullable: false),
                    SplitMode = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    InviteTokenHash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    InvitedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    InvitedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    RespondedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    CheckedInAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    SettledOutsideAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    LapsedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    LastNudgedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    NudgeCount = table.Column<int>(type: "integer", nullable: false),
                    LastReminderAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    ReminderCount = table.Column<int>(type: "integer", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    Version = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_booking_participants", x => x.Id);
                    table.CheckConstraint("ck_booking_participants_guest", "\"GuestName\" IS NULL OR (\"UserId\" IS NULL AND \"ShareCredits\" = 0)");
                    table.CheckConstraint("ck_booking_participants_money", "\"ShareCredits\" >= 0 AND \"ConsentedCredits\" >= 0 AND \"ShareWeight\" >= 0");
                    table.CheckConstraint("ck_booking_participants_seat", "\"Seat\" BETWEEN 1 AND 4");
                    table.CheckConstraint("ck_booking_participants_status", "\"Status\" BETWEEN 0 AND 5");
                });

            migrationBuilder.CreateTable(
                name: "member_notifications",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Kind = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Headline = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false),
                    Link = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: true),
                    BookingId = table.Column<Guid>(type: "uuid", nullable: true),
                    DedupeKey = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ReadAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_member_notifications", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "partner_favourites",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    PartnerUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_partner_favourites", x => x.Id);
                    table.CheckConstraint("ck_partner_favourites_not_self", "\"UserId\" <> \"PartnerUserId\"");
                });

            migrationBuilder.AddCheckConstraint(
                name: "ck_ledger_entries_type_range",
                table: "ledger_entries",
                sql: "\"Type\" BETWEEN 0 AND 9");

            migrationBuilder.AddCheckConstraint(
                name: "ck_admin_notifications_audience",
                table: "admin_notifications",
                sql: "(\"Audience\" = 0 AND \"RecipientUserId\" IS NULL) OR (\"Audience\" = 1 AND \"RecipientUserId\" IS NOT NULL)");

            migrationBuilder.CreateIndex(
                name: "IX_booking_participants_InviteTokenHash",
                table: "booking_participants",
                column: "InviteTokenHash",
                unique: true,
                filter: "\"InviteTokenHash\" IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_booking_participants_TenantId_BookingId_Seat",
                table: "booking_participants",
                columns: new[] { "TenantId", "BookingId", "Seat" },
                unique: true,
                filter: "\"Status\" IN (0, 1)");

            migrationBuilder.CreateIndex(
                name: "IX_booking_participants_TenantId_BookingId_UserId",
                table: "booking_participants",
                columns: new[] { "TenantId", "BookingId", "UserId" },
                unique: true,
                filter: "\"Status\" IN (0, 1) AND \"UserId\" IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_booking_participants_TenantId_UserId_Status",
                table: "booking_participants",
                columns: new[] { "TenantId", "UserId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_member_notifications_TenantId_DedupeKey",
                table: "member_notifications",
                columns: new[] { "TenantId", "DedupeKey" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_member_notifications_TenantId_UserId",
                table: "member_notifications",
                columns: new[] { "TenantId", "UserId" },
                filter: "\"ReadAt\" IS NULL");

            migrationBuilder.CreateIndex(
                name: "IX_member_notifications_TenantId_UserId_CreatedAt_Id",
                table: "member_notifications",
                columns: new[] { "TenantId", "UserId", "CreatedAt", "Id" });

            migrationBuilder.CreateIndex(
                name: "IX_partner_favourites_TenantId_UserId_PartnerUserId",
                table: "partner_favourites",
                columns: new[] { "TenantId", "UserId", "PartnerUserId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Refused, not lossy, once a share has moved: deleting ShareTransfer rows would change
            // members' balances, and keeping them would violate the narrowed type range. A club
            // that needs to roll back past this point decides what to do with those rows by hand.
            migrationBuilder.Sql("""
                DO $$
                BEGIN
                    IF EXISTS (SELECT 1 FROM ledger_entries WHERE "Type" = 9) THEN
                        RAISE EXCEPTION 'AddBookingParticipants cannot be rolled back: share transfers exist in ledger_entries';
                    END IF;
                END $$;
                """);

            // Member mail in the outbox would read as ADMIN mail once the audience column is gone,
            // and be sent to every administrator. It is mail, not money: dropped.
            migrationBuilder.Sql("""DELETE FROM admin_notifications WHERE "Audience" = 1;""");

            migrationBuilder.DropTable(
                name: "booking_participants");

            migrationBuilder.DropTable(
                name: "member_notifications");

            migrationBuilder.DropTable(
                name: "partner_favourites");

            migrationBuilder.DropCheckConstraint(
                name: "ck_ledger_entries_type_range",
                table: "ledger_entries");

            migrationBuilder.DropCheckConstraint(
                name: "ck_admin_notifications_audience",
                table: "admin_notifications");

            migrationBuilder.DropColumn(
                name: "ShareResults",
                table: "user_preferences");

            migrationBuilder.DropColumn(
                name: "Audience",
                table: "admin_notifications");

            migrationBuilder.DropColumn(
                name: "RecipientUserId",
                table: "admin_notifications");

            migrationBuilder.AddCheckConstraint(
                name: "ck_ledger_entries_type_range",
                table: "ledger_entries",
                sql: "\"Type\" BETWEEN 0 AND 8");
        }
    }
}

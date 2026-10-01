using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <summary>
    /// P13: minutes replace the old unit of account (<c>docs/specs/minutes-and-packages.md</c> §2.4).
    ///
    /// <para>
    /// <b>Refuses to run on money history, in both directions.</b> Converting the old unit to
    /// minutes has no meaning, and silently deleting money rows is worse than refusing, so
    /// <c>Up</c> and <c>Down</c> both start with a <c>DO</c> block that raises
    /// "pre-launch reset required" when any ledger, purchase or pay-for row exists, or any
    /// booking or seat carries a non-zero amount. On an empty ledger every converted value is 0,
    /// which is what makes the <c>round(…)::integer</c> casts below lossless.
    /// </para>
    /// </summary>
    public partial class MinutesReplaceCredits : Migration
    {
        /// <summary>The refusal both directions run first. The three column names are the money columns as they stand at that moment.</summary>
        private static string Refusal(string charged, string share, string consented) => $$"""
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM ledger_entries) THEN
                    RAISE EXCEPTION 'MinutesReplaceCredits: pre-launch reset required — money history exists (ledger_entries)';
                END IF;
                IF EXISTS (SELECT 1 FROM pending_topups) THEN
                    RAISE EXCEPTION 'MinutesReplaceCredits: pre-launch reset required — money history exists (pending_topups)';
                END IF;
                IF EXISTS (SELECT 1 FROM device_pay_fors) THEN
                    RAISE EXCEPTION 'MinutesReplaceCredits: pre-launch reset required — money history exists (device_pay_fors)';
                END IF;
                IF EXISTS (SELECT 1 FROM bookings WHERE "{{charged}}" <> 0) THEN
                    RAISE EXCEPTION 'MinutesReplaceCredits: pre-launch reset required — money history exists (bookings)';
                END IF;
                IF EXISTS (SELECT 1 FROM booking_participants WHERE "{{share}}" <> 0 OR "{{consented}}" <> 0) THEN
                    RAISE EXCEPTION 'MinutesReplaceCredits: pre-launch reset required — money history exists (booking_participants)';
                END IF;
            END
            $$;
            """;

        /// <summary>Renames a money column and retypes it, converting every (zero) value through <c>round</c>.</summary>
        private static void Retype(MigrationBuilder b, string table, string from, string to, string type)
        {
            b.RenameColumn(name: from, table: table, newName: to);
            b.Sql($"ALTER TABLE {table} ALTER COLUMN \"{to}\" TYPE {type} USING round(\"{to}\")::{type};");
        }

        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(Refusal("AmountChargedCredits", "ShareCredits", "ConsentedCredits"));

            // 1. Rename and retype the money columns to whole minutes (§2.1).
            migrationBuilder.DropCheckConstraint(name: "ck_booking_participants_guest", table: "booking_participants");
            migrationBuilder.DropCheckConstraint(name: "ck_booking_participants_money", table: "booking_participants");

            Retype(migrationBuilder, "ledger_entries", "AmountCredits", "AmountMinutes", "integer");
            Retype(migrationBuilder, "bookings", "AmountChargedCredits", "AmountChargedMinutes", "integer");
            Retype(migrationBuilder, "booking_participants", "ShareCredits", "ShareMinutes", "integer");
            Retype(migrationBuilder, "booking_participants", "ConsentedCredits", "ConsentedMinutes", "integer");
            Retype(migrationBuilder, "device_pay_fors", "AmountCredits", "AmountMinutes", "integer");
            Retype(migrationBuilder, "device_pay_fors", "BalanceAfterCredits", "BalanceAfterMinutes", "integer");

            // 2. The two seat checks, naming the new columns under their old names.
            migrationBuilder.AddCheckConstraint(
                name: "ck_booking_participants_guest",
                table: "booking_participants",
                sql: "\"GuestName\" IS NULL OR (\"UserId\" IS NULL AND \"ShareMinutes\" = 0)");

            migrationBuilder.AddCheckConstraint(
                name: "ck_booking_participants_money",
                table: "booking_participants",
                sql: "\"ShareMinutes\" >= 0 AND \"ConsentedMinutes\" >= 0 AND \"ShareWeight\" >= 0");

            // 3. Prices and conversion rates are gone (§2.2).
            migrationBuilder.DropCheckConstraint(name: "ck_member_groups_credits_per_zar", table: "member_groups");
            migrationBuilder.DropCheckConstraint(name: "ck_member_groups_pricing", table: "member_groups");
            migrationBuilder.DropColumn(name: "ConversionRate", table: "pending_topups");
            migrationBuilder.DropColumn(name: "CreditsPerZar", table: "member_groups");
            migrationBuilder.DropColumn(name: "FlatSlicePriceCredits", table: "member_groups");
            migrationBuilder.DropColumn(name: "PriceMultiplierBps", table: "member_groups");
            migrationBuilder.DropColumn(name: "PricingMode", table: "member_groups");
            migrationBuilder.DropColumn(name: "ConversionRate", table: "ledger_entries");
            migrationBuilder.DropColumn(name: "SlicePriceCredits", table: "courts");

            // 4. The packages (§2.3).
            migrationBuilder.CreateTable(
                name: "minute_packages",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    GroupId = table.Column<Guid>(type: "uuid", nullable: true),
                    Name = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Minutes = table.Column<int>(type: "integer", nullable: false),
                    PriceZar = table.Column<decimal>(type: "numeric(10,2)", nullable: false),
                    SortOrder = table.Column<int>(type: "integer", nullable: false, defaultValue: 0),
                    Status = table.Column<int>(type: "integer", nullable: false, defaultValue: 0),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_minute_packages", x => x.Id);
                    table.CheckConstraint("ck_minute_packages_minutes", "\"Minutes\" BETWEEN 1 AND 60000");
                    table.CheckConstraint("ck_minute_packages_price", "\"PriceZar\" > 0 AND \"PriceZar\" <= 100000");
                    table.CheckConstraint("ck_minute_packages_status", "\"Status\" IN (0, 1)");
                    table.ForeignKey(
                        name: "FK_minute_packages_member_groups_GroupId",
                        column: x => x.GroupId,
                        principalTable: "member_groups",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_minute_packages_GroupId",
                table: "minute_packages",
                column: "GroupId");

            migrationBuilder.CreateIndex(
                name: "IX_minute_packages_TenantId_GroupId",
                table: "minute_packages",
                columns: new[] { "TenantId", "GroupId" });

            migrationBuilder.CreateIndex(
                name: "IX_minute_packages_TenantId_GroupId_Name",
                table: "minute_packages",
                columns: new[] { "TenantId", "GroupId", "Name" },
                unique: true,
                filter: "\"Status\" = 0")
                .Annotation("Npgsql:NullsDistinct", false);

            migrationBuilder.CreateIndex(
                name: "IX_minute_packages_TenantId_Status",
                table: "minute_packages",
                columns: new[] { "TenantId", "Status" });

            // 5. A group's package discount.
            migrationBuilder.AddColumn<int>(
                name: "PackageDiscountBps",
                table: "member_groups",
                type: "integer",
                nullable: true);

            migrationBuilder.AddCheckConstraint(
                name: "ck_member_groups_package_discount",
                table: "member_groups",
                sql: "\"PackageDiscountBps\" IS NULL OR \"PackageDiscountBps\" BETWEEN 0 AND 10000");

            // 6. The purchase lock on pending_topups. NOT NULL with a throwaway default is safe:
            // the refusal above guarantees the table is empty.
            migrationBuilder.AddColumn<Guid>(
                name: "PackageId",
                table: "pending_topups",
                type: "uuid",
                nullable: false,
                defaultValue: new Guid("00000000-0000-0000-0000-000000000000"));

            migrationBuilder.AddColumn<string>(
                name: "PackageName",
                table: "pending_topups",
                type: "character varying(64)",
                maxLength: 64,
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<int>(
                name: "Minutes",
                table: "pending_topups",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<decimal>(
                name: "ListPriceZar",
                table: "pending_topups",
                type: "numeric(10,2)",
                nullable: false,
                defaultValue: 0m);

            migrationBuilder.AddColumn<int>(
                name: "DiscountBps",
                table: "pending_topups",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddCheckConstraint(
                name: "ck_pending_topups_minutes",
                table: "pending_topups",
                sql: "\"Minutes\" > 0");

            migrationBuilder.AddCheckConstraint(
                name: "ck_pending_topups_discount",
                table: "pending_topups",
                sql: "\"DiscountBps\" BETWEEN 0 AND 10000");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(Refusal("AmountChargedMinutes", "ShareMinutes", "ConsentedMinutes"));

            migrationBuilder.DropCheckConstraint(name: "ck_pending_topups_discount", table: "pending_topups");
            migrationBuilder.DropCheckConstraint(name: "ck_pending_topups_minutes", table: "pending_topups");
            migrationBuilder.DropColumn(name: "DiscountBps", table: "pending_topups");
            migrationBuilder.DropColumn(name: "ListPriceZar", table: "pending_topups");
            migrationBuilder.DropColumn(name: "Minutes", table: "pending_topups");
            migrationBuilder.DropColumn(name: "PackageId", table: "pending_topups");
            migrationBuilder.DropColumn(name: "PackageName", table: "pending_topups");

            migrationBuilder.DropCheckConstraint(name: "ck_member_groups_package_discount", table: "member_groups");
            migrationBuilder.DropColumn(name: "PackageDiscountBps", table: "member_groups");

            migrationBuilder.DropTable(name: "minute_packages");

            migrationBuilder.AddColumn<decimal>(
                name: "SlicePriceCredits",
                table: "courts",
                type: "numeric(10,2)",
                nullable: false,
                defaultValue: 8m);

            migrationBuilder.AddColumn<decimal>(
                name: "ConversionRate",
                table: "ledger_entries",
                type: "numeric(8,4)",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "PricingMode",
                table: "member_groups",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<int>(
                name: "PriceMultiplierBps",
                table: "member_groups",
                type: "integer",
                nullable: false,
                defaultValue: 10000);

            migrationBuilder.AddColumn<decimal>(
                name: "FlatSlicePriceCredits",
                table: "member_groups",
                type: "numeric(10,2)",
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "CreditsPerZar",
                table: "member_groups",
                type: "numeric(8,4)",
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "ConversionRate",
                table: "pending_topups",
                type: "numeric(8,4)",
                nullable: true);

            migrationBuilder.AddCheckConstraint(
                name: "ck_member_groups_pricing",
                table: "member_groups",
                sql: "(\"PricingMode\" = 0) OR (\"PricingMode\" = 1 AND \"PriceMultiplierBps\" BETWEEN 0 AND 1000000) OR (\"PricingMode\" = 2 AND \"FlatSlicePriceCredits\" IS NOT NULL AND \"FlatSlicePriceCredits\" >= 0)");

            migrationBuilder.AddCheckConstraint(
                name: "ck_member_groups_credits_per_zar",
                table: "member_groups",
                sql: "\"CreditsPerZar\" IS NULL OR (\"CreditsPerZar\" > 0 AND \"CreditsPerZar\" <= 1000)");

            migrationBuilder.DropCheckConstraint(name: "ck_booking_participants_guest", table: "booking_participants");
            migrationBuilder.DropCheckConstraint(name: "ck_booking_participants_money", table: "booking_participants");

            Retype(migrationBuilder, "device_pay_fors", "BalanceAfterMinutes", "BalanceAfterCredits", "numeric(10,2)");
            Retype(migrationBuilder, "device_pay_fors", "AmountMinutes", "AmountCredits", "numeric(10,2)");
            Retype(migrationBuilder, "booking_participants", "ConsentedMinutes", "ConsentedCredits", "numeric(10,2)");
            Retype(migrationBuilder, "booking_participants", "ShareMinutes", "ShareCredits", "numeric(10,2)");
            Retype(migrationBuilder, "bookings", "AmountChargedMinutes", "AmountChargedCredits", "numeric(10,2)");
            Retype(migrationBuilder, "ledger_entries", "AmountMinutes", "AmountCredits", "numeric(10,2)");

            migrationBuilder.AddCheckConstraint(
                name: "ck_booking_participants_guest",
                table: "booking_participants",
                sql: "\"GuestName\" IS NULL OR (\"UserId\" IS NULL AND \"ShareCredits\" = 0)");

            migrationBuilder.AddCheckConstraint(
                name: "ck_booking_participants_money",
                table: "booking_participants",
                sql: "\"ShareCredits\" >= 0 AND \"ConsentedCredits\" >= 0 AND \"ShareWeight\" >= 0");
        }
    }
}

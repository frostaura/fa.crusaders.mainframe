using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddSessionEpochClaimKeysPayForQuotesAndCutoffMarks : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "SessionEpoch",
                table: "users",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<string>(
                name: "ClaimKey",
                table: "member_code_uses",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "CutoffExpiredAt",
                table: "access_codes",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "ExpiresAtBeforeCutoff",
                table: "access_codes",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "device_pay_for_quotes",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    DeviceId = table.Column<Guid>(type: "uuid", nullable: false),
                    Nonce = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    BookingId = table.Column<Guid>(type: "uuid", nullable: false),
                    QuotedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_device_pay_for_quotes", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_device_pay_for_quotes_QuotedAt",
                table: "device_pay_for_quotes",
                column: "QuotedAt");

            migrationBuilder.CreateIndex(
                name: "IX_device_pay_for_quotes_TenantId_DeviceId_Nonce",
                table: "device_pay_for_quotes",
                columns: new[] { "TenantId", "DeviceId", "Nonce" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "device_pay_for_quotes");

            migrationBuilder.DropColumn(
                name: "SessionEpoch",
                table: "users");

            migrationBuilder.DropColumn(
                name: "ClaimKey",
                table: "member_code_uses");

            migrationBuilder.DropColumn(
                name: "CutoffExpiredAt",
                table: "access_codes");

            migrationBuilder.DropColumn(
                name: "ExpiresAtBeforeCutoff",
                table: "access_codes");
        }
    }
}

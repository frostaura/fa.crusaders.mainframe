using System;
using System.Collections.Generic;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddMemberCodes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<List<string>>(
                name: "Capabilities",
                table: "devices",
                type: "text[]",
                nullable: false,
                defaultValueSql: "'{}'::text[]");

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "CapabilitiesReportedAt",
                table: "devices",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "device_pay_fors",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    DeviceId = table.Column<Guid>(type: "uuid", nullable: false),
                    Nonce = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    BookingId = table.Column<Guid>(type: "uuid", nullable: false),
                    PayerUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    RefundedUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    CourtNumber = table.Column<int>(type: "integer", nullable: false),
                    AmountCredits = table.Column<decimal>(type: "numeric(10,2)", nullable: false),
                    AmountLabel = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    BalanceAfterCredits = table.Column<decimal>(type: "numeric(10,2)", nullable: false),
                    GrantedSeconds = table.Column<int>(type: "integer", nullable: false),
                    Paid = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_device_pay_fors", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "member_code_uses",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    Ref = table.Column<int>(type: "integer", nullable: false),
                    Step = table.Column<long>(type: "bigint", nullable: false),
                    UseClass = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false),
                    UsedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    DeviceId = table.Column<Guid>(type: "uuid", nullable: true),
                    Kind = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_member_code_uses", x => x.Id);
                    table.CheckConstraint("ck_member_code_uses_class", "\"UseClass\" IN ('door', 'court', 'money')");
                });

            migrationBuilder.CreateTable(
                name: "member_codes",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Ref = table.Column<int>(type: "integer", nullable: false),
                    Generation = table.Column<int>(type: "integer", nullable: false, defaultValue: 1),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    EnrolledAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    RotatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_member_codes", x => x.Id);
                    table.CheckConstraint("ck_member_codes_generation", "\"Generation\" >= 1");
                    table.CheckConstraint("ck_member_codes_ref", "\"Ref\" BETWEEN 1 AND 1048575");
                });

            migrationBuilder.CreateIndex(
                name: "IX_device_pay_fors_TenantId_DeviceId_Nonce",
                table: "device_pay_fors",
                columns: new[] { "TenantId", "DeviceId", "Nonce" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_member_code_uses_TenantId_Ref_Step_UseClass",
                table: "member_code_uses",
                columns: new[] { "TenantId", "Ref", "Step", "UseClass" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_member_code_uses_UsedAt",
                table: "member_code_uses",
                column: "UsedAt");

            migrationBuilder.CreateIndex(
                name: "IX_member_codes_TenantId_Ref",
                table: "member_codes",
                columns: new[] { "TenantId", "Ref" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_member_codes_TenantId_UserId",
                table: "member_codes",
                columns: new[] { "TenantId", "UserId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "device_pay_fors");

            migrationBuilder.DropTable(
                name: "member_code_uses");

            migrationBuilder.DropTable(
                name: "member_codes");

            migrationBuilder.DropColumn(
                name: "Capabilities",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "CapabilitiesReportedAt",
                table: "devices");
        }
    }
}

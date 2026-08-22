using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddDevices : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "devices",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    DeviceCode = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Name = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    Kind = table.Column<int>(type: "integer", nullable: false),
                    Hardware = table.Column<int>(type: "integer", nullable: false),
                    CourtNumber = table.Column<int>(type: "integer", nullable: true),
                    GateKey = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    KeyVersion = table.Column<int>(type: "integer", nullable: false),
                    LastIpAddress = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    RevokedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    LastSeenAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    RunningVersion = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    MegaVersion = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    OtaChannel = table.Column<int>(type: "integer", nullable: false),
                    PinnedVersion = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_devices", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_devices_TenantId_DeviceCode",
                table: "devices",
                columns: new[] { "TenantId", "DeviceCode" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_devices_TenantId_Kind",
                table: "devices",
                columns: new[] { "TenantId", "Kind" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "devices");
        }
    }
}

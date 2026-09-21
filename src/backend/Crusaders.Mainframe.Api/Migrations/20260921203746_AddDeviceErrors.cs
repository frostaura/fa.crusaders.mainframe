using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddDeviceErrors : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "device_errors",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    DeviceId = table.Column<Guid>(type: "uuid", nullable: true),
                    ClaimedDeviceCode = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    ClaimedMac = table.Column<string>(type: "character varying(12)", maxLength: 12, nullable: true),
                    Source = table.Column<int>(type: "integer", nullable: false),
                    Code = table.Column<string>(type: "character varying(48)", maxLength: 48, nullable: false),
                    Severity = table.Column<int>(type: "integer", nullable: false),
                    Detail = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: true),
                    Court = table.Column<int>(type: "integer", nullable: true),
                    FirstSeenAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    LastSeenAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    Count = table.Column<int>(type: "integer", nullable: false),
                    Fingerprint = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ResolvedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    ResolvedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    ResolutionNote = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_device_errors", x => x.Id);
                    table.CheckConstraint("ck_device_errors_count", "\"Count\" >= 1");
                    table.CheckConstraint("ck_device_errors_severity", "\"Severity\" BETWEEN 0 AND 3");
                });

            migrationBuilder.CreateIndex(
                name: "IX_device_errors_TenantId_DeviceId_LastSeenAt",
                table: "device_errors",
                columns: new[] { "TenantId", "DeviceId", "LastSeenAt" });

            migrationBuilder.CreateIndex(
                name: "IX_device_errors_TenantId_Fingerprint",
                table: "device_errors",
                columns: new[] { "TenantId", "Fingerprint" },
                unique: true,
                filter: "\"ResolvedAt\" IS NULL");

            migrationBuilder.CreateIndex(
                name: "IX_device_errors_TenantId_LastSeenAt",
                table: "device_errors",
                columns: new[] { "TenantId", "LastSeenAt" });

            migrationBuilder.CreateIndex(
                name: "IX_device_errors_TenantId_Severity_ResolvedAt",
                table: "device_errors",
                columns: new[] { "TenantId", "Severity", "ResolvedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "device_errors");
        }
    }
}

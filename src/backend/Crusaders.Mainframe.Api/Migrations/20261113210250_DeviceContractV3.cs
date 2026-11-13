using System;
using System.Collections.Generic;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <inheritdoc />
    public partial class DeviceContractV3 : Migration
    {
        /// <summary>
        /// Device contract v3 (docs/specs/device-api.md): what a v3 board reports (firmware state,
        /// network, acknowledged layout, restore, telemetry, the key it is on), the per-board
        /// display and hardware overrides, the server's key-shedding counts, a release's cause,
        /// and three tenant-scoped tables — retained device keys, the club's device network and
        /// signed firmware releases. Every new device column is nullable or defaulted, so a 2.x
        /// board's row is untouched.
        /// </summary>
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Every club that existed before key rotation holds key k1 (device-api.md §6).
            migrationBuilder.AddColumn<int>(
                name: "DeviceApiKeyId",
                table: "tenants",
                type: "integer",
                nullable: false,
                defaultValue: 1);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "DeviceKeyRotationStartedAt",
                table: "tenants",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "CodeKeysAt",
                table: "devices",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "CodeKeysSent",
                table: "devices",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "CodeKeysTrimNoticedAt",
                table: "devices",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "CodeKeysTrimmed",
                table: "devices",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "DiagJson",
                table: "devices",
                type: "jsonb",
                nullable: true);

            migrationBuilder.AddColumn<List<string>>(
                name: "Drift",
                table: "devices",
                type: "text[]",
                nullable: false,
                defaultValueSql: "'{}'::text[]");

            migrationBuilder.AddColumn<string>(
                name: "FwError",
                table: "devices",
                type: "character varying(16)",
                maxLength: 16,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "FwFailed",
                table: "devices",
                type: "character varying(32)",
                maxLength: 32,
                nullable: true);

            migrationBuilder.AddColumn<List<string>>(
                name: "FwFailedVersions",
                table: "devices",
                type: "text[]",
                nullable: false,
                defaultValueSql: "'{}'::text[]");

            migrationBuilder.AddColumn<string>(
                name: "FwState",
                table: "devices",
                type: "character varying(16)",
                maxLength: 16,
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "FwStateChangedAt",
                table: "devices",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "HwLcdI2cAddress",
                table: "devices",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "HwRelayActiveLevel",
                table: "devices",
                type: "character varying(8)",
                maxLength: 8,
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "HwScannerBaud",
                table: "devices",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "HwScannerGapMs",
                table: "devices",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "HwScannerLineEnd",
                table: "devices",
                type: "character varying(8)",
                maxLength: 8,
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "LastKeyAt",
                table: "devices",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "LastKeyId",
                table: "devices",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "LcdLayoutAcknowledged",
                table: "devices",
                type: "character varying(16)",
                maxLength: 16,
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "LcdLayoutAcknowledgedAt",
                table: "devices",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "LcdLayoutOverride",
                table: "devices",
                type: "character varying(16)",
                maxLength: 16,
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "LcdMarqueeOverride",
                table: "devices",
                type: "boolean",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "MegaJson",
                table: "devices",
                type: "jsonb",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "NetPushRequested",
                table: "devices",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<string>(
                name: "NetSrc",
                table: "devices",
                type: "character varying(16)",
                maxLength: 16,
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "NetVer",
                table: "devices",
                type: "bigint",
                nullable: true);

            migrationBuilder.AddColumn<List<int>>(
                name: "RelayDarkStreak",
                table: "devices",
                type: "integer[]",
                nullable: false,
                defaultValueSql: "'{}'::integer[]");

            migrationBuilder.AddColumn<string>(
                name: "RestoreReport",
                table: "devices",
                type: "character varying(16)",
                maxLength: 16,
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "RestoreReportedAt",
                table: "devices",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "TelemetryAt",
                table: "devices",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Cause",
                table: "device_event_receipts",
                type: "character varying(32)",
                maxLength: 32,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "device_networks",
                columns: table => new
                {
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    Version = table.Column<int>(type: "integer", nullable: false),
                    BaseUrl = table.Column<string>(type: "character varying(96)", maxLength: 96, nullable: true),
                    Wifi0Ssid = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    Wifi0PskCipher = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: true),
                    Wifi1Ssid = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    Wifi1PskCipher = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: true),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UpdatedByUserId = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_device_networks", x => x.TenantId);
                });

            migrationBuilder.CreateTable(
                name: "device_previous_keys",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    KeyId = table.Column<int>(type: "integer", nullable: false),
                    Key = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    SupersededAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    RetiredAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    RetiredByUserId = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_device_previous_keys", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "firmware_releases",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: false),
                    Target = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Version = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Size = table.Column<int>(type: "integer", nullable: false),
                    Sha256 = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Signature = table.Column<string>(type: "character varying(342)", maxLength: 342, nullable: false),
                    Image = table.Column<byte[]>(type: "bytea", nullable: false),
                    UploadedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    UploadedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    Rollout = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false),
                    RolloutDeviceId = table.Column<Guid>(type: "uuid", nullable: true),
                    Paused = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_firmware_releases", x => x.Id);
                    table.CheckConstraint("ck_firmware_releases_rollout", "\"Rollout\" IN ('off', 'one', 'all')");
                });

            migrationBuilder.CreateIndex(
                name: "IX_device_previous_keys_TenantId_KeyId",
                table: "device_previous_keys",
                columns: new[] { "TenantId", "KeyId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_firmware_releases_TenantId_Target_Version",
                table: "firmware_releases",
                columns: new[] { "TenantId", "Target", "Version" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "device_networks");

            migrationBuilder.DropTable(
                name: "device_previous_keys");

            migrationBuilder.DropTable(
                name: "firmware_releases");

            migrationBuilder.DropColumn(
                name: "DeviceApiKeyId",
                table: "tenants");

            migrationBuilder.DropColumn(
                name: "DeviceKeyRotationStartedAt",
                table: "tenants");

            migrationBuilder.DropColumn(
                name: "CodeKeysAt",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "CodeKeysSent",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "CodeKeysTrimNoticedAt",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "CodeKeysTrimmed",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "DiagJson",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "Drift",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "FwError",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "FwFailed",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "FwFailedVersions",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "FwState",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "FwStateChangedAt",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "HwLcdI2cAddress",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "HwRelayActiveLevel",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "HwScannerBaud",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "HwScannerGapMs",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "HwScannerLineEnd",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "LastKeyAt",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "LastKeyId",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "LcdLayoutAcknowledged",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "LcdLayoutAcknowledgedAt",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "LcdLayoutOverride",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "LcdMarqueeOverride",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "MegaJson",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "NetPushRequested",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "NetSrc",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "NetVer",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "RelayDarkStreak",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "RestoreReport",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "RestoreReportedAt",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "TelemetryAt",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "Cause",
                table: "device_event_receipts");
        }
    }
}

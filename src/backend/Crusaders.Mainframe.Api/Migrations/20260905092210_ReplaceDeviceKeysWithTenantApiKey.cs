using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <summary>
    /// Retires the per-device HMAC credential in favour of one API key per club.
    ///
    /// <para>
    /// Every dropped column belonged to a control that no longer exists: KeyVersion and
    /// RevokedAt to a derived per-device key (rotating one, and refusing one), OtaChannel,
    /// PinnedVersion and FailedVersion to over-the-air updates. The key itself was never
    /// stored — it was derived from a master KEK — so there is nothing here to migrate
    /// into the new column; every box has to be reflashed with the club key regardless.
    /// </para>
    ///
    /// <para>
    /// MacAddress becomes required because it is now a device's whole identity: the key
    /// says which club is calling and the MAC says which board. Rows without one were
    /// hand-registered under the old scheme and cannot be matched to a board at all, so
    /// they are deleted rather than defaulted — their board re-registers itself on its
    /// next heartbeat, which is the same recovery path everything else here relies on.
    /// </para>
    /// </summary>
    public partial class ReplaceDeviceKeysWithTenantApiKey : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Before MacAddress is made NOT NULL. A defaulted '' would satisfy the column
            // and then collide on the unique index the moment a second such row existed.
            migrationBuilder.Sql("DELETE FROM devices WHERE \"MacAddress\" IS NULL;");

            migrationBuilder.DropIndex(
                name: "IX_devices_TenantId_MacAddress",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "FailedVersion",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "KeyVersion",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "OtaChannel",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "PinnedVersion",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "RevokedAt",
                table: "devices");

            migrationBuilder.AddColumn<string>(
                name: "DeviceApiKey",
                table: "tenants",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "DeviceApiKeyRegeneratedAt",
                table: "tenants",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AlterColumn<string>(
                name: "MacAddress",
                table: "devices",
                type: "character varying(12)",
                maxLength: 12,
                nullable: false,
                defaultValue: "",
                oldClrType: typeof(string),
                oldType: "text",
                oldNullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "AutoRegistered",
                table: "devices",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.CreateIndex(
                name: "IX_devices_TenantId_MacAddress",
                table: "devices",
                columns: new[] { "TenantId", "MacAddress" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_devices_TenantId_MacAddress",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "DeviceApiKey",
                table: "tenants");

            migrationBuilder.DropColumn(
                name: "DeviceApiKeyRegeneratedAt",
                table: "tenants");

            migrationBuilder.DropColumn(
                name: "AutoRegistered",
                table: "devices");

            migrationBuilder.AlterColumn<string>(
                name: "MacAddress",
                table: "devices",
                type: "text",
                nullable: true,
                oldClrType: typeof(string),
                oldType: "character varying(12)",
                oldMaxLength: 12);

            migrationBuilder.AddColumn<string>(
                name: "FailedVersion",
                table: "devices",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "KeyVersion",
                table: "devices",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<int>(
                name: "OtaChannel",
                table: "devices",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<string>(
                name: "PinnedVersion",
                table: "devices",
                type: "character varying(32)",
                maxLength: 32,
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "RevokedAt",
                table: "devices",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_devices_TenantId_MacAddress",
                table: "devices",
                columns: new[] { "TenantId", "MacAddress" },
                unique: true,
                filter: "\"MacAddress\" IS NOT NULL");
        }
    }
}

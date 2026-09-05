using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddSettlementTrace : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "BookingId",
                table: "device_event_receipts",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "Court",
                table: "device_event_receipts",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "DisplacedByBookingId",
                table: "bookings",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "NoShowReversedAt",
                table: "bookings",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_device_event_receipts_TenantId_DeviceId_Court_OccurredAt",
                table: "device_event_receipts",
                columns: new[] { "TenantId", "DeviceId", "Court", "OccurredAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_device_event_receipts_TenantId_DeviceId_Court_OccurredAt",
                table: "device_event_receipts");

            migrationBuilder.DropColumn(
                name: "BookingId",
                table: "device_event_receipts");

            migrationBuilder.DropColumn(
                name: "Court",
                table: "device_event_receipts");

            migrationBuilder.DropColumn(
                name: "DisplacedByBookingId",
                table: "bookings");

            migrationBuilder.DropColumn(
                name: "NoShowReversedAt",
                table: "bookings");
        }
    }
}

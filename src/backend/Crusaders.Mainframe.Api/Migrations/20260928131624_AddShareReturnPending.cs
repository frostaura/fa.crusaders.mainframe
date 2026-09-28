using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddShareReturnPending : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "ReturnPendingSince",
                table: "booking_participants",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_bookings_TenantId_ShareDeadlineAt",
                table: "bookings",
                columns: new[] { "TenantId", "ShareDeadlineAt" },
                filter: "\"ShareDeadlineAt\" IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_booking_participants_TenantId_ReturnPendingSince",
                table: "booking_participants",
                columns: new[] { "TenantId", "ReturnPendingSince" },
                filter: "\"ReturnPendingSince\" IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_bookings_TenantId_ShareDeadlineAt",
                table: "bookings");

            migrationBuilder.DropIndex(
                name: "IX_booking_participants_TenantId_ReturnPendingSince",
                table: "booking_participants");

            migrationBuilder.DropColumn(
                name: "ReturnPendingSince",
                table: "booking_participants");
        }
    }
}

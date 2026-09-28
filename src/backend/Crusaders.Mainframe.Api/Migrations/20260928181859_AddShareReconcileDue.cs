using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddShareReconcileDue : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "ShareReconcileDueAt",
                table: "bookings",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_bookings_TenantId_ShareReconcileDueAt",
                table: "bookings",
                columns: new[] { "TenantId", "ShareReconcileDueAt" },
                filter: "\"ShareReconcileDueAt\" IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_bookings_TenantId_ShareReconcileDueAt",
                table: "bookings");

            migrationBuilder.DropColumn(
                name: "ShareReconcileDueAt",
                table: "bookings");
        }
    }
}

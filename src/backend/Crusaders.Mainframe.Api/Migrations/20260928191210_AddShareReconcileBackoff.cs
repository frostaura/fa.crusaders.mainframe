using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddShareReconcileBackoff : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "ShareReconcileAttempts",
                table: "bookings",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "ShareReconcileLastAttemptAt",
                table: "bookings",
                type: "timestamp with time zone",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Rolling back forgets each marked booking's backoff (attempts, last attempt): the
            // sweep then retries every still-marked booking at once, as before this migration.
            migrationBuilder.DropColumn(
                name: "ShareReconcileAttempts",
                table: "bookings");

            migrationBuilder.DropColumn(
                name: "ShareReconcileLastAttemptAt",
                table: "bookings");
        }
    }
}

using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddRelayRestoreHandshake : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "NoPush",
                table: "devices",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "NoPushReportedAt",
                table: "devices",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "RestoreServedAt",
                table: "devices",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "RestoreServedRelays",
                table: "devices",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "ConfirmedAt",
                table: "court_light_state",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "ConfirmedState",
                table: "court_light_state",
                type: "integer",
                nullable: false,
                defaultValue: 2);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "NoPush",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "NoPushReportedAt",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "RestoreServedAt",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "RestoreServedRelays",
                table: "devices");

            migrationBuilder.DropColumn(
                name: "ConfirmedAt",
                table: "court_light_state");

            migrationBuilder.DropColumn(
                name: "ConfirmedState",
                table: "court_light_state");
        }
    }
}

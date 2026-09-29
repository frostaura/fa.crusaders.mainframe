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

            // Added WITH a default of 2 (Unknown) so every existing row reads "the box has
            // never told us", and the default is then DROPPED so it can never mask a value the
            // application meant to write. See the model configuration for what keeping it cost:
            // EF omits a property whose value equals the CLR default — 0, which is Off — so a
            // database default of Unknown silently overwrote every genuine "the box reports
            // this relay is open" the server tried to record.
            migrationBuilder.AddColumn<int>(
                name: "ConfirmedState",
                table: "court_light_state",
                type: "integer",
                nullable: false,
                defaultValue: 2);

            migrationBuilder.Sql(
                "ALTER TABLE court_light_state ALTER COLUMN \"ConfirmedState\" DROP DEFAULT;");
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

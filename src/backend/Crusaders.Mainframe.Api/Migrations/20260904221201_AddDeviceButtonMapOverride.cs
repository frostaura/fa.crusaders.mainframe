using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <summary>
    /// A court box may carry its own button map (closing re-review #17). One tenant-wide
    /// map validated against every box's court count left a mixed fleet — a four-court
    /// box and a one-court annex — with no valid configuration at all; the invariant is a
    /// property of one box, so the override lives on the row. Nullable: null means the
    /// club's map, so no existing box changes behaviour.
    /// </summary>
    public partial class AddDeviceButtonMapOverride : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "ButtonMapJson",
                table: "devices",
                type: "text",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ButtonMapJson",
                table: "devices");
        }
    }
}

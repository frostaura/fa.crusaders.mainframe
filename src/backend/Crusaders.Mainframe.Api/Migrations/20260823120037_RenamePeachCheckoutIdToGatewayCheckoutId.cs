using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <inheritdoc />
    public partial class RenamePeachCheckoutIdToGatewayCheckoutId : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.RenameColumn(
                name: "PeachCheckoutId",
                table: "pending_topups",
                newName: "GatewayCheckoutId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.RenameColumn(
                name: "GatewayCheckoutId",
                table: "pending_topups",
                newName: "PeachCheckoutId");
        }
    }
}

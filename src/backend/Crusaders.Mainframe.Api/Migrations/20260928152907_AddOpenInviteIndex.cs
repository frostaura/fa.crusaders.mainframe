using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddOpenInviteIndex : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "IX_booking_participants_open_invites",
                table: "booking_participants",
                columns: new[] { "TenantId", "BookingId" },
                filter: "\"Status\" = 0 AND \"LapsedAt\" IS NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_booking_participants_open_invites",
                table: "booking_participants");
        }
    }
}

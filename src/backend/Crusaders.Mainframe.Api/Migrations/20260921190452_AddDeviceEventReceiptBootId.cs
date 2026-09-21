using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <summary>
    /// Adds the boot identity to the event receipt's idempotency key.
    ///
    /// <para>
    /// <c>(tenant, device, seq)</c> was not a key. A box's ring is RAM-only and <c>seq</c>
    /// resumes from one checkpoint record in the board's flash, written in blocks of 64;
    /// erase or tear that record — a reflash, a wiped NVS partition, a torn write — and the
    /// board renumbers from 1 against an index that is PERMANENT. Every event of the next
    /// evening was then silently receipted as a duplicate and discarded, including the
    /// <c>boot</c> event that exists to tell an operator the board restarted. Two boards
    /// accidentally sharing a MAC dedup each other the same way.
    /// </para>
    ///
    /// <para>
    /// <b>The backfill is 0, and that is the compatibility hinge rather than a placeholder.</b>
    /// 0 is the wire's "this board sends no boot identity", which is exactly what
    /// <c>(device, seq)</c> always meant — so existing rows keep deduplicating against the
    /// boards that wrote them, a court box (whose renderer omits the field) is unaffected, and
    /// nothing has to be reflashed for the new key to start working on the boards that do send
    /// one.
    /// </para>
    ///
    /// <para>
    /// <b>The down migration is not always reversible, and that is said rather than hidden.</b>
    /// Two rows differing only by <c>BootId</c> are legal under the new key and collide under
    /// the old one — and a board that renumbered after a torn checkpoint, which is the case
    /// this migration exists for, is exactly what produces such a pair. It will fail on that
    /// data, which is the honest outcome: the alternative is a down migration that silently
    /// discards receipts and lets a box re-upload an evening the server has already settled.
    /// </para>
    /// </summary>
    public partial class AddDeviceEventReceiptBootId : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // The index goes FIRST: re-creating it after the column is what makes the new key
            // live rather than merely recorded in the model.
            migrationBuilder.DropIndex(
                name: "IX_device_event_receipts_TenantId_DeviceId_Seq",
                table: "device_event_receipts");

            migrationBuilder.AddColumn<long>(
                name: "BootId",
                table: "device_event_receipts",
                type: "bigint",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.CreateIndex(
                name: "IX_device_event_receipts_TenantId_DeviceId_BootId_Seq",
                table: "device_event_receipts",
                columns: new[] { "TenantId", "DeviceId", "BootId", "Seq" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_device_event_receipts_TenantId_DeviceId_BootId_Seq",
                table: "device_event_receipts");

            migrationBuilder.DropColumn(
                name: "BootId",
                table: "device_event_receipts");

            migrationBuilder.CreateIndex(
                name: "IX_device_event_receipts_TenantId_DeviceId_Seq",
                table: "device_event_receipts",
                columns: new[] { "TenantId", "DeviceId", "Seq" },
                unique: true);
        }
    }
}

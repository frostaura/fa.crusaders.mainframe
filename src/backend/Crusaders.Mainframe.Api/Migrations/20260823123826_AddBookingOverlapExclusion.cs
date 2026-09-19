using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Crusaders.Mainframe.Api.Migrations
{
    /// <summary>
    /// Closes the double-booking race at the only place it can actually be closed.
    ///
    /// <para>
    /// <c>BookingService.CreateAsync</c> checks for an overlap and then inserts. Two requests
    /// for the same slot can both pass the check before either inserts, and the club ends up
    /// with two members and one court. No amount of application-side care fixes that: the
    /// check and the insert are separate statements, and under READ COMMITTED neither
    /// transaction can see the other's uncommitted row. It matters more now than it did —
    /// both members have been debited by the time the collision is visible.
    /// </para>
    ///
    /// <para>
    /// A GiST exclusion constraint makes the overlap unrepresentable. It is scoped by tenant
    /// as well as court: <c>CourtId</c> is a UUID and so already unique across tenants, but
    /// leading with <c>TenantId</c> states the isolation rule in the schema rather than
    /// resting it on an argument about UUID collisions.
    /// </para>
    ///
    /// <para>
    /// The range is half-open, <c>[StartsAt, EndsAt)</c>, so a booking ending at 10:00 and one
    /// starting at 10:00 are adjacent rather than overlapping. That is exactly the
    /// application's own <c>StartsAt &lt; endsAt &amp;&amp; EndsAt &gt; startsAt</c> predicate;
    /// a closed range would start rejecting the back-to-back bookings the club has always
    /// allowed, and <c>Booking_immediately_after_another_is_allowed</c> would say so.
    /// </para>
    ///
    /// <para>
    /// Cancelled rows are exempt — they are kept for the audit trail and their slot is free to
    /// rebook. Every other status still holds the slot, <c>NoShow</c> included, which is what
    /// stops a no-show being overwritten before the sweep has settled it. After settlement a
    /// <c>NoShow</c> row holds only its elapsed portion: <c>NoShowWorker.SweepOneAsync</c>
    /// truncates <c>EndsAt</c> to the sweep's clock in the same save as the status change
    /// (decision 2026-08-24, review H5), and that truncation — not an exemption here — is
    /// what frees the tail of the slot for resale.
    /// </para>
    /// </summary>
    public partial class AddBookingOverlapExclusion : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // btree_gist is what lets equality columns share a GiST index with a range column.
            migrationBuilder.Sql("CREATE EXTENSION IF NOT EXISTS btree_gist;");

            migrationBuilder.Sql(@"
                ALTER TABLE bookings
                ADD CONSTRAINT ck_bookings_no_overlapping_slot
                EXCLUDE USING gist (
                    ""TenantId"" WITH =,
                    ""CourtId"" WITH =,
                    tstzrange(""StartsAt"", ""EndsAt"", '[)') WITH &&
                )
                WHERE (""Status"" <> 1);");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("ALTER TABLE bookings DROP CONSTRAINT IF EXISTS ck_bookings_no_overlapping_slot;");
            // btree_gist is left installed on purpose: dropping an extension that another
            // migration or another schema in the same database may depend on is not this
            // migration's call to make.
        }
    }
}

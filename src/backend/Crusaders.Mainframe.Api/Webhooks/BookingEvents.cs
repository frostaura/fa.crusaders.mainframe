namespace Crusaders.Mainframe.Api.Webhooks;

/// <summary>
/// Booking webhook event names declared once, so an emitter and the coverage tests cannot spell
/// one differently. The older booking events are still written as literals at their emitters;
/// a new one starts here.
/// </summary>
public static class BookingEvents
{
    /// <summary>
    /// Somebody other than the booking's payer took its charge over — D10's pay-for at the box,
    /// or a payer override at the court (review round 6, E6-4). The SUBJECT is the new payer, so a
    /// member-registered endpoint hears that its member paid; the old payer's refund is its own
    /// <c>minutes.refunded</c>.
    /// </summary>
    public const string PayerChanged = "booking.payer_changed";
}

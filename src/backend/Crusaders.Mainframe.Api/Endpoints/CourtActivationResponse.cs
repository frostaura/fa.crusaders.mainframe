using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The wire shape every courtside touchpoint answers with, whichever way the player
/// identified.
///
/// <para>
/// Shared so biometric, PIN and QR cannot drift into describing the same outcome three
/// ways — the box has one screen and one set of messages, and a refusal it does not
/// recognise becomes a blank display in a locked corridor.
/// </para>
/// </summary>
public static class CourtActivationResponse
{
    public static IResult For(ActivationResult result, Guid userId) => result switch
    {
        ActivationResult.Activated a => Results.Ok(new
        {
            matched = true,
            activated = true,
            user_id = userId,
            booking_id = a.Booking.Id,
            paid_by_user_id = a.PayerUserId,
            amount_credits = a.AmountCredits,
            already_active = a.AlreadyActive,
            ends_at = a.Booking.EndsAt,
        }),

        // 200 rather than 402: the player WAS identified, and the box needs to tell them
        // what is wrong on the LCD. An error status would make this indistinguishable
        // from "we do not know who you are", which is a different message to a different
        // person standing in front of a dark court.
        ActivationResult.InsufficientBalance ib => Results.Ok(new
        {
            matched = true,
            activated = false,
            user_id = userId,
            reason = "insufficient_balance",
            current_credits = ib.Current,
            required_credits = ib.Required,
        }),

        ActivationResult.NoBooking => Results.Ok(new
        {
            matched = true,
            activated = false,
            user_id = userId,
            reason = "no_active_booking",
        }),

        _ => Results.Ok(new
        {
            matched = true,
            activated = false,
            user_id = userId,
            reason = "not_chargeable",
        }),
    };
}

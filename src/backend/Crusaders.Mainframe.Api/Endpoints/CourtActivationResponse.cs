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
    public static IResult For(ActivationResult result, Guid userId)
        => Results.Ok(Payload(result, userId));

    /// <summary>
    /// The same contract with the biometric read-quality extras appended, so the fingerprint
    /// path answers the shared shape rather than a fourth one of its own. Before this
    /// existed the biometric endpoint discarded the <see cref="ActivationResult"/> entirely
    /// and answered <c>{matched: true}</c> alone — an insufficient-balance refusal reached
    /// the kiosk as a plain successful match, with the lights off and nothing to say why.
    /// </summary>
    public static IResult For(ActivationResult result, Guid userId, double confidence, double liveness, int latencyMs)
    {
        var payload = Payload(result, userId);
        payload["confidence"] = confidence;
        payload["liveness"] = liveness;
        payload["latency_ms"] = latencyMs;
        return Results.Ok(payload);
    }

    private static Dictionary<string, object?> Payload(ActivationResult result, Guid userId) => result switch
    {
        ActivationResult.Activated a => new()
        {
            ["matched"] = true,
            ["activated"] = true,
            ["user_id"] = userId,
            ["booking_id"] = a.Booking.Id,
            ["paid_by_user_id"] = a.PayerUserId,
            ["amount_credits"] = a.AmountCredits,
            ["already_active"] = a.AlreadyActive,
            ["ends_at"] = a.Booking.EndsAt,
        },

        // 200 rather than 402: the player WAS identified, and the box needs to tell them
        // what is wrong on the LCD. An error status would make this indistinguishable
        // from "we do not know who you are", which is a different message to a different
        // person standing in front of a dark court.
        ActivationResult.InsufficientBalance ib => new()
        {
            ["matched"] = true,
            ["activated"] = false,
            ["user_id"] = userId,
            ["reason"] = "insufficient_balance",
            ["current_credits"] = ib.Current,
            ["required_credits"] = ib.Required,
        },

        ActivationResult.NoBooking => new()
        {
            ["matched"] = true,
            ["activated"] = false,
            ["user_id"] = userId,
            ["reason"] = "no_active_booking",
        },

        // Identified, holding the booking, but its start is outside the cue window.
        // Nothing was stamped or cued, so the kiosk says when to come back rather than
        // pretending the member is not booked at all.
        ActivationResult.TooEarly early => new()
        {
            ["matched"] = true,
            ["activated"] = false,
            ["user_id"] = userId,
            ["booking_id"] = early.Booking.Id,
            ["reason"] = "too_early",
            ["starts_in_seconds"] = early.StartsInSeconds,
            ["starts_at"] = early.Booking.StartsAt,
        },

        _ => new()
        {
            ["matched"] = true,
            ["activated"] = false,
            ["user_id"] = userId,
            ["reason"] = "not_chargeable",
        },
    };
}

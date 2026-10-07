namespace Crusaders.Mainframe.Api.Email;

/// <summary>
/// Wakes the outbox sender the moment a row is queued, so a mail leaves within a moment of the
/// action that raised it instead of waiting out the poll interval. A hint only: the sender still
/// polls, so a missed or lost signal costs a few seconds, never a mail.
/// </summary>
public sealed class EmailOutboxSignal
{
    private readonly SemaphoreSlim _gate = new(0, 1);

    public void Raise()
    {
        try { _gate.Release(); }
        catch (SemaphoreFullException) { /* already signalled; the sender will see the row */ }
    }

    /// <summary>Waits for a signal, or for <paramref name="timeout"/>. Answers false when cancelled.</summary>
    public async Task<bool> WaitAsync(TimeSpan timeout, CancellationToken ct)
    {
        try
        {
            await _gate.WaitAsync(timeout, ct);
            return true;
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }
}

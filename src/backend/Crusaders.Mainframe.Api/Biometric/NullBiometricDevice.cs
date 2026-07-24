using System.Security.Cryptography;

namespace Crusaders.Mainframe.Api.Biometric;

/// <summary>
/// Returns deterministic match results based on a configured "always-match" user list.
/// Used in CI and as a graceful fallback when no hardware is present.
/// </summary>
public sealed class NullBiometricDevice : IBiometricDevice
{
    public string DeviceId => "null-device";
    public BiometricDeviceKind Kind => BiometricDeviceKind.Multi;
    public BiometricDeviceState State => BiometricDeviceState.Connected;

    public Task<BiometricCapture> CaptureAsync(CaptureOptions options, CancellationToken ct)
        => Task.FromResult(new BiometricCapture(Array.Empty<byte>(), Quality: 100, LatencyMs: 1));

    public Task<BiometricMatchResult> IdentifyAsync(BiometricCapture capture, IReadOnlyCollection<EnrolledTemplateRef> candidates, IdentifyOptions options, CancellationToken ct)
    {
        // Match the first candidate, if any.
        var first = candidates.FirstOrDefault();
        return Task.FromResult(first is null
            ? new BiometricMatchResult(false, null, null, 0, 0, 1)
            : new BiometricMatchResult(true, first.TemplateId, first.UserId, 0.99, 0.99, 1));
    }

    public Task<BiometricEnrollmentResult> EnrollAsync(EnrollmentRequest request, CancellationToken ct)
    {
        var id = $"null-{Convert.ToHexString(RandomNumberGenerator.GetBytes(8)).ToLowerInvariant()}";
        return Task.FromResult(new BiometricEnrollmentResult(Ok: true, TemplateId: id, FailureReason: null));
    }

    public Task<bool> RemoveTemplateAsync(string templateId, CancellationToken ct) => Task.FromResult(true);
    public Task<DeviceHealthSnapshot> GetHealthAsync(CancellationToken ct)
        => Task.FromResult(new DeviceHealthSnapshot(DateTimeOffset.UtcNow, 0, "null-1.0"));
}

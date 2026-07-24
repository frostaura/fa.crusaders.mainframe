namespace Crusaders.Mainframe.Api.Biometric;

public enum BiometricDeviceKind { Fingerprint, Face, Multi }
public enum BiometricDeviceState { Connected, Disconnected, Faulted }

public interface IBiometricDevice
{
    string DeviceId { get; }
    BiometricDeviceKind Kind { get; }
    BiometricDeviceState State { get; }

    Task<BiometricCapture> CaptureAsync(CaptureOptions options, CancellationToken ct);
    Task<BiometricMatchResult> IdentifyAsync(BiometricCapture capture, IReadOnlyCollection<EnrolledTemplateRef> candidates, IdentifyOptions options, CancellationToken ct);
    Task<BiometricEnrollmentResult> EnrollAsync(EnrollmentRequest request, CancellationToken ct);
    Task<bool> RemoveTemplateAsync(string templateId, CancellationToken ct);
    Task<DeviceHealthSnapshot> GetHealthAsync(CancellationToken ct);
}

public sealed record CaptureOptions(int MaxAttempts = 3, int MinQuality = 60);
public sealed record IdentifyOptions(double MinConfidence = 0.85, double MinLiveness = 0.6);
public sealed record EnrollmentRequest(Guid TenantId, Guid UserId, Guid AdminUserId, string? FingerLabel, string ConsentReceiptHash, int MinSamples = 3);

public sealed record BiometricCapture(byte[] Bytes, int Quality, int LatencyMs);
public sealed record BiometricMatchResult(bool Matched, string? MatchedTemplateId, Guid? MatchedUserId, double Confidence, double LivenessScore, int LatencyMs);
public sealed record BiometricEnrollmentResult(bool Ok, string? TemplateId, string? FailureReason);
public sealed record EnrolledTemplateRef(string TemplateId, Guid UserId);
public sealed record DeviceHealthSnapshot(DateTimeOffset LastSeenUtc, int FailedReadsLastHour, string FirmwareVersion);

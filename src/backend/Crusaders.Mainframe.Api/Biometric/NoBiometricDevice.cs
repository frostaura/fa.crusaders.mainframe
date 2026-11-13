namespace Crusaders.Mainframe.Api.Biometric;

/// <summary>
/// The biometric device of a deployment that has none: it captures nothing, enrols nobody and
/// matches nobody (BP-09).
///
/// <para>
/// <b>Why it exists.</b> <see cref="NullBiometricDevice"/> is the CI and development simulator, and
/// it answers every identification with the FIRST enrolled candidate at 0.99 confidence. It used to
/// be registered unconditionally, Production included, so an admin calling the courtside
/// biometric match there would have checked in — and charged — whichever member happened to be
/// first. Production now gets this device unless a real driver is configured, and the simulator
/// is honoured only in Development and Testing (<see cref="BiometricDrivers"/>).
/// </para>
/// </summary>
public sealed class NoBiometricDevice : IBiometricDevice
{
    /// <summary>The refusal an enrolment gets: there is no reader to enrol on.</summary>
    public const string Unavailable = "biometric_unavailable";

    public string DeviceId => "none";
    public BiometricDeviceKind Kind => BiometricDeviceKind.Fingerprint;
    public BiometricDeviceState State => BiometricDeviceState.Disconnected;

    public Task<BiometricCapture> CaptureAsync(CaptureOptions options, CancellationToken ct)
        => Task.FromResult(new BiometricCapture(Array.Empty<byte>(), Quality: 0, LatencyMs: 0));

    public Task<BiometricMatchResult> IdentifyAsync(BiometricCapture capture, IReadOnlyCollection<EnrolledTemplateRef> candidates, IdentifyOptions options, CancellationToken ct)
        => Task.FromResult(new BiometricMatchResult(false, null, null, 0, 0, 0));

    public Task<BiometricEnrollmentResult> EnrollAsync(EnrollmentRequest request, CancellationToken ct)
        => Task.FromResult(new BiometricEnrollmentResult(Ok: false, TemplateId: null, FailureReason: Unavailable));

    public Task<bool> RemoveTemplateAsync(string templateId, CancellationToken ct) => Task.FromResult(true);

    public Task<DeviceHealthSnapshot> GetHealthAsync(CancellationToken ct)
        => Task.FromResult(new DeviceHealthSnapshot(DateTimeOffset.MinValue, 0, "none"));
}

/// <summary>Which <see cref="IBiometricDevice"/> a deployment runs, from <c>Biometric:Driver</c>.</summary>
public static class BiometricDrivers
{
    /// <summary>The configuration key.</summary>
    public const string Key = "Biometric:Driver";

    /// <summary>The simulator's name: <see cref="NullBiometricDevice"/>.</summary>
    public const string Simulator = "Null";

    /// <summary>
    /// The device for this environment: the simulator only where it was asked for AND the
    /// environment is Development or Testing; <see cref="NoBiometricDevice"/> everywhere else,
    /// including a Production deployment that copied the development value. No real driver is
    /// built yet, so every other value is "none".
    /// </summary>
    public static IBiometricDevice For(string? driver, IHostEnvironment env)
    {
        var simulatorAllowed = env.IsDevelopment() || env.IsEnvironment("Testing");
        return simulatorAllowed && string.Equals(driver, Simulator, StringComparison.OrdinalIgnoreCase)
            ? new NullBiometricDevice()
            : new NoBiometricDevice();
    }
}

# Biometric Peripheral Abstraction

The .NET app runs on the same physical machine as a biometric peripheral (fingerprint reader and/or face camera). The app accesses it via a clean abstraction so the SDK can change without rewriting scheduling logic.

## Identification triple-stack (per [client blueprint](../client-blueprints/Crusaders-Blueprint-2026-05-Rev2.md) B.1)

The courtside terminal accepts three identification methods, any of which the player can opt into in their profile:

1. **Biometric** (fingerprint / face) — see the rest of this document.
2. **Personal PIN** — 4–6-digit code the player sets in their profile, entered on the touchpad keypad.
3. **Phone-displayed QR / short-lived signed token** — the player's PWA generates a signed 60-second token; the courtside camera scans the QR. Verification stays local.

A player can have multiple methods enabled. Failed attempt with one doesn't invalidate the booking — they try the next. Implementation order: PIN ships first (no hardware needed), then QR (modest UI + webcam library), biometric stays as-is, face deferred until vendor SDK lands. See `client-blueprint-deltas.md` § 8.6.

## Core principles
1. **Templates stay on-premises.** The biometric template (the cryptographic representation of the fingerprint / face embedding) never leaves the local machine. Only match results, hashes, and metadata travel over the wire to the cloud backend.
2. **Driver-agnostic interface.** Higher layers depend on `IBiometricDevice`, never on a vendor SDK directly.
3. **A null driver is a first-class implementation.** `NullBiometricDevice` lets developers and CI run the entire booking flow without hardware.
4. **Privacy by design.** Templates are encrypted at rest with a per-machine key. Enrollments require explicit player consent (logged). Templates are deletable on player request.

## Interfaces (.NET, namespace `Crusaders.Mainframe.Biometric`)

```csharp
public interface IBiometricDevice : IAsyncDisposable
{
    string DeviceId { get; }
    BiometricDeviceKind Kind { get; }              // Fingerprint, Face, Multi
    BiometricDeviceState State { get; }            // Connected, Disconnected, Faulted
    event EventHandler<BiometricDeviceStateChangedEventArgs> StateChanged;

    Task<BiometricCaptureResult> CaptureAsync(
        CaptureOptions options,
        CancellationToken ct);

    Task<BiometricMatchResult> IdentifyAsync(
        BiometricCapture capture,
        IReadOnlyCollection<EnrolledTemplateRef> candidates,
        IdentifyOptions options,
        CancellationToken ct);

    Task<BiometricEnrollmentResult> EnrollAsync(
        EnrollmentRequest request,
        CancellationToken ct);

    Task<bool> RemoveTemplateAsync(string templateId, CancellationToken ct);

    Task<DeviceHealthSnapshot> GetHealthAsync(CancellationToken ct);
}

public interface IEnrolledTemplateStore
{
    Task<EnrolledTemplateRef> StoreAsync(
        Guid tenantId,
        Guid userId,
        BiometricTemplateBlob template,
        CancellationToken ct);

    Task<IReadOnlyList<EnrolledTemplateRef>> ListForUserAsync(
        Guid tenantId, Guid userId, CancellationToken ct);

    Task DeleteAsync(string templateId, CancellationToken ct);
}

public interface IBiometricMatchPolicy
{
    // Tenant-configurable thresholds (FAR/FRR), liveness requirements, etc.
    BiometricMatchPolicySnapshot Resolve(Guid tenantId);
}
```

Records:
- `BiometricCapture` — opaque, includes a quality score and capture metadata.
- `BiometricMatchResult` — `Matched` (bool), `MatchedTemplateId`, `Confidence`, `LivenessScore`, `LatencyMs`, `RawDriverData` (debug-only, redacted in logs).
- `EnrollmentRequest` — `TenantId`, `UserId`, `ConsentReceiptHash`, `MinAcceptableQuality`.
- `DeviceHealthSnapshot` — `LastSeenUtc`, `TempC` (if available), `FailedReadsLastHour`, `FirmwareVersion`.

## Implementations to ship
- `NullBiometricDevice` — returns deterministic match results based on a config-injected lookup. Used in dev, CI, and as a graceful fallback when hardware is absent.
- `MockSimulatorBiometricDevice` — for the demo flow: prints "tap your finger" to a console, accepts a keystroke as the "match", returns the configured user.
- `<Vendor>BiometricDevice` — to be added once the hardware is selected. Candidates: DigitalPersona U.are.U (good .NET SDK), Suprema BioMini (well-documented, ZA distributors), ZKTeco SilkID (cheap, weaker SDK). Decision deferred until first hardware purchase.

## Selecting hardware (decision deferred)
Evaluate against:
- **.NET 10 SDK quality** — first-party or maintained third-party wrapper? Avoid vendors that ship only Win32 C SDKs without async support.
- **Linux support** — the deploy target runs Docker on Linux; the device driver must work in a Linux container. Some vendor SDKs are Windows-only — those are disqualified.
- **Liveness detection** — fingerprint readers must reject silicone; face cameras must do anti-spoofing. Without this, biometric attestation is theatre.
- **Local availability in South Africa** — replacement parts in <1 week.
- **Per-unit cost** — multiplied by court count; a 4-court Crusaders deploy at R5k each is R20k of hardware. Stay sane.

## Container & device passthrough
The .NET app runs in Docker. To reach a USB device on the host, `docker-compose.yml` will need:
```yaml
devices:
  - "/dev/bus/usb/<bus>/<device>:/dev/bus/usb/<bus>/<device>"
# OR more permissively (only if the device path is dynamic):
privileged: true
```
Document the chosen approach in the project's `docker-compose.yml` once the SDK is selected. Avoid `privileged: true` if a specific device path works — it's a meaningful blast-radius reduction.

## Data flow at booking time
1. Player approaches court at booking start.
2. Courtside terminal (the same .NET app, running in "court mode") asks `IBiometricDevice.CaptureAsync()`.
3. The terminal queries the local `IEnrolledTemplateStore` for the candidate set: all players with a booking on this court within `[now - grace, now + slice_duration]`.
4. Calls `IBiometricDevice.IdentifyAsync(capture, candidates)`. The match runs **locally** — no template leaves the machine.
5. On match: terminal flips a relay (or sends an MQTT/Modbus message — out of scope for this spec) to turn lights on, posts `LightsOnEvent` to the backend, backend updates the booking and emits a webhook.
6. On no-match within grace: backend's scheduled job marks the booking `no_show`, applies the penalty, sends the email.

## Admin-led enrollment flow
Biometric enrollment is **always admin-witnessed and member-present-in-person** — there is no remote enrollment path. The peripheral physically lives at the club, the member must be there to provide samples, and an admin signs in to drive the session. This shape is enforced at the API (only admins can call `POST /enrollments`).

**Steps**
1. Admin signs in on a tenant machine that has a peripheral attached.
2. Admin opens the member's profile → "Enroll biometric" → starts a session.
3. UI shows the consent text (versioned). Member acknowledges; the version hash + member-id + admin-id + timestamp are recorded as the consent receipt.
4. UI prompts the member for sample 1. Member places finger / faces camera. The driver returns a `BiometricCapture` with a quality score.
5. If quality below threshold, retry up to 5x with a clear "try again — keep your finger flat / well-lit" hint.
6. Repeat for N samples (vendor-driven, typically 3–5) to build a robust template.
7. Driver combines captures into a single template; `IEnrolledTemplateStore.StoreAsync` writes `{tenant_id, user_id, template_id, created_by_admin_id, consent_receipt_hash, finger_label}` to local storage.
8. UI confirms enrollment, offers to enroll a backup finger (recommended; optional).
9. Member's profile thereafter shows `Biometric: 2 fingers enrolled`.

**State machine** (per session)
`requested → consent_acknowledged → capturing(i/N) → captured(i) → capturing(i+1/N) → enrolled` with abort transitions to `failed_quality` or `abandoned` from any capturing state.

**Multiple templates per member.** A member may have several templates (e.g. left index + right thumb). At match-time the candidate set is all templates belonging to members with a booking on this court within the grace window. More templates → better recall, slightly more false-accept risk → tune via the tenant's `BiometricMatchPolicy` thresholds.

**Re-enrollment.** An admin can replace an existing template (quality drift, finger injury, etc.). Replacement creates a new `template_id` and deletes the old one in the same operation, both audit-logged. The member's match continuity is preserved.

**Deferred until hardware is in hand.** All of the above is backed by `NullBiometricDevice` and `MockSimulatorBiometricDevice` in the meantime — the entire flow (UI, state machine, audit trail, store) is testable end-to-end without real hardware. The vendor driver is the *only* swap-in needed when hardware arrives.

## Privacy & consent
- Enrollment requires the player to read and accept a consent receipt (versioned text). The hash of the accepted version is stored alongside the template — disputes are resolvable.
- The player can delete all their templates from their account settings; backend issues a delete to every machine that holds a copy via a signed command.
- Templates are NEVER backed up to the SaaS cloud. They are tenant- and machine-local. If a machine fails, players re-enroll on the new machine. This is intentional — it's the bright privacy line.
- All biometric capture, match, and enrollment events are audit-logged (not the template, just the metadata).

## Failure modes & graceful degradation
- **Device disconnected:** UI shows "Biometric check unavailable — please ask the duty admin to mark you arrived." Admin-arrival action is logged with reason.
- **Quality too low for confident match:** prompt for re-capture up to 3 times, then fall back to admin-arrival.
- **Multi-match (two candidates above threshold):** reject, prompt for re-capture, log incident.
- **Driver crash:** auto-restart up to 3x within 5 min; if still down, mark device `Faulted`; backend auto-credits all impacted bookings during the outage window; admin paged.

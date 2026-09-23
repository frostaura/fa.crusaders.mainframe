import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { endpoints, ApiError, type WebAuthnCredentialRow, type MyProfile } from "../lib/api";
import { useProfile } from "../lib/profile";
import { useToast } from "../components/Toast";
import { ConfirmButton } from "../components/ConfirmButton";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { PageHeader, PageShell, Section } from "../components/ui/page-shell";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import { StateBlock } from "../components/ui/state-block";
import { TextLink } from "../components/ui/text-link";
import { Camera, Fingerprint, Plus, Trash } from "../components/ui/icons";
import { isPasskeySupported, registerPasskey } from "../lib/webauthn";
import { ChangePasswordForm } from "./ChangePassword";
import { cn } from "../lib/utils";
import { describeFailure } from "../lib/errors";
// doors: member — W1.8, the member's own door history, on the page they already think of
// as their record. Gated on the club having a door at all; see MemberDoorHistory below.
import { DoorHistoryCard } from "../components/member-door/DoorHistoryCard";
import { useDoorsFlag } from "../components/member-door/useMemberDoor";
// item 16 — the guide's third recall point. See the note beside the link.
import { GUIDE_LINK_LABEL, GUIDE_PATH, GUIDE_TILE_HINT } from "../lib/onboardingCopy";

const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

/**
 * What `PUT /api/v1/me/profile` will actually accept for a name.
 *
 * <p>
 * The rule existed only on the server: Save stayed enabled for three spaces, the API answered
 * `400 full_name_invalid`, the toast said "Couldn't save name.", and a reload silently put the
 * old name back. Nothing on the screen ever said what a valid name was. Stated here, enforced
 * here, and named in the toast if the server still refuses.
 * </p>
 */
const NAME_MIN = 2;
const NAME_MAX = 120;

/**
 * How long the page waits, with no profile and no read in flight, before it says the read
 * failed. The provider owns the read and reports only `loading`, so "never asked yet" and
 * "asked and failed" look the same for a moment on mount; this is that moment, not a delay
 * anybody waits through — a read that answers clears it.
 */
const STALLED_AFTER_MS = 800;

/** True once the profile has been missing, with nothing in flight, for {@link STALLED_AFTER_MS}. */
function useStalled(missing: boolean): [boolean, () => void] {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (!missing) return undefined;
    const timer = window.setTimeout(() => setStalled(true), STALLED_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [missing]);
  return [stalled && missing, () => setStalled(false)];
}

export default function ProfilePage() {
  const { profile, loading, refresh } = useProfile();
  const [failed, clearFailed] = useStalled(!profile && !loading);

  return (
    <PageShell width="narrow">
      <PageHeader
        title="Profile"
        description="Your photo and name are what other players see on the booking grid and on every booking."
      />
      <StateBlock
        loading={!profile && !failed}
        error={!profile && failed ? new Error("profile read failed") : null}
        action={failed ? "load your profile" : "your profile"}
        onRetry={() => { clearFailed(); void refresh(); }}
        skeleton={<ProfileSkeleton />}
        className="gap-8"
      >
        {profile ? <ProfileSections profile={profile} /> : null}
      </StateBlock>
    </PageShell>
  );
}

function ProfileSkeleton() {
  return (
    <Card className="px-4 sm:px-6">
      <div className="flex items-center gap-5">
        <Skeleton className="size-24 shrink-0 rounded-full" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
      <Skeleton className="h-touch" />
    </Card>
  );
}

function ProfileSections({ profile }: { profile: MyProfile }) {
  return (
    <>
      <Section title="Your details">
        <IdentityCard profile={profile} />
      </Section>
      <PasswordCard />
      <MemberDoorHistory />
      <PasskeysCard />
      {/*
        Item 16's third recall point. NN/g's requirement is that dismissible help stay
        reachable from a permanent place; the other two are the home tile and the link under
        the code. This is the one a member reaches for when they are already looking for
        "where is the thing that explains this", which for most people is the account screen.
      */}
      <div className="flex flex-col items-start">
        <TextLink to={GUIDE_PATH} variant="standalone">{GUIDE_LINK_LABEL}</TextLink>
        <p className="text-sm text-text-secondary">{GUIDE_TILE_HINT}.</p>
      </div>
    </>
  );
}

/** Photo, email, membership number and name — what the club and the other players see. */
function IdentityCard({ profile }: { profile: MyProfile }) {
  return (
    <Card className="px-4 sm:px-6">
      <PhotoPicker profile={profile} />
      <div className="border-t border-border pt-4">
        {/* Keyed on the saved name, so a name the server settles on resets the buffer. */}
        <NameForm key={profile.full_name ?? ""} profile={profile} />
      </div>
    </Card>
  );
}

/**
 * The photo button's hover scrim. The theme's `overlay` colour at a FIXED 65% — not
 * `bg-overlay`, whose theme alpha composites to 3.1:1 over a white photo. The photo is a
 * member's own upload and can be anything; 65% measures ≥5.5:1 in both themes over pure white
 * (affordance.test.ts computes it from the tokens) and still shows the face.
 */
const SCRIM = "absolute inset-0 flex flex-col items-center justify-center gap-1 text-xs font-medium text-primary-ink "
  + "bg-[rgb(var(--color-overlay)/0.65)] transition-opacity duration-fast ease-standard motion-reduce:transition-none";

function PhotoPicker({ profile }: { profile: MyProfile }) {
  const { refresh, setLocal } = useProfile();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFile = async (file: File) => {
    if (!ACCEPT.split(",").includes(file.type)) { toast.push({ tone: "danger", text: "Unsupported image type." }); return; }
    if (file.size > MAX_BYTES) { toast.push({ tone: "danger", text: "Image must be under 5 MB." }); return; }

    // Optimistic preview while we upload.
    const objUrl = URL.createObjectURL(file);
    setPreviewUrl(objUrl);
    setUploading(true);
    try {
      const r = await endpoints.meUploadPhoto(file);
      setLocal({ ...profile, photo_url: r.photo_url });
      toast.push({ tone: "success", text: "Profile photo updated." });
      // Pull fresh profile in the background to keep state honest.
      void refresh();
    } catch (err) {
      const msg = err instanceof ApiError ? `Upload failed (${err.status}).` : "Upload failed.";
      toast.push({ tone: "danger", text: msg });
      setPreviewUrl(null);
    } finally {
      setUploading(false);
      // Free the blob URL after the upload completes.
      window.setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
    }
  };

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void handleFile(f);
    e.target.value = "";
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void handleFile(f);
  };

  const initial = (profile.full_name?.[0] ?? profile.email[0]).toUpperCase();
  const showUrl = previewUrl ?? profile.photo_url;

  return (
    <div className="flex items-center gap-5">
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        disabled={uploading}
        aria-busy={uploading || undefined}
        aria-label="Change profile photo"
        className={cn(
          "no-lift group relative size-24 shrink-0 overflow-hidden rounded-full border-2 transition-colors duration-fast ease-standard motion-reduce:transition-none sm:size-28",
          dragOver ? "border-accent-strong ring-4 ring-accent-soft" : "border-border",
          uploading ? "cursor-progress" : "hover:border-accent-strong",
        )}
      >
        {showUrl ? (
          <img src={showUrl} alt="" className="size-full object-cover" />
        ) : (
          <span className="flex size-full items-center justify-center bg-bg-muted text-3xl font-semibold text-text-secondary">{initial}</span>
        )}
        <span className={cn(SCRIM, uploading ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100")}>
          {uploading ? <Spinner className="size-5" /> : <Camera size={20} aria-hidden="true" />}
          {uploading ? null : <span>Change</span>}
        </span>
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="break-words text-sm font-medium text-text-primary">{profile.email}</p>
        {profile.membership_number && (
          <p className="font-mono text-xs text-text-muted">{profile.membership_number}</p>
        )}
        <p className="mt-2 text-xs text-text-secondary">
          Tap the photo, or drop an image on it. PNG, JPG, WEBP or GIF, up to 5 MB.
        </p>
      </div>
      <input ref={fileRef} type="file" accept={ACCEPT} onChange={onChange} className="hidden" tabIndex={-1} aria-hidden="true" />
    </div>
  );
}

function NameForm({ profile }: { profile: MyProfile }) {
  const { setLocal } = useProfile();
  const toast = useToast();
  // Local-only edits for the name; commits via Save.
  const [fullName, setFullName] = useState(profile.full_name ?? "");
  const [savingName, setSavingName] = useState(false);

  const trimmedName = fullName.trim();
  const nameTooShort = trimmedName.length < NAME_MIN;
  const nameUnchanged = trimmedName === (profile.full_name ?? "").trim();

  const saveName = async () => {
    if (savingName || nameUnchanged || nameTooShort) return;
    setSavingName(true);
    try {
      const r = await endpoints.meUpdateProfile({ fullName: trimmedName });
      setLocal({ ...profile, full_name: r.full_name });
      toast.push({ tone: "success", text: "Name updated." });
    } catch (err) {
      toast.push({
        tone: "danger",
        text: describeFailure(err, {
          codes: { full_name_invalid: `Your name must be between ${NAME_MIN} and ${NAME_MAX} characters.` },
          action: "save your name",
        }),
      });
    } finally { setSavingName(false); }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void saveName(); }}>
      <Field controlId="fullName">
        <FieldLabel>Full name</FieldLabel>
        <Input
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          placeholder="As it appears on the schedule"
          maxLength={NAME_MAX}
          autoComplete="name"
        />
        <FieldDescription>At least {NAME_MIN} characters. Shown to other players on the booking grid.</FieldDescription>
      </Field>
      {/* Disabled only while the name is not one the server would take — the rule is stated
          right above it. While it saves it is pending, never disabled, so focus stays put. */}
      <div className="flex justify-end">
        <Button type="submit" variant="secondary" pending={savingName} disabled={nameUnchanged || nameTooShort}>
          Save
        </Button>
      </div>
    </form>
  );
}

/**
 * The member's own door history, below the password and above the passkeys.
 *
 * <p>
 * That place is deliberate: door entry is closer to "what the club knows about me" than
 * to credentials, and this card is the POPIA s.23 right served as a product feature
 * rather than as an email somebody has to answer by hand.
 * </p>
 *
 * <p>
 * At a club with no gate it does not render at all — not an empty card, not a heading
 * with a sentence under it. A member of a club that has never owned a door has no door
 * history and should not be told they have none.
 * </p>
 *
 * <p>
 * <b>D11 — but a `/me/door` that FAILED is not a club with no gate, and it used to be
 * treated as one.</b> The flag answered false on any error, so one unlucky request deleted
 * a member's whole record from this page while `/me/door/history` was answering perfectly.
 * The two reads are independent and the card is now gated on what it can see for itself:
 * with the door question unanswered it renders only once it has rows, which keeps the
 * no-gate club silent without letting a failed read silence anybody else.
 * </p>
 */
function MemberDoorHistory() {
  const doors = useDoorsFlag();
  if (doors === "no") return null;
  return <DoorHistoryCard onlyWithRows={doors === "unknown"} />;
}

/**
 * Somewhere for a member to change their own password.
 *
 * <p>
 * There was nowhere. This page offered a photo, a name and passkeys, and the word "password"
 * appeared on it nowhere at all — so a temporary password an admin had emailed in plaintext was
 * the account's permanent credential, with no self-service reset either.
 * </p>
 */
function PasswordCard() {
  const [open, setOpen] = useState(false);

  return (
    <Section
      title="Password"
      description="Change the password you sign in with. We'll email you whenever it changes, so you'd know if somebody else did it."
    >
      <Card className="px-4 sm:px-6">
        {open ? (
          <ChangePasswordForm onDone={() => setOpen(false)} onCancel={() => setOpen(false)} />
        ) : (
          <div>
            <Button variant="outline" onClick={() => setOpen(true)}>Change password</Button>
          </div>
        )}
      </Card>
    </Section>
  );
}

const PASSKEY_INTRO = "One-tap sign-in with your device's biometrics or a security key. Add as many as you like — phone, laptop, key.";
const PASSKEY_UNSUPPORTED = "This browser doesn't support passkeys. Use a recent Chrome, Safari, Edge or Firefox on a device with biometrics or a security key.";

type PasskeyRead = { rows: WebAuthnCredentialRow[] | null; error: unknown; loading: boolean };

/**
 * The member's passkeys, read honestly. The read used to swallow its own failure ("non-blocking")
 * and leave the list at `[]`, so a failed read told the member they had no passkeys — an empty
 * collection is not an answer. It is now three states: reading, failed (with a retry), and the
 * list — which may genuinely be empty.
 */
function usePasskeys(supported: boolean) {
  const [read, setRead] = useState<PasskeyRead>({ rows: null, error: null, loading: supported });
  const load = useCallback(async () => {
    setRead((r) => ({ ...r, loading: true }));
    try { setRead({ rows: await endpoints.webauthnList(), error: null, loading: false }); }
    catch (error) { setRead((r) => ({ rows: r.rows, error, loading: false })); }
  }, []);
  useEffect(() => { if (supported) void load(); }, [supported, load]);
  return { ...read, load };
}

function PasskeysCard() {
  const supported = isPasskeySupported();
  const passkeys = usePasskeys(supported);

  if (!supported) {
    return (
      <Section title="Passkeys">
        <Card className="px-4 sm:px-6">
          <p className="text-sm text-text-secondary">{PASSKEY_UNSUPPORTED}</p>
        </Card>
      </Section>
    );
  }

  return (
    <Section title="Passkeys" description={PASSKEY_INTRO}>
      <Card className="px-4 sm:px-6">
        <StateBlock
          loading={passkeys.rows === null && passkeys.loading}
          error={passkeys.rows === null ? passkeys.error : null}
          action={passkeys.error ? "load your passkeys" : "your passkeys"}
          onRetry={() => void passkeys.load()}
          empty={passkeys.rows !== null && passkeys.rows.length === 0}
          emptyIcon={Fingerprint}
          emptyTitle="No passkeys yet"
          emptyHint="Add one below to sign in with a touch or a glance."
          skeleton={<div className="flex flex-col gap-3">{[0, 1].map((i) => <Skeleton key={i} className="h-14" />)}</div>}
        >
          <PasskeyList rows={passkeys.rows ?? []} onChanged={passkeys.load} />
        </StateBlock>
        <div className="border-t border-border pt-4">
          <AddPasskey onAdded={passkeys.load} />
        </div>
      </Card>
    </Section>
  );
}

const shortDate = (iso: string, withYear: boolean) =>
  new Date(iso).toLocaleDateString(undefined, withYear ? { day: "2-digit", month: "short", year: "numeric" } : { day: "2-digit", month: "short" });

function PasskeyList({ rows, onChanged }: { rows: WebAuthnCredentialRow[]; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const remove = async (id: string) => {
    try {
      await endpoints.webauthnDelete(id);
      await onChanged();
      toast.push({ tone: "success", text: "Passkey removed." });
    } catch { toast.push({ tone: "danger", text: "Couldn't remove passkey." }); }
  };
  return (
    <ul className="divide-y divide-border">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center gap-3 py-3 first:pt-0">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-info-soft text-info-strong">
            <Fingerprint size={20} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-text-primary">{r.label}</p>
            <p className="text-xs text-text-muted">
              {`Added ${shortDate(r.created_at, true)}`}
              {r.last_used_at ? ` · Last used ${shortDate(r.last_used_at, false)}` : " · Never used"}
              {r.transports ? ` · ${r.transports}` : ""}
            </p>
          </div>
          <ConfirmButton
            idleLabel={<span className="inline-flex items-center gap-1"><Trash size={16} aria-hidden="true" /> Remove</span>}
            confirmLabel="Tap to confirm"
            onConfirm={() => remove(r.id)}
            tone="danger"
          />
        </li>
      ))}
    </ul>
  );
}

function AddPasskey({ onAdded }: { onAdded: () => Promise<void> }) {
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [adding, setAdding] = useState(false);

  const add = async () => {
    if (adding) return;
    if (!label.trim()) { toast.push({ tone: "warning", text: "Give the passkey a label so you can tell devices apart." }); return; }
    setAdding(true);
    try {
      await registerPasskey(label.trim());
      setLabel("");
      await onAdded();
      toast.push({ tone: "success", text: "Passkey added." });
    } catch (err) {
      if (err instanceof Error && err.message === "passkey_cancelled") return;
      toast.push({ tone: "danger", text: "Couldn't add passkey." });
    } finally { setAdding(false); }
  };

  return (
    <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
      <Field controlId="passkey-label">
        <FieldLabel>Label</FieldLabel>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. iPhone, MacBook, YubiKey" />
          <Button type="submit" variant="secondary" icon={<Plus aria-hidden="true" />} pending={adding} className="shrink-0">
            Add passkey
          </Button>
        </div>
      </Field>
    </form>
  );
}

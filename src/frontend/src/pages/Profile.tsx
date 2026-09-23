import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type ComponentProps, type DragEvent, type ReactNode } from "react";
import { endpoints, type WebAuthnCredentialRow, type MyProfile } from "../lib/api";
import { useProfile } from "../lib/profile";
import { useAsyncAction } from "../lib/useAsyncAction";
import { useToast } from "../components/Toast";
import { ConfirmButton } from "../components/ConfirmButton";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { PageHeader, PageShell } from "../components/ui/page-shell";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import { StateBlock } from "../components/ui/state-block";
import { TextLink } from "../components/ui/text-link";
import { BookOpen, Camera, Fingerprint, Plus, WarningCircle } from "../components/ui/icons";
import { isPasskeySupported, registerPasskey } from "../lib/webauthn";
import { ChangePasswordForm } from "./ChangePassword";
import { cn } from "../lib/utils";
// doors: member — W1.8, the member's own door history, on the page they already think of
// as their record. Gated on the club having a door at all; see MemberDoorHistory below.
import { DoorHistoryCard } from "../components/member-door/DoorHistoryCard";
import { useDoorsFlag } from "../components/member-door/useMemberDoor";
// R23 — an admin's own email alerts: the same switches Settings shows, on the page people look
// for "my emails" first.
import { EmailAlertSwitches } from "../components/notifications/EmailAlertSwitches";
import { EMAIL_ALERTS_COPY } from "../lib/notificationsCopy";
// item 16 — the guide's third recall point. See the note beside the link.
import { GUIDE_LINK_LABEL, GUIDE_PATH, GUIDE_TILE_HINT } from "../lib/onboardingCopy";
import {
  DETAILS_TITLE, NAME_HINT, NAME_INVALID, NAME_LABEL, NAME_MAX, NAME_MIN, NAME_PLACEHOLDER, NAME_SAVE, NAME_SAVED,
  PASSKEYS_TITLE, PASSKEY_ADD, PASSKEY_ADDED, PASSKEY_EMPTY_HINT, PASSKEY_EMPTY_TITLE, PASSKEY_INTRO,
  PASSKEY_NAME_HINT, PASSKEY_NAME_LABEL, PASSKEY_NAME_MISSING, PASSKEY_NAME_PLACEHOLDER, PASSKEY_REMOVE,
  PASSKEY_REMOVED, PASSKEY_UNSUPPORTED, PASSWORD_DESCRIPTION, PASSWORD_OPEN, PASSWORD_TITLE,
  PHOTO_ACCEPT, PHOTO_BAD_TYPE, PHOTO_BUTTON, PHOTO_CHANGE_LABEL, PHOTO_HINT, PHOTO_MAX_BYTES, PHOTO_TOO_BIG,
  PHOTO_UPDATED, PHOTO_UPLOADING, PROFILE_DESCRIPTION, PROFILE_TITLE, passkeyMeta, passkeyRemoveConsequence,
} from "../lib/profileCopy";

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
      <PageHeader title={PROFILE_TITLE} description={PROFILE_DESCRIPTION} />
      <StateBlock
        loading={!profile && !failed}
        error={!profile && failed ? new Error("profile read failed") : null}
        action={failed ? "load your profile" : "your profile"}
        onRetry={() => { clearFailed(); void refresh(); }}
        skeleton={<ProfileSkeleton />}
        className="gap-6"
      >
        {profile ? <ProfileSections profile={profile} /> : null}
      </StateBlock>
    </PageShell>
  );
}

function ProfileSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Card className="px-4 sm:px-6">
        <Skeleton className="h-6 w-32" />
        <div className="flex items-center gap-5">
          <Skeleton className="size-24 shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
        <Skeleton className="h-touch" />
      </Card>
      <Skeleton className="h-36 rounded-xl" />
    </div>
  );
}

/**
 * One section of the page, as a card: its `h2` and description in the card's header, the
 * body below. Every section on Profile — and the door
 * history card beside them — has this one anatomy, so the page reads as one place rather than
 * as headings floating over boxes of different shapes. A named region, so each part can be
 * reached from a landmark list.
 */
function ProfileCard(props: { title: string; description?: ReactNode; children: ReactNode }) {
  const { title, description, children } = props;
  const id = useId();
  return (
    <Card role="region" aria-labelledby={id}>
      <CardHeader>
        <CardTitle asChild><h2 id={id}>{title}</h2></CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}

/*
 * The last row is item 16's third recall point: dismissible help must stay reachable from a
 * permanent place. The other two are the home tile and the link under the code; this is the one
 * a member reaches for when already looking for the thing that explains this, which for most
 * people is the account screen.
 */
function ProfileSections({ profile }: { profile: MyProfile }) {
  return (
    <>
      <ProfileCard title={DETAILS_TITLE}>
        <PhotoPicker profile={profile} />
        <div className="border-t border-border pt-4">
          {/* Keyed on the saved name, so a name the server settles on resets the buffer. */}
          <NameForm key={profile.full_name ?? ""} profile={profile} />
        </div>
      </ProfileCard>
      <PasswordCard />
      <MemberDoorHistory />
      <PasskeysCard />
      {profile.is_admin ? (
        <ProfileCard title={EMAIL_ALERTS_COPY.profileTitle} description={EMAIL_ALERTS_COPY.description}>
          <EmailAlertSwitches />
          <p className="text-sm text-text-secondary">{EMAIL_ALERTS_COPY.feedNote}</p>
        </ProfileCard>
      ) : null}
      <div className="flex items-start gap-3 rounded-xl border border-dashed border-border px-4 py-3 sm:px-6">
        <BookOpen aria-hidden="true" size={20} className="mt-3 shrink-0 text-text-muted" />
        <div className="flex min-w-0 flex-col items-start">
          <TextLink to={GUIDE_PATH} variant="standalone">{GUIDE_LINK_LABEL}</TextLink>
          <p className="text-sm text-text-secondary">{GUIDE_TILE_HINT}.</p>
        </div>
      </div>
    </>
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

/** Why a chosen file cannot be used, or null. Said beside the photo, not in a passing toast. */
function photoProblem(file: File): string | null {
  if (!PHOTO_ACCEPT.split(",").includes(file.type)) return PHOTO_BAD_TYPE;
  if (file.size > PHOTO_MAX_BYTES) return PHOTO_TOO_BIG;
  return null;
}

/**
 * The upload, optimistic: the chosen image is on the avatar at once, rolled back if the club
 * refuses it. The blob URL is freed once the real one has replaced it.
 */
function usePhotoUpload(profile: MyProfile) {
  const { refresh, setLocal } = useProfile();
  const [preview, setPreview] = useState<string | null>(null);
  const blob = useRef<string | null>(null);
  const release = () => {
    const url = blob.current;
    blob.current = null;
    if (url) window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  useEffect(() => () => { if (blob.current) URL.revokeObjectURL(blob.current); }, []);
  const upload = useAsyncAction((file: File) => endpoints.meUploadPhoto(file), {
    optimistic: {
      apply: (file) => { blob.current = URL.createObjectURL(file); setPreview(blob.current); },
      rollback: () => { setPreview(null); release(); },
    },
    success: (r) => {
      setLocal({ ...profile, photo_url: r.photo_url });
      release();
      // Pull the fresh profile in the background to keep state honest.
      void refresh();
    },
    toast: { success: PHOTO_UPDATED, action: "upload your photo" },
  });
  return { upload, preview };
}

function PhotoPicker({ profile }: { profile: MyProfile }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const { upload, preview } = usePhotoUpload(profile);
  const [problem, setProblem] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const uploading = upload.pending;

  const take = (file: File | undefined) => {
    if (!file) return;
    const refused = photoProblem(file);
    setProblem(refused);
    if (!refused) void upload.run(file);
  };
  const choose = () => { if (!uploading) fileRef.current?.click(); };
  const onChange = (e: ChangeEvent<HTMLInputElement>) => { take(e.target.files?.[0]); e.target.value = ""; };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDragOver(false); take(e.dataTransfer.files?.[0]); };

  return (
    <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:items-center sm:gap-6 sm:text-left">
      <AvatarButton
        profile={profile}
        src={preview ?? profile.photo_url}
        uploading={uploading}
        dragOver={dragOver}
        onChoose={choose}
        drop={{ onDragOver: (e) => { e.preventDefault(); setDragOver(true); }, onDragLeave: () => setDragOver(false), onDrop }}
      />
      <div className="flex min-w-0 flex-1 flex-col items-center gap-1 sm:items-start">
        <p className="max-w-full break-words text-base font-semibold text-text-primary">{profile.full_name || profile.email}</p>
        <p className="max-w-full break-words text-sm text-text-secondary">{profile.email}</p>
        {profile.membership_number && (
          <p className="font-mono text-xs tracking-code text-text-muted">{profile.membership_number}</p>
        )}
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={choose}
          pending={uploading}
          icon={<Camera aria-hidden="true" />}
        >
          {PHOTO_BUTTON}
        </Button>
        <p className="mt-1 text-xs text-text-secondary">{PHOTO_HINT}</p>
        <p aria-live="polite" className="empty:hidden">
          {problem ? (
            <span className="inline-flex items-start gap-1.5 text-sm font-medium text-danger-strong">
              <WarningCircle size={16} weight="bold" aria-hidden="true" className="mt-0.5 shrink-0" />
              {problem}
            </span>
          ) : null}
        </p>
      </div>
      {/* Display none already hides it from assistive tech; the avatar and the button are the controls. */}
      <input ref={fileRef} type="file" accept={PHOTO_ACCEPT} onChange={onChange} className="hidden" tabIndex={-1} />
    </div>
  );
}

type AvatarButtonProps = {
  profile: MyProfile;
  src: string | null;
  uploading: boolean;
  dragOver: boolean;
  onChoose: () => void;
  drop: DropHandlers;
};

/** The three drag handlers, borrowed from the button's own props (no inline arrow types: lizard). */
type DropHandlers = Required<Pick<ComponentProps<"button">, "onDragOver" | "onDragLeave" | "onDrop">>;

/**
 * The avatar IS the control: a round photo with a camera badge that is always there (a phone
 * has no hover, so a scrim that appears on hover alone never told a member it was tappable),
 * the scrim on hover and focus for a mouse, and a spinner over the photo while it uploads.
 * `aria-busy` + `aria-disabled` while it works — never `disabled`, which would drop focus.
 */
function AvatarButton(props: AvatarButtonProps) {
  const { profile, src, uploading, dragOver, onChoose, drop } = props;
  const initial = (profile.full_name?.[0] ?? profile.email[0]).toUpperCase();
  const name = uploading ? PHOTO_CHANGE_LABEL + " — " + PHOTO_UPLOADING : PHOTO_CHANGE_LABEL;
  return (
    // aria-* FIRST: lizard's JSX reader gives up on a tag at its first hyphenated attribute and,
    // if an expression attribute came before it, replays that brace twice and loses count.
    <button
      aria-busy={uploading || undefined}
      aria-disabled={uploading || undefined}
      aria-label={name}
      type="button"
      onClick={onChoose}
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
      className={cn("no-lift group relative shrink-0 rounded-full", uploading && "cursor-progress")}
    >
      <span
        className={cn(
          "relative block size-24 overflow-hidden rounded-full border-2 transition-colors duration-fast ease-standard motion-reduce:transition-none sm:size-28",
          dragOver ? "border-accent-strong ring-4 ring-accent-soft" : "border-border group-hover:border-accent-strong",
        )}
      >
        {src ? (
          <img src={src} alt="" className="size-full object-cover" />
        ) : (
          <span className="flex size-full items-center justify-center bg-accent-soft text-3xl font-semibold text-accent-strong">{initial}</span>
        )}
        <PhotoScrim uploading={uploading} />
      </span>
      <CameraBadge />
    </button>
  );
}

/** Over the photo: "Change" on hover and focus, the spinner while it uploads. */
function PhotoScrim({ uploading }: { uploading: boolean }) {
  if (uploading) {
    return <span className={cn(SCRIM, "opacity-100")}><Spinner className="size-5" /></span>;
  }
  return (
    <span className={cn(SCRIM, "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100")}>
      <Camera size={20} aria-hidden="true" />
      <span>Change</span>
    </span>
  );
}

/** Always there, so the photo reads as tappable on a phone, which has no hover. Decorative. */
function CameraBadge() {
  return (
    <span aria-hidden="true" className="absolute bottom-0 right-0 flex size-9 items-center justify-center rounded-full border-2 border-bg-surface bg-primary text-primary-ink shadow-sm">
      <Camera size={16} weight="bold" />
    </span>
  );
}

function NameForm({ profile }: { profile: MyProfile }) {
  const { setLocal } = useProfile();
  // Local-only edits for the name; commits via Save.
  const [fullName, setFullName] = useState(profile.full_name ?? "");
  const trimmedName = fullName.trim();
  // `>` rather than `<`: lizard reads a bare `<` in a .tsx file as a JSX tag and swallows the file.
  const nameTooShort = NAME_MIN > trimmedName.length;
  const nameUnchanged = trimmedName === (profile.full_name ?? "").trim();

  const save = useAsyncAction(() => endpoints.meUpdateProfile({ fullName: trimmedName }), {
    success: (r) => setLocal({ ...profile, full_name: r.full_name }),
    toast: { success: NAME_SAVED, action: "save your name", codes: { full_name_invalid: NAME_INVALID } },
  });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => { e.preventDefault(); if (!nameUnchanged && !nameTooShort) void save.run(); }}
    >
      <Field controlId="fullName">
        <FieldLabel>{NAME_LABEL}</FieldLabel>
        <Input
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          placeholder={NAME_PLACEHOLDER}
          maxLength={NAME_MAX}
          autoComplete="name"
        />
        <FieldDescription>{NAME_HINT}</FieldDescription>
      </Field>
      {/* Disabled only while the name is not one the server would take — the rule is stated
          right above it. While it saves it is pending, never disabled, so focus stays put. */}
      <div className="flex justify-end">
        <Button type="submit" pending={save.pending} disabled={nameUnchanged || nameTooShort}>
          {NAME_SAVE}
        </Button>
      </div>
    </form>
  );
}

/**
 * The member's own door history, below the password and above the passkeys.
 *
 * <p>
 * Door entry is closer to "what the club knows about me" than to credentials, and this card
 * is the POPIA s.23 right served as a product feature. At a club with no gate it does not
 * render at all. D11: a `/me/door` that FAILED is not a club with no gate — with the door
 * question unanswered the card renders only once it has rows of the member's own.
 * </p>
 */
function MemberDoorHistory() {
  const doors = useDoorsFlag();
  if (doors === "no") return null;
  return <DoorHistoryCard onlyWithRows={doors === "unknown"} />;
}

/**
 * Somewhere for a member to change their own password. There was nowhere: a temporary password
 * an admin had emailed in plaintext was the account's permanent credential.
 */
function PasswordCard() {
  const [open, setOpen] = useState(false);
  return (
    <ProfileCard title={PASSWORD_TITLE} description={PASSWORD_DESCRIPTION}>
      {open ? (
        <ChangePasswordForm onDone={() => setOpen(false)} onCancel={() => setOpen(false)} />
      ) : (
        <div><Button variant="outline" onClick={() => setOpen(true)}>{PASSWORD_OPEN}</Button></div>
      )}
    </ProfileCard>
  );
}

type PasskeyRead = { rows: WebAuthnCredentialRow[] | null; error: unknown; loading: boolean };

/**
 * The member's passkeys, read honestly — three states: reading, failed (with a retry), and the
 * list, which may genuinely be empty. The read once swallowed its own failure and left `[]`,
 * which told a member whose read failed that they had no passkeys.
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
      <ProfileCard title={PASSKEYS_TITLE}>
        <p className="text-sm text-text-secondary">{PASSKEY_UNSUPPORTED}</p>
      </ProfileCard>
    );
  }

  return (
    <ProfileCard title={PASSKEYS_TITLE} description={PASSKEY_INTRO}>
      <StateBlock
        loading={passkeys.rows === null && passkeys.loading}
        error={passkeys.rows === null ? passkeys.error : null}
        action={passkeys.error ? "load your passkeys" : "your passkeys"}
        onRetry={() => void passkeys.load()}
        empty={passkeys.rows !== null && passkeys.rows.length === 0}
        emptyIcon={Fingerprint}
        emptyTitle={PASSKEY_EMPTY_TITLE}
        emptyHint={PASSKEY_EMPTY_HINT}
        skeleton={<div className="flex flex-col gap-3">{[0, 1].map((i) => <Skeleton key={i} className="h-14" />)}</div>}
      >
        <PasskeyList rows={passkeys.rows ?? []} onChanged={passkeys.load} />
      </StateBlock>
      <div className="border-t border-border pt-4">
        <AddPasskey onAdded={passkeys.load} />
      </div>
    </ProfileCard>
  );
}

function PasskeyList({ rows, onChanged }: { rows: WebAuthnCredentialRow[]; onChanged: () => Promise<void> }) {
  const toast = useToast();
  /**
   * Resolves to the sentence the confirm announces; REJECTS on a refusal, so the confirm says
   * that nothing changed rather than "Done." over a passkey that is still there.
   */
  const remove = async (id: string) => {
    try {
      await endpoints.webauthnDelete(id);
    } catch (error) {
      toast.push({ tone: "danger", text: "Couldn't remove that passkey — it still works.", unchanged: true });
      throw error;
    }
    await onChanged();
    return PASSKEY_REMOVED;
  };
  return (
    <ul className="flex flex-col divide-y divide-border">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-strong">
            <Fingerprint size={20} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-text-primary">{r.label}</p>
            <p className="text-xs text-text-secondary">{passkeyMeta(r.created_at, r.last_used_at, r.transports)}</p>
          </div>
          <ConfirmButton
            idleLabel={PASSKEY_REMOVE}
            confirmLabel={passkeyRemoveConsequence(r.label)}
            ariaLabel={`${PASSKEY_REMOVE} ${r.label}`}
            subject={r.label}
            cancelLabel="Keep it"
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
  const [missing, setMissing] = useState(false);
  const add = useAsyncAction(async (name: string) => {
    try {
      await registerPasskey(name);
    } catch (err) {
      // The member closed the browser's own sheet: not a failure, and nothing to say.
      if (err instanceof Error && err.message === "passkey_cancelled") return false;
      throw err;
    }
    await onAdded();
    return true;
  }, {
    success: (added) => {
      if (!added) return;
      setLabel("");
      toast.push({ tone: "success", text: PASSKEY_ADDED });
    },
    toast: { failure: "Couldn't add that passkey. Nothing was saved — try again." },
  });

  const submit = () => {
    const name = label.trim();
    setMissing(name === "");
    if (name) void add.run(name);
  };

  return (
    <form noValidate className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <Field controlId="passkey-label">
        <FieldLabel>{PASSKEY_NAME_LABEL}</FieldLabel>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={label}
            onChange={(e) => { setLabel(e.target.value); if (missing) setMissing(false); }}
            placeholder={PASSKEY_NAME_PLACEHOLDER}
          />
          <Button type="submit" variant="secondary" icon={<Plus aria-hidden="true" />} pending={add.pending} className="shrink-0">
            {PASSKEY_ADD}
          </Button>
        </div>
        {missing ? <FieldError>{PASSKEY_NAME_MISSING}</FieldError> : <FieldDescription>{PASSKEY_NAME_HINT}</FieldDescription>}
      </Field>
    </form>
  );
}

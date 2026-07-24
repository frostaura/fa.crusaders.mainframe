import { useEffect, useRef, useState } from "react";
import { Camera, Fingerprint, Loader2, Plus, Trash2 } from "lucide-react";
import { endpoints, ApiError, type WebAuthnCredentialRow } from "../lib/api";
import { useProfile } from "../lib/profile";
import { useToast } from "../components/Toast";
import { Card } from "../components/Card";
import { Button, Input, Label } from "../components/Button";
import { ConfirmButton } from "../components/ConfirmButton";
import { isPasskeySupported, registerPasskey } from "../lib/webauthn";
import { cn } from "../lib/utils";

const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

export default function ProfilePage() {
  const { profile, loading, refresh, setLocal } = useProfile();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // Local-only edits for the name; commits via Save.
  const [fullName, setFullName] = useState("");
  const [savingName, setSavingName] = useState(false);
  useEffect(() => { if (profile) setFullName(profile.full_name ?? ""); }, [profile]);

  const handleFile = async (file: File) => {
    if (!file) return;
    if (!ACCEPT.split(",").includes(file.type)) { toast.push({ tone: "danger", text: "Unsupported image type." }); return; }
    if (file.size > MAX_BYTES) { toast.push({ tone: "danger", text: "Image must be under 5 MB." }); return; }

    // Optimistic preview while we upload.
    const objUrl = URL.createObjectURL(file);
    setPreviewUrl(objUrl);
    setUploading(true);
    try {
      const r = await endpoints.meUploadPhoto(file);
      // Bust any browser cache by appending a timestamp on display.
      if (profile) setLocal({ ...profile, photo_url: r.photo_url });
      toast.push({ tone: "success", text: "Profile photo updated." });
      // Pull fresh profile in the background to keep state honest.
      refresh();
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

  const onPick = () => fileRef.current?.click();
  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
    e.target.value = "";
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  };

  const saveName = async () => {
    if (!profile) return;
    if (fullName.trim() === (profile.full_name ?? "").trim()) return;
    setSavingName(true);
    try {
      const r = await endpoints.meUpdateProfile({ fullName: fullName.trim() });
      setLocal({ ...profile, full_name: r.full_name });
      toast.push({ tone: "success", text: "Name updated." });
    } catch { toast.push({ tone: "danger", text: "Couldn't save name." }); }
    finally { setSavingName(false); }
  };

  if (loading && !profile) return <Card>Loading…</Card>;
  if (!profile) return <Card>Couldn't load profile.</Card>;

  const initial = (profile.full_name?.[0] ?? profile.email[0]).toUpperCase();
  const showUrl = previewUrl ?? profile.photo_url;

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Profile</h1>
        <p className="text-sm text-text-secondary">Your photo is shown on the schedule, in admin lists, and on every booking.</p>
      </div>

      <Card className="space-y-5">
        <div className="flex items-center gap-5">
          <button
            type="button"
            onClick={onPick}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            disabled={uploading}
            aria-label="Change profile photo"
            className={cn(
              "group relative w-28 h-28 rounded-full overflow-hidden border-2 transition-all",
              dragOver ? "border-accent-strong scale-[1.03]" : "border-border",
              uploading ? "opacity-90 cursor-wait" : "hover:border-accent-strong/60",
            )}
          >
            {showUrl ? (
              <img src={showUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="w-full h-full flex items-center justify-center text-3xl font-semibold bg-bg-muted text-text-secondary">{initial}</span>
            )}
            <span className={cn(
              "absolute inset-0 flex flex-col items-center justify-center gap-1 text-white text-xs font-medium",
              "bg-black/40 transition-opacity",
              uploading ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            )}>
              {uploading ? (
                <Loader2 size={20} className="animate-spin" />
              ) : (
                <>
                  <Camera size={20} />
                  <span>Change</span>
                </>
              )}
            </span>
          </button>

          <div className="flex-1 min-w-0">
            <p className="text-sm text-text-secondary">{profile.email}</p>
            {profile.membership_number && (
              <p className="text-xs text-text-muted font-mono mt-1">{profile.membership_number}</p>
            )}
            <p className="mt-3 text-xs text-text-muted">
              Drag and drop, or click the photo. PNG / JPG / WEBP / GIF, up to 5 MB.
            </p>
          </div>
        </div>

        <input ref={fileRef} type="file" accept={ACCEPT} onChange={onChange} className="hidden" />

        <div className="border-t border-border pt-4 space-y-3">
          <div>
            <Label htmlFor="fullName">Full name</Label>
            <Input
              id="fullName"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="As it appears on the schedule"
              maxLength={120}
            />
          </div>
          <div className="flex justify-end">
            <Button onClick={saveName} disabled={savingName || fullName.trim() === (profile.full_name ?? "").trim()}>
              {savingName ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </Card>

      <PasskeysCard />
    </div>
  );
}

function PasskeysCard() {
  const toast = useToast();
  const [rows, setRows] = useState<WebAuthnCredentialRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const supported = isPasskeySupported();

  const load = async () => {
    setLoading(true);
    try { setRows(await endpoints.webauthnList()); }
    catch { /* non-blocking */ }
    finally { setLoading(false); }
  };
  useEffect(() => { if (supported) load(); }, [supported]);

  const add = async () => {
    if (!label.trim()) { toast.push({ tone: "warning", text: "Give the passkey a label so you can tell devices apart." }); return; }
    setAdding(true);
    try {
      await registerPasskey(label.trim());
      setLabel("");
      await load();
      toast.push({ tone: "success", text: "Passkey added." });
    } catch (err) {
      if (err instanceof Error && err.message === "passkey_cancelled") return;
      toast.push({ tone: "danger", text: "Couldn't add passkey." });
    } finally { setAdding(false); }
  };

  const remove = async (id: string) => {
    try {
      await endpoints.webauthnDelete(id);
      await load();
      toast.push({ tone: "success", text: "Passkey removed." });
    } catch { toast.push({ tone: "danger", text: "Couldn't remove passkey." }); }
  };

  if (!supported) {
    return (
      <Card>
        <h2 className="text-base font-semibold mb-1">Passkeys</h2>
        <p className="text-sm text-text-secondary">
          This browser doesn't support passkeys. Use a recent build of Chrome, Safari, Edge, or Firefox on a
          device with biometrics or a security key.
        </p>
      </Card>
    );
  }

  return (
    <Card className="space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-base font-semibold">Passkeys</h2>
          <p className="text-sm text-text-secondary">
            Add a passkey for one-tap sign-in with your device's biometrics or a hardware key. You can register
            as many as you like — phone, laptop, security key.
          </p>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="border border-dashed border-border rounded-lg py-8 text-center text-sm text-text-secondary">
          No passkeys yet. Add one below.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <li key={r.id} className="py-3 flex items-center gap-3">
              <span className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-info-soft text-info-strong shrink-0">
                <Fingerprint size={18} />
              </span>
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{r.label}</p>
                <p className="text-xs text-text-muted">
                  Added {new Date(r.created_at).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })}
                  {r.last_used_at ? ` · Last used ${new Date(r.last_used_at).toLocaleDateString(undefined, { day: "2-digit", month: "short" })}` : " · Never used"}
                  {r.transports ? ` · ${r.transports}` : ""}
                </p>
              </div>
              <ConfirmButton
                idleLabel={<span className="inline-flex items-center"><Trash2 size={14} className="mr-1" /> Remove</span>}
                confirmLabel="Tap to confirm"
                onConfirm={() => remove(r.id)}
                idleClassName="bg-danger-soft text-danger-strong hover:bg-danger-soft/70"
                className="h-9 px-3 text-xs"
              />
            </li>
          ))}
        </ul>
      )}

      <div className="border-t border-border pt-4">
        <Label htmlFor="passkey-label">Label</Label>
        <div className="flex gap-2">
          <Input id="passkey-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. iPhone, MacBook, YubiKey" />
          <Button
            variant="outline"
            className="bg-info-soft border-info-soft text-info-strong hover:bg-info-soft/70 whitespace-nowrap"
            onClick={add}
            disabled={adding}
          >
            <Plus size={16} className="mr-1" /> {adding ? "Adding…" : "Add passkey"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

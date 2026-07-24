import { useEffect, useMemo, useState } from "react";
import { Fingerprint, Plus, Search, X } from "lucide-react";
import { endpoints, type BiometricEnrollmentRow, type BiometricTemplateRow } from "../lib/api";
import { Card } from "../components/Card";
import { Badge, Button, Input, Label } from "../components/Button";
import { ConfirmButton } from "../components/ConfirmButton";
import { useToast } from "../components/Toast";
import { cn } from "../lib/utils";

type Phase = "list" | "consent" | "capturing" | "done" | "failed";
type StatusFilter = "all" | "enrolled" | "not_enrolled";

const FINGER_OPTIONS = [
  "right-thumb", "right-index", "right-middle", "right-ring", "right-pinky",
  "left-thumb", "left-index", "left-middle", "left-ring", "left-pinky",
];

export default function AdminBiometricPage() {
  const toast = useToast();
  const [rows, setRows] = useState<BiometricEnrollmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const [target, setTarget] = useState<BiometricEnrollmentRow | null>(null);
  const [phase, setPhase] = useState<Phase>("list");
  const [fingerLabel, setFingerLabel] = useState("right-index");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try { setRows(await endpoints.adminBiometricEnrollments()); }
    catch { toast.push({ tone: "danger", text: "Couldn't load enrollments." }); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter === "enrolled" && r.templates.length === 0) return false;
      if (statusFilter === "not_enrolled" && r.templates.length > 0) return false;
      if (!needle) return true;
      return [r.full_name, r.email, r.membership_number].some((s) => s.toLowerCase().includes(needle));
    });
  }, [rows, query, statusFilter]);

  const counts = useMemo(() => ({
    total: rows.length,
    enrolled: rows.filter((r) => r.templates.length > 0).length,
    not_enrolled: rows.filter((r) => r.templates.length === 0).length,
  }), [rows]);

  const startEnroll = (m: BiometricEnrollmentRow) => {
    setTarget(m); setPhase("consent"); setError(null); setTemplateId(null);
    // Default to a sensible next finger if the user already has some enrolled.
    const used = new Set(m.templates.map((t) => t.finger_label).filter(Boolean) as string[]);
    const next = FINGER_OPTIONS.find((f) => !used.has(f)) ?? "right-index";
    setFingerLabel(next);
  };

  const acknowledgeConsent = () => setPhase("capturing");

  const capture = async () => {
    if (!target) return;
    try {
      const r = await endpoints.adminBiometricEnroll(target.user_id, fingerLabel);
      setTemplateId(r.template_id);
      setPhase("done");
      await load();
      toast.push({ tone: "success", text: `${target.full_name} enrolled (${fingerLabel}).` });
    } catch {
      setPhase("failed");
      setError("Enrollment failed. Try again or check the device.");
    }
  };

  const removeTemplate = async (templateId: string) => {
    try {
      await endpoints.adminBiometricRemoveTemplate(templateId);
      await load();
      toast.push({ tone: "success", text: "Template removed." });
    } catch { toast.push({ tone: "danger", text: "Remove failed." }); }
  };

  const removeAllForUser = async (m: BiometricEnrollmentRow) => {
    try {
      await Promise.all(m.templates.map((t) => endpoints.adminBiometricRemoveTemplate(t.template_id)));
      await load();
      toast.push({ tone: "success", text: `${m.full_name} fully unenrolled.` });
    } catch { toast.push({ tone: "danger", text: "Unenroll failed." }); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold">Admin · Biometrics</h1>
          <p className="text-sm text-text-secondary">
            Enroll, unenroll, and manage members' fingerprint templates. Templates are stored on this on-prem
            machine only — never the cloud. Backend currently uses <code className="font-mono text-xs">NullBiometricDevice</code> until vendor SDK is wired.
          </p>
        </div>
      </div>

      {phase === "list" && (
        <>
          <Card className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_220px] gap-3">
              <div>
                <Label>Search</Label>
                <div className="relative">
                  <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
                  <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, email, or membership number" className="pl-9" />
                </div>
              </div>
              <div>
                <Label>Status</Label>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                  className="w-full h-11 px-3 rounded-lg border border-border bg-bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-strong focus:border-accent-strong"
                >
                  <option value="all">All members</option>
                  <option value="enrolled">Enrolled</option>
                  <option value="not_enrolled">Not enrolled</option>
                </select>
              </div>
            </div>
            <div className="flex gap-3 text-xs text-text-muted pt-1">
              <span><strong className="text-text-primary">{counts.total}</strong> total</span>
              <span>·</span>
              <span><strong className="text-info-strong">{counts.enrolled}</strong> enrolled</span>
              <span>·</span>
              <span><strong className="text-warning-strong">{counts.not_enrolled}</strong> not enrolled</span>
            </div>
          </Card>

          <Card>
            {loading ? (
              <p className="text-sm text-text-secondary">Loading…</p>
            ) : filtered.length === 0 ? (
              <div className="border border-dashed border-border rounded-lg py-12 text-center text-sm text-text-secondary">
                No members match this filter.
              </div>
            ) : (
              <ul className="divide-y divide-border -mx-4 sm:-mx-6">
                {filtered.map((m) => (
                  <MemberRow
                    key={m.user_id}
                    member={m}
                    onEnroll={() => startEnroll(m)}
                    onRemoveTemplate={removeTemplate}
                    onRemoveAll={() => removeAllForUser(m)}
                  />
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      {phase !== "list" && target && (
        <Card>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">{target.full_name}</h2>
            <button
              onClick={() => { setPhase("list"); setTarget(null); }}
              className="text-text-muted hover:text-text-primary"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>

          {phase === "consent" && (
            <>
              <p className="text-sm">
                I consent to the storage of a biometric template on the on-premises club machine for the
                purpose of court access at Crusaders. Templates never leave the machine. I can request
                deletion at any time.
              </p>
              <p className="text-xs text-text-muted mt-2">Consent receipt v1 — recorded with admin id and timestamp.</p>
              <div className="mt-4 flex gap-2 justify-end">
                <Button variant="ghost" onClick={() => { setPhase("list"); setTarget(null); }}>Cancel</Button>
                <Button
                  variant="outline"
                  className="bg-info-soft border-info-soft text-info-strong hover:bg-info-soft/70"
                  onClick={acknowledgeConsent}
                >
                  Member acknowledged — capture
                </Button>
              </div>
            </>
          )}

          {phase === "capturing" && (
            <>
              <Label>Finger label</Label>
              <select
                value={fingerLabel}
                onChange={(e) => setFingerLabel(e.target.value)}
                className="w-full h-11 px-3 rounded-lg border border-border bg-bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-strong focus:border-accent-strong"
              >
                {FINGER_OPTIONS.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
              <p className="mt-3 text-sm text-text-secondary">Ask the member to place their finger on the reader.</p>
              <div className="mt-4 flex gap-2 justify-end">
                <Button variant="ghost" onClick={() => setPhase("consent")}>Back</Button>
                <Button
                  variant="outline"
                  className="bg-info-soft border-info-soft text-info-strong hover:bg-info-soft/70"
                  onClick={capture}
                >
                  <Fingerprint size={16} className="mr-1" /> Capture
                </Button>
              </div>
            </>
          )}

          {phase === "done" && (
            <>
              <p className="text-sm">Enrollment complete.</p>
              <p className="text-xs font-mono mt-1 break-all text-text-secondary">template_id: {templateId}</p>
              <div className="mt-4 flex gap-2 justify-end">
                <Button variant="ghost" onClick={() => { setPhase("list"); setTarget(null); }}>Back to list</Button>
                <Button
                  variant="outline"
                  className="bg-info-soft border-info-soft text-info-strong hover:bg-info-soft/70"
                  onClick={() => startEnroll(target)}
                >
                  <Plus size={16} className="mr-1" /> Enroll another finger
                </Button>
              </div>
            </>
          )}

          {phase === "failed" && (
            <>
              <p className="text-sm text-danger-strong">{error}</p>
              <div className="mt-4 flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setPhase("capturing")}>Retry</Button>
                <Button variant="ghost" onClick={() => { setPhase("list"); setTarget(null); }}>Cancel</Button>
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}

function MemberRow({
  member, onEnroll, onRemoveTemplate, onRemoveAll,
}: {
  member: BiometricEnrollmentRow;
  onEnroll: () => void;
  onRemoveTemplate: (templateId: string) => Promise<void>;
  onRemoveAll: () => Promise<void>;
}) {
  const enrolled = member.templates.length > 0;
  const initials = member.full_name.split(" ").map((s) => s[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();

  return (
    <li className="px-4 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center gap-3">
      {member.photo_url ? (
        <img src={member.photo_url} alt="" style={{ width: 36, height: 36, minWidth: 36, minHeight: 36 }} className="rounded-full object-cover block shrink-0" />
      ) : (
        <div style={{ width: 36, height: 36, minWidth: 36, minHeight: 36 }} className="rounded-full bg-bg-muted flex items-center justify-center text-xs font-medium shrink-0">{initials}</div>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="font-medium truncate">{member.full_name}</p>
          {enrolled
            ? <Badge tone="success">{member.templates.length} enrolled</Badge>
            : <Badge tone="warning">not enrolled</Badge>}
          <span className="text-xs text-text-muted font-mono">{member.membership_number}</span>
        </div>
        <p className="text-xs text-text-secondary truncate">{member.email}</p>
        {enrolled && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {member.templates.map((t) => (
              <FingerChip key={t.template_id} t={t} onRemove={() => onRemoveTemplate(t.template_id)} />
            ))}
          </div>
        )}
      </div>

      <div className="flex gap-2 shrink-0 sm:ml-auto">
        <Button
          variant="outline"
          className="bg-info-soft border-info-soft text-info-strong hover:bg-info-soft/70 whitespace-nowrap"
          onClick={onEnroll}
        >
          <Plus size={16} className="mr-1" /> {enrolled ? "Add finger" : "Enroll"}
        </Button>
        {enrolled && (
          <ConfirmButton
            idleLabel="Unenroll all"
            confirmLabel="Tap to confirm"
            onConfirm={onRemoveAll}
            idleClassName="bg-danger-soft text-danger-strong hover:bg-danger-soft/70"
            className="h-11 px-4 whitespace-nowrap"
          />
        )}
      </div>
    </li>
  );
}

function FingerChip({ t, onRemove }: { t: BiometricTemplateRow; onRemove: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const click = async () => {
    if (busy) return;
    setBusy(true);
    try { await onRemove(); } finally { setBusy(false); }
  };
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 pl-2.5 pr-1 py-1 rounded-full text-xs font-medium border",
      "bg-info-soft border-info-soft text-info-strong",
    )}>
      <Fingerprint size={12} />
      <span className="font-mono">{t.finger_label ?? "unspecified"}</span>
      <button
        type="button"
        onClick={click}
        title="Remove this template"
        disabled={busy}
        className="ml-1 inline-flex items-center justify-center w-5 h-5 rounded-full hover:bg-bg-surface text-info-strong/70 hover:text-danger-strong disabled:opacity-50"
        aria-label="Remove template"
      >
        <X size={12} />
      </button>
    </span>
  );
}

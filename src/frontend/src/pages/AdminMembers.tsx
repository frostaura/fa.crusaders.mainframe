import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Fingerprint, KeyRound, Plus, Search, Users, Wallet, X } from "lucide-react";
import { endpoints, type AdminMember, type BiometricEnrollmentRow, type BiometricTemplateRow } from "../lib/api";
import { Card } from "../components/Card";
import { Badge, Button, Input, Label } from "../components/Button";
import { ConfirmButton } from "../components/ConfirmButton";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import { cn } from "../lib/utils";

const FINGER_OPTIONS = [
  "left-index", "left-middle", "left-pinky", "left-ring", "left-thumb",
  "right-index", "right-middle", "right-pinky", "right-ring", "right-thumb",
];

type StatusFilter = "all" | "PendingApproval" | "Active" | "Rejected" | "Suspended";
type SortKey = "full_name" | "email" | "membership_number" | "status" | "created_at";
type SortDir = "asc" | "desc";

const STATUSES: { value: StatusFilter; label: string }[] = [
  { value: "Active", label: "Active" },
  { value: "all", label: "All statuses" },
  { value: "PendingApproval", label: "Pending approval" },
  { value: "Rejected", label: "Rejected" },
  { value: "Suspended", label: "Suspended" },
];

export default function AdminMembersPage() {
  const toast = useToast();
  const [members, setMembers] = useState<AdminMember[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("created_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const [rejectFor, setRejectFor] = useState<AdminMember | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [creditFor, setCreditFor] = useState<AdminMember | null>(null);
  const [creditAmount, setCreditAmount] = useState("");
  const [creditReason, setCreditReason] = useState("");
  const [resetFor, setResetFor] = useState<AdminMember | null>(null);
  const [resetResult, setResetResult] = useState<{ tempPassword: string; emailSentTo: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [enrollFor, setEnrollFor] = useState<AdminMember | null>(null);
  const [biometrics, setBiometrics] = useState<Record<string, BiometricEnrollmentRow>>({});

  const load = async () => {
    setLoading(true);
    try {
      // Server filter only when status is specific; the rest filters/sorts client-side.
      const r = await endpoints.adminMembers(status === "all" ? undefined : status);
      setMembers(r);
    } catch { toast.push({ tone: "danger", text: "Couldn't load members." }); }
    finally { setLoading(false); }
  };

  const loadBiometrics = async () => {
    try {
      const rows = await endpoints.adminBiometricEnrollments();
      const map: Record<string, BiometricEnrollmentRow> = {};
      rows.forEach((r) => { map[r.user_id] = r; });
      setBiometrics(map);
    } catch { /* non-blocking */ }
  };

  useEffect(() => { load(); loadBiometrics(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [status]);

  const filtered = useMemo(() => {
    if (!members) return [];
    const q = search.trim().toLowerCase();
    let rows = q
      ? members.filter((m) =>
          m.full_name.toLowerCase().includes(q) ||
          m.email.toLowerCase().includes(q) ||
          m.membership_number.toLowerCase().includes(q))
      : members.slice();
    rows.sort((a, b) => compare(a, b, sortKey) * (sortDir === "asc" ? 1 : -1));
    return rows;
  }, [members, search, sortKey, sortDir]);

  const onSort = (k: SortKey) => {
    if (k === sortKey) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(k); setSortDir(k === "created_at" ? "desc" : "asc"); }
  };

  const approve = async (m: AdminMember) => {
    setBusyId(m.membership_id);
    try { await endpoints.adminApprove(m.membership_id); toast.push({ tone: "success", text: `${m.full_name} approved.` }); await load(); }
    catch { toast.push({ tone: "danger", text: "Approval failed." }); }
    finally { setBusyId(null); }
  };

  const reject = async () => {
    if (!rejectFor || !rejectReason.trim()) return;
    setBusyId(rejectFor.membership_id);
    try {
      await endpoints.adminReject(rejectFor.membership_id, rejectReason);
      toast.push({ tone: "success", text: "Application rejected." });
      setRejectFor(null); setRejectReason("");
      await load();
    } catch { toast.push({ tone: "danger", text: "Rejection failed." }); }
    finally { setBusyId(null); }
  };

  const adjust = async () => {
    if (!creditFor) return;
    const amount = parseFloat(creditAmount);
    if (isNaN(amount) || amount === 0) { toast.push({ tone: "warning", text: "Enter a non-zero amount." }); return; }
    if (!creditReason.trim()) { toast.push({ tone: "warning", text: "A reason is required." }); return; }
    const targetUserId = creditFor.user_id;
    setBusyId(targetUserId);
    try {
      const r = await endpoints.adminAdjust(targetUserId, amount, creditReason);
      // Reflect the new balance in this row immediately — no list refetch, no reload.
      setMembers((prev) => prev?.map((m) => m.user_id === targetUserId ? { ...m, balance_zar: r.balance_after_zar } : m) ?? prev);
      toast.push({ tone: "success", text: `${amount > 0 ? "Credited" : "Debited"} ${creditFor.full_name} R${Math.abs(amount).toFixed(2)}.` });
      setCreditFor(null); setCreditAmount(""); setCreditReason("");
    } catch { toast.push({ tone: "danger", text: "Credit adjustment failed." }); }
    finally { setBusyId(null); }
  };

  const resetPassword = async () => {
    if (!resetFor) return;
    setBusyId(resetFor.membership_id);
    try {
      const r = await endpoints.adminResetMemberPassword(resetFor.membership_id);
      setResetResult({ tempPassword: r.temp_password, emailSentTo: r.email_sent_to });
      toast.push({ tone: "success", text: `Password reset for ${resetFor.full_name}.` });
    } catch { toast.push({ tone: "danger", text: "Password reset failed." }); }
    finally { setBusyId(null); }
  };

  const counts = useMemo(() => {
    if (!members) return { total: 0, pending: 0, active: 0, suspended: 0, rejected: 0 };
    return {
      total: members.length,
      pending: members.filter((m) => m.status === "PendingApproval").length,
      active: members.filter((m) => m.status === "Active").length,
      suspended: members.filter((m) => m.status === "Suspended").length,
      rejected: members.filter((m) => m.status === "Rejected").length,
    };
  }, [members]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Admin · Members</h1>
        <p className="text-sm text-text-secondary">Approve applicants, adjust credit, and reset member passwords.</p>
      </div>

      {/* Filters */}
      <Card className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_220px] gap-3">
          <div>
            <Label htmlFor="search">Search</Label>
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
              <Input id="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, email, or membership number" className="pl-9" />
            </div>
          </div>
          <div>
            <Label htmlFor="status">Status</Label>
            <select
              id="status"
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusFilter)}
              className="w-full h-11 px-3 rounded-lg border border-border bg-bg-surface text-text-primary"
            >
              {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap gap-3 text-xs text-text-muted pt-1">
          <span><strong className="text-text-primary">{counts.total}</strong> total</span>
          <span>·</span>
          <span><strong className="text-info-strong">{counts.pending}</strong> pending</span>
          <span><strong className="text-success-strong">{counts.active}</strong> active</span>
          <span><strong className="text-warning-strong">{counts.suspended}</strong> suspended</span>
          <span><strong className="text-danger-strong">{counts.rejected}</strong> rejected</span>
        </div>
      </Card>

      {/* Table */}
      <Card className="!p-0 overflow-hidden">
        {filtered.length === 0 ? (
          <EmptyState loading={loading} hasFilters={search.trim().length > 0 || status !== "all"} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg-muted/40 text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="text-left px-4 py-3" style={{ width: 60 }}></th>
                  <SortHeader label="Name" k="full_name" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortHeader label="Email" k="email" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortHeader label="Member #" k="membership_number" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortHeader label="Status" k="status" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <th className="text-right px-4 py-3">Balance</th>
                  <SortHeader label="Joined" k="created_at" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <th className="text-right px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((m) => (
                  <tr key={m.membership_id} className="hover:bg-bg-muted/30">
                    <td className="px-4 py-3 align-middle">
                      {m.photo_url ? (
                        <img
                          src={m.photo_url}
                          alt=""
                          width={36}
                          height={36}
                          style={{ width: 36, height: 36, minWidth: 36, minHeight: 36 }}
                          className="rounded-full object-cover block shrink-0"
                        />
                      ) : (
                        <div
                          style={{ width: 36, height: 36, minWidth: 36, minHeight: 36 }}
                          className="rounded-full bg-bg-muted text-text-secondary flex items-center justify-center text-sm font-medium shrink-0"
                        >
                          {m.full_name[0]?.toUpperCase() ?? "?"}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-text-primary truncate max-w-[180px]" title={m.full_name}>{m.full_name}</p>
                        {biometrics[m.user_id]?.templates.length ? (
                          <span
                            title={`${biometrics[m.user_id].templates.length} fingerprint(s) enrolled`}
                            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-info-soft text-info-strong"
                          >
                            <Fingerprint size={11} /> {biometrics[m.user_id].templates.length}
                          </span>
                        ) : null}
                      </div>
                      {m.rejection_reason && <p className="text-xs text-danger-strong truncate max-w-[260px]" title={m.rejection_reason}>{m.rejection_reason}</p>}
                    </td>
                    <td className="px-4 py-3 text-text-secondary truncate max-w-[200px]" title={m.email}>{m.email}</td>
                    <td className="px-4 py-3 font-mono text-xs text-text-secondary">{m.membership_number}</td>
                    <td className="px-4 py-3"><Badge tone={statusTone(m.status)}>{prettyStatus(m.status)}</Badge></td>
                    <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">
                      <span className={cn("font-medium", m.balance_zar < 0 ? "text-danger-strong" : "text-text-primary")}>
                        R{m.balance_zar.toFixed(2)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-text-secondary whitespace-nowrap text-xs">
                      {new Date(m.created_at).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col items-end gap-1">
                        {m.status === "PendingApproval" && (
                          <div className="flex gap-1.5">
                            <Button onClick={() => approve(m)} disabled={busyId === m.membership_id} className="h-9 px-3 text-xs">Approve</Button>
                            <Button variant="outline" onClick={() => { setRejectFor(m); setRejectReason(""); }} className="h-9 px-3 text-xs">Reject</Button>
                          </div>
                        )}
                        {m.status === "Active" && (
                          <>
                            <IconAction title="Adjust credit" onClick={() => setCreditFor(m)} icon={<Wallet size={16} />} />
                            <IconAction
                              title={biometrics[m.user_id]?.templates.length ? "Manage biometrics" : "Enroll fingerprint"}
                              onClick={() => setEnrollFor(m)}
                              icon={<Fingerprint size={16} />}
                            />
                            <IconAction title="Reset password" onClick={() => setResetFor(m)} icon={<KeyRound size={16} />} />
                          </>
                        )}
                        {m.status !== "Active" && m.status !== "PendingApproval" && (
                          <IconAction title="Reset password" onClick={() => setResetFor(m)} icon={<KeyRound size={16} />} />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Reject modal */}
      {rejectFor && (
        <Modal onClose={() => setRejectFor(null)} title={`Reject ${rejectFor.full_name}'s application`}>
          <Label>Reason (visible to applicant)</Label>
          <Input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="e.g. Membership number not on file." />
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" onClick={() => setRejectFor(null)}>Cancel</Button>
            <Button variant="danger" onClick={reject} disabled={!rejectReason.trim()}>Reject</Button>
          </div>
        </Modal>
      )}

      {/* Credit adjust modal */}
      {creditFor && (
        <Modal onClose={() => setCreditFor(null)} title={`Adjust credit — ${creditFor.full_name}`}>
          <Label>Amount (ZAR — positive credits, negative debits)</Label>
          <Input value={creditAmount} onChange={(e) => setCreditAmount(e.target.value)} placeholder="e.g. 100" inputMode="decimal" />
          <Label className="mt-3">Reason (audit-logged)</Label>
          <Input value={creditReason} onChange={(e) => setCreditReason(e.target.value)} placeholder="e.g. Voided 2026-05-04 booking, reissuing credit" />
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" onClick={() => setCreditFor(null)}>Cancel</Button>
            <Button onClick={adjust}>Apply</Button>
          </div>
        </Modal>
      )}

      {/* Reset password — confirm */}
      {resetFor && !resetResult && (
        <Modal onClose={() => setResetFor(null)} title={`Reset password for ${resetFor.full_name}?`}>
          <p className="text-sm text-text-secondary">
            A new temporary password will be generated, set on the account, and emailed to <span className="font-medium text-text-primary">{resetFor.email}</span>.
            You'll see it once on the next screen so you can share it directly if email delivery is uncertain.
          </p>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" onClick={() => setResetFor(null)}>Cancel</Button>
            <Button variant="danger" onClick={resetPassword} disabled={busyId === resetFor.membership_id}>
              {busyId === resetFor.membership_id ? "Resetting…" : "Reset password"}
            </Button>
          </div>
        </Modal>
      )}

      {/* Biometric enrollment manager */}
      {enrollFor && (
        <BiometricModal
          member={enrollFor}
          enrollment={biometrics[enrollFor.user_id]}
          onClose={() => setEnrollFor(null)}
          onChange={loadBiometrics}
        />
      )}

      {/* Reset password — show generated password once */}
      {resetFor && resetResult && (
        <Modal onClose={() => { setResetFor(null); setResetResult(null); }} title="Temporary password generated">
          <p className="text-sm text-text-secondary">Emailed to <strong className="text-text-primary">{resetResult.emailSentTo}</strong>. The member should change it after signing in.</p>
          <div className="my-4 px-4 py-3 rounded-lg border border-border bg-bg-muted font-mono text-base tracking-wider text-center select-all">
            {resetResult.tempPassword}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { navigator.clipboard?.writeText(resetResult.tempPassword); toast.push({ tone: "info", text: "Copied to clipboard." }); }}>Copy</Button>
            <Button onClick={() => { setResetFor(null); setResetResult(null); }}>Done</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function IconAction({ title, icon, onClick }: { title: string; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="inline-flex items-center justify-center w-8 h-8 rounded-md text-text-secondary hover:text-info-strong hover:bg-info-soft transition"
    >
      {icon}
    </button>
  );
}

function SortHeader({ label, k, sortKey, sortDir, onSort }: { label: string; k: SortKey; sortKey: SortKey; sortDir: SortDir; onSort: (k: SortKey) => void }) {
  const active = sortKey === k;
  const Icon = !active ? ArrowUpDown : sortDir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th className="text-left px-4 py-3">
      <button type="button" onClick={() => onSort(k)} className={cn("inline-flex items-center gap-1 hover:text-text-primary", active && "text-text-primary")}>
        <span>{label}</span>
        <Icon size={12} className={cn(active ? "opacity-100" : "opacity-40")} />
      </button>
    </th>
  );
}

function EmptyState({ loading, hasFilters }: { loading: boolean; hasFilters: boolean }) {
  return (
    <div className="border border-dashed border-border rounded-lg m-4 sm:m-6 py-16 flex flex-col items-center justify-center gap-2 text-center">
      <Users size={28} className="text-text-muted" />
      <p className="text-sm text-text-secondary">{loading ? "Loading members…" : hasFilters ? "No members match these filters." : "No members yet."}</p>
      {hasFilters && !loading && <p className="text-xs text-text-muted">Try clearing the search or switching status.</p>}
    </div>
  );
}

function BiometricModal({
  member, enrollment, onClose, onChange,
}: {
  member: AdminMember;
  enrollment: BiometricEnrollmentRow | undefined;
  onClose: () => void;
  onChange: () => Promise<void>;
}) {
  const toast = useToast();
  const [phase, setPhase] = useState<"manage" | "consent" | "capturing">("manage");
  const [fingerLabel, setFingerLabel] = useState("right-index");
  const [busy, setBusy] = useState(false);

  const templates = enrollment?.templates ?? [];

  const startEnroll = () => {
    const used = new Set(templates.map((t) => t.finger_label).filter(Boolean) as string[]);
    setFingerLabel(FINGER_OPTIONS.find((f) => !used.has(f)) ?? "right-index");
    setPhase("consent");
  };

  const capture = async () => {
    setBusy(true);
    try {
      await endpoints.adminBiometricEnroll(member.user_id, fingerLabel);
      await onChange();
      toast.push({ tone: "success", text: `${member.full_name} enrolled (${fingerLabel}).` });
      setPhase("manage");
    } catch {
      toast.push({ tone: "danger", text: "Enrollment failed. Try again or check the device." });
    } finally { setBusy(false); }
  };

  const removeOne = async (templateId: string) => {
    try {
      await endpoints.adminBiometricRemoveTemplate(templateId);
      await onChange();
      toast.push({ tone: "success", text: "Template removed." });
    } catch { toast.push({ tone: "danger", text: "Remove failed." }); }
  };

  const removeAll = async () => {
    try {
      await Promise.all(templates.map((t) => endpoints.adminBiometricRemoveTemplate(t.template_id)));
      await onChange();
      toast.push({ tone: "success", text: `${member.full_name} fully unenrolled.` });
    } catch { toast.push({ tone: "danger", text: "Unenroll failed." }); }
  };

  return (
    <Modal onClose={onClose} title={`Biometrics — ${member.full_name}`}>
      {phase === "manage" && (
        <>
          {templates.length === 0 ? (
            <p className="text-sm text-text-secondary">No fingerprints enrolled yet.</p>
          ) : (
            <>
              <p className="text-xs uppercase tracking-wide text-text-muted mb-2">Enrolled fingers</p>
              <div className="flex flex-wrap gap-1.5">
                {templates.map((t) => (
                  <FingerChip key={t.template_id} t={t} onRemove={() => removeOne(t.template_id)} />
                ))}
              </div>
            </>
          )}
          <div className="flex justify-end gap-2 mt-5 flex-wrap">
            {templates.length > 0 && (
              <ConfirmButton
                idleLabel="Unenroll all"
                confirmLabel="Tap to confirm"
                onConfirm={removeAll}
                idleClassName="bg-danger-soft text-danger-strong hover:bg-danger-soft/70"
                className="h-11 px-4"
              />
            )}
            <Button variant="ghost" onClick={onClose}>Close</Button>
            <Button
              variant="outline"
              className="bg-info-soft border-info-soft text-info-strong hover:bg-info-soft/70"
              onClick={startEnroll}
            >
              <Plus size={16} className="mr-1" /> {templates.length ? "Add finger" : "Enroll"}
            </Button>
          </div>
        </>
      )}

      {phase === "consent" && (
        <>
          <p className="text-sm">
            I consent to the storage of a biometric template on the on-premises club machine for the purpose of court access at Crusaders.
            Templates never leave the machine. I can request deletion at any time.
          </p>
          <p className="text-xs text-text-muted mt-2">Consent receipt v1 — recorded with admin id and timestamp.</p>
          <div className="flex justify-end gap-2 mt-5">
            <Button variant="ghost" onClick={() => setPhase("manage")}>Back</Button>
            <Button
              variant="outline"
              className="bg-info-soft border-info-soft text-info-strong hover:bg-info-soft/70"
              onClick={() => setPhase("capturing")}
            >
              Member acknowledged — capture
            </Button>
          </div>
        </>
      )}

      {phase === "capturing" && (
        <>
          <Label>Finger</Label>
          <select
            value={fingerLabel}
            onChange={(e) => setFingerLabel(e.target.value)}
            className="w-full h-11 px-3 rounded-lg border border-border bg-bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-strong focus:border-accent-strong"
          >
            {FINGER_OPTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <p className="mt-3 text-sm text-text-secondary">Ask the member to place their finger on the reader.</p>
          <div className="flex justify-end gap-2 mt-5">
            <Button variant="ghost" onClick={() => setPhase("consent")}>Back</Button>
            <Button
              variant="outline"
              className="bg-info-soft border-info-soft text-info-strong hover:bg-info-soft/70"
              onClick={capture}
              disabled={busy}
            >
              <Fingerprint size={16} className="mr-1" /> {busy ? "Capturing…" : "Capture"}
            </Button>
          </div>
        </>
      )}
    </Modal>
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
    <span className="inline-flex items-center gap-1.5 pl-2.5 pr-1 py-1 rounded-full text-xs font-medium border bg-info-soft border-info-soft text-info-strong">
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

function compare(a: AdminMember, b: AdminMember, key: SortKey): number {
  const av = String((a as unknown as Record<string, unknown>)[key] ?? "");
  const bv = String((b as unknown as Record<string, unknown>)[key] ?? "");
  return av.localeCompare(bv, undefined, { numeric: true });
}

function statusTone(s: string): "muted" | "success" | "info" | "warning" | "danger" {
  switch (s) {
    case "Active": return "success";
    case "PendingApproval": return "info";
    case "Suspended": return "warning";
    case "Rejected": return "danger";
    default: return "muted";
  }
}

function prettyStatus(s: string): string {
  switch (s) {
    case "PendingApproval": return "Pending";
    case "Active": return "Active";
    case "Rejected": return "Rejected";
    case "Suspended": return "Suspended";
    default: return s;
  }
}

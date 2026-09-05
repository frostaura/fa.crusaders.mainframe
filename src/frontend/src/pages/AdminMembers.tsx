import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Ban, Fingerprint, KeyRound, MailWarning, Plus, RotateCcw, Search, Users, Wallet, X } from "lucide-react";
import { ApiError, endpoints, type AdminMember, type BiometricEnrollmentRow, type BiometricTemplateRow, type LedgerEntryType, type LedgerRow, type MemberClass } from "../lib/api";
import { Card } from "../components/Card";
import { Badge, Button, Input, Label } from "../components/Button";
import { ConfirmButton } from "../components/ConfirmButton";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import { cn, formatCredits } from "../lib/utils";

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
  const [creditBooking, setCreditBooking] = useState("");
  // The server's verdict on the named booking, shown at the field rather than as a toast:
  // it is the one input the admin has to change, and a toast that has faded says nothing.
  const [creditBookingError, setCreditBookingError] = useState<string | null>(null);
  const [resetFor, setResetFor] = useState<AdminMember | null>(null);
  const [resetResult, setResetResult] = useState<{ tempPassword: string; emailSentTo: string } | null>(null);
  const [suspendFor, setSuspendFor] = useState<AdminMember | null>(null);
  const [suspendReason, setSuspendReason] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  /** The key naming the adjustment currently being attempted; cleared once it lands. */
  const adjustKey = useRef<string | null>(null);
  /** Synchronous re-entry guard for Apply — see `adjust`. */
  const adjustInFlight = useRef(false);
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

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader; sync loading flag is the house idiom
  useEffect(() => { load(); loadBiometrics(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [status]);

  const filtered = useMemo(() => {
    if (!members) return [];
    const q = search.trim().toLowerCase();
    const rows = q
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

  const closeCredit = () => {
    setCreditFor(null); setCreditAmount(""); setCreditReason(""); setCreditBooking(""); setCreditBookingError(null);
    adjustKey.current = null;
    adjustInFlight.current = false;
  };

  const adjust = async () => {
    if (!creditFor) return;
    // Two guards, because they stop two different things.
    //
    // The ref stops the second click: `busyId` is React state, and a second click landing
    // before the re-render commits reads the old value — which is exactly what a
    // double-click is. The ref is written synchronously, so the second call returns here.
    //
    // The key stops everything the ref cannot see: a retry after a failed response, a
    // second tab, a request the browser retried under the covers. It names THIS movement
    // and survives until the movement succeeds, so the server answers a repeat with the
    // row it already wrote instead of writing a second one. A double-click posted +7
    // twice and moved a member 444 -> 458; four clicks on a slow connection granted 44
    // credits where 11 were typed. Money is ledger-only, so a duplicated row IS the wrong
    // balance and nothing on the ledger says which of the two was the mistake.
    if (adjustInFlight.current) return;
    const bookingId = creditBooking.trim();
    const complaint = validateAdjustment(creditAmount, creditReason, bookingId);
    if (complaint) { toast.push({ tone: "warning", text: complaint }); return; }
    const amount = parseFloat(creditAmount);
    const targetUserId = creditFor.user_id;
    adjustInFlight.current = true;
    adjustKey.current ??= newIdempotencyKey();
    setBusyId(targetUserId);
    setCreditBookingError(null);
    try {
      const r = await endpoints.adminAdjust(targetUserId, amount, creditReason, bookingId || undefined, adjustKey.current);
      // Reflect the new balance in this row immediately — no list refetch, no reload.
      setMembers((prev) => prev?.map((m) => m.user_id === targetUserId ? { ...m, balance_credits: r.balance_after_credits } : m) ?? prev);
      toast.push({ tone: "success", text: `${amount > 0 ? "Credited" : "Debited"} ${creditFor.full_name} ${formatCredits(Math.abs(amount))}${bookingId ? ` for booking ${bookingId.slice(0, 8)}` : ""}.` });
      closeCredit();
    } catch (err) {
      // A refused booking id keeps the form open with the reason at the field. Anything
      // else is not about one input, so it stays a toast.
      const refusal = relatedBookingRefusal(err);
      if (refusal) setCreditBookingError(refusal);
      else toast.push({ tone: "danger", text: "Credit adjustment failed." });
    }
    finally { adjustInFlight.current = false; setBusyId(null); }
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

  /**
   * Assign a member's class.
   *
   * The endpoint and a typed client for it both existed and nothing called either, so
   * every member onboarded through the product was permanently Regular — while the class
   * decides the top-up rate (R100 buys 160 credits as Regular and 240 as league/senior)
   * and peak-hour exclusivity. The row is corrected locally rather than by refetching the
   * list, so a sorted, filtered, scrolled table does not jump under the admin's cursor.
   */
  const setMemberClass = async (m: AdminMember, next: MemberClass) => {
    const previous = m.member_class;
    if (next === previous) return;
    setBusyId(m.membership_id);
    setMembers((prev) => prev?.map((r) => r.membership_id === m.membership_id ? { ...r, member_class: next } : r) ?? prev);
    try {
      await endpoints.adminSetMemberClass(m.membership_id, next);
      toast.push({ tone: "success", text: `${m.full_name} is now ${classLabel(next).toLowerCase()}.` });
    } catch {
      // Put the old value back: a select that keeps a class the server refused is a lie
      // about a field that doubles what the member's money buys.
      setMembers((prev) => prev?.map((r) => r.membership_id === m.membership_id ? { ...r, member_class: previous } : r) ?? prev);
      toast.push({ tone: "danger", text: `Couldn't change ${m.full_name}'s class. Their rate is unchanged.` });
    } finally { setBusyId(null); }
  };

  const suspend = async () => {
    if (!suspendFor || !suspendReason.trim()) return;
    setBusyId(suspendFor.membership_id);
    try {
      await endpoints.adminSuspend(suspendFor.membership_id, suspendReason);
      toast.push({ tone: "success", text: `${suspendFor.full_name} suspended.` });
      setSuspendFor(null); setSuspendReason("");
      await load();
    } catch { toast.push({ tone: "danger", text: "Couldn't suspend this member." }); }
    finally { setBusyId(null); }
  };

  const reactivate = async (m: AdminMember) => {
    setBusyId(m.membership_id);
    try {
      await endpoints.adminReactivate(m.membership_id);
      toast.push({ tone: "success", text: `${m.full_name} is active again.` });
      await load();
    } catch { toast.push({ tone: "danger", text: "Couldn't reactivate this member." }); }
    finally { setBusyId(null); }
  };

  /**
   * Send the verification email again.
   *
   * An unverified member cannot sign in with a password however active their membership
   * is, and this is the button that unsticks them. The endpoint answers the same way for
   * an address it does not hold, so the toast promises delivery to the address rather
   * than confirming the account — there is nothing here to leak either way, but the copy
   * should not imply a lookup that did not happen.
   */
  const resendVerification = async (m: AdminMember) => {
    setBusyId(m.membership_id);
    try {
      await endpoints.resendVerification(m.email);
      toast.push({ tone: "success", text: `Verification email sent to ${m.email}.` });
    } catch { toast.push({ tone: "danger", text: "Couldn't send the verification email. Check the mail settings and try again." }); }
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
                  <th className="text-left px-4 py-3">Class</th>
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
                    <td className="px-4 py-3 text-text-secondary max-w-[200px]" title={m.email}>
                      <p className="truncate">{m.email}</p>
                      {m.email_verified === false && (
                        <span
                          title="This member never confirmed their email address, so they cannot sign in with a password."
                          className="inline-flex items-center gap-1 mt-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-warning-soft text-warning-strong"
                        >
                          <MailWarning size={11} /> Unverified
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-text-secondary">{m.membership_number}</td>
                    <td className="px-4 py-3"><Badge tone={statusTone(m.status)}>{prettyStatus(m.status)}</Badge></td>
                    <td className="px-4 py-3">
                      <MemberClassCell member={m} busy={busyId === m.membership_id} onChange={(next) => setMemberClass(m, next)} />
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">
                      <span className={cn("font-medium", m.balance_credits < 0 ? "text-danger-strong" : "text-text-primary")}>
                        {formatCredits(m.balance_credits)}
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
                            <IconAction
                              title="Suspend member"
                              onClick={() => { setSuspendFor(m); setSuspendReason(""); }}
                              icon={<Ban size={16} />}
                              tone="danger"
                            />
                          </>
                        )}
                        {m.status === "Suspended" && (
                          <>
                            <IconAction title="Reactivate member" onClick={() => reactivate(m)} icon={<RotateCcw size={16} />} />
                            <IconAction title="Reset password" onClick={() => setResetFor(m)} icon={<KeyRound size={16} />} />
                          </>
                        )}
                        {m.status === "Rejected" && (
                          <IconAction title="Reset password" onClick={() => setResetFor(m)} icon={<KeyRound size={16} />} />
                        )}
                        {/* Available whatever the status: an applicant who never verified is
                            stuck before approval matters, and an approved one is stuck after. */}
                        {m.email_verified === false && (
                          <IconAction title="Resend verification email" onClick={() => resendVerification(m)} icon={<MailWarning size={16} />} />
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

      {/* Suspend modal */}
      {suspendFor && (
        <Modal onClose={() => setSuspendFor(null)} title={`Suspend ${suspendFor.full_name}?`}>
          <p className="text-sm text-text-secondary">
            They won't be able to sign in, book a court, or open a court at the box. Their credit balance
            and any bookings they already have are left exactly as they are, and reactivating restores
            everything. The reason is emailed to them.
          </p>
          <Label className="mt-3">Reason (visible to the member)</Label>
          <Input value={suspendReason} onChange={(e) => setSuspendReason(e.target.value)} placeholder="e.g. Membership dues unpaid since March." />
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" onClick={() => setSuspendFor(null)}>Cancel</Button>
            <Button variant="danger" onClick={suspend} disabled={!suspendReason.trim() || busyId === suspendFor.membership_id}>
              {busyId === suspendFor.membership_id ? "Suspending…" : "Suspend"}
            </Button>
          </div>
        </Modal>
      )}

      {/* Credit adjust modal */}
      {creditFor && (
        <Modal onClose={closeCredit} title={`Adjust credit — ${creditFor.full_name}`}>
          <Label htmlFor="credit-amount">Amount (credits — positive adds, negative deducts)</Label>
          <Input id="credit-amount" value={creditAmount} onChange={(e) => setCreditAmount(e.target.value)} placeholder="e.g. 100" inputMode="decimal" />
          <Label htmlFor="credit-reason" className="mt-3">Reason (audit-logged)</Label>
          <Input id="credit-reason" value={creditReason} onChange={(e) => setCreditReason(e.target.value)} placeholder="e.g. Goodwill — court 2 lights faulty on 2026-05-04" />
          <RelatedBookingField
            userId={creditFor.user_id}
            value={creditBooking}
            error={creditBookingError}
            onChange={(next) => { setCreditBooking(next); setCreditBookingError(null); }}
          />
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" onClick={closeCredit}>Cancel</Button>
            <Button onClick={adjust} disabled={busyId === creditFor.user_id}>
              {busyId === creditFor.user_id ? "Applying…" : "Apply"}
            </Button>
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

function IconAction({ title, icon, onClick, tone = "info" }: { title: string; icon: React.ReactNode; onClick: () => void; tone?: "info" | "danger" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        "inline-flex items-center justify-center w-8 h-8 rounded-md text-text-secondary transition",
        tone === "danger" ? "hover:text-danger-strong hover:bg-danger-soft" : "hover:text-info-strong hover:bg-info-soft",
      )}
    >
      {icon}
    </button>
  );
}

const MEMBER_CLASSES: MemberClass[] = ["Regular", "LeagueOrSenior"];

function classLabel(c: MemberClass): string {
  return c === "LeagueOrSenior" ? "League or senior" : "Regular";
}

/**
 * The member's class, editable in place.
 *
 * <p>
 * A select rather than a modal because this is a two-value field an admin changes while
 * reading down a list, and a confirmation step for it would be ceremony. It is read-only
 * for a rejected application: that membership is not going to buy anything, and offering
 * a rate control on it invites the question of whether setting one revives the account.
 * </p>
 */
function MemberClassCell({ member, busy, onChange }: { member: AdminMember; busy: boolean; onChange: (next: MemberClass) => void }) {
  const current = member.member_class ?? "Regular";
  if (member.status === "Rejected") {
    return <span className="text-xs text-text-muted">{classLabel(current)}</span>;
  }
  return (
    <select
      value={current}
      disabled={busy}
      aria-label={`Member class for ${member.full_name}`}
      onChange={(e) => onChange(e.target.value as MemberClass)}
      className="h-9 px-2 rounded-lg border border-border bg-bg-surface text-text-primary text-xs disabled:opacity-60"
    >
      {MEMBER_CLASSES.map((c) => <option key={c} value={c}>{classLabel(c)}</option>)}
    </select>
  );
}

/**
 * A name for one intended credit movement.
 *
 * <p>
 * `crypto.randomUUID` needs a secure context and is absent under plain HTTP on a LAN
 * address — which is exactly where a club's admin laptop sits — so a fallback is not
 * theoretical here. It does not need to be unguessable: the server scopes the key to the
 * tenant and it only ever suppresses a repeat of the desk's own adjustment, so
 * "distinct with overwhelming probability" is the whole requirement.
 * </p>
 */
function newIdempotencyKey(): string {
  const c = globalThis.crypto as Crypto & { randomUUID?: () => string };
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`;
}

// --- "for booking" on a credit adjustment --------------------------------------

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isGuid(value: string) { return GUID.test(value); }

/**
 * What is wrong with the form, in the desk's words, or null when nothing is.
 *
 * <p>
 * The GUID check is here rather than left to the server because the endpoint binds
 * <code>RelatedBookingId</code> as a <code>Guid?</code> and answers a bare 400 with no
 * body for anything that is not one — a refusal an admin cannot act on. The two refusals
 * the endpoint <em>does</em> explain are handled after the round trip, in
 * {@link relatedBookingRefusal}.
 * </p>
 */
function validateAdjustment(amountText: string, reason: string, bookingId: string): string | null {
  const amount = parseFloat(amountText);
  if (isNaN(amount) || amount === 0) return "Enter a non-zero amount.";
  if (!reason.trim()) return "A reason is required.";
  if (bookingId && !isGuid(bookingId)) return "That booking ID is not one — it should look like 8-4-4-4-12 hex characters. Pick one from the list or leave it blank.";
  return null;
}

/**
 * The two ways the server refuses the booking a hand adjustment names (settlement-model
 * I4), told apart.
 *
 * <p>
 * They are different mistakes with different repairs, and a generic "adjustment failed"
 * sends the admin back round the same loop. <code>booking_not_found</code> is a
 * mis-keyed or foreign id — including another club's, which this tenant cannot see and
 * so does not have. <code>booking_not_members</code> is a real booking of the wrong
 * member's, which is the dangerous one: it is the mistake I4 exists to stop, because
 * before the check it silently netted against a third party's settlement and left
 * nothing on their ledger to explain it.
 * </p>
 */
const RELATED_BOOKING_REFUSAL: Record<string, string> = {
  booking_not_found:
    "No booking with that ID exists at this club. Check it against the club's own records, or pick one from the list — the list is every booking this member's money has moved on.",
  booking_not_members:
    "That booking belongs to another member. Naming it here would net against THEIR reversal and change what they are owed, so the server refused it. Pick one of this member's own bookings.",
};

function relatedBookingRefusal(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.status !== 400) return null;
  const payload = typeof err.payload === "object" && err.payload !== null ? (err.payload as Record<string, unknown>) : {};
  const code = typeof payload.error === "string" ? payload.error : "";
  return RELATED_BOOKING_REFUSAL[code] ?? null;
}

/** Sentinel option value: the admin will type a booking ID the ledger has not seen. */
const OTHER_BOOKING = "other";

type RecentBooking = { id: string; label: string };

/**
 * What each ledger type is called in the picker — the wording LedgerRowMapper uses for
 * the same rows, so a booking reads the same here as on the ledger page. A Record over
 * the union, so a type added on the backend fails to compile here rather than showing
 * up unlabelled.
 */
const LEDGER_TYPE_LABEL: Record<LedgerEntryType, string> = {
  TopUp: "Wallet top-up",
  BookingCharge: "Booking charge",
  CancellationRefund: "Cancellation refund",
  NoShowPenalty: "No-show penalty",
  LateCancellationPenalty: "Late-cancellation penalty",
  AdminAdjustment: "Admin adjustment",
  PaymentReversal: "Payment reversal",
  LightsPurchase: "Lights purchase",
};

/**
 * The bookings the ledger knows this member by, newest first, one entry per booking.
 *
 * There is no admin endpoint that lists a member's bookings, and none is needed for
 * this: every charge, penalty and refund row carries `relatedBookingId`, so the ledger
 * filtered to the member is the list of bookings money has moved on — which is the
 * list an adjustment could be compensating for. A no-show penalty row is the usual
 * pick, and that is exactly the case the field exists for.
 */
function recentBookingsFrom(rows: LedgerRow[]): RecentBooking[] {
  const seen = new Set<string>();
  const out: RecentBooking[] = [];
  for (const row of rows) {
    const id = row.relatedBookingId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const when = new Date(row.at).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
    out.push({ id, label: `${when} · ${LEDGER_TYPE_LABEL[row.type] ?? row.type} ${formatCredits(row.amountCredits)} · ${id.slice(0, 8)}` });
  }
  return out;
}

/**
 * The optional booking a credit adjustment is compensation for.
 *
 * <p>
 * Naming the booking is what turns a manual credit from plain money into evidence. It
 * does <b>not</b> stand in for the automatic reversal and does not cancel it: a no-show
 * is reversed on its own the moment the box's attendance upload arrives, and both legs
 * of that reversal are always attempted. What naming the booking does is make the hand
 * adjustment part of the arithmetic — settlement-model I3 nets it against the reversal
 * <em>one leg at a time</em>:
 * </p>
 *
 * <pre>
 * penaltyBack = max(0, penalised − Σ  positive adjustments naming b)
 * refundBack  = max(0, refunded  − Σ |negative adjustments naming b|)
 * </pre>
 *
 * <p>
 * So a positive adjustment reduces the penalty the reversal gives back, and a negative
 * one reduces the refund the reversal takes away. The sign is never read as a signal
 * that the desk "already fixed it" — the model tried that, and because the honest
 * outstanding after a sweep is always negative, a positive adjustment could never be
 * the whole correction: it matched only wrong-direction repairs, skipped the refund
 * reversal, and made a played court free (review finding 2).
 * </p>
 *
 * <p>
 * Netting caps at each leg, so an adjustment larger than the leg is worth is a decision
 * the model does not claw back; the excess stands on the ledger under the admin's name
 * (settlement-model §7.1). The copy below says all of this, because the copy here used
 * to say the reverse — first that a credit was the repair for a wrongly-recorded
 * no-show, then that a credit on top left the member "holding both". Neither is true
 * under I3, and both push the desk into paying the wrong amount.
 * </p>
 *
 * <p>
 * The booking must be this member's own. The picker only offers their bookings, and a
 * typed id is checked here for shape; ownership and existence are the server's, and its
 * two refusals arrive back here as {@link RELATED_BOOKING_REFUSAL} text shown at this
 * field rather than as a toast.
 * </p>
 */
function RelatedBookingField(
  { userId, value, error, onChange }: { userId: string; value: string; error: string | null; onChange: (next: string) => void },
) {
  const [recent, setRecent] = useState<RecentBooking[] | null>(null);
  const [choice, setChoice] = useState("");

  useEffect(() => {
    let cancelled = false;
    // Best effort: the field degrades to "type the ID" if the ledger cannot be read.
    endpoints.adminLedger({ userId, limit: 50 })
      .then((rows) => { if (!cancelled) setRecent(recentBookingsFrom(rows)); })
      .catch(() => { if (!cancelled) setRecent([]); });
    return () => { cancelled = true; };
  }, [userId]);

  const pick = (next: string) => {
    setChoice(next);
    onChange(next === OTHER_BOOKING ? "" : next);
  };

  return (
    <div className="mt-3">
      <Label htmlFor="credit-booking">For booking (optional)</Label>
      <select
        id="credit-booking"
        value={choice}
        onChange={(e) => pick(e.target.value)}
        className="w-full h-11 px-3 rounded-lg border border-border bg-bg-surface text-text-primary"
      >
        <option value="">Not for a specific booking</option>
        {recent === null && <option value="loading" disabled>Loading recent bookings…</option>}
        {(recent ?? []).map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
        <option value={OTHER_BOOKING}>Another booking of this member's — enter its ID</option>
      </select>
      {choice === OTHER_BOOKING && (
        <Input
          aria-label="Booking ID"
          className="mt-2 font-mono text-xs"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="00000000-0000-0000-0000-000000000000"
          autoComplete="off"
        />
      )}
      {choice === OTHER_BOOKING && (
        <p className="mt-1 text-xs text-text-muted">
          It must be one of {"this member's"} own bookings. The server refuses another {"member's"}, because naming it
          would change what that member is owed.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger-strong">
          {error}
        </p>
      )}
      <p className="mt-1 text-xs text-text-muted">
        Only for a credit or debit that genuinely compensates this member for that booking. It does not stand in for
        the automatic reversal: when the court box reports the member did attend, the refund and the penalty are
        reversed on their own, and what you post here is netted against that reversal one leg at a time — a positive
        adjustment reduces the penalty the reversal gives back, a negative one reduces the refund it takes away.
        Netting stops at zero per leg, so anything beyond what a leg is worth stands as posted and is not clawed back.
      </p>
    </div>
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

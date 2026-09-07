import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Ban, Fingerprint, KeyRound, MailWarning, Plus, RotateCcw, Search, Users, Wallet, X } from "lucide-react";
import { endpoints, type AdminMember, type BiometricEnrollmentRow, type BiometricTemplateRow, type MemberClass } from "../lib/api";
import {
  OTHER_BOOKING, newIdempotencyKey, recentBookingsFrom, relatedBookingRefusal,
  validateAdjustment, type RecentBooking,
} from "../lib/creditAdjustment";
import { notifyPendingApplicationsChanged } from "../lib/pendingApplications";
import { Card } from "../components/Card";
import { Badge, Button, Input, Label } from "../components/Button";
import { ConfirmButton } from "../components/ConfirmButton";
import { Modal } from "../components/Modal";
import { ScrollArea } from "../components/ScrollArea";
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

/**
 * What an admin is told the temporary password they just generated actually does.
 *
 * <p>
 * It used to read "The member should change it after signing in" — the advisory wording from
 * before the forced-change gate existed, when that sentence was the entire mechanism. The
 * password now unlocks one screen and nothing else, and an admin reading the weaker sentence
 * cannot tell from this screen that the member is locked out of everything until they replace
 * it. This is the API's own wording for the same call.
 * </p>
 *
 * <p>
 * A named constant rather than a JSX block comment beside the paragraph: lizard's TSX scanner
 * reads a braced JSX comment as the end of the enclosing function and swallows the rest of the
 * file into one 347-line pseudo-function, which trips the length gate under a name nobody
 * wrote. Same family as the brace traps already recorded for its C# parser.
 * </p>
 */
const TEMP_PASSWORD_SCOPE =
  "It only unlocks the change-password screen — they must choose a new password before they can do anything else.";

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
    try {
      await endpoints.adminApprove(m.membership_id);
      toast.push({ tone: "success", text: `${m.full_name} approved.` });
      // The chrome's "Members N" badge counts the same applications this screen's "N pending"
      // summary does, and it re-read itself only on navigation — which an approval pressed ON
      // /admin/members does not cause. The two numbers sat contradicting each other on one
      // screen until the admin left the route and came back. See lib/pendingApplications.
      notifyPendingApplicationsChanged();
      await load();
    }
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
      notifyPendingApplicationsChanged();
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
      setMembers((prev) => patchMember(prev, (row) => row.user_id === targetUserId, { balance_credits: r.balance_after_credits }));
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
    setMembers((prev) => patchMember(prev, (r) => r.membership_id === m.membership_id, { member_class: next }));
    try {
      await endpoints.adminSetMemberClass(m.membership_id, next);
      toast.push({ tone: "success", text: `${m.full_name} is now ${classLabel(next).toLowerCase()}.` });
    } catch {
      // Put the old value back: a select that keeps a class the server refused is a lie
      // about a field that doubles what the member's money buys.
      setMembers((prev) => patchMember(prev, (r) => r.membership_id === m.membership_id, { member_class: previous }));
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

      {/*
        ScrollArea, not a bare `overflow-x-auto` div, and a table that stops being a table
        on a phone.

        The bare div was silent in both directions. At 1440 px the nine-column table
        measured 1006 px inside a 990 px box and clipped its own ACTIONS header mid-word;
        at 375 px it was 1006 px inside 341 px, so status, class, balance and every row
        action sat off the right edge behind a scrollbar macOS does not draw — and
        scrolling to reach them took the member's NAME off screen, leaving an admin
        pressing Suspend on a row they could no longer identify.

        Four changes, none of which drops a column:
        • below `sm` each row renders as a card (`block` rows and cells, with the column
          name printed from `data-label`), so everything is on screen at 375 px with no
          sideways scroll at all — measured, 0 px of overflow;
        • from `sm` up the identity column is sticky, so the name stays put while the rest
          of the row scrolls under it;
        • the actions column is sticky too, at the other edge, so the four things an admin
          came here to press are on screen from the moment the page loads rather than 151 px
          beyond the card's right edge;
        • the avatar moved into the name cell and the action icons run in a row rather than
          a column, which took ~90 px off the table's width and row height from 165 px to
          one line (60.5–69 px, measured at 768 and 1440).

        What did NOT happen is the table fitting the card. It is 1141 px against a 990 px
        card at 1440 px and a 734 px one at 768 px, and no arrangement of eight columns that
        keeps a readable name and email fits either. Sideways scroll is therefore the
        mechanism, not a failure of one — and ScrollArea is what stops it being a silent one:
        a gradient, a keyboard tab stop, and a sentence a screen reader can read, none of
        which the plain div had. It was built in round 1 for exactly this and applied only to
        the ledger.
      */}
      <Card className="!p-0 overflow-hidden">
        {filtered.length === 0 ? (
          <EmptyState loading={loading} hasFilters={search.trim().length > 0 || status !== "all"} />
        ) : (
          <ScrollArea label="Members table">
            <table className="w-full text-sm">
              <thead className="hidden sm:table-header-group bg-bg-muted text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <SortHeader label="Name" k="full_name" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="sticky left-0 z-20 bg-bg-muted" />
                  <SortHeader label="Email" k="email" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="hidden xl:table-cell" />
                  <SortHeader label="Member #" k="membership_number" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="hidden lg:table-cell" />
                  <SortHeader label="Status" k="status" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <th className="hidden md:table-cell text-left px-3 py-3">Class</th>
                  <SortHeader label="Joined" k="created_at" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="hidden lg:table-cell" />
                  <th className="text-right px-3 py-3 whitespace-nowrap sticky right-[200px] z-20 bg-bg-muted border-l border-border">Balance</th>
                  <th className="text-right px-3 py-3 whitespace-nowrap sticky right-0 z-20 bg-bg-muted min-w-[200px] border-l border-border">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((m) => (
                  <MemberRow
                    key={m.membership_id}
                    member={m}
                    fingerprints={biometrics[m.user_id]?.templates.length ?? 0}
                    busy={busyId === m.membership_id}
                    onClass={(next) => setMemberClass(m, next)}
                    actions={{
                      approve: () => approve(m),
                      reject: () => { setRejectFor(m); setRejectReason(""); },
                      credit: () => setCreditFor(m),
                      enroll: () => setEnrollFor(m),
                      reset: () => setResetFor(m),
                      suspend: () => { setSuspendFor(m); setSuspendReason(""); },
                      reactivate: () => reactivate(m),
                      resend: () => resendVerification(m),
                    }}
                  />
                ))}
              </tbody>
            </table>
          </ScrollArea>
        )}
      </Card>

      {/* Reject modal */}
      {rejectFor && (
        <Modal onClose={() => setRejectFor(null)} title={`Reject ${rejectFor.full_name}'s application`}>
          {/* Bound, not merely adjacent. Both this and the suspend field below carried a
              <Label> with no `htmlFor` and an <Input> with no `id`, so `el.labels.length`
              was 0 and a screen reader announced an unlabelled edit box — for the one field
              on the screen whose text is emailed verbatim to the person it is about. The
              adjust-credit modal a few lines down had it right all along. */}
          <Label htmlFor="reject-reason">Reason (visible to applicant)</Label>
          <Input id="reject-reason" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="e.g. Membership number not on file." />
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
            They won’t be able to sign in, book a court, or open a court at the box. Their credit balance
            and any bookings they already have are left exactly as they are, and reactivating restores
            everything. The reason is emailed to them.
          </p>
          <Label htmlFor="suspend-reason" className="mt-3">Reason (visible to the member)</Label>
          <Input id="suspend-reason" value={suspendReason} onChange={(e) => setSuspendReason(e.target.value)} placeholder="e.g. Membership dues unpaid since March." />
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
          <p className="text-sm text-text-secondary">
            Emailed to <strong className="text-text-primary">{resetResult.emailSentTo}</strong>. {TEMP_PASSWORD_SCOPE}
          </p>
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

/**
 * One row of the members list, replaced in place.
 *
 * <p>
 * The three callers all correct a single row locally rather than refetching the list, so a
 * sorted, filtered, scrolled table does not jump under the admin's cursor.
 * </p>
 *
 * <p>
 * It is a named function with a block body rather than the inline
 * <code>? {{ ...r, ...patch }} : r</code> each caller used to write, and that is a gate
 * requirement, not taste: lizard's .tsx parser miscounts a brace-bearing object literal
 * inside a ternary and swallows every function after it into the enclosing one, so
 * `make complexity` reported a 278-line `setMemberClass` that does not exist and a
 * 366-line `relatedBookingRefusal` that is nine. See memory/gotchas.md — this is the
 * .tsx face of the same trap the C# expression-body entry describes.
 * </p>
 */
function patchMember(
  rows: AdminMember[] | null,
  matches: (row: AdminMember) => boolean,
  patch: Partial<AdminMember>,
): AdminMember[] | null {
  if (!rows) return rows;
  return rows.map((row) => {
    if (!matches(row)) return row;
    return { ...row, ...patch };
  });
}

/**
 * One row action, as an icon.
 *
 * <p>
 * <b>`disabled` is not decoration on this control.</b> Two of these fire a request straight
 * from the click — Reactivate and Resend verification — and until it existed neither read the
 * `busyId` the handlers were already setting. An ordinary impatient double-click on Reactivate
 * therefore sent two requests: the first returned 200 and the second 409, and the admin was
 * shown both toasts at once — "Aisha Patel is active again." in green above "Couldn't
 * reactivate this member." in red, with nothing on screen saying which was true. Resend was
 * worse than confusing: it sent two verification emails, and §2 spends any earlier unused link
 * on a resend, so the first mail the member received contained a dead link.
 * </p>
 *
 * <p>
 * The guarded <code>Approve</code> button beside these had read <code>busyId</code> since it
 * was written and fired exactly once on the same double-click, which is what made this an
 * omission on one control rather than a missing pattern.
 * </p>
 */
function IconAction({ title, icon, onClick, tone = "info", disabled = false }: { title: string; icon: React.ReactNode; onClick: () => void; tone?: "info" | "danger"; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-busy={disabled}
      title={title}
      aria-label={title}
      className={cn(
        "inline-flex items-center justify-center w-8 h-8 rounded-md text-text-secondary transition shrink-0",
        tone === "danger" ? "hover:text-danger-strong hover:bg-danger-soft" : "hover:text-info-strong hover:bg-info-soft",
        "disabled:opacity-40 disabled:cursor-wait disabled:hover:bg-transparent",
      )}
    >
      {icon}
    </button>
  );
}

/** Everything a row can do, so the row itself holds no page state. */
type MemberRowActions = {
  approve: () => void;
  reject: () => void;
  credit: () => void;
  enroll: () => void;
  reset: () => void;
  suspend: () => void;
  reactivate: () => void;
  resend: () => void;
};

/**
 * A cell that is a table cell on a desktop and a labelled line of a card on a phone.
 *
 * <p>
 * `data-label` is printed by a `::before` pseudo-element below `sm`, which is what lets the
 * same DOM be a nine-column table at 1440 px and a readable card at 375 px without hiding a
 * single column and without rendering the row twice. It has to be a pseudo-element rather
 * than a second `<span>`: a duplicate label in the DOM is a duplicate accessible name, and
 * every `getByText("Status")` in the suite would then match two nodes.
 * </p>
 */
/**
 * Which widths each column is drawn at — one place, so a header and its body cells cannot
 * disagree about it.
 *
 * <p>
 * <b>A pinned column hides whatever the table overflows by.</b> `position: sticky` on the
 * right pulls a cell LEFT of where it sits in flow by exactly the un-scrolled overflow, and
 * whatever was in that band is underneath it. Measured in Chromium against a seeded club:
 * the table is 1079px, its container was 990px at <em>both</em> 1440px and 1920px, and the
 * 89px band immediately left of the pins is precisely where the 99px `Joined` column sat —
 * so the header rendered as a bare glyph and every cell as a single `S`, at every desktop
 * width, with ~800px of page beside it unused. At 768px the overflow is 345px and `Status`
 * and `Class` go under too.
 * </p>
 *
 * <p>
 * Three rounds tried to solve that by column ORDER, and order cannot solve it: the hidden
 * band is wherever the pins land, so every arrangement has a victim. The only overlap-free
 * states are "no overflow" or "no pinning", and pinning is what puts the row actions on
 * screen at all. So this removes the overflow instead: the container widened to `max-w-7xl`
 * for `/admin/*` (Layout.tsx), and below that the columns that do not fit are <b>not drawn</b>
 * rather than drawn underneath something. Below `sm` every field is still on screen, because
 * the row is a card there and nothing is a column at all.
 * </p>
 *
 * <p>
 * The breakpoints come from measured column widths — Name 192 · Email 156 · Member # 103 ·
 * Status 81 · Class 157 · Joined 99 · Balance 90 · Actions 200 — against the container at
 * each one: 608 at `sm`, 734 at `md`, 992 at `lg`, 1248 at `xl`. Changing a width means
 * re-measuring these, which `e2e/admin-members-layout.spec.ts` does in a real browser.
 * </p>
 */
const COLUMN_DISPLAY = {
  /** Card field below `sm`, table cell above it. */
  always: "block sm:table-cell",
  /** Card field below `sm`; from 768 up, once `Class` fits beside the pinned pair. */
  fromMd: "block sm:hidden md:table-cell",
  /** Card field below `sm`; from 1024 up — `Member #` and `Joined`. */
  fromLg: "block sm:hidden lg:table-cell",
  /** Card field below `sm`; from 1280 up, where the full table finally fits its container. */
  fromXl: "block sm:hidden xl:table-cell",
} as const;

function Cell({ label, className, align = "left", display = COLUMN_DISPLAY.always, children }: { label: string; className?: string; align?: "left" | "right"; display?: string; children: React.ReactNode }) {
  return (
    <td
      data-label={label}
      className={cn(
        display,
        "px-0 sm:px-3 py-0.5 sm:py-3 text-left",
        // The label, on a phone only. `content-none` from `sm` up is what keeps it off the
        // desktop table, where the column header already says it.
        "before:content-[attr(data-label)] before:mr-2 before:text-[10px] before:uppercase before:tracking-wide before:text-text-muted sm:before:content-none",
        "before:inline-block before:w-20 sm:before:w-0",
        align === "right" && "sm:text-right",
        className,
      )}
    >
      {children}
    </td>
  );
}

/**
 * One member, as a table row from `sm` up and as a card below it.
 *
 * <p>
 * Lifted out of the page's JSX rather than left inline, because lizard's .tsx parser folds
 * a page's whole return into whichever function precedes it and `make complexity` then
 * measures the lot as one — see the note on {@link patchMember}. It also keeps the row's
 * markup readable, which matters here: the identity cell is sticky, so its background has
 * to be opaque, and that is easy to lose in a 120-line return.
 * </p>
 */
function MemberRow({ member: m, fingerprints, busy, onClass, actions }: {
  member: AdminMember;
  fingerprints: number;
  busy: boolean;
  onClass: (next: MemberClass) => void;
  actions: MemberRowActions;
}) {
  return (
    <tr className="block sm:table-row p-3 sm:p-0 hover:bg-bg-muted/30">
      {/*
        Identity: avatar and name in ONE cell, and sticky from `sm` up.

        Two defects at once. The avatar had a 60 px column of its own, which was 92 px of
        the 1006 px that would not fit the 990 px card; and with the name scrolling away
        with everything else, an admin who scrolled right to reach the actions was pressing
        Suspend on a row they could no longer identify. A sticky cell needs an opaque
        background or the columns underneath show through it as it passes.
      */}
      <td className="block sm:table-cell sm:sticky sm:left-0 sm:z-10 bg-bg-surface px-0 sm:px-3 py-1 sm:py-3 sm:align-middle">
        <div className="flex items-center gap-2">
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
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="font-medium text-text-primary truncate max-w-[180px]" title={m.full_name}>{m.full_name}</p>
              {fingerprints > 0 ? (
                <span
                  title={`${fingerprints} fingerprint(s) enrolled`}
                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-info-soft text-info-strong shrink-0"
                >
                  <Fingerprint size={11} /> {fingerprints}
                </span>
              ) : null}
            </div>
            {m.rejection_reason && <p className="text-xs text-danger-strong truncate max-w-[260px]" title={m.rejection_reason}>{m.rejection_reason}</p>}
          </div>
        </div>
      </td>
      <Cell label="Email" display={COLUMN_DISPLAY.fromXl} className="text-text-secondary sm:max-w-[200px]">
        <span className="inline-block align-middle max-w-[200px] truncate" title={m.email}>{m.email}</span>
        {m.email_verified === false && (
          <span
            title="This member never confirmed their email address, so they cannot sign in with a password."
            className="inline-flex items-center gap-1 ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-warning-soft text-warning-strong align-middle"
          >
            <MailWarning size={11} /> Unverified
          </span>
        )}
      </Cell>
      <Cell label="Member #" display={COLUMN_DISPLAY.fromLg} className="font-mono text-xs text-text-secondary">{m.membership_number}</Cell>
      <Cell label="Status"><Badge tone={statusTone(m.status)}>{prettyStatus(m.status)}</Badge></Cell>
      <Cell label="Class" display={COLUMN_DISPLAY.fromMd}>
        <MemberClassCell member={m} busy={busy} onChange={onClass} />
      </Cell>
      <Cell label="Joined" display={COLUMN_DISPLAY.fromLg} className="text-text-secondary whitespace-nowrap text-xs">
        {new Date(m.created_at).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })}
      </Cell>
      <Cell label="Balance" align="right" className="tabular-nums whitespace-nowrap sm:sticky sm:right-[200px] sm:z-10 bg-bg-surface sm:border-l sm:border-border">
        <span className={cn("font-medium", m.balance_credits < 0 ? "text-danger-strong" : "text-text-primary")}>
          {formatCredits(m.balance_credits)}
        </span>
      </Cell>
      {/*
        Actions: one line, and pinned to the right edge from `sm` up.

        Two rounds argued `flex-wrap` against `flex-row` on the div below without either
        one measuring it, so this was settled in Chromium against the real stack — an admin
        signed in against a seeded club of seven members, at 375, 768 and 1440 px. What the
        three candidate layouts actually do (row height / how many of the 27 action controls
        are on screen before the admin scrolls anything):

          flex-wrap      768: 92.5–136.5 px, 0 of 27 · 1440: 92.5–136.5 px, 0 of 27
          flex-row       768: 60.5–69 px,    0 of 27 · 1440: 60.5–69 px,    0 of 27
          flex-row+pin   768: 60.5–69 px,   27 of 27 · 1440: 60.5–69 px,   27 of 27

        So the comment that used to sit here had it backwards: wrapping is what MAKES the
        tall row, not what prevents it — it lets the table squeeze this column from 197 px to
        96 px, and the buttons then stack into the 136 px row that is two thirds of the way
        back to the original 165 px one. `flex-row` with no wrap is what holds one line.

        And `flex-row` alone was not enough either. The table is 1141 px wide and the card is
        990 px at 1440 px, so before this the entire action set sat outside the scroller's
        box on arrival: every action was reachable, and none was visible. Pinning the column
        the way the identity column is already pinned puts all four on screen at both desktop
        widths with the member's name still opposite them, and the middle columns scroll
        between the two pinned edges.

        The pin overlays whatever it covers, and round 4 tried to solve that by column order
        — `Joined` between `Class` and `Balance`, on the theory that a clipped date cannot
        lie. Measured in Chromium at every pixel of scroll, that was wrong twice over. It did
        not move Balance away from the pin at all (Balance was still the column immediately
        before it), and ordering cannot work in principle: the right pin sweeps
        `[clientWidth - 200, tableWidth]` and the left one sweeps `[0, overflow + 222]`, and
        at 768 px those two ranges already cover the whole 1144 px table. There is no column
        position that is safe from both. What the shipped order actually produced, glyph by
        glyph, was `1500.00 cr` reading as `150` at scrollLeft 96 of 151 at 1440 px — and
        `123456.78 cr` reading as `12345` at scrollLeft 0, before the admin touches anything.
        A member with 123 456 credits displayed as 12 345, on the screen where credit is
        adjusted, with no ellipsis and no cue that anything was cut.

        So the money column is pinned too, beside the actions, rather than left to pass under
        them. `Balance` sits at `right-[200px]` and `Actions` is held to `min-w-[200px]` —
        the two numbers are one decision and the tests assert they match, because a pin whose
        offset no longer equals the width it clears puts the balance straight back under the
        actions. Contiguity is part of it: Balance must be the column immediately before
        Actions or a scrolling column shows through the seam between the two pinned cells.

        One consequence to know about before touching `min-w-[200px]`: it also decides whether
        `flex-wrap` on the div below is still a defect. Round 4 caught wrapping in the browser
        because the table squeezed this column to 96 px and the buttons stacked; with a 200 px
        floor the widest action row (Approve + Reject + Resend) measures 173.4 px of content in
        175.5 px of space, so wrapping now renders identically and no browser assertion can see
        it. That is a 2.1 px margin — a fifth control or a longer label puts it back — so the
        `flex-row` / not-`flex-wrap` assertions in AdminMembers.test.tsx and
        admin-members-layout.test.tsx are what hold that line now, and they are not decoration.

        Measured after the change, at 1 px granularity across five fixture variations (large,
        negative, fractional, all-pending, long-string) at both 768 and 1440: zero scroll
        positions at which any balance renders partially, and the row actions stay 27-of-27
        on screen at rest. The remaining columns scroll between the two pinned edges, which is
        the same sideways scroll ScrollArea announces with a gradient, a tab stop and a
        sentence.
      */}
      <Cell label="Actions" align="right" className="pt-2 sm:pt-3 sm:sticky sm:right-0 sm:z-10 bg-bg-surface sm:min-w-[200px] sm:border-l sm:border-border">
        <div className="flex flex-row items-center gap-1 sm:justify-end">
          {m.status === "PendingApproval" && (
            <>
              <Button onClick={actions.approve} disabled={busy} className="h-9 px-3 text-xs">Approve</Button>
              <Button variant="outline" onClick={actions.reject} disabled={busy} className="h-9 px-3 text-xs">Reject</Button>
            </>
          )}
          {m.status === "Active" && (
            <>
              <IconAction title="Adjust credit" onClick={actions.credit} icon={<Wallet size={16} />} disabled={busy} />
              <IconAction
                title={fingerprints > 0 ? "Manage biometrics" : "Enroll fingerprint"}
                onClick={actions.enroll}
                icon={<Fingerprint size={16} />}
                disabled={busy}
              />
              <IconAction title="Reset password" onClick={actions.reset} icon={<KeyRound size={16} />} disabled={busy} />
              <IconAction
                title="Suspend member"
                onClick={actions.suspend}
                icon={<Ban size={16} />}
                tone="danger"
                disabled={busy}
              />
            </>
          )}
          {m.status === "Suspended" && (
            <>
              <IconAction title="Reactivate member" onClick={actions.reactivate} icon={<RotateCcw size={16} />} disabled={busy} />
              <IconAction title="Reset password" onClick={actions.reset} icon={<KeyRound size={16} />} disabled={busy} />
            </>
          )}
          {m.status === "Rejected" && (
            <IconAction title="Reset password" onClick={actions.reset} icon={<KeyRound size={16} />} disabled={busy} />
          )}
          {/* Available whatever the status: an applicant who never verified is
              stuck before approval matters, and an approved one is stuck after. */}
          {m.email_verified === false && (
            <IconAction title="Resend verification email" onClick={actions.resend} icon={<MailWarning size={16} />} disabled={busy} />
          )}
        </div>
      </Cell>
    </tr>
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

function SortHeader({ label, k, sortKey, sortDir, onSort, className }: { label: string; k: SortKey; sortKey: SortKey; sortDir: SortDir; onSort: (k: SortKey) => void; className?: string }) {
  const active = sortKey === k;
  const Icon = !active ? ArrowUpDown : sortDir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th className={cn("text-left px-3 py-3 whitespace-nowrap", className)}>
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

import { clubInstant } from "./clubClock";
import { clubZone } from "./clubZone";
import { formatCredits } from "./utils";
import { clubShortDate } from "./clubClock";

/**
 * Every sentence the Members list says (P5, R10, R12), in one place — so a test can ask for the
 * words by name and a rewrite of the screen cannot quietly change what an admin is told.
 *
 * <p>
 * <b>The lifecycle sentences are pinned for a reason.</b> Each transition (approve, reject,
 * suspend, reactivate, reset password) commits before its email is attempted, and the API says
 * whether the member was told (`member_notified`). An admin who reads "approved" about a member
 * nobody emailed leaves them waiting for a link that never comes, so each one has two arms and
 * both are asserted in `AdminMembers.test.tsx`.
 * </p>
 */

// ---------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------

export const MEMBERS_PAGE = {
  title: "Members",
  description: "Approve applicants, top up credit, and open anyone's record — their bookings, doors and night.",
  searchLabel: "Search members",
  searchPlaceholder: "Name, email or membership number",
  filterLabel: "Show members",
  tableLabel: "Members table",
  refresh: "Refresh the member list",
  /** The verb phrase `describeFailure` finishes: "Couldn't load the member list — …". */
  loadAction: "load the member list",
  /**
   * Said under the failure, because the absence of rows is the thing being explained: a failed
   * read once rendered as "0 total · 0 pending" over "No members yet." and an admin concluded
   * there was nothing to approve.
   */
  loadCaveat: "This is not an empty club — the list could not be read, so nothing below is the club's real membership.",
  retry: "Try again",
  emptyTitle: "No members yet.",
  emptyHint: "Applications appear here as soon as someone registers.",
  noMatchTitle: "No members match.",
  noMatchHint: "Try another name, or show every status.",
  clearFilters: "Show everyone",
} as const;

/** "142 members in total" / "12 shown · 142 in total" — the only place the word "total" appears. */
export function membersCount(shown: number, total: number): string {
  if (shown === total) return `${total} ${total === 1 ? "member" : "members"} in total`;
  return `${shown} shown · ${total} in total`;
}

// ---------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------

export type MemberStatus = "PendingApproval" | "Active" | "Suspended" | "Rejected";
export type StatusFilter = "all" | MemberStatus;

/** The filter chips, in the order an admin works through them: the queue first. */
export const STATUS_FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "PendingApproval", label: "Pending" },
  { value: "Active", label: "Active" },
  { value: "Suspended", label: "Suspended" },
  { value: "Rejected", label: "Rejected" },
];

/** Anything in the URL that is not a status is "all" — unknown is never one of the others. */
export function statusFilterFrom(raw: string | null): StatusFilter {
  const hit = STATUS_FILTERS.find((f) => f.value === raw);
  return hit ? hit.value : "all";
}

export function statusLabel(status: string): string {
  switch (status) {
    case "PendingApproval": return "Pending";
    case "Active": return "Active";
    case "Suspended": return "Suspended";
    case "Rejected": return "Rejected";
    default: return status;
  }
}

export type StatusTone = "neutral" | "success" | "info" | "warning" | "danger";

export function statusTone(status: string): StatusTone {
  switch (status) {
    case "Active": return "success";
    case "PendingApproval": return "info";
    case "Suspended": return "warning";
    case "Rejected": return "danger";
    default: return "neutral";
  }
}

/** "3 membership applications waiting" — the Pending chip's count, read as a sentence. */
export function pendingCountLabel(n: number): string {
  return `${n} ${n === 1 ? "application" : "applications"} waiting`;
}

export const UNVERIFIED = {
  label: "Unverified",
  /**
   * The marker's title. `e2e/admin-members-layout.spec.ts` counts rows by its prefix, so the
   * sentence starts the same way whatever else changes.
   */
  title: "This member never confirmed their email address, so they cannot sign in with a password.",
} as const;

/**
 * Why a suspended member's row has no Top up. (D3-B18)
 *
 * Both halves, as every refusal on this estate is: what is not available, and what to do about it.
 * In the row rather than in a tooltip, because a title is invisible on a phone and to touch.
 */
export const SUSPENDED_NOTE = "No top-ups until reactivated.";

// ---------------------------------------------------------------------------------------
// Admin role (R20)
// ---------------------------------------------------------------------------------------

export const ADMIN_BADGE = {
  label: "Admin",
  /** Read after the badge by a screen reader, and shown as its tooltip. */
  config: "Set in the server's configuration — it can only be removed there.",
  granted: "Made an admin by the club.",
} as const;

// ---------------------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------------------

export const COLUMNS = {
  member: "Member",
  status: "Status",
  groups: "Groups",
  joined: "Joined",
  lastSeen: "Last seen",
  balance: "Balance",
  actions: "Actions",
} as const;

export const GROUPS_COPY = {
  none: "No groups",
  more: (n: number) => `+${n}`,
  moreTitle: (names: string[]) => names.join(", "),
  /**
   * The groups read failed: the column is not drawn rather than drawn blank, because a blank
   * Groups cell reads as "in no group" — a claim the screen cannot make.
   */
  failed: "Couldn't read group memberships, so the Groups column is hidden.",
  retry: "Read groups again",
} as const;

/** "5 Sep 2026", in the CLUB's calendar — never the reader's own zone. The one short club date. */
export function joinedOn(iso: string): string {
  return clubShortDate(iso, clubZone(), { weekday: false, year: true });
}

const DAY_MS = 86_400_000;

/**
 * "Today", "Yesterday", "3 days ago", "5 Sep 2026", or "Never".
 *
 * <p>
 * Relative for the first week, because "when did they last come in" is a question about
 * recency; a date after that, because "41 days ago" makes the reader do arithmetic. The exact
 * instant is always the cell's title ({@link lastSeenTitle}).
 * </p>
 */
export function lastSeen(iso: string | null | undefined, now: number): string {
  if (!iso) return "Never";
  const days = Math.floor((now - new Date(iso).getTime()) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return joinedOn(iso);
}

export function lastSeenTitle(iso: string | null | undefined): string {
  return iso ? `Last signed in ${clubInstant(iso)}` : "Has never signed in";
}

// ---------------------------------------------------------------------------------------
// Row actions
// ---------------------------------------------------------------------------------------

export const ROW_ACTIONS = {
  approve: "Approve",
  reject: "Reject",
  topUp: "Top up",
  more: (name: string) => `More actions for ${name}`,
  view: "View member",
  book: "Book for member",
  night: "Night trace",
  fingerprints: (count: number) => (count > 0 ? "Manage fingerprints" : "Enrol a fingerprint"),
  reset: "Reset password",
  resend: "Resend verification email",
  suspend: "Suspend member",
  reactivate: "Reactivate member",
} as const;

/** Where each navigation in the row goes — links, never buttons that navigate. */
export const memberHref = (userId: string) => `/admin/members/${userId}`;
export const bookForHref = (userId: string) => `/bookings?as=${encodeURIComponent(userId)}`;
export const nightHref = (userId: string) => `/admin/members/${userId}/night`;

// ---------------------------------------------------------------------------------------
// Outcomes — toasts
// ---------------------------------------------------------------------------------------

export const OUTCOMES = {
  approved: (name: string) => `${name} approved.`,
  approvedUnnotified: (name: string) =>
    `${name} is approved, but the welcome email couldn't be sent. Their membership is active — tell them directly.`,
  approveFailed: "Approval failed.",
  /** F3-3: the reply was lost, the member was read again, and they are Active. */
  approvedAfterLostReply: (name: string) =>
    `${name} is approved — the reply got lost, so the club was asked, and their membership is active. Check with them that the welcome email arrived.`,
  approveUnknown: (name: string) =>
    `It isn't known yet whether ${name} was approved: the reply got lost and the club couldn't be asked. Look at their status in the list before pressing Approve again.`,
  rejected: "Application rejected.",
  rejectedUnnotified: (name: string) =>
    `${name}'s application is rejected, but the email couldn't be sent. Tell them directly — they'll be refused at sign-in until someone does.`,
  suspended: (name: string) => `${name} suspended.`,
  suspendedUnnotified: (name: string) =>
    `${name} is suspended, but the email couldn't be sent. They'll find out at the door unless you tell them.`,
  reactivated: (name: string) => `${name} is active again.`,
  reactivatedUnnotified: (name: string) =>
    `${name} is active again, but the email couldn't be sent. Tell them directly.`,
  reset: (name: string) => `Password reset for ${name}.`,
  resetUnnotified: (name: string) =>
    `Password reset for ${name}, but the email couldn't be sent. Read them the password below.`,
  resendSent: (email: string) => `Verification email sent to ${email}.`,
  resendFailed: "Couldn't send the verification email. Check the mail settings and try again.",
  copied: "Copied to clipboard.",
} as const;

// ---------------------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------------------

export const REJECT_DIALOG = {
  title: (name: string) => `Reject ${name}'s application?`,
  description: "They are emailed the reason and cannot sign in. The application stays on record.",
  reasonLabel: "Reason (visible to applicant)",
  reasonPlaceholder: "e.g. Membership number not on file.",
  confirm: "Reject application",
  action: "reject the application",
} as const;

export const SUSPEND_DIALOG = {
  title: (name: string) => `Suspend ${name}?`,
  description:
    "They won’t be able to sign in, book a court, or open a court at the box. Their credit balance and any bookings they already have are left exactly as they are, and reactivating restores everything. The reason is emailed to them.",
  reasonLabel: "Reason (visible to the member)",
  reasonPlaceholder: "e.g. Membership dues unpaid since March.",
  confirm: "Suspend member",
  action: "suspend this member",
} as const;

export const REACTIVATE_DIALOG = {
  title: (name: string) => `Reactivate ${name}?`,
  description: "They can sign in, book and open courts again straight away, and they are emailed to say so.",
  confirm: "Reactivate member",
  action: "reactivate this member",
} as const;

export const RESET_DIALOG = {
  title: (name: string) => `Reset password for ${name}?`,
  description: (email: string) =>
    `A new temporary password is set on the account and emailed to ${email}. You see it once on the next screen, so you can share it directly if email delivery is uncertain.`,
  confirm: "Reset password",
  action: "reset the password",
} as const;

export const PASSWORD_DIALOG = {
  title: "Temporary password generated",
  emailedTo: "Emailed to",
  notEmailed: "Not emailed",
  notEmailedRest: " — the send failed, so this password only reaches the member if you pass it on. ",
  /**
   * What the password actually does. It used to read "The member should change it after signing
   * in" — the advisory wording from before the forced-change gate existed. It now unlocks one
   * screen and nothing else; this is the API's own wording for the same call.
   */
  scope: "It only unlocks the change-password screen — they must choose a new password before they can do anything else.",
  copy: "Copy password",
  done: "Done",
} as const;

// ---------------------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------------------

export const FINGER_OPTIONS = [
  "left-index", "left-middle", "left-pinky", "left-ring", "left-thumb",
  "right-index", "right-middle", "right-pinky", "right-ring", "right-thumb",
] as const;

export const FINGERPRINTS = {
  title: (name: string) => `Fingerprints — ${name}`,
  description: "Templates live on the club's own reader and never leave it.",
  none: "No fingerprints enrolled yet.",
  enrolled: "Enrolled fingers",
  unspecified: "unspecified",
  remove: (finger: string) => `Remove ${finger}`,
  removeAll: "Remove every fingerprint",
  removeAllConfirm: "Tap to confirm",
  add: "Add a finger",
  enrol: "Enrol a fingerprint",
  consentTitle: "Ask the member to read this",
  consent:
    "I consent to the storage of a biometric template on the on-premises club machine for the purpose of court access at Crusaders. Templates never leave the machine. I can request deletion at any time.",
  consentReceipt: "Consent receipt v1 — recorded with your admin id and the time.",
  acknowledged: "Member agreed — continue",
  fingerLabel: "Finger",
  place: "Ask the member to place their finger on the reader.",
  capture: "Capture fingerprint",
  back: "Back",
  done: "Done",
  enrolledToast: (name: string, finger: string) => `${name} enrolled (${finger}).`,
  enrolFailed: "Enrolment failed. Try again or check the reader.",
  removed: "Fingerprint removed.",
  removeFailed: "Couldn't remove that fingerprint.",
  allRemoved: (name: string) => `${name} has no fingerprints enrolled now.`,
  allRemoveFailed: "Couldn't remove every fingerprint.",
} as const;

// ---------------------------------------------------------------------------------------
// Top-up sheet (the words not already in lib/topUpCopy)
// ---------------------------------------------------------------------------------------

export const TOP_UP_SHEET = {
  steps: ["Amount", "Reason", "Check"] as const,
  quickLabel: "Quick amounts",
  amountLabel: "Another amount",
  amountPlaceholder: "e.g. 150",
  reasonLabel: "Reason",
  reasonDescription: "The member sees this on their wallet.",
  reasonPlaceholder: "Choose a reason",
  detailLabel: "And why this one?",
  detailPlaceholder: "e.g. R200 cash at the desk, receipt 0412",
  next: "Next",
  back: "Back",
  cancel: "Cancel",
  done: "Done",
  balanceNow: "Balance now",
  thisMovement: "This",
  balanceAfter: "Balance after",
  unreadable: "Couldn't read it",
  serverWorksItOut: "the club's system works it out",
  reasonLine: (label: string, text: string) => `Reason: ${label} — “${text}”`,
  failed: "That didn't go through.",
} as const;

/** "+100.00 cr" / "−100.00 cr" — the direction carries the sign, never a typed character. */
export function signedAmount(direction: "add" | "take_back", amount: number): string {
  return `${direction === "add" ? "+" : "−"}${formatCredits(amount)}`;
}

export const RELATED_BOOKING = {
  label: "For booking (optional)",
  none: "Not for a specific booking",
  loading: "Reading recent bookings…",
  other: "Another booking of this member's — enter its ID",
  idLabel: "Booking ID",
  idPlaceholder: "00000000-0000-0000-0000-000000000000",
  otherHint: "It must be one of this member's own bookings. The server refuses another member's, because naming it would change what that member is owed.",
  short: "Name it only when this movement makes up for that booking.",
  moreLabel: "naming a booking",
  more:
    "Only for a credit or debit that genuinely compensates this member for that booking. It does not stand in for the automatic reversal: when the court box reports the member did attend, the refund and the penalty are reversed on their own, and what you post here is netted against that reversal one leg at a time — a positive adjustment reduces the penalty the reversal gives back, a negative one reduces the refund it takes away. Netting stops at zero per leg, so anything beyond what a leg is worth stands as posted and is not clawed back.",
  notAGuid: "That booking ID is not one — it should look like 8-4-4-4-12 hex characters. Pick one from the list or leave it blank.",
} as const;

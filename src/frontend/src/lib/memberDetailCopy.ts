import { minutesCompact } from "./minutes";

/**
 * Every word the member-detail screen says — its header, its six tabs and the admin-role switch.
 *
 * <p>
 * One module for the reason `lib/bookingsCopy.ts` gives: the same sentence is needed in a visible
 * label, an `aria-label` and a live region, and the tests query by these constants, so a wording
 * change is one edit and never a red suite.
 * </p>
 *
 * <p>
 * <b>Outcome-named verbs.</b> A button says what happens ("Make administrator", "Suspend
 * membership"), never "OK" or "Yes"; a dismiss is "Cancel" unless the primary itself cancels
 * something (design-system.md, Dialog copy).
 * </p>
 */

/* ═══════════════════════════════ HEADER ═══════════════════════════════ */

export const MEMBER_COPY = {
  back: "Members",
  backTo: "/admin/members",
  eyebrow: "Member",
  /** A person with an account and no membership row — a bootstrap admin, typically. */
  noName: "Unnamed account",
  refresh: "Refresh this member",
  loadAction: "read this member",
  refreshFailed: "Couldn't refresh this member. What you see was read earlier — press Refresh to try again.",
  notFoundTitle: "No such member",
  notFoundHint: "This club has no member with that link. They may have been removed, or the link belongs to another club.",
  notFoundAction: "Back to members",
  balance: "Balance",
  balanceOverdrawn: "Overdrawn — the next package they buy pays this back first.",
  /** P13 §3.7: the desk takes money by selling a package off the member's own shelf. */
  sell: "Sell package",
  /** Goodwill and corrections, in whole minutes — no money changes hands. */
  adjust: "Adjust minutes",
  /** Why there is no Sell package beside the balance (F3.10) — the members list already says the same. */
  noSell: {
    Suspended: "No packages or adjustments until reactivated.",
    Rejected: "Turned down — approve the application from ⋯ before selling them anything.",
    PendingApproval: "Approve the application before selling them a package.",
    none: "No membership, so no minutes to sell or adjust.",
  } as Record<string, string>,
  bookFor: "Book for member",
  bookForHint: (name: string) => `Opens Bookings with ${name} already chosen as the player.`,
  moreActions: (name: string) => `More actions for ${name}`,
  groupsLabel: "Groups",
  noGroups: "No groups",
  // "Admin" (R4 V4-9): "Administrator" is one long word, and at 320 with 200% text it broke mid-word.
  adminBadge: "Admin",
  adminFromConfig: "Admin · server config",
  tabsLabel: "Member sections",
  noMembership: "No membership",
} as const;

export const STATUS_WORD: Record<string, string> = {
  PendingApproval: "Awaiting approval",
  Active: "Active",
  Rejected: "Rejected",
  Suspended: "Suspended",
};

export function statusTone(status: string | null): "success" | "warning" | "danger" | "neutral" {
  if (status === "Active") return "success";
  if (status === "PendingApproval") return "warning";
  if (status === "Suspended" || status === "Rejected") return "danger";
  return "neutral";
}

/** The six tabs, in order. Each is a route under `/admin/members/:userId`. */
export const MEMBER_TABS = [
  { path: "", label: "Overview" },
  { path: "wallet", label: "Wallet & ledger" },
  { path: "bookings", label: "Bookings" },
  { path: "doors", label: "Door history" },
  { path: "night", label: "Night" },
  { path: "access", label: "Sign-in & biometrics" },
] as const;

export const TOP_UP_COPY = {
  notAGuid: "That booking ID is not one — it should look like 8-4-4-4-12 hex characters. Pick one from the list or leave it blank.",
  refused: "The club refused that adjustment.",
  unreachable: "Couldn't reach the club.",
} as const;

/* ═══════════════════════════════ ⋯ MENU ═══════════════════════════════ */

export const ACTIONS_COPY = {
  approve: "Approve application",
  approveTitle: (name: string) => `Approve ${name}?`,
  approveBody: "They become an active member straight away and are emailed to say so. They can then buy minutes and book.",
  approveConfirm: "Approve member",
  approveAction: "approve this application",
  approved: (name: string) => `${name} is now an active member.`,
  approvedUnnotified: (name: string) => `${name} is active, but the email couldn't be sent. Tell them directly.`,
  approvedAfterLostReply: (name: string) =>
    `${name} is approved — the reply got lost, so the club was asked, and their membership is active. Check with them that the welcome email arrived.`,
  approveUnknown: (name: string) =>
    `It isn't known yet whether ${name} was approved: the reply got lost and the club couldn't be asked. Their status above has been read again.`,

  reject: "Reject application",
  rejectTitle: (name: string) => `Reject ${name}'s application?`,
  rejectBody: "They are emailed the reason below. Their account stays, so they can apply again.",
  rejectConfirm: "Reject application",
  rejectAction: "reject this application",
  rejected: (name: string) => `${name}'s application was rejected.`,
  rejectedUnnotified: (name: string) => `${name}'s application was rejected, but the email couldn't be sent. Tell them directly.`,

  suspend: "Suspend membership",
  suspendTitle: (name: string) => `Suspend ${name}?`,
  suspendBody:
    "They can't book, buy minutes or open the doors until reactivated. Their minutes and existing bookings are kept, and they are emailed the reason below.",
  suspendConfirm: "Suspend membership",
  suspendAction: "suspend this member",
  suspended: (name: string) => `${name} is suspended.`,
  suspendedUnnotified: (name: string) =>
    `${name} is suspended, but the email couldn't be sent. They'll find out at the door unless you tell them.`,

  reactivate: "Reactivate membership",
  reactivateTitle: (name: string) => `Reactivate ${name}?`,
  reactivateBody: "Everything they had comes back exactly as it was — minutes, bookings and door access. They are emailed to say so.",
  reactivateConfirm: "Reactivate membership",
  reactivateAction: "reactivate this member",
  reactivated: (name: string) => `${name} is active again.`,
  reactivatedUnnotified: (name: string) => `${name} is active again, but the email couldn't be sent. Tell them directly.`,

  reason: "Reason",
  reasonHint: "The member reads this in their email, so write it to them.",
  reasonPlaceholder: "e.g. Annual subscription unpaid since 1 September",

  resendVerification: "Resend verification email",
  resent: (email: string) => `Verification email sent to ${email}.`,
  resendFailed: "Couldn't send the verification email. Check the mail settings and try again.",

  /** The desk's answer to "I lost my phone" (member-code §10, §13). */
  resetCode: "Reset member code",
  resetCodeTitle: (name: string) => `Reset ${name}'s member code?`,
  resetCodeBody:
    "For a lost phone or a code somebody else has seen. The code on their phone stops working straight away and they're signed out on every device. They sign in again to get a new code.",
  revokePasskeys: "Also remove their passkeys",
  revokePasskeysHint:
    "Leave this on for a lost phone — a passkey on it could otherwise sign straight back in and pick up the new code.",
  resetCodeReason: "Reason",
  resetCodeReasonHint: "Kept in the change record, and quoted in the email the member gets about the reset.",
  resetCodeReasonPlaceholder: "e.g. Lost their phone at the club",
  resetCodeConfirm: "Reset code",
  resetCodeAction: "reset the member code",
  codeReset: (name: string, passkeysRevoked: boolean, passkeysRemoved: number) =>
    `${name}'s code is reset and they're signed out everywhere. ${passkeySentence(passkeysRevoked, passkeysRemoved)}`,
} as const;

/** What happened to a member's passkeys, for the reset's toast. */
function passkeySentence(revoked: boolean, removed: number): string {
  if (!revoked) return "Their passkeys were kept.";
  if (removed === 0) return "They had no passkeys to remove.";
  return `${countOf(removed, "passkey", "passkeys")} removed — they'll need to add one again.`;
}

/* ═══════════════════════════════ OVERVIEW ═══════════════════════════════ */

/** D9 — "with Sam" · "with Sam and Jo" · "with Sam, Jo and Alex", under a next booking. */
export function withPlayersLine(names: readonly string[]): string {
  if (names.length <= 1) return `with ${names[0] ?? ""}`.trim();
  return `with ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export const OVERVIEW_COPY = {
  nextTitle: "Next bookings",
  nextDescription: "The courts this member is due on, soonest first.",
  nextEmpty: "Nothing booked",
  nextEmptyHint: "No courts coming up for this member.",
  allBookings: "All bookings",
  countsTitle: "Last 30 days",
  countsDescription: "Counted from each booking's start. Attendance means a check-in at the court, never the clock.",
  bookings: "Bookings",
  bookingsHint: "Not cancelled",
  noShows: "No-shows",
  noShowsHint: "Missed without a check-in",
  played: "Sessions played",
  playedHint: "Checked in at the court",
  accountTitle: "Account",
  email: "Email",
  verified: "Email verified",
  verifiedYes: "Yes",
  unverified: "Not verified — they can't sign in with a password yet",
  memberSince: "Member since",
  /** F3-12: an applicant — waiting or turned down — has never been a member. */
  appliedOn: "Applied on",
  lastSignIn: "Last sign-in",
  neverSignedIn: "Never",
  membershipNumber: "Membership number",
  accountStatus: "Account",
  /** F3.10: a turned-down application reads as one thing, not "Rejected" beside "Account: active". */
  application: "Application",
  turnedDown: "Turned down",
  turnedDownBecause: (reason: string) => `Turned down — “${reason}”`,
  passkeys: "Passkeys",
  fingerprints: "Fingerprints",
  manageAccess: "Manage sign-in",
} as const;

export function countOf(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/* ═══════════════════════════════ BOOKINGS ═══════════════════════════════ */

export const BOOKINGS_TAB_COPY = {
  title: "Bookings",
  whenLabel: "Which bookings",
  upcoming: "Upcoming",
  past: "Past",
  loadAction: "read this member's bookings",
  failedCaveat: "That does not mean they have none.",
  emptyUpcoming: "Nothing coming up",
  emptyUpcomingHint: "This member has no bookings that haven't finished yet.",
  emptyPast: "No past bookings",
  emptyPastHint: "Nothing this member booked has finished yet.",
  loadMore: "Load more",
  loadMoreFailed: "Couldn't read the next page. The list above is complete up to here.",
  cancel: "Cancel",
  cancelFor: (court: string, when: string) => `Cancel ${court}, ${when}`,
  bookedBySelf: "Booked by the member",
  bookedBy: (name: string) => `Booked by ${name}`,
  bookedByUnknown: "Booked by the club",
  /** C6: a seat on somebody else's game — theirs to play, the organiser's to cancel. */
  partnerOf: (name: string | null) => (name ? `Playing as ${name}'s partner` : "Playing as a partner"),
  partnerBadge: "Partner",
  checkedIn: "Checked in",
  charged: (minutes: number) => minutesCompact(minutes),
  unknownCourt: "A court",
} as const;

export const BOOKING_STATUS: Record<string, { word: string; tone: "success" | "info" | "neutral" | "danger" | "warning" }> = {
  booked: { word: "Booked", tone: "info" },
  completed: { word: "Played", tone: "success" },
  cancelled: { word: "Cancelled", tone: "neutral" },
  noshow: { word: "No-show", tone: "danger" },
};

/* ═══════════════════════════════ WALLET ═══════════════════════════════ */

export const WALLET_TAB_COPY = {
  title: "Ledger",
  description: "Every movement of this member's minutes, newest first. The balance is the sum of these rows — nothing else.",
  label: (name: string) => `${name}'s ledger`,
  loadAction: "read this member's ledger",
  failedCaveat: "That does not mean nothing has moved.",
  empty: "No movements yet",
  emptyHint: "Packages bought, bookings, refunds and penalties appear here as they happen.",
  showingLatest: (n: number) => `Showing the latest ${n} movements.`,
  seeAll: "Open in Transactions",
} as const;

/** How many ledger rows the tab reads. The Transactions page has the club's whole book. */
export const LEDGER_LIMIT = 200;

/* ═══════════════════════════════ DOORS (D9) ═══════════════════════════════ */

export const DOORS_TAB_COPY = {
  title: "Door history",
  audited: "Viewing this history is recorded in the change record — who looked, at whom, and when.",
  loadAction: "read this member's door history",
  failedCaveat: "Nothing was recorded about this look-up.",
  empty: "No door scans in this range",
  emptyHint: "Try a longer period. Scans older than the club's retention are deleted and can't be shown.",
  period: "Period",
  door: "Door",
  outcome: "Outcome",
  anyDoor: "Any door",
  anyOutcome: "Any outcome",
  released: "Opened",
  refused: "Refused",
  offline: "Decided offline",
  download: "Download CSV",
  downloadAction: "download the CSV",
  downloaded: "CSV downloaded. The download is recorded in the change record too.",
  loadOlder: "Load older scans",
  loadOlderFailed: "Couldn't read older scans. The list above is complete up to here.",
  colWhen: "When",
  colDoor: "Door",
  colOutcome: "Outcome",
  colHow: "How",
  approximate: "Time from the board's own clock after an outage — may be minutes out.",
  offlineNote: "Decided by the board while offline",
  removedDoor: "(removed)",
  unknownDoor: "Unknown door",
  total: (shown: number, total: number) => (shown >= total ? countOf(total, "scan", "scans") : `Showing ${shown} of ${total} scans`),
  retention: (days: number) => `Door scans are kept for ${days} days.`,
} as const;

export const DOOR_PERIODS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last_24h", label: "Last 24 hours" },
  { value: "last_7d", label: "Last 7 days" },
  { value: "last_30d", label: "Last 30 days" },
];

export const DEFAULT_DOOR_PERIOD = "last_7d";

const METHOD_WORD: Record<string, string> = {
  qr: "QR code", code: "Member code", pin: "PIN", fingerprint: "Fingerprint", biometric: "Fingerprint", card: "Card",
};

/** How they identified, in words. An unknown method is shown as the board sent it, never hidden. */
export function doorMethod(method: string | null): string | null {
  if (!method) return null;
  return METHOD_WORD[method.toLowerCase()] ?? method.replace(/_/g, " ");
}

/* ═══════════════════════════════ ACCESS ═══════════════════════════════ */

export const ACCESS_COPY = {
  adminTitle: "Admin rights",
  adminDescription: "Administrators run the club from this console: members, money, courts, doors and settings.",
  signInTitle: "Sign-in",
  signInDescription: "How this member gets into the app.",
  passkeys: "Passkeys",
  passkeysNone: "No passkeys — they sign in with a password or an email link.",
  passkeysSome: (n: number) => `${countOf(n, "passkey", "passkeys")} registered. The member manages their own passkeys from their profile.`,
  emailVerified: "Email verified",
  emailUnverifiedTitle: "Email not verified",
  emailUnverifiedHint: "They can't sign in with a password until they click the link in their verification email.",
  resend: "Resend verification email",
  password: "Password",
  passwordHint: "Sets a temporary password and emails it to them. They must choose a new one when they next sign in.",
  resetPassword: "Reset password",
  resetTitle: (name: string) => `Reset ${name}'s password?`,
  resetBody: (email: string) =>
    `A temporary password is set on the account and emailed to ${email}. You'll see it once, so you can read it to them if the email doesn't arrive.`,
  resetConfirm: "Reset password",
  resetAction: "reset the password",
  resetDoneTitle: "Temporary password",
  resetDoneSent: (email: string) => `Emailed to ${email}. It works once; they choose their own at the next sign-in.`,
  resetDoneUnsent: "The email couldn't be sent. Read this to them — it works once, and they choose their own at the next sign-in.",
  close: "Close",
  noMembershipNote: "This account has no membership row, so there is no password reset to offer from here.",

  fingerprintsTitle: "Court-box fingerprints",
  fingerprintsDescription:
    "Fingerprint templates stored on the club's own reader, used to switch on a booked court. They never leave the club's machine.",
  fingerprintsNone: "No fingerprints enrolled.",
  enrolled: (when: string) => `Enrolled ${when}`,
  unlabelled: "Unlabelled finger",
  remove: (finger: string) => `Remove ${finger}`,
  removeShort: "Remove",
  removeTitle: (finger: string) => `Remove ${finger}?`,
  removeBody: "Every court box forgets this finger at its next roster read. The member can enrol it again at any time.",
  removeConfirm: "Remove fingerprint",
  removeAction: "remove the fingerprint",
  removed: "Fingerprint removed.",
  enrol: "Enrol a finger",
  enrolTitle: (name: string) => `Enrol a finger for ${name}`,
  consentStep: "Consent",
  consent:
    "I consent to the storage of a biometric template on the on-premises club machine for the purpose of court access at the club. Templates never leave the machine. I can ask for deletion at any time.",
  consentReceipt: "Consent receipt v1 — recorded with your admin id and the time.",
  consentGiven: "Member agreed — continue",
  finger: "Finger",
  captureHint: "Ask the member to place that finger on the reader, then capture.",
  capture: "Capture fingerprint",
  captureAction: "capture the fingerprint",
  captured: (finger: string) => `${finger} enrolled.`,
  back: "Back",
  cancel: "Cancel",
} as const;

export const FINGER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "right-index", label: "Right index" },
  { value: "right-middle", label: "Right middle" },
  { value: "right-thumb", label: "Right thumb" },
  { value: "left-index", label: "Left index" },
  { value: "left-middle", label: "Left middle" },
  { value: "left-thumb", label: "Left thumb" },
];

export function fingerLabel(value: string | null): string {
  if (!value) return ACCESS_COPY.unlabelled;
  return FINGER_OPTIONS.find((f) => f.value === value)?.label ?? value.replace(/-/g, " ");
}

/* ═══════════════════════════════ ADMIN ROLE (R20) ═══════════════════════════════ */

export const ADMIN_ROLE_COPY = {
  label: "Administrator",
  descriptionOn: (name: string) => `${name} can use this console. Every change they make is recorded against their name.`,
  descriptionOff: (name: string) => `${name} uses the app as a member only.`,
  configLocked:
    "Set in the server's configuration (Admins:Emails). It can't be removed from here — whoever runs the server changes it there.",
  notActive: "Only an active member can be made an administrator. Approve or reactivate them first.",
  /**
   * R5 lane G: the same two reasons under a ⋯ item (members list, the record's header), where a
   * menu row has a few words, not a paragraph. The item's own label is `grantConfirm` /
   * `revokeConfirm` — the menu names the act the dialog's primary performs.
   */
  menuConfigLocked: "Set in the server's configuration — only whoever runs the server can remove it.",
  menuNotActive: "Only an active member can be made an administrator.",
  grantTitle: (name: string) => `Make ${name} an administrator?`,
  grantBody: (name: string) =>
    `${name} will be able to manage members, sell and adjust minutes, book courts for members even past what their balance covers, open doors and change settings. They and every other admin are emailed the reason.`,
  grantConfirm: "Make administrator",
  grantAction: "grant admin rights",
  granted: (name: string) => `${name} is now an administrator.`,
  revokeTitle: (name: string) => `Remove ${name}'s admin rights?`,
  revokeBody: (name: string) =>
    `${name} goes back to being a member. It takes effect within seconds, even on a screen they already have open. They and every other admin are emailed the reason.`,
  revokeSelfTitle: "Remove your own admin rights?",
  revokeSelfBody:
    "You'll lose this console within seconds — including this page. Only another administrator can give the rights back.",
  revokeConfirm: "Remove admin rights",
  revokeAction: "remove admin rights",
  revoked: (name: string) => `${name} is no longer an administrator.`,
  /** R3 lost-reply audit: what the member read again still shows, and what is not known. */
  stillNotAdmin: (name: string) => `${name} is still not an administrator`,
  stillAdmin: (name: string) => `${name} is still an administrator`,
  whetherGranted: (name: string) => `${name} was made an administrator`,
  whetherRevoked: (name: string) => `${name}'s admin rights were removed`,
  reason: "Reason",
  reasonHint: "Recorded in the change record and sent in the email.",
  reasonPlaceholder: "e.g. Stepped down from the committee",
  /** A grant asks for its reason too (F3.9, contract §7): the change record says why either way. */
  grantReasonPlaceholder: "e.g. Joined the committee as treasurer",
  confirmSelf: "Yes — remove my own admin rights",
  /** R3 A-16: the reason is there, the second yes is not. */
  confirmSelfMissing: "Tick “Yes — remove my own admin rights” first. Nothing was changed.",
  unchanged: (name: string, isAdmin: boolean) =>
    isAdmin ? `${name} was already an administrator.` : `${name} already wasn't an administrator.`,
} as const;

/** Every refusal the admin-role route can give, in words (R20). */
export const ADMIN_ROLE_CODES: Record<string, string> = {
  last_admin: "You're the last administrator — make someone else an admin first.",
  not_active_member: "Only an active member can be an administrator. Approve or reactivate them first.",
  admin_inherited_from_config:
    "This person's admin rights come from the server's configuration, so they can't be removed here. Whoever runs the server changes it there.",
  confirm_self_required: "Tick the box to confirm you mean to remove your own admin rights.",
  actor_not_admin: "Your own admin rights have been removed, so you can't change anyone else's. Sign in again to see what you can do.",
  member_not_found: "This club has no such member any more. Go back to Members and refresh.",
  reason_required: "Say why — the reason is recorded and emailed.",
  grant_required: "Something went wrong building that request. Refresh the page and try again.",
};

/* ═══════════════════════════════ NIGHT ═══════════════════════════════ */

export const NIGHT_TAB_COPY = {
  /** R4 carry-over: a night read a page at a time. */
  showing: (shown: number, total: number | null) =>
    total === null ? `Showing the first ${shown} events.` : `Showing ${shown} of ${total} events.`,
  showMore: "Show more of this night",
  title: "Night",
  pickerTitle: "A person’s night",
  pickerDescription: "Choose a member to open their night. It now lives on the member's own page.",
  pickerLabel: "Which member?",
  pickerPlaceholder: "Search the club's members",
  membersFailed: "Couldn't read the club's members. That is not the same as the club having none — try again.",
  membersRetry: "Try again",
  open: "Open their night",
  download: "Download CSV",
  downloadFailed: "Couldn't build that CSV.",
} as const;

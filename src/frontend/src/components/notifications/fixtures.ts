import type { AdminNotice, AdminNoticeKind } from "@/lib/notificationsApi";

/**
 * Test fixtures for the admin alerts (R23) — the catalogue and the feed, in the server's shapes.
 * Imported by tests only.
 */

/** Four of the twelve kinds: two an admin may switch off (one already off), two nobody may. */
export const KINDS_FIXTURE: AdminNoticeKind[] = [
  {
    kind: "member.registered", title: "New membership applications",
    description: "Somebody has applied to join and is waiting for approval.", optional: true, opted_out: false,
  },
  {
    kind: "device.offline", title: "Court box or door stopped reporting",
    description: "A board the club has acknowledged has gone silent.", optional: true, opted_out: true,
  },
  {
    kind: "admin.role_changed", title: "Administrator changes",
    description: "Somebody was made an administrator, or stopped being one.", optional: false, opted_out: false,
  },
  {
    kind: "code.forgery_suspected", title: "Suspected forged codes",
    description: "A board accepted a code this club could not have issued.", optional: false, opted_out: false,
  },
];

export const KINDS_ROUTE = { path: "/api/v1/admin/notifications/kinds", body: { kinds: KINDS_FIXTURE } };

let seq = 0;

export function noticeFixture(overrides: Partial<AdminNotice> = {}): AdminNotice {
  seq += 1;
  return {
    id: `n-${seq}`,
    kind: "member.registered",
    title: "New membership applications",
    headline: "Thandi Mokoena applied to join",
    link: "/admin/members",
    subject_user_id: null,
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    delivery: { state: "sent", sent_at: new Date().toISOString(), finished_at: new Date().toISOString(), recipients: 3 },
    ...overrides,
  };
}

import { api } from "./api";

/**
 * The admin-notice wire (R23): the club's feed of things every admin was told about, the
 * catalogue the email-alert switches are drawn from, and the one write — a person's own opt-outs.
 *
 * <p>
 * <b>The feed is the club's, not the caller's.</b> Every admin sees every notice, including kinds
 * they have switched off: an opt-out stops the email, never the record. The feed carries a
 * headline, a console link and how delivery went — never the payload, which holds applicants'
 * addresses and members' balances and is for the email alone.
 * </p>
 *
 * <p>
 * <b>Opting out is a preference, not a club setting.</b> It is written through
 * `PUT /api/v1/me/preferences` with the WHOLE list, snake_case (the spelling the contract names;
 * the server binds both). The kinds route only reads, so a switch and the notifier cannot disagree
 * about what a kind is called or whether it may be switched off.
 * </p>
 */

/** Where one notice's email got to. `sent_at` is set only for `sent`; `finished_at` for any finished state. */
export type NoticeDeliveryState = "pending" | "sent" | "suppressed" | "failed";

export type AdminNotice = {
  id: string;
  /** The dotted kind — `member.registered`, `device.offline` — a closed set the catalogue names. */
  kind: string;
  /** The kind's own title, as the switches call it. */
  title: string;
  headline: string;
  /** A console path (`/admin/members`), or null when there is nowhere to go. */
  link: string | null;
  subject_user_id: string | null;
  created_at: string;
  delivery: {
    state: NoticeDeliveryState;
    sent_at: string | null;
    finished_at: string | null;
    /** Admins actually emailed so far; null from a server that does not count. */
    recipients: number | null;
  };
};

export type AdminNoticePage = { items: AdminNotice[]; next_cursor: string | null };

/** One switch: what it is, whether this admin may switch it off, and whether they have. */
export type AdminNoticeKind = {
  kind: string;
  title: string;
  description: string;
  optional: boolean;
  opted_out: boolean;
  /**
   * How many OTHER active admins are still emailed this kind (review round 1, F3.11). Absent from
   * an API that does not send it — then the switch says what it cannot know rather than guessing.
   */
  others_receiving?: number;
};

/** The feed's page size. Twenty is the server's own default; asked for explicitly so both agree. */
export const NOTICE_PAGE_SIZE = 20;

function feedPath(cursor?: string | null, limit = NOTICE_PAGE_SIZE): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  return `/api/v1/admin/notifications?${params.toString()}`;
}

export const notificationsEndpoints = {
  /** One page, newest first. A malformed cursor is 400 `cursor_invalid`, never a silent page one. */
  feed: (cursor?: string | null) => api.get<AdminNoticePage>(feedPath(cursor)),
  kinds: () => api.get<{ kinds: AdminNoticeKind[] }>("/api/v1/admin/notifications/kinds").then((r) => r.kinds),
  /**
   * The complete opt-out list — a replace, not a patch. 400 `notification_kind_not_optional`
   * when it names a kind nobody may switch off.
   */
  setOptouts: (kinds: readonly string[]) =>
    api.put<{ admin_notification_optouts?: string[] }>("/api/v1/me/preferences", { admin_notification_optouts: [...kinds] }),
};

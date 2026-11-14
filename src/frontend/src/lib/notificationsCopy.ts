import { clubDayAndClock } from "./clubClock";
import type { AdminNotice, NoticeDeliveryState } from "./notificationsApi";

/**
 * The words of the admin alerts (R23): the Overview's "Recent alerts" feed and the "Email alerts"
 * switches Settings and Profile share. Tests query by these, so a copy change is one edit.
 */

export const RECENT_ALERTS_COPY = {
  title: "Recent alerts",
  description: "What every admin was emailed about, newest first — including kinds you have switched off.",
  readAction: "read the recent alerts",
  readCaveat: "That doesn’t mean nothing happened.",
  emptyTitle: "No alerts yet",
  emptyHint: "When something needs an admin — a new application, a court box going quiet — it appears here and"
    + " every admin is emailed.",
  loadMore: "Show older alerts",
  loadMoreFailed: "Couldn’t read older alerts. What is shown above is still right — try again.",
  cursorExpired: "The list moved on since it was read. Refresh the Overview to start again from the newest.",
  listLabel: "Recent alerts, newest first",
  /** R5 A5-6: the Overview shows the five newest; the rest open in place. */
  seeAll: (count: number) => `See all ${count} alerts`,
} as const;

/** How many alerts the Overview shows before "See all" (R5 A5-6: 34 cards were 3,025px on a phone). */
export const RECENT_ALERTS_SHOWN = 5;

/**
 * The Overview's Console list on a phone (R5 A5-6): it repeats the section switcher above it, so
 * there it is one toggle.
 */
export const CONSOLE_COPY = {
  show: "Show every section",
  hide: "Hide the sections",
} as const;

/** The delivery badge: a word and a tone, so the tone is never the only carrier. */
export function deliveryBadge(delivery: AdminNotice["delivery"]): { label: string; tone: "success" | "info" | "neutral" | "danger" | "warning" } {
  const state: NoticeDeliveryState = delivery.state;
  switch (state) {
    case "sent":
      if (delivery.recipients === 0) return { label: "No admin to email", tone: "warning" };
      // A server that does not count answers null (or nothing): say it was emailed, not to whom.
      if (typeof delivery.recipients !== "number") return { label: "Emailed", tone: "success" };
      return { label: `Emailed ${delivery.recipients} ${delivery.recipients === 1 ? "admin" : "admins"}`, tone: "success" };
    case "suppressed":
      // BA-12: a demo club mails nobody, so its feed says what WOULD have happened, never "told recently".
      if (delivery.reason === "demo_club") return { label: "Would have emailed the admins — a demo club sends no mail", tone: "neutral" };
      if (delivery.reason === "recipient_inactive") return { label: "Not emailed — the account is not active", tone: "neutral" };
      return { label: "Not emailed — told recently", tone: "neutral" };
    case "failed":
      return { label: "Email failed", tone: "danger" };
    default:
      return { label: "Sending", tone: "info" };
  }
}

/**
 * "just now" · "5 minutes ago" · "3 hours ago" · "2 days ago" — and past a week the club's own date,
 * because "23 days ago" makes the reader do arithmetic to find the day. Words, never "min" or "h"
 * (R7 J7-3): the age is read inside the alert's accessible description, a sentence.
 */
export function noticeAge(iso: string, now: number, timezone?: string): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? "yesterday" : `${days} days ago`;
  // ICU's en-GB spells September "Sept"; the week strip and the grid say "Sep".
  return clubDayAndClock(iso, timezone).replace(/\bSept\b/, "Sep");
}

/** Where an admin chooses which alerts reach their inbox — linked from the Overview (F3.11). */
export const EMAIL_ALERTS_HREF = "/admin/settings#settings-alerts";

export const EMAIL_ALERTS_COPY = {
  chooseLink: "Choose which of these you're emailed about",
  settingsTitle: "Your email alerts",
  profileTitle: "Email alerts",
  description: "Which of the club’s alerts reach your inbox. Only for you — other admins keep their own. Each"
    + " switch saves the moment you flip it.",
  feedNote: "Switching one off stops the email, not the record: it still shows under Recent alerts on the Overview.",
  readAction: "read your email alerts",
  readCaveat: "Nothing was changed.",
  alwaysOn: "Always on",
  saving: "Saving…",
  switchedOn: (title: string) => `You will be emailed about ${lower(title)}.`,
  switchedOff: (title: string) => `You won’t be emailed about ${lower(title)} any more.`,
  saveFailed: (title: string) => `Couldn’t change the ${lower(title)} email. Nothing changed — try again.`,
  notOptional: (title: string) => `${title} can’t be switched off — every admin is always told.`,
  /** Said AT the switch once it is off (F3.11): who, if anybody, is still emailed. */
  nobodyTold: "Nobody is emailed about this now — every admin has switched it off. It still shows under Recent alerts.",
  othersTold: (n: number) => `${n === 1 ? "1 other admin is" : `${n} other admins are`} still emailed about this.`,
  othersUnknown: "Other admins choose for themselves. If they have all switched this off too, nobody is emailed — it still shows under Recent alerts.",
} as const;

/** The line under a switched-off alert: nobody / N others / not known. */
export function whoIsStillTold(othersReceiving: number | undefined): { text: string; nobody: boolean } {
  if (othersReceiving === undefined) return { text: EMAIL_ALERTS_COPY.othersUnknown, nobody: false };
  if (othersReceiving <= 0) return { text: EMAIL_ALERTS_COPY.nobodyTold, nobody: true };
  return { text: EMAIL_ALERTS_COPY.othersTold(othersReceiving), nobody: false };
}

/**
 * Why a kind nobody may switch off is locked on — said beside the lock, not behind it, because a
 * switch that will not move and does not say why reads as broken.
 */
const LOCKED_BECAUSE: Record<string, string> = {
  "admin.role_changed": "Who holds admin rights decides who can see and undo everything else, so every admin is told.",
  "webhook.auto_disabled": "A switched-off webhook means another system has stopped hearing from the club, so every admin is told.",
  "code.forgery_suspected": "A forged code means somebody may be attacking the club’s system, so every admin is told.",
};

export function lockedBecause(kind: string): string {
  return LOCKED_BECAUSE[kind] ?? "This one is about the club’s security, so every admin is always told.";
}

function lower(title: string): string {
  return title.charAt(0).toLowerCase() + title.slice(1);
}

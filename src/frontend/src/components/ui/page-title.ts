import { createContext } from "react";

/**
 * Whether the navigation already NAMES the page on screen — the active tab (top bar or the phone's
 * tab bar), or the admin rail / section switcher's active item. Where it does, `PageHeader` keeps
 * its `<h1>` for screen readers and the route announcer but does not paint it: the same word twice,
 * one row apart, was redundant (Dean, 2026-10). Provided by the shell (`AppShell`, `AdminLayout`),
 * which know the route; default `false`, so a page rendered anywhere else keeps a visible title.
 *
 * <p>
 * A page whose title says something the nav does not — a member's name, a booking, a door, any
 * page under a section (it has a `back` link) or off the nav (Inbox, Profile) — is never named by
 * the nav, so its title stays.
 * </p>
 */
export const PageNamedByNav = createContext(false);

/** `/admin/members/` and `/admin/members` are one page. */
export function samePath(a: string, b: string): boolean {
  const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return trim(a) === trim(b);
}

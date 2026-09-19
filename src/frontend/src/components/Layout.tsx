import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { DoorClosed, LogOut, Settings as SettingsIcon, Wallet as WalletIcon, Webhook as WebhookIcon, Cpu } from "lucide-react";
import { ShutDoorsBanner } from "./doors/ShutDoorsBanner";
import { useDoorsChrome } from "./doors/useDoorsChrome";
import { endpoints } from "../lib/api";
import { useAuth } from "../lib/auth";
import { tokenStore } from "../lib/api";
import { LOW_BALANCE_CREDITS, useBalance, walletLabel } from "../lib/balance";
import { useProfile } from "../lib/profile";
import { ScrollArea } from "./ScrollArea";
import { pendingApplicationsVersion, subscribePendingApplications } from "../lib/pendingApplications";
import { cn, formatCredits } from "../lib/utils";

/**
 * How many membership applications are sitting unreviewed — the in-app half of §2.3's
 * "all tenant admins notified (email + in-app)".
 *
 * <p>
 * Only the email half existed. An admin who signed in with somebody waiting to be approved saw
 * nothing anywhere in the chrome — no badge, no count, nothing in the menu — and the only cue
 * in the whole product was a line INSIDE /admin/members, which you have to already suspect
 * something to go and look at. An application could sit for days behind an email nobody opened.
 * </p>
 *
 * <p>
 * Re-read on every navigation <b>and on every change to the pending set</b>. Navigation
 * alone was not enough and the comment that used to sit here claimed the opposite: Approve
 * and Reject are pressed <em>on</em> <code>/admin/members</code>, the console patches the
 * row in place without refetching, and <code>location.pathname</code> does not change — so
 * the badge went on counting an applicant the admin had just dealt with, beside that same
 * screen's own "3 pending" summary. <code>lib/pendingApplications</code> is how the console
 * says the set moved; the count itself still comes from the server, never from the console's
 * optimistic view of it.
 * </p>
 */
function usePendingApplicationCount(enabled: boolean, routeKey: string): number {
  const [count, setCount] = useState(0);
  const changeVersion = useSyncExternalStore(subscribePendingApplications, pendingApplicationsVersion, pendingApplicationsVersion);

  useEffect(() => {
    if (!enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears the badge when the session stops being an admin one
      setCount(0);
      return;
    }
    let cancelled = false;
    endpoints.adminMembers("PendingApproval")
      .then((rows) => { if (!cancelled) setCount(rows.length); })
      .catch(() => { /* A badge is a cue, not a screen: a failed read shows nothing rather than an error. */ });
    return () => { cancelled = true; };
  }, [enabled, routeKey, changeVersion]);

  return count;
}

export default function Layout() {
  const auth = useAuth();
  const nav = useNavigate();
  const location = useLocation();
  const { balance, loading } = useBalance();
  const { profile } = useProfile();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const pendingApplications = usePendingApplicationCount(
    auth.status === "authenticated" && auth.isAdmin,
    location.pathname,
  );
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  /**
   * doors: admin — the chrome's half of the doors surface (A1.5, A2.6).
   *
   * Two things ride on one read: the attention cue on the gear and its menu item, and the
   * club-wide banner while any door is shut. Both take the `usePendingApplicationCount`
   * posture — re-read on navigation, and a failed read shows nothing rather than an error,
   * so the banner's absence has never meant "no doors are shut" and a failed read cannot
   * produce a false all-clear.
   */
  const doors = useDoorsChrome(
    auth.status === "authenticated" && auth.isAdmin,
    location.pathname,
  );
  const doorsNeedingAttention = doors.attention.length;

  // Hide the chrome on auth-flow routes — login/register/verify/welcome/reset — so the
  // user only sees the auth modal itself.
  //
  // `change-password` is in here because of the forced case: a session holding an
  // admin-issued temporary password can reach nothing else, so a nav bar and a wallet
  // chip would be links to 403s. Members changing their password by choice do it from
  // the card on /profile, with the chrome where they expect it.
  const headerless = /^\/(login|register|verify-email|welcome|forgot-password|reset-password|change-password)(\/|$)/.test(location.pathname);

  /**
   * The signed-out root is the club's public page, not a screen of the app.
   *
   * <p>
   * It rendered inside the app chrome, which put a sticky bar over it carrying the club's name
   * and a "Sign in" link — both of which the page's own hero already says, larger and better.
   * A landing page wearing an application's toolbar reads as an intranet.
   * </p>
   *
   * <p>
   * Signed IN, the root is a member's home and the nav is the whole point, so this applies only
   * while anonymous.
   * </p>
   *
   * <p>
   * The initial auth probe is the awkward case, and a stored token settles it without waiting.
   * Guessing "public" for everybody flashes a late-arriving bar at every returning member;
   * guessing "app" for everybody flashes chrome at every first-time visitor. `tokenStore.get()`
   * is a synchronous localStorage read that says which of the two this almost certainly is, so
   * neither group sees the flash. It only has to be right about intent, not about whether the
   * token is still valid — an expired one resolves to anonymous a moment later and the bar goes
   * away, which is the same thing signing out does.
   * </p>
   */
  const probablySignedIn = auth.status === "loading" && Boolean(tokenStore.get());
  const publicLanding =
    location.pathname === "/" && auth.status !== "authenticated" && !probablySignedIn;

  // Every way out of the settings menu, including the keyboard one.
  //
  // Escape did nothing: only the mousedown listener existed, so a keyboard user who opened the
  // menu could tab into it and choose an item, or tab back out, but could not dismiss it without
  // reaching for the mouse. WAI-ARIA's menu pattern makes Escape the way out, and it also has to
  // put focus back on the button that opened the menu — closing it while focus sits on a node
  // that no longer exists drops the keyboard user at the top of the document.
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  if (publicLanding) {
    // No chrome, no width cap and no inner scroll container: the page lays itself out, and the
    // DOCUMENT scrolls. The app's own shell scrolls a nested <main> instead, which on a long
    // marketing page stops a phone's URL bar collapsing and breaks scroll-to-anchor.
    return (
      <main className="min-h-full">
        <Outlet />
      </main>
    );
  }

  if (headerless) {
    return (
      <div className="h-full flex flex-col">
        <main className="flex-1 min-h-0 flex flex-col overflow-auto"><div className="max-w-5xl w-full mx-auto px-4 py-6 flex-1 min-h-0 flex flex-col"><Outlet /></div></main>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <header className="bg-bg-surface border-b border-border sticky top-0 z-30">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center gap-4">
          <NavLink to="/" className="font-semibold tracking-tight whitespace-nowrap min-w-0 truncate">Crusaders Squash</NavLink>
          {auth.status === "authenticated" && (
            // `lg`, not `md`. The inline nav switched on at 768 and the row it sits in needs
            // 800: an admin has five tabs, and at 768 the header measured a 795px scrollWidth
            // against a 768px viewport on all ten routes — 27px of whole-page sideways scroll
            // with the gear button (`Open menu`, and the only route to Sign out) running from
            // 751 to 795 and therefore sliced by the right edge. A member, with three tabs,
            // was clean at every width, which is why it survived so long.
            //
            // Between 768 and 1023 the scrolling tab strip below takes over instead. It is
            // the same nav, it announces its own overflow, and it is what a phone already
            // gets — a strip that scrolls beats a gear you cannot press.
            <nav className="hidden lg:flex items-center gap-1 text-sm min-w-0">
              <NavTab to="/schedule" label="Bookings" />
              <NavTab to="/court-code" label="Court code" />
              {auth.isAdmin && <NavTab to="/admin/ledger" label="Transactions" />}
              {auth.isAdmin && <NavTab to="/admin/members" label="Members" badge={pendingApplications} />}
              <NavTab to="/reports" label="Reports" />
            </nav>
          )}
          <div className="ml-auto flex items-center gap-2 shrink-0">
            {auth.status === "authenticated" && (
              <NavLink
                to="/wallet"
                className={({ isActive }) => cn(
                  "inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-sm font-medium tabular-nums whitespace-nowrap transition-colors",
                  balance !== null && balance < LOW_BALANCE_CREDITS
                    ? "bg-warning-soft text-warning-strong hover:bg-warning-soft/80"
                    : "bg-success-soft text-success-strong hover:bg-success-soft/80",
                  isActive && "ring-1 ring-accent-strong/30",
                )}
                /*
                  The NUMBER, in the name.

                  This was `aria-label="Wallet balance"`, and an aria-label REPLACES an
                  element's contents as its accessible name — so a screen reader announced
                  "Wallet balance, link" and the balance itself, the only reason the chip
                  exists, was never read out at all. It is also the only place in the chrome
                  that says whether a member can afford to book.

                  The low-balance state goes in too. It is carried visually by the chip turning
                  amber, and a colour is not an announcement.
                */
                aria-label={walletLabel(balance, loading)}
                title={loading ? "Refreshing balance…" : "Wallet balance — tap to top up"}
              >
                <WalletIcon size={14} strokeWidth={2.25} />
                {/* aria-hidden: the label above already says the number, and the visible text
                    abbreviates it to "cr", which is not a word. */}
                <span aria-hidden="true">{balance === null ? "— cr" : formatCredits(balance)}</span>
              </NavLink>
            )}
            {auth.status === "authenticated" && (
              <NavLink
                to="/profile"
                aria-label="Edit profile"
                title={profile?.full_name ?? profile?.email ?? "Profile"}
                className={({ isActive }) => cn(
                  "shrink-0 rounded-full overflow-hidden border-2 transition-all",
                  isActive ? "border-accent-strong" : "border-border hover:border-accent-strong/60",
                )}
                style={{ width: 36, height: 36 }}
              >
                {profile?.photo_url ? (
                  <img src={profile.photo_url} alt="" className="w-full h-full object-cover" />
                ) : (
                  <span className="w-full h-full flex items-center justify-center text-xs font-semibold bg-bg-muted text-text-secondary">
                    {(profile?.full_name?.[0] ?? profile?.email?.[0] ?? "?").toUpperCase()}
                  </span>
                )}
              </NavLink>
            )}
            {auth.status === "authenticated" ? (
              <div className="relative" ref={menuRef}>
                <button
                  ref={menuButtonRef}
                  onClick={() => setMenuOpen((v) => !v)}
                  /* doors: admin — the count goes in the NAME, because a number inside a 44 px
                     circular icon button is unreadable at 360 and a dot is not, and because
                     colour alone is never the signal. */
                  aria-label={doorsNeedingAttention === 0
                    ? "Open menu"
                    : `Open menu — ${doorsNeedingAttention} ${doorsNeedingAttention === 1 ? "door needs" : "doors need"} attention`}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  className="relative inline-flex items-center justify-center w-11 h-11 rounded-full text-text-secondary hover:text-text-primary hover:bg-bg-muted"
                >
                  <SettingsIcon size={26} strokeWidth={1.75} />
                  {doorsNeedingAttention > 0 && (
                    <span aria-hidden="true" className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-danger-strong" />
                  )}
                </button>
                {menuOpen && (
                  <div
                    role="menu"
                    className="absolute right-0 mt-2 w-56 rounded-lg border border-border bg-bg-surface shadow-lg z-40 overflow-hidden"
                  >
                    {auth.isAdmin && (
                      <>
                        {/* doors: admin — first, above Devices, and NOT a sixth tab. This file
                            already carries the cost of the alternative in the nav comment above:
                            five admin tabs measured a 795 px scrollWidth against a 768 px
                            viewport, which is why the inline nav switches at `lg`. Ordered by
                            urgency of use rather than alphabetically — Doors is opened standing
                            in a club with a member waiting, Webhooks twice a year. `DoorClosed`,
                            not `DoorOpen`: an open door is a state claim this product cannot
                            make, two lines above the page whose whole discipline is not making
                            it. */}
                        <MenuItem
                          onClick={() => { setMenuOpen(false); nav("/admin/doors"); }}
                          icon={<DoorClosed size={16} />}
                          label="Doors"
                          badge={{
                            count: doorsNeedingAttention,
                            label: `${doorsNeedingAttention} ${doorsNeedingAttention === 1 ? "door needs" : "doors need"} attention`,
                          }}
                        />
                        <MenuItem
                          onClick={() => { setMenuOpen(false); nav("/admin/devices"); }}
                          icon={<Cpu size={16} />}
                          label="Devices"
                        />
                        <MenuItem
                          onClick={() => { setMenuOpen(false); nav("/admin/settings"); }}
                          icon={<SettingsIcon size={16} />}
                          label="Admin settings"
                        />
                        <MenuItem
                          onClick={() => { setMenuOpen(false); nav("/admin/webhooks"); }}
                          icon={<WebhookIcon size={16} />}
                          label="Webhooks"
                        />
                        <div className="border-t border-border" />
                      </>
                    )}
                    <MenuItem
                      onClick={() => { setMenuOpen(false); auth.logout(); nav("/login"); }}
                      icon={<LogOut size={16} />}
                      label="Sign out"
                      tone="danger"
                    />
                  </div>
                )}
              </div>
            ) : auth.status === "anonymous" ? (
              <NavLink to="/login" className="text-sm font-medium text-accent-strong hover:underline">Sign in</NavLink>
            ) : null}
          </div>
        </div>
        {auth.status === "authenticated" && (
          // The compact tab strip — phones, and now every width below `lg`, because five admin
          // tabs do not fit the header row until 1024. It scrolls sideways and used to hide its own scrollbar, so at 375px
          // the last tab ("Reports") was simply cut off at the edge with nothing to say it was
          // there. ScrollArea is the same container the wallet ledger uses: a fade at the edge for
          // anyone who can see it, a tab stop so the arrow keys can reach the rest, and a sentence
          // for a screen reader while there is more to reach.
          <nav className="lg:hidden border-t border-border" aria-label="Sections">
            <ScrollArea label="Section tabs">
              <div className="flex items-center gap-1 px-2 py-1 text-sm w-max">
              <NavTab to="/schedule" label="Bookings" />
              <NavTab to="/court-code" label="Court code" />
              {auth.isAdmin && <NavTab to="/admin/ledger" label="Transactions" />}
              {auth.isAdmin && <NavTab to="/admin/members" label="Members" badge={pendingApplications} />}
              <NavTab to="/reports" label="Reports" />
            </div>
            </ScrollArea>
          </nav>
        )}
      </header>
      {/*
        The admin console gets the width the page already has.

        Every route was capped at `max-w-5xl`, so the members table's scroll container
        measured 990px at 1440px AND at 1920px — roughly 800px of screen sitting unused
        beside a table that is 1079px wide and was therefore hiding a whole column
        underneath its two pinned ones at every desktop width. Member-facing routes stay at
        5xl on purpose: the booking grid, the wallet and the top-up flow are mobile-first
        reading widths, and stretching them to 1280px makes them worse, not better.
      */}
      <main className="flex-1 min-h-0 flex flex-col overflow-auto"><div className={cn(
        "w-full mx-auto px-4 py-6 flex-1 min-h-0 flex flex-col",
        location.pathname.startsWith("/admin/") ? "max-w-7xl" : "max-w-5xl",
      )}>
        {/* doors: admin — the club-wide shut banner (A1.5 / D5), on EVERY admin route rather
            than only the doors pages. Shut-all has no timed auto-reopen, so without this a
            club that shut every door after an incident discovers it at 05:50 the next
            morning with thirty members outside. */}
        {location.pathname.startsWith("/admin/") && (
          <ShutDoorsBanner shut={doors.shut} total={doors.total} />
        )}
        <Outlet />
      </div></main>
    </div>
  );
}

function NavTab({ to, label, badge = 0 }: { to: string; label: string; badge?: number }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `px-3 h-9 inline-flex items-center gap-1.5 rounded-lg ${isActive ? "bg-accent-soft text-accent-strong font-medium" : "text-text-secondary hover:bg-bg-muted"}`}
    >
      {label}
      {badge > 0 && (
        // The number alone means nothing to a screen reader beside the word "Members", so the
        // count carries the sentence and the digits are decoration.
        <span
          className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-info-soft text-info-strong text-xs font-semibold tabular-nums"
          aria-label={`${badge} membership ${badge === 1 ? "application" : "applications"} awaiting review`}
          title={`${badge} awaiting review`}
        >
          {badge}
        </span>
      )}
    </NavLink>
  );
}

function MenuItem({
  onClick, icon, label, tone = "default", badge,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  tone?: "default" | "danger";
  /**
   * doors: admin — the same numeric pill NavTab uses, on the same terms: a zero renders
   * nothing. The count and its sentence travel together because they are one thing and
   * because two flat props put this signature over the complexity gate's parameter bound.
   */
  badge?: { count: number; label: string };
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-left transition",
        tone === "danger"
          ? "text-danger-strong hover:bg-danger-soft/50"
          : "text-text-primary hover:bg-bg-muted",
      )}
    >
      <span className="text-text-muted">{icon}</span>
      <span>{label}</span>
      {badge && badge.count > 0 && (
        // The digits are decoration; the sentence is the name. Same rule as NavTab's badge —
        // "2" beside the word "Doors" means nothing to a screen reader.
        <span
          className="ml-auto inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-info-soft text-info-strong text-xs font-semibold tabular-nums"
          aria-label={badge.label}
          title={badge.label}
        >
          {badge.count}
        </span>
      )}
    </button>
  );
}

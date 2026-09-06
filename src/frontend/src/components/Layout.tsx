import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { LogOut, Settings as SettingsIcon, Wallet as WalletIcon, Webhook as WebhookIcon, Cpu } from "lucide-react";
import { endpoints } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useBalance } from "../lib/balance";
import { useProfile } from "../lib/profile";
import { ScrollArea } from "./ScrollArea";
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
 * Re-read on every navigation, which is what makes it correct after an approval: the console
 * patches its row in place without refetching, so the badge would otherwise still claim a
 * pending application the admin has just dealt with.
 * </p>
 */
function usePendingApplicationCount(enabled: boolean, routeKey: string): number {
  const [count, setCount] = useState(0);

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
  }, [enabled, routeKey]);

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

  // Hide the chrome on auth-flow routes — login/register/verify/welcome/reset — so the
  // user only sees the auth modal itself.
  //
  // `change-password` is in here because of the forced case: a session holding an
  // admin-issued temporary password can reach nothing else, so a nav bar and a wallet
  // chip would be links to 403s. Members changing their password by choice do it from
  // the card on /profile, with the chrome where they expect it.
  const headerless = /^\/(login|register|verify-email|welcome|forgot-password|reset-password|change-password)(\/|$)/.test(location.pathname);

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
          <NavLink to="/" className="font-semibold tracking-tight whitespace-nowrap">Crusaders Squash</NavLink>
          {auth.status === "authenticated" && (
            <nav className="hidden md:flex items-center gap-1 text-sm">
              <NavTab to="/schedule" label="Bookings" />
              <NavTab to="/court-code" label="Court code" />
              {auth.isAdmin && <NavTab to="/admin/ledger" label="Transactions" />}
              {auth.isAdmin && <NavTab to="/admin/members" label="Members" badge={pendingApplications} />}
              <NavTab to="/reports" label="Reports" />
            </nav>
          )}
          <div className="ml-auto flex items-center gap-2">
            {auth.status === "authenticated" && (
              <NavLink
                to="/wallet"
                className={({ isActive }) => cn(
                  "inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-sm font-medium tabular-nums whitespace-nowrap transition-colors",
                  balance !== null && balance < 50
                    ? "bg-warning-soft text-warning-strong hover:bg-warning-soft/80"
                    : "bg-success-soft text-success-strong hover:bg-success-soft/80",
                  isActive && "ring-1 ring-accent-strong/30",
                )}
                aria-label="Wallet balance"
                title={loading ? "Refreshing balance…" : "Wallet balance — tap to top up"}
              >
                <WalletIcon size={14} strokeWidth={2.25} />
                <span>{balance === null ? "— cr" : formatCredits(balance)}</span>
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
                  aria-label="Open menu"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  className="inline-flex items-center justify-center w-11 h-11 rounded-full text-text-secondary hover:text-text-primary hover:bg-bg-muted"
                >
                  <SettingsIcon size={26} strokeWidth={1.75} />
                </button>
                {menuOpen && (
                  <div
                    role="menu"
                    className="absolute right-0 mt-2 w-56 rounded-lg border border-border bg-bg-surface shadow-lg z-40 overflow-hidden"
                  >
                    {auth.isAdmin && (
                      <>
                        <MenuItem
                          onClick={() => { setMenuOpen(false); nav("/admin/settings"); }}
                          icon={<SettingsIcon size={16} />}
                          label="Admin settings"
                        />
                        <MenuItem
                          onClick={() => { setMenuOpen(false); nav("/admin/devices"); }}
                          icon={<Cpu size={16} />}
                          label="Devices"
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
          // The mobile tab strip scrolls sideways and used to hide its own scrollbar, so at 375px
          // the last tab ("Reports") was simply cut off at the edge with nothing to say it was
          // there. ScrollArea is the same container the wallet ledger uses: a fade at the edge for
          // anyone who can see it, a tab stop so the arrow keys can reach the rest, and a sentence
          // for a screen reader while there is more to reach.
          <nav className="md:hidden border-t border-border" aria-label="Sections">
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
      <main className="flex-1 min-h-0 flex flex-col overflow-auto"><div className="max-w-5xl w-full mx-auto px-4 py-6 flex-1 min-h-0 flex flex-col">
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
  onClick, icon, label, tone = "default",
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  tone?: "default" | "danger";
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
    </button>
  );
}

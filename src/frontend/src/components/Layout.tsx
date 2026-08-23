import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { LogOut, Settings as SettingsIcon, Wallet as WalletIcon, Webhook as WebhookIcon, Cpu } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useBalance } from "../lib/balance";
import { useProfile } from "../lib/profile";
import { cn, formatCredits } from "../lib/utils";

export default function Layout() {
  const auth = useAuth();
  const nav = useNavigate();
  const location = useLocation();
  const { balance, loading } = useBalance();
  const { profile } = useProfile();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Hide the chrome on auth-flow routes — login/register/verify/welcome — so the
  // user only sees the auth modal itself.
  const headerless = /^\/(login|register|verify-email|welcome|forgot-password)(\/|$)/.test(location.pathname);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
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
              {auth.isAdmin && <NavTab to="/admin/ledger" label="Transactions" />}
              {auth.isAdmin && <NavTab to="/admin/members" label="Members" />}
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
          <nav className="md:hidden border-t border-border overflow-x-auto no-scrollbar">
            <div className="flex items-center gap-1 px-2 py-1 text-sm w-max">
              <NavTab to="/schedule" label="Bookings" />
              {auth.isAdmin && <NavTab to="/admin/ledger" label="Transactions" />}
              {auth.isAdmin && <NavTab to="/admin/members" label="Members" />}
              <NavTab to="/reports" label="Reports" />
            </div>
          </nav>
        )}
      </header>
      <main className="flex-1 min-h-0 flex flex-col overflow-auto"><div className="max-w-5xl w-full mx-auto px-4 py-6 flex-1 min-h-0 flex flex-col">
        <Outlet />
      </div></main>
    </div>
  );
}

function NavTab({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `px-3 h-9 inline-flex items-center rounded-lg ${isActive ? "bg-accent-soft text-accent-strong font-medium" : "text-text-secondary hover:bg-bg-muted"}`}
    >
      {label}
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

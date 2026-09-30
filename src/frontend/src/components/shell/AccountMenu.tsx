import { useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Desktop, HandWaving, MapTrifold, Moon, Question, SignOut, Sun, UserCircle, type Icon } from "@/components/ui/icons";
import { useAuth } from "@/lib/auth";
import {
  ADMIN_TOUR_PATH, GET_STARTED_PATH, GUIDE_LINK_LABEL, GUIDE_PATH, REPLAY_ADMIN_TOUR, REPLAY_WELCOME,
} from "@/lib/onboardingCopy";
import { useProfile } from "@/lib/profile";
import { focusHeading } from "@/lib/routeAnnouncer";
import { useTheme, type ThemeChoice } from "@/lib/theme";

/**
 * The account menu, behind the avatar (Target IA → Shell). R16 retired the gear: every admin
 * destination it held lives under the Admin tab now, so what is left here is the person's own
 * things — Profile, Appearance, How it works, Sign out.
 *
 * <p>
 * <b>Appearance makes dark mode live (D7).</b> System / Light / Dark are radio items on
 * `useTheme()`; choosing one keeps the menu open, so a member can flick between them and see the
 * app change under the menu before deciding.
 * </p>
 *
 * <p>
 * <b>"Replay welcome" and "Replay admin tour" (P8)</b> are links, because each goes somewhere:
 * the wizard from its first step, and the console's Overview with the tour asked for. Each is
 * shown only to whoever has that tour — an active member, an admin — never greyed for anyone
 * else.
 * </p>
 *
 * <p>
 * Radix supplies the menu contract the old hand-built one had to spell out (B15): focus moves in
 * on open, arrow keys rove and wrap (`loop` — Radix's default stops at the ends), Home/End jump,
 * typeahead, Escape closes and restores focus to the avatar, Tab out closes. Navigations are real links (`asChild` + `Link`) so they can be
 * opened in a new tab; Sign out is a button because it is not a destination.
 * </p>
 */

const THEMES: { value: ThemeChoice; label: string; icon: Icon }[] = [
  { value: "system", label: "System", icon: Desktop },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

function isThemeChoice(value: string): value is ThemeChoice {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * R4 (X4-4) — after a destination is chosen, focus goes to the destination.
 *
 * <p>
 * Radix returns focus to the avatar when the menu closes, which is right for Escape and wrong for
 * a navigation: "Replay admin tour" opened the tour with focus still on the avatar, so the tour was
 * never announced and Tab could not reach it; Profile and Replay welcome left it there too. The
 * route announcer's own move to the new heading lost the race — a modal menu holds focus until it
 * unmounts, then hands it back. So the menu's close is told not to, and focus goes to the tour
 * when one opens, otherwise to the new page's heading, once either has rendered (a lazy page's
 * heading arrives with its chunk). Never off something the person has moved to since.
 * </p>
 */
function focusWhereItWent(timeoutMs = 3_000) {
  const started = Date.now();
  let landed: HTMLElement | null = null;
  const attempt = () => {
    const active = document.activeElement;
    const free = !active || active === document.body || active === landed;
    const tour = document.querySelector<HTMLElement>("[data-coachmark]");
    if (tour && free) {
      tour.focus();
      return;
    }
    const heading = landed ? null : document.querySelector<HTMLElement>("#main-content h1");
    if (heading && free) {
      focusHeading(heading, false);
      landed = heading;
    }
    // Keep looking for a tour that opens after the page does, for as long as focus sits where
    // this put it; anything the person has moved to since is theirs.
    if (Date.now() - started < timeoutMs && (landed === null || document.activeElement === landed)) {
      window.setTimeout(attempt, 50);
    }
  };
  window.setTimeout(attempt, 0);
}

export function AccountMenu() {
  const auth = useAuth();
  /** Set when an item navigates, so the close hands focus to the destination (X4-4). */
  const went = useRef(false);
  const going = () => { went.current = true; };
  const navigate = useNavigate();
  const { profile } = useProfile();
  const { theme, setTheme } = useTheme();
  const name = profile?.full_name?.trim() || profile?.email || "Your account";
  const member = (profile?.status ?? "").toLowerCase() === "active";
  const admin = auth.status === "authenticated" && auth.isAdmin;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account menu"
        data-account-menu=""
        className="no-lift inline-flex size-touch shrink-0 items-center justify-center rounded-full border border-transparent hover:bg-bg-muted data-[state=open]:bg-bg-muted"
      >
        <Avatar size={32}>
          {profile?.photo_url ? <AvatarImage src={profile.photo_url} alt="" /> : null}
          <AvatarFallback aria-hidden="true">{initials(name)}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end" loop className="w-64"
        onCloseAutoFocus={(event) => {
          if (!went.current) return;
          went.current = false;
          event.preventDefault();
          focusWhereItWent();
        }}
      >
        <Identity name={name} email={profile?.email ?? null} photo={profile?.photo_url ?? null} />
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild onSelect={going}>
          <Link to="/profile">
            <UserCircle size={16} aria-hidden="true" className="text-text-muted" />
            Profile
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild onSelect={going}>
          <Link to={GUIDE_PATH}>
            <Question size={16} aria-hidden="true" className="text-text-muted" />
            {GUIDE_LINK_LABEL}
          </Link>
        </DropdownMenuItem>
        {member ? (
          <DropdownMenuItem asChild onSelect={going}>
            <Link to={`${GET_STARTED_PATH}?replay=1`}>
              <HandWaving size={16} aria-hidden="true" className="text-text-muted" />
              {REPLAY_WELCOME}
            </Link>
          </DropdownMenuItem>
        ) : null}
        {admin ? (
          <DropdownMenuItem asChild onSelect={going}>
            <Link to={ADMIN_TOUR_PATH}>
              <MapTrifold size={16} aria-hidden="true" className="text-text-muted" />
              {REPLAY_ADMIN_TOUR}
            </Link>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={(value) => { if (isThemeChoice(value)) setTheme(value); }}>
          {THEMES.map(({ value, label, icon: Glyph }) => (
            <DropdownMenuRadioItem key={value} value={value} onSelect={(event) => event.preventDefault()}>
              <Glyph size={16} aria-hidden="true" className="text-text-muted" />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="danger"
          onSelect={() => {
            going();
            void auth.logout();
            navigate("/login");
          }}
        >
          <SignOut size={16} aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Who is signed in — not interactive, so it is a label row rather than an item. */
function Identity({ name, email, photo }: { name: string; email: string | null; photo: string | null }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <Avatar size={40}>
        {photo ? <AvatarImage src={photo} alt="" /> : null}
        <AvatarFallback aria-hidden="true">{initials(name)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-text-primary">{name}</p>
        {email && email !== name ? <p className="truncate text-xs text-text-muted">{email}</p> : null}
      </div>
    </div>
  );
}

/** "Dean Martin" → "DM"; first and last word so a middle name never crowds the circle. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = Array.from(words[0])[0] ?? "";
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] ?? "" : "";
  return (first + last).toLocaleUpperCase();
}

import { Link, useNavigate } from "react-router-dom";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Desktop, Moon, Question, SignOut, Sun, UserCircle, type Icon } from "@/components/ui/icons";
import { useAuth } from "@/lib/auth";
import { GUIDE_LINK_LABEL, GUIDE_PATH } from "@/lib/onboardingCopy";
import { useProfile } from "@/lib/profile";
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
 * <b>"Replay welcome" is omitted, not disabled.</b> The welcome wizard is P8's; a greyed item
 * would be a control that does nothing and cannot say why. It arrives with the wizard.
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

export function AccountMenu() {
  const auth = useAuth();
  const navigate = useNavigate();
  const { profile } = useProfile();
  const { theme, setTheme } = useTheme();
  const name = profile?.full_name?.trim() || profile?.email || "Your account";

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
      <DropdownMenuContent align="end" loop className="w-64">
        <Identity name={name} email={profile?.email ?? null} photo={profile?.photo_url ?? null} />
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/profile">
            <UserCircle size={16} aria-hidden="true" className="text-text-muted" />
            Profile
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to={GUIDE_PATH}>
            <Question size={16} aria-hidden="true" className="text-text-muted" />
            {GUIDE_LINK_LABEL}
          </Link>
        </DropdownMenuItem>
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

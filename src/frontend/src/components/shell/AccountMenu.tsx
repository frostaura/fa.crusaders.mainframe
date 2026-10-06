import { useRef, useState } from "react";
import { intentProps } from "@/routeChunks";
import { Link, useNavigate } from "react-router-dom";
import { EmailWithBreaks } from "@/components/members/EmailWithBreaks";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ArrowCounterClockwise, Compass, Desktop, Moon, Question, SignOut, Sun, UserCircle, Wallet, type Icon } from "@/components/ui/icons";
import { walletHref } from "@/lib/walletLabel";
import { Minutes } from "@/components/Minutes";
import { NO_FIGURE_SPOKEN } from "@/lib/minutes";
import { useChipBalance } from "./chipBalance";
import { DemoPart } from "./demoChrome";
import { useAuth } from "@/lib/useAuth";
import {
  ADMIN_TOUR_PATH, GET_STARTED_PATH, GUIDE_LINK_LABEL, GUIDE_PATH, REPLAY_ADMIN_TOUR, REPLAY_WELCOME,
} from "@/lib/onboardingCopy";
import { useProfile } from "@/lib/useProfile";
import { focusHeading } from "@/lib/routeAnnouncer";
import { useTheme, type ThemeChoice } from "@/lib/theme";
import { initialsOf } from "@/lib/initials";

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
  /** V5-4 — the chip has folded away (large text on a phone): the figure is said here instead. */
  const [chipFolded, setChipFolded] = useState(false);

  return (
    <DropdownMenu onOpenChange={(open) => { if (open) setChipFolded(chipIsFolded()); }}>
      <DropdownMenuTrigger
        aria-label="Account menu"
        data-account-menu=""
        className="no-lift inline-flex size-touch shrink-0 items-center justify-center rounded-full border border-transparent hover:bg-bg-muted data-[state=open]:bg-bg-muted"
      >
        {/* R15 L15-6 — the avatar is rem-sized and the button is a px touch target: at 200 % the
            64px circle overflowed the 44px button and the app bar. It never outgrows its button. */}
        <Avatar size={32} className="max-h-full max-w-full">
          {profile?.photo_url ? <AvatarImage src={profile.photo_url} alt="" /> : null}
          <AvatarFallback aria-hidden="true"><Mark name={profile ? name : null} /></AvatarFallback>
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
        <Identity name={name} known={profile !== null} email={profile?.email ?? null} photo={profile?.photo_url ?? null} />
        <DropdownMenuSeparator />
        {chipFolded ? <WalletItem onSelect={going} /> : null}
        <DropdownMenuItem asChild onSelect={going}>
          <Link to="/profile" {...intentProps("/profile")}>
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
              {/* P5-7 (R5): glyphs the first load already carries — HandWaving and MapTrifold were
                  5.4 kB raw in every member's entry chunk for two menu items. */}
              <ArrowCounterClockwise size={16} aria-hidden="true" className="text-text-muted" />
              {REPLAY_WELCOME}
            </Link>
          </DropdownMenuItem>
        ) : null}
        {admin ? (
          <DropdownMenuItem asChild onSelect={going}>
            <Link to={ADMIN_TOUR_PATH}>
              <Compass size={16} aria-hidden="true" className="text-text-muted" />
              {REPLAY_ADMIN_TOUR}
            </Link>
          </DropdownMenuItem>
        ) : null}
        {admin ? <DemoPart part="menu" /> : null}
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

/** Whether the minutes chip is in the bar but not drawn (its slot folded at large text, V5-4). */
function chipIsFolded(): boolean {
  const slot = document.querySelector<HTMLElement>("[data-minutes-chip-slot]");
  // `checkVisibility` (not a computed style: cheap, and absent — so "not folded" — in jsdom).
  return slot !== null && typeof slot.checkVisibility === "function" && !slot.checkVisibility();
}

/** The chip's figure as a menu item, for when the chip has folded away (V5-4). */
function WalletItem({ onSelect }: { onSelect: () => void }) {
  const { figures } = useChipBalance();
  const shown = figures.shown;
  return (
    // R13 L13-2: the figure WRAPS under "Wallet" when the row cannot hold both (a 320 phone at
    // 200 % text: the menu ended at 296 and "2 h 45 min" ran to 320, clipped). `flex-wrap` with the
    // figure's `ml-auto` keeps it right-aligned on its own line; `py-2` so the two lines breathe.
    <DropdownMenuItem asChild onSelect={onSelect} className="flex-wrap py-2">
      <Link to={walletHref(shown)}>
        <Wallet size={16} aria-hidden="true" className="text-text-muted" />
        Wallet{" "}
        <span data-wallet-figure="" className="ml-auto max-w-full whitespace-nowrap font-semibold tabular-nums">
          {/* R6 X6-2: the figure is heard in words — "1 hour 30 minutes", never "1 h 30 min". */}
          {shown === null
            ? <><span aria-hidden="true">— min</span><span className="sr-only">{NO_FIGURE_SPOKEN}</span></>
            : <Minutes value={shown} />}
        </span>
      </Link>
    </DropdownMenuItem>
  );
}

/**
 * Who is signed in — not interactive, so it is a label row rather than an item.
 *
 * <p>
 * R14 L14-4 — the name and the address WRAP, never cut: at 200 % the 80px avatar beside them left
 * "Chiama…" and "l14c+mu…". The address breaks after its "@" and before each "." (`EmailWithBreaks`),
 * mid-word only where one part alone is wider than the menu. And when the TEXT is large for the menu
 * (a rem query on the row's own box, under 13.5rem — the menu is 16rem until a phone caps it) the
 * avatar stands over the name, so the words have the menu's whole width.
 * </p>
 */
function Identity({ name, known, email, photo }: { name: string; known: boolean; email: string | null; photo: string | null }) {
  return (
    <div data-account-identity="" className="px-3 py-2 [container-type:inline-size]">
      <div className="flex items-center gap-3 [@container(max-width:13.49rem)]:flex-col [@container(max-width:13.49rem)]:items-start">
        <Avatar size={40}>
          {photo ? <AvatarImage src={photo} alt="" /> : null}
          <AvatarFallback aria-hidden="true"><Mark name={known ? name : null} /></AvatarFallback>
        </Avatar>
        <div className="min-w-0 max-w-full">
          <p className="break-words text-sm font-semibold text-text-primary">{name}</p>
          {email && email !== name ? <p className="break-words text-xs text-text-muted"><EmailWithBreaks email={email} /></p> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * R10 X10-1 — what the avatar draws without a photo: the member's initials, or, with no profile in
 * hand (not read yet, failed, offline with nothing kept), the neutral person glyph. "Your account"
 * is a phrase for the menu's text, and its letters — "YA" — are nobody's initials.
 */
function Mark({ name }: { name: string | null }) {
  return name === null ? <UserCircle size="100%" aria-hidden="true" /> : <>{initialsOf(name)}</>;
}

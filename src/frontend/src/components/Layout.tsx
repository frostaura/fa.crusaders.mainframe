import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
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
  const pendingApplications = usePendingApplicationCount(
    auth.status === "authenticated" && auth.isAdmin,
    location.pathname,
  );
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

  /**
   * B13 — how tall the chrome actually is, published for anything that must sit under it.
   *
   * <p>
   * The toast strip was anchored at a constant 100 px, which is the header's height at a
   * 16 px root font on a wide screen and nothing like it anywhere else: at a 32 px root the
   * header plus the section tab strip is taller, so the offline error toast covered the tab
   * bar — the only way between sections a phone has. A guessed constant is wrong on exactly
   * the configuration the finding was raised on.
   * </p>
   *
   * <p>
   * Measured rather than computed: the header wraps, so its height is a function of the
   * viewport width, the root font size and how many tabs this session has. `ResizeObserver`
   * is what catches all three. It is written to the document element as a custom property
   * because the consumer — `ToastProvider` — is mounted ABOVE this component and cannot be
   * handed a prop.
   * </p>
   */
  const headerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const root = document.documentElement;
    const header = headerRef.current;
    if (!header) {
      root.style.setProperty("--app-chrome-height", "0px");
      return () => root.style.removeProperty("--app-chrome-height");
    }
    const publish = () => root.style.setProperty("--app-chrome-height", `${Math.round(header.getBoundingClientRect().height)}px`);
    publish();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(publish);
    observer?.observe(header);
    window.addEventListener("resize", publish);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", publish);
      root.style.removeProperty("--app-chrome-height");
    };
  }, [publicLanding, headerless, auth.status]);

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
      {/*
        B11 — the first thing in the DOM, and the first thing a keyboard reaches.
        <p>
        Nine tab stops stood between the top of the document and the page's own content: the
        club name, five section tabs, the wallet chip, the avatar and the gear — on EVERY
        route, so a keyboard user paid for the whole header again after every navigation.
        </p>
        <p>
        `sr-only focus:not-sr-only` is the standard shape: no pixels until it is focused,
        which is why it costs a sighted mouse user nothing. `focus:fixed` rather than
        `focus:absolute` deliberately — the header is `sticky` and the shell has no
        positioned ancestor here, so an absolutely-positioned link would resolve against the
        initial containing block anyway and scroll away from the reader who just focused it.
        </p>
        <p>
        The click handler is not decoration. `href="#main-content"` alone leaves the browser
        to decide, and a fragment jump only moves FOCUS (rather than just the scroll
        position) when the target is focusable — which is why `<main>` carries
        `tabIndex={-1}` below. Focusing it here as well makes the behaviour the same in every
        engine and, more to the point, testable: jsdom performs no fragment navigation at
        all, so a skip link resting on the browser's good behaviour is a skip link nothing
        can hold to its promise.
        </p>
      */}
      <a
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:inline-flex focus:min-h-11 focus:items-center focus:rounded-lg focus:border focus:border-accent-strong focus:bg-bg-surface focus:px-4 focus:text-sm focus:font-medium focus:text-accent-strong focus:shadow-md"
      >
        Skip to main content
      </a>
      <header ref={headerRef} data-app-header className="bg-bg-surface border-b border-border sticky top-0 z-30">
        {/*
          A10 / C14 / D6 — the row WRAPS rather than overflowing.

          At 200 % browser zoom on a phone, and at a 32 px root font size on a 360 px screen,
          this row's contents are wider than the screen and every one of them is
          `whitespace-nowrap`. It had `h-14` and no wrap, so the surplus went sideways: the
          whole document scrolled, and the thing sliced by the right edge was the gear — the
          only route to Doors and to Sign out.

          `flex-wrap` + `min-h-[3.5rem]` is the same 56 px row at every ordinary width (the
          content is 44 px tall, well inside the minimum) and a second line instead of a
          horizontal scrollbar when it genuinely cannot fit. The club name still truncates
          first, because it is the only item here that carries no action.
        */}
        {/*
          B12 — every length in this row is now PIXELS, not rem.

          At a 32 px root font size `min-h-[3.5rem]` is 112 px, `h-11` is 88 px and the row
          wrapped to three of them: the header and the tab strip together took 54 % of a
          320×568 screen, leaving the page itself less than half the phone. None of that
          height is a touch target — 44 px is — it is a touch target written in a unit that
          doubles when the text doubles. The TEXT still scales, which is the whole point of
          a root font size; the boxes around it stop scaling at the size a fingertip needs.

          The GAPS and PADDINGS go the same way, and they are most of the number. Measured
          on a coarse pointer at 320×568 with a 32 px root, one change at a time:
          262 px of chrome → 234 (the club name's `py-2.5`, which was 40 px of padding round
          a 48 px word) → 182 (the wallet chip's `px-3`, 48 px of padding that pushed the
          cluster's total 4 px past the row and wrapped the gear onto a line of its own).
          182 px is 32 % of the phone, against the 54 % reviewer B measured.
        */}
        <div className="max-w-5xl mx-auto px-4 min-h-[56px] py-[4px] flex flex-wrap items-center gap-x-[16px] gap-y-[4px]">
          {/*
            B12, second pass — a touch MINIMUM, not padding that is added whatever the text
            already measures.

            `[@media(pointer:coarse)]:py-[10px]` was 20px of padding round the club name to
            bring it to a 44px target, and at a 16px root that is exactly what it does. At a
            32px root the name's own line box is 48px, so the padding bought nothing a
            fingertip needed and cost a 68px line in a header that was already the finding.
            Measured on /my-code at 320×568 with a 32px root: the club name's row went 68px →
            48px, the header 234 → 214, and the page's share of the phone 59% → 63%.

            `min-h` says what was actually meant — never smaller than a fingertip — and adds
            nothing once the text is bigger than one. Same rule as the tab strip and the gear
            beside it; this was the one item in the row still expressing it as padding.
          */}
          <NavLink to="/" className="inline-flex items-center font-semibold tracking-tight whitespace-nowrap min-w-0 truncate [@media(pointer:coarse)]:min-h-[44px]">Crusaders Squash</NavLink>
          {auth.status === "authenticated" && (
            // `lg`, not `md`. The inline nav switched on at 768 and the row it sits in needs
            // 800: an admin had five tabs, and at 768 the header measured a 795px scrollWidth
            // against a 768px viewport on all ten routes — 27px of whole-page sideways scroll
            // with the gear button (`Open menu`, and the only route to Sign out) running from
            // 751 to 795 and therefore sliced by the right edge. A member, with three tabs,
            // was clean at every width, which is why it survived so long.
            //
            // Between 768 and 1023 the scrolling tab strip below takes over instead. It is
            // the same nav, it announces its own overflow, and it is what a phone already
            // gets — a strip that scrolls beats a gear you cannot press.
            //
            // A20 — there are SIX admin tabs now, Doors among them, and the breakpoint did
            // not move. Re-measured in Chromium against this build rather than reasoned
            // about, because the five-tab number above is exactly the measurement somebody
            // would otherwise have argued from. At 1024, with all six tabs rendered and a
            // door needing attention (so the Doors badge is showing too): the nav measures
            // 511–537px, the whole row uses 813–892px of the 992px its content box has, the
            // header's scrollWidth is 1024 against a 1024px clientWidth, and the six tabs
            // share one line. 100px of slack at the worst of several runs — the spread is
            // the web font arriving or not before the measurement, which is why the number
            // quoted is the widest seen rather than the prettiest. The measurement is pinned
            // — and printed — by `e2e/narrow-viewport.spec.ts`, so a seventh tab has to
            // argue with a number rather than with this paragraph.
            //
            // Below `lg` the sixth tab costs nothing at all: the strip is a scroll container
            // by design and announces its own overflow, and the 360px volunteer admin who
            // could not find Doors is precisely who it is there for.
            <nav className="hidden lg:flex flex-wrap items-center gap-1 text-sm min-w-0">
              <SectionTabs
                isAdmin={auth.isAdmin}
                pendingApplications={pendingApplications}
                doorsNeedingAttention={doorsNeedingAttention}
              />
            </nav>
          )}
          {/*
            `min-w-0`, where this used to say `shrink-0`.

            The 795 px lesson in the nav comment above was this cluster being squeezed by the
            nav until the gear ran past the right edge, and `shrink-0` was the fix for it.
            With `flex-wrap` on the row that job is done better by the row itself: a cluster
            that cannot fit beside the nav now moves to a line of its own at full width
            rather than being compressed on a line it does not fit.

            And `shrink-0` had become the thing CAUSING the overflow at the extreme. It sizes
            this box to its max-content width and never gives it a narrower one, so the
            `flex-wrap` on it could never fire: measured in Chromium at a 180 px CSS viewport
            (a 360 px phone at 200 % zoom, which is exactly reviewer A's setup) the cluster
            stayed one 167 px line inside a 148 px content box. `min-w-0` lets it take the
            width it is given and wrap the gear onto a second line, which is the whole point:
            the club name may truncate and the wallet chip may wrap, the gear may not vanish.
          */}
          <div className="ml-auto flex flex-wrap justify-end items-center gap-[8px] min-w-0">
            {auth.status === "authenticated" && (
              <NavLink
                to="/wallet"
                className={({ isActive }) => cn(
                  // C16 — 36 px is not a touch target. `h-11` (44 px) on a coarse pointer
                  // only: the constraint is a fingertip, and a 44 px chip in a desktop
                  // header is a chip that has stopped being a chip.
                  //
                  // B12 — the cap and the truncation both GO, and the box is sized in
                  // pixels like everything else in this row.
                  //
                  // `max-w-[35vw]` with `truncate` on the figure was the D6 fix, and at a
                  // 32 px root font size reviewer B measured what it actually produced: a
                  // balance of 0 rendered as "0…". A wallet chip that abbreviates the one
                  // number it exists to show has stopped being a wallet chip — and the
                  // reason it needed a cap was that its own height and padding were rem,
                  // so it grew with the text and squeezed the gear off the row. With the
                  // box in pixels the chip is about as wide as its digits, and `shrink-0`
                  // lets the cluster WRAP it onto a line of its own rather than compress
                  // it. The whole number, always, on one line, whatever the text size.
                  "inline-flex shrink-0 items-center gap-[6px] min-h-[36px] [@media(pointer:coarse)]:min-h-[44px] px-[12px] rounded-lg text-sm font-medium tabular-nums whitespace-nowrap transition-colors max-w-[calc(100vw-32px)]",
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
                <WalletIcon size={14} strokeWidth={2.25} className="shrink-0" />
                {/* aria-hidden: the label above already says the number, and the visible text
                    abbreviates it to "cr", which is not a word. No `truncate`: B12 — it cut
                    a balance of 0 down to "0…", which is the one thing this chip must never
                    do. The cluster wraps instead. */}
                <span aria-hidden="true">{balance === null ? "— cr" : formatCredits(balance)}</span>
              </NavLink>
            )}
            {auth.status === "authenticated" && (
              <NavLink
                to="/profile"
                aria-label="Edit profile"
                title={profile?.full_name ?? profile?.email ?? "Profile"}
                className={({ isActive }) => cn(
                  // C16 / D6 — 36 px on a mouse, 44 px on a fingertip, and PIXELS rather
                  // than the rem scale, because this was an inline `style={{width: 36}}`
                  // and everything around it grew to 2× at a 32 px root font size while it
                  // did not. Both halves of that are wrong: the target was too small to hit
                  // and the cluster around it was too wide to fit.
                  "shrink-0 rounded-full overflow-hidden border-2 transition-all w-[36px] h-[36px] [@media(pointer:coarse)]:w-[44px] [@media(pointer:coarse)]:h-[44px]",
                  isActive ? "border-accent-strong" : "border-border hover:border-accent-strong/60",
                )}
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
              <SettingsMenu
                isAdmin={auth.isAdmin}
                doorsNeedingAttention={doorsNeedingAttention}
                onSignOut={() => { auth.logout(); nav("/login"); }}
              />
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
            {/* C19 — the region is no longer a tab stop. Every tab inside it is a link, and
                since C16 every link scrolls itself into view on focus, so the container's
                own stop reached nothing the next Tab would not have. It was the second stop
                on every route on a phone, it announced itself as a region, and it went
                nowhere. The fade and the overflow announcement stay; only the stop goes. */}
            <ScrollArea label="Section tabs" tabbable={false}>
              <div className="flex items-center gap-[4px] px-2 py-[4px] text-sm w-max">
                <SectionTabs
                  isAdmin={auth.isAdmin}
                  pendingApplications={pendingApplications}
                  doorsNeedingAttention={doorsNeedingAttention}
                />
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
      {/* B11 — `id` and `tabIndex={-1}` are the skip link's other half. A fragment target
          that is not focusable moves the SCROLL POSITION and leaves focus at the top of the
          document, so the next Tab lands back on the club name and the skip link has
          achieved nothing. */}
      <main id="main-content" tabIndex={-1} className="flex-1 min-h-0 flex flex-col overflow-auto"><div className={cn(
        "w-full mx-auto px-4 py-6 flex-1 min-h-0 flex flex-col",
        location.pathname.startsWith("/admin/") ? "max-w-7xl" : "max-w-5xl",
      )}>
        {/*
          doors: admin — the club-wide shut banner (A1.5 / D5), on every route an ADMIN is
          on, not on every route whose path begins `/admin/`.

          C8: those are not the same set, and the difference is the landing screen. An admin
          signs in and arrives at `/schedule`, which is a member route by path; so are
          `/reports`, `/wallet` and `/my-code`. A club that shut every door after an incident
          could sign in the next morning, look at the bookings for the day and be told
          nothing at all. Shut-all has no timed auto-reopen, so the banner is the only thing
          that puts the state back in front of somebody.

          `print:hidden` is B14 — the door card is printed and put in a cupboard beside the
          board, and a sheet of paper carrying "the doors are shut" plus a button is a sheet
          that will still say it in March. If the rule belongs on the banner itself, move it
          there and drop this wrapper; hiding it twice is harmless either way.
        */}
        {auth.status === "authenticated" && auth.isAdmin && (
          <div className="print:hidden">
            <ShutDoorsBanner chrome={doors} />
          </div>
        )}
        <Outlet />
      </div></main>
    </div>
  );
}

/** The count of waiting applications, as a sentence. Two call sites, one wording. */
function pendingApplicationsLabel(count: number): string {
  return `${count} membership ${count === 1 ? "application" : "applications"} awaiting review`;
}

/**
 * doors: admin — the attention count, as a sentence.
 *
 * Three call sites now say it: the gear's accessible name, the Doors menu item's badge and
 * the Doors tab's badge. It was written out twice before and the third copy is what turned
 * a wording into a function.
 */
function doorsAttentionLabel(count: number): string {
  return `${count} ${count === 1 ? "door needs" : "doors need"} attention`;
}

/**
 * The section tabs, rendered twice — inline at `lg`, in the scrolling strip below it.
 *
 * <p>
 * One list, not two. The two copies were written out separately and are asserted in pairs by
 * `Layout.test.tsx` precisely because a divergence between them is invisible at any single
 * width: whichever copy you are looking at is the one that looks right.
 * </p>
 */
function SectionTabs({ isAdmin, pendingApplications, doorsNeedingAttention }: {
  isAdmin: boolean;
  pendingApplications: number;
  doorsNeedingAttention: number;
}) {
  return (
    <>
      <NavTab to="/schedule" label="Bookings" />
      <NavTab to="/my-code" label="My code" />
      {isAdmin && <NavTab to="/admin/ledger" label="Transactions" />}
      {isAdmin && (
        <NavTab
          to="/admin/members"
          label="Members"
          badge={{ count: pendingApplications, label: pendingApplicationsLabel(pendingApplications) }}
        />
      )}
      {/* A20 — Doors is a named destination rather than a 6 px dot on a cog.
          See the measurement note on the `lg` nav in `Layout`. */}
      {isAdmin && (
        <NavTab
          to="/admin/doors"
          label="Doors"
          badge={{ count: doorsNeedingAttention, label: doorsAttentionLabel(doorsNeedingAttention) }}
        />
      )}
      <NavTab to="/reports" label="Reports" />
    </>
  );
}

function NavTab({ to, label, badge }: {
  to: string;
  label: string;
  /**
   * The count and its sentence travel together, because they are one thing: the digits are
   * decoration and the sentence is the accessible name. A zero renders nothing.
   */
  badge?: { count: number; label: string };
}) {
  return (
    <NavLink
      to={to}
      /*
        C16 / E-L4 — a focused tab brings ITSELF into view.

        At 400 % zoom reviewer C tabbed to "Members" and it was clipped by the right edge of
        the viewport: the strip scrolls, the focus ring was inside it, and nothing told the
        strip to move. At 390 px reviewer E found "Doors" off-screen for the same reason.
        `inline: "nearest"` is the whole fix and it is deliberately "nearest" rather than
        "center": a tab that is already fully visible must not make the strip jump, which is
        what "center" does to every tab in the middle of the list.

        `block: "nearest"` with it, because this strip lives inside the page and a
        `scrollIntoView` with no block argument would scroll the DOCUMENT to it as well — a
        header that scrolls itself up to meet a focus ring is a worse bug than the one below.
      */
      onFocus={(e) => e.currentTarget.scrollIntoView?.({ inline: "nearest", block: "nearest" })}
      // B12 / C16 — 36 px is not a touch target and `h-11` is not 44 px at every root font
      // size. A minimum in PIXELS on a coarse pointer: the text still grows, the box stops
      // at the size a fingertip needs instead of doubling with it. (A `h-11` strip measured
      // 96 px tall at a 32 px root, which is most of why the chrome ate 54 % of the phone.)
      className={({ isActive }) =>
        `px-3 min-h-[36px] [@media(pointer:coarse)]:min-h-[44px] inline-flex items-center gap-1.5 rounded-lg whitespace-nowrap ${isActive ? "bg-accent-soft text-accent-strong font-medium" : "text-text-secondary hover:bg-bg-muted"}`}
    >
      {label}
      {badge && badge.count > 0 && (
        // The number alone means nothing to a screen reader beside the word "Members", so the
        // count carries the sentence and the digits are decoration.
        <span
          className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-info-soft text-info-strong text-xs font-semibold tabular-nums"
          aria-label={badge.label}
          title={badge.label}
        >
          {badge.count}
        </span>
      )}
    </NavLink>
  );
}

/** Where the next roving focus goes, or null when this key is not the menu's business. */
function nextMenuItem(key: string, from: number, count: number): number | null {
  if (key === "ArrowDown") return (from + 1) % count;
  if (key === "ArrowUp") return (from - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/**
 * The settings menu — a real WAI-ARIA menu button, and real links inside it.
 *
 * <p>
 * B15. It declared <code>role="menu"</code> and had none of the behaviour that goes with
 * one. Three separate failures, and the third is the one a mouse user hits too:
 * </p>
 *
 * <ul>
 * <li><b>Focus never moved into it.</b> Opening the menu from the keyboard left focus on the
 * gear, so the first Tab went to the first item and the second left the menu — and the menu
 * stayed open behind you, over the page, with nothing focused inside it.</li>
 * <li><b>Tab out did not close it.</b> Escape did (and still does, returning focus to the
 * gear), but Tab is the key a keyboard user actually presses. Closing on focusout is what
 * handles Shift+Tab as well, and it does it AFTER the browser has moved focus, so nothing
 * is dropped at the top of the document.</li>
 * <li><b>The items were buttons.</b> Four of the five are navigations, and a button that
 * navigates cannot be middle-clicked, cmd-clicked or copied — an admin who wants Doors in a
 * second tab while keeping the page they are on simply cannot have it. They are
 * <code>Link</code>s now; Sign out stays a button, because it is not a destination.</li>
 * </ul>
 *
 * <p>
 * Having picked the menu pattern rather than dropping <code>role="menu"</code>, the keyboard
 * contract is implemented in full: ArrowDown / ArrowUp wrap, Home / End jump, Escape closes
 * and restores focus. A half-implemented <code>role="menu"</code> is worse than no role at
 * all, because a screen-reader user is told to expect arrow keys that do nothing.
 * </p>
 */
function SettingsMenu({ isAdmin, doorsNeedingAttention, onSignOut }: {
  isAdmin: boolean;
  doorsNeedingAttention: number;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Focus into the menu on open. Queried from the DOM rather than plumbed through refs:
  // the items are conditional on `isAdmin`, so a ref array would have to be rebuilt on
  // every render anyway and would disagree with the rendered order the moment one moves.
  useEffect(() => {
    if (!open) return;
    containerRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  // Escape, and a click anywhere outside. Escape puts focus back on the gear — closing the
  // menu while focus sits on a node that is about to be unmounted drops the keyboard user
  // at the top of the document, several tab stops from where they were.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function onMenuKeyDown(e: React.KeyboardEvent) {
    const items = Array.from(containerRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    const to = nextMenuItem(e.key, items.indexOf(document.activeElement as HTMLElement), items.length);
    if (to === null) return;
    e.preventDefault();
    items[to].focus();
  }

  return (
    <div
      className="relative"
      ref={containerRef}
      /*
        Tab-out, Shift+Tab-out, and focus leaving for any other reason.
        <p>
        A `relatedTarget` is REQUIRED rather than merely checked: `.focus()` moves focus
        within the menu too, and an implementation that closed on a null relatedTarget would
        close itself the moment the open effect above focused the first item. The cost is
        that Tab from the last item into the browser's own chrome — which reports no
        relatedTarget at all — leaves the menu open; the mousedown listener and Escape still
        close it, and that is the whole of what this does not cover.
        </p>
      */
      onBlur={(e) => {
        const to = e.relatedTarget as Node | null;
        if (to && !containerRef.current?.contains(to)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        /* doors: admin — the count goes in the NAME, because a number inside a 44 px
           circular icon button is unreadable at 360 and a dot is not, and because
           colour alone is never the signal. */
        aria-label={doorsNeedingAttention === 0
          ? "Open menu"
          : `Open menu — ${doorsAttentionLabel(doorsNeedingAttention)}`}
        aria-haspopup="menu"
        aria-expanded={open}
        // 44 px in PIXELS, not `w-11`/`h-11`. The rem form doubled to 88 px at a 32 px root
        // font size and was a third of the reason the header cluster overflowed a 360 px
        // screen (D6) — and this is the one control in the header that must never be the
        // thing pushed off the edge, because it is the only route to Doors and to Sign out.
        className="relative inline-flex items-center justify-center w-[44px] h-[44px] rounded-full text-text-secondary hover:text-text-primary hover:bg-bg-muted"
      >
        <SettingsIcon size={26} strokeWidth={1.75} />
        {doorsNeedingAttention > 0 && (
          // B12 — pixels, and in the corner rather than on the glyph.
          //
          // `right-1.5 top-1.5 h-1.5 w-1.5` is 6 px at a 16 px root and 12 px at a 32 px
          // one, inside a button that is 44 px either way: at the larger size the dot
          // landed at x 20–32, y 12–24, straight across the cog's own 26 px glyph, and
          // read as part of the icon rather than as a flag on it. Fixed at 8 px in the
          // corner it clears the glyph's box at every text size.
          <span aria-hidden="true" className="absolute right-[1px] top-[1px] h-[8px] w-[8px] rounded-full bg-danger-strong" />
        )}
      </button>
      {open && (
        <div
          role="menu"
          onKeyDown={onMenuKeyDown}
          // `max-w-[calc(100vw-16px)]`: `w-56` is 14 rem, which is 448 px at a 32 px root
          // font size — wider than the phone it is anchored to the right edge of.
          className="absolute right-0 mt-2 w-56 max-w-[calc(100vw-16px)] rounded-lg border border-border bg-bg-surface shadow-lg z-40 overflow-hidden"
        >
          {isAdmin && (
            <>
              {/* doors: admin — first, above Devices. Ordered by urgency of use rather than
                  alphabetically: Doors is opened standing in a club with a member waiting,
                  Webhooks twice a year. `DoorClosed`, not `DoorOpen` — an open door is a
                  state claim this product cannot make, two lines above the page whose whole
                  discipline is not making it. */}
              <MenuLink
                to="/admin/doors"
                onNavigate={() => setOpen(false)}
                icon={<DoorClosed size={16} />}
                label="Doors"
                badge={{ count: doorsNeedingAttention, label: doorsAttentionLabel(doorsNeedingAttention) }}
              />
              <MenuLink to="/admin/devices" onNavigate={() => setOpen(false)} icon={<Cpu size={16} />} label="Devices" />
              <MenuLink to="/admin/settings" onNavigate={() => setOpen(false)} icon={<SettingsIcon size={16} />} label="Admin settings" />
              <MenuLink to="/admin/webhooks" onNavigate={() => setOpen(false)} icon={<WebhookIcon size={16} />} label="Webhooks" />
              <div className="border-t border-border" />
            </>
          )}
          {/* A button, not a link: signing out is not a destination, and a `Link` to
              `/login` would be openable in a new tab without ending the session. */}
          <MenuAction
            onClick={() => { setOpen(false); onSignOut(); }}
            icon={<LogOut size={16} />}
            label="Sign out"
            tone="danger"
          />
        </div>
      )}
    </div>
  );
}

const MENU_ITEM_CLASS = "w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-left transition min-h-11";

/** The badge shared by both kinds of menu item — a zero renders nothing. */
function MenuBadge({ badge }: { badge?: { count: number; label: string } }) {
  if (!badge || badge.count === 0) return null;
  // The digits are decoration; the sentence is the name. Same rule as NavTab's badge —
  // "2" beside the word "Doors" means nothing to a screen reader.
  return (
    <span
      className="ml-auto inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-info-soft text-info-strong text-xs font-semibold tabular-nums"
      aria-label={badge.label}
      title={badge.label}
    >
      {badge.count}
    </span>
  );
}

/** A navigating menu item: a real anchor, so middle-click and cmd-click work (B15). */
function MenuLink({ to, onNavigate, icon, label, badge }: {
  to: string;
  onNavigate: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: { count: number; label: string };
}) {
  return (
    <Link
      to={to}
      role="menuitem"
      onClick={onNavigate}
      className={cn(MENU_ITEM_CLASS, "text-text-primary hover:bg-bg-muted")}
    >
      <span className="text-text-muted">{icon}</span>
      <span>{label}</span>
      <MenuBadge badge={badge} />
    </Link>
  );
}

/** A menu item that DOES something rather than going somewhere. */
function MenuAction({ onClick, icon, label, tone = "default" }: {
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
        MENU_ITEM_CLASS,
        tone === "danger" ? "text-danger-strong hover:bg-danger-soft/50" : "text-text-primary hover:bg-bg-muted",
      )}
    >
      <span className="text-text-muted">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

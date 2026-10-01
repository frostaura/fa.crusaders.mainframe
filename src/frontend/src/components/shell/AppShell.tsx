import { useEffect, useRef } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { tokenStore } from "@/lib/api";
import { useAdminAttention } from "@/lib/adminAttention";
import { useAuth } from "@/lib/auth";
import { useDataOwner } from "@/lib/offline/useCachedRead";
import { cn } from "@/lib/utils";
import { CelebrationOverlay } from "../play/CelebrationOverlay";
import { ShutDoorsBanner } from "../doors/ShutDoorsBanner";
import { useDoorsChrome } from "../doors/useDoorsChrome";
import { AccountMenu } from "./AccountMenu";
import { CreditsChip } from "./CreditsChip";
import { CrestLink } from "./Crest";
import { LANDING_PATH } from "./nav";
import { NotificationBell } from "./NotificationBell";
import { PageErrorBoundary } from "./PageErrorBoundary";
import { PrimaryNav } from "./PrimaryNav";
import { SkipLink } from "./SkipLink";

/**
 * The application shell (P2, Target IA → Shell).
 *
 * <ul>
 *   <li><b>Desktop (`md`+):</b> one 56px top bar — crest · My Code · Bookings · Wallet · Admin
 *   (admins, with its attention badge) · notification bell · credits chip · avatar menu.</li>
 *   <li><b>Phone:</b> a slim top bar (crest, bell, credits chip, avatar) and a fixed, safe-area-aware
 *   bottom tab bar. Both are the same `PrimaryNav`.</li>
 * </ul>
 *
 * <p>
 * Three branches, each a different kind of screen: the signed-out public landing (no chrome, the
 * document scrolls), the auth-flow screens (no chrome — a forced password change can reach
 * nothing else, so a nav bar would be a row of links to 403s), and the app itself.
 * </p>
 *
 * <h3>The page frame</h3>
 * <p>
 * A page built on `PageShell` owns its width, gutters and top padding; so does any direct child
 * marked <code>data-full-bleed</code>, and the admin section's `AdminLayout`
 * (<code>data-admin-layout</code>), which lays out its own rail and frames its own pages. Every
 * other page — the ones P3 has not rebuilt yet — gets the frame PageShell would give it:
 * `content` (64rem) for member screens, `wide` (80rem) under `/admin`, gutters 16 / 24 / 32px
 * and a 24 / 32px top. The frame stands down for self-framed children by `:has()`, so no page
 * is ever double-guttered and no page is left flush against the glass.
 * </p>
 */

const ADMIN_PATH = /^\/admin(\/|$)/;

const HEADERLESS = /^\/(login|register|verify-email|welcome|forgot-password|reset-password|change-password)(\/|$)/;

/** Stands the legacy frame down for a child that frames itself. */
const SELF_FRAMED = [
  "has-[>[data-page-shell]]:max-w-none has-[>[data-page-shell]]:p-0",
  "has-[>[data-full-bleed]]:max-w-none has-[>[data-full-bleed]]:p-0",
  "has-[>[data-admin-layout]]:max-w-none has-[>[data-admin-layout]]:p-0",
].join(" ");

/**
 * `grow shrink-0`, never `flex-1 min-h-0`: a frame allowed to shrink is squeezed to the scroller's
 * height and its page overflows it, and overflow from a squeezed child does not carry `<main>`'s
 * padding-bottom — so on a phone the last 65px of every long page (the bookings grid's last rows
 * included) sat under the tab bar at the end of the scroll (measured at the P3/P4 integration).
 * It still grows, so a short page fills the height.
 */
const FRAME = "mx-auto flex w-full grow shrink-0 flex-col px-4 pb-10 pt-6 sm:px-6 lg:px-8 lg:pt-8 3xl:px-12";

/**
 * The app bar's inner box follows the PAGE's frame (R4 form factor, SPEC 2.1), so the crest and
 * the content share one edge instead of reading as two grids.
 *
 * <ul>
 *   <li>Member pages: `wide` (80rem), widening to the `full` frame (120rem) from 3xl when the page
 *   is a `full` PageShell — read by `:has()` from the shell root, so no page has to tell the shell
 *   anything and the first paint is right.</li>
 *   <li>`/admin` from xl, where the rail stands: full-bleed. The crest sits in a box as wide as the
 *   rail (16rem), over it, and the nav starts at the content's edge (16rem + the frame's 2rem
 *   gutter) — at 1920 the bar was centred at 80rem with its crest at x≈320 while the rail sat flush
 *   at x=0.</li>
 * </ul>
 */
const HEADER_FRAME = [
  "mx-auto flex min-h-appbar w-full max-w-wide flex-wrap items-center justify-end gap-x-3 gap-y-1 px-4 py-1 sm:px-6 lg:gap-x-6 lg:px-8",
  "3xl:px-12 3xl:group-has-[[data-page-frame=full]]/shell:max-w-page",
].join(" ");
const HEADER_OVER_RAIL = "xl:max-w-none xl:gap-x-8 xl:pl-0";
/** The rail is `w-64` and its items start 24px in (px-3 + px-3). */
const CREST_OVER_RAIL = "xl:w-64 xl:pl-6";

/** The frame the bar follows: the admin console's (over the rail) or a member page's. */
function chromeFrame(admin: boolean) {
  return admin
    ? { name: "admin", header: cn(HEADER_FRAME, HEADER_OVER_RAIL), crest: cn("flex shrink-0", CREST_OVER_RAIL) }
    : { name: "member", header: HEADER_FRAME, crest: "flex shrink-0" };
}

export default function AppShell() {
  const auth = useAuth();
  const location = useLocation();
  const signedIn = auth.status === "authenticated";
  const isAdmin = signedIn && auth.isAdmin;
  // R4 wave B (P4-4) — the tab bar stays for the member this phone confirmed while the club is
  // out of reach or not yet asked: My Code offline had no way to Bookings or Wallet.
  const offlineMember = useDataOwner().who !== null;
  const memberChrome = signedIn || offlineMember;
  // One read each, shared with the admin rail and the Overview (both stores dedupe their requests).
  const attention = useAdminAttention({ enabled: isAdmin });
  const doors = useDoorsChrome(isAdmin, location.pathname);
  const headerRef = useRef<HTMLElement>(null);

  const headerless = HEADERLESS.test(location.pathname);
  /**
   * The signed-out root is the club's public page, not a screen of the app. A stored token
   * settles the initial probe without waiting (a synchronous localStorage read), so neither a
   * returning member nor a first-time visitor sees the other's chrome flash — and "/" sends a
   * returning member on to My Code anyway (R15).
   */
  const probablySignedIn = auth.status === "loading" && Boolean(tokenStore.get());
  const publicLanding = location.pathname === "/" && !signedIn && !probablySignedIn;

  usePublishChromeHeight(headerRef, `${publicLanding}|${headerless}|${auth.status}`);

  if (publicLanding) {
    // No chrome, no width cap and no inner scroll container: the page lays itself out and the
    // DOCUMENT scrolls, so a phone's URL bar collapses and scroll-to-anchor works. It keeps the
    // skip link (C-L4): the longest page in the product is the first one anybody sees.
    return (
      <>
        <SkipLink />
        <main id="main-content" tabIndex={-1} className="min-h-full">
          <Outlet />
        </main>
      </>
    );
  }

  if (headerless) {
    return (
      <div className="flex h-full flex-col">
        <main className="relative flex min-h-0 flex-1 flex-col overflow-auto">
          <div className={cn(FRAME, "max-w-content", SELF_FRAMED)}>
            <PageErrorBoundary resetKey={location.pathname}><Outlet /></PageErrorBoundary>
          </div>
        </main>
      </div>
    );
  }

  const wide = ADMIN_PATH.test(location.pathname);
  const frame = chromeFrame(wide);
  return (
    <div data-frame={frame.name} className="group/shell flex h-full flex-col">
      <SkipLink />
      <header
        ref={headerRef}
        data-app-header=""
        className="sticky top-0 z-chrome border-b border-border bg-bg-surface print:hidden"
        style={{
          paddingTop: "env(safe-area-inset-top)",
          paddingLeft: "env(safe-area-inset-left)",
          paddingRight: "env(safe-area-inset-right)",
        }}
      >
        {/*
          `justify-end` and the bell's own `ml-auto` (P11): the bell is a ROW item, not one of the
          actions, so that when large text wraps the row it stays up beside the crest and the
          chip and avatar drop to the next line together, right-aligned — two lines, not three.
          On one line the bell's auto margin takes the free space and the actions follow it.
        */}
        <div className={frame.header}>
          <div data-app-crest="" className={frame.crest}>
            <CrestLink to={memberChrome ? LANDING_PATH : "/"} />
          </div>
          {memberChrome ? <PrimaryNav isAdmin={isAdmin} attention={attention} /> : null}
          {signedIn ? <NotificationBell className="ml-auto md:-mr-4" /> : null}
          <div data-app-header-actions="" className={cn("flex min-w-0 flex-wrap items-center justify-end gap-2", !signedIn && "ml-auto")}>
            {signedIn ? <><CreditsChip /><AccountMenu /></> : null}
            {auth.status === "anonymous" ? (
              <Button asChild variant="outline" size="sm"><Link to="/login">Sign in</Link></Button>
            ) : null}
          </div>
        </div>
      </header>
      {/*
        `relative` (F4-3): <main> is the scroller, so it must also be the containing block of
        everything absolutely placed inside it. Without it a visually hidden live region or a
        positioned badge far down a long page sat at its static position in the DOCUMENT, made
        the document taller than the screen, and a wheel or a focus scrolled the whole app —
        header and nav included — off-screen (admin /admin at 1280: scrollY 1588, all blank).
        `scroll-padding-bottom` (F4-4): the phone's tab bar is fixed over the foot of this
        scroller, so a control focused by Tab is scrolled clear of it, not under it.
      */}
      <main
        id="main-content"
        tabIndex={-1}
        className="relative flex min-h-0 flex-1 flex-col overflow-auto"
        style={{
          paddingBottom: "calc(var(--app-bottom-bar-height, 0px) + var(--context-bar-height, 0px))",
          scrollPaddingBottom: "calc(var(--app-bottom-bar-height, 0px) + var(--context-bar-height, 0px) + 0.5rem)",
        }}
      >
        {/*
          The club-wide shut banner on every route an ADMIN is on (C8) — not only on /admin paths,
          because an admin lands on My Code and a club that shut every door must be told so the
          next morning. Its own gutter, so it lines up whether or not the page frames itself;
          `empty:hidden` so the wrapper costs nothing on a normal day; `print:hidden` so the door
          card that goes in a cupboard does not carry "the doors are shut" until March (B14).
        */}
        {isAdmin ? (
          <div className="mx-auto w-full max-w-wide px-4 pt-4 empty:hidden print:hidden sm:px-6 lg:px-8 3xl:px-12">
            <ShutDoorsBanner chrome={doors} />
          </div>
        ) : null}
        <div data-shell-frame={wide ? "wide" : "content"} className={cn(FRAME, wide ? "max-w-wide" : "max-w-content", SELF_FRAMED)}>
          {/* A page that throws takes only itself down, and leaving it clears the failure. */}
          <PageErrorBoundary resetKey={location.pathname}><Outlet /></PageErrorBoundary>
        </div>
      </main>
      {/* P12 — a badge or a goal, once. It keeps its own rules: signed in only, and never over the pass (§9.3). */}
      <CelebrationOverlay />
    </div>
  );
}

/**
 * How tall the top bar actually is, published as `--app-chrome-height` for what must sit under
 * it — the toast strip from `sm`, the scroll margin a fragment target lands at, the booking
 * grid's height budget. Measured, not guessed (B13): it wraps at extreme zoom and grows with
 * the root font size. The phone's bottom bar is `position: fixed` and so is out of this box's
 * flow; it publishes its own height.
 */
function usePublishChromeHeight(ref: React.RefObject<HTMLElement | null>, key: string) {
  useEffect(() => {
    const root = document.documentElement;
    const header = ref.current;
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
  }, [ref, key]);
}

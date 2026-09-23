import { useEffect, useRef } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { tokenStore } from "@/lib/api";
import { useAdminAttention } from "@/lib/adminAttention";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { ShutDoorsBanner } from "../doors/ShutDoorsBanner";
import { useDoorsChrome } from "../doors/useDoorsChrome";
import { AccountMenu } from "./AccountMenu";
import { CreditsChip } from "./CreditsChip";
import { CrestLink } from "./Crest";
import { LANDING_PATH } from "./nav";
import { PageErrorBoundary } from "./PageErrorBoundary";
import { PrimaryNav } from "./PrimaryNav";
import { SkipLink } from "./SkipLink";

/**
 * The application shell (P2, Target IA → Shell).
 *
 * <ul>
 *   <li><b>Desktop (`md`+):</b> one 56px top bar — crest · My Code · Bookings · Wallet · Admin
 *   (admins, with its attention badge) · credits chip · avatar menu.</li>
 *   <li><b>Phone:</b> a slim top bar (crest, credits chip, avatar) and a fixed, safe-area-aware
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

const HEADERLESS = /^\/(login|register|verify-email|welcome|forgot-password|reset-password|change-password)(\/|$)/;

/** Stands the legacy frame down for a child that frames itself. */
const SELF_FRAMED = [
  "has-[>[data-page-shell]]:max-w-none has-[>[data-page-shell]]:p-0",
  "has-[>[data-full-bleed]]:max-w-none has-[>[data-full-bleed]]:p-0",
  "has-[>[data-admin-layout]]:max-w-none has-[>[data-admin-layout]]:p-0",
].join(" ");

const FRAME = "mx-auto flex w-full min-h-0 flex-1 flex-col px-4 pb-10 pt-6 sm:px-6 lg:px-8 lg:pt-8";

export default function AppShell() {
  const auth = useAuth();
  const location = useLocation();
  const signedIn = auth.status === "authenticated";
  const isAdmin = signedIn && auth.isAdmin;
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
        <main className="flex min-h-0 flex-1 flex-col overflow-auto">
          <div className={cn(FRAME, "max-w-content", SELF_FRAMED)}>
            <PageErrorBoundary resetKey={location.pathname}><Outlet /></PageErrorBoundary>
          </div>
        </main>
      </div>
    );
  }

  const wide = location.pathname === "/admin" || location.pathname.startsWith("/admin/");
  return (
    <div className="flex h-full flex-col">
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
        <div className="mx-auto flex min-h-appbar w-full max-w-wide flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1 sm:px-6 md:gap-x-6 lg:px-8">
          <CrestLink to={signedIn ? LANDING_PATH : "/"} />
          {signedIn ? <PrimaryNav isAdmin={isAdmin} attention={attention} /> : null}
          <div data-app-header-actions="" className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
            {signedIn ? <CreditsChip /> : null}
            {signedIn ? <AccountMenu /> : null}
            {auth.status === "anonymous" ? (
              <Button asChild variant="outline" size="sm"><Link to="/login">Sign in</Link></Button>
            ) : null}
          </div>
        </div>
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        className="flex min-h-0 flex-1 flex-col overflow-auto"
        style={{ paddingBottom: "var(--app-bottom-bar-height, 0px)" }}
      >
        {/*
          The club-wide shut banner on every route an ADMIN is on (C8) — not only on /admin paths,
          because an admin lands on My Code and a club that shut every door must be told so the
          next morning. Its own gutter, so it lines up whether or not the page frames itself;
          `empty:hidden` so the wrapper costs nothing on a normal day; `print:hidden` so the door
          card that goes in a cupboard does not carry "the doors are shut" until March (B14).
        */}
        {isAdmin ? (
          <div className="mx-auto w-full max-w-wide px-4 pt-4 empty:hidden print:hidden sm:px-6 lg:px-8">
            <ShutDoorsBanner chrome={doors} />
          </div>
        ) : null}
        <div data-shell-frame={wide ? "wide" : "content"} className={cn(FRAME, wide ? "max-w-wide" : "max-w-content", SELF_FRAMED)}>
          {/* A page that throws takes only itself down, and leaving it clears the failure. */}
          <PageErrorBoundary resetKey={location.pathname}><Outlet /></PageErrorBoundary>
        </div>
      </main>
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

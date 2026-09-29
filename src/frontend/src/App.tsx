import { Suspense, lazy, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { AuthProvider, readLastIdentity, useAuth } from "./lib/auth";
import Layout from "./components/Layout";
import { ToastProvider } from "./components/Toast";
import { BalanceProvider } from "./lib/balance";
import { ProfileProvider } from "./lib/profile";
import { ClubUiProvider } from "./lib/ClubUiProvider";
import HomePage from "./pages/Home";
import LoginPage from "./pages/Login";
import RegisterPage from "./pages/Register";
import VerifyEmailPage from "./pages/VerifyEmail";
import ForgotPasswordPage from "./pages/ForgotPassword";
import ResetPasswordPage from "./pages/ResetPassword";
import ChangePasswordPage from "./pages/ChangePassword";
import WelcomePage from "./pages/Welcome";
import WalletPage from "./pages/Wallet";
import SchedulePage from "./pages/Schedule";
import AdminMembersPage from "./pages/AdminMembers";
import TopUpPage from "./pages/TopUp";
import TopUpStatusPage from "./pages/TopUpStatus";
import AdminWebhooksPage from "./pages/AdminWebhooks";
import AdminSettingsPage from "./pages/AdminSettings";
import AdminLedgerPage from "./pages/AdminLedger";
import ProfilePage from "./pages/Profile";
import ProfileResultsPage from "./pages/ProfileResults";
import MyCodePage from "./pages/MyCode";
import HowItWorksPage from "./pages/HowItWorks";
// P8 — the member welcome wizard, and the gate that offers it once to a newly approved member.
import GetStartedPage from "./pages/GetStarted";
import { FirstRunGate } from "./components/onboarding/FirstRunGate";
import { AdminDevicesPage } from "./pages/AdminDevices";
// doors: admin — the four doors routes and their pages, in one block.
import { AdminDoorsPage } from "./pages/AdminDoors";
import { AdminDoorsDetailPage } from "./pages/AdminDoorsDetail";
import { AdminDoorsLogPage } from "./pages/AdminDoorsLog";
import { AdminDoorsCardPage } from "./pages/AdminDoorsCard";
// Monitoring — courts, hardware and control (R17): the control board, doors, boards, faults and
// the change record. A person's night lives on the member now (P5); its old route asks who.
import { ControlBoardPage } from "./pages/monitoring/ControlBoard";
import { MonitoringFaultsPage } from "./pages/monitoring/MonitoringFaults";
import { MemberNightPage } from "./pages/monitoring/MemberNight";
import { AdminChangeRecordPage } from "./pages/monitoring/AdminChangeRecord";
import { AdminSchedulesPage } from "./pages/AdminSchedules";
import { AdminScheduleDetailPage } from "./pages/AdminScheduleDetail";
import { AdminGroupsPage } from "./pages/AdminGroups";
// P5 — a member's own page and its six tabs (Target IA → Member detail). Each tab is a URL.
import MemberDetailLayout, {
  MemberAccess, MemberBookings, MemberDoors, MemberNightTab, MemberOverview, MemberWallet,
} from "./pages/admin/member";
// P6 — the courts left Settings for a page of their own.
import AdminCourtsPage from "./pages/admin/AdminCourts";
import NotFoundPage from "./pages/NotFound";
// P11 — players and splits (D11–D13): a booking's own page, invites (the tab, a shared link, and
// the invite email's deep link) and the member's inbox.
import BookingDetailPage from "./pages/BookingDetail";
import InvitesPage from "./pages/Invites";
import InviteLinkPage from "./pages/InviteLink";
import InviteDeepLinkPage from "./pages/InviteDeepLink";
import InboxPage from "./pages/Inbox";
// `/reports` split in two (Target IA → Routes): club reports under Admin, a member's own under Wallet.
import { ReportsRedirect } from "./pages/Reports";
import AdminLayout from "./components/admin/AdminLayout";
import AdminHomePage from "./pages/admin/AdminHome";
import AdminResultsPage from "./pages/admin/AdminResults";
import { RouteAnnouncer } from "./components/RouteAnnouncer";
import { LANDING_PATH } from "./components/shell/nav";
import { BootSplash, ConnectionLost, RouteSkeleton } from "./components/shell/SessionScreens";

/**
 * The primitives preview — development only, and dropped from the production bundle.
 *
 * <p>
 * `import.meta.env.DEV` is replaced with a literal at build time, so the ternary folds to
 * `null`, the route below disappears, and the dynamic import is never reachable. It exists
 * because `SegmentedTabs` and the feedback theme have geometry that only a layout engine can
 * answer — a measured thumb, a control that flips to a vertical tablist when the labels stop
 * fitting, a 44 px target at a 32 px root font — and jsdom reports every offset as 0. The
 * Playwright suite runs `npm run dev`, which is where the route exists.
 * </p>
 */
const DevPrimitivesPage = import.meta.env.DEV ? lazy(() => import("./pages/DevPrimitives")) : null;

/**
 * The two report screens carry the chart library, so they load when first opened: a member who
 * never looks at their activity never downloads Recharts, and neither does an admin who never
 * opens the club's reports.
 *
 * <p>
 * <b>The admin console's frame and Overview are NOT lazy, deliberately.</b> Both read the
 * club's doors through the shared doors store, which dedupes only while a read is in flight — a
 * reader that mounts after a Suspense boundary resolves joins late and fires a second identical
 * GET (E-L6: "one read on arrival, not one per reader"; `e2e/admin-doors.spec.ts` counts it).
 * </p>
 */
const AdminReportsPage = lazy(() => import("./pages/admin/AdminReports"));
const WalletActivityPage = lazy(() => import("./pages/WalletActivity"));

/** A lazily loaded route: the page's own shape while its code arrives, never "Loading…". */
function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteSkeleton />}>{children}</Suspense>;
}

export default function App() {
  return (
    <BrowserRouter>
      {/*
        C6 — the three things a real page load does that a single-page app does not: name the
        document, move focus to where the new page begins, and say where you have arrived.
        Above `Routes` rather than inside the shell, because the shell returns early for the
        public landing and for every auth-flow screen, and those are routes too.
      */}
      <RouteAnnouncer />
      <AuthProvider>
        <ProfileProvider>
        {/* Inside ProfileProvider, because that is where the club's glyph choice arrives, and
            outside everything that draws one. */}
        <ClubUiProvider>
        <BalanceProvider>
        <ToastProvider>
          <FirstRunGate />
          <AppRoutes />
        </ToastProvider>
        </BalanceProvider>
        </ClubUiProvider>
        </ProfileProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

/**
 * The route map (P2, Target IA → Routes). Exported so `routes.test.tsx` can drive it inside a
 * `MemoryRouter` — `App` itself owns a `BrowserRouter`.
 *
 * <p>
 * <b>Every moved URL is a permanent redirect that keeps its query and hash</b>, never a deletion:
 * old paths are in emails, bookmarks, the installed app's shortcuts and on a door card printed and
 * screwed to a frame. A dead link in an email is how somebody ends up at a 404 while standing in
 * front of a door that will not open.
 * </p>
 *
 * <p>
 * <b>Admin routes nest under one guarded element</b> — `AdminLayout` renders the rail and an
 * `Outlet` — so the guard is stated once and the rail is on every admin screen. Child paths are
 * written absolute (react-router accepts an absolute child that begins with its parent's path) so
 * each line still reads as the URL it serves, and the route-title reconciliation can read them.
 * `/log` is declared before `/:id` in the doors block: the router ranks by specificity, but a
 * reader should not have to know that.
 * </p>
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/verify-email/:token" element={<VerifyEmailPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
        <Route path="/welcome/:token" element={<WelcomePage />} />

        {/* R15 — My Code is the landing, then Bookings, then Wallet. */}
        <Route path="/my-code" element={<RequireAuth><MyCodePage /></RequireAuth>} />
        <Route path="/bookings" element={<RequireAuth><SchedulePage /></RequireAuth>} />
        {/* P11. `/bookings/invites` is literal, so it outranks `/bookings/:bookingId`. */}
        <Route path="/bookings/invites" element={<RequireAuth><InvitesPage /></RequireAuth>} />
        <Route path="/bookings/:bookingId" element={<RequireAuth><BookingDetailPage /></RequireAuth>} />
        {/* A shared invite link (`/j/{token}`, WhatsApp) and the invite email's deep link. Both
            signed-in: RequireAuth carries the link through /login and back. */}
        <Route path="/j/:token" element={<RequireAuth><InviteLinkPage /></RequireAuth>} />
        <Route path="/invites/:participantId" element={<RequireAuth><InviteDeepLinkPage /></RequireAuth>} />
        <Route path="/inbox" element={<RequireAuth><InboxPage /></RequireAuth>} />
        <Route path="/wallet" element={<RequireAuth><WalletPage /></RequireAuth>} />
        <Route path="/wallet/topup" element={<RequireAuth><TopUpPage /></RequireAuth>} />
        <Route path="/wallet/topup/:topupId" element={<RequireAuth><TopUpStatusPage /></RequireAuth>} />
        <Route path="/wallet/activity" element={<RequireAuth><Lazy><WalletActivityPage /></Lazy></RequireAuth>} />
        <Route path="/profile" element={<RequireAuth><ProfilePage /></RequireAuth>} />
        {/* P12 — the member's match history, from My game's "All results". */}
        <Route path="/profile/results" element={<RequireAuth><ProfileResultsPage /></RequireAuth>} />
        <Route path="/change-password" element={<RequireAuth><ChangePasswordPage /></RequireAuth>} />
        {/* Deliberately NOT behind RequireAuth: an applicant waiting for approval and a member who
            cannot sign in are exactly the people wondering how any of this works (item 16). */}
        <Route path="/how-it-works" element={<HowItWorksPage />} />
        {/* P8 — the welcome wizard. Signed-in only: every step is about the member's own account. */}
        <Route path="/get-started" element={<RequireAuth><GetStartedPage /></RequireAuth>} />

        {/* R16 — one Admin tab. Everything the gear menu held is in here now. */}
        <Route path="/admin" element={<RequireAuth admin><AdminLayout /></RequireAuth>}>
          <Route index element={<AdminHomePage />} />
          <Route path="/admin/members" element={<AdminMembersPage />} />
          {/* Absolute child paths, so every `path=` here is a whole URL the title table can name. */}
          <Route path="/admin/members/:userId" element={<MemberDetailLayout />}>
            <Route index element={<MemberOverview />} />
            <Route path="/admin/members/:userId/wallet" element={<MemberWallet />} />
            <Route path="/admin/members/:userId/bookings" element={<MemberBookings />} />
            <Route path="/admin/members/:userId/doors" element={<MemberDoors />} />
            <Route path="/admin/members/:userId/night" element={<MemberNightTab />} />
            <Route path="/admin/members/:userId/access" element={<MemberAccess />} />
          </Route>
          <Route path="/admin/groups" element={<AdminGroupsPage />} />
          {/* P12 — disputed results, and removing a wrong one. */}
          <Route path="/admin/results" element={<AdminResultsPage />} />
          <Route path="/admin/transactions" element={<AdminLedgerPage />} />
          <Route path="/admin/reports" element={<Lazy><AdminReportsPage /></Lazy>} />
          <Route path="/admin/monitoring" element={<ControlBoardPage />} />
          <Route path="/admin/monitoring/doors" element={<AdminDoorsPage />} />
          <Route path="/admin/monitoring/doors/log" element={<AdminDoorsLogPage />} />
          <Route path="/admin/monitoring/doors/:id" element={<AdminDoorsDetailPage />} />
          <Route path="/admin/monitoring/doors/:id/card" element={<AdminDoorsCardPage />} />
          <Route path="/admin/monitoring/devices" element={<AdminDevicesPage />} />
          <Route path="/admin/monitoring/faults" element={<MonitoringFaultsPage />} />
          <Route path="/admin/monitoring/changes" element={<AdminChangeRecordPage />} />
          {/* R17: a person's night lives on the member (`/admin/members/:userId/night`). The old
              route stays a picker so a bookmark still lands somewhere — it asks who, then goes there. */}
          <Route path="/admin/monitoring/night" element={<MemberNightPage />} />
          <Route path="/admin/schedules" element={<AdminSchedulesPage />} />
          <Route path="/admin/schedules/:id" element={<AdminScheduleDetailPage />} />
          <Route path="/admin/courts" element={<AdminCourtsPage />} />
          <Route path="/admin/settings" element={<AdminSettingsPage />} />
          <Route path="/admin/webhooks" element={<AdminWebhooksPage />} />
        </Route>

        {/* PERMANENT redirects — query and hash carried across (see `RedirectKeepingQuery`). */}
        <Route path="/schedule" element={<RedirectKeepingQuery to="/bookings" />} />
        {/* P11 — a booking's page under the names it could have been linked by. */}
        <Route path="/schedule/:bookingId" element={<RedirectBooking />} />
        <Route path="/booking/:bookingId" element={<RedirectBooking />} />
        <Route path="/invites" element={<RedirectKeepingQuery to="/bookings/invites" />} />
        <Route path="/court-code" element={<RedirectKeepingQuery to="/my-code" />} />
        <Route path="/reports" element={<RequireAuth><ReportsRedirect /></RequireAuth>} />
        <Route path="/admin/ledger" element={<RedirectKeepingQuery to="/admin/transactions" />} />
        <Route path="/admin/biometric" element={<RedirectKeepingQuery to="/admin/members" />} />
        <Route path="/admin/devices" element={<RedirectKeepingQuery to="/admin/monitoring/devices" />} />
        <Route path="/admin/doors" element={<RedirectKeepingQuery to="/admin/monitoring/doors" />} />
        <Route path="/admin/doors/log" element={<RedirectKeepingQuery to="/admin/monitoring/doors/log" />} />
        <Route path="/admin/doors/:id" element={<RedirectDoor />} />
        <Route path="/admin/doors/:id/card" element={<RedirectDoor card />} />

        {DevPrimitivesPage && (
          <Route
            path="/dev/primitives"
            element={<Suspense fallback={null}><DevPrimitivesPage /></Suspense>}
          />
        )}
        {/* A real 404, not a redirect: a redirect is how a dead link in an email looks like a working one. */}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

/**
 * A redirect that keeps the QUERY STRING, because a bare one throws it away.
 *
 * <p>
 * `<Navigate to="/new" replace />` discards `location.search`, and the door log's whole
 * filter state lives there. Measured: `/admin/doors/log?door=<id>` landed on the new path
 * with no filter, so a link an admin had sent a colleague — or a "check this door" link out
 * of an outage email, which is the reason these redirects exist at all — arrived showing
 * every scan in the club. The hash goes across too, for the same reason `focusFragmentTarget`
 * exists.
 * </p>
 */
function RedirectKeepingQuery({ to }: { to: string }) {
  const { search, hash } = useLocation();
  return <Navigate to={`${to}${search}${hash}`} replace />;
}

/**
 * One door's old URL, carried to its new one with the id intact.
 *
 * <p>
 * A bare `<Navigate to="/admin/monitoring/doors" replace />` would have been simpler and would
 * have thrown the id away — a bookmark to one door landing on the fleet list, which is the
 * failure a redirect exists to prevent. `useParams` is the whole of it.
 * </p>
 */
function RedirectDoor({ card = false }: { card?: boolean }) {
  const { id } = useParams();
  const base = `/admin/monitoring/doors/${id ?? ""}`;
  return <RedirectKeepingQuery to={card ? `${base}/card` : base} />;
}

/** A booking's page from a path it was never meant to have (P11) — the id carried across. */
function RedirectBooking() {
  const { bookingId } = useParams();
  return <RedirectKeepingQuery to={`/bookings/${bookingId ?? ""}`} />;
}

/**
 * The routes that are worth anything with no signal at all. (D3)
 *
 * <p>
 * One, today, and the list is deliberately a literal rather than a prop somebody can pass: a
 * route that renders while the club cannot be reached is rendering from a store on the device,
 * and which screens may do that is an app-wide decision, not a per-page one.
 * </p>
 *
 * <p>
 * <b>Why `/my-code` earns it.</b> Reviewer D's finding is a member standing at a locked door
 * with no signal, which is not an edge case — it is the moment the whole surface was designed
 * for. `lib/lastKnown` exists because the service worker is forbidden to cache a byte of member
 * data, so the page keeps its own copy of the last code, the club's door rules and the club's
 * telephone number. All of it was unreachable behind `ConnectionLost`: the app-wide gate fired
 * before the page that knew how to cope. Every other route needs the club to say anything true,
 * and gets the honest "can't reach it" screen.
 * </p>
 */
const OFFLINE_CAPABLE = new Set(["/my-code"]);

/**
 * The guard on every member and admin route.
 *
 * <p>
 * It carries the location it turned away in router state, so `/login` can finish the journey the
 * member actually started. Without that, a "top up" link from an email or a bookmarked
 * `/wallet` was silently discarded and every sign-in landed on the default screen — the member
 * had to navigate to the thing they had already asked for.
 * </p>
 *
 * <p>
 * It also holds a session whose password an admin has just reset on `/change-password`. That is
 * courtesy, not security: `PasswordChangeGate` on the API refuses the same session everywhere
 * else regardless, because a redirect is only ever a suggestion to whatever holds the token.
 * </p>
 *
 * <p>
 * Exported for `offline-routing.test.tsx`, which is the only test that can hold the
 * offline-capable rule: the decision is three conditions deep and the two that matter most —
 * "only these routes" and "only a confirmed identity" — are invisible to the production-build
 * e2e, which necessarily arrives with both already satisfied.
 * </p>
 */
export function RequireAuth({ children, admin = false }: { children: React.ReactNode; admin?: boolean }) {
  const auth = useAuth();
  const location = useLocation();
  if (auth.status === "loading") return <BootSplash />;
  // A session we cannot confirm is not a session we have lost. Bouncing to /login here is what
  // turned a few seconds of backend downtime into a permanent sign-out for everyone on the site.
  //
  /**
   * D3 — and an offline-capable route falls through instead.
   *
   * <p>
   * Three conditions, and each is load-bearing. The state must be `offline`, which `auth.tsx`
   * reaches only on a network failure and never on a 401 — an authentication refusal still ends
   * the session and still goes to `/login`, because "the club says this token is bad" and "I
   * could not ask" are different events and conflating them is the older bug this file already
   * carries a paragraph about. The route must be on the list above. And this device must hold
   * an identity the club has actually confirmed at some point: a token alone is a string in
   * `localStorage` that nothing has vouched for, and a first-ever visitor who is handed one has
   * no last-known store to render anyway.
   * </p>
   *
   * <p>
   * The page is still responsible for saying that what it is showing is remembered rather than
   * fresh. It knows how — every sentence on it is built from a store that records an absolute
   * expiry and its own age — and it could not say it while it was not being rendered.
   * </p>
   */
  if (auth.status === "offline") {
    const canCope = OFFLINE_CAPABLE.has(location.pathname) && readLastIdentity() !== null;
    if (!canCope) return <ConnectionLost onRetry={auth.retryConnection} />;
    return <>{children}</>;
  }
  if (auth.status !== "authenticated") return <Navigate to="/login" replace state={{ from: location }} />;
  if (auth.mustChangePassword && location.pathname !== "/change-password") {
    return <Navigate to="/change-password" replace />;
  }
  // A member who follows an admin link lands on their own landing, not on a redirect to it.
  if (admin && !auth.isAdmin) return <Navigate to={LANDING_PATH} replace />;
  return <>{children}</>;
}

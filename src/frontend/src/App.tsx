import { Suspense, lazy as reactLazy, useEffect, type ComponentType, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { AuthProvider } from "./lib/auth";
import AppShell from "./components/shell/AppShell";
import { ToastProvider } from "./components/Toast";
import { loadClubIdentity } from "./lib/clubIdentity";
import { BalanceProvider } from "./lib/balance";
import { ProfileProvider } from "./lib/profile";
import { ClubUiProvider } from "./lib/ClubUiProvider";
import HomePage from "./pages/Home";
import LoginPage from "./pages/Login";
import MyCodePage from "./pages/MyCode";
import { FirstRunGate } from "./components/onboarding/FirstRunGate";
import NotFoundPage from "./pages/NotFound";
// `/reports` split in two (Target IA → Routes): club reports under Admin, a member's own under Wallet.
import { ReportsRedirect } from "./pages/Reports";
import { RouteAnnouncer } from "./components/RouteAnnouncer";
import { RouteSkeleton } from "./components/shell/SessionScreens";
import { RequireAuth } from "./components/shell/RequireAuth";
import { loadChunk } from "./lib/chunkLoad";
import { loadAdminFrame, routeLazy } from "./routeChunks";
import { NavPrefetch } from "./components/shell/NavPrefetch";

/**
 * `React.lazy`, with the chunk's fetch going through `loadChunk` (F4.3): a stale deploy reloads
 * once, and a chunk that cannot be fetched throws a `ChunkLoadError` the page boundary explains
 * ("you're offline — this page opens when you're back online") instead of the generic failure.
 * Named `lazy` so every route below still reads, and is still matched by the route guards, as one.
 */
const lazy: typeof reactLazy = (load) => reactLazy(() => loadChunk(load));

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
 * Code-split routes (P10). The entry chunk carries what the first screen needs and what must
 * work with no signal — the shell, the public landing, sign-in and My Code, the member's
 * landing (the service worker precaches only what `index.html` names, so an offline /my-code
 * cannot wait on a lazy chunk). Every other page loads when first opened, behind the
 * page-shaped {@link RouteSkeleton}.
 *
 * <p>
 * <b>The admin console's frame, its Overview and the two doors pages are ONE lazy chunk</b>
 * (`adminFrame`, perf lane 2026-09-30 — they were eager, ~97 kB of every member's first load).
 * They read the club's doors through the shared doors store, and a reader mounting after a
 * Suspense boundary resolved used to fire a second identical GET (E-L6: "one read on arrival,
 * not one per reader"; `e2e/admin-doors.spec.ts` counts it). `named` therefore does not
 * suspend once the chunk is in, the chunk is fetched at boot on an admin path, and the store takes
 * a read that landed moments before rather than reading again.
 * </p>
 */
/**
 * A named export of a lazy module. Once that module has arrived, the next page from it does NOT
 * suspend (perf lane, 2026-09-30): React.lazy reads a thenable that answers synchronously, so a
 * page mounts in the same commit as the frame around it. That is what keeps the admin frame and
 * its doors pages (`adminFrame`, one chunk) reading the doors store once (E-L6).
 */
const arrived = new WeakMap<() => Promise<unknown>, Record<string, ComponentType>>();
const named = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) =>
  reactLazy(() => {
    const ready = arrived.get(load);
    if (ready) return { then: (resolve: (m: { default: ComponentType }) => void) => resolve({ default: ready[name] }) } as Promise<{ default: ComponentType }>;
    return loadChunk(load).then((m) => {
      arrived.set(load, m as Record<string, ComponentType>);
      return { default: m[name] };
    });
  });

const AdminLayout = named(loadAdminFrame, "AdminLayout");
const AdminHomePage = named(loadAdminFrame, "AdminHomePage");
const AdminDoorsPage = named(loadAdminFrame, "AdminDoorsPage");
const AdminDoorsDetailPage = named(loadAdminFrame, "AdminDoorsDetailPage");

const RegisterPage = lazy(() => import("./pages/Register"));
const VerifyEmailPage = lazy(() => import("./pages/VerifyEmail"));
const ForgotPasswordPage = lazy(() => import("./pages/ForgotPassword"));
const ResetPasswordPage = lazy(() => import("./pages/ResetPassword"));
const WelcomePage = lazy(() => import("./pages/Welcome"));
const ChangePasswordPage = lazy(() => import("./pages/ChangePassword"));
const SchedulePage = routeLazy("schedule");
const WalletPage = routeLazy("wallet");
const BuyMinutesPage = lazy(() => import("./pages/TopUp"));
const BuyMinutesStatusPage = lazy(() => import("./pages/TopUpStatus"));
const AdminPackagesPage = lazy(() => import("./pages/admin/AdminPackages"));
const ProfilePage = routeLazy("profile");
const ProfileResultsPage = lazy(() => import("./pages/ProfileResults"));
const HowItWorksPage = lazy(() => import("./pages/HowItWorks"));
const GetStartedPage = lazy(() => import("./pages/GetStarted"));
const BookingDetailPage = routeLazy("bookingDetail");
const InvitesPage = routeLazy("invites");
const InviteLinkPage = lazy(() => import("./pages/InviteLink"));
const InviteDeepLinkPage = lazy(() => import("./pages/InviteDeepLink"));
const InboxPage = routeLazy("inbox");

const AdminMembersPage = lazy(() => import("./pages/AdminMembers"));
const MemberDetailLayout = lazy(() => import("./pages/admin/member"));
const MemberOverview = named(() => import("./pages/admin/member"), "MemberOverview");
const MemberWallet = named(() => import("./pages/admin/member"), "MemberWallet");
const MemberBookings = named(() => import("./pages/admin/member"), "MemberBookings");
const MemberDoors = named(() => import("./pages/admin/member"), "MemberDoors");
const MemberNightTab = named(() => import("./pages/admin/member"), "MemberNightTab");
const MemberAccess = named(() => import("./pages/admin/member"), "MemberAccess");
const AdminGroupsPage = named(() => import("./pages/AdminGroups"), "AdminGroupsPage");
const AdminResultsPage = lazy(() => import("./pages/admin/AdminResults"));
const AdminLedgerPage = lazy(() => import("./pages/AdminLedger"));
const ControlBoardPage = named(() => import("./pages/monitoring/ControlBoard"), "ControlBoardPage");
const AdminDoorsLogPage = named(() => import("./pages/AdminDoorsLog"), "AdminDoorsLogPage");
const AdminDoorsCardPage = named(() => import("./pages/AdminDoorsCard"), "AdminDoorsCardPage");
const AdminDevicesPage = named(() => import("./pages/AdminDevices"), "AdminDevicesPage");
const MonitoringFaultsPage = named(() => import("./pages/monitoring/MonitoringFaults"), "MonitoringFaultsPage");
const AdminChangeRecordPage = named(() => import("./pages/monitoring/AdminChangeRecord"), "AdminChangeRecordPage");
const MemberNightPage = named(() => import("./pages/monitoring/MemberNight"), "MemberNightPage");
const AdminSchedulesPage = named(() => import("./pages/AdminSchedules"), "AdminSchedulesPage");
const AdminScheduleDetailPage = named(() => import("./pages/AdminScheduleDetail"), "AdminScheduleDetailPage");
const AdminCourtsPage = lazy(() => import("./pages/admin/AdminCourts"));
const AdminSettingsPage = lazy(() => import("./pages/AdminSettings"));
const AdminWebhooksPage = lazy(() => import("./pages/AdminWebhooks"));

/**
 * The two report screens carry the chart library, so they load when first opened: a member who
 * never looks at their activity never downloads Recharts, and neither does an admin who never
 * opens the club's reports.
 *
 * <p>
 * The admin console's frame and Overview are lazy too, as one chunk — see `named` above.
 * </p>
 */
const AdminReportsPage = lazy(() => import("./pages/admin/AdminReports"));
const WalletActivityPage = lazy(() => import("./pages/WalletActivity"));

/** A lazily loaded route: the page's own shape while its code arrives, never "Loading…". */
function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteSkeleton />}>{children}</Suspense>;
}

/** Toasts that leave with the page they were raised on (BM-14); see `TOAST_KEEP_ACROSS_NAV_MS`. */
function RoutedToasts({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <ToastProvider routeKey={pathname}>{children}</ToastProvider>;
}

export default function App() {
  // FM-8 — which club this address serves: the crest, the sign-in band, the pass and the tab title.
  useEffect(() => { void loadClubIdentity(); }, []);
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
        {/* Inside ProfileProvider, because that is where the club's money symbol arrives, and
            outside everything that formats money. */}
        <ClubUiProvider>
        <BalanceProvider>
        <RoutedToasts>
          <FirstRunGate />
          <NavPrefetch />
          <AppRoutes />
        </RoutedToasts>
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
      <Route element={<AppShell />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<Lazy><RegisterPage /></Lazy>} />
        <Route path="/verify-email/:token" element={<Lazy><VerifyEmailPage /></Lazy>} />
        <Route path="/forgot-password" element={<Lazy><ForgotPasswordPage /></Lazy>} />
        <Route path="/reset-password/:token" element={<Lazy><ResetPasswordPage /></Lazy>} />
        <Route path="/welcome/:token" element={<Lazy><WelcomePage /></Lazy>} />

        {/* R15 — My Code is the landing, then Bookings, then Wallet. */}
        <Route path="/my-code" element={<RequireAuth><MyCodePage /></RequireAuth>} />
        <Route path="/bookings" element={<RequireAuth><Lazy><SchedulePage /></Lazy></RequireAuth>} />
        {/* P11. `/bookings/invites` is literal, so it outranks `/bookings/:bookingId`. */}
        <Route path="/bookings/invites" element={<RequireAuth><Lazy><InvitesPage /></Lazy></RequireAuth>} />
        <Route path="/bookings/:bookingId" element={<RequireAuth><Lazy><BookingDetailPage /></Lazy></RequireAuth>} />
        {/* A shared invite link (`/j/{token}`, WhatsApp) and the invite email's deep link. Open
            signed OUT too (R1 F2): each shows a preview with "Sign in to answer" / "Join the club",
            because a friend who is not a member yet is exactly who a WhatsApp link reaches. */}
        <Route path="/j/:token" element={<RequireAuth allowAnonymous><Lazy><InviteLinkPage /></Lazy></RequireAuth>} />
        <Route path="/invites/:participantId" element={<RequireAuth allowAnonymous><Lazy><InviteDeepLinkPage /></Lazy></RequireAuth>} />
        <Route path="/inbox" element={<RequireAuth><Lazy><InboxPage /></Lazy></RequireAuth>} />
        <Route path="/wallet" element={<RequireAuth><Lazy><WalletPage /></Lazy></RequireAuth>} />
        <Route path="/wallet/buy" element={<RequireAuth><Lazy><BuyMinutesPage /></Lazy></RequireAuth>} />
        <Route path="/wallet/buy/:purchaseId" element={<RequireAuth><Lazy><BuyMinutesStatusPage /></Lazy></RequireAuth>} />
        {/* P13 §12.14: a PayFast return in flight at deploy time lands on the old URL — id AND query kept. */}
        <Route path="/wallet/topup" element={<RedirectKeepingQuery to="/wallet/buy" />} />
        <Route path="/wallet/topup/:topupId" element={<RedirectTopUp />} />
        <Route path="/wallet/activity" element={<RequireAuth><Lazy><WalletActivityPage /></Lazy></RequireAuth>} />
        <Route path="/profile" element={<RequireAuth><Lazy><ProfilePage /></Lazy></RequireAuth>} />
        {/* P12 — the member's match history, from My game's "All results". */}
        <Route path="/profile/results" element={<RequireAuth><Lazy><ProfileResultsPage /></Lazy></RequireAuth>} />
        <Route path="/change-password" element={<RequireAuth><Lazy><ChangePasswordPage /></Lazy></RequireAuth>} />
        {/* Deliberately NOT behind RequireAuth: an applicant waiting for approval and a member who
            cannot sign in are exactly the people wondering how any of this works (item 16). */}
        <Route path="/how-it-works" element={<Lazy><HowItWorksPage /></Lazy>} />
        {/* P8 — the welcome wizard. Signed-in only: every step is about the member's own account. */}
        <Route path="/get-started" element={<RequireAuth><Lazy><GetStartedPage /></Lazy></RequireAuth>} />

        {/* R16 — one Admin tab. Everything the gear menu held is in here now. */}
        <Route path="/admin" element={<RequireAuth admin><Lazy><AdminLayout /></Lazy></RequireAuth>}>
          <Route index element={<AdminHomePage />} />
          {/* R4 form factor: the member is a CHILD of the list, so the list stays mounted beside it
              (SplitView, from a 64rem box) and keeps its filters, its page and its scroll. */}
          <Route path="/admin/members" element={<Lazy><AdminMembersPage /></Lazy>}>
            {/* Absolute child paths, so every `path=` here is a whole URL the title table can name. */}
            <Route path="/admin/members/:userId" element={<Lazy><MemberDetailLayout /></Lazy>}>
              <Route index element={<Lazy><MemberOverview /></Lazy>} />
              <Route path="/admin/members/:userId/wallet" element={<Lazy><MemberWallet /></Lazy>} />
              <Route path="/admin/members/:userId/bookings" element={<Lazy><MemberBookings /></Lazy>} />
              <Route path="/admin/members/:userId/doors" element={<Lazy><MemberDoors /></Lazy>} />
              <Route path="/admin/members/:userId/night" element={<Lazy><MemberNightTab /></Lazy>} />
              <Route path="/admin/members/:userId/access" element={<Lazy><MemberAccess /></Lazy>} />
            </Route>
          </Route>
          <Route path="/admin/groups" element={<Lazy><AdminGroupsPage /></Lazy>} />
          <Route path="/admin/packages" element={<Lazy><AdminPackagesPage /></Lazy>} />
          {/* P12 — disputed results, and removing a wrong one. */}
          <Route path="/admin/results" element={<Lazy><AdminResultsPage /></Lazy>} />
          <Route path="/admin/transactions" element={<Lazy><AdminLedgerPage /></Lazy>} />
          <Route path="/admin/reports" element={<Lazy><AdminReportsPage /></Lazy>} />
          <Route path="/admin/monitoring" element={<Lazy><ControlBoardPage /></Lazy>} />
          <Route path="/admin/monitoring/doors" element={<AdminDoorsPage />} />
          <Route path="/admin/monitoring/doors/log" element={<Lazy><AdminDoorsLogPage /></Lazy>} />
          <Route path="/admin/monitoring/doors/:id" element={<AdminDoorsDetailPage />} />
          <Route path="/admin/monitoring/doors/:id/card" element={<Lazy><AdminDoorsCardPage /></Lazy>} />
          <Route path="/admin/monitoring/devices" element={<Lazy><AdminDevicesPage /></Lazy>} />
          <Route path="/admin/monitoring/faults" element={<Lazy><MonitoringFaultsPage /></Lazy>} />
          <Route path="/admin/monitoring/changes" element={<Lazy><AdminChangeRecordPage /></Lazy>} />
          {/* R17: a person's night lives on the member (`/admin/members/:userId/night`). The old
              route stays a picker so a bookmark still lands somewhere — it asks who, then goes there. */}
          <Route path="/admin/monitoring/night" element={<Lazy><MemberNightPage /></Lazy>} />
          <Route path="/admin/schedules" element={<Lazy><AdminSchedulesPage /></Lazy>} />
          <Route path="/admin/schedules/:id" element={<Lazy><AdminScheduleDetailPage /></Lazy>} />
          <Route path="/admin/courts" element={<Lazy><AdminCourtsPage /></Lazy>} />
          <Route path="/admin/settings" element={<Lazy><AdminSettingsPage /></Lazy>} />
          <Route path="/admin/webhooks" element={<Lazy><AdminWebhooksPage /></Lazy>} />
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

/** An old top-up status URL (PayFast's return, pre-P13) to its purchase page, id and query kept. */
function RedirectTopUp() {
  const { topupId } = useParams();
  return <RedirectKeepingQuery to={`/wallet/buy/${encodeURIComponent(topupId ?? "")}`} />;
}

/** A booking's page from a path it was never meant to have (P11) — the id carried across. */
function RedirectBooking() {
  const { bookingId } = useParams();
  return <RedirectKeepingQuery to={`/bookings/${bookingId ?? ""}`} />;
}

/**
 * The guard lives in `components/shell/RequireAuth.tsx` (moved out so the complexity gate measures
 * the route table alone); re-exported because the routing tests import it from here.
 */
export { RequireAuth };

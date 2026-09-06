import { render, type RenderOptions } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { ToastProvider } from "../components/Toast";
import { AuthProvider } from "../lib/auth";
import { BalanceProvider } from "../lib/balance";
import { tokenStore } from "../lib/api";

/**
 * The shared frontend test harness.
 *
 * <p>
 * Every route test needs the same three things: a router, a toast provider, and a
 * fetch that answers with fixtures instead of hitting a server. Writing those three
 * by hand in each file is how they drift — and a route test whose fetch stub returns
 * a slightly different shape from the real API is a test that passes while the screen
 * is broken.
 * </p>
 *
 * <p>
 * <b>The stub matches on method and path and fails loudly on anything unrecognised.</b>
 * A permissive stub that returns <code>{}</code> for unknown calls hides exactly the
 * mistake worth catching: a screen calling an endpoint nobody meant it to.
 * </p>
 */

export type StubRoute = {
  method?: string;
  /** Matched against the request path with `startsWith`, so query strings are fine. */
  path: string;
  /**
   * A single status for every call, or one per call with the last repeating — the same
   * indexing as `sequence`, so a route can answer 402 then 200. A screen whose whole job
   * is to react to a refusal and retry cannot be driven by a stub that only has one
   * status to give.
   */
  status?: number | number[];
  /** Response headers, keyed lower-case — `content-disposition` for a file download. */
  headers?: Record<string, string>;
  body: unknown;
  /**
   * Answers the nth matching call with the nth entry, the last one repeating — for a
   * screen that fetches the same thing twice and must show that it got two different
   * answers. When set, `body` is ignored.
   */
  sequence?: unknown[];
};

export type StubCall = {
  method: string;
  path: string;
  body: unknown;
  /**
   * The body exactly as it went over the wire, for the assertions where parsing would
   * hide the point — a key that must be ABSENT (not present-as-null, not
   * present-as-undefined) is only provably absent in the serialised text.
   */
  raw: string | undefined;
  /**
   * The request headers, lower-cased. The wallet CSV's whole defect was a MISSING
   * Authorization header on a request the browser made by itself, so a test of that fix
   * has to be able to look at what went out, not only at what came back.
   */
  headers: Record<string, string>;
};

export type FetchStub = {
  /** Every call the component made, in order — for asserting what a save actually sent. */
  calls: StubCall[];
};

function parseIfJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return raw; }
}

/** Request headers as a plain lower-cased map, whatever shape `fetch` was handed. */
function lowerCased(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((headers ?? {}) as Record<string, string>)) out[k.toLowerCase()] = v;
  return out;
}

/** A stubbed body on the wire: a string route answers as itself, anything else as JSON. */
function serialise(answer: unknown): string {
  return typeof answer === "string" ? answer : JSON.stringify(answer);
}

export function stubFetch(routes: StubRoute[]): FetchStub {
  const calls: StubCall[] = [];
  const served = new Map<StubRoute, number>();

  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const raw = init?.body ? String(init.body) : undefined;
    // Not every request body is JSON — the photo upload posts FormData, which stringifies to
    // "[object FormData]" and used to throw a SyntaxError out of the fetch mock itself. The page
    // then reported a generic network failure, and a test asserting the real error message failed
    // with no hint that the stub, not the page, was the problem.
    const body = raw ? parseIfJson(raw) : undefined;
    calls.push({ method, path, body, raw, headers: lowerCased(init?.headers) });

    // Longest prefix wins, not first-declared.
    //
    // "/api/v1/admin/devices/" is a prefix of "/api/v1/admin/devices/api-key", so
    // first-match order meant a caller could stub both and silently get the wrong one
    // depending on which they listed first — a test that fails with an empty screen
    // and no hint as to why. Ordering by specificity removes the trap rather than
    // documenting it.
    const route = routes
      .filter((r) => (r.method ?? "GET").toUpperCase() === method && path.startsWith(r.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!route) {
      // Loud on purpose. A stub that shrugged and returned {} would let a screen call
      // an endpoint nobody meant it to and still pass.
      return Promise.reject(new Error(`No stub for ${method} ${path}`));
    }

    const nth = served.get(route) ?? 0;
    served.set(route, nth + 1);
    const answer = route.sequence ? route.sequence[Math.min(nth, route.sequence.length - 1)] : route.body;

    // `status` and `ok` are computed out here rather than inline in the literal because
    // lizard reads a bare `<` inside an object literal in a .tsx file as the start of a
    // JSX tag, never finds its close, and swallows the whole rest of the file into one
    // anonymous function. That is why `make complexity` used to measure this file as a
    // single 189-line function and could not see `stubFetch` at all — and why adding a
    // fixture to the end of the file tripped the length gate on a line nobody touched.
    const status = Array.isArray(route.status)
      ? route.status[Math.min(nth, route.status.length - 1)]
      : route.status ?? 200;
    const ok = status < 400;
    // `json()` and `blob()` as well as `text()`: the typed client reads text and parses it,
    // the multipart photo upload calls `res.json()` directly, and the wallet CSV must be
    // FETCHED with the session's bearer token and saved from a blob, because a plain
    // `<a download>` navigates with no Authorization header at all. A stub with only one
    // of the three turns a working page into a TypeError the page reports as a generic
    // failure — indistinguishable, from the test's side, from the page being broken.
    const headers = lowerCased(route.headers);
    const wire = serialise(answer);
    return Promise.resolve({
      ok,
      status,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      text: () => Promise.resolve(wire),
      json: () => Promise.resolve(answer),
      blob: () => Promise.resolve(new Blob([wire])),
    } as unknown as Response);
  }));

  return { calls };
}

/**
 * `AuthProvider` is here for every test, not only the ones that need a session.
 *
 * <p>
 * A page that reads `useAuth` throws outright without it, which reads as a broken page
 * rather than a missing wrapper. With no token in storage the provider resolves to
 * anonymous synchronously and issues no request at all, so it costs the other tests
 * nothing — {@link signIn} is what turns it on.
 * </p>
 */
function Providers({ children, entries }: { children: ReactNode; entries?: string[] }) {
  return (
    <MemoryRouter initialEntries={entries}>
      <AuthProvider>
        {/*
          BalanceProvider is here for the same reason AuthProvider is: a page that reads
          `useBalance` throws outright without it, which reads as a broken page rather
          than a missing wrapper. Anonymous, it fetches nothing; signed in it asks for
          /api/v1/wallet, so a test that calls `signIn` stubs that route too.
        */}
        <BalanceProvider>
          <ToastProvider>{children}</ToastProvider>
        </BalanceProvider>
      </AuthProvider>
    </MemoryRouter>
  );
}

/**
 * Puts a session in place for the render that follows: a token in storage, which is what
 * makes `AuthProvider` ask `/api/v1/whoami`. Stub that route as well, and call this
 * BEFORE `renderPage` — the provider reads storage on mount.
 */
export function signIn({ isAdmin }: { isAdmin: boolean }) {
  tokenStore.set("test.token.value");
  return {
    tenant_slug: "crusaders", tenant_id: "00000000-0000-0000-0000-0000000000cc",
    user_id: "44444444-4444-4444-4444-444444444444", is_authenticated: true, is_admin: isAdmin,
  };
}

/** Drops any session left behind, so the next test starts anonymous. */
export function signOut() { tokenStore.clear(); }

/**
 * Renders a page inside the house providers.
 *
 * <p>
 * <code>initialEntries</code> is for the pages that read a route param —
 * <code>/wallet/topup/:topupId</code> and friends. Without it the router starts at
 * <code>/</code>, <code>useParams</code> hands the page <code>undefined</code>, and the
 * page sits on its loading state forever: a test that reads as "the screen never
 * rendered" when in fact it was never given the id it needs.
 * </p>
 */
export function renderPage(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper"> & { initialEntries?: string[] },
) {
  const { initialEntries, ...rest } = options ?? {};
  const wrapper = ({ children }: { children: ReactNode }) => <Providers entries={initialEntries}>{children}</Providers>;
  return render(ui, { wrapper, ...rest });
}

/** The settings document the API returns, with every field the screens read. */
export const SETTINGS_FIXTURE = {
  slice_minutes: 15,
  slice_price_credits: 8,
  advance_booking_days: 14,
  day_start_minute: 360,
  day_end_minute: 1320,
  penalty_pct: 30,
  grace_window_minutes: 5,
  penalty_window_minutes: 15,
  timezone: "Africa/Johannesburg",
  button_map: ["court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "minutes:60"],
  // The club's real shape, and the seed's: weekdays long, weekend short, and — the part
  // that made G-F2 a defect rather than a gap — the map names days the flat pair above
  // cannot override. Sunday is deliberately absent, because a day the map does not name is
  // the only way the flat pair means anything.
  operating_hours: { mon: "06:00-22:00", tue: "06:00-22:00", wed: "06:00-22:00", thu: "06:00-22:00", fri: "06:00-22:00", sat: "07:00-20:00" },
  credits_per_zar_regular: 1.6,
  credits_per_zar_league: 2.4,
  topup_block_zar: 100,
  topup_max_zar_per_member: 1000,
  member_per_day_max_minutes: 60,
  peak_hours: "16:00-19:00",
  peak_advance_hours_for_regular: 1,
  retention_years: 2,
  no_show_lookback_days: 7,
  walk_up_max_minutes: 90,
  heartbeat_seconds: 60,
  activation_forward_window_minutes: 120,
  activation_cue_window_minutes: 10,
  qr_lifetime_seconds: 60,
  roster_window_minutes: 120,
};

export function deviceFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    device_code: "court-box-1",
    name: "Court 1 box",
    kind: "CourtBox",
    hardware: "Esp8266",
    // Relay order: index 0 is relay A. A box drives up to four courts.
    court_numbers: [1],
    gate_key: null,
    mac_address: "5ccf7f1a2b3c",
    enabled: true,
    last_seen_at: new Date().toISOString(),
    last_ip_address: "192.168.68.150",
    running_version: "1.0.0",
    mega_version: "1.0.0",
    // False by default: most fixtures are boxes an admin has already configured. The
    // badge is the interesting case, so a test that wants it asks for it.
    auto_registered: false,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

export function courtFixture(courtNumber: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `22222222-2222-2222-2222-22222222222${courtNumber}`,
    court_number: courtNumber,
    name: `Court ${courtNumber}`,
    court_type: "Squash",
    slice_price_credits: 8,
    is_active: true,
    ...overrides,
  };
}

/** The club's courts — what the device screens offer when assigning relays. */
export const COURTS_FIXTURE = [courtFixture(1), courtFixture(2), courtFixture(3)];

/** One row of the admin members list, as AdminMemberEndpoints shapes it. */
export function memberFixture(overrides: Record<string, unknown> = {}) {
  return {
    membership_id: "33333333-3333-3333-3333-333333333333",
    user_id: "44444444-4444-4444-4444-444444444444",
    email: "ada@example.com",
    full_name: "Ada Lovelace",
    membership_number: "CR-0001",
    photo_url: null,
    status: "Active",
    member_class: "Regular",
    // True by default: the unverified case is the interesting one, so a test that wants
    // the badge and the resend action asks for it.
    email_verified: true,
    created_at: new Date().toISOString(),
    rejection_reason: null,
    balance_credits: 120,
    ...overrides,
  };
}

/** One admin-ledger row (LedgerRowDto, camelCase). `relatedBookingId` is null unless given. */
export function ledgerRowFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "55555555-5555-5555-5555-555555555555",
    at: "2026-09-01T10:00:00Z",
    from: "Ada Lovelace",
    to: "Club treasury",
    amountCredits: 24,
    signedAmountCredits: -24,
    type: "BookingCharge",
    comment: "Booking charge",
    subjectUserId: "44444444-4444-4444-4444-444444444444",
    subjectName: "Ada Lovelace",
    actorUserId: "44444444-4444-4444-4444-444444444444",
    actorName: "Ada Lovelace",
    relatedBookingId: null,
    ...overrides,
  };
}

/** The club's one device API key, as GET /admin/devices/api-key answers it. */
export const DEVICE_API_KEY_FIXTURE = {
  api_key: "crsdr_live_9f3a7c21b8e4d650a1c2",
  regenerated_at: "2026-09-01T08:30:00Z",
};

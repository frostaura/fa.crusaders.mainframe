import { render, type RenderOptions } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { ToastProvider } from "../components/Toast";
import { AuthProvider } from "../lib/auth";
import { BalanceProvider } from "../lib/balance";
import { tokenStore } from "../lib/api";
// The API's own bound on `gate_key`, read from the copy module rather than restated: a mock
// that refuses at 64 while the column stores 64 has to be the SAME 64.
import { GATE_KEY_MAX_LENGTH } from "../lib/gateCopy";

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
  /** The canned answer. Optional only when {@link StubRoute.respond} supplies one instead. */
  body?: unknown;
  /**
   * Answers the nth matching call with the nth entry, the last one repeating — for a
   * screen that fetches the same thing twice and must show that it got two different
   * answers. When set, `body` is ignored.
   */
  sequence?: unknown[];
  /**
   * Answers from the REQUEST rather than from a canned body, and wins over both `body`
   * and `sequence`.
   *
   * <p>
   * A canned body pins nothing about what was sent: a stub that answers
   * <code>{gate_key: null}</code> with a cleared row would report a cleared door however
   * the page had asked for it, and that is exactly how the frontend shipped a PATCH the
   * API treats as "leave it alone" with two tests green over it. A route that applies the
   * API's own rule — see {@link applyDevicePatch} — makes the wrong wire value fail here
   * for the reason it fails in production.
   * </p>
   */
  respond?: (request: StubRequest) => unknown;
};

/** What a {@link StubRoute.respond} handler is given: the call it is answering. */
export type StubRequest = {
  method: string;
  path: string;
  /** The parsed request body, or undefined for a bodyless call. */
  body: unknown;
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

/**
 * What this route answers this call with: `respond` first, then the nth `sequence` entry
 * with the last repeating, then the canned `body`.
 *
 * <p>
 * Out here rather than inline in the stub, because the stub is already at the complexity
 * gate's bound and three more branches inside it put the whole file over.
 * </p>
 */
function answerFor(route: StubRoute, nth: number, request: StubRequest): unknown {
  if (route.respond) return route.respond(request);
  if (route.sequence) return route.sequence[Math.min(nth, route.sequence.length - 1)];
  return route.body;
}

/** The status this route answers this call with — a single one, or the nth with the last repeating. */
function statusFor(route: StubRoute, nth: number): number {
  if (!Array.isArray(route.status)) return route.status ?? 200;
  return route.status[Math.min(nth, route.status.length - 1)];
}

const REFUSAL = Symbol("stub-refusal");

/** A status and a body, returned FROM a {@link StubRoute.respond} handler. See {@link refuse}. */
export type StubRefusal = { [REFUSAL]: true; status: number; body: unknown };

/**
 * A refusal a `respond` handler can answer with.
 *
 * <p>
 * `status` on a route is fixed per call index, which is enough for a stub that always
 * refuses and useless for a stub that decides. A server that refuses what the API refuses
 * has to answer 400 for one request and 200 for the next on the same route — so the status
 * travels back with the body rather than beside it.
 * </p>
 */
export function refuse(status: number, body: unknown): StubRefusal {
  return { [REFUSAL]: true, status, body };
}

function asRefusal(answer: unknown): StubRefusal | null {
  const marked = typeof answer === "object" && answer !== null
    && (answer as Record<symbol, unknown>)[REFUSAL] === true;
  return marked ? (answer as StubRefusal) : null;
}

/** The body and the status for this call, with a {@link refuse} from a handler unwrapped. */
function resolveAnswer(route: StubRoute, nth: number, request: StubRequest): { answer: unknown; status: number } {
  const answer = answerFor(route, nth, request);
  const refusal = asRefusal(answer);
  if (refusal) return { answer: refusal.body, status: refusal.status };
  return { answer, status: statusFor(route, nth) };
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
    if (!route.respond && !("body" in route)) {
      // Same reason, one level in: a route with neither an answer nor a responder would
      // serialise to the string "undefined" and read as a parse failure in the page.
      return Promise.reject(new Error(`Stub for ${method} ${route.path} has neither body nor respond`));
    }

    const nth = served.get(route) ?? 0;
    served.set(route, nth + 1);

    // `status` and `ok` are computed out here rather than inline in the literal because
    // lizard reads a bare `<` inside an object literal in a .tsx file as the start of a
    // JSX tag, never finds its close, and swallows the whole rest of the file into one
    // anonymous function. That is why `make complexity` used to measure this file as a
    // single 189-line function and could not see `stubFetch` at all — and why adding a
    // fixture to the end of the file tripped the length gate on a line nobody touched.
    const { answer, status } = resolveAnswer(route, nth, { method, path, body });
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
  // The API's default. With the two above it, this fixture is the club's shipping state —
  // which is what makes the door horizon it implies (120 + 10 = 130, not the 30 in
  // `gate_early_entry_minutes`) the number the settings screen has to be right about.
  device_alert_cooldown_minutes: 60,
  // The three door-gate numbers, at the API's own defaults. `active_member` is the default
  // policy, so a fixture that wanted the strict one has to say so — which is what makes the
  // tests of `booking_window` prove something.
  gate_unlock_seconds: 3,
  gate_access_policy: "active_member",
  gate_early_entry_minutes: 30,
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

/**
 * A door gate, as `GET /admin/devices/` serves one.
 *
 * <p>
 * Deliberately NOT `deviceFixture({ kind: "Gate" })`: that leaves `court_numbers: [1]` on a
 * row the API guarantees has none, so a test written on it would prove the screen handles a
 * shape the server never sends while saying nothing about the shape it does. The fields that
 * differ from a box are the whole point of the fixture — `kind`, `court_numbers`, `gate_key`,
 * the ESP32 hardware, and no `button_map` at all, because a heartbeat for a Gate row carries
 * neither a button map nor a config block.
 * </p>
 */
export function gateFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "99999999-9999-9999-9999-999999999999",
    device_code: "gate-0a1b2c",
    name: "Door gate",
    kind: "Gate",
    hardware: "Esp32",
    court_numbers: [],
    // Null by default: a gate self-registers with no key, so "unnamed" is the state every
    // door is actually in when an admin first opens this screen.
    gate_key: null,
    mac_address: "5ccf7f0a1b2c",
    enabled: true,
    last_seen_at: new Date().toISOString(),
    last_ip_address: "192.168.68.160",
    running_version: "1.0.0",
    mega_version: null,
    auto_registered: false,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * One device row, patched the way `DeviceRegistryService.UpdateAsync` patches it.
 *
 * <p>
 * <b>`gate_key` is the field this exists for.</b> The API's rule is
 * <code>if (cmd.GateKey is not null) device.GateKey = cmd.GateKey.Length == 0 ? null : cmd.GateKey</code>
 * — so an ABSENT key and a `null` key both mean "leave the door's name alone", and `""` is
 * the only value that clears it. The frontend sent `null` to clear a name, which is a
 * silent no-op, and two tests were green over it for one reason: both pinned the wire text
 * against a server that answered with a cleared row whatever it was sent. A mock that
 * accepts anything pins nothing.
 * </p>
 *
 * <p>
 * `name`, `enabled`, `court_numbers` and `button_map` are patched on their own contracts —
 * `button_map` genuinely IS three-valued (absent leaves it, `null` reverts to the club's),
 * which is the neighbouring field whose semantics the gate key was wrongly assumed to
 * share.
 * </p>
 */
export function applyDevicePatch(
  row: Record<string, unknown>, patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...row };
  // `device.Name = cmd.Name.Trim()`. Trimmed on the API as well as by the editor, so a name
  // pasted with a trailing space is stored without one.
  if (typeof patch.name === "string") next.name = patch.name.trim();
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  if (Array.isArray(patch.court_numbers)) next.court_numbers = patch.court_numbers;
  if ("button_map" in patch) next.button_map = patch.button_map;
  // The whole point: null is not a clear, it is an absence. Only a string is applied.
  if (typeof patch.gate_key === "string") {
    const trimmed = patch.gate_key.trim();
    next.gate_key = trimmed === "" ? null : trimmed;
  }
  // `UpdateAsync` sets this unconditionally — not guarded by which field changed, and not
  // guarded by anything changing at all. The badge it drives says "nobody has checked this
  // row yet", and an admin who has PATCHed it has checked it. A mock that left the flag
  // alone would let a page test assert a badge the real API had already cleared.
  next.auto_registered = false;
  return next;
}

/**
 * What the API would refuse this PATCH with, or null when it would take it.
 *
 * <p>
 * <b>A mock that only applies the rules is still a server that says yes.</b>
 * {@link applyDevicePatch} was written to catch the `gate_key` no-op and did; it also
 * accepted a door name on a court box, court fields on a gate, and a name of any length —
 * so a page test written on it proved the screen handles a success the real API never
 * sends. That is the gate-key failure one field along.
 * </p>
 *
 * <p>
 * Mirrored from <code>AdminDeviceEndpoints.KindFieldsRefusal</code>, <b>including the
 * order</b>: the kind refusals are answered before the length bound and before the button
 * map is parsed at all, so a request carrying both a court field and an over-long name is
 * refused for the field that does not belong.
 * </p>
 *
 * <p>
 * `gate_key` present-as-null is an ABSENCE, not a value — the API binds it as a nullable
 * string and asks <code>req.GateKey is null</code>, which reads a JSON null and an omitted
 * key identically. `button_map` present-as-null is a VALUE, because it binds as a
 * `JsonElement` and the API asks <code>ValueKind != Undefined</code>. The two fields look
 * alike on the wire and do not behave alike, which is the confusion this whole area keeps
 * producing.
 * </p>
 */
export function refuseDevicePatch(
  row: Record<string, unknown>, patch: Record<string, unknown>,
): StubRefusal | null {
  const sentGateKey = patch.gate_key !== undefined && patch.gate_key !== null;
  if (row.kind !== "Gate") {
    return sentGateKey ? refuse(400, { error: "gate_key_not_a_gate" }) : null;
  }
  if (patch.court_numbers != null || "button_map" in patch) {
    return refuse(400, { error: "court_fields_on_a_gate" });
  }
  // Bounded here rather than truncated at the column, and measured after the trim, because
  // a door whose name is silently shortened is a door nobody can find in the audit trail.
  if (sentGateKey && String(patch.gate_key).trim().length > GATE_KEY_MAX_LENGTH) {
    return refuse(400, { error: "gate_key_too_long", max_length: GATE_KEY_MAX_LENGTH });
  }
  return null;
}

/**
 * One row of a board's trail, as `GET /admin/devices/{id}/activity` serves one.
 *
 * <p>
 * Defaults to the commonest row there is — a door that opened for a member it resolved —
 * so a test that wants a refusal, an offline upload or an unknown code asks for it and the
 * ask is the point of the test. `fingerprint` is present even on a resolved row, because
 * the API sends both and the panel's rule (the member wins) is only testable when it does.
 * </p>
 */
export function activityFixture(overrides: Record<string, unknown> = {}) {
  return {
    at: new Date().toISOString(),
    action: "gate.opened",
    reason: "ok",
    offline: false,
    member: { id: "44444444-4444-4444-4444-444444444444", name: "Ada Lovelace" },
    fingerprint: "1f2e3d4c",
    ...overrides,
  };
}

/** A device server's routes plus a window onto the row it is holding. */
export type DeviceServer = {
  routes: StubRoute[];
  /** The row as the server now holds it — what a real GET would serve next. */
  current: () => Record<string, unknown>;
  /**
   * Swaps what the activity route serves, so one test can drive a panel from empty to
   * populated without re-stubbing the whole server.
   */
  setActivity: (next: Record<string, unknown>[]) => void;
  /**
   * Swaps the row the server is holding, without going through a PATCH.
   *
   * <p>
   * For the one thing a PATCH cannot do: change a row's KIND. The API has no member for it
   * and never has — the reset is to delete the row and let the board register itself again,
   * which is also the only legitimate way a screen with an open form meets
   * `gate_key_not_a_gate` or `court_fields_on_a_gate`. Without this those two refusals are
   * decodable and untestable, which is how copy for them rots.
   * </p>
   */
  replace: (next: Record<string, unknown>) => void;
};

/**
 * A stateful stand-in for the devices API: one row, a list that serves it and a PATCH that
 * applies {@link applyDevicePatch} to it.
 *
 * <p>
 * The reload after a save then shows what a real one would, so a PATCH the API would
 * ignore leaves the row unchanged on screen instead of being reported as a success. That
 * is the difference between a test that pins a wire value and a test that pins an
 * OUTCOME — and the wire value the two gate-key tests pinned was the wrong one.
 * </p>
 */
export function deviceServer(
  initial: Record<string, unknown>,
  initialActivity: Record<string, unknown>[] = [],
): DeviceServer {
  let row = { ...initial };
  let activity = [...initialActivity];
  return {
    routes: [
      {
        // One GET route for both reads, dispatching on the path — not two routes.
        //
        // `/api/v1/admin/devices/{id}/activity` starts with `/api/v1/admin/devices/`, so a
        // second route would have to spell the row's id to out-length the list route under
        // the stub's longest-prefix rule, and `replace` can change that id underneath it.
        // A route that matched the list path and answered the list for an activity request
        // would hand the panel an ARRAY where it expects `{items}` — a page that renders
        // nothing, from a stub that returned 200.
        //
        // Tenant-blind and device-blind by design: this stands in for one club's one
        // board. A new device simply has an empty list, which is the real API's answer too.
        path: "/api/v1/admin/devices/",
        respond: (request) => (request.path.includes("/activity") ? { items: activity } : [row]),
      },
      {
        method: "PATCH",
        path: "/api/v1/admin/devices/",
        respond: (request) => {
          const patch = (request.body ?? {}) as Record<string, unknown>;
          // Refuse first and apply nothing: the API answers its refusals before it touches
          // the row, so a half-applied patch behind a 400 is a failure mode it does not have.
          const refusal = refuseDevicePatch(row, patch);
          if (refusal) return refusal;
          row = applyDevicePatch(row, patch);
          return row;
        },
      },
    ],
    current: () => row,
    replace: (next) => { row = { ...next }; },
    setActivity: (next) => { activity = [...next]; },
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

// ---------------------------------------------------------------------------------------
// doors: admin
//
// A stateful stand-in for the doors API, appended as one block. It applies the API's own
// rules rather than answering canned bodies, for the reason `deviceServer` exists: a mock
// that accepts anything pins nothing, and the two gate-key tests that shipped a PATCH the
// API discards were green against exactly such a mock.
// ---------------------------------------------------------------------------------------

/** A gate carrying W1.4's door-card fields, as `GET /admin/doors` serves one. */
export function doorFixture(overrides: Record<string, unknown> = {}) {
  return {
    ...gateFixture(),
    id: "99999999-9999-9999-9999-999999999999",
    // Named by default, because the doors surface is mostly about doors somebody has named
    // and the unnamed state is the interesting one a test asks for.
    gate_key: "side-door",
    name: "Side door",
    location_note: null,
    power_loss_behaviour: "not_established",
    out_of_service_since: null,
    ...overrides,
  };
}

/** One club-log row: an activity entry plus the door it happened at. */
export function doorLogFixture(overrides: Record<string, unknown> = {}) {
  return {
    ...activityFixture(),
    door: { id: "99999999-9999-9999-9999-999999999999", name: "Side door", gate_key: "side-door" },
    ...overrides,
  };
}

/** What `GET /admin/doors` says about one door beyond the device row itself. */
export type DoorsServerRow = {
  today?: { released: number; refused: number } | null;
  signals?: { kind: string; since: string; until: string; scans: number }[];
};

export type DoorsServer = {
  routes: StubRoute[];
  /** The rows as the server now holds them — what a real GET would serve next. */
  current: () => Record<string, unknown>[];
  setActivity: (next: Record<string, unknown>[]) => void;
  /** Swaps one door's counts and signals without going through a write. */
  setRow: (id: string, row: DoorsServerRow) => void;
};

/**
 * Which outcome bucket a log row falls in. Mirrors the API's own `outcome` parameter, whose
 * three values are the only ones the filter offers.
 */
function doorOutcomeOf(entry: Record<string, unknown>): string[] {
  const action = String(entry.action ?? "");
  const buckets: string[] = [];
  if (action === "gate.opened" || action === "device.gate_open") buckets.push("released");
  if (action.startsWith("gate.denied") || action === "device.unknown_scan") buckets.push("refused");
  if (entry.offline === true) buckets.push("offline");
  return buckets;
}

/**
 * A stand-in for the doors API: the overview, the club log with its cursor, the CSV, the two
 * fleet writes and the devices PATCH that owns a door's fields.
 *
 * <p>
 * <b>The fleet semantics are the reason this is stateful.</b> `shut-all` is one unit of work
 * over every gate and stamps `shut_by_shut_all_at`; `reopen-all` reopens ONLY the doors that
 * stamp names, so a door an admin shut on its own stays shut. A canned `{doors: [...]}` body
 * would let a page claim either behaviour and stay green.
 * </p>
 */
export function doorsServer(
  initial: Record<string, unknown>[],
  options: {
    activity?: Record<string, unknown>[];
    rows?: Record<string, DoorsServerRow>;
    retentionDays?: number;
    timezone?: string;
    dayStartedAt?: string;
    /** The page size the cursor pages at, so a test can produce a second page from four rows. */
    pageSize?: number;
  } = {},
): DoorsServer {
  let doors = initial.map((d) => ({ ...d }));
  let activity = [...(options.activity ?? [])];
  const rows: Record<string, DoorsServerRow> = { ...(options.rows ?? {}) };
  const retentionDays = options.retentionDays ?? 90;
  const pageSize = options.pageSize ?? 50;
  const shutByFleet = new Set<string>();

  const view = () => ({
    day_started_at: options.dayStartedAt ?? new Date(new Date().setHours(0, 0, 0, 0)).toISOString(),
    timezone: options.timezone ?? "Africa/Johannesburg",
    shut_all_active: doors.some((d) => d.enabled === false && shutByFleet.has(String(d.id))),
    doors: [...doors]
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map((device) => ({
        device,
        // `?? ` would turn an EXPLICIT null — the count failed — back into a zero, which
        // is the very defect the page's copy exists to avoid. Absent means "not
        // interesting to this test"; null means "the server could not count".
        today: "today" in (rows[String(device.id)] ?? {})
          ? rows[String(device.id)].today
          : { released: 0, refused: 0 },
        signals: rows[String(device.id)]?.signals ?? [],
      })),
  });

  /** One fleet write, applied to every gate the club has. */
  const fleet = (enabled: boolean) => {
    const at = new Date().toISOString();
    doors = doors.map((d) => {
      if (enabled) {
        if (!shutByFleet.has(String(d.id))) return d;
        shutByFleet.delete(String(d.id));
        return { ...d, enabled: true, out_of_service_since: null };
      }
      if (d.enabled === false) return d;
      shutByFleet.add(String(d.id));
      return { ...d, enabled: false, out_of_service_since: at };
    });
    return {
      doors: doors.map((d) => ({
        id: d.id, name: d.name, gate_key: d.gate_key, enabled: d.enabled,
        last_seen_at: d.last_seen_at,
        offline_after_seconds: d.offline_after_seconds ?? 180,
        power_loss_behaviour: d.power_loss_behaviour ?? "not_established",
      })),
    };
  };

  const logPage = (path: string) => {
    const query = new URLSearchParams(path.split("?")[1] ?? "");
    const door = query.get("door");
    const outcome = query.get("outcome");
    const from = query.get("from");
    const to = query.get("to");
    // The retention clamp the API applies, so a page that states a range states a real one.
    const floor = Date.now() - retentionDays * 86_400_000;
    const matched = activity.filter((e) => {
      const at = new Date(String(e.at)).getTime();
      const entryDoor = (e.door ?? {}) as Record<string, unknown>;
      if (door && String(entryDoor.id) !== door) return false;
      if (outcome && !doorOutcomeOf(e).includes(outcome)) return false;
      if (from && at < Math.max(new Date(from).getTime(), floor)) return false;
      if (to && at > new Date(to).getTime()) return false;
      return at >= floor;
    });
    const start = Number(query.get("cursor") ?? 0);
    const items = matched.slice(start, start + pageSize);
    const next = start + pageSize;
    return {
      items,
      next_cursor: next < matched.length ? String(next) : null,
      retention_days: retentionDays,
    };
  };

  return {
    routes: [
      // Longest prefix wins in this stub, so `.csv` out-lengths `activity`, which out-lengths
      // the collection. Declaration order is irrelevant and deliberately not relied on.
      {
        path: "/api/v1/admin/doors/activity.csv",
        headers: { "content-disposition": 'attachment; filename="door-log.csv"' },
        body: "at,door,door_name,outcome,reason,offline,member,fingerprint\n",
      },
      { path: "/api/v1/admin/doors/activity", respond: (r) => logPage(r.path) },
      { path: "/api/v1/admin/doors", respond: () => view() },
      { method: "POST", path: "/api/v1/admin/doors/shut-all", respond: () => fleet(false) },
      { method: "POST", path: "/api/v1/admin/doors/reopen-all", respond: () => fleet(true) },
      {
        // The B5 per-device feed the door detail page reads, and the device list beneath it.
        path: "/api/v1/admin/devices/",
        respond: (request) => {
          if (!request.path.includes("/activity")) return doors;
          const id = request.path.split("/api/v1/admin/devices/")[1].split("/")[0];
          return { items: activity.filter((e) => ((e.door ?? {}) as Record<string, unknown>).id === undefined
            || ((e.door ?? {}) as Record<string, unknown>).id === id) };
        },
      },
      {
        method: "PATCH",
        path: "/api/v1/admin/devices/",
        respond: (request) => {
          const patch = (request.body ?? {}) as Record<string, unknown>;
          const id = request.path.split("/api/v1/admin/devices/")[1];
          const index = doors.findIndex((d) => String(d.id) === id);
          if (index < 0) return refuse(404, { error: "not_found" });
          const refusal = refuseDoorPatch(doors[index], patch);
          if (refusal) return refusal;
          doors[index] = applyDoorPatch(doors[index], patch);
          // An individual shut is NOT a fleet shut, so reopen-all must leave it alone.
          if (patch.enabled === false) shutByFleet.delete(id);
          return doors[index];
        },
      },
    ],
    current: () => doors,
    setActivity: (next) => { activity = [...next]; },
    setRow: (id, row) => { rows[id] = row; },
  };
}

/** The API's bound on `location_note` — mirrored here so the mock refuses what the API refuses. */
export const LOCATION_NOTE_MAX_LENGTH = 200;

/**
 * What the API would refuse a door PATCH with, or null.
 *
 * The door-card fields are gates-only: the API answers `door_fields_on_a_court_box` for
 * either of them on a CourtBox row, and a mock that accepted them would let a page prove it
 * handles a success the server never sends.
 */
export function refuseDoorPatch(
  row: Record<string, unknown>, patch: Record<string, unknown>,
): StubRefusal | null {
  const touchesDoorFields = patch.location_note !== undefined || patch.power_loss_behaviour !== undefined;
  if (row.kind !== "Gate") {
    return touchesDoorFields ? refuse(400, { error: "door_fields_on_a_court_box" }) : refuseDevicePatch(row, patch);
  }
  if (typeof patch.location_note === "string" && patch.location_note.trim().length > LOCATION_NOTE_MAX_LENGTH) {
    return refuse(400, { error: "location_note_too_long", max_length: LOCATION_NOTE_MAX_LENGTH });
  }
  if (patch.power_loss_behaviour !== undefined
    && !["not_established", "released", "locked"].includes(String(patch.power_loss_behaviour))) {
    return refuse(400, { error: "power_loss_behaviour_unknown" });
  }
  return refuseDevicePatch(row, patch);
}

/**
 * One door row, patched the way the API patches it.
 *
 * `location_note` binds two-valued exactly as `gate_key` does — `""` clears, absent leaves
 * alone, and there is no `null` clear. That is the field's whole trap, one field along from
 * the one that produced it.
 */
export function applyDoorPatch(
  row: Record<string, unknown>, patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = applyDevicePatch(row, patch);
  if (typeof patch.location_note === "string") {
    const trimmed = patch.location_note.trim();
    next.location_note = trimmed === "" ? null : trimmed;
  }
  if (typeof patch.power_loss_behaviour === "string") next.power_loss_behaviour = patch.power_loss_behaviour;
  // `UpdateAsync` stamps the transition; the standing notice reads it.
  if (patch.enabled === false && row.enabled !== false) next.out_of_service_since = new Date().toISOString();
  if (patch.enabled === true) next.out_of_service_since = null;
  return next;
}

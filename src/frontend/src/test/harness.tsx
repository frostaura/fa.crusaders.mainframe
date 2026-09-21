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
// The nine scan actions, from the one place they are written down (WIRE-R1 §3).
import { DOOR_SCAN_ACTIONS } from "../lib/deviceActivity";

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

/** Everything one doors server is holding, so its three jobs can be functions rather than closures. */
type DoorsState = {
  doors: Record<string, unknown>[];
  activity: Record<string, unknown>[];
  rows: Record<string, DoorsServerRow>;
  retentionDays: number;
  pageSize: number;
  timezone: string;
  dayStartedAt: string;
  /** Deleted doors with rows still inside retention (WIRE-R2 §1). */
  removedDoors: { key: string; name?: string | null; gate_key?: string | null }[];
  /** Which doors a shut-all shut, which is what makes reopen-all selective. */
  shutByFleet: Set<string>;
};

/**
 * How far this zone is from UTC at this instant, milliseconds.
 *
 * The club's midnight is the SERVER's to compute (WIRE-R2 §3) and the mock has to compute it
 * the same way, or a page that states a resolved range states one the API would never send.
 */
function zoneOffsetMs(at: number, timeZone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  );
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** Club-local midnight of the day containing `at`, as an instant. */
function clubMidnight(at: number, timeZone: string): number {
  const offset = zoneOffsetMs(at, timeZone);
  const local = at + offset;
  return local - (local % 86_400_000) - offset;
}

const DAY_MS = 86_400_000;

/**
 * The resolved range for one query, or the API's own refusal (WIRE-R2 §3).
 *
 * <p>
 * A4: "Last 24 hours" is rolling and the page had no way to ask for yesterday or for one
 * day, so a chair exporting "yesterday" was handed half of yesterday and half of today.
 * `period` and `day` are resolved HERE, in the club's zone, because a browser's midnight is
 * a different instant for any admin travelling or with a wrong device clock.
 * </p>
 */
function resolveLogRange(
  query: URLSearchParams, state: DoorsState,
): { from: number; to: number } | StubRefusal {
  const period = query.get("period");
  const day = query.get("day");
  const from = query.get("from");
  const to = query.get("to");
  const given = [period !== null, day !== null, from !== null || to !== null].filter(Boolean).length;
  if (given > 1) return refuse(400, { error: "range_conflict" });
  const now = Date.now();
  if (day !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return refuse(400, { error: "day_invalid" });
    const start = clubMidnight(new Date(`${day}T12:00:00Z`).getTime(), state.timezone);
    return { from: start, to: Math.min(start + DAY_MS, now) };
  }
  if (period !== null) return resolvePeriod(period, now, state);
  return { from: from ? new Date(from).getTime() : now - DAY_MS, to: to ? new Date(to).getTime() : now };
}

function resolvePeriod(
  period: string, now: number, state: DoorsState,
): { from: number; to: number } | StubRefusal {
  const midnight = clubMidnight(now, state.timezone);
  if (period === "today") return { from: midnight, to: now };
  if (period === "yesterday") return { from: clubMidnight(midnight - 1, state.timezone), to: midnight };
  if (period === "last_24h") return { from: now - DAY_MS, to: now };
  if (period === "last_7d") return { from: now - 7 * DAY_MS, to: now };
  if (period === "last_30d") return { from: now - 30 * DAY_MS, to: now };
  return refuse(400, { error: "period_invalid" });
}

/** `GET /admin/doors`. */
function doorsView(state: DoorsState) {
  return {
    day_started_at: state.dayStartedAt,
    timezone: state.timezone,
    shut_all_active: state.doors.some((d) => d.enabled === false && state.shutByFleet.has(String(d.id))),
    // WIRE-R1 §4. NAMED, not counted: `reopen-all` reopens only what a shut-all shut, and
    // the fleet control has to be able to say which doors those are before it is pressed.
    shut_together: state.doors
      .filter((d) => d.enabled === false && state.shutByFleet.has(String(d.id)))
      .map((d) => ({ id: d.id, name: d.name, gate_key: d.gate_key })),
    shut_individually: state.doors
      .filter((d) => d.enabled === false && !state.shutByFleet.has(String(d.id)))
      .map((d) => ({ id: d.id, name: d.name, gate_key: d.gate_key })),
    doors: [...state.doors]
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map((device) => ({
        device,
        // `?? ` would turn an EXPLICIT null — the count failed — back into a zero, which is
        // the very defect the page's copy exists to avoid. Absent means "not interesting to
        // this test"; null means "the server could not count".
        today: "today" in (state.rows[String(device.id)] ?? {})
          ? state.rows[String(device.id)].today
          : { released: 0, refused: 0 },
        signals: state.rows[String(device.id)]?.signals ?? [],
      })),
  };
}

/**
 * `POST /admin/doors/shut-all` and `/reopen-all` — one unit of work over every gate.
 *
 * <b>reopen-all reopens only what a shut-all shut.</b> A door an admin shut on its own stays
 * shut, or the club-wide control quietly undoes an individual decision — which is a rule a
 * canned `{doors: [...]}` body could never hold a page to.
 */
function applyFleet(state: DoorsState, enabled: boolean) {
  const at = new Date().toISOString();
  // Captured BEFORE the map below empties the set, so a reopen can report what it touched.
  const touched = new Set(enabled ? [...state.shutByFleet] : []);
  state.doors = state.doors.map((d) => {
    if (enabled) {
      if (!state.shutByFleet.has(String(d.id))) return d;
      state.shutByFleet.delete(String(d.id));
      return { ...d, enabled: true, out_of_service_since: null };
    }
    if (d.enabled === false) return d;
    state.shutByFleet.add(String(d.id));
    return { ...d, enabled: false, out_of_service_since: at };
  });
  return {
    // Only the doors this request actually changed. A reopen-all that reopened nothing
    // answers `{doors: []}` — the shape C1's "0 doors reopened" came from, and the page has
    // to go on being right about it.
    doors: state.doors
      .filter((d) => (enabled ? touched.has(String(d.id)) : d.enabled === false))
      .map((d) => ({
        id: d.id, name: d.name, gate_key: d.gate_key, enabled: d.enabled,
        last_seen_at: d.last_seen_at,
        offline_after_seconds: d.offline_after_seconds ?? 180,
        power_loss_behaviour: d.power_loss_behaviour ?? "not_established",
      })),
    // WIRE-R1 §5: ALWAYS present. A zero-change result that names nothing is exactly the
    // dead end the ruling closes.
    left_shut: state.doors
      .filter((d) => d.enabled === false && !state.shutByFleet.has(String(d.id)))
      .map((d) => ({ id: d.id, name: d.name, gate_key: d.gate_key })),
  };
}

/** Whether one log row survives the filters in this query string. */
function matchesLogFilters(
  entry: Record<string, unknown>, query: URLSearchParams, floor: number,
  range: { from: number; to: number },
): boolean {
  const at = new Date(String(entry.at)).getTime();
  const entryDoor = (entry.door ?? {}) as Record<string, unknown>;
  const door = query.get("door");
  // WIRE-R2 §1: a deleted board has no id, so its rows are reached by the key the row stored.
  const removedDoor = query.get("removed_door");
  const outcome = query.get("outcome");
  if (door && String(entryDoor.id) !== door) return false;
  if (removedDoor && String(entryDoor.gate_key ?? entryDoor.name ?? "") !== removedDoor) return false;
  if (outcome && !doorOutcomeOf(entry).includes(outcome)) return false;
  // The API narrows by reason too, and this stub did not — so a page filtering to "Too early"
  // was handed every row and could claim any behaviour it liked about the result.
  const reason = query.get("reason");
  if (reason && String(entry.reason ?? "") !== reason) return false;
  // The retention clamp the API applies, so a page that states a range states a real one.
  if (at < Math.max(range.from, floor)) return false;
  return at <= range.to;
}

/** `GET /admin/doors/activity`, cursor-paged. */
function doorsLogPage(state: DoorsState, path: string) {
  const query = new URLSearchParams(path.split("?")[1] ?? "");
  const resolved = resolveLogRange(query, state);
  if (!("from" in resolved)) return resolved;
  const range = resolved;
  const floor = Date.now() - state.retentionDays * DAY_MS;
  const matched = state.activity.filter((entry) => matchesLogFilters(entry, query, floor, range));
  const start = Number(query.get("cursor") ?? 0);
  const next = start + state.pageSize;
  return {
    items: matched.slice(start, next),
    // `matched.length > next` rather than `next < matched.length`: a bare `<` in a .tsx file
    // is read as the start of a JSX tag by lizard's lexer, which then swallows every
    // function below it into one. See the note inside `stubFetch`.
    next_cursor: matched.length > next ? String(next) : null,
    retention_days: state.retentionDays,
    // WIRE-R2 §3. A6: the heading read "50 scans, newest first" over a 70-row range, which
    // is the number an admin quotes to a committee.
    total: matched.length,
    timezone: state.timezone,
    range: {
      from: new Date(Math.max(range.from, floor)).toISOString(),
      to: new Date(range.to).toISOString(),
    },
    removed_doors: state.removedDoors,
  };
}

/**
 * The B5 per-device feed, and the device list beneath it.
 *
 * <p>
 * <b>It answers `{items, events}`, because the API does (WIRE-R1 §1).</b> The two used to be
 * one array, and that is the whole of B1: a `device.updated` row arrived among the scans and
 * the feed painted it as a green "Refused". A mock that goes on merging them is a mock that
 * cannot fail for the reason production failed — so it splits them here by the same rule the
 * screen uses, and the events it emits carry the real `{at, action, kind}`, with NO actor
 * and the five real kinds.
 * </p>
 */
function doorsDeviceRoute(state: DoorsState, path: string) {
  if (!path.includes("/activity")) return state.doors;
  const id = path.split("/api/v1/admin/devices/")[1].split("/")[0];
  const mine = state.activity.filter((e) => {
    const door = (e.door ?? {}) as Record<string, unknown>;
    return door.id === undefined || door.id === id;
  });
  const isScan = (e: Record<string, unknown>) =>
    (DOOR_SCAN_ACTIONS as readonly string[]).includes(String(e.action));
  return {
    items: mine.filter(isScan),
    // WIRE-R2 §2: `kind` stays for compatibility and `change` is what the screen renders
    // from. A5: nine identical "details or state were changed" rows told an admin nothing,
    // and the card said "You shut this door" to four admins who had not.
    events: mine.filter((e) => !isScan(e)).map((e) => ({
      at: e.at,
      action: e.action,
      kind: doorEventKindOf(String(e.action)),
      change: e.change ?? doorEventChangeOf(String(e.action)),
      actor_name: e.actor_name ?? null,
    })),
  };
}

/** `device.updated` → `edited`, and so on. Mirrors the backend's own map (WIRE-R1 §3). */
const DOOR_EVENT_KINDS: Record<string, string> = {
  "device.auto_registered": "registered",
  "device.registered": "registered",
  "device.updated": "edited",
  "device.deleted": "removed",
  "device.event_time_clamped": "clock_corrected",
};

function doorEventKindOf(action: string): string {
  return DOOR_EVENT_KINDS[action] ?? "unrecognised";
}

/**
 * WIRE-R2 §2's `change`, as the server derives it from the audit details.
 *
 * `device.updated` lands on `other` here unless the fixture says which of the four it was —
 * which is exactly the old-row case the copy has to stay honest about.
 */
const DOOR_EVENT_CHANGE_BY_ACTION: Record<string, string> = {
  "device.auto_registered": "registered",
  "device.registered": "registered",
  "device.deleted": "removed",
  "device.event_time_clamped": "clock_corrected",
  "doors.shut_all": "shut_all",
  "doors.reopened_all": "reopened_all",
};

function doorEventChangeOf(action: string): string {
  return DOOR_EVENT_CHANGE_BY_ACTION[action] ?? "other";
}

/** The devices PATCH, applying and refusing what the API applies and refuses. */
function doorsPatchRoute(state: DoorsState, path: string, body: unknown) {
  const patch = (body ?? {}) as Record<string, unknown>;
  const id = path.split("/api/v1/admin/devices/")[1];
  const index = state.doors.findIndex((d) => String(d.id) === id);
  if (index < 0) return refuse(404, { error: "not_found" });
  const refusal = refuseDoorPatch(state.doors[index], patch);
  if (refusal) return refusal;
  const before = state.doors[index];
  // B10 / WIRE-R2 §2: a PATCH that changes nothing answers 200 `unchanged: true` with the
  // CURRENT shut facts. A stale tab "shut" an already-shut door and was told it had worked.
  if (patch.enabled !== undefined && patch.enabled === before.enabled) {
    return { ...before, unchanged: true };
  }
  state.doors[index] = applyDoorPatch(before, patch);
  // An individual shut is NOT a fleet shut, so reopen-all must leave it alone.
  if (patch.enabled === false) state.shutByFleet.delete(id);
  return state.doors[index];
}

/**
 * A stand-in for the doors API: the overview, the club log with its cursor, the CSV, the two
 * fleet writes and the devices PATCH that owns a door's fields.
 *
 * <p>
 * <b>The fleet semantics are the reason this is stateful.</b> `shut-all` is one unit of work
 * over every gate and records which doors it shut; `reopen-all` reopens only those. A canned
 * `{doors: [...]}` body would let a page claim either behaviour and stay green.
 * </p>
 *
 * <p>
 * Its jobs are module-level functions over one state object rather than closures, because
 * lizard scores a closure's complexity into the function that holds it and this one was over
 * the gate as a result.
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
    /** Deleted doors that still have rows in range (WIRE-R2 §1), for the picker's own group. */
    removedDoors?: { key: string; name?: string | null; gate_key?: string | null }[];
  } = {},
): DoorsServer {
  // Defaults as one object rather than seven `??`s: each of those is a branch lizard counts,
  // and this constructor was over the complexity gate on nothing but its own defaults.
  const state: DoorsState = {
    activity: [],
    rows: {},
    retentionDays: 90,
    pageSize: 50,
    timezone: "Africa/Johannesburg",
    dayStartedAt: new Date(new Date().setHours(0, 0, 0, 0)).toISOString(),
    removedDoors: [],
    ...options,
    doors: initial.map((d) => ({ ...d })),
    // Seeded from the fixture's own `shut_by_shut_all_at`, so a test can start from a club
    // that is ALREADY under a shut-all without driving the button. The two spellings are
    // one fact — `shut_together` is derived from this set — and a fixture that set the
    // field while the set stayed empty would describe a club whose own records disagree.
    shutByFleet: new Set<string>(
      initial.filter((d) => d.shut_by_shut_all_at != null).map((d) => String(d.id)),
    ),
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
      { path: "/api/v1/admin/doors/activity", respond: (r) => doorsLogPage(state, r.path) },
      { path: "/api/v1/admin/doors", respond: () => doorsView(state) },
      { method: "POST", path: "/api/v1/admin/doors/shut-all", respond: () => applyFleet(state, false) },
      { method: "POST", path: "/api/v1/admin/doors/reopen-all", respond: () => applyFleet(state, true) },
      { path: "/api/v1/admin/devices/", respond: (r) => doorsDeviceRoute(state, r.path) },
      {
        method: "PATCH",
        path: "/api/v1/admin/devices/",
        respond: (r) => doorsPatchRoute(state, r.path, r.body),
      },
    ],
    current: () => state.doors,
    setActivity: (next) => { state.activity = [...next]; },
    setRow: (id, row) => { state.rows[id] = row; },
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
  if (patch.enabled === false && row.enabled !== false) {
    next.out_of_service_since = new Date().toISOString();
    // A5 / WIRE-R2 §2: WHO, not "you". The card said "You shut this door." to every admin in
    // the club, which is false for all but one of them and unfalsifiable for the reader.
    next.shut_by_name = row.shut_by_name ?? ACTING_ADMIN_NAME;
  }
  if (patch.enabled === true) {
    next.out_of_service_since = null;
    next.shut_by_name = null;
  }
  return next;
}

/** The admin this stub acts as, so a shut can be attributed to a name rather than to "you". */
export const ACTING_ADMIN_NAME = "Priya Naidoo";

// --- doors: member ---------------------------------------------------------------

/**
 * `GET /api/v1/me/door`, as the wave-1 wire shape defines it.
 *
 * <p>
 * The default is the SILENT club: `doors: false`, because a club with no gate is the
 * state most of the product is in and the one the page must say nothing whatever about.
 * A test that wants a door asks for one, which is what makes every doors assertion prove
 * something. The same reasoning as {@link gateFixture}'s null `gate_key`.
 * </p>
 *
 * <p>
 * `contact` is populated by default: the club's number is the one thing on this surface
 * that is always meant to be reachable, so its ABSENCE is the interesting case and a
 * test that wants it passes nulls.
 * </p>
 */
export function memberDoorFixture(overrides: Record<string, unknown> = {}) {
  return {
    doors: false,
    policy: "active_member",
    membership: "active",
    // The same fact at the resolution that says WHICH not-active it is. The two move
    // together in reality, so a fixture that overrides one and not the other is
    // describing a club whose own records disagree — see `memberDoorNotActiveFixture`.
    membership_detail: "active",
    is_club_admin: false,
    next_booking: null,
    // `gate_early_entry_minutes`' own default, clamped server-side to 0..240.
    early_entry_minutes: 30,
    // `DeviceGateRosterBuilder.GateRosterMaxEntries`, which the firmware shares.
    roster_max_entries: 48,
    contact: { phone: "021 555 0134", email: "info@crusaders.co.za" },
    // `DoorSettings.DefaultLogRetentionDays`.
    door_log_retention_days: 90,
    last_decision: null,
    ...overrides,
  };
}

/**
 * A membership the club has as not active, with both halves of the fact in step.
 *
 * <p>
 * Spelling the pair out at every call site is how one of them ends up saying `active`
 * under a `not_active` — a club whose own records contradict each other, which is a state
 * the endpoint cannot produce and a fixture that proves nothing about the page.
 * </p>
 */
export function memberDoorNotActiveFixture(
  detail: "pending_approval" | "rejected" | "suspended",
  overrides: Record<string, unknown> = {},
) {
  return memberDoorsOnFixture({ membership: "not_active", membership_detail: detail, ...overrides });
}

/**
 * The booking the endpoint sends, with every field on it.
 *
 * <p>
 * Both edges of the door window are always present — `NextBookingAsync` computes them from
 * `BookingCodeWindow` on every booking it returns — so a fixture omitting one is testing a
 * response shape the API cannot emit. `court_number` is the one genuinely nullable half.
 * </p>
 */
export function memberDoorBookingFixture(overrides: Record<string, unknown> = {}) {
  return {
    starts_at: "2026-09-19T17:00:00Z",
    ends_at: "2026-09-19T17:45:00Z",
    court_number: 3,
    door_opens_at: "2026-09-19T16:30:00Z",
    door_closes_at: "2026-09-19T18:05:00Z",
    ...overrides,
  };
}

/** The same club, with a door. The shorthand every doors test on this surface starts from. */
export function memberDoorsOnFixture(overrides: Record<string, unknown> = {}) {
  return memberDoorFixture({ doors: true, ...overrides });
}

/**
 * One `last_decision`, as the endpoint shapes it.
 *
 * <p>
 * A REFUSAL by default — `released: false`, `too_early` — because a decision the member
 * is looking at is nearly always one that went wrong; the open is the case they walk away
 * from. `door_name` is the club's own key, never a device id.
 * </p>
 */
export function memberDoorDecisionFixture(overrides: Record<string, unknown> = {}) {
  return {
    at: "2026-09-19T06:04:00Z",
    // Null unless the door decided it OFFLINE — a row the door asked the club about has
    // no delivery to state, and a fixture that carried one would let a page render a
    // journey the row never made. `memberDoorOfflineDecisionFixture` is the other arm.
    delivered_at: null,
    door_name: "front-door",
    released: false,
    reason: "too_early",
    // A door that could reach the club, which is the common case and the one where the
    // open arm says the shorter sentence.
    offline: false,
    // Null on every reason but `too_early`, and null there too when the booking behind the
    // refusal has since gone. A fixture that wants a countdown asks for one.
    opens_at: null,
    ...overrides,
  };
}

/**
 * A route the request never gets an answer out of — the wire shape of no signal.
 *
 * <p>
 * <b>A 500 is not what a phone with no bars looks like, and the page has to tell them
 * apart.</b> Every failed-read test on this surface used to stub a status and call the
 * result "the read failed", which is half the cases: one of them is a response that
 * arrived carrying an error, and the other is no response at all. The page told both
 * members "Your phone can't reach the club" and scored the phone's own diagnostic row ✗
 * over a 500 the club's own API had answered with.
 * </p>
 *
 * <p>
 * A `respond` that throws is what produces the real thing rather than an approximation of
 * it: the throw escapes the stubbed `fetch` synchronously, `fetchWithTimeout` catches it
 * exactly as it catches a dropped connection, and the page receives the same
 * `NetworkError` a phone in a lift would give it. Stubbing the error object directly
 * would prove only that the page can read a field somebody handed it.
 * </p>
 */
export function unreachable(path: string, method = "GET"): StubRoute {
  return {
    method,
    path,
    respond: () => { throw new TypeError("Failed to fetch"); },
  };
}

/**
 * A decision a CUT-OFF door made, with both instants on it.
 *
 * <p>
 * The pair moves together in reality — `delivered_at` is non-null exactly when `offline`
 * is true — so spelling them out at each call site is how one ends up with a row that
 * claims a delivery delay for a scan the door asked the club about at the time, which is
 * a shape the endpoint cannot produce. Five minutes late by default, which is long enough
 * to read as a gap and short enough to be an ordinary one.
 * </p>
 */
export function memberDoorOfflineDecisionFixture(overrides: Record<string, unknown> = {}) {
  return memberDoorDecisionFixture({
    released: true,
    reason: "ok",
    offline: true,
    delivered_at: "2026-09-19T06:09:00Z",
    ...overrides,
  });
}

/** The same pairing for a history row. See `memberDoorOfflineDecisionFixture`. */
export function memberDoorOfflineHistoryRowFixture(overrides: Record<string, unknown> = {}) {
  return memberDoorHistoryRowFixture({
    offline: true,
    delivered_at: "2026-09-19T06:09:00Z",
    ...overrides,
  });
}

/** One row of `GET /api/v1/me/door/history`. An open, from a door that could reach the club. */
export function memberDoorHistoryRowFixture(overrides: Record<string, unknown> = {}) {
  return {
    at: "2026-09-19T06:04:00Z",
    delivered_at: null,
    door_name: "front-door",
    released: true,
    reason: "ok",
    offline: false,
    ...overrides,
  };
}

// --- end doors: member -----------------------------------------------------------

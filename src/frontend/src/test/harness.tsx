import { render, type RenderOptions } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { ToastProvider } from "../components/Toast";

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
  status?: number;
  body: unknown;
  /**
   * Answers the nth matching call with the nth entry, the last one repeating — for a
   * screen that fetches the same thing twice and must show that it got two different
   * answers. When set, `body` is ignored.
   */
  sequence?: unknown[];
};

export type FetchStub = {
  /** Every call the component made, in order — for asserting what a save actually sent. */
  calls: { method: string; path: string; body: unknown }[];
};

export function stubFetch(routes: StubRoute[]): FetchStub {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const served = new Map<StubRoute, number>();

  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });

    // Longest prefix wins, not first-declared.
    //
    // "/api/v1/admin/devices/" is a prefix of "/api/v1/admin/devices/discovered", so
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

    return Promise.resolve({
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      text: () => Promise.resolve(JSON.stringify(answer)),
    } as unknown as Response);
  }));

  return { calls };
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <ToastProvider>{children}</ToastProvider>
    </MemoryRouter>
  );
}

export function renderPage(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return render(ui, { wrapper: Providers, ...options });
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
    key_version: 1,
    enabled: true,
    revoked_at: null,
    last_seen_at: new Date().toISOString(),
    last_ip_address: "192.168.68.150",
    running_version: "1.0.0",
    mega_version: "1.0.0",
    ota_channel: "Stable",
    pinned_version: null,
    failed_version: null,
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

export function boardFixture(overrides: Record<string, unknown> = {}) {
  return {
    mac: "5ccf7f1a2b3c",
    address: "192.168.68.151",
    hardware: "esp8266",
    firmware: "1.0.0",
    mega_version: null,
    claimed: false,
    claimable: true,
    signature_verified: null,
    device_id: null,
    tenant_slug: null,
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    ...overrides,
  };
}

export const DISCOVERY_LISTENING = {
  state: "Listening",
  listening: true,
  bound_endpoint: "0.0.0.0:48653",
  detail: null,
  packets_received: 12,
  packets_accepted: 12,
  packets_rejected: 0,
  last_packet_at: new Date().toISOString(),
  started_at: new Date().toISOString(),
  announcers: 1,
  capacity_reached: false,
  hint: null,
};

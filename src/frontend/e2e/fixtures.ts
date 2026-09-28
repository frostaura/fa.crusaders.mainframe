import { test as base, type Page } from "@playwright/test";

/**
 * The E2E fixtures.
 *
 * <p>
 * These specs run against the real built frontend — real routing, real React, real
 * CSS — with the API answered by route interception rather than by a live backend.
 * That is a deliberate split, and worth being explicit about what it buys and what
 * it does not.
 * </p>
 *
 * <p>
 * <b>What it proves:</b> that the screens compose, navigate, render the shapes the
 * API actually returns, and put the right numbers in front of a member. Those are
 * the failures that reach a person, and none of them are visible to a unit test.
 * </p>
 *
 * <p>
 * <b>What it does not prove:</b> anything about the server. The API's own behaviour is
 * held by the xUnit suite and its Postgres-backed boundary tier, and the box-facing chain
 * end to end by <code>test/e2e-device/scenario.py</code> against a real API and a real
 * database; running a migration and a seeded tenant per browser test would buy a slower
 * copy of what those already cover. (No count here on purpose — the one that used to be
 * stated was stale by four hundred tests.)
 * </p>
 *
 * <p>
 * The interception is <b>strict</b>: an unrecognised call fails the test rather than
 * being fulfilled with something plausible. A permissive stub hides exactly the
 * mistake worth catching — a screen calling an endpoint nobody meant it to.
 * </p>
 */

/**
 * `respond` answers from the REQUEST rather than from a canned body, and wins over `body`.
 *
 * <p>
 * A canned body pins nothing about what was sent. The Devices screen cleared a door's name
 * with a wire value the API treats as "leave it alone", and both the unit test and this spec
 * stayed green because each answered the PATCH with an already-cleared row whatever it was
 * handed. A route that applies the API's own rule makes the wrong value fail here for the
 * reason it fails in production.
 * </p>
 */
export type ApiRoute = {
  method?: string;
  path: string;
  status?: number;
  /** The canned answer. Optional only when `respond` supplies one instead. */
  body?: unknown;
  respond?: (request: { method: string; path: string; body: unknown }) => unknown;
};

export const SESSION_ADMIN = {
  tenant_slug: "crusaders",
  tenant_id: "00000000-0000-0000-0000-000000000001",
  user_id: "00000000-0000-0000-0000-000000000002",
  is_authenticated: true,
  is_admin: true,
};

export const SESSION_ANON = {
  tenant_slug: "crusaders",
  tenant_id: "00000000-0000-0000-0000-000000000001",
  user_id: null,
  is_authenticated: false,
  is_admin: false,
};

export async function serveApi(page: Page, routes: ApiRoute[]) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method().toUpperCase();

    // Longest prefix wins, so "/api/v1/admin/devices/" cannot swallow
    // "/api/v1/admin/devices/api-key" depending on declaration order.
    const match = routes
      .filter((r) => (r.method ?? "GET").toUpperCase() === method && url.pathname.startsWith(r.path))
      .sort((a, b) => b.path.length - a.path.length)[0];

    if (!match) {
      await route.fulfill({
        status: 501,
        contentType: "application/json",
        body: JSON.stringify({ error: `no route for ${method} ${url.pathname}` }),
      });
      return;
    }

    let body = match.body;
    if (match.respond) {
      const raw = route.request().postData();
      let parsed: unknown;
      try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = raw; }
      body = match.respond({ method, path: url.pathname, body: parsed });
    }

    await route.fulfill({
      status: match.status ?? 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

/** Signs in by planting the token the app looks for, rather than driving a login
 *  form on every spec. The login flow has its own test; every other spec is about
 *  what happens after it. */
export async function signIn(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("crusaders.mainframe.token", "e2e-token");
  });
}

export const test = base;
export { expect } from "@playwright/test";

/**
 * D1 — the single rotating member code. The member secret is `derivation.json`'s `dean-gen1`
 * (a fixture derived from a fixture master key; it authenticates nothing anywhere).
 */
export const MEMBER_CODE = {
  secretHex: "aca5e9d6718ee21c343dee909e9037ff98d47dbf053dffa57b9b24d9c99b5387",
  ref: "18Y9",
  tz: "Africa/Johannesburg",
} as const;

/** Unpadded base64url of the fixture secret — what `POST /me/code/enrol` carries. */
export function memberCodeSecretB64(): string {
  return Buffer.from(MEMBER_CODE.secretHex, "hex").toString("base64url");
}

/**
 * `POST /api/v1/me/code/enrol` and `GET /api/v1/me/code`, answering with the harness's clock at
 * the moment of the call — so the phone measures an offset of about nothing.
 */
export function memberCodeRoutes(options: { generation?: number } = {}): ApiRoute[] {
  const generation = options.generation ?? 1;
  const { ref, tz } = MEMBER_CODE;
  return [
    {
      method: "POST",
      path: "/api/v1/me/code/enrol",
      respond: () => ({ v: 1, ref, generation, secret: memberCodeSecretB64(), tz, step_seconds: 30, server_time_ms: Date.now() }),
    },
    { path: "/api/v1/me/code", respond: () => ({ v: 1, ref, generation, tz, server_time_ms: Date.now() }) },
  ];
}

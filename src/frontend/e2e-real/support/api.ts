import type { APIRequestContext, APIResponse, Page } from "@playwright/test";

/**
 * The admin's side of a real-stack walk, driven through the API rather than the console.
 *
 * <p>
 * The console is about to be redesigned; a helper that clicked through it would break on every
 * lane. The API is the contract that survives the facelift, so setup and approvals go through it
 * and only the journey under test goes through the UI.
 * </p>
 */

/** The one localStorage key the app keeps its session under (`src/lib/api.ts` TOKEN_KEY). */
export const TOKEN_KEY = "crusaders.mainframe.token";

export type Session = { accessToken: string; userId: string; isAdmin: boolean };

type LoginBody = { access_token: string; user_id: string; is_admin: boolean };

type MemberRow = {
  membership_id: string;
  user_id: string;
  email: string;
  status: string;
};

const MAX_ATTEMPTS = 4;

/**
 * POSTs with a wait-and-retry on 429.
 *
 * <p>
 * The auth group allows 10 anonymous calls a minute per IP, and a mobile + desktop run makes
 * about that many. Waiting out `Retry-After` is what a patient person does; failing the walk on
 * a limiter that is working as designed would be noise.
 * </p>
 */
async function postWithBackoff(
  request: APIRequestContext,
  url: string,
  options: Parameters<APIRequestContext["post"]>[1],
): Promise<APIResponse> {
  let res = await request.post(url, options);
  for (let attempt = 1; res.status() === 429 && attempt < MAX_ATTEMPTS; attempt += 1) {
    const retryAfter = Number(res.headers()["retry-after"] ?? "20");
    await new Promise((r) => setTimeout(r, Math.min(Math.max(retryAfter, 5), 65) * 1_000));
    res = await request.post(url, options);
  }
  return res;
}

async function expectOk(res: APIResponse, what: string): Promise<void> {
  if (res.ok()) return;
  throw new Error(`${what} failed: HTTP ${res.status()} ${await res.text()}`);
}

function toSession(body: LoginBody): Session {
  return { accessToken: body.access_token, userId: body.user_id, isAdmin: body.is_admin };
}

let adminSession: Promise<Session> | null = null;
let adminSessionAt = 0;

/**
 * How long a cached admin session is trusted. The access token lives longer than this, but a
 * walk that waits for a box's cue window can outlast it; a fresh login costs one call.
 */
const ADMIN_SESSION_REUSE_MS = 5 * 60_000;

/**
 * The seeded admin's session, via the Development-only `/api/v1/auth/dev/admin-login`.
 *
 * <p>
 * Cached for a few minutes (`ADMIN_SESSION_REUSE_MS`): every call burns one of the ten
 * anonymous auth calls a minute, and a session held for the life of the worker expired mid-walk. The endpoint answers 404 outside Development, which is reported as such rather than
 * as a generic failure.
 * </p>
 */
export function devAdminSession(request: APIRequestContext): Promise<Session> {
  if (adminSession && Date.now() - adminSessionAt > ADMIN_SESSION_REUSE_MS) adminSession = null;
  if (!adminSession) adminSessionAt = Date.now();
  adminSession ??= (async () => {
    const res = await postWithBackoff(request, "/api/v1/auth/dev/admin-login", {});
    if (res.status() === 404) {
      throw new Error("dev admin login answered 404 — the stack is not running with ASPNETCORE_ENVIRONMENT=Development.");
    }
    await expectOk(res, "dev admin login");
    return toSession((await res.json()) as LoginBody);
  })();
  const pending = adminSession;
  pending.catch(() => { adminSession = null; });
  return pending;
}

/** Signs a member in through the API (for setup, not for the journey under test). */
export async function passwordSession(request: APIRequestContext, email: string, password: string): Promise<Session> {
  const res = await postWithBackoff(request, "/api/v1/auth/login", { data: { email, password } });
  await expectOk(res, `login for ${email}`);
  return toSession((await res.json()) as LoginBody);
}

/** Plants a session before the page's own scripts run, the way a returning browser has one. */
export async function useSession(page: Page, session: Session): Promise<void> {
  await page.addInitScript(
    ([key, token]) => { window.localStorage.setItem(key, token); },
    [TOKEN_KEY, session.accessToken] as const,
  );
}

function bearer(session: Session): Record<string, string> {
  return { Authorization: `Bearer ${session.accessToken}` };
}

/** The membership row for an address, from the admin's list. Null when there is none. */
export async function findMember(request: APIRequestContext, admin: Session, email: string): Promise<MemberRow | null> {
  const res = await request.get("/api/v1/admin/members/", { headers: bearer(admin) });
  await expectOk(res, "list members");
  const rows = (await res.json()) as MemberRow[];
  const wanted = email.toLowerCase();
  return rows.find((r) => r.email.toLowerCase() === wanted) ?? null;
}

/** Approves a pending applicant by email. Throws when there is no such pending membership. */
export async function approveMember(request: APIRequestContext, admin: Session, email: string): Promise<MemberRow> {
  const row = await findMember(request, admin, email);
  if (!row) throw new Error(`no membership for ${email}`);
  const res = await request.post(`/api/v1/admin/members/${row.membership_id}/approve`, { headers: bearer(admin) });
  await expectOk(res, `approve ${email}`);
  return row;
}

/**
 * Moves a member's balance by hand, as the desk would. Goodwill by default so a walk never
 * inflates the club's recorded revenue; the idempotency key makes a retried call one movement.
 */
export async function adjustCredits(
  request: APIRequestContext,
  admin: Session,
  userId: string,
  amountCredits: number,
  reason = "Local walk setup",
): Promise<{ balance_after_credits: number }> {
  const res = await postWithBackoff(request, `/api/v1/admin/credit/${userId}/adjust`, {
    headers: bearer(admin),
    data: {
      amountCredits,
      reason,
      reasonCode: "goodwill",
      idempotencyKey: `walk-${userId}-${amountCredits}-${Date.now()}`,
    },
  });
  await expectOk(res, `adjust credits for ${userId}`);
  return (await res.json()) as { balance_after_credits: number };
}

/** whoami with an explicit token — the server's own view of a session. */
export async function whoami(request: APIRequestContext, session: Session): Promise<{ user_id: string | null; is_authenticated: boolean; is_admin: boolean }> {
  const res = await request.get("/api/v1/whoami", { headers: bearer(session) });
  await expectOk(res, "whoami");
  return res.json();
}

import type { FullConfig } from "@playwright/test";

/**
 * Fails the run in one sentence when the stack is not up, instead of letting the first spec
 * time out on a blank page that reads like a frontend bug.
 */
export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  const baseURL = String(config.projects[0]?.use.baseURL ?? "http://localhost:8088");
  await stackUp(baseURL);
  return quietHoursOffForTheRun(baseURL);
}

/**
 * The club's quiet hours (21:00–07:00 by default) hold a member's non-urgent mail until the
 * morning — correctly — so the play walk's "confirm the result" email never came after 21:00
 * and the walk passed only in daylight. Off for the run (start == end means none), once for
 * every project, and the club's own window put back at teardown.
 */
async function quietHoursOffForTheRun(baseURL: string): Promise<() => Promise<void>> {
  const at = (path: string) => new URL(path, baseURL).toString();
  const login = await fetch(at("/api/v1/auth/dev/admin-login"), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (!login.ok) throw new Error(`dev admin login answered ${login.status} — is the stack in Development?`);
  const body = (await login.json()) as { access_token: string };
  const token = body.access_token;
  // Handed to the workers (env set here reaches them) so `devAdminSession` spends no second
  // sign-in: the anonymous auth bucket is ten a minute, and one more tipped the smoke walk's
  // verify link into "Too many tries".
  process.env.E2E_REAL_ADMIN_LOGIN = JSON.stringify({ ...body, at: Date.now() });
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const settings = (await (await fetch(at("/api/v1/admin/settings"), { headers })).json()) as {
    member_quiet_start_minute: number; member_quiet_end_minute: number;
  };
  const put = async (start: number, end: number) => {
    const res = await fetch(at("/api/v1/admin/settings"), {
      method: "PUT", headers, body: JSON.stringify({ member_quiet_start_minute: start, member_quiet_end_minute: end }),
    });
    if (!res.ok) throw new Error(`setting quiet hours answered ${res.status}: ${await res.text()}`);
  };
  await put(0, 0);
  return () => put(settings.member_quiet_start_minute, settings.member_quiet_end_minute);
}

async function stackUp(baseURL: string): Promise<void> {
  const url = new URL("/healthz", baseURL).toString();
  const deadline = Date.now() + 15_000;
  let last = "no answer";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(
    `The real stack is not answering at ${url} (${last}). ` +
      "Start the stack: make up (with ASPNETCORE_ENVIRONMENT=Development in .env). See docs/runbooks/local-walk.md.",
  );
}

import type { FullConfig } from "@playwright/test";

/**
 * Fails the run in one sentence when the stack is not up, instead of letting the first spec
 * time out on a blank page that reads like a frontend bug.
 */
export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  const baseURL = String(config.projects[0]?.use.baseURL ?? "http://localhost:8088");
  await stackUp(baseURL);
  return clubOpenAndQuietOffForTheRun(baseURL);
}

/**
 * The play walk books a court for NOW and expects the result mail at once, so it held only in
 * daylight: after 21:00 quiet hours rightly held the mail till morning, and after closing time
 * (22:00) "now" is out of hours. For the run the club is open all day and quiet hours are off
 * (start == end means none), once for every project; the club's own values are put back at
 * teardown.
 */
async function clubOpenAndQuietOffForTheRun(baseURL: string): Promise<() => Promise<void>> {
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
    member_quiet_start_minute: number; member_quiet_end_minute: number; operating_hours: Record<string, string>;
  };
  const put = async (body: Record<string, unknown>) => {
    const res = await fetch(at("/api/v1/admin/settings"), { method: "PUT", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`setting the run's club hours answered ${res.status}: ${await res.text()}`);
  };
  const allDay = Object.fromEntries(Object.keys(settings.operating_hours).map((day) => [day, "00:00-23:59"]));
  // The write's name for the map is `operatingHours` (the read says `operating_hours`); an
  // unknown key is ignored, so the snake spelling "saved" and changed nothing.
  await put({ member_quiet_start_minute: 0, member_quiet_end_minute: 0, operatingHours: allDay });
  return () => put({
    member_quiet_start_minute: settings.member_quiet_start_minute,
    member_quiet_end_minute: settings.member_quiet_end_minute,
    operatingHours: settings.operating_hours,
  });
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

import type { FullConfig } from "@playwright/test";

/**
 * Fails the run in one sentence when the stack is not up, instead of letting the first spec
 * time out on a blank page that reads like a frontend bug.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = String(config.projects[0]?.use.baseURL ?? "http://localhost:8088");
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

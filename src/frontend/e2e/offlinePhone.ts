import type { BrowserContext, Page } from "@playwright/test";

/**
 * R15 X15-3 — a phone with no signal, as every NEXT document sees it.
 *
 * <p>
 * Chromium's `context.setOffline(true)` sets `navigator.onLine` false only on the documents already
 * open (FE15s measured it): a reload, a `goto` or a new page reads `true` again. Since X15-3 the app
 * says "You're offline" only when `navigator.onLine === false` — so a spec that goes offline and then
 * opens a document would be testing "Can't reach the club" without knowing it. This pins `onLine`
 * false on every document the target opens from now on (an init script, so it cannot be undone:
 * pin a page or context that stays offline until it is closed).
 * </p>
 */
export async function pinPhoneOffline(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "onLine", { configurable: true, get: () => false });
  });
}

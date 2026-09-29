import { useSyncExternalStore } from "react";

/**
 * Installing the app to the home screen (P8, the wizard's last step and the checklist's fourth
 * item).
 *
 * <p>
 * <b>Three platforms, three truths.</b> Chromium fires `beforeinstallprompt` once, early, and
 * only then can the page offer its own Install button — so the event is captured at module load
 * and held. iOS Safari has no such event and no programmatic install at all: the only route is
 * Share → Add to Home Screen, so the page says that in words. Everything else (Firefox desktop,
 * an in-app browser) can do neither, and the step says the app works in the browser as it is.
 * </p>
 *
 * <p>
 * "Installed" is read from the display mode (the page is running as the installed app right
 * now) or from `appinstalled` having fired on this device. Neither can see an install made from
 * another device, which is the honest limit of a checklist item a browser has to infer.
 * </p>
 */

/** The non-standard event Chromium fires. Not in the DOM lib types. */
export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform?: string }>;
};

let deferred: BeforeInstallPromptEvent | null = null;
let installedNow = false;
let version = 0;
const listeners = new Set<() => void>();

function notify() {
  version += 1;
  listeners.forEach((listener) => listener());
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    // Held for the wizard's own button. Chromium shows its mini-infobar otherwise, which on a
    // phone lands over the bottom tab bar.
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installedNow = true;
    notify();
  });
}

/** Running as the installed app right now. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const nav = window.navigator as Navigator & { standalone?: boolean };
    return window.matchMedia?.("(display-mode: standalone)").matches === true || nav.standalone === true;
  } catch {
    return false;
  }
}

/** iPhone / iPad Safari, including an iPad that reports itself as a Mac. */
export function isIos(userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
  touchPoints = typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints ?? 0): boolean {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return true;
  return /Macintosh/i.test(userAgent) && touchPoints > 1;
}

export type InstallRoute = "installed" | "prompt" | "ios" | "browser";

/** Which of the four things the install step can honestly say. */
export function installRoute(input: { standalone: boolean; installed: boolean; canPrompt: boolean; ios: boolean }): InstallRoute {
  if (input.standalone || input.installed) return "installed";
  if (input.canPrompt) return "prompt";
  if (input.ios) return "ios";
  return "browser";
}

/** Shows the browser's own install sheet. Resolves true when the member accepted. */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  await event.prompt();
  const choice = await event.userChoice;
  // A prompt can be shown once; either answer uses it up.
  deferred = null;
  if (choice.outcome === "accepted") installedNow = true;
  notify();
  return choice.outcome === "accepted";
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The live answer, re-rendering when the prompt arrives or the app is installed. */
export function useInstallState(): { canPrompt: boolean; installedNow: boolean; standalone: boolean; ios: boolean } {
  useSyncExternalStore(subscribe, () => version, () => version);
  return { canPrompt: deferred !== null, installedNow, standalone: isStandalone(), ios: isIos() };
}

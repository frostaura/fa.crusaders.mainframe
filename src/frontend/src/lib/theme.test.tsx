import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { THEME_STORAGE_KEY, ThemeProvider, resolveTheme, useTheme } from "./theme";
import { themes } from "./tokens";

/**
 * The theme provider: a stored choice wins, `system` follows the OS LIVE, and the document is
 * painted only through `html.dark` + `color-scheme` (no `dark:` classes anywhere — D7).
 */

type Listener = () => void;

/** A controllable `(prefers-color-scheme: dark)`: flip it and every subscriber hears. */
function fakeScheme(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<Listener>();
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    get matches() { return query.includes("dark") ? dark : false; },
    media: query,
    onchange: null,
    addEventListener: (_: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
    addListener: (fn: Listener) => listeners.add(fn),
    removeListener: (fn: Listener) => listeners.delete(fn),
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return {
    flip(next: boolean) { dark = next; act(() => listeners.forEach((fn) => fn())); },
    listeners,
    restore() { window.matchMedia = original; },
  };
}

function Probe() {
  const { theme, resolved, setTheme } = useTheme();
  return (
    <div>
      <output data-testid="state">{`${theme}/${resolved}`}</output>
      <button type="button" onClick={() => setTheme("dark")}>dark</button>
      <button type="button" onClick={() => setTheme("light")}>light</button>
      <button type="button" onClick={() => setTheme("system")}>system</button>
    </div>
  );
}

const state = () => screen.getByTestId("state").textContent;
const html = () => document.documentElement;

describe("ThemeProvider", () => {
  let scheme: ReturnType<typeof fakeScheme>;

  beforeEach(() => {
    localStorage.clear();
    html().classList.remove("dark");
    html().style.colorScheme = "";
  });
  afterEach(() => { scheme?.restore(); html().classList.remove("dark"); });

  it("follows the OS when nothing is stored — and keeps following it", () => {
    scheme = fakeScheme(false);
    render(<ThemeProvider><Probe /></ThemeProvider>, { reactStrictMode: true });
    expect(state()).toBe("system/light");
    expect(html().classList.contains("dark")).toBe(false);

    scheme.flip(true);
    expect(state()).toBe("system/dark");
    expect(html().classList.contains("dark")).toBe(true);
    expect(html().style.colorScheme).toBe("dark");
  });

  it("an explicit choice beats the OS, persists, and ignores the OS flipping", () => {
    scheme = fakeScheme(true);
    render(<StrictMode><ThemeProvider><Probe /></ThemeProvider></StrictMode>);
    fireEvent.click(screen.getByRole("button", { name: "light" }));
    expect(state()).toBe("light/light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(html().classList.contains("dark")).toBe(false);

    scheme.flip(false);
    scheme.flip(true);
    expect(state()).toBe("light/light");
  });

  it("reads the stored choice on mount, and `system` clears it", () => {
    scheme = fakeScheme(false);
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(state()).toBe("dark/dark");
    expect(html().classList.contains("dark")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "system" }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(state()).toBe("system/light");
  });

  it("points the browser chrome at an explicit theme, and gives each meta its own back on system", () => {
    scheme = fakeScheme(false);
    document.head.innerHTML = `
      <meta name="theme-color" media="(prefers-color-scheme: light)" content="${themes.light.bg.app}">
      <meta name="theme-color" media="(prefers-color-scheme: dark)" content="${themes.dark.bg.app}">`;
    const metas = () => [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute("content"));
    render(<ThemeProvider><Probe /></ThemeProvider>);

    fireEvent.click(screen.getByRole("button", { name: "dark" }));
    expect(metas()).toEqual([themes.dark.bg.app, themes.dark.bg.app]);
    fireEvent.click(screen.getByRole("button", { name: "system" }));
    expect(metas()).toEqual([themes.light.bg.app, themes.dark.bg.app]);
    document.head.innerHTML = "";
  });

  it("unsubscribes from the OS on unmount", () => {
    scheme = fakeScheme(false);
    const { unmount } = render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(scheme.listeners.size).toBeGreaterThan(0);
    unmount();
    expect(scheme.listeners.size).toBe(0);
  });

  it("treats a stored value it does not recognise as system", () => {
    scheme = fakeScheme(true);
    localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(state()).toBe("system/dark");
  });
});

describe("useTheme outside a provider", () => {
  it("still applies a choice to the document, so a stray consumer cannot crash a test", () => {
    render(<Probe />);
    expect(state()).toBe("system/light");
    fireEvent.click(screen.getByRole("button", { name: "dark" }));
    expect(html().classList.contains("dark")).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: "system" }));
    expect(html().classList.contains("dark")).toBe(false);
  });
});

describe("resolveTheme", () => {
  it("maps a choice and the OS preference to what is painted", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

/* eslint-disable react-refresh/only-export-components -- the provider, its hook and the pure helpers theme-boot.js mirrors belong in one module. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { themes, type ThemeName } from "./tokens";

/**
 * Light, dark, or whatever the device says (D7).
 *
 * <p>
 * `public/theme-boot.js` applies the stored choice before the first paint; this provider owns it
 * from hydration on — the account menu's System / Light / Dark calls {@link ThemeContextValue.setTheme},
 * and a `system` choice follows the OS live (macOS and iOS flip it at sunset). The two must agree
 * on the storage key and on what they do to `<html>`; `theme-emission.test.ts` pins both.
 * </p>
 *
 * <p>
 * Dark is expressed ONLY through the token variables: this toggles `html.dark`, the Tailwind
 * plugin's `.dark` block swaps every `--color-*`, and no component carries a `dark:` class.
 * </p>
 */

export type ThemeChoice = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "crusaders:theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

export interface ThemeContextValue {
  /** What the member chose. */
  theme: ThemeChoice;
  /** What is actually painted. */
  resolved: ThemeName;
  setTheme: (choice: ThemeChoice) => void;
}

function readChoice(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function writeChoice(choice: ThemeChoice): void {
  try {
    if (choice === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Storage refused (private mode, blocked site data): the choice lasts for this page only.
  }
}

function systemPrefersDark(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ThemeName {
  if (choice === "system") return prefersDark ? "dark" : "light";
  return choice;
}

/** Paint `resolved` on the document, and point the browser chrome at it for an explicit choice. */
export function applyTheme(choice: ThemeChoice, resolved: ThemeName): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    const media = meta.getAttribute("media") ?? "";
    const own: ThemeName = media.includes("dark") ? "dark" : "light";
    meta.setAttribute("content", themes[choice === "system" ? own : resolved].bg.app);
  });
}

const fallback: ThemeContextValue = {
  theme: "system",
  resolved: "light",
  setTheme: (choice) => {
    writeChoice(choice);
    applyTheme(choice, resolveTheme(choice, systemPrefersDark()));
  },
};

const ThemeContext = createContext<ThemeContextValue>(fallback);

/** Subscribe to the OS scheme; returns the current value and re-renders when it flips. */
function useSystemDark(): boolean {
  const [dark, setDark] = useState(systemPrefersDark);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    let query: MediaQueryList;
    try { query = window.matchMedia(DARK_QUERY); } catch { return; }
    const onChange = () => setDark(query.matches);
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    }
    query.addListener?.(onChange);
    return () => query.removeListener?.(onChange);
  }, []);
  return dark;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setChoice] = useState<ThemeChoice>(readChoice);
  const systemDark = useSystemDark();
  const resolved = resolveTheme(theme, systemDark);

  useEffect(() => { applyTheme(theme, resolved); }, [theme, resolved]);

  const setTheme = useCallback((choice: ThemeChoice) => {
    writeChoice(choice);
    setChoice(choice);
  }, []);

  const value = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * The member's theme. Outside a provider (a unit test rendering one component) it reports
 * `system`/`light` and `setTheme` still applies the choice to the document.
 */
export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

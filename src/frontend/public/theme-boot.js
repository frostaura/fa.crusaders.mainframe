/*
 * Theme boot — runs BEFORE the stylesheet and the app, so the first frame is already in the
 * right theme (no white flash for a member whose phone is in dark mode).
 *
 * Reads localStorage["crusaders:theme"] (system | light | dark; anything else is system),
 * toggles `dark` on <html>, and sets `color-scheme` so native controls and scrollbars match.
 * An explicit choice also pins both theme-color metas, so the browser chrome follows the app
 * rather than the OS. `lib/theme.tsx` owns the same logic after hydration.
 *
 * Wrapped whole in try/catch: storage can throw (private mode, blocked site data), and a boot
 * script that throws leaves the page in light — which is exactly what doing nothing does.
 */
(function () {
  try {
    var KEY = "crusaders:theme";
    var APP = { light: "#F8FAFC", dark: "#0A1220" };
    var stored = null;
    try { stored = window.localStorage.getItem(KEY); } catch (e) { stored = null; }
    var choice = stored === "light" || stored === "dark" ? stored : "system";
    var prefersDark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    var resolved = choice === "system" ? (prefersDark ? "dark" : "light") : choice;
    var root = document.documentElement;
    root.classList.toggle("dark", resolved === "dark");
    root.style.colorScheme = resolved;
    if (choice !== "system") {
      var metas = document.querySelectorAll('meta[name="theme-color"]');
      for (var i = 0; i < metas.length; i++) metas[i].setAttribute("content", APP[resolved]);
    }
  } catch (e) {
    /* Light is the safe default; nothing to do. */
  }
})();

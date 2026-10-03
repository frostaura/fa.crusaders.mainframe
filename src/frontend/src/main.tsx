import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ICON_DEFAULTS, IconContext } from "./components/ui/icons";
import { registerServiceWorker } from "./lib/pwa";
import { installChunkReload } from "./lib/chunkLoad";
import { ThemeProvider } from "./lib/theme";
import { tokenStore } from "./lib/api";
import { whenSessionCheckSent } from "./lib/sessionCheck";
import { preloadAtSessionCheck } from "./routeChunks";
import "./index.css";

// Perf: with a session on this device, the opened page's code is fetched BESIDE the session check
// rather than after it (`routeChunks`) — the moment that check is sent, so it is not queued behind
// the page's files. No session: the page is sign-in, which is in the entry.
// R4: and Bookings' straight after — the next tap from every page (`preloadAtSessionCheck`).
if (tokenStore.get()) whenSessionCheckSent(() => preloadAtSessionCheck(window.location.pathname, undefined, window.location.search));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <IconContext.Provider value={ICON_DEFAULTS}>
        <App />
      </IconContext.Provider>
    </ThemeProvider>
  </StrictMode>
);

// Production only. A service worker in front of the dev server hands back a stale module graph
// after every edit, and the symptom is indistinguishable from a broken build.
if (import.meta.env.PROD) registerServiceWorker();

// F4.3 — a deploy under an open tab: Vite reports a lazy chunk's failed preload as an event, and
// one reload picks up the new build (lib/chunkLoad says why only one).
installChunkReload();

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ICON_DEFAULTS, IconContext } from "./components/ui/icons";
import { registerServiceWorker } from "./lib/pwa";
import { ThemeProvider } from "./lib/theme";
import "./index.css";

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

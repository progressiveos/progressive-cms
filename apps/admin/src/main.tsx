// Admin entry point (PCMS-ADMIN-T001).
// Appearance bootstrap must run before any render: importing theme.js applies
// the persisted light/dark preference to <html> as a module-init side effect.
import "./design/theme.js";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { AuthProvider } from "./auth/AuthContext.js";
import { ToastProvider } from "./design/toast.js";
// M12 Interactions workspace: extension registration must run before the
// router reads the registries (module-load contract, Admin spec §59).
import "./features/interactions/index.js";
import "./features/extensions/index.js";
import "./design/tokens.css";
import "./design/theme-light.css";
import "./design/theme-dark.css";
import "./design/base.css";
import "./design/components.css";
import "./design/shell.css";
import "./design/login.css";
import "./design/screens.css";

// Stale-tab chunk recovery (2026-10-05 incident, p-cms.com): a release flip
// renames fingerprinted chunks, so an Admin tab opened before the update
// fails its next dynamic import (e.g. ExtensionsScreen) with a 404. One
// automatic reload picks the fresh index (served no-store). The guard keeps
// a set of already-retried chunk URLs in sessionStorage: each unique chunk
// reloads at most once — repeated release flips keep self-healing, while a
// persistently failing network never loops.
const STALE_CHUNK_KEY = "pcms.admin.stale_chunk_reloads";
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason ?? "");
  const match = /dynamically imported module: (\S+)/i.exec(reason);
  if (match === null) return;
  let seen: string[] = [];
  try {
    seen = JSON.parse(sessionStorage.getItem(STALE_CHUNK_KEY) ?? "[]") as string[];
  } catch {
    seen = [];
  }
  const chunkUrl = match[1]!;
  if (seen.includes(chunkUrl)) return;
  seen.push(chunkUrl);
  try {
    sessionStorage.setItem(STALE_CHUNK_KEY, JSON.stringify(seen));
  } catch {
    // storage full/blocked — still reload once
  }
  window.location.reload();
});

const container = document.getElementById("root");
if (container === null) {
  throw new Error("#root container is missing");
}

createRoot(container).render(
  <AuthProvider>
    <ToastProvider>
      <App />
    </ToastProvider>
  </AuthProvider>,
);

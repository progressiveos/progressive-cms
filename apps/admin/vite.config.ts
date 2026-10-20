import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
) as { version: string };

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // Served by the web process under /admin/ (ADR-0009) — assets must resolve
  // against that prefix.
  base: "/admin/",
  plugins: [react()],
  // Build-time product version for the login screen metadata (redesign §25.4).
  define: {
    __PCMS_ADMIN_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
  server: {
    // Dev convenience only; acceptance runs the production bundle served by
    // the web process. API calls proxy to a locally running pcms-web.
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/media": "http://127.0.0.1:3000",
    },
  },
});

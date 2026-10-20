// Admin appearance engine (redesign spec §5): light | dark | system,
// persisted in localStorage, applied to <html data-pcms-theme> before first
// paint (imported for its side effect at the top of main.tsx — the bundle is
// fully client-rendered, so module init is pre-paint). No server preference
// surface exists today (gap G-UI-2).
export type AdminAppearance = "light" | "dark" | "system";

const KEY = "pcms.admin.appearance";
const VALUES: readonly AdminAppearance[] = ["light", "dark", "system"];

type Listener = (preference: AdminAppearance, effective: "light" | "dark") => void;
const listeners = new Set<Listener>();

function systemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function getAppearance(): AdminAppearance {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored !== null && (VALUES as readonly string[]).includes(stored)) {
      return stored as AdminAppearance;
    }
  } catch {
    // storage unavailable — fall through to system
  }
  return "system";
}

function apply(): void {
  const preference = getAppearance();
  const effective = preference === "system" ? systemTheme() : preference;
  document.documentElement.dataset.pcmsTheme = effective;
  document.documentElement.dataset.pcmsThemePreference = preference;
  for (const listener of listeners) listener(preference, effective);
}

export function setAppearance(preference: AdminAppearance): void {
  try {
    localStorage.setItem(KEY, preference);
  } catch {
    // non-fatal: theme still applies for this session
  }
  apply();
}

/** Subscribe to preference/effective changes; fires immediately. */
export function onAppearanceChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// React to OS scheme flips while preference === "system" (spec §5.3).
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (getAppearance() === "system") apply();
});

apply();

// Bounded extension registries (PCMS-ADMIN-T023/T024; Admin spec §3/§59).
//
// M12 (Forms/Quizzes/Leads), M13 (Integrations/Payments), M11 (Search) and
// later assistant surfaces plug into the Admin shell ONLY through these
// registries. Admin core never imports an extension module: an extension
// imports `register*` from here and adds its contribution at module load.
// There is deliberately no remove/override — a bounded, append-only contract.
import type { AdminNavSection, AdminRoute } from "@pcms/extensions";

export type { AdminNavItem, AdminNavSection, AdminRoute } from "@pcms/extensions";

/** Core registrations pass the base shape; extension contributions tag the
 * owning extensionId so unregisterExtensionContributions can remove them. */
export type OwnedNavSection = AdminNavSection & { readonly extensionId?: string };
export type OwnedRoute = AdminRoute & { readonly extensionId?: string };

const navSections: OwnedNavSection[] = [];
const routes: OwnedRoute[] = [];

export function registerNavSection(section: OwnedNavSection): void {
  navSections.push(section);
  navSections.sort((a, b) => a.id.localeCompare(b.id));
  bump();
}

export function registerRoute(route: OwnedRoute): void {
  routes.push(route);
  bump();
}

export function extensionNavSections(): readonly AdminNavSection[] {
  return navSections;
}

export function extensionRoutes(): readonly AdminRoute[] {
  return routes;
}

// ---- S6 UI contract: runtime-gated extension contributions ----------------
// The contributions loader re-registers the ENABLED set on every extension
// lifecycle change; the shell re-renders through the version store.
let registryVersion = 0;
const listeners = new Set<() => void>();

function bump(): void {
  registryVersion += 1;
  for (const listener of listeners) listener();
}

export function subscribeExtensionRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function extensionRegistryVersion(): number {
  return registryVersion;
}

/** Removes every contribution registered for one extension (disable/
 * uninstall — nav/routes disappear on the next render). */
export function unregisterExtensionContributions(extensionId: string): void {
  let changed = false;
  for (let index = navSections.length - 1; index >= 0; index -= 1) {
    if (navSections[index]?.extensionId === extensionId) {
      navSections.splice(index, 1);
      changed = true;
    }
  }
  for (let index = routes.length - 1; index >= 0; index -= 1) {
    if (routes[index]?.extensionId === extensionId) {
      routes.splice(index, 1);
      changed = true;
    }
  }
  if (changed) bump();
}

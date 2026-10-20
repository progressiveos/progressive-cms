// Minimal hash router (ADR-0009: no router library). Hash format:
//   #/section/entity?query — e.g. #/content/<entryId>?tab=seo
import { useEffect, useState } from "react";

export interface RouteInfo {
  readonly path: string;
  readonly segments: readonly string[];
  readonly query: URLSearchParams;
}

function parseHash(): RouteInfo {
  const raw = window.location.hash.replace(/^#/, "") || "/";
  const [rawPath = "/", rawQuery = ""] = raw.split("?");
  const path = rawPath.endsWith("/") && rawPath !== "/" ? rawPath.slice(0, -1) : rawPath;
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return { path, segments, query: new URLSearchParams(rawQuery) };
}

export function useRoute(): RouteInfo {
  const [route, setRoute] = useState<RouteInfo>(parseHash);
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

/** Navigates; `replace` avoids polluting history (post-login redirect guard). */
export function navigate(path: string, options?: { readonly replace?: boolean }): void {
  const target = `#${path.startsWith("/") ? path : `/${path}`}`;
  if (options?.replace === true) {
    window.history.replaceState(null, "", target);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = target;
  }
}

/**
 * Matches "content/:entryId" style patterns against route segments.
 * Returns named params or null. `*` consumes the rest (as "rest").
 */
export function matchRoute(
  pattern: string,
  segments: readonly string[],
): Readonly<Record<string, string>> | null {
  const parts = pattern.split("/").filter((part) => part.length > 0);
  const params: Record<string, string> = {};
  let i = 0;
  for (; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === undefined) break;
    if (part === "*") {
      params.rest = segments.slice(i).join("/");
      return params;
    }
    const segment = segments[i];
    if (segment === undefined) return null;
    if (part.startsWith(":")) {
      params[part.slice(1)] = decodeURIComponent(segment);
    } else if (part !== segment) {
      return null;
    }
  }
  return i === segments.length ? params : null;
}

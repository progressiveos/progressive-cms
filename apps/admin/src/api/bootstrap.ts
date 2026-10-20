// Site/environment bootstrap (redesign spec §10.3, §40.12): one
// authenticated GET /agent/bootstrap call feeding the topbar (site title,
// environment classification) and Overview (CMS version). Cached per session;
// the Admin UI must not block first paint on it.
import { useEffect, useState } from "react";
import { apiGet } from "./client.js";

export interface BootstrapInfo {
  readonly site: { readonly key: string; readonly title: string };
  readonly environment: { readonly classification: string };
  readonly server: { readonly cms_version: string; readonly server_time: string };
  /** Opt-in multilingual discovery (absent on older servers / single mode). */
  readonly localization?: {
    readonly mode: "single" | "multilingual";
    readonly default_locale: string;
    readonly enabled_locales: readonly string[];
    readonly routing_strategy: string;
  };
}

let cache: BootstrapInfo | null = null;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load(): Promise<void> {
  if (pending === null) {
    pending = apiGet<BootstrapInfo>("/agent/bootstrap")
      .then((info) => {
        cache = info;
      })
      .catch(() => {
        cache = null;
      })
      .finally(() => {
        for (const listener of listeners) listener();
      });
  }
  return pending;
}

/** Site/environment info; null while loading or when the endpoint fails. */
export function useBootstrap(): BootstrapInfo | null {
  const [info, setInfo] = useState<BootstrapInfo | null>(cache);
  useEffect(() => {
    if (cache === null) {
      void load();
      const notify = () => setInfo(cache);
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    }
    return undefined;
  }, []);
  return info;
}

/** Fresh server identity, bypassing the session cache — the arbiter when a
 * long synchronous apply returns an ambiguous body (the running version can
 * only be contradicted by the server, never by a proxied response shape). */
export const fetchBootstrapInfo = (): Promise<BootstrapInfo> =>
  apiGet<BootstrapInfo>("/agent/bootstrap");

/** Drop the session cache and re-fetch — after an applied update, so the
 * version badge reflects the running release without a manual page reload. */
export const refreshBootstrap = (): Promise<void> => {
  cache = null;
  pending = null;
  return load();
};

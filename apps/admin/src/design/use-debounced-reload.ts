import { useEffect } from "react";

/** Re-runs `reload` 250ms after its identity changes — the standard
 * filter-input debounce shared by the list screens. */
export function useDebouncedReload(reload: () => void, milliseconds = 250): void {
  useEffect(() => {
    const timer = setTimeout(reload, milliseconds);
    return () => clearTimeout(timer);
  }, [reload, milliseconds]);
}

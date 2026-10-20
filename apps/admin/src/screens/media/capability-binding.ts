import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../../api/client.js";

/**
 * Resolves the (extension_id, operation_id) of an enabled operation by its
 * SEMANTIC capability (ADR-0017 S4) — generic consumers never name extension
 * ids. Null when no enabled extension contributes the capability.
 */
export function useCapabilityOperation(
  capability: string,
): { readonly extensionId: string; readonly operationId: string } | null {
  const [binding, setBinding] = useState<{ extensionId: string; operationId: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiGet<{
      items: readonly { extension_id: string; operation_id: string; capability?: string }[];
    }>("/extensions/operations")
      .then((result) => {
        if (cancelled) return;
        const found = result.items.find((entry) => entry.capability === capability);
        setBinding(
          found === undefined
            ? null
            : { extensionId: found.extension_id, operationId: found.operation_id },
        );
      })
      .catch(() => setBinding(null));
    return () => {
      cancelled = true;
    };
  }, [capability]);
  return binding;
}

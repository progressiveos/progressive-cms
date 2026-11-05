/** Refresh a lifecycle-derived value before use. Concurrent callers share the
 * same in-flight refresh, including its failure; stale values are never served
 * when the authoritative read or rebuild fails. */
export function createRevisionedValue<T>(options: {
  revision: () => Promise<string>;
  build: () => Promise<T>;
}): () => Promise<T> {
  let current: { revision: string; value: T } | undefined;
  let pending: Promise<T> | undefined;
  return () => {
    if (pending) return pending;
    const refresh = async (): Promise<T> => {
      const revision = await options.revision();
      if (current?.revision === revision) return current.value;
      const value = await options.build();
      current = { revision, value };
      return value;
    };
    pending = refresh().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

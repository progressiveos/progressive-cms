export function checkNativeSourceSupply(
  root: string,
  options?: { fetch?: typeof globalThis.fetch },
): Promise<{ url: string; bytes: number; sha256: string }>;

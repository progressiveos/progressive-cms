/** Identifier grammar shared by extension manifests, block registries and themes. */
export const EXTENSION_BLOCK_TYPE_ID_SOURCE =
  "[a-z][a-z0-9-]{0,62}(?:\\.[a-z0-9][a-z0-9-]{0,62}){0,9}";
export const BLOCK_TYPE_ID_SOURCE = `(?:[a-z][a-z0-9_]{0,63}|${EXTENSION_BLOCK_TYPE_ID_SOURCE})`;
export const BLOCK_TYPE_ID_MAX_LENGTH = 200;

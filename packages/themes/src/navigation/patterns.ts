// Shared regex patterns mirrored from sibling subsystem contracts (L1 packages
// do not import each other — canonical source: @pcms/blocks first-party
// declarations and @pcms/core stable IDs).
export const STABLE_ID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

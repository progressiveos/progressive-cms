// Injectable clock (PCMS-PUB-T001). Scheduler/publication semantics must be
// testable without real time: services take a Clock, production uses
// systemClock (spec §68 clock control). Clock lives in core because it is a
// universal infrastructure primitive, like identity and transactions.
export interface Clock {
  /** Current instant. Deterministic implementations return a fixed point. */
  now(): Date;
}

/** Production clock backed by the system wall clock. */
export const systemClock: Clock = {
  now: () => new Date(),
};

/** Test/fixture clock frozen at a fixed instant. */
export function fixedClock(instant: Date | string | number): Clock {
  const fixed = instant instanceof Date ? new Date(instant.getTime()) : new Date(instant);
  return { now: () => new Date(fixed.getTime()) };
}

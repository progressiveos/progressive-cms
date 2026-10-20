// Money boundary (S7, CORE-P0-01 §5): explicit currency whitelist with fixed
// 2-decimal minor units. JavaScript floating point never participates in
// business arithmetic — every check converts to integer minor units first and
// every conversion REJECTS values that are not exactly representable instead
// of rounding silently.

/** Currencies the platform accepts, with their minor-unit exponent.
 * numeric(14,2) supports exactly 2 decimals; zero-decimal currencies
 * (JPY, KRW, …) and 3-decimal currencies (KWD, BHD, …) are REJECTED
 * explicitly rather than rounded. Extend via a registry append + tests. */
export const SUPPORTED_CURRENCIES: Readonly<Record<string, 2>> = {
  RUB: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AED: 2,
  CNY: 2,
  KZT: 2,
};

export function isSupportedCurrency(currency: string): boolean {
  return Object.hasOwn(SUPPORTED_CURRENCIES, currency);
}

/** Converts a 2-decimal amount to integer minor units. Throws (caller maps to
 * PAYMENT_REQUEST_INVALID / PAYMENT_REFUND_EXCEEDS_AMOUNT) on non-finite
 * values, more than 2 decimals, or float representation drift > 1e-9. */
export function toMinorUnits(amount: number, currency: string): number {
  if (!Number.isFinite(amount)) {
    throw new Error(`amount ${String(amount)} is not finite`);
  }
  const minor = amount * 100;
  const rounded = Math.round(minor);
  if (Math.abs(minor - rounded) > 1e-6) {
    throw new Error(
      `amount ${amount} ${currency} has sub-minor precision the 2-decimal model does not support`,
    );
  }
  return rounded;
}

/** Integer-safe addition of 2-decimal amounts (returns a clean 2-decimal number). */
export function addAmounts(a: number, b: number): number {
  return (toMinorUnits(a, "XX") + toMinorUnits(b, "XX")) / 100;
}

/** Integer-safe subtraction of 2-decimal amounts. */
export function subAmounts(a: number, b: number): number {
  return (toMinorUnits(a, "XX") - toMinorUnits(b, "XX")) / 100;
}

/** True when a <= b exactly in minor units. */
export function amountLte(a: number, b: number): boolean {
  return toMinorUnits(a, "XX") <= toMinorUnits(b, "XX");
}

/** True when a < b exactly in minor units. */
export function amountLt(a: number, b: number): boolean {
  return toMinorUnits(a, "XX") < toMinorUnits(b, "XX");
}

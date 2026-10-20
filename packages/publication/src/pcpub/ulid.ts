// ULID identity for .pcpub bundle ids (ADR-0014 §2): 48-bit ms UTC timestamp
// + 80 bits of crypto randomness, Crockford Base32. Clock and randomness are
// injectable so tests can produce byte-identical packs.
import { randomBytes } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function encodeUlid(time: number, randomness: Uint8Array): string {
  if (time < 0 || time > 0xffffffffffff) {
    throw new RangeError("ulid timestamp out of range");
  }
  if (randomness.length !== 10) throw new RangeError("ulid needs 10 random bytes");
  let value = (BigInt(time) << 80n) | BigInt(`0x${Buffer.from(randomness).toString("hex")}`);
  let out = "";
  for (let i = 0; i < 26; i += 1) {
    out = ENCODING[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}

export function generateUlid(
  now: number = Date.now(),
  random: (size: number) => Uint8Array = (size) => randomBytes(size),
): string {
  return encodeUlid(now, random(10));
}

// TOTP secret encryption at rest (PCMS-AUTH-T011; Auth spec §21, §67).
//
// The secret must be decryptable for verification, so it is stored
// encrypted — AES-256-GCM from node:crypto (vetted primitive; no hand-rolled
// crypto). The key comes from the M01 secret channel (env/file, outside the
// database) and must be 32 bytes of key material (base64 or hex). A missing
// key at service construction is a startup error (Operations §10: "missing
// encryption key when TOTP enabled").
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { AuthError } from "./errors.js";

export const SECRET_BOX_KEY_BYTES = 32;

export interface SecretBox {
  encrypt(plaintext: string): Buffer;
  decrypt(blob: Buffer): string;
}

/** Accepts base64 or hex; anything that is not 32 bytes of material fails. */
export function decodeEncryptionKey(secret: string): Buffer {
  if (secret.length === 0) {
    throw new AuthError("AUTH_CONFIGURATION", "TOTP encryption key is empty");
  }
  const candidates = [Buffer.from(secret, "base64"), Buffer.from(secret, "hex")];
  for (const candidate of candidates) {
    if (candidate.length === SECRET_BOX_KEY_BYTES) return candidate;
  }
  throw new AuthError(
    "AUTH_CONFIGURATION",
    `TOTP encryption key must decode to ${SECRET_BOX_KEY_BYTES} bytes (base64 or hex)`,
  );
}

export function createSecretBox(keySecret: string): SecretBox {
  const key = decodeEncryptionKey(keySecret);
  return {
    encrypt(plaintext: string): Buffer {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      // Layout: 12-byte IV | 16-byte GCM tag | ciphertext.
      return Buffer.concat([iv, tag, ciphertext]);
    },
    decrypt(blob: Buffer): string {
      if (blob.length < 12 + 16) {
        throw new AuthError("AUTH_CONFIGURATION", "TOTP secret blob is truncated");
      }
      const iv = blob.subarray(0, 12);
      const tag = blob.subarray(12, 28);
      const ciphertext = blob.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    },
  };
}

/** Deterministic key derivation for tests/dev only; production keys are random. */
export function deriveKeyForTesting(seed: string): string {
  return createHash("sha256").update(seed, "utf8").digest("base64");
}

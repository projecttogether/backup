import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config";

/** Encrypts a stored secret (S3 key, repository password, source key) with AES-256-GCM and ENCRYPTION_KEY. */
export function encryptSecret(plain: string): string {
  const key = Buffer.from(config().ENCRYPTION_KEY, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

/** A stored secret that ENCRYPTION_KEY cannot decrypt. It stays so until the key or the secret changes. */
export class SecretDecryptionError extends Error {
  override name = "SecretDecryptionError";
}

export function decryptSecret(stored: string): string {
  const [version, iv, tag, ciphertext] = stored.split(":");
  if (version !== "v1" || !iv || !tag || ciphertext === undefined) {
    throw new SecretDecryptionError("A stored secret has an unknown format");
  }
  try {
    const key = Buffer.from(config().ENCRYPTION_KEY, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString(
      "utf8",
    );
  } catch (error) {
    throw new SecretDecryptionError(
      "A stored secret cannot be decrypted: ENCRYPTION_KEY is not the key it was saved with, or the value is damaged",
      { cause: error },
    );
  }
}

/** What the admin interface shows of a stored secret: its last four characters. */
export function secretHint(plain: string): string {
  return plain.length > 8 ? `…${plain.slice(-4)}` : "…";
}

/** A random secret: `bytes` random bytes in base64url. */
export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

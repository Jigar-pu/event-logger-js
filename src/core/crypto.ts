import crypto from "crypto";

const ALGORITHM = "aes-256-gcm" as const;

/**
 * handles AES-256-GCM encryption and decryption.
 * the stored format is: `iv:ciphertext:authTag` (all hex encoded, colon separated).
 *
 * you normally don't need to use this directly — EventLogger handles it for you
 * when you set `encryption: true` in addEvent. but it's exported in case you
 * need to encrypt/decrypt something outside of event logging.
 */
export class CryptoHelper {
  private readonly key: Buffer;

  /**
   * @param encryptionKey - a string that will be used as the encryption key.
   * gets padded/trimmed to exactly 32 bytes internally.
   * falls back to the `ENCRYPTION_KEY` env variable if not passed.
   */
  constructor(encryptionKey?: string) {
    const rawKey = encryptionKey ?? process.env.ENCRYPTION_KEY;

    if (!rawKey) {
      throw new Error(
        "[EventLogger] Encryption key is required. " +
          "Pass encryptionKey in the config or set the ENCRYPTION_KEY env variable."
      );
    }

    // key needs to be exactly 32 bytes for AES-256
    const paddedKey = rawKey.padEnd(32, "0").slice(0, 32);
    this.key = Buffer.from(paddedKey, "utf-8");
  }

  /**
   * encrypts any JSON-serializable value.
   * returns a string in the format: `iv:ciphertext:authTag`
   *
   * @param data - the value to encrypt, must be JSON-serializable
   * @returns encrypted string you can store in the DB
   */
  encrypt<T = unknown>(data: T): string {
    const iv = crypto.randomBytes(12); // GCM standard is 12 bytes
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);

    let encrypted = cipher.update(JSON.stringify(data), "utf-8", "hex");
    encrypted += cipher.final("hex");

    const authTag = cipher.getAuthTag().toString("hex");

    return `${iv.toString("hex")}:${encrypted}:${authTag}`;
  }

  /**
   * decrypts a string that was previously encrypted with `encrypt()`.
   * throws if the data was tampered with (GCM auth tag won't match).
   *
   * @param encryptedData - the string returned by `encrypt()`
   * @returns the original value
   */
  decrypt<T = unknown>(encryptedData: string): T {
    const parts = encryptedData.split(":");
    if (parts.length !== 3) {
      throw new Error(
        "[EventLogger] Invalid encrypted data. Expected format: iv:ciphertext:authTag"
      );
    }

    const [ivHex, ciphertext, authTagHex] = parts;
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");

    const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, "hex", "utf-8");
    decrypted += decipher.final("utf-8");

    return JSON.parse(decrypted) as T;
  }
}

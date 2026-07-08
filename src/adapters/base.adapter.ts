import {
  AddEventParams,
  AddEventResult,
  GetEventsParams,
  GetEventsResult,
} from "../core/types.js";
import { CryptoHelper } from "../core/crypto.js";

// base class that both mongo and postgres adapters extend.
// handles encryption helpers so we don't repeat that logic in each adapter.
export abstract class BaseAdapter {
  protected crypto?: CryptoHelper;

  /**
   * wires up the encryption helper. called internally by EventLogger
   * right after the adapter is created.
   */
  setEncryptionKey(key?: string): void {
    if (key || process.env.ENCRYPTION_KEY) {
      this.crypto = new CryptoHelper(key);
    }
  }

  /**
   * encrypts data if `encrypt` is true, otherwise returns it as-is.
   * throws if encryption is requested but no key was configured.
   */
  protected encryptData(
    data: Record<string, unknown>,
    encrypt: boolean
  ): { payload: unknown; isEncrypted: boolean } {
    if (encrypt) {
      if (!this.crypto) {
        throw new Error(
          "[EventLogger] Cannot encrypt: no encryptionKey was provided in config."
        );
      }
      return { payload: this.crypto.encrypt(data), isEncrypted: true };
    }
    return { payload: data, isEncrypted: false };
  }

  /**
   * decrypts data if it was marked as encrypted, otherwise returns it as-is.
   * returns null if decryption fails (wrong key or corrupted data).
   */
  protected decryptData(data: unknown, isEncrypted: boolean): unknown {
    if (isEncrypted && this.crypto && typeof data === "string") {
      try {
        return this.crypto.decrypt(data);
      } catch {
        return null; // wrong key or corrupted data
      }
    }
    return data;
  }

  /** opens the database connection */
  abstract connect(): Promise<void>;

  /** closes the database connection */
  abstract disconnect(): Promise<void>;

  /** saves an event to the database */
  abstract addEvent(params: AddEventParams): Promise<AddEventResult>;

  /** fetches events from the database */
  abstract getEvents(params: GetEventsParams): Promise<GetEventsResult>;
}

// shared types used across all adapters and the public API

/** what you pass to addEvent() */
export interface AddEventParams {
  /** e.g. "user", "payment", "order" — used as the collection/table name prefix */
  eventType: string;
  /** e.g. "user_login", "payment_success" */
  eventName: string;
  /** the event payload, any plain JSON object */
  data: Record<string, unknown>;
  /**
   * set to true to encrypt the data with AES-256-GCM before saving.
   * you need to pass `encryptionKey` in the EventLogger config for this to work.
   * @default false
   */
  encryption?: boolean;
  /**
   * controls which table/collection the event goes into.
   * - `true`  → saves to `{eventType}_event_logs`
   * - `false` → saves to the shared `master_event_logs`
   * @default false
   */
  isOwn?: boolean;
}

/** shape of an event record returned from the database */
export interface StoredEvent {
  /** the document ID (ObjectId hex for mongo, UUID for postgres) */
  id?: string;
  eventType: string;
  eventName: string;
  /** the data field — either a plain object or an encrypted blob depending on how it was saved */
  data: unknown;
  isEncrypted: boolean;
  isOwn: boolean;
  createdAt: Date;
}

/** what you pass to getEvents() */
export interface GetEventsParams {
  /** the event category to query */
  eventType: string;
  /** the specific event name to query */
  eventName: string;
  /**
   * filter by fields inside the data object.
   * e.g. `{ userId: "abc" }` will only return events where `data.userId === "abc"`.
   */
  filter?: Record<string, unknown>;
  /**
   * set to true to query `master_event_logs` instead of `{eventType}_event_logs`.
   * @default false
   */
  isFromMaster?: boolean;
  /**
   * filter by whether the event data is encrypted.
   * - `true`  → only encrypted rows, auto-decrypted before returning
   * - `false` → only plain rows
   * - leave undefined to get all rows regardless
   */
  isEncrypted?: boolean;
  /**
   * which page to fetch, starts at 1.
   * @default 1
   */
  page?: number;
  /**
   * how many records to return per page.
   * @default 10
   */
  limit?: number;
}

/** what getEvents() returns */
export interface GetEventsResult {
  success: boolean;
  data: StoredEvent[];
  /** total number of matching records, useful for building pagination */
  total: number;
  /** total number of pages */
  totalPages: number;
  message: string;
}

/** what addEvent() returns */
export interface AddEventResult {
  success: boolean;
  /** the saved event, returned on success */
  data?: StoredEvent;
  /** error message if something went wrong */
  error?: string;
}

// config types — use a discriminated union on the `type` field

interface BaseConfig {
  /**
   * 32-byte key used for AES-256-GCM encryption.
   * only needed if you're using `encryption: true` in addEvent.
   * can also be set via the `ENCRYPTION_KEY` env variable instead.
   */
  encryptionKey?: string;
}

/** config for connecting to MongoDB */
export interface MongoConfig extends BaseConfig {
  type: "mongodb";
  /** full connection URL, e.g. `mongodb://user:pass@localhost:27017/mydb` */
  url: string;
}

/**
 * individual postgres connection fields — mirrors what you'd typically
 * have in your .env (DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_NAME)
 */
export interface PostgresParams {
  /** database host, e.g. `localhost` */
  host: string;
  /** database port, defaults to 5432 */
  port?: number;
  /** database username */
  username: string;
  /** database password */
  password: string;
  /** database name, e.g. `telemart_backup_dev` */
  database: string;
}

/**
 * config for connecting to PostgreSQL.
 * pass either a full connection URL or the individual fields — not both.
 */
export type PostgresConfig = BaseConfig &
  (
    | {
        type: "postgres";
        /** full connection URL, e.g. `postgres://user:pass@localhost:5432/mydb` */
        url: string;
        host?: never;
        port?: never;
        username?: never;
        password?: never;
        database?: never;
      }
    | ({
        type: "postgres";
        url?: never;
      } & PostgresParams)
  );

/** the config object you pass to `new EventLogger(...)` */
export type EventLoggerConfig = MongoConfig | PostgresConfig;

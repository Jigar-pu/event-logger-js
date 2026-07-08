import { MongoAdapter } from "./adapters/mongodb.adapter.js";
import { PostgresAdapter } from "./adapters/postgres.adapter.js";
import {
  AddEventParams,
  AddEventResult,
  EventLoggerConfig,
  GetEventsParams,
  GetEventsResult,
  PostgresConfig,
} from "./core/types.js";
import { BaseAdapter } from "./adapters/base.adapter.js";

/**
 * EventLogger — the main class you'll interact with.
 *
 * supports MongoDB and PostgreSQL. just pass your connection config and
 * start logging — no need to call `connect()` manually, it auto-connects
 * on first use.
 *
 * the package manages its own internal connection pool separately from
 * whatever database connections your app already has (TypeORM, Prisma,
 * Mongoose, etc.) so there's no conflict.
 *
 * @example postgres with individual params
 * ```ts
 * import { EventLogger } from "multi-db-event-logger";
 *
 * const logger = new EventLogger({
 *   type: "postgres",
 *   host:     process.env.DB_HOST,
 *   port:     Number(process.env.DB_PORT),
 *   username: process.env.DB_USERNAME,
 *   password: process.env.DB_PASSWORD,
 *   database: process.env.DB_NAME,
 * });
 *
 * await logger.addEvent({
 *   eventType: "user",
 *   eventName: "user_login",
 *   data: { userId: "123", ip: "192.168.1.1" },
 * });
 * ```
 *
 * @example mongodb
 * ```ts
 * const logger = new EventLogger({
 *   type: "mongodb",
 *   url: "mongodb://localhost:27017/mydb",
 * });
 *
 * await logger.addEvent({
 *   eventType: "payment",
 *   eventName: "card_charged",
 *   data: { userId: "123", amount: 99.99 },
 *   encryption: true,
 *   isOwn: true,
 * });
 * ```
 */
export class EventLogger {
  private readonly adapter: BaseAdapter;

  /**
   * creates a new EventLogger instance.
   *
   * @param config - pass `type: "mongodb"` with a `url`, or `type: "postgres"`
   * with either a `url` or individual `host`, `username`, `password`, `database` fields.
   * optionally include `encryptionKey` if you plan to use `encryption: true` in addEvent.
   *
   * @throws if required fields are missing in the config
   */
  constructor(config: EventLoggerConfig) {
    switch (config.type) {
      case "mongodb": {
        if (!config.url) {
          throw new Error(
            "[EventLogger] MongoDB config needs a url. e.g. mongodb://user:pass@localhost:27017/mydb"
          );
        }
        this.adapter = new MongoAdapter(config.url);
        break;
      }

      case "postgres": {
        const pgConfig = config as PostgresConfig;

        if ("url" in pgConfig && pgConfig.url) {
          this.adapter = new PostgresAdapter(pgConfig.url);
        } else {
          const p = pgConfig as {
            host: string;
            port?: number;
            username: string;
            password: string;
            database: string;
          };

          if (!p.host || !p.username || !p.password || !p.database) {
            throw new Error(
              "[EventLogger] PostgreSQL config needs either a url or all of: host, username, password, database."
            );
          }

          this.adapter = new PostgresAdapter({
            host: p.host,
            port: p.port,
            username: p.username,
            password: p.password,
            database: p.database,
          });
        }
        break;
      }

      default:
        throw new Error(
          `[EventLogger] unknown type "${(config as EventLoggerConfig).type}". use "mongodb" or "postgres".`
        );
    }

    this.adapter.setEncryptionKey(config.encryptionKey);
  }

  /**
   * opens and verifies the database connection.
   *
   * you don't have to call this — `addEvent` and `getEvents` will auto-connect
   * on their first call. calling `connect()` at startup is useful if you want to
   * catch a wrong password or unreachable host before your app starts serving traffic.
   *
   * safe to call multiple times — it's a no-op if already connected.
   *
   * @returns the EventLogger instance so you can chain it if you want
   */
  async connect(): Promise<this> {
    await this.adapter.connect();
    return this;
  }

  /**
   * closes the database connection pool gracefully.
   *
   * call this during shutdown — e.g. in a SIGTERM or SIGINT handler —
   * to let in-flight queries finish before the process exits.
   */
  async disconnect(): Promise<void> {
    await this.adapter.disconnect();
  }

  /**
   * logs an event to the database.
   *
   * auto-connects on the first call if you haven't called `connect()` yet.
   * subsequent calls hit the pool directly with no overhead.
   *
   * @param params.eventType  - event category, e.g. `"user"`, `"payment"`, `"order"`
   * @param params.eventName  - what happened, e.g. `"user_login"`, `"order_placed"`
   * @param params.data       - the event payload as a plain JSON object
   * @param params.encryption - set to `true` to encrypt the data with AES-256-GCM (needs encryptionKey in config)
   * @param params.isOwn      - `true` saves to `{eventType}_event_logs`, `false` saves to `master_event_logs`
   *
   * @returns `{ success: true, data: StoredEvent }` on success,
   *          or `{ success: false, error: string }` if something went wrong
   */
  async addEvent(params: AddEventParams): Promise<AddEventResult> {
    await this.adapter.connect(); // no-op if already connected
    return this.adapter.addEvent(params);
  }

  /**
   * fetches events from the database with optional filtering and pagination.
   *
   * auto-connects on the first call if you haven't called `connect()` yet.
   *
   * @param params.eventType    - the event category to query
   * @param params.eventName    - the specific event name to query
   * @param params.filter       - filter by fields inside the data object, e.g. `{ userId: "123" }`
   * @param params.isFromMaster - query `master_event_logs` instead of `{eventType}_event_logs`
   * @param params.isEncrypted  - `true` = only encrypted rows (auto-decrypted in response),
   *                              `false` = only plain rows, `undefined` = return all
   * @param params.page         - page number, starts at 1 (default: 1)
   * @param params.limit        - records per page (default: 10)
   *
   * @returns `{ success, data, total, message }` — `total` is the full count for pagination
   */
  async getEvents(params: GetEventsParams): Promise<GetEventsResult> {
    await this.adapter.connect(); // no-op if already connected
    return this.adapter.getEvents(params);
  }
}

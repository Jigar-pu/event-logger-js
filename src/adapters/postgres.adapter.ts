import type { Pool, PoolClient, PoolConfig } from "pg";
import { BaseAdapter } from "./base.adapter.js";
import {
  AddEventParams,
  AddEventResult,
  GetEventsParams,
  GetEventsResult,
  PostgresParams,
  StoredEvent,
} from "../core/types.js";

const MASTER_TABLE = "master_event_logs";

// one entry per unique connection, shared across all adapter instances
interface RegistryEntry {
  pool?: Pool;
  // tracks which tables we've already run CREATE TABLE IF NOT EXISTS on,
  // so we don't repeat DDL on every query
  ensuredTables: Set<string>;
  connected: boolean;
}

/**
 * PostgreSQL adapter for EventLogger.
 *
 * uses a connection pool (pg.Pool) internally so it handles concurrent
 * requests without opening a new connection on every query.
 *
 * one Pool is kept per connection string in a static registry, so
 * multiple EventLogger instances pointing at the same DB share a
 * single pool instead of creating duplicate ones.
 *
 * tables are created automatically on first use — no migrations needed.
 */
export class PostgresAdapter extends BaseAdapter {
  // keyed by connection string so all instances pointing at the same DB share one pool
  private static readonly _registry = new Map<string, RegistryEntry>();

  private readonly poolConfig: PoolConfig;
  private readonly connectionKey: string;

  /**
   * @param connection - either a full connection URL or individual params
   *
   * @example URL
   * ```ts
   * new PostgresAdapter("postgres://postgres:postgres@localhost:5432/mydb")
   * ```
   *
   * @example individual params
   * ```ts
   * new PostgresAdapter({
   *   host: "localhost",
   *   port: 5432,
   *   username: "postgres",
   *   password: "postgres",
   *   database: "mydb",
   * })
   * ```
   */
  constructor(connection: string | PostgresParams) {
    super();

    if (typeof connection === "string") {
      this.poolConfig = { connectionString: connection };
      this.connectionKey = connection;
    } else {
      // pg uses `user` internally, not `username`
      this.poolConfig = {
        host: connection.host,
        port: connection.port ?? 5432,
        user: connection.username,
        password: connection.password,
        database: connection.database,
      };
      // build a stable key without the password
      this.connectionKey = `pg:${connection.username}@${connection.host}:${connection.port ?? 5432}/${connection.database}`;
    }
  }

  // returns the registry entry, creating it if this is the first time.
  private getOrCreateEntry(): RegistryEntry {
    let entry = PostgresAdapter._registry.get(this.connectionKey);
    if (!entry) {
      entry = {
        ensuredTables: new Set<string>(),
        connected: false,
      };
      PostgresAdapter._registry.set(this.connectionKey, entry);
    }
    return entry;
  }

  private getPool(): Pool {
    const entry = PostgresAdapter._registry.get(this.connectionKey);
    if (!entry?.connected || !entry.pool) {
      throw new Error(
        "[EventLogger/PostgreSQL] not connected. call connect() first."
      );
    }
    return entry.pool;
  }

  /**
   * opens and verifies the PostgreSQL connection.
   * if a pool for this connection already exists and was verified, this does nothing.
   *
   * borrows one connection from the pool just to run a `SELECT 1` health check,
   * then immediately releases it back. after that, the pool is ready.
   */
  async connect(): Promise<void> {
    const entry = this.getOrCreateEntry();
    if (!entry.pool) {
      const { Pool } = await import("pg");
      entry.pool = new Pool(this.poolConfig);
    }

    if (entry.connected) return;

    const client = await entry.pool.connect();
    try {
      await client.query("SELECT 1");
      const result = await client.query<{ current_database: string }>(
        "SELECT current_database()"
      );
      const dbName = result.rows[0]?.current_database;
      console.log(`[EventLogger/PostgreSQL] connected to ${dbName}`);
      entry.connected = true;
    } finally {
      client.release();
    }
  }

  /**
   * drains and closes the connection pool, then removes it from the registry.
   * after this, the next connect() call will create a fresh pool.
   */
  async disconnect(): Promise<void> {
    const entry = PostgresAdapter._registry.get(this.connectionKey);
    if (entry && entry.pool) {
      await entry.pool.end();
      PostgresAdapter._registry.delete(this.connectionKey);
      console.log("[EventLogger/PostgreSQL] disconnected");
    }
  }

  // isOwn=true  → {eventType}_event_logs
  // isOwn=false → master_event_logs
  private tableName(eventType: string, isOwn: boolean): string {
    if (!isOwn) return MASTER_TABLE;
    const base = eventType.toLowerCase();
    return base.endsWith("_event_logs") ? base : `${base}_event_logs`;
  }

  // strips anything that's not a-z, 0-9, or underscore to prevent SQL injection in table names
  private safeTableName(name: string): string {
    const sanitised = name.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
    if (!sanitised) {
      throw new Error(
        `[EventLogger/PostgreSQL] invalid table name from eventType: "${name}"`
      );
    }
    return sanitised;
  }

  /**
   * creates the table and its indexes if they don't exist yet.
   * uses the shared `ensuredTables` cache so DDL only runs once per table per process.
   */
  private async ensureTable(
    client: PoolClient,
    tableName: string
  ): Promise<void> {
    const entry = PostgresAdapter._registry.get(this.connectionKey)!;
    if (entry.ensuredTables.has(tableName)) return;

    const safe = this.safeTableName(tableName);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "${safe}" (
        id           SERIAL       PRIMARY KEY,
        event_type   VARCHAR(255) NOT NULL,
        event_name   VARCHAR(255) NOT NULL,
        data         JSONB        NOT NULL,
        is_encrypted BOOLEAN      NOT NULL DEFAULT FALSE,
        is_own       BOOLEAN      NOT NULL DEFAULT FALSE,
        created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS "idx_${safe}_type_name"
        ON "${safe}" (event_type, event_name);

      CREATE INDEX IF NOT EXISTS "idx_${safe}_created_at"
        ON "${safe}" (created_at DESC);
    `);

    entry.ensuredTables.add(tableName);
  }

  private rowToStoredEvent(row: Record<string, unknown>): StoredEvent {
    return {
      id: String(row["id"]),
      eventType: String(row["event_type"]),
      eventName: String(row["event_name"]),
      data: row["data"],
      isEncrypted: Boolean(row["is_encrypted"]),
      isOwn: Boolean(row["is_own"]),
      createdAt:
        row["created_at"] instanceof Date
          ? row["created_at"]
          : new Date(String(row["created_at"])),
    };
  }

  /**
   * saves an event to PostgreSQL.
   * the table is created automatically if it doesn't exist yet.
   *
   * @param params.eventType  - category of the event, e.g. `"user"`, `"order"`
   * @param params.eventName  - specific event name, e.g. `"order_placed"`
   * @param params.data       - the event payload
   * @param params.encryption - encrypt the data before saving? (default: false)
   * @param params.isOwn      - save to `{eventType}_event_logs` (true) or `master_event_logs` (false)?
   */
  async addEvent({
    eventType,
    eventName,
    data,
    encryption = false,
    isOwn = false,
  }: AddEventParams): Promise<AddEventResult> {
    if (!eventType) return { success: false, error: "eventType is required" };
    if (!eventName) return { success: false, error: "eventName is required" };
    if (!data) return { success: false, error: "data is required" };

    const type = eventType.toLowerCase();

    if (type === "master") {
      return {
        success: false,
        error: "eventType 'master' is reserved, pick a different name",
      };
    }

    const table = this.tableName(type, isOwn);

    // borrow a connection from the pool for this operation
    const client = await this.getPool().connect();
    try {
      await this.ensureTable(client, table);

      const { payload, isEncrypted } = this.encryptData(data, encryption);

      // encrypted payload is a string, wrap it so JSONB column accepts it
      const jsonData = isEncrypted ? { _encrypted: payload } : payload;

      const result = await client.query<{ id: number; created_at: Date }>(
        `INSERT INTO "${this.safeTableName(table)}"
           (event_type, event_name, data, is_encrypted, is_own, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING id, created_at`,
        [type, eventName, JSON.stringify(jsonData), isEncrypted, isOwn]
      );

      const row = result.rows[0];

      return {
        success: true,
        data: {
          id: row?.id ? String(row.id) : undefined,
          eventType: type,
          eventName,
          data: payload,
          isEncrypted,
          isOwn,
          createdAt: row?.created_at ?? new Date(),
        },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "unknown error";
      return { success: false, error: message };
    } finally {
      client.release();
    }
  }

  /**
   * fetches events from PostgreSQL with optional filtering and pagination.
   * uses JSONB containment (`@>`) for filtering on data fields.
   *
   * @param params.eventType    - the event category to query
   * @param params.eventName    - the specific event name to query
   * @param params.filter       - filter on fields inside the data object, e.g. `{ userId: "123" }`
   * @param params.isFromMaster - query `master_event_logs` instead of the type-specific table
   * @param params.isEncrypted  - `true` = only encrypted (auto-decrypted), `false` = only plain, undefined = all
   * @param params.page         - page number, starts at 1
   * @param params.limit        - records per page
   */
  async getEvents({
    eventType,
    eventName,
    filter = {},
    isFromMaster = false,
    isEncrypted,
    page = 1,
    limit = 10,
  }: GetEventsParams): Promise<GetEventsResult> {
    const type = eventType.toLowerCase();

    if (type === "master") {
      return {
        success: false,
        data: [],
        total: 0,
        totalPages: 0,
        message: "cannot query master_event_logs directly",
      };
    }

    const table = isFromMaster ? MASTER_TABLE : `${type}_event_logs`;

    const client = await this.getPool().connect();
    try {
      await this.ensureTable(client, table);

      const conditions: string[] = ["event_type = $1", "event_name = $2"];
      const values: unknown[] = [type, eventName];
      let paramIdx = 3;

      if (isEncrypted !== undefined) {
        conditions.push(`is_encrypted = $${paramIdx++}`);
        values.push(isEncrypted);
      }

      // JSONB containment — checks if the data column contains the filter object
      if (Object.keys(filter).length > 0) {
        conditions.push(`data @> $${paramIdx++}::jsonb`);
        values.push(JSON.stringify(filter));
      }

      const safe = this.safeTableName(table);
      const where = conditions.join(" AND ");
      const offset = (page - 1) * limit;

      const countResult = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM "${safe}" WHERE ${where}`,
        values
      );
      const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

      const rowResult = await client.query<Record<string, unknown>>(
        `SELECT * FROM "${safe}" WHERE ${where}
         ORDER BY created_at DESC
         LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
        [...values, limit, offset]
      );

      const events: StoredEvent[] = rowResult.rows.map((row) => {
        const event = this.rowToStoredEvent(row);

        const rawData = event.data as Record<string, unknown> | null;
        const encryptedString =
          rawData && typeof rawData === "object" && "_encrypted" in rawData
            ? (rawData["_encrypted"] as string)
            : undefined;

        if (isEncrypted === true && event.isEncrypted && encryptedString) {
          event.data = this.decryptData(encryptedString, true);
        } else if (encryptedString) {
          // don't expose the raw cipher text to the caller
          event.data = { _encrypted: true };
        }

        return event;
      });

      return {
        success: true,
        data: events,
        total,
        totalPages: Math.ceil(total / limit),
        message: "fetched successfully",
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "unknown error";
      return { success: false, data: [], total: 0, totalPages: 0, message };
    } finally {
      client.release();
    }
  }
}

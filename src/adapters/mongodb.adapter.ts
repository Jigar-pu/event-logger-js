import type { MongoClient, Db, Collection, ObjectId } from "mongodb";
import { BaseAdapter } from "./base.adapter.js";
import {
  AddEventParams,
  AddEventResult,
  GetEventsParams,
  GetEventsResult,
  StoredEvent,
} from "../core/types.js";

interface MongoStoredEvent {
  _id?: ObjectId;
  eventType: string;
  eventName: string;
  data: unknown;
  isEncrypted: boolean;
  isOwn: boolean;
  createdAt: Date;
}

const MASTER_COLLECTION = "master_event_logs";

/**
 * MongoDB adapter for EventLogger.
 *
 * one MongoClient is kept per connection URL in a static registry,
 * so multiple EventLogger instances pointing at the same DB will
 * share a single client instead of opening duplicate connections.
 */
export class MongoAdapter extends BaseAdapter {
  // one MongoClient per URL, shared across all instances pointing at the same DB
  private static readonly _registry = new Map<
    string,
    { client: MongoClient; db: Db }
  >();

  private readonly url: string;

  /**
   * @param url - full MongoDB connection URL
   * e.g. `mongodb://user:pass@localhost:27017/mydb`
   */
  constructor(url: string) {
    super();
    this.url = url;
  }

  /**
   * opens the MongoDB connection and stores it in the shared registry.
   * if a connection for this URL already exists, this does nothing.
   */
  async connect(): Promise<void> {
    if (MongoAdapter._registry.has(this.url)) return;

    try {
      const { MongoClient } = await import("mongodb");
      const client = new MongoClient(this.url);
      await client.connect();
      const db = client.db();

      MongoAdapter._registry.set(this.url, { client, db });
      console.log(`[EventLogger/MongoDB] connected to ${db.databaseName}`);
    } catch (err) {
      console.error("[EventLogger/MongoDB] connection failed:", err);
      throw err;
    }
  }

  /**
   * closes the MongoDB connection and removes it from the registry.
   * after this, the next connect() call will open a fresh connection.
   */
  async disconnect(): Promise<void> {
    const entry = MongoAdapter._registry.get(this.url);
    if (entry) {
      await entry.client.close();
      MongoAdapter._registry.delete(this.url);
      console.log("[EventLogger/MongoDB] disconnected");
    }
  }

  private getDb(): Db {
    const entry = MongoAdapter._registry.get(this.url);
    if (!entry) {
      throw new Error(
        "[EventLogger/MongoDB] not connected. call connect() first."
      );
    }
    return entry.db;
  }

  private getCollection(
    eventType: string,
    isOwn: boolean
  ): Collection<MongoStoredEvent> {
    const name = isOwn
      ? eventType.endsWith("_event_logs")
        ? eventType
        : `${eventType}_event_logs`
      : MASTER_COLLECTION;
    return this.getDb().collection<MongoStoredEvent>(name);
  }

  private toStoredEvent(doc: MongoStoredEvent): StoredEvent {
    return {
      id: doc._id?.toHexString(),
      eventType: doc.eventType,
      eventName: doc.eventName,
      data: doc.data,
      isEncrypted: doc.isEncrypted,
      isOwn: doc.isOwn,
      createdAt: doc.createdAt,
    };
  }

  /**
   * saves an event to MongoDB.
   *
   * @param params.eventType - category of the event, e.g. `"user"`, `"payment"`
   * @param params.eventName - specific event name, e.g. `"user_login"`
   * @param params.data      - the event payload
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
    try {
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

      const { payload, isEncrypted } = this.encryptData(data, encryption);
      const collection = this.getCollection(type, isOwn);

      const doc: MongoStoredEvent = {
        eventType: type,
        eventName,
        data: payload,
        isEncrypted,
        isOwn,
        createdAt: new Date(),
      };

      const result = await collection.insertOne(doc);
      doc._id = result.insertedId;

      return { success: true, data: this.toStoredEvent(doc) };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "unknown error";
      return { success: false, error: message };
    }
  }

  /**
   * fetches events from MongoDB with optional filtering and pagination.
   *
   * @param params.eventType    - the event category to query
   * @param params.eventName    - the specific event name to query
   * @param params.filter       - filter on fields inside the data object, e.g. `{ userId: "123" }`
   * @param params.isFromMaster - query `master_event_logs` instead of the type-specific collection
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
    try {
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

      const collectionName = isFromMaster
        ? MASTER_COLLECTION
        : `${type}_event_logs`;

      const collection =
        this.getDb().collection<MongoStoredEvent>(collectionName);

      const query: Record<string, unknown> = { eventType: type, eventName };
      if (isEncrypted !== undefined) query["isEncrypted"] = isEncrypted;

      // prefix filter keys with "data." to query nested fields
      for (const key in filter) {
        query[`data.${key}`] = filter[key];
      }

      const total = await collection.countDocuments(query);

      const rows = await collection
        .find(query as Parameters<typeof collection.find>[0])
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray();

      const events: StoredEvent[] = rows.map((row) => {
        const decryptedData =
          isEncrypted === true
            ? this.decryptData(row.data, row.isEncrypted)
            : row.data;

        return this.toStoredEvent({ ...row, data: decryptedData });
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
    }
  }
}

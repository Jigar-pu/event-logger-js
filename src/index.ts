// public exports for multi-db-event-logger

export { EventLogger } from "./event-logger.js";

// individual adapters, exposed in case someone wants to use them directly
export { MongoAdapter } from "./adapters/mongodb.adapter.js";
export { PostgresAdapter } from "./adapters/postgres.adapter.js";
export { BaseAdapter } from "./adapters/base.adapter.js";

export { CryptoHelper } from "./core/crypto.js";

// types
export type {
  AddEventParams,
  AddEventResult,
  GetEventsParams,
  GetEventsResult,
  StoredEvent,
  EventLoggerConfig,
  MongoConfig,
  PostgresConfig,
  PostgresParams,
} from "./core/types.js";

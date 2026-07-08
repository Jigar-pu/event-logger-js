# 📋 multi-db-event-logger

A flexible, database-agnostic event logger for Node.js with **MongoDB** and **PostgreSQL** support, AES-256-GCM encryption, and a clean TypeScript-first API.

[![npm version](https://img.shields.io/npm/v/multi-db-event-logger.svg)](https://www.npmjs.com/package/multi-db-event-logger)
[![license](https://img.shields.io/npm/l/multi-db-event-logger.svg)](LICENSE)

<br/>

---

## ✨ Features

- 🗄️ **MongoDB** and **PostgreSQL** support — plug in your URL, done.
- 🔐 **AES-256-GCM** authenticated encryption for sensitive event payloads.
- 📦 **Dynamic collections/tables** — each `eventType` gets its own collection/table, or use a single `master_event_logs`.
- 📄 **Paginated queries** with flexible `data`-field filtering.
- 🟦 **TypeScript-first** with full type exports.
- ⚡ **Dual CJS + ESM** build — works in both `require()` and `import` environments.
- 🪶 **Zero bloat** — no ORM, no framework lock-in.

<br/>

---

## 📦 Installation

```bash
npm install multi-db-event-logger
```

Then install the driver for your database:

```bash
# MongoDB
npm install mongodb

# PostgreSQL
npm install pg
```

<br/>

---

## ⚙️ Quick Start

### MongoDB

```typescript
import { EventLogger } from 'multi-db-event-logger';

const logger = new EventLogger({
  type: 'mongodb',
  url: 'mongodb://localhost:27017/mydb',
});

await logger.connect();

// Log a plain event
await logger.addEvent({
  eventType: 'user',
  eventName: 'user_login',
  data: { userId: '123', ip: '192.168.1.1', browser: 'Chrome' },
  isOwn: true, // stored in `user_event_logs` collection
});

// Log an encrypted event
await logger.addEvent({
  eventType: 'payment',
  eventName: 'card_charged',
  data: { userId: '123', amount: 99.99, card: '4111111111111111' },
  encryption: true,
  isOwn: true,
});

await logger.disconnect();
```

### PostgreSQL

```typescript
import { EventLogger } from 'multi-db-event-logger';

const logger = new EventLogger({
  type: 'postgres',
  url: 'postgres://user:pass@localhost:5432/mydb',
  encryptionKey: 'your-32-byte-secret-key-goes-here', // optional
});

await logger.connect();

await logger.addEvent({
  eventType: 'order',
  eventName: 'order_placed',
  data: { orderId: 'ORD-001', total: 250.00, items: 3 },
  isOwn: true, // stored in `order_event_logs` table
});

await logger.disconnect();
```

> **Note:** Tables are created automatically on first use. No migrations needed.

<br/>

---

## 🔌 Connecting

```typescript
const logger = new EventLogger({ type: 'mongodb', url: '...' });

// connect() is idempotent — safe to call multiple times
await logger.connect();

// Always disconnect when shutting down
process.on('SIGTERM', () => logger.disconnect());
```

<br/>

---

## 📝 `addEvent(params)`

Logs a new event to the database.

| Parameter    | Type      | Required | Default | Description |
|-------------|-----------|----------|---------|-------------|
| `eventType`  | `string`  | ✅ yes   | —       | Event category (e.g. `"user"`, `"payment"`) |
| `eventName`  | `string`  | ✅ yes   | —       | Specific event (e.g. `"user_login"`) |
| `data`       | `object`  | ✅ yes   | —       | JSON payload |
| `encryption` | `boolean` | ❌ no    | `false` | Encrypt data with AES-256-GCM |
| `isOwn`      | `boolean` | ❌ no    | `false` | `true` → `{eventType}_event_logs`, `false` → `master_event_logs` |

```typescript
const result = await logger.addEvent({
  eventType: 'user',
  eventName: 'profile_updated',
  data: { userId: '123', fields: ['email', 'avatar'] },
});

if (result.success) {
  console.log(result.data); // StoredEvent
} else {
  console.error(result.error);
}
```

<br/>

---

## 🔍 `getEvents(params)`

Retrieves events with filtering and pagination.

| Parameter      | Type      | Required | Default | Description |
|---------------|-----------|----------|---------|-------------|
| `eventType`    | `string`  | ✅ yes   | —       | Category to query |
| `eventName`    | `string`  | ✅ yes   | —       | Event name to query |
| `filter`       | `object`  | ❌ no    | `{}`    | Filter on `data` fields, e.g. `{ userId: '123' }` |
| `isFromMaster` | `boolean` | ❌ no    | `false` | Query `master_event_logs` instead of own table |
| `isEncrypted`  | `boolean` | ❌ no    | —       | `true` = encrypted only (auto-decrypted), `false` = plain only |
| `page`         | `number`  | ❌ no    | `1`     | Page number |
| `limit`        | `number`  | ❌ no    | `10`    | Records per page |

```typescript
// Fetch all user login events (page 1, 20 per page)
const result = await logger.getEvents({
  eventType: 'user',
  eventName: 'user_login',
  filter: { userId: '123' }, // filter on data.userId
  page: 1,
  limit: 20,
});

console.log(`Found ${result.total} events across ${result.totalPages} pages`);
console.log(result.data); // StoredEvent[]

// Fetch encrypted payment events (auto-decrypted)
const payments = await logger.getEvents({
  eventType: 'payment',
  eventName: 'card_charged',
  isEncrypted: true,
});
```

<br/>

---

## 🔐 Encryption

Encryption uses **AES-256-GCM** (authenticated encryption). Set a 32-byte key:

```typescript
// Option 1: Pass in config
const logger = new EventLogger({
  type: 'postgres',
  url: '...',
  encryptionKey: 'your-32-byte-secret-key-here!!!!',
});

// Option 2: Environment variable
// ENCRYPTION_KEY=your-32-byte-secret-key-here!!!!
```

> **Important:** The key is padded/truncated to exactly 32 bytes. Use a randomly generated key and **never commit it to version control**.

<br/>

---

## 🗄️ Storage Behaviour

### MongoDB
| `isOwn` | Collection |
|---------|------------|
| `true`  | `{eventType}_event_logs` |
| `false` | `master_event_logs` |

### PostgreSQL
Tables are **auto-created** with this schema:

```sql
CREATE TABLE IF NOT EXISTS "{eventType}_event_logs" (
  id           SERIAL      PRIMARY KEY,
  event_type   VARCHAR(255) NOT NULL,
  event_name   VARCHAR(255) NOT NULL,
  data         JSONB        NOT NULL,
  is_encrypted BOOLEAN      NOT NULL DEFAULT FALSE,
  is_own       BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

Indexes are created automatically on `(event_type, event_name)` and `(created_at DESC)`.

<br/>

---

## 📐 TypeScript Types

```typescript
import type {
  EventLoggerConfig,
  AddEventParams,
  AddEventResult,
  GetEventsParams,
  GetEventsResult,
  StoredEvent,
} from 'multi-db-event-logger';
```

<br/>

---

## 📜 License

MIT © [Jigar Suthar](https://github.com/Jigar-pu)

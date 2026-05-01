import { getConnection, execQuery, runQuery } from './db.js';
import { type HLC, compareHLC } from './hlc.js';
import type { FieldState } from './crdt.js';
import type { FieldDefinition } from './schema-sync.js';

export interface MockCloud {
  push(states: FieldState[]): Promise<void>;
  pull(since: HLC): Promise<FieldState[]>;
  getAll(): Promise<FieldState[]>;
  reset(): Promise<void>;
  pushSchema(objectName: string, version: number, fields: FieldDefinition[]): Promise<void>;
  pullSchema(objectName: string): Promise<{ version: number; fields: FieldDefinition[] } | null>;
}

interface CloudRow {
  entry_id: string;
  field_id: string;
  value: string | null;
  hlc_ts: number;
  hlc_counter: number;
  node_id: string;
}

interface CloudSchemaRow {
  version: number;
  fields_json: string;
}

async function ensureTables(dbPath: string): Promise<void> {
  await execQuery(`
    CREATE TABLE IF NOT EXISTS cloud_sync_state (
      entry_id VARCHAR NOT NULL,
      field_id VARCHAR NOT NULL,
      value VARCHAR,
      hlc_ts BIGINT NOT NULL,
      hlc_counter INTEGER NOT NULL DEFAULT 0,
      node_id VARCHAR NOT NULL,
      PRIMARY KEY (entry_id, field_id)
    )
  `, [], dbPath);
  await execQuery(`
    CREATE TABLE IF NOT EXISTS cloud_schema_versions (
      object_name VARCHAR NOT NULL,
      version INTEGER NOT NULL,
      fields_json VARCHAR NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (object_name)
    )
  `, [], dbPath);
}

export function createMockCloud(dbPath: string): MockCloud {
  let initialized = false;

  async function init(): Promise<void> {
    if (!initialized) {
      await ensureTables(dbPath);
      initialized = true;
    }
  }

  return {
    async push(states: FieldState[]): Promise<void> {
      await init();
      if (states.length === 0) return;

      const conn = await getConnection(dbPath);
      try {
        await conn.run('BEGIN');
        for (const s of states) {
          const existing = await conn.all<CloudRow>(
            'SELECT hlc_ts, hlc_counter, node_id FROM cloud_sync_state WHERE entry_id = ? AND field_id = ?',
            s.entryId,
            s.fieldId,
          );
          if (existing.length > 0) {
            const row = existing[0];
            const existingHlc: HLC = { ts: Number(row.hlc_ts), counter: Number(row.hlc_counter), nodeId: row.node_id };
            if (compareHLC(s.hlc, existingHlc) <= 0) continue;
          }
          await conn.run(
            `INSERT INTO cloud_sync_state (entry_id, field_id, value, hlc_ts, hlc_counter, node_id)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (entry_id, field_id) DO UPDATE SET
               value = excluded.value,
               hlc_ts = excluded.hlc_ts,
               hlc_counter = excluded.hlc_counter,
               node_id = excluded.node_id`,
            s.entryId,
            s.fieldId,
            s.value,
            s.hlc.ts,
            s.hlc.counter,
            s.hlc.nodeId,
          );
        }
        await conn.run('COMMIT');
      } catch (err) {
        await conn.run('ROLLBACK');
        throw err;
      } finally {
        await conn.close();
      }
    },

    async pull(since: HLC): Promise<FieldState[]> {
      await init();
      const rows = await runQuery<CloudRow>(
        `SELECT entry_id, field_id, value, hlc_ts, hlc_counter, node_id
         FROM cloud_sync_state
         WHERE hlc_ts > ? OR (hlc_ts = ? AND hlc_counter > ?)`,
        [since.ts, since.ts, since.counter],
        dbPath,
      );
      return rows.map((r) => ({
        entryId: r.entry_id,
        fieldId: r.field_id,
        value: r.value,
        hlc: { ts: Number(r.hlc_ts), counter: Number(r.hlc_counter), nodeId: r.node_id },
      }));
    },

    async getAll(): Promise<FieldState[]> {
      await init();
      const rows = await runQuery<CloudRow>(
        'SELECT entry_id, field_id, value, hlc_ts, hlc_counter, node_id FROM cloud_sync_state',
        [],
        dbPath,
      );
      return rows.map((r) => ({
        entryId: r.entry_id,
        fieldId: r.field_id,
        value: r.value,
        hlc: { ts: Number(r.hlc_ts), counter: Number(r.hlc_counter), nodeId: r.node_id },
      }));
    },

    async reset(): Promise<void> {
      await init();
      await execQuery('DELETE FROM cloud_sync_state', [], dbPath);
      await execQuery('DELETE FROM cloud_schema_versions', [], dbPath);
    },

    async pushSchema(objectName: string, version: number, fields: FieldDefinition[]): Promise<void> {
      await init();
      const conn = await getConnection(dbPath);
      try {
        await conn.run(
          `INSERT INTO cloud_schema_versions (object_name, version, fields_json)
           VALUES (?, ?, ?)
           ON CONFLICT (object_name) DO UPDATE SET
             version = excluded.version,
             fields_json = excluded.fields_json,
             updated_at = now()`,
          objectName,
          version,
          JSON.stringify(fields),
        );
      } finally {
        await conn.close();
      }
    },

    async pullSchema(objectName: string): Promise<{ version: number; fields: FieldDefinition[] } | null> {
      await init();
      const rows = await runQuery<CloudSchemaRow>(
        'SELECT version, fields_json FROM cloud_schema_versions WHERE object_name = ?',
        [objectName],
        dbPath,
      );
      if (rows.length === 0) return null;
      return {
        version: Number(rows[0].version),
        fields: JSON.parse(rows[0].fields_json) as FieldDefinition[],
      };
    },
  };
}

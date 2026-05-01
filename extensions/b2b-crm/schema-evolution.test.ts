import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, execQuery, getConnection, runQuery } from './db.js';
import { createObjects, createPivotViews, createDynamicPivotView } from './objects.js';
import { createStandaloneTables } from './tables.js';
import {
  getLocalFields,
  getLocalSchemaVersion,
  upsertSchemaVersion,
  computeFieldsHash,
  detectSchemaChanges,
  applySchemaChanges,
  drainPendingFieldValues,
  syncSchemas,
  type FieldDefinition,
} from './schema-sync.js';
import { createMockCloud } from './mock-cloud.js';

// ── helpers ────────────────────────────────────────────────────────────────

let testDir: string;
let localDbPath: string;
let cloudDbPath: string;

async function setupFullDb(dbPath: string): Promise<void> {
  await execQuery(`
    CREATE TABLE IF NOT EXISTS objects (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR,
      name VARCHAR NOT NULL UNIQUE, description VARCHAR,
      default_view VARCHAR, parent_document_id VARCHAR, sort_order INTEGER DEFAULT 0,
      source_app VARCHAR, immutable BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`, [], dbPath);
  await execQuery(`
    CREATE TABLE IF NOT EXISTS fields (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR,
      object_id VARCHAR NOT NULL, name VARCHAR NOT NULL, description VARCHAR,
      type VARCHAR NOT NULL, required BOOLEAN DEFAULT false,
      default_value VARCHAR, related_object_id VARCHAR, relationship_type VARCHAR,
      enum_values JSON, enum_colors JSON, enum_multiple BOOLEAN DEFAULT false,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(object_id, name)
    )`, [], dbPath);
  await execQuery(`
    CREATE TABLE IF NOT EXISTS statuses (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR,
      object_id VARCHAR NOT NULL, name VARCHAR NOT NULL, color VARCHAR,
      sort_order INTEGER DEFAULT 0, is_default BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(object_id, name)
    )`, [], dbPath);
  await execQuery(`
    CREATE TABLE IF NOT EXISTS entries (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR,
      object_id VARCHAR NOT NULL, sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`, [], dbPath);
  await execQuery(`
    CREATE TABLE IF NOT EXISTS entry_fields (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR,
      entry_id VARCHAR NOT NULL, field_id VARCHAR NOT NULL, value VARCHAR,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(entry_id, field_id)
    )`, [], dbPath);
  await execQuery(`
    CREATE TABLE IF NOT EXISTS sync_state (
      entry_id VARCHAR NOT NULL, field_id VARCHAR NOT NULL, value VARCHAR,
      hlc_ts BIGINT NOT NULL, hlc_counter INTEGER NOT NULL DEFAULT 0, node_id VARCHAR NOT NULL,
      PRIMARY KEY (entry_id, field_id)
    )`, [], dbPath);
  await execQuery(`
    CREATE TABLE IF NOT EXISTS pending_field_values (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR,
      entry_id VARCHAR NOT NULL, field_name VARCHAR NOT NULL, value VARCHAR,
      hlc_ts BIGINT NOT NULL, hlc_counter INTEGER NOT NULL, node_id VARCHAR NOT NULL,
      received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`, [], dbPath);
  await execQuery(`
    CREATE TABLE IF NOT EXISTS b2b_crm_schema_version (
      object_name VARCHAR NOT NULL, version INTEGER NOT NULL, fields_hash VARCHAR NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (object_name)
    )`, [], dbPath);
  // Seed objects + fields + pivot views
  await createObjects(dbPath);
  await createPivotViews(dbPath);
}

beforeEach(() => {
  const ts = Date.now();
  testDir = join(tmpdir(), `b2b-schema-test-${ts}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  localDbPath = join(testDir, 'local.duckdb');
  cloudDbPath = join(testDir, 'cloud.duckdb');
});

afterEach(async () => {
  await closeDb(localDbPath);
  await closeDb(cloudDbPath);
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Schema version tracking ───────────────────────────────────────────────

describe('schema version tracking', () => {
  it('upserts version and hash, increments on re-call', async () => {
    await setupFullDb(localDbPath);
    const fields = await getLocalFields('account', localDbPath);
    const hash = computeFieldsHash(fields);
    await upsertSchemaVersion('account', 1, hash, localDbPath);

    const v1 = await getLocalSchemaVersion('account', localDbPath);
    expect(v1?.version).toBe(1);
    expect(v1?.hash).toBe(hash);

    await upsertSchemaVersion('account', 2, 'newhash', localDbPath);
    const v2 = await getLocalSchemaVersion('account', localDbPath);
    expect(v2?.version).toBe(2);
    expect(v2?.hash).toBe('newhash');
  });

  it('migration: version increments when fields change', async () => {
    await setupFullDb(localDbPath);
    const fields = await getLocalFields('account', localDbPath);
    const hash = computeFieldsHash(fields);
    await upsertSchemaVersion('account', 1, hash, localDbPath);

    // Add a field directly (simulating Node A adding it)
    const conn = await getConnection(localDbPath);
    try {
      await conn.run(
        `INSERT INTO fields (id, object_id, name, type, sort_order)
         VALUES ('custom-field-001', (SELECT id FROM objects WHERE name='account'), 'Revenue Segment', 'text', 99)`,
      );
    } finally {
      await conn.close();
    }

    const newFields = await getLocalFields('account', localDbPath);
    const newHash = computeFieldsHash(newFields);
    expect(newHash).not.toBe(hash);
    await upsertSchemaVersion('account', 2, newHash, localDbPath);
    const v2 = await getLocalSchemaVersion('account', localDbPath);
    expect(v2?.version).toBe(2);
  });
});

// ── Field addition sync ───────────────────────────────────────────────────

describe('field addition', () => {
  it('detectSchemaChanges finds new field in remote', async () => {
    await setupFullDb(localDbPath);
    const localFields = await getLocalFields('account', localDbPath);

    const remoteFields: FieldDefinition[] = [
      ...localFields,
      { id: 'custom-field-999', name: 'Revenue Segment', type: 'text', required: false,
        relatedObjectId: null, relationshipType: null, enumValues: null },
    ];

    const changes = detectSchemaChanges('account', localFields, remoteFields);
    const added = changes.filter((c) => c.changeType === 'field_added');
    expect(added).toHaveLength(1);
    expect(added[0].fieldName).toBe('Revenue Segment');
    expect(added[0].fieldDef?.id).toBe('custom-field-999');
  });

  it('applySchemaChanges inserts new field with remote id', async () => {
    await setupFullDb(localDbPath);
    const localFields = await getLocalFields('account', localDbPath);
    const newFieldDef: FieldDefinition = {
      id: 'custom-field-888', name: 'Market Cap', type: 'number', required: false,
      relatedObjectId: null, relationshipType: null, enumValues: null,
    };
    const changes = [{ objectName: 'account', changeType: 'field_added' as const,
      fieldName: 'Market Cap', fieldDef: newFieldDef }];

    await applySchemaChanges(changes, null, localDbPath);

    const newFields = await getLocalFields('account', localDbPath);
    const added = newFields.find((f) => f.name === 'Market Cap');
    expect(added).toBeDefined();
    expect(added?.id).toBe('custom-field-888');
  });

  it('v_account includes new column after applySchemaChanges', async () => {
    await setupFullDb(localDbPath);
    const newFieldDef: FieldDefinition = {
      id: 'custom-field-777', name: 'Tier', type: 'text', required: false,
      relatedObjectId: null, relationshipType: null, enumValues: null,
    };
    const changes = [{ objectName: 'account', changeType: 'field_added' as const,
      fieldName: 'Tier', fieldDef: newFieldDef }];

    await applySchemaChanges(changes, null, localDbPath);

    interface ColRow { column_name: string }
    const cols = await runQuery<ColRow>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'v_account'`,
      [], localDbPath,
    );
    const colNames = cols.map((c) => c.column_name);
    expect(colNames).toContain('Tier');
  });

  it('schema version increments after applySchemaChanges', async () => {
    await setupFullDb(localDbPath);
    const fields = await getLocalFields('account', localDbPath);
    await upsertSchemaVersion('account', 1, computeFieldsHash(fields), localDbPath);

    const newFieldDef: FieldDefinition = {
      id: 'custom-field-555', name: 'Churn Risk', type: 'text', required: false,
      relatedObjectId: null, relationshipType: null, enumValues: null,
    };
    const changes = [{ objectName: 'account', changeType: 'field_added' as const,
      fieldName: 'Churn Risk', fieldDef: newFieldDef }];
    await applySchemaChanges(changes, null, localDbPath);

    const v = await getLocalSchemaVersion('account', localDbPath);
    expect(v?.version).toBeGreaterThanOrEqual(2);
  });
});

// ── Unknown field handling ────────────────────────────────────────────────

describe('unknown field queueing', () => {
  it('stores value in pending_field_values when field_id unknown', async () => {
    await setupFullDb(localDbPath);
    // Simulate receiving a value for an unknown field_id 'xyz-unknown'
    const conn = await getConnection(localDbPath);
    try {
      await conn.run(
        `INSERT INTO pending_field_values (entry_id, field_name, value, hlc_ts, hlc_counter, node_id)
         VALUES ('e1', 'xyz-unknown', '5M', 1000, 0, 'node-A')`,
      );
    } finally {
      await conn.close();
    }

    interface PRow { field_name: string; value: string | null }
    const rows = await runQuery<PRow>(
      `SELECT field_name, value FROM pending_field_values WHERE entry_id = 'e1'`,
      [], localDbPath,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe('5M');
  });

  it('drainPendingFieldValues applies pending values once field exists', async () => {
    await setupFullDb(localDbPath);

    // First create the entry
    const conn = await getConnection(localDbPath);
    try {
      await conn.run(
        `INSERT INTO entries (id, object_id) VALUES ('e1', (SELECT id FROM objects WHERE name='account'))`,
      );
      // Store a pending value with field_name = the field id we're about to create
      await conn.run(
        `INSERT INTO pending_field_values (entry_id, field_name, value, hlc_ts, hlc_counter, node_id)
         VALUES ('e1', 'drain-field-id', 'drainvalue', 1000, 0, 'node-A')`,
      );
    } finally {
      await conn.close();
    }

    // Before field exists: drainPendingFieldValues should drain 0
    const drained1 = await drainPendingFieldValues(localDbPath);
    expect(drained1).toBe(0);

    // Create the field with the known id 'drain-field-id'
    const conn2 = await getConnection(localDbPath);
    try {
      await conn2.run(
        `INSERT INTO fields (id, object_id, name, type, sort_order)
         VALUES ('drain-field-id', (SELECT id FROM objects WHERE name='account'), 'Custom Drain', 'text', 99)`,
      );
    } finally {
      await conn2.close();
    }

    // Now drain should apply the pending value
    const drained2 = await drainPendingFieldValues(localDbPath);
    expect(drained2).toBe(1);

    interface EFRow { value: string | null }
    const efRows = await runQuery<EFRow>(
      `SELECT value FROM entry_fields WHERE entry_id='e1' AND field_id='drain-field-id'`,
      [], localDbPath,
    );
    expect(efRows[0]?.value).toBe('drainvalue');
  });
});

// ── schema sync via MockCloud ─────────────────────────────────────────────

describe('schema sync via cloud', () => {
  it('Node A pushes schema to cloud, Node B receives and applies new field', async () => {
    const nodeADb = join(testDir, 'node-a.duckdb');
    const nodeBDb = join(testDir, 'node-b.duckdb');

    await setupFullDb(nodeADb);
    await setupFullDb(nodeBDb);

    const cloud = createMockCloud(cloudDbPath);

    // Node A adds a custom field
    const connA = await getConnection(nodeADb);
    try {
      await connA.run(
        `INSERT INTO fields (id, object_id, name, type, sort_order)
         VALUES ('cross-field-001', (SELECT id FROM objects WHERE name='account'), 'Revenue Segment', 'text', 99)`,
      );
    } finally {
      await connA.close();
    }

    const nodeAFields = await getLocalFields('account', nodeADb);
    const nodeAHash = computeFieldsHash(nodeAFields);
    await upsertSchemaVersion('account', 2, nodeAHash, nodeADb);

    // Node A syncs schema to cloud
    await syncSchemas(cloud, null, nodeADb);

    // Node B syncs — should detect remote version > local and apply changes
    const nodeBFieldsBefore = await getLocalFields('account', nodeBDb);
    expect(nodeBFieldsBefore.find((f) => f.name === 'Revenue Segment')).toBeUndefined();

    await syncSchemas(cloud, null, nodeBDb);

    const nodeBFieldsAfter = await getLocalFields('account', nodeBDb);
    const added = nodeBFieldsAfter.find((f) => f.name === 'Revenue Segment');
    expect(added).toBeDefined();
    expect(added?.id).toBe('cross-field-001');

    await closeDb(nodeADb);
    await closeDb(nodeBDb);
  });
});

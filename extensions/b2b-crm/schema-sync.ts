import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getConnection, runQuery } from './db.js';
import { createDynamicPivotView } from './objects.js';

export interface FieldDefinition {
  id: string;
  name: string;
  type: string;
  required: boolean;
  relatedObjectId: string | null;
  relationshipType: string | null;
  enumValues: string[] | null;
}

export interface SchemaChange {
  objectName: string;
  changeType: 'field_added' | 'field_removed' | 'field_modified';
  fieldName: string;
  fieldDef?: FieldDefinition;
}

interface FieldRow {
  id: string;
  name: string;
  type: string;
  required: boolean;
  related_object_id: string | null;
  relationship_type: string | null;
  enum_values: string | null;
}

interface SchemaVersionRow {
  version: number;
  fields_hash: string;
}

export function computeFieldsHash(fields: FieldDefinition[]): string {
  const sorted = [...fields].sort((a, b) => a.name.localeCompare(b.name));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

export async function getLocalFields(objectName: string, dbPath?: string): Promise<FieldDefinition[]> {
  const rows = await runQuery<FieldRow>(
    `SELECT f.id, f.name, f.type, f.required, f.related_object_id,
            f.relationship_type, f.enum_values
     FROM fields f
     JOIN objects o ON f.object_id = o.id
     WHERE o.name = ? AND f.type != 'action'
     ORDER BY f.sort_order`,
    [objectName],
    dbPath,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    required: Boolean(r.required),
    relatedObjectId: r.related_object_id ?? null,
    relationshipType: r.relationship_type ?? null,
    enumValues: r.enum_values ? (JSON.parse(r.enum_values) as string[]) : null,
  }));
}

export async function getLocalSchemaVersion(
  objectName: string,
  dbPath?: string,
): Promise<{ version: number; hash: string } | null> {
  const rows = await runQuery<SchemaVersionRow>(
    `SELECT version, fields_hash FROM b2b_crm_schema_version WHERE object_name = ?`,
    [objectName],
    dbPath,
  );
  if (rows.length === 0) return null;
  return { version: Number(rows[0].version), hash: rows[0].fields_hash };
}

export async function upsertSchemaVersion(
  objectName: string,
  version: number,
  hash: string,
  dbPath?: string,
): Promise<void> {
  const conn = await getConnection(dbPath);
  try {
    await conn.run(
      `INSERT INTO b2b_crm_schema_version (object_name, version, fields_hash)
       VALUES (?, ?, ?)
       ON CONFLICT (object_name) DO UPDATE SET
         version = excluded.version,
         fields_hash = excluded.fields_hash,
         updated_at = now()`,
      objectName,
      version,
      hash,
    );
  } finally {
    await conn.close();
  }
}

export function detectSchemaChanges(
  objectName: string,
  localFields: FieldDefinition[],
  remoteFields: FieldDefinition[],
): SchemaChange[] {
  const localByName = new Map(localFields.map((f) => [f.name, f]));
  const remoteByName = new Map(remoteFields.map((f) => [f.name, f]));
  const changes: SchemaChange[] = [];

  for (const [name, remoteDef] of remoteByName) {
    if (!localByName.has(name)) {
      changes.push({ objectName, changeType: 'field_added', fieldName: name, fieldDef: remoteDef });
    } else {
      const local = localByName.get(name)!;
      if (local.type !== remoteDef.type) {
        changes.push({ objectName, changeType: 'field_modified', fieldName: name, fieldDef: remoteDef });
      }
    }
  }

  for (const [name] of localByName) {
    if (!remoteByName.has(name)) {
      changes.push({ objectName, changeType: 'field_removed', fieldName: name });
    }
  }

  return changes;
}

export async function applySchemaChanges(
  changes: SchemaChange[],
  workspacePath: string | null,
  dbPath?: string,
): Promise<void> {
  const addedByObject = new Map<string, SchemaChange[]>();

  for (const change of changes) {
    if (change.changeType !== 'field_added' || !change.fieldDef) continue;
    const list = addedByObject.get(change.objectName) ?? [];
    list.push(change);
    addedByObject.set(change.objectName, list);
  }

  if (addedByObject.size === 0) return;

  const conn = await getConnection(dbPath);
  try {
    await conn.run('BEGIN');
    try {
      for (const [objectName, additions] of addedByObject) {
        for (const change of additions) {
          const def = change.fieldDef!;
          // Insert with the REMOTE field id to ensure cross-node field_id consistency
          await conn.run(
            `INSERT INTO fields (id, object_id, name, type, required, related_object_id,
                                 relationship_type, enum_values, sort_order)
             VALUES (
               ?,
               (SELECT id FROM objects WHERE name = ?),
               ?, ?, ?, ?, ?, ?,
               (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM fields
                WHERE object_id = (SELECT id FROM objects WHERE name = ?))
             )
             ON CONFLICT (object_id, name) DO NOTHING`,
            def.id,
            objectName,
            def.name,
            def.type,
            def.required,
            def.relatedObjectId,
            def.relationshipType,
            def.enumValues ? JSON.stringify(def.enumValues) : null,
            objectName,
          );
        }
      }
      await conn.run('COMMIT');
    } catch (err) {
      await conn.run('ROLLBACK');
      throw err;
    }
  } finally {
    await conn.close();
  }

  // Recreate PIVOT views and update schema versions for changed objects
  for (const [objectName] of addedByObject) {
    await createDynamicPivotView(objectName, dbPath);

    const newFields = await getLocalFields(objectName, dbPath);
    const hash = computeFieldsHash(newFields);
    const current = await getLocalSchemaVersion(objectName, dbPath);
    const newVersion = (current?.version ?? 0) + 1;
    await upsertSchemaVersion(objectName, newVersion, hash, dbPath);

    // Update .object.yaml if workspace path provided
    if (workspacePath) {
      updateObjectYaml(workspacePath, objectName, newFields);
    }
  }
}

function updateObjectYaml(workspacePath: string, objectName: string, fields: FieldDefinition[]): void {
  const dir = join(workspacePath, objectName);
  mkdirSync(dir, { recursive: true });
  const yamlPath = join(dir, '.object.yaml');
  const existing = existsSync(yamlPath) ? readFileSync(yamlPath, 'utf8') : `name: "${objectName}"`;
  const header = existing.split('\nfields:')[0];
  const lines = fields.map((f) => `  - name: "${f.name}"\n    type: ${f.type}`).join('\n');
  writeFileSync(yamlPath, `${header}\nfields:\n${lines}\n`, 'utf8');
}

interface SchemaCloudExchange {
  pushSchema(objectName: string, version: number, fields: FieldDefinition[]): Promise<void>;
  pullSchema(objectName: string): Promise<{ version: number; fields: FieldDefinition[] } | null>;
}

/**
 * Sync schemas for all objects between local node and cloud.
 * Called at the start of each drain cycle before field-level sync.
 */
export async function syncSchemas(
  cloud: SchemaCloudExchange,
  workspacePath: string | null,
  dbPath?: string,
): Promise<void> {
  const objectNames = ['account', 'contact', 'deal'];
  for (const objectName of objectNames) {
    const localFields = await getLocalFields(objectName, dbPath);
    const localVer = await getLocalSchemaVersion(objectName, dbPath);
    const remoteSchema = await cloud.pullSchema(objectName);

    if (!remoteSchema) {
      // Push local schema to cloud so other nodes can discover it
      if (localFields.length > 0) {
        const hash = computeFieldsHash(localFields);
        const version = localVer?.version ?? 1;
        await cloud.pushSchema(objectName, version, localFields);
        if (!localVer) await upsertSchemaVersion(objectName, version, hash, dbPath);
      }
      continue;
    }

    if ((localVer?.version ?? 0) < remoteSchema.version) {
      // Remote is ahead — apply changes
      const changes = detectSchemaChanges(objectName, localFields, remoteSchema.fields);
      if (changes.some((c) => c.changeType === 'field_added')) {
        await applySchemaChanges(changes, workspacePath, dbPath);
      }
    } else if ((localVer?.version ?? 0) > remoteSchema.version) {
      // Local is ahead — push to cloud
      await cloud.pushSchema(objectName, localVer!.version, localFields);
    }
  }
}

interface PendingRow {
  id: string;
  entry_id: string;
  field_name: string;
  value: string | null;
  hlc_ts: number;
  hlc_counter: number;
  node_id: string;
}

/**
 * Drains pending_field_values by resolving field_name → local field_id and
 * writing the values into entry_fields and sync_state.
 * Returns the number of rows drained.
 */
export async function drainPendingFieldValues(dbPath?: string): Promise<number> {
  const rows = await runQuery<PendingRow>(
    `SELECT id, entry_id, field_name, value, hlc_ts, hlc_counter, node_id FROM pending_field_values`,
    [],
    dbPath,
  );
  if (rows.length === 0) return 0;

  const conn = await getConnection(dbPath);
  let drained = 0;
  try {
    for (const row of rows) {
      // field_name here stores the remote field_id (see deviation note in Done.md)
      const fieldRows = await conn.all<{ id: string }>(
        'SELECT id FROM fields WHERE id = ?',
        row.field_name,
      );
      if (fieldRows.length === 0) continue;
      const localFieldId = fieldRows[0].id;

      await conn.run('BEGIN');
      try {
        await conn.run(
          `INSERT INTO entry_fields (entry_id, field_id, value)
           VALUES (?, ?, ?)
           ON CONFLICT (entry_id, field_id) DO UPDATE SET value = excluded.value`,
          row.entry_id, localFieldId, row.value,
        );
        await conn.run(
          `INSERT INTO sync_state (entry_id, field_id, value, hlc_ts, hlc_counter, node_id)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (entry_id, field_id) DO UPDATE SET
             value = excluded.value, hlc_ts = excluded.hlc_ts,
             hlc_counter = excluded.hlc_counter, node_id = excluded.node_id`,
          row.entry_id, localFieldId, row.value,
          Number(row.hlc_ts), Number(row.hlc_counter), row.node_id,
        );
        await conn.run('DELETE FROM pending_field_values WHERE id = ?', row.id);
        await conn.run('COMMIT');
        drained++;
      } catch (err) {
        await conn.run('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await conn.close();
  }
  return drained;
}


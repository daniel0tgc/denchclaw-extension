import { runQuery } from './db.js';

/**
 * Checks existing data in the PIVOT view for exact matches on a field.
 * Returns a Set of values that already exist in the database.
 */
export async function findDuplicates(
  objectName: string,
  field: string,
  values: string[],
  dbPath?: string,
): Promise<Set<string>> {
  if (values.length === 0) return new Set();

  const viewName = `v_${objectName}`;
  const quotedField = `"${field.replace(/"/g, '""')}"`;
  const placeholders = values.map(() => '?').join(', ');

  const rows = await runQuery<Record<string, string>>(
    `SELECT ${quotedField} AS val FROM ${viewName} WHERE ${quotedField} IN (${placeholders})`,
    values,
    dbPath,
  );

  return new Set(rows.map((r) => r['val']).filter(Boolean));
}

/**
 * Separates import rows into unique (safe to import) and duplicate (already exist or
 * duplicated within the batch itself) based on an exact match on the specified field.
 */
export async function deduplicateImport(
  rows: Array<Record<string, string>>,
  objectName: string,
  dedupField: string,
  dbPath?: string,
): Promise<{
  unique: Array<Record<string, string>>;
  duplicates: Array<Record<string, string>>;
}> {
  if (rows.length === 0) return { unique: [], duplicates: [] };

  // Collect all values for the dedup field from the batch
  const batchValues = rows.map((r) => r[dedupField] ?? '').filter(Boolean);

  // Check against existing DB data
  const existingSet = await findDuplicates(objectName, dedupField, batchValues, dbPath);

  const unique: Array<Record<string, string>> = [];
  const duplicates: Array<Record<string, string>> = [];
  const seenInBatch = new Set<string>();

  for (const row of rows) {
    const val = row[dedupField] ?? '';
    if (!val) {
      // No dedup field value — treat as unique
      unique.push(row);
      continue;
    }

    if (existingSet.has(val) || seenInBatch.has(val)) {
      duplicates.push(row);
    } else {
      seenInBatch.add(val);
      unique.push(row);
    }
  }

  return { unique, duplicates };
}

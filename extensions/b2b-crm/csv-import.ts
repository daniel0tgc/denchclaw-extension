import { randomUUID } from 'node:crypto';
import { getConnection, runQuery } from './db.js';

export interface ColumnMapping {
  csvColumn: string;
  objectField: string;
}

export interface ImportResult {
  batchId: string;
  totalRows: number;
  imported: number;
  skipped: number;
  errors: Array<{ row: number; reason: string }>;
}

// ── CSV Parser ──────────────────────────────────────────────────────────────

/**
 * RFC 4180-compliant CSV parser.
 * Handles quoted fields, escaped double-quotes (""), and newlines within quoted fields.
 */
export function parseCSV(content: string): string[][] {
  const rows: string[][] = [];
  let i = 0;
  const len = content.length;

  while (i < len) {
    const row: string[] = [];

    while (i < len) {
      if (content[i] === '"') {
        // Quoted field
        i++; // skip opening quote
        let field = '';
        while (i < len) {
          if (content[i] === '"') {
            if (content[i + 1] === '"') {
              // Escaped quote
              field += '"';
              i += 2;
            } else {
              i++; // skip closing quote
              break;
            }
          } else {
            field += content[i++];
          }
        }
        row.push(field);
      } else {
        // Unquoted field — read until comma or newline
        let field = '';
        while (i < len && content[i] !== ',' && content[i] !== '\n' && content[i] !== '\r') {
          field += content[i++];
        }
        row.push(field);
      }

      if (i < len && content[i] === ',') {
        i++; // next field
        continue;
      }
      break; // end of row
    }

    // Skip \r\n or \n
    if (i < len && content[i] === '\r') i++;
    if (i < len && content[i] === '\n') i++;

    if (row.length > 0 && !(row.length === 1 && row[0] === '')) {
      rows.push(row);
    }
  }
  return rows;
}

// ── Validation ──────────────────────────────────────────────────────────────

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_PROTOCOLS = ['http://', 'https://'];
const DATE_FORMATS = [
  /^\d{4}-\d{2}-\d{2}$/,                     // ISO 8601: YYYY-MM-DD
  /^\d{2}\/\d{2}\/\d{4}$/,                   // MM/DD/YYYY
  /^\d{2}-\d{2}-\d{4}$/,                     // DD-MM-YYYY
];

interface FieldDef {
  id: string;
  name: string;
  type: string;
  required: boolean;
}

function validateValue(value: string, field: FieldDef): string | null {
  if (value === '' || value === null || value === undefined) {
    if (field.required) return `Required field "${field.name}" is missing`;
    return null; // empty optional field is fine
  }

  switch (field.type) {
    case 'email':
      if (!EMAIL_REGEX.test(value)) return `Invalid email address: "${value}"`;
      break;
    case 'number':
      if (Number.isNaN(parseFloat(value))) return `Non-numeric value in number field "${field.name}": "${value}"`;
      break;
    case 'phone': {
      const digits = value.replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15) {
        return `Invalid phone number in "${field.name}": "${value}" (must be 7–15 digits)`;
      }
      break;
    }
    case 'date':
      if (!DATE_FORMATS.some((re) => re.test(value))) {
        return `Invalid date in "${field.name}": "${value}" (expected YYYY-MM-DD, MM/DD/YYYY, or DD-MM-YYYY)`;
      }
      break;
    case 'url':
      if (!URL_PROTOCOLS.some((p) => value.toLowerCase().startsWith(p))) {
        return `Invalid URL in "${field.name}": "${value}" (must start with http:// or https://)`;
      }
      break;
  }
  return null;
}

// ── Import Engine ───────────────────────────────────────────────────────────

/**
 * Imports a CSV string into the EAV schema for the specified object.
 * - Applies column mappings to map CSV headers to EAV field names
 * - Validates each row against field types and required constraints
 * - Skip-and-log: bad rows are written to import_errors, good rows are inserted
 * - Returns a summary with batchId for error review
 */
export async function importCSV(
  csvContent: string,
  objectName: string,
  mappings: ColumnMapping[],
  options: { skipHeader?: boolean; dedup?: boolean; tenantId?: string; dbPath?: string } = {},
): Promise<ImportResult> {
  const { skipHeader = true, dbPath } = options;
  const batchId = randomUUID();
  const result: ImportResult = {
    batchId,
    totalRows: 0,
    imported: 0,
    skipped: 0,
    errors: [],
  };

  const rows = parseCSV(csvContent);
  if (rows.length === 0) return result;

  const dataRows = skipHeader ? rows.slice(1) : rows;
  const headerRow = skipHeader ? rows[0] : null;
  result.totalRows = dataRows.length;

  // Build a column-index map if we have a header row
  const colIndexMap = new Map<string, number>();
  if (headerRow) {
    headerRow.forEach((col, idx) => colIndexMap.set(col.trim(), idx));
  } else {
    // Without header, assume mappings refer to column index order
    mappings.forEach((m, idx) => colIndexMap.set(m.csvColumn, idx));
  }

  // Fetch field definitions for the object
  const fieldDefs = await runQuery<FieldDef>(
    `SELECT f.id, f.name, f.type, f.required
     FROM fields f
     JOIN objects o ON f.object_id = o.id
     WHERE o.name = ? AND f.type != 'action'`,
    [objectName],
    dbPath,
  );
  const fieldByName = new Map(fieldDefs.map((f) => [f.name, f]));

  const objectRows = await runQuery<{ id: string }>(
    `SELECT id FROM objects WHERE name = ?`,
    [objectName],
    dbPath,
  );
  if (objectRows.length === 0) {
    throw new Error(`Object "${objectName}" not found in database`);
  }
  const objectId = objectRows[0].id;

  for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex++) {
    const rawRow = dataRows[rowIndex];
    const rowNum = (skipHeader ? rowIndex + 2 : rowIndex + 1); // 1-based, accounting for header

    // Build field value map from CSV columns using mappings
    const fieldValues = new Map<string, string>();
    for (const mapping of mappings) {
      const colIdx = colIndexMap.get(mapping.csvColumn);
      if (colIdx !== undefined && colIdx < rawRow.length) {
        fieldValues.set(mapping.objectField, rawRow[colIdx].trim());
      }
    }

    // Validate all mapped fields
    let errorReason: string | null = null;
    for (const [fieldName, value] of fieldValues) {
      const fieldDef = fieldByName.get(fieldName);
      if (!fieldDef) continue; // unmapped field — skip silently
      const err = validateValue(value, fieldDef);
      if (err) {
        errorReason = err;
        break;
      }
    }

    // Check required fields that might not be in the CSV
    if (!errorReason) {
      for (const fieldDef of fieldDefs) {
        if (fieldDef.required && !fieldValues.has(fieldDef.name)) {
          // Check if there's a mapping for this required field
          const hasMappingForField = mappings.some((m) => m.objectField === fieldDef.name);
          if (hasMappingForField) {
            errorReason = `Required field "${fieldDef.name}" is missing`;
            break;
          }
        }
      }
    }

    if (errorReason) {
      result.skipped++;
      result.errors.push({ row: rowNum, reason: errorReason });
      // Log to import_errors
      const conn = await getConnection(dbPath);
      try {
        await conn.run(
          `INSERT INTO import_errors (import_batch_id, row_number, raw_data, error_reason)
           VALUES (?, ?, ?, ?)`,
          batchId,
          rowNum,
          JSON.stringify(Object.fromEntries(
            rawRow.map((v, i) => [(headerRow?.[i] ?? String(i)), v]),
          )),
          errorReason,
        );
      } finally {
        await conn.close();
      }
      continue;
    }

    // Insert valid row into EAV tables
    try {
      const entryId = randomUUID();
      const conn = await getConnection(dbPath);
      try {
        await conn.run(
          `INSERT INTO entries (id, object_id) VALUES (?, ?)`,
          entryId,
          objectId,
        );
        for (const [fieldName, value] of fieldValues) {
          if (value === '') continue; // skip empty optional fields
          const fieldDef = fieldByName.get(fieldName);
          if (!fieldDef) continue;
          await conn.run(
            `INSERT INTO entry_fields (entry_id, field_id, value)
             VALUES (?, ?, ?)
             ON CONFLICT (entry_id, field_id) DO UPDATE SET value = excluded.value`,
            entryId,
            fieldDef.id,
            value,
          );
        }
      } finally {
        await conn.close();
      }
      result.imported++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result.skipped++;
      result.errors.push({ row: rowNum, reason });
      const conn = await getConnection(dbPath);
      try {
        await conn.run(
          `INSERT INTO import_errors (import_batch_id, row_number, raw_data, error_reason)
           VALUES (?, ?, ?, ?)`,
          batchId,
          rowNum,
          JSON.stringify(Object.fromEntries(
            rawRow.map((v, i) => [(headerRow?.[i] ?? String(i)), v]),
          )),
          reason,
        );
      } finally {
        await conn.close();
      }
    }
  }

  return result;
}

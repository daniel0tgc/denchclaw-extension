import { getConnection, runQuery } from './db.js';
import type { FilterGroup } from './filters.js';
import { buildFilterSQL } from './filters.js';

/**
 * Escapes a single CSV cell value per RFC 4180.
 * Values containing commas, double-quotes, or newlines are quoted.
 * Double-quotes inside values are escaped as "".
 */
function escapeCSVCell(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Converts an array of rows (objects) to a RFC 4180 CSV string.
 */
function rowsToCSV(rows: Record<string, unknown>[], columns: string[]): string {
  if (rows.length === 0) {
    return columns.map(escapeCSVCell).join(',') + '\r\n';
  }

  const lines: string[] = [];
  // Header
  lines.push(columns.map(escapeCSVCell).join(','));
  // Data rows
  for (const row of rows) {
    const cells = columns.map((col) => {
      const val = row[col];
      if (val === null || val === undefined) return '';
      return escapeCSVCell(String(val));
    });
    lines.push(cells.join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * Exports data from a PIVOT view as a RFC 4180 CSV string.
 *
 * @param objectName - Name of the EAV object (account, contact, deal)
 * @param fields - Specific fields to export. If omitted, all columns from the view are exported.
 * @param filter - Optional FilterGroup to restrict which rows are exported.
 * @param dbPath - Optional DuckDB path (defaults to workspace.duckdb)
 */
export async function exportCSV(
  objectName: string,
  fields?: string[],
  filter?: FilterGroup,
  dbPath?: string,
): Promise<string> {
  const viewName = `v_${objectName}`;

  // Determine which columns to export
  let columns: string[];
  if (fields && fields.length > 0) {
    columns = fields;
  } else {
    // Fetch all column names from the view via information_schema
    const colRows = await runQuery<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = ?
       ORDER BY ordinal_position`,
      [viewName],
      dbPath,
    );
    columns = colRows.map((r) => r.column_name);
  }

  if (columns.length === 0) {
    return '';
  }

  // Build the SELECT with quoted column names
  const quotedCols = columns
    .map((c) => `"${c.replace(/"/g, '""')}" AS "${c.replace(/"/g, '""')}"`)
    .join(', ');

  let sql: string;
  let params: unknown[];

  if (filter) {
    const filtered = buildFilterSQL(filter, viewName);
    // Replace "SELECT *" with our quoted column projection
    sql = filtered.sql.replace(/^SELECT \*/, `SELECT ${quotedCols}`);
    params = filtered.params;
  } else {
    sql = `SELECT ${quotedCols} FROM ${viewName}`;
    params = [];
  }

  const conn = await getConnection(dbPath);
  let rows: Record<string, unknown>[];
  try {
    rows = (await conn.all(sql, ...params)) as Record<string, unknown>[];
  } finally {
    await conn.close();
  }

  return rowsToCSV(rows, columns);
}

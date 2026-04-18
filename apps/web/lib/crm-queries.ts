/**
 * Shared DuckDB query helpers for the CRM API routes.
 *
 * Centralizes the field-map loading + relation parsing pattern so each
 * route doesn't reimplement it (and so we keep all SQL in one place we
 * can audit for SQL injection / quoting bugs).
 *
 * All queries use the lock-aware `duckdbQueryAsync` from `workspace.ts`.
 * Field-map lookups are serialized — concurrent duckdb CLI processes
 * thrash the file lock and most return empty silently (we learned this
 * the hard way during the Gmail sync work).
 */

import { duckdbQueryAsync } from "./workspace";
import {
  ONBOARDING_OBJECT_IDS,
  fetchFieldIdMap,
} from "./workspace-schema-migrations";

// ---------------------------------------------------------------------------
// Field-map cache
// ---------------------------------------------------------------------------

export type CrmFieldMaps = {
  people: Record<string, string>;
  company: Record<string, string>;
  email_thread: Record<string, string>;
  email_message: Record<string, string>;
  calendar_event: Record<string, string>;
  interaction: Record<string, string>;
};

let cachedMaps: CrmFieldMaps | null = null;

/**
 * Load field-id maps for every CRM object. Cached for the lifetime of
 * the Next.js process — field IDs are stable across migrations (we use
 * `seed_fld_*` literals everywhere) so this is safe.
 */
export async function loadCrmFieldMaps(force = false): Promise<CrmFieldMaps> {
  if (cachedMaps && !force) {return cachedMaps;}

  // Sequential to avoid lock contention.
  const people = await fetchFieldIdMap(ONBOARDING_OBJECT_IDS.people);
  const company = await fetchFieldIdMap(ONBOARDING_OBJECT_IDS.company);
  const email_thread = await fetchFieldIdMap(ONBOARDING_OBJECT_IDS.email_thread);
  const email_message = await fetchFieldIdMap(ONBOARDING_OBJECT_IDS.email_message);
  const calendar_event = await fetchFieldIdMap(ONBOARDING_OBJECT_IDS.calendar_event);
  const interaction = await fetchFieldIdMap(ONBOARDING_OBJECT_IDS.interaction);

  cachedMaps = { people, company, email_thread, email_message, calendar_event, interaction };
  return cachedMaps;
}

/** Reset the cache — useful for tests after a schema migration. */
export function clearCrmFieldMapCache(): void {
  cachedMaps = null;
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

/** Single-quote-escape a string for inline SQL embedding. */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Build a JSON-array LIKE predicate for "find rows where this relation array contains <id>". */
export function jsonArrayContains(columnExpr: string, id: string): string {
  const safeId = id.replace(/'/g, "''").replace(/"/g, '""');
  return `${columnExpr} LIKE '%"${safeId}"%'`;
}

// ---------------------------------------------------------------------------
// Common pivot helpers
// ---------------------------------------------------------------------------

/**
 * Build a pivot subquery that returns one row per `entry.id` with each
 * named field as a column. Wraps the standard `entries × entry_fields`
 * join with a SELECT ... MAX(CASE WHEN ...) construction so we can
 * project arbitrary fields without hitting the v_* PIVOT views (which
 * sometimes lag behind a recent migration).
 *
 * Returned columns: `entry_id`, `created_at`, `updated_at`, plus one
 * column per `aliasedFields` entry (alias used as the column name).
 */
export function buildEntryProjection(params: {
  objectId: string;
  fieldMap: Record<string, string>;
  aliasedFields: Array<{ name: string; alias: string }>;
  whereSql?: string;
  orderBySql?: string;
  limit?: number;
}): string {
  const objectId = params.objectId.replace(/'/g, "''");
  const projections = params.aliasedFields
    .map(({ name, alias }) => {
      const fieldId = params.fieldMap[name];
      if (!fieldId) {
        return `NULL AS "${alias}"`;
      }
      const safeId = fieldId.replace(/'/g, "''");
      return `MAX(CASE WHEN ef.field_id = '${safeId}' THEN ef.value END) AS "${alias}"`;
    })
    .join(",\n      ");

  const where = params.whereSql ? `AND ${params.whereSql}` : "";
  const order = params.orderBySql ? `ORDER BY ${params.orderBySql}` : "";
  const limit = params.limit !== undefined ? `LIMIT ${Math.max(0, Math.floor(params.limit))}` : "";

  return `
    SELECT
      e.id AS entry_id,
      e.created_at,
      e.updated_at,
      ${projections}
    FROM entries e
    LEFT JOIN entry_fields ef ON ef.entry_id = e.id
    WHERE e.object_id = '${objectId}'
      ${where}
    GROUP BY e.id, e.created_at, e.updated_at
    ${order}
    ${limit}
  `;
}

/**
 * Wrap `buildEntryProjection` in a subquery so the caller can reorder
 * by a derived column (e.g. `TRY_CAST("Strength Score" AS DOUBLE) DESC`).
 */
export function wrapForOrderedAccess(
  projection: string,
  order: string,
  limit?: number,
): string {
  const limitClause = limit !== undefined ? `LIMIT ${Math.max(0, Math.floor(limit))}` : "";
  return `
    SELECT * FROM (${projection}) sub
    ${order ? `ORDER BY ${order}` : ""}
    ${limitClause}
  `;
}

// ---------------------------------------------------------------------------
// Run a query with a tiny error guard. We don't want one missing field
// or a transient lock to crash the whole route.
// ---------------------------------------------------------------------------

export async function safeQuery<T = Record<string, unknown>>(
  sql: string,
  fallback: T[] = [],
): Promise<T[]> {
  try {
    return await duckdbQueryAsync<T>(sql);
  } catch {
    return fallback;
  }
}

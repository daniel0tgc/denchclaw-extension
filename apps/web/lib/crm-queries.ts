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

// ---------------------------------------------------------------------------
// Latest-message-per-thread aggregate
// ---------------------------------------------------------------------------

/**
 * Build the SQL fragment that produces a `latest_msg` CTE row per
 * thread, projecting:
 *   - thread_id          → email_thread.entry_id this latest msg belongs to
 *   - sender_type        → Sender Type of the message with max sent_at
 *   - snippet            → Body Preview of the same message
 *   - from_person_id     → email_message.From relation entry_id
 *
 * Returns `null` when the email_message field map is missing the
 * critical Thread / Sent At fields (i.e. fresh / un-migrated workspace),
 * so the caller can branch and emit a no-aggregate fallback.
 *
 * If `candidateThreadIdsCte` is provided, the message scan is restricted
 * to threads whose id is in that CTE — dramatically cheaper when only a
 * small windowed set of threads is needed (the Inbox uses this; Person /
 * Company profile pages use it too).
 */
export function buildLatestMessagePerThreadCte(params: {
  emailMessageFieldMap: Record<string, string>;
  /** Name of an upstream CTE that yields a single column `entry_id`. */
  candidateThreadIdsCte?: string;
}): { cte: string; joinClause: string } | null {
  const fm = params.emailMessageFieldMap;
  const threadFieldId = fm["Thread"];
  const sentFieldId = fm["Sent At"];
  if (!threadFieldId || !sentFieldId) {return null;}

  const senderTypeFieldId = fm["Sender Type"];
  const previewFieldId = fm["Body Preview"];
  const fromFieldId = fm["From"];

  const fieldIdsInJoin = [threadFieldId, sentFieldId];
  if (senderTypeFieldId) {fieldIdsInJoin.push(senderTypeFieldId);}
  if (previewFieldId) {fieldIdsInJoin.push(previewFieldId);}
  if (fromFieldId) {fieldIdsInJoin.push(fromFieldId);}
  const inList = fieldIdsInJoin.map((id) => `'${id.replace(/'/g, "''")}'`).join(", ");

  const candidateFilter = params.candidateThreadIdsCte
    ? `WHERE m.thread_value IN (SELECT entry_id FROM ${params.candidateThreadIdsCte})`
    : `WHERE m.thread_value IS NOT NULL`;

  const cte = `
    latest_msg AS (
      SELECT
        thread_value AS thread_id,
        ${senderTypeFieldId ? "ARG_MAX(sender_type_value, sent_at_value)" : "NULL"} AS sender_type,
        ${previewFieldId ? "ARG_MAX(preview_value, sent_at_value)" : "NULL"} AS snippet,
        ${fromFieldId ? "ARG_MAX(from_value, sent_at_value)" : "NULL"} AS from_person_id
      FROM (
        SELECT
          e.id AS msg_id,
          MAX(CASE WHEN ef.field_id = '${threadFieldId}' THEN ef.value END) AS thread_value,
          MAX(CASE WHEN ef.field_id = '${sentFieldId}' THEN ef.value END) AS sent_at_value,
          ${senderTypeFieldId ? `MAX(CASE WHEN ef.field_id = '${senderTypeFieldId}' THEN ef.value END)` : "NULL"} AS sender_type_value,
          ${previewFieldId ? `MAX(CASE WHEN ef.field_id = '${previewFieldId}' THEN ef.value END)` : "NULL"} AS preview_value,
          ${fromFieldId ? `MAX(CASE WHEN ef.field_id = '${fromFieldId}' THEN ef.value END)` : "NULL"} AS from_value
        FROM entries e
        JOIN entry_fields ef
          ON ef.entry_id = e.id
         AND ef.field_id IN (${inList})
        WHERE e.object_id = '${ONBOARDING_OBJECT_IDS.email_message}'
        GROUP BY e.id
      ) m
      ${candidateFilter}
      GROUP BY thread_value
    )
  `;

  return {
    cte,
    joinClause: "LEFT JOIN latest_msg ON latest_msg.thread_id = base.entry_id",
  };
}

// ---------------------------------------------------------------------------
// People hydration by id
// ---------------------------------------------------------------------------

export type ParticipantRow = {
  id: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
};

/**
 * Bulk-hydrate a set of People entries by id. Returns a Map keyed by
 * person entry_id. Quietly tolerates missing field-map entries (returns
 * an empty map instead of throwing) so a partially-migrated workspace
 * never breaks the caller's UX.
 */
export async function hydratePeopleByIds(
  peopleIds: ReadonlyArray<string>,
  peopleFieldMap: Record<string, string>,
): Promise<Map<string, ParticipantRow>> {
  const map = new Map<string, ParticipantRow>();
  if (peopleIds.length === 0) {return map;}

  const nameFieldId = peopleFieldMap["Full Name"];
  const emailFieldId = peopleFieldMap["Email Address"];
  const avatarFieldId = peopleFieldMap["Avatar URL"];
  if (!nameFieldId && !emailFieldId) {return map;}

  const inList = peopleIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(", ");
  const sql = `
    SELECT
      e.id AS person_id,
      ${nameFieldId ? `MAX(CASE WHEN ef.field_id = '${nameFieldId}' THEN ef.value END)` : "NULL"} AS name,
      ${emailFieldId ? `MAX(CASE WHEN ef.field_id = '${emailFieldId}' THEN ef.value END)` : "NULL"} AS email,
      ${avatarFieldId ? `MAX(CASE WHEN ef.field_id = '${avatarFieldId}' THEN ef.value END)` : "NULL"} AS avatar_url
    FROM entries e
    LEFT JOIN entry_fields ef ON ef.entry_id = e.id
    WHERE e.object_id = '${ONBOARDING_OBJECT_IDS.people}'
      AND e.id IN (${inList})
    GROUP BY e.id;
  `;
  const rows = await safeQuery<{
    person_id: string;
    name: string | null;
    email: string | null;
    avatar_url: string | null;
  }>(sql);
  for (const row of rows) {
    map.set(row.person_id, {
      id: row.person_id,
      name: row.name,
      email: row.email,
      avatar_url: row.avatar_url,
    });
  }
  return map;
}

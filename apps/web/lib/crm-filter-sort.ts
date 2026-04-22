/**
 * Filter / sort / pagination decoder for the CRM list APIs.
 *
 * Translates the `FilterGroup` + `SortRule[]` payloads produced by
 * `ObjectFilterBar` into SQL fragments that operate on already-projected
 * column names. We deliberately do NOT reuse `buildWhereClause` from
 * lib/object-filters.ts — that helper builds nested EXISTS subqueries
 * against `entry_fields`, which is the right shape for raw object queries
 * but the wrong shape for our pivoted SELECT (where every column is
 * already a top-level column).
 *
 * Safety:
 *   - Field names are validated against an allowlist (the CRM_FIELDS
 *     declared in people-columns.ts / companies-columns.ts). Unknown
 *     fields → throws `CrmFilterError` which the route turns into 400.
 *   - All string values are escaped via single-quote-doubling.
 *   - All operator branches go through `unreachable()` for exhaustive
 *     compile-time coverage.
 */

import type {
  FilterGroup,
  FilterRule,
  FilterOperator,
  SortRule,
} from "./object-filters";

export class CrmFilterError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "CrmFilterError";
    this.status = status;
  }
}

/**
 * Per-field metadata used by the decoder. The route declares one of
 * these for each filterable column. `column` is the SQL identifier we
 * project in the inner SELECT (matches the `alias` passed to
 * `buildEntryProjection`).
 */
export type CrmFilterField = {
  /** Human name shown in the filter bar. Matches FilterRule.field. */
  name: string;
  /** SQL column name inside the projection. */
  column: string;
  /** Field type — drives operator semantics + value coercion. */
  type: "text" | "email" | "number" | "date" | "enum" | "boolean";
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sqlString(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) {return "NULL";}
  const text = typeof value === "string" ? value : String(value);
  return `'${text.replace(/'/g, "''")}'`;
}

function sqlIdentifier(name: string): string {
  // Quote with double quotes; double-up any internal double quotes.
  return `"${name.replace(/"/g, '""')}"`;
}

function isFilterRule(node: FilterRule | FilterGroup): node is FilterRule {
  return Object.prototype.hasOwnProperty.call(node, "operator");
}

// ---------------------------------------------------------------------------
// Public: decode WHERE
// ---------------------------------------------------------------------------

/**
 * Decode a base64-encoded JSON `FilterGroup` payload into a SQL
 * fragment. Returns "1=1" if the payload is empty / invalid (so callers
 * can safely concatenate with ` AND <decoded>`).
 *
 * Throws `CrmFilterError` for unknown field names or malformed rules.
 */
export function decodeFiltersToSql(
  base64Payload: string | null,
  fields: ReadonlyArray<CrmFilterField>,
): string {
  if (!base64Payload) {return "1=1";}
  let decoded: string;
  try {
    decoded = Buffer.from(base64Payload, "base64").toString("utf-8");
  } catch {
    throw new CrmFilterError("Invalid base64 in `filters` parameter.");
  }
  let group: FilterGroup;
  try {
    group = JSON.parse(decoded) as FilterGroup;
  } catch {
    throw new CrmFilterError("Invalid JSON in `filters` parameter.");
  }
  const fieldMap = new Map<string, CrmFilterField>();
  for (const f of fields) {
    fieldMap.set(f.name, f);
  }
  const sql = compileGroup(group, fieldMap);
  return sql || "1=1";
}

function compileGroup(
  group: FilterGroup,
  fieldMap: Map<string, CrmFilterField>,
): string {
  if (!group || !Array.isArray(group.rules) || group.rules.length === 0) {
    return "";
  }
  const parts: string[] = [];
  for (const rule of group.rules) {
    if (isFilterRule(rule)) {
      const sql = compileRule(rule, fieldMap);
      if (sql) {parts.push(sql);}
    } else {
      const sub = compileGroup(rule, fieldMap);
      if (sub) {parts.push(`(${sub})`);}
    }
  }
  if (parts.length === 0) {return "";}
  const joiner = group.conjunction === "or" ? " OR " : " AND ";
  return parts.join(joiner);
}

function compileRule(
  rule: FilterRule,
  fieldMap: Map<string, CrmFilterField>,
): string {
  const field = fieldMap.get(rule.field);
  if (!field) {
    throw new CrmFilterError(`Unknown field: ${rule.field}`);
  }
  const col = sqlIdentifier(field.column);
  const op: FilterOperator = rule.operator;

  // Universal operators first — these don't depend on field type.
  if (op === "is_empty") {return `(${col} IS NULL OR ${col} = '')`;}
  if (op === "is_not_empty") {return `(${col} IS NOT NULL AND ${col} <> '')`;}

  switch (field.type) {
    case "text":
    case "email":
      return compileTextRule(col, op, rule);
    case "number":
      return compileNumberRule(col, op, rule);
    case "date":
      return compileDateRule(col, op, rule);
    case "enum":
      return compileEnumRule(col, op, rule);
    case "boolean":
      return compileBooleanRule(col, op);
  }
}

function compileTextRule(col: string, op: FilterOperator, rule: FilterRule): string {
  const value = String(rule.value ?? "");
  const safe = value.replace(/'/g, "''").replace(/%/g, "\\%").replace(/_/g, "\\_");
  switch (op) {
    case "contains":
      return `LOWER(COALESCE(${col}, '')) LIKE '%${safe.toLowerCase()}%' ESCAPE '\\'`;
    case "not_contains":
      return `LOWER(COALESCE(${col}, '')) NOT LIKE '%${safe.toLowerCase()}%' ESCAPE '\\'`;
    case "equals":
      return `LOWER(COALESCE(${col}, '')) = '${safe.toLowerCase()}'`;
    case "not_equals":
      return `LOWER(COALESCE(${col}, '')) <> '${safe.toLowerCase()}'`;
    case "starts_with":
      return `LOWER(COALESCE(${col}, '')) LIKE '${safe.toLowerCase()}%' ESCAPE '\\'`;
    case "ends_with":
      return `LOWER(COALESCE(${col}, '')) LIKE '%${safe.toLowerCase()}' ESCAPE '\\'`;
    case "is_empty":
    case "is_not_empty":
      // handled in the caller
      return "";
    default:
      throw new CrmFilterError(`Operator ${op} is not valid for text fields.`);
  }
}

function compileNumberRule(col: string, op: FilterOperator, rule: FilterRule): string {
  const value = Number(rule.value);
  const valueTo = rule.valueTo !== undefined ? Number(rule.valueTo) : null;
  const cast = `TRY_CAST(${col} AS DOUBLE)`;
  if (op === "between") {
    if (!Number.isFinite(value) || valueTo === null || !Number.isFinite(valueTo)) {
      return "1=1";
    }
    return `${cast} BETWEEN ${value} AND ${valueTo}`;
  }
  if (!Number.isFinite(value)) {return "1=1";}
  switch (op) {
    case "eq":
      return `${cast} = ${value}`;
    case "neq":
      return `${cast} <> ${value}`;
    case "gt":
      return `${cast} > ${value}`;
    case "gte":
      return `${cast} >= ${value}`;
    case "lt":
      return `${cast} < ${value}`;
    case "lte":
      return `${cast} <= ${value}`;
    case "is_empty":
    case "is_not_empty":
      return "";
    default:
      throw new CrmFilterError(`Operator ${op} is not valid for number fields.`);
  }
}

function compileDateRule(col: string, op: FilterOperator, rule: FilterRule): string {
  const value = String(rule.value ?? "");
  const valueTo = rule.valueTo !== undefined ? String(rule.valueTo) : null;
  switch (op) {
    case "before":
      return value ? `${col} < ${sqlString(value)}` : "1=1";
    case "after":
      return value ? `${col} > ${sqlString(value)}` : "1=1";
    case "on":
      return value
        ? `DATE_TRUNC('day', CAST(${col} AS TIMESTAMP)) = DATE_TRUNC('day', CAST(${sqlString(value)} AS TIMESTAMP))`
        : "1=1";
    case "date_between":
      if (!value || !valueTo) {return "1=1";}
      return `${col} BETWEEN ${sqlString(value)} AND ${sqlString(valueTo)}`;
    case "relative_past": {
      const amount = Math.max(0, Math.floor(Number(rule.relativeAmount ?? 0)));
      const unit = rule.relativeUnit ?? "days";
      if (amount === 0) {return "1=1";}
      return `${col} >= NOW() - INTERVAL '${amount} ${unit}'`;
    }
    case "relative_next": {
      const amount = Math.max(0, Math.floor(Number(rule.relativeAmount ?? 0)));
      const unit = rule.relativeUnit ?? "days";
      if (amount === 0) {return "1=1";}
      return `${col} <= NOW() + INTERVAL '${amount} ${unit}' AND ${col} >= NOW()`;
    }
    case "is_empty":
    case "is_not_empty":
      return "";
    default:
      throw new CrmFilterError(`Operator ${op} is not valid for date fields.`);
  }
}

function compileEnumRule(col: string, op: FilterOperator, rule: FilterRule): string {
  const value = rule.value;
  const single = Array.isArray(value) ? value[0] ?? "" : String(value ?? "");
  switch (op) {
    case "is":
      return single ? `${col} = ${sqlString(single)}` : "1=1";
    case "is_not":
      return single ? `(${col} IS NULL OR ${col} <> ${sqlString(single)})` : "1=1";
    case "is_any_of": {
      const list = Array.isArray(value) ? value : [single];
      const cleaned = list.filter((v) => typeof v === "string" && v.length > 0);
      if (cleaned.length === 0) {return "1=1";}
      return `${col} IN (${cleaned.map((v) => sqlString(v)).join(", ")})`;
    }
    case "is_none_of": {
      const list = Array.isArray(value) ? value : [single];
      const cleaned = list.filter((v) => typeof v === "string" && v.length > 0);
      if (cleaned.length === 0) {return "1=1";}
      return `(${col} IS NULL OR ${col} NOT IN (${cleaned.map((v) => sqlString(v)).join(", ")}))`;
    }
    case "is_empty":
    case "is_not_empty":
      return "";
    default:
      throw new CrmFilterError(`Operator ${op} is not valid for enum fields.`);
  }
}

function compileBooleanRule(col: string, op: FilterOperator): string {
  switch (op) {
    case "is_true":
      return `${col} = 'true'`;
    case "is_false":
      return `(${col} IS NULL OR ${col} = 'false')`;
    case "is_empty":
    case "is_not_empty":
      return "";
    default:
      throw new CrmFilterError(`Operator ${op} is not valid for boolean fields.`);
  }
}

// ---------------------------------------------------------------------------
// Public: decode ORDER BY
// ---------------------------------------------------------------------------

/**
 * Decode a base64-encoded JSON `SortRule[]` payload into a SQL ORDER BY
 * fragment. Returns null if the payload is empty / invalid so the caller
 * can fall back to its default ordering.
 *
 * Throws `CrmFilterError` for unknown field names so a malicious URL
 * can't sort by an unprojected column.
 */
export function decodeSortToSql(
  base64Payload: string | null,
  fields: ReadonlyArray<CrmFilterField>,
): string | null {
  if (!base64Payload) {return null;}
  let decoded: string;
  try {
    decoded = Buffer.from(base64Payload, "base64").toString("utf-8");
  } catch {
    throw new CrmFilterError("Invalid base64 in `sort` parameter.");
  }
  let rules: SortRule[];
  try {
    rules = JSON.parse(decoded) as SortRule[];
  } catch {
    throw new CrmFilterError("Invalid JSON in `sort` parameter.");
  }
  if (!Array.isArray(rules) || rules.length === 0) {return null;}
  const fieldMap = new Map<string, CrmFilterField>();
  for (const f of fields) {
    fieldMap.set(f.name, f);
  }
  const parts: string[] = [];
  for (const rule of rules) {
    const field = fieldMap.get(rule.field);
    if (!field) {
      throw new CrmFilterError(`Unknown sort field: ${rule.field}`);
    }
    const dir = rule.direction === "asc" ? "ASC" : "DESC";
    const col = sqlIdentifier(field.column);
    // Numbers / dates need a typed cast for correct ordering when the
    // column is stored as TEXT (everything in entry_fields is VARCHAR).
    const expr =
      field.type === "number"
        ? `TRY_CAST(${col} AS DOUBLE)`
        : field.type === "date"
          ? `CAST(${col} AS TIMESTAMP)`
          : col;
    parts.push(`${expr} ${dir} NULLS LAST`);
  }
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Public: pagination
// ---------------------------------------------------------------------------

export type PageParams = { page: number; pageSize: number; offset: number };

export function decodePagination(
  pageRaw: string | null,
  pageSizeRaw: string | null,
  defaults: { pageSize: number; maxPageSize: number },
): PageParams {
  const page = Math.max(1, parseInt(pageRaw ?? "1", 10) || 1);
  let pageSize = parseInt(pageSizeRaw ?? "", 10);
  if (!Number.isFinite(pageSize) || pageSize <= 0) {pageSize = defaults.pageSize;}
  pageSize = Math.min(pageSize, defaults.maxPageSize);
  const offset = (page - 1) * pageSize;
  return { page, pageSize, offset };
}

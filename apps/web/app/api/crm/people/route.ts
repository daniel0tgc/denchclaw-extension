import {
  ONBOARDING_OBJECT_IDS,
} from "@/lib/workspace-schema-migrations";
import {
  buildEntryProjection,
  loadCrmFieldMaps,
  safeQuery,
} from "@/lib/crm-queries";
import { getConnectionStrengthBucket } from "@/lib/connection-strength-label";
import {
  CrmFilterError,
  decodeFiltersToSql,
  decodePagination,
  decodeSortToSql,
  type CrmFilterField,
} from "@/lib/crm-filter-sort";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type PersonRow = {
  id: string;
  name: string | null;
  email: string | null;
  company_name: string | null;
  job_title: string | null;
  source: string | null;
  strength_score: number | null;
  strength_label: string;
  strength_color: string;
  last_interaction_at: string | null;
  avatar_url: string | null;
};

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

const VALID_PRESET_FILTERS = new Set(["all", "strongest", "going_cold", "recent"]);
type PresetFilter = "all" | "strongest" | "going_cold" | "recent";

/**
 * Filterable + sortable column allowlist for People. Names mirror the
 * fields shown in ObjectFilterBar; columns mirror the projection
 * aliases below. Anything not in this list is rejected by the decoder.
 */
const PEOPLE_FILTER_FIELDS: ReadonlyArray<CrmFilterField> = [
  { name: "Full Name", column: "name", type: "text" },
  { name: "Email Address", column: "email", type: "email" },
  { name: "Company", column: "company_name", type: "text" },
  { name: "Job Title", column: "job_title", type: "text" },
  { name: "Strength Label", column: "strength_label", type: "enum" },
  { name: "Strength Score", column: "strength_score", type: "number" },
  { name: "Last Interaction At", column: "last_interaction_at", type: "date" },
  { name: "Source", column: "source", type: "enum" },
];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const search = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
  const filterRaw = url.searchParams.get("filter") ?? "strongest";
  const presetFilter: PresetFilter = (VALID_PRESET_FILTERS.has(filterRaw) ? filterRaw : "strongest") as PresetFilter;
  const filtersParam = url.searchParams.get("filters");
  const sortParam = url.searchParams.get("sort");
  const pagination = decodePagination(
    url.searchParams.get("page"),
    url.searchParams.get("pageSize") ?? url.searchParams.get("limit"),
    { pageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE },
  );
  // Back-compat: `offset` was the original pagination knob; keep it
  // working even though new clients use `page` exclusively.
  const offsetOverride = url.searchParams.get("offset");
  const offset =
    offsetOverride !== null && offsetOverride !== ""
      ? Math.max(0, parseInt(offsetOverride, 10) || 0)
      : pagination.offset;

  const fieldMaps = await loadCrmFieldMaps();
  const projection = buildEntryProjection({
    objectId: ONBOARDING_OBJECT_IDS.people,
    fieldMap: fieldMaps.people,
    aliasedFields: [
      { name: "Full Name", alias: "name" },
      { name: "Email Address", alias: "email" },
      { name: "Company", alias: "company_name" },
      { name: "Job Title", alias: "job_title" },
      { name: "Source", alias: "source" },
      { name: "Strength Score", alias: "strength_score" },
      { name: "Last Interaction At", alias: "last_interaction_at" },
      { name: "Avatar URL", alias: "avatar_url" },
    ],
  });

  // ─── Compose WHERE ─────────────────────────────────────────────────────
  const wherePieces: string[] = ["1=1"];

  // Decoded structured filters (from ObjectFilterBar)
  let structuredWhere = "1=1";
  try {
    structuredWhere = decodeFiltersToSql(filtersParam, PEOPLE_FILTER_FIELDS);
  } catch (err) {
    if (err instanceof CrmFilterError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
  if (structuredWhere && structuredWhere !== "1=1") {
    wherePieces.push(`(${structuredWhere})`);
  }

  // Preset pill filters (Strongest / Going cold / Recently added / All).
  // Only apply pill semantics when no structured filters exist — once the
  // user opens the filter bar we trust their explicit rules.
  if (structuredWhere === "1=1" && presetFilter === "going_cold") {
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    wherePieces.push(
      `TRY_CAST(strength_score AS DOUBLE) > 5 AND (last_interaction_at IS NULL OR last_interaction_at < '${sixtyDaysAgo}')`,
    );
  }

  // Search filter — substring match against name / email / company.
  if (search) {
    const safe = search.replace(/'/g, "''");
    wherePieces.push(
      `(LOWER(COALESCE(name, '')) LIKE '%${safe}%'
        OR LOWER(COALESCE(email, '')) LIKE '%${safe}%'
        OR LOWER(COALESCE(company_name, '')) LIKE '%${safe}%')`,
    );
  }

  const where = wherePieces.join(" AND ");

  // ─── Compose ORDER BY ──────────────────────────────────────────────────
  let order: string;
  try {
    const decodedSort = decodeSortToSql(sortParam, PEOPLE_FILTER_FIELDS);
    if (decodedSort) {
      order = decodedSort;
    } else if (presetFilter === "going_cold") {
      order = "last_interaction_at ASC NULLS LAST";
    } else if (presetFilter === "recent") {
      order = "created_at DESC NULLS LAST";
    } else if (presetFilter === "all") {
      order = "name ASC NULLS LAST";
    } else {
      // Strongest (default)
      order = "TRY_CAST(strength_score AS DOUBLE) DESC NULLS LAST, last_interaction_at DESC NULLS LAST";
    }
  } catch (err) {
    if (err instanceof CrmFilterError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  // ─── Run query (data + count combined via window function) ────────────
  // Each DuckDB CLI spawn is ~150ms of pure overhead, so combining the
  // list + total into one round trip cuts the warm-path latency in half.
  // `COUNT(*) OVER ()` computes the full filtered total on every row;
  // LIMIT applies after the window so pagination still works correctly.
  //
  // The DISTINCT ON deduper sits between `base` (the raw EAV pivot) and
  // the WHERE/ORDER apply: even with `mergeDuplicatePeople` running on
  // every sync, brand-new duplicates can appear briefly between an
  // incremental write and the next merge tick. Rows without an email get
  // their own bucket via COALESCE(entry_id) so anonymous people don't
  // accidentally collapse into one.
  const sql = `
    WITH base AS (${projection}),
    deduped AS (
      SELECT DISTINCT ON (COALESCE(LOWER(TRIM(email)), entry_id)) *
      FROM base
      ORDER BY COALESCE(LOWER(TRIM(email)), entry_id),
               TRY_CAST(strength_score AS DOUBLE) DESC NULLS LAST,
               last_interaction_at DESC NULLS LAST
    )
    SELECT *, COUNT(*) OVER () AS _total FROM deduped
    WHERE ${where}
    ORDER BY ${order}
    LIMIT ${pagination.pageSize} OFFSET ${offset};
  `;
  const rows = await safeQuery<Record<string, string | null>>(sql);
  const total = rows[0]?._total ? Number(rows[0]._total) : 0;

  const people: PersonRow[] = rows.map((row) => {
    const score = row.strength_score ? Number(row.strength_score) : 0;
    const bucket = getConnectionStrengthBucket(score);
    return {
      id: String(row.entry_id),
      name: row.name,
      email: row.email,
      company_name: row.company_name,
      job_title: row.job_title,
      source: row.source,
      strength_score: Number.isFinite(score) ? score : null,
      strength_label: bucket.label,
      strength_color: bucket.color,
      last_interaction_at: row.last_interaction_at,
      avatar_url: row.avatar_url,
    };
  });

  return Response.json({
    people,
    total,
    page: pagination.page,
    pageSize: pagination.pageSize,
    offset,
    filter: presetFilter,
  });
}

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

type CompanyRow = {
  id: string;
  name: string | null;
  domain: string | null;
  website: string | null;
  industry: string | null;
  source: string | null;
  strength_score: number | null;
  strength_label: string;
  strength_color: string;
  last_interaction_at: string | null;
  people_count: number;
  strongest_contact: string | null;
};

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

const COMPANIES_FILTER_FIELDS: ReadonlyArray<CrmFilterField> = [
  { name: "Company Name", column: "name", type: "text" },
  { name: "Domain", column: "domain", type: "text" },
  { name: "Industry", column: "industry", type: "text" },
  { name: "Strength Label", column: "strength_label", type: "enum" },
  { name: "Strength Score", column: "strength_score", type: "number" },
  { name: "Last Interaction At", column: "last_interaction_at", type: "date" },
];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const search = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
  const filtersParam = url.searchParams.get("filters");
  const sortParam = url.searchParams.get("sort");
  const pagination = decodePagination(
    url.searchParams.get("page"),
    url.searchParams.get("pageSize") ?? url.searchParams.get("limit"),
    { pageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE },
  );
  const offsetOverride = url.searchParams.get("offset");
  const offset =
    offsetOverride !== null && offsetOverride !== ""
      ? Math.max(0, parseInt(offsetOverride, 10) || 0)
      : pagination.offset;

  const fieldMaps = await loadCrmFieldMaps();
  const projection = buildEntryProjection({
    objectId: ONBOARDING_OBJECT_IDS.company,
    fieldMap: fieldMaps.company,
    aliasedFields: [
      { name: "Company Name", alias: "name" },
      { name: "Domain", alias: "domain" },
      { name: "Website", alias: "website" },
      { name: "Industry", alias: "industry" },
      { name: "Source", alias: "source" },
      { name: "Strength Score", alias: "strength_score" },
      { name: "Last Interaction At", alias: "last_interaction_at" },
    ],
  });

  // ─── Compose WHERE ─────────────────────────────────────────────────────
  const wherePieces: string[] = ["1=1"];
  let structuredWhere = "1=1";
  try {
    structuredWhere = decodeFiltersToSql(filtersParam, COMPANIES_FILTER_FIELDS);
  } catch (err) {
    if (err instanceof CrmFilterError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
  if (structuredWhere && structuredWhere !== "1=1") {
    wherePieces.push(`(${structuredWhere})`);
  }
  if (search) {
    const safe = search.replace(/'/g, "''");
    wherePieces.push(
      `(LOWER(COALESCE(name, '')) LIKE '%${safe}%'
        OR LOWER(COALESCE(domain, '')) LIKE '%${safe}%'
        OR LOWER(COALESCE(industry, '')) LIKE '%${safe}%')`,
    );
  }
  const where = wherePieces.join(" AND ");

  // ─── Compose ORDER BY ──────────────────────────────────────────────────
  let order: string;
  try {
    const decodedSort = decodeSortToSql(sortParam, COMPANIES_FILTER_FIELDS);
    order =
      decodedSort ??
      "TRY_CAST(strength_score AS DOUBLE) DESC NULLS LAST, last_interaction_at DESC NULLS LAST";
  } catch (err) {
    if (err instanceof CrmFilterError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  // ─── Run query (data + count combined via window function) ────────────
  // Same optimization as /api/crm/people: one CLI spawn instead of two,
  // using COUNT(*) OVER () to return the filtered total on every row.
  const sql = `
    WITH base AS (${projection})
    SELECT *, COUNT(*) OVER () AS _total FROM base
    WHERE ${where}
    ORDER BY ${order}
    LIMIT ${pagination.pageSize} OFFSET ${offset};
  `;
  const rows = await safeQuery<Record<string, string | null>>(sql);
  const total = rows[0]?._total ? Number(rows[0]._total) : 0;

  // Bulk-load people-count + strongest-contact per company. We fetch the
  // full People list (one DuckDB round-trip), then aggregate in JS — this
  // is comfortably faster than N+1 queries and the page is capped at
  // ~500 companies.
  const peopleEmailFieldId = fieldMaps.people["Email Address"];
  const peopleNameFieldId = fieldMaps.people["Full Name"];
  const peopleScoreFieldId = fieldMaps.people["Strength Score"];
  let peopleByCompanyDomain = new Map<string, { count: number; strongest: { name: string; score: number } | null }>();
  if (peopleEmailFieldId) {
    const peopleSql = `
      SELECT
        e.id AS person_id,
        ${peopleEmailFieldId ? `MAX(CASE WHEN ef.field_id = '${peopleEmailFieldId}' THEN ef.value END)` : "NULL"} AS email,
        ${peopleNameFieldId ? `MAX(CASE WHEN ef.field_id = '${peopleNameFieldId}' THEN ef.value END)` : "NULL"} AS name,
        ${peopleScoreFieldId ? `MAX(CASE WHEN ef.field_id = '${peopleScoreFieldId}' THEN ef.value END)` : "NULL"} AS score
      FROM entries e
      LEFT JOIN entry_fields ef ON ef.entry_id = e.id
      WHERE e.object_id = '${ONBOARDING_OBJECT_IDS.people}'
      GROUP BY e.id;
    `;
    const peopleRows = await safeQuery<{
      person_id: string;
      email: string | null;
      name: string | null;
      score: string | null;
    }>(peopleSql);
    peopleByCompanyDomain = aggregatePeopleByDomain(peopleRows);
  }

  const companies: CompanyRow[] = rows.map((row) => {
    const score = row.strength_score ? Number(row.strength_score) : 0;
    const bucket = getConnectionStrengthBucket(score);
    const domain = row.domain ?? null;
    const aggregated = domain ? peopleByCompanyDomain.get(domain.toLowerCase()) : undefined;
    return {
      id: String(row.entry_id),
      name: row.name,
      domain,
      website: row.website,
      industry: row.industry,
      source: row.source,
      strength_score: Number.isFinite(score) ? score : null,
      strength_label: bucket.label,
      strength_color: bucket.color,
      last_interaction_at: row.last_interaction_at,
      people_count: aggregated?.count ?? 0,
      strongest_contact: aggregated?.strongest?.name ?? null,
    };
  });

  return Response.json({
    companies,
    total,
    page: pagination.page,
    pageSize: pagination.pageSize,
    offset,
  });
}

function aggregatePeopleByDomain(
  rows: Array<{ person_id: string; email: string | null; name: string | null; score: string | null }>,
): Map<string, { count: number; strongest: { name: string; score: number } | null }> {
  const map = new Map<string, { count: number; strongest: { name: string; score: number } | null }>();
  for (const row of rows) {
    if (!row.email) {continue;}
    const at = row.email.lastIndexOf("@");
    if (at <= 0) {continue;}
    const domain = row.email.slice(at + 1).toLowerCase();
    if (!domain) {continue;}
    const score = row.score ? Number(row.score) : 0;
    const existing = map.get(domain);
    if (!existing) {
      map.set(domain, {
        count: 1,
        strongest: { name: row.name ?? row.email, score: Number.isFinite(score) ? score : 0 },
      });
    } else {
      existing.count += 1;
      if (Number.isFinite(score) && (!existing.strongest || score > existing.strongest.score)) {
        existing.strongest = { name: row.name ?? row.email, score };
      }
    }
  }
  return map;
}

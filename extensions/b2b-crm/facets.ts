import { getConnection } from './db.js';
import { buildFilterSQL, type FilterGroup } from './filters.js';

export interface FacetValue {
  value: string;
  count: number;
}

export interface FacetResult {
  field: string;
  values: FacetValue[];
}

/**
 * Runs one faceted count query per facet field against the given view.
 * If a FilterGroup is provided, counts reflect only the filtered subset —
 * so facets update as the user applies filters.
 *
 * Field names with spaces are double-quoted in the generated SQL.
 */
export async function getFacetedCounts(
  viewName: string,
  facetFields: string[],
  filter?: FilterGroup,
  dbPath?: string,
): Promise<FacetResult[]> {
  if (facetFields.length === 0) return [];

  const conn = await getConnection(dbPath);
  try {
    const results: FacetResult[] = [];

    for (const field of facetFields) {
      const quotedField = `"${field.replace(/"/g, '""')}"`;

      let sql: string;
      let params: unknown[];

      if (filter) {
        const { sql: filterSql, params: filterParams } = buildFilterSQL(filter, viewName);
        // Wrap the filtered result as a CTE and aggregate the facet field
        sql = `
          WITH filtered AS (${filterSql})
          SELECT ${quotedField} AS value, COUNT(*) AS count
          FROM filtered
          WHERE ${quotedField} IS NOT NULL
          GROUP BY ${quotedField}
          ORDER BY count DESC
        `;
        params = filterParams;
      } else {
        sql = `
          SELECT ${quotedField} AS value, COUNT(*) AS count
          FROM ${viewName}
          WHERE ${quotedField} IS NOT NULL
          GROUP BY ${quotedField}
          ORDER BY count DESC
        `;
        params = [];
      }

      const rows = await conn.all<{ value: string; count: number | bigint }>(
        sql,
        ...params,
      );
      results.push({
        field,
        values: rows.map((r) => ({
          value: String(r.value),
          count: Number(r.count),
        })),
      });
    }

    return results;
  } finally {
    await conn.close();
  }
}

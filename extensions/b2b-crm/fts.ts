import { getConnection } from './db.js';

interface FTSConfig {
  readonly table: string;
  readonly idCol: string;
  readonly sourceCols: readonly string[];
  readonly sourceView: string;
}

const FTS_CONFIGS: Record<string, FTSConfig> = {
  account: {
    table: 'fts_account',
    idCol: 'entry_id',
    sourceCols: ['Company Name', 'Domain', 'Industry', 'HQ City', 'HQ Country', 'Description'],
    sourceView: 'v_account',
  },
  contact: {
    table: 'fts_contact',
    idCol: 'entry_id',
    sourceCols: ['First Name', 'Last Name', 'Email Address', 'Job Title', 'Department', 'Notes'],
    sourceView: 'v_contact',
  },
  deal: {
    table: 'fts_deal',
    idCol: 'entry_id',
    sourceCols: ['Deal Name', 'Description'],
    sourceView: 'v_deal',
  },
};

/**
 * Sanitizes a user-supplied FTS query string for safe inline interpolation.
 * DuckDB's match_bm25 does not accept parameterized values — the query string
 * must be a literal. We strip single-quotes and non-search characters to prevent
 * injection. See Pattern Log: "DuckDB FTS match_bm25 requires literal query".
 */
function sanitizeFTSQuery(query: string): string {
  return query
    .slice(0, 200)
    .replace(/'/g, '')
    .replace(/[^\w\s*+\-"]/g, ' ')
    .trim();
}

/**
 * Creates flat FTS staging tables from the three PIVOT views and builds
 * DuckDB BM25 full-text search indexes over them.
 *
 * Must be called after createPivotViews() — the PIVOT views must exist.
 * Safe to re-run (overwrite=1 rebuilds existing indexes).
 */
export async function setupFTSIndexes(dbPath?: string): Promise<void> {
  const conn = await getConnection(dbPath);
  try {
    await conn.exec('INSTALL fts; LOAD fts;');
    for (const cfg of Object.values(FTS_CONFIGS)) {
      const colList = cfg.sourceCols.map((c) => `"${c}"`).join(', ');
      await conn.exec(
        `CREATE OR REPLACE TABLE ${cfg.table} AS SELECT entry_id, ${colList} FROM ${cfg.sourceView}`,
      );
      const pragmaCols = cfg.sourceCols.map((c) => `'${c}'`).join(', ');
      await conn.exec(
        `PRAGMA create_fts_index('${cfg.table}', '${cfg.idCol}', ${pragmaCols}, stopwords='none', overwrite=1)`,
      );
    }
  } finally {
    await conn.close();
  }
}

/**
 * Queries the FTS index for the given object type and returns ranked results.
 * objectName must be one of: 'account', 'contact', 'deal'.
 *
 * Returns array sorted by BM25 relevance score descending.
 */
export async function searchFTS(
  query: string,
  objectName: string,
  limit = 20,
  dbPath?: string,
): Promise<Array<{ id: string; score: number }>> {
  const cfg = FTS_CONFIGS[objectName];
  if (!cfg) return [];

  const sanitized = sanitizeFTSQuery(query);
  if (!sanitized) return [];

  const conn = await getConnection(dbPath);
  try {
    await conn.exec('LOAD fts;');
    const fnSchema = `fts_main_${cfg.table}`;
    // DuckDB FTS: match_bm25 requires a string literal — parameterized bind returns null.
    // sanitizeFTSQuery strips single-quotes so interpolation is safe.
    const rows = await conn.all<{ score: number; entry_id: string }>(
      `SELECT score, entry_id
       FROM (
         SELECT ${fnSchema}.match_bm25(entry_id, '${sanitized}') AS score, entry_id
         FROM ${cfg.table}
       )
       WHERE score IS NOT NULL
       ORDER BY score DESC
       LIMIT ?`,
      limit,
    );
    return rows.map((r) => ({ id: r.entry_id, score: r.score }));
  } finally {
    await conn.close();
  }
}

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { closeDb, execQuery, getConnection } from './db.js';
import { createObjects, createPivotViews } from './objects.js';
import { createStandaloneTables } from './tables.js';
import { setupFTSIndexes, searchFTS } from './fts.js';
import { buildFilterSQL, type FilterGroup } from './filters.js';
import { getFacetedCounts } from './facets.js';
import { enrichSearchResults } from './enrich.js';

// ── helpers ───────────────────────────────────────────────────────────────────

let testDir: string;
let dbPath: string;

async function setupFullDb(path: string): Promise<void> {
  await execQuery(
    `CREATE TABLE IF NOT EXISTS objects (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR,
      name VARCHAR NOT NULL UNIQUE, description VARCHAR,
      default_view VARCHAR, parent_document_id VARCHAR, sort_order INTEGER DEFAULT 0,
      source_app VARCHAR, immutable BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`, [], path);
  await execQuery(
    `CREATE TABLE IF NOT EXISTS fields (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR,
      object_id VARCHAR NOT NULL, name VARCHAR NOT NULL, description VARCHAR,
      type VARCHAR NOT NULL, required BOOLEAN DEFAULT false,
      default_value VARCHAR, related_object_id VARCHAR, relationship_type VARCHAR,
      enum_values JSON, enum_colors JSON, enum_multiple BOOLEAN DEFAULT false,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(object_id, name)
    )`, [], path);
  await execQuery(
    `CREATE TABLE IF NOT EXISTS statuses (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR,
      object_id VARCHAR NOT NULL, name VARCHAR NOT NULL, color VARCHAR,
      sort_order INTEGER DEFAULT 0, is_default BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(object_id, name)
    )`, [], path);
  await execQuery(
    `CREATE TABLE IF NOT EXISTS entries (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR,
      object_id VARCHAR NOT NULL, sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`, [], path);
  await execQuery(
    `CREATE TABLE IF NOT EXISTS entry_fields (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR,
      entry_id VARCHAR NOT NULL, field_id VARCHAR NOT NULL, value VARCHAR,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(entry_id, field_id)
    )`, [], path);
  await createStandaloneTables(path);
  await createObjects(path);
  await createPivotViews(path);
}

interface AccountData {
  name: string;
  industry?: string;
  employeeCount?: number;
  hqCountry?: string;
  description?: string;
}

async function insertAccount(path: string, data: AccountData): Promise<string> {
  const entryId = randomUUID();
  const conn = await getConnection(path);
  try {
    await conn.run(
      `INSERT INTO entries (id, object_id)
       VALUES (?, (SELECT id FROM objects WHERE name = 'account'))`,
      entryId,
    );
    const fieldPairs: Array<[string, string]> = [
      ['Company Name', data.name],
      ...(data.industry ? [['Industry', data.industry] as [string, string]] : []),
      ...(data.employeeCount != null ? [['Employee Count', String(data.employeeCount)] as [string, string]] : []),
      ...(data.hqCountry ? [['HQ Country', data.hqCountry] as [string, string]] : []),
      ...(data.description ? [['Description', data.description] as [string, string]] : []),
    ];
    for (const [fieldName, value] of fieldPairs) {
      await conn.run(
        `INSERT INTO entry_fields (entry_id, field_id, value)
         VALUES (?, (SELECT id FROM fields
                     WHERE object_id = (SELECT id FROM objects WHERE name = 'account')
                       AND name = ?), ?)`,
        entryId, fieldName, value,
      );
    }
  } finally {
    await conn.close();
  }
  return entryId;
}

// Generates 100 test accounts with known distribution:
// Manufacturing: 30, Energy: 25, Chemicals: 20, Logistics: 15, Agriculture: 10
const DISTRIBUTION: Array<[string, number]> = [
  ['Manufacturing', 30], ['Energy', 25], ['Chemicals', 20],
  ['Logistics', 15], ['Agriculture', 10],
];

async function insertTestAccounts(path: string): Promise<{ ids: string[]; distribution: Map<string, number> }> {
  const ids: string[] = [];
  const distribution = new Map<string, number>();
  let idx = 0;
  for (const [industry, count] of DISTRIBUTION) {
    distribution.set(industry, count);
    for (let i = 0; i < count; i++) {
      const employeeCount = (idx % 5 + 1) * 200;
      const id = await insertAccount(path, {
        name: `${industry}Corp ${String(idx).padStart(3, '0')}`,
        industry,
        employeeCount,
        hqCountry: idx % 2 === 0 ? 'USA' : 'Germany',
      });
      ids.push(id);
      idx++;
    }
  }
  return { ids, distribution };
}

beforeEach(() => {
  const ts = Date.now();
  testDir = join(tmpdir(), `b2b-search-test-${ts}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  dbPath = join(testDir, 'test.duckdb');
});

afterEach(async () => {
  await closeDb(dbPath);
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── FTS ───────────────────────────────────────────────────────────────────────

describe('FTS', () => {
  it('returns ranked results for unique company name term', async () => {
    await setupFullDb(dbPath);
    await insertTestAccounts(dbPath);
    // Insert a uniquely-named account for unambiguous FTS retrieval
    const ftsId = await insertAccount(dbPath, { name: 'Zythox Technologies', industry: 'Energy' });
    await setupFTSIndexes(dbPath);

    const results = await searchFTS('Zythox', 'account', 10, dbPath);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe(ftsId);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('returns multiple results for a shared industry term', async () => {
    await setupFullDb(dbPath);
    await insertTestAccounts(dbPath);
    await setupFTSIndexes(dbPath);

    const results = await searchFTS('Manufacturing', 'account', 50, dbPath);
    expect(results.length).toBe(30);
    expect(results.every((r) => r.score > 0)).toBe(true);
  });

  it('returns empty array for unknown objectName', async () => {
    await setupFullDb(dbPath);
    await setupFTSIndexes(dbPath);
    const results = await searchFTS('anything', 'unknown_object', 10, dbPath);
    expect(results).toEqual([]);
  });

  it('returns empty array for empty query', async () => {
    await setupFullDb(dbPath);
    await setupFTSIndexes(dbPath);
    const results = await searchFTS('', 'account', 10, dbPath);
    expect(results).toEqual([]);
  });
});

// ── Boolean filter ─────────────────────────────────────────────────────────────

describe('boolean filter', () => {
  it('filters by single field eq', async () => {
    await setupFullDb(dbPath);
    await insertTestAccounts(dbPath);

    const filter: FilterGroup = {
      logic: 'AND',
      clauses: [{ field: 'Industry', operator: 'eq', value: 'Manufacturing' }],
    };
    const { sql, params } = buildFilterSQL(filter, 'v_account');
    const conn = await getConnection(dbPath);
    try {
      const rows = await conn.all<{ entry_id: string; Industry: string }>(sql, ...params);
      expect(rows.length).toBe(30);
      expect(rows.every((r) => r.Industry === 'Manufacturing')).toBe(true);
    } finally {
      await conn.close();
    }
  });

  it('filters by compound AND: industry + employee count', async () => {
    await setupFullDb(dbPath);
    await insertTestAccounts(dbPath);

    const filter: FilterGroup = {
      logic: 'AND',
      clauses: [
        { field: 'Industry', operator: 'eq', value: 'Manufacturing' },
        { field: 'Employee Count', operator: 'gt', value: 500 },
      ],
    };
    const { sql, params } = buildFilterSQL(filter, 'v_account');
    const conn = await getConnection(dbPath);
    try {
      const rows = await conn.all<{ entry_id: string }>(sql, ...params);
      // Mfg accounts with idx 0-29, employeeCount = (idx%5+1)*200: 600,800,1000 → idx%5 in [2,3,4] → 3/5 of 30 = 18
      expect(rows.length).toBe(18);
    } finally {
      await conn.close();
    }
  });

  it('supports nested OR groups', async () => {
    await setupFullDb(dbPath);
    await insertTestAccounts(dbPath);

    const filter: FilterGroup = {
      logic: 'OR',
      clauses: [
        { field: 'Industry', operator: 'eq', value: 'Energy' },
        { field: 'Industry', operator: 'eq', value: 'Chemicals' },
      ],
    };
    const { sql, params } = buildFilterSQL(filter, 'v_account');
    const conn = await getConnection(dbPath);
    try {
      const rows = await conn.all<{ entry_id: string }>(sql, ...params);
      expect(rows.length).toBe(45); // Energy 25 + Chemicals 20
    } finally {
      await conn.close();
    }
  });
});

// ── Faceted counts ─────────────────────────────────────────────────────────────

describe('faceted counts', () => {
  it('returns correct industry distribution', async () => {
    await setupFullDb(dbPath);
    const { distribution } = await insertTestAccounts(dbPath);

    const facets = await getFacetedCounts('v_account', ['Industry'], undefined, dbPath);
    expect(facets).toHaveLength(1);
    const industryFacet = facets[0];
    expect(industryFacet.field).toBe('Industry');

    const totalFromFacets = industryFacet.values.reduce((sum, v) => sum + v.count, 0);
    expect(totalFromFacets).toBe(100);

    for (const { value, count } of industryFacet.values) {
      expect(count).toBe(distribution.get(value));
    }
  });

  it('facet counts respect active filter', async () => {
    await setupFullDb(dbPath);
    await insertTestAccounts(dbPath);

    const filter: FilterGroup = {
      logic: 'AND',
      clauses: [{ field: 'HQ Country', operator: 'eq', value: 'USA' }],
    };
    const facets = await getFacetedCounts('v_account', ['Industry'], filter, dbPath);
    const total = facets[0].values.reduce((sum, v) => sum + v.count, 0);
    expect(total).toBe(50); // 50 USA accounts (every even idx out of 100)
  });
});

// ── Combined FTS + filter ─────────────────────────────────────────────────────

describe('combined FTS + filter', () => {
  it('intersection of FTS results and filter', async () => {
    await setupFullDb(dbPath);
    await insertTestAccounts(dbPath);
    await setupFTSIndexes(dbPath);

    // FTS returns all ManufacturingCorp entries; filter restricts to USA
    const ftsResults = await searchFTS('Manufacturing', 'account', 100, dbPath);
    const ftsIds = new Set(ftsResults.map((r) => r.id));
    expect(ftsIds.size).toBe(30);

    const filter: FilterGroup = {
      logic: 'AND',
      clauses: [
        { field: 'Industry', operator: 'eq', value: 'Manufacturing' },
        { field: 'HQ Country', operator: 'eq', value: 'USA' },
      ],
    };
    const { sql, params } = buildFilterSQL(filter, 'v_account');
    const conn = await getConnection(dbPath);
    try {
      const filtered = await conn.all<{ entry_id: string }>(sql, ...params);
      const filteredIds = new Set(filtered.map((r) => r.entry_id));
      // Intersection: both must be Manufacturing + in FTS results
      const intersection = filtered.filter((r) => ftsIds.has(r.entry_id));
      expect(intersection.length).toBe(filteredIds.size);
    } finally {
      await conn.close();
    }
  });
});

// ── ILIKE substring ───────────────────────────────────────────────────────────

describe('ILIKE substring search', () => {
  it('finds accounts by partial company name match', async () => {
    await setupFullDb(dbPath);
    await insertTestAccounts(dbPath);

    const conn = await getConnection(dbPath);
    try {
      const rows = await conn.all<{ entry_id: string }>(
        `SELECT entry_id FROM v_account WHERE "Company Name" ILIKE ?`,
        '%energycorp%',
      );
      expect(rows.length).toBe(25);
    } finally {
      await conn.close();
    }
  });

  it('ILIKE is case insensitive', async () => {
    await setupFullDb(dbPath);
    await insertTestAccounts(dbPath);

    const conn = await getConnection(dbPath);
    try {
      const lower = await conn.all<{ entry_id: string }>(
        `SELECT entry_id FROM v_account WHERE "Company Name" ILIKE ?`,
        '%logistics%',
      );
      const upper = await conn.all<{ entry_id: string }>(
        `SELECT entry_id FROM v_account WHERE "Company Name" ILIKE ?`,
        '%LOGISTICS%',
      );
      expect(lower.length).toBe(15);
      expect(upper.length).toBe(lower.length);
    } finally {
      await conn.close();
    }
  });
});

// ── Stable sort ───────────────────────────────────────────────────────────────

describe('stable sort', () => {
  it('same query returns same order on repeated calls', async () => {
    await setupFullDb(dbPath);
    await insertTestAccounts(dbPath);

    const conn = await getConnection(dbPath);
    try {
      const query = `SELECT entry_id FROM v_account ORDER BY "Company Name" ASC, entry_id ASC LIMIT 20`;
      const r1 = await conn.all<{ entry_id: string }>(query);
      const r2 = await conn.all<{ entry_id: string }>(query);
      expect(r1.map((r) => r.entry_id)).toEqual(r2.map((r) => r.entry_id));
    } finally {
      await conn.close();
    }
  });
});

// ── Pagination ────────────────────────────────────────────────────────────────

describe('pagination', () => {
  it('page1 + page2 equals first 40 rows of unpaginated query', async () => {
    await setupFullDb(dbPath);
    await insertTestAccounts(dbPath);

    const conn = await getConnection(dbPath);
    try {
      const orderBy = `ORDER BY "Company Name" ASC, entry_id ASC`;
      const all40 = await conn.all<{ entry_id: string }>(
        `SELECT entry_id FROM v_account ${orderBy} LIMIT 40`,
      );
      const page1 = await conn.all<{ entry_id: string }>(
        `SELECT entry_id FROM v_account ${orderBy} LIMIT 20 OFFSET 0`,
      );
      const page2 = await conn.all<{ entry_id: string }>(
        `SELECT entry_id FROM v_account ${orderBy} LIMIT 20 OFFSET 20`,
      );
      const combined = [...page1, ...page2].map((r) => r.entry_id);
      expect(combined).toEqual(all40.map((r) => r.entry_id));
    } finally {
      await conn.close();
    }
  });
});

// ── Intelligence sort ─────────────────────────────────────────────────────────

describe('intelligence sort', () => {
  it('enrichSearchResults returns required intelligence fields', async () => {
    await setupFullDb(dbPath);
    const input = [
      { id: 'id-1', score: 0.9 },
      { id: 'id-2', score: 0.5 },
    ];
    const enriched = await enrichSearchResults(input, 'account', dbPath);
    expect(enriched).toHaveLength(2);
    for (const r of enriched) {
      expect(r).toHaveProperty('id');
      expect(r).toHaveProperty('score');
      expect(r).toHaveProperty('engagement_score');
      expect(r).toHaveProperty('neglect_flag');
      expect(r).toHaveProperty('days_since_activity');
    }
  });

  it('unknown entity has null engagement_score and false neglect_flag', async () => {
    await setupFullDb(dbPath);
    const enriched = await enrichSearchResults([{ id: 'nonexistent-id', score: 1.0 }], 'account', dbPath);
    expect(enriched[0].engagement_score).toBeNull();
    expect(enriched[0].neglect_flag).toBe(false);
    expect(enriched[0].days_since_activity).toBeNull();
  });
});

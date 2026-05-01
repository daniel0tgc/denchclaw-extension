import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, execQuery, runQuery } from './db.js';
import { createObjects, createPivotViews } from './objects.js';
import { createStandaloneTables } from './tables.js';
import { importCSV, parseCSV } from './csv-import.js';
import { exportCSV } from './csv-export.js';
import { deduplicateImport, findDuplicates } from './dedup.js';
import { detectEncoding, normalizeToUTF8 } from './encoding.js';

// ── DB Setup ──────────────────────────────────────────────────────────────────

let testDir: string;
let dbPath: string;

async function setupFullDb(path: string): Promise<void> {
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS objects (id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR, name VARCHAR NOT NULL UNIQUE, description VARCHAR, default_view VARCHAR, parent_document_id VARCHAR, sort_order INTEGER DEFAULT 0, source_app VARCHAR, immutable BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS fields (id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR, object_id VARCHAR NOT NULL, name VARCHAR NOT NULL, description VARCHAR, type VARCHAR NOT NULL, required BOOLEAN DEFAULT false, default_value VARCHAR, related_object_id VARCHAR, relationship_type VARCHAR, enum_values JSON, enum_colors JSON, enum_multiple BOOLEAN DEFAULT false, sort_order INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(object_id, name))`,
    `CREATE TABLE IF NOT EXISTS statuses (id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR, object_id VARCHAR NOT NULL, name VARCHAR NOT NULL, color VARCHAR, sort_order INTEGER DEFAULT 0, is_default BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(object_id, name))`,
    `CREATE TABLE IF NOT EXISTS entries (id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR, object_id VARCHAR NOT NULL, sort_order INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS entry_fields (id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR, entry_id VARCHAR NOT NULL, field_id VARCHAR NOT NULL, value VARCHAR, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(entry_id, field_id))`,
  ]) {
    await execQuery(sql, [], path);
  }
  await createStandaloneTables(path);
  await createObjects(path);
  await createPivotViews(path);
}

beforeEach(() => {
  const ts = Date.now();
  testDir = join(tmpdir(), `b2b-import-test-${ts}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  dbPath = join(testDir, 'test.duckdb');
});

afterEach(async () => {
  await closeDb(dbPath);
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── CSV Parser ────────────────────────────────────────────────────────────────

describe('parseCSV', () => {
  it('parses a simple CSV', () => {
    const rows = parseCSV('name,age\nAlice,30\nBob,25');
    expect(rows).toEqual([['name', 'age'], ['Alice', '30'], ['Bob', '25']]);
  });

  it('handles quoted fields with commas', () => {
    const rows = parseCSV('"Company, Inc.",domain.com');
    expect(rows).toEqual([['Company, Inc.', 'domain.com']]);
  });

  it('handles escaped double-quotes inside quoted fields', () => {
    const rows = parseCSV('"He said ""hello""",next');
    expect(rows).toEqual([['He said "hello"', 'next']]);
  });

  it('handles CRLF line endings', () => {
    const rows = parseCSV('a,b\r\nc,d\r\n');
    expect(rows).toEqual([['a', 'b'], ['c', 'd']]);
  });
});

// ── Clean CSV import ──────────────────────────────────────────────────────────

describe('clean', () => {
  it('imports all rows from a valid CSV', async () => {
    await setupFullDb(dbPath);

    const csv = [
      'Name,Website,City',
      'Apex Manufacturing,https://apex.com,Chicago',
      'Summit Energy,https://summit.io,Houston',
      'Delta Logistics,https://delta.net,Dallas',
    ].join('\n');

    const mappings = [
      { csvColumn: 'Name', objectField: 'Company Name' },
      { csvColumn: 'Website', objectField: 'Website' },
      { csvColumn: 'City', objectField: 'HQ City' },
    ];

    const result = await importCSV(csv, 'account', mappings, { dbPath });
    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.totalRows).toBe(3);
  });
});

// ── Adversarial CSV ───────────────────────────────────────────────────────────

describe('adversarial', () => {
  it('skips bad rows and imports good ones', async () => {
    await setupFullDb(dbPath);

    // Row 2: bad email, Row 4: non-numeric employee count
    const csv = [
      'Email,Name,Employees',
      'alice@example.com,Alice Corp,100',
      'not-an-email,Bad Email Corp,50',
      'bob@example.com,Bob Corp,200',
      'carol@example.com,Carol Corp,not-a-number',
    ].join('\n');

    const mappings = [
      { csvColumn: 'Email', objectField: 'Company Name' },  // using Company Name as name placeholder
      { csvColumn: 'Email', objectField: 'Domain' },
      { csvColumn: 'Name', objectField: 'Company Name' },
      { csvColumn: 'Employees', objectField: 'Employee Count' },
    ];

    // Use a simpler adversarial test with contact email validation
    const contactCsv = [
      'First Name,Last Name,Email Address',
      'Alice,Smith,alice@example.com',
      'Bob,Jones,not-an-email',
      'Carol,Williams,carol@example.com',
    ].join('\n');

    const contactMappings = [
      { csvColumn: 'First Name', objectField: 'First Name' },
      { csvColumn: 'Last Name', objectField: 'Last Name' },
      { csvColumn: 'Email Address', objectField: 'Email Address' },
    ];

    const result = await importCSV(contactCsv, 'contact', contactMappings, { dbPath });
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].row).toBe(3); // row 3 in file (header=1, data rows 2,3,4)
    expect(result.errors[0].reason).toMatch(/email/i);
  });

  it('logs errors to import_errors table with batch ID', async () => {
    await setupFullDb(dbPath);

    const csv = [
      'First Name,Last Name,Email Address',
      'Good,Person,good@example.com',
      'Bad,Person,not-valid',
    ].join('\n');

    const mappings = [
      { csvColumn: 'First Name', objectField: 'First Name' },
      { csvColumn: 'Last Name', objectField: 'Last Name' },
      { csvColumn: 'Email Address', objectField: 'Email Address' },
    ];

    const result = await importCSV(csv, 'contact', mappings, { dbPath });
    expect(result.errors).toHaveLength(1);

    const errors = await runQuery<{ import_batch_id: string; row_number: number }>(
      `SELECT import_batch_id, row_number FROM import_errors WHERE import_batch_id = ?`,
      [result.batchId],
      dbPath,
    );
    expect(errors).toHaveLength(1);
    expect(Number(errors[0].row_number)).toBe(3);
  });
});

// ── Column mapping ────────────────────────────────────────────────────────────

describe('column mapping', () => {
  it('handles CSV columns in different order than fields', async () => {
    await setupFullDb(dbPath);

    const csv = [
      'City,CompanyName,Country',
      'Chicago,Apex Manufacturing,US',
    ].join('\n');

    const mappings = [
      { csvColumn: 'CompanyName', objectField: 'Company Name' },
      { csvColumn: 'City', objectField: 'HQ City' },
      { csvColumn: 'Country', objectField: 'HQ Country' },
    ];

    const result = await importCSV(csv, 'account', mappings, { dbPath });
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);

    const accounts = await runQuery<Record<string, unknown>>(
      `SELECT "Company Name", "HQ City", "HQ Country" FROM v_account`,
      [],
      dbPath,
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]['Company Name']).toBe('Apex Manufacturing');
    expect(accounts[0]['HQ City']).toBe('Chicago');
  });
});

// ── Encoding detection ────────────────────────────────────────────────────────

describe('encoding', () => {
  it('detects UTF-8 BOM', () => {
    const buf = Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]); // BOM + 'hi'
    expect(detectEncoding(buf)).toBe('utf-8');
  });

  it('detects UTF-16LE BOM', () => {
    const buf = Buffer.from([0xff, 0xfe, 0x68, 0x00]);
    expect(detectEncoding(buf)).toBe('utf-16le');
  });

  it('detects ISO-8859-1 / latin1 content', () => {
    // é in ISO-8859-1 is 0xe9 — not a valid UTF-8 sequence on its own
    const buf = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // 'café' in latin1
    expect(detectEncoding(buf)).toBe('iso-8859-1');
  });

  it('normalizes ISO-8859-1 to UTF-8 string', () => {
    // 'café' in ISO-8859-1
    const buf = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
    const result = normalizeToUTF8(buf);
    expect(result).toBe('café');
  });

  it('strips UTF-8 BOM from output', () => {
    const withBOM = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('hello')]);
    expect(normalizeToUTF8(withBOM)).toBe('hello');
  });

  it('handles pure ASCII as UTF-8', () => {
    const buf = Buffer.from('hello,world');
    expect(detectEncoding(buf)).toBe('utf-8');
    expect(normalizeToUTF8(buf)).toBe('hello,world');
  });
});

// ── Deduplication ─────────────────────────────────────────────────────────────

describe('dedup', () => {
  it('deduplicates import batch against existing DB records', async () => {
    await setupFullDb(dbPath);

    // Pre-insert some accounts (Domain field is type:url — must include protocol)
    const preCsv = [
      'Name,Domain',
      'Existing Corp,https://existing.com',
    ].join('\n');
    await importCSV(preCsv, 'account', [
      { csvColumn: 'Name', objectField: 'Company Name' },
      { csvColumn: 'Domain', objectField: 'Domain' },
    ], { dbPath });

    // Verify the domain was stored
    const existingDomains = await findDuplicates('account', 'Domain', ['https://existing.com', 'https://new.com'], dbPath);
    expect(existingDomains.has('https://existing.com')).toBe(true);
    expect(existingDomains.has('https://new.com')).toBe(false);

    // Dedup a new batch using the same URL format
    const rows = [
      { 'Domain': 'https://existing.com', 'Company Name': 'Duplicate Corp' },
      { 'Domain': 'https://new.com', 'Company Name': 'New Corp' },
      { 'Domain': 'https://another.com', 'Company Name': 'Another Corp' },
    ];

    const { unique, duplicates } = await deduplicateImport(rows, 'account', 'Domain', dbPath);
    expect(unique).toHaveLength(2);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]['Domain']).toBe('https://existing.com');
  });

  it('deduplicates within the import batch itself', async () => {
    await setupFullDb(dbPath);

    const rows = [
      { 'Domain': 'alpha.com', 'Company Name': 'Alpha 1' },
      { 'Domain': 'beta.com',  'Company Name': 'Beta' },
      { 'Domain': 'alpha.com', 'Company Name': 'Alpha 2' }, // duplicate of row 1
    ];

    const { unique, duplicates } = await deduplicateImport(rows, 'account', 'Domain', dbPath);
    expect(unique).toHaveLength(2);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]['Company Name']).toBe('Alpha 2');
  });
});

// ── CSV export ────────────────────────────────────────────────────────────────

describe('export', () => {
  it('exports accounts as valid CSV with correct headers and values', async () => {
    await setupFullDb(dbPath);

    const csv = [
      'Name,Website',
      'Apex Manufacturing,https://apex.com',
      'Summit Energy,https://summit.io',
    ].join('\n');

    await importCSV(csv, 'account', [
      { csvColumn: 'Name', objectField: 'Company Name' },
      { csvColumn: 'Website', objectField: 'Website' },
    ], { dbPath });

    const exported = await exportCSV('account', ['Company Name', 'Website'], undefined, dbPath);

    // Should have header + 2 data rows + trailing CRLF
    const lines = exported.split('\r\n').filter(Boolean);
    expect(lines[0]).toBe('Company Name,Website');
    expect(lines).toHaveLength(3);

    // Values should appear in the exported data
    const allText = exported;
    expect(allText).toContain('Apex Manufacturing');
    expect(allText).toContain('Summit Energy');
  });

  it('properly escapes values with commas and quotes in CSV', async () => {
    await setupFullDb(dbPath);

    const csv = [
      'Name',
      '"Company, Inc."',
    ].join('\n');

    await importCSV(csv, 'account', [
      { csvColumn: 'Name', objectField: 'Company Name' },
    ], { dbPath });

    const exported = await exportCSV('account', ['Company Name'], undefined, dbPath);
    // Value with comma must be quoted in output
    expect(exported).toContain('"Company, Inc."');
  });

  it('exports empty view as just a header row', async () => {
    await setupFullDb(dbPath);
    const exported = await exportCSV('account', ['Company Name', 'Domain'], undefined, dbPath);
    const lines = exported.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('Company Name,Domain');
  });
});

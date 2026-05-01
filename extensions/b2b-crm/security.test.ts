import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { closeDb, execQuery, getConnection } from './db.js';
import { createTenantContext } from './tenant.js';
import { createEncryptionService } from './encryption.js';
import { appendAuditLog, verifyAuditChain } from './audit.js';

// ── DB Setup ──────────────────────────────────────────────────────────────────

let testDir: string;
let dbPath: string;

async function setupSecurityDb(path: string): Promise<void> {
  // audit_log table
  await execQuery(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR,
      action VARCHAR NOT NULL,
      entity_type VARCHAR NOT NULL,
      entity_id VARCHAR NOT NULL,
      actor_id VARCHAR,
      details JSON,
      prev_hash VARCHAR,
      hash VARCHAR NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, [], path);

  // tenant_items — a simple tenant-scoped table for isolation testing
  await execQuery(`
    CREATE TABLE IF NOT EXISTS tenant_items (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR,
      tenant_id VARCHAR NOT NULL,
      name VARCHAR NOT NULL
    )
  `, [], path);
}

beforeEach(() => {
  const ts = Date.now();
  testDir = join(tmpdir(), `b2b-security-test-${ts}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  dbPath = join(testDir, 'test.duckdb');
});

afterEach(async () => {
  await closeDb(dbPath);
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Tenant isolation ──────────────────────────────────────────────────────────

describe('tenant', () => {
  it('tenant A cannot read tenant B data', async () => {
    await setupSecurityDb(dbPath);

    // Insert rows for both tenants directly
    const conn = await getConnection(dbPath);
    try {
      await conn.run(
        `INSERT INTO tenant_items (id, tenant_id, name) VALUES ('a1', 'tenant_A', 'Alpha item')`,
      );
      await conn.run(
        `INSERT INTO tenant_items (id, tenant_id, name) VALUES ('b1', 'tenant_B', 'Beta item')`,
      );
    } finally {
      await conn.close();
    }

    const ctxA = createTenantContext('tenant_A', dbPath);
    const ctxB = createTenantContext('tenant_B', dbPath);

    const rowsA = await ctxA.query<{ name: string }>(
      `SELECT name FROM tenant_items`,
    );
    const rowsB = await ctxB.query<{ name: string }>(
      `SELECT name FROM tenant_items`,
    );

    expect(rowsA).toHaveLength(1);
    expect(rowsA[0].name).toBe('Alpha item');

    expect(rowsB).toHaveLength(1);
    expect(rowsB[0].name).toBe('Beta item');
  });

  it('tenant context with WHERE clause preserves existing conditions', async () => {
    await setupSecurityDb(dbPath);

    const conn = await getConnection(dbPath);
    try {
      await conn.run(`INSERT INTO tenant_items (id, tenant_id, name) VALUES ('a1', 'tenant_A', 'Item One')`);
      await conn.run(`INSERT INTO tenant_items (id, tenant_id, name) VALUES ('a2', 'tenant_A', 'Item Two')`);
      await conn.run(`INSERT INTO tenant_items (id, tenant_id, name) VALUES ('b1', 'tenant_B', 'Item One')`);
    } finally {
      await conn.close();
    }

    const ctxA = createTenantContext('tenant_A', dbPath);
    // Filter by name within tenant A — should only return tenant_A rows matching name
    const rows = await ctxA.query<{ id: string; name: string }>(
      `SELECT id, name FROM tenant_items WHERE name = ?`,
      ['Item One'],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('a1');
  });
});

// ── PII encryption ────────────────────────────────────────────────────────────

describe('encryption', () => {
  const keyBase64 = randomBytes(32).toString('base64');

  it('encrypted value differs from plaintext', () => {
    const svc = createEncryptionService(keyBase64);
    const plaintext = 'John';
    const blob = svc.encrypt(plaintext);
    expect(blob).not.toBe(plaintext);
    expect(blob).toContain(':'); // iv:authTag:ciphertext format
  });

  it('decrypt(encrypt(x)) === x (round-trip)', () => {
    const svc = createEncryptionService(keyBase64);
    const cases = [
      'Alice',
      'alice@example.com',
      '+1 (555) 123-4567',
      'Hello "World", this is a test with special chars: <>&!',
      'Unicode: café, naïve, résumé',
    ];
    for (const plaintext of cases) {
      expect(svc.decrypt(svc.encrypt(plaintext))).toBe(plaintext);
    }
  });

  it('each encryption produces a different ciphertext (random IV)', () => {
    const svc = createEncryptionService(keyBase64);
    const a = svc.encrypt('same value');
    const b = svc.encrypt('same value');
    expect(a).not.toBe(b); // different random IV each time
    // Both decrypt to the same plaintext
    expect(svc.decrypt(a)).toBe('same value');
    expect(svc.decrypt(b)).toBe('same value');
  });

  it('throws on invalid key length', () => {
    const badKey = randomBytes(16).toString('base64'); // 16 bytes, not 32
    expect(() => createEncryptionService(badKey)).toThrow();
  });

  it('throws on tampered ciphertext', () => {
    const svc = createEncryptionService(keyBase64);
    const blob = svc.encrypt('secret');
    const parts = blob.split(':');
    // Tamper with the ciphertext part
    parts[2] = Buffer.from('tampered').toString('base64');
    expect(() => svc.decrypt(parts.join(':'))).toThrow();
  });
});

// ── Audit chain integrity ─────────────────────────────────────────────────────

describe('audit', () => {
  it('verifyAuditChain returns valid for correct chain', async () => {
    await setupSecurityDb(dbPath);

    for (let i = 0; i < 10; i++) {
      await appendAuditLog(
        {
          action: 'update',
          entityType: 'account',
          entityId: `entry-${i}`,
          actorId: 'user-1',
          details: { field: 'Company Name', newValue: `Corp ${i}` },
        },
        dbPath,
      );
    }

    const result = await verifyAuditChain(dbPath);
    expect(result.valid).toBe(true);
    expect(result.brokenAt).toBeUndefined();
  });

  it('verifyAuditChain returns invalid when a row is tampered', async () => {
    await setupSecurityDb(dbPath);

    for (let i = 0; i < 5; i++) {
      await appendAuditLog(
        { action: 'create', entityType: 'contact', entityId: `c-${i}` },
        dbPath,
      );
    }

    // Tamper with row 3 by changing its details
    const conn = await getConnection(dbPath);
    try {
      await conn.run(
        `UPDATE audit_log SET details = '{"tampered": true}'
         WHERE id = (
           SELECT id FROM audit_log ORDER BY created_at ASC, id ASC LIMIT 1 OFFSET 2
         )`,
      );
    } finally {
      await conn.close();
    }

    const result = await verifyAuditChain(dbPath);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBeDefined();
    expect(result.brokenAt).toBeGreaterThanOrEqual(3);
  });

  it('first entry has null prev_hash', async () => {
    await setupSecurityDb(dbPath);

    await appendAuditLog(
      { action: 'create', entityType: 'account', entityId: 'entry-1' },
      dbPath,
    );

    const conn = await getConnection(dbPath);
    try {
      const rows = await conn.all<{ prev_hash: string | null }>(
        `SELECT prev_hash FROM audit_log ORDER BY created_at ASC LIMIT 1`,
      );
      expect(rows[0].prev_hash).toBeNull();
    } finally {
      await conn.close();
    }
  });

  it('chain links correctly — each row prev_hash matches previous row hash', async () => {
    await setupSecurityDb(dbPath);

    for (let i = 0; i < 3; i++) {
      await appendAuditLog(
        { action: 'view', entityType: 'deal', entityId: `d-${i}` },
        dbPath,
      );
    }

    const conn = await getConnection(dbPath);
    try {
      const rows = await conn.all<{ hash: string; prev_hash: string | null }>(
        `SELECT hash, prev_hash FROM audit_log ORDER BY created_at ASC, id ASC`,
      );
      expect(rows).toHaveLength(3);
      expect(rows[0].prev_hash).toBeNull();
      expect(rows[1].prev_hash).toBe(rows[0].hash);
      expect(rows[2].prev_hash).toBe(rows[1].hash);
    } finally {
      await conn.close();
    }
  });
});

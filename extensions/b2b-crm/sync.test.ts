import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, execQuery, getConnection, runQuery } from './db.js';
import {
  createHLC,
  compareHLC,
  incrementHLC,
  receiveHLC,
  serializeHLC,
  deserializeHLC,
} from './hlc.js';
import { mergeFieldState, mergeAllFields, type FieldState } from './crdt.js';
import { createMockCloud } from './mock-cloud.js';
import { createSyncQueueService } from './sync-queue.js';

// --- helpers ---

let testDir: string;
let localDbPath: string;
let cloudDbPath: string;

async function setupLocalDb(dbPath: string): Promise<void> {
  await execQuery(
    `CREATE TABLE IF NOT EXISTS sync_state (
      entry_id VARCHAR NOT NULL,
      field_id VARCHAR NOT NULL,
      value VARCHAR,
      hlc_ts BIGINT NOT NULL,
      hlc_counter INTEGER NOT NULL DEFAULT 0,
      node_id VARCHAR NOT NULL,
      PRIMARY KEY (entry_id, field_id)
    )`,
    [],
    dbPath,
  );
  await execQuery(
    `CREATE TABLE IF NOT EXISTS sync_queue (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR,
      operation VARCHAR NOT NULL CHECK (operation IN ('push', 'pull')),
      entry_id VARCHAR NOT NULL,
      field_id VARCHAR,
      value VARCHAR,
      hlc_ts BIGINT NOT NULL,
      hlc_counter INTEGER NOT NULL DEFAULT 0,
      node_id VARCHAR NOT NULL,
      status VARCHAR NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      processed_at TIMESTAMP
    )`,
    [],
    dbPath,
  );
  await execQuery(
    `CREATE TABLE IF NOT EXISTS entry_fields (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR,
      entry_id VARCHAR NOT NULL,
      field_id VARCHAR NOT NULL,
      value VARCHAR,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(entry_id, field_id)
    )`,
    [],
    dbPath,
  );
}

beforeEach(() => {
  const ts = Date.now();
  testDir = join(tmpdir(), `b2b-sync-test-${ts}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  localDbPath = join(testDir, 'local.duckdb');
  cloudDbPath = join(testDir, 'cloud.duckdb');
});

afterEach(async () => {
  await closeDb(localDbPath);
  await closeDb(cloudDbPath);
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ============================================================
// HLC tests
// ============================================================

describe('HLC', () => {
  it('createHLC produces a valid clock', () => {
    const hlc = createHLC('node-a');
    expect(hlc.nodeId).toBe('node-a');
    expect(hlc.counter).toBe(0);
    expect(hlc.ts).toBeGreaterThan(0);
  });

  it('incrementHLC is monotonic', () => {
    const hlc = createHLC('node-a');
    const hlc2 = incrementHLC(hlc);
    expect(compareHLC(hlc2, hlc)).toBeGreaterThan(0);
  });

  it('incrementHLC resets counter when ts advances', () => {
    const hlc = { ts: Date.now() - 5000, counter: 99, nodeId: 'node-a' };
    const next = incrementHLC(hlc);
    expect(next.counter).toBe(0);
    expect(next.ts).toBeGreaterThanOrEqual(Date.now() - 1000);
  });

  it('incrementHLC bumps counter when ts unchanged', () => {
    const now = Date.now() + 999999;
    const hlc = { ts: now, counter: 5, nodeId: 'node-a' };
    const next = incrementHLC(hlc);
    expect(next.ts).toBe(now);
    expect(next.counter).toBe(6);
  });

  it('receiveHLC advances clock past remote', () => {
    const local = createHLC('node-a');
    const remote = { ts: local.ts + 10000, counter: 0, nodeId: 'node-b' };
    const merged = receiveHLC(local, remote);
    expect(merged.ts).toBe(remote.ts);
    expect(compareHLC(merged, remote)).toBeGreaterThan(0);
  });

  it('compareHLC orders by ts then counter then nodeId', () => {
    const a = { ts: 100, counter: 0, nodeId: 'node-a' };
    const b = { ts: 100, counter: 1, nodeId: 'node-b' };
    const c = { ts: 101, counter: 0, nodeId: 'node-a' };
    expect(compareHLC(a, b)).toBeLessThan(0);
    expect(compareHLC(b, a)).toBeGreaterThan(0);
    expect(compareHLC(a, c)).toBeLessThan(0);
    expect(compareHLC(c, a)).toBeGreaterThan(0);
    // nodeId tiebreak
    const x = { ts: 100, counter: 0, nodeId: 'node-a' };
    const y = { ts: 100, counter: 0, nodeId: 'node-b' };
    expect(compareHLC(x, y)).toBeLessThan(0);
  });

  it('serialization round-trip', () => {
    const hlc = { ts: 1714500000000, counter: 42, nodeId: 'my:node:with:colons' };
    const s = serializeHLC(hlc);
    const back = deserializeHLC(s);
    expect(back.ts).toBe(hlc.ts);
    expect(back.counter).toBe(hlc.counter);
    expect(back.nodeId).toBe(hlc.nodeId);
  });
});

// ============================================================
// CRDT merge tests
// ============================================================

describe('CRDT', () => {
  it('local wins when local HLC is higher', () => {
    const local: FieldState = {
      entryId: 'e1', fieldId: 'f1', value: 'local-value',
      hlc: { ts: 200, counter: 0, nodeId: 'node-a' },
    };
    const remote: FieldState = {
      entryId: 'e1', fieldId: 'f1', value: 'remote-value',
      hlc: { ts: 100, counter: 0, nodeId: 'node-b' },
    };
    const winner = mergeFieldState(local, remote);
    expect(winner.value).toBe('local-value');
  });

  it('remote wins when remote HLC is higher', () => {
    const local: FieldState = {
      entryId: 'e1', fieldId: 'f1', value: 'local-value',
      hlc: { ts: 100, counter: 0, nodeId: 'node-a' },
    };
    const remote: FieldState = {
      entryId: 'e1', fieldId: 'f1', value: 'remote-value',
      hlc: { ts: 200, counter: 0, nodeId: 'node-b' },
    };
    const winner = mergeFieldState(local, remote);
    expect(winner.value).toBe('remote-value');
  });

  it('merge is commutative — merge(A,B) === merge(B,A)', () => {
    const a: FieldState = {
      entryId: 'e1', fieldId: 'f1', value: 'aaa',
      hlc: { ts: 150, counter: 3, nodeId: 'node-a' },
    };
    const b: FieldState = {
      entryId: 'e1', fieldId: 'f1', value: 'bbb',
      hlc: { ts: 150, counter: 2, nodeId: 'node-b' },
    };
    expect(mergeFieldState(a, b).value).toBe(mergeFieldState(b, a).value);
  });

  it('auto-merge: different fields on same entry are both preserved', () => {
    const localStates: FieldState[] = [
      { entryId: 'e1', fieldId: 'phone', value: '111', hlc: { ts: 100, counter: 0, nodeId: 'A' } },
    ];
    const remoteStates: FieldState[] = [
      { entryId: 'e1', fieldId: 'industry', value: 'Energy', hlc: { ts: 100, counter: 0, nodeId: 'B' } },
    ];
    const { merged, conflicts } = mergeAllFields(localStates, remoteStates);
    expect(merged).toHaveLength(2);
    expect(conflicts).toHaveLength(0);
    expect(merged.find((s) => s.fieldId === 'phone')?.value).toBe('111');
    expect(merged.find((s) => s.fieldId === 'industry')?.value).toBe('Energy');
  });

  it('conflict: same field, different values — higher HLC wins', () => {
    const localStates: FieldState[] = [
      { entryId: 'e1', fieldId: 'phone', value: '111', hlc: { ts: 200, counter: 0, nodeId: 'A' } },
    ];
    const remoteStates: FieldState[] = [
      { entryId: 'e1', fieldId: 'phone', value: '222', hlc: { ts: 100, counter: 0, nodeId: 'B' } },
    ];
    const { merged, conflicts } = mergeAllFields(localStates, remoteStates);
    expect(merged).toHaveLength(1);
    expect(merged[0].value).toBe('111');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].winner).toBe('local');
  });
});

// ============================================================
// Queue drain tests
// ============================================================

describe('queue drain', () => {
  it('pushes local sync_state to mock cloud and marks done', async () => {
    await setupLocalDb(localDbPath);
    const cloud = createMockCloud(cloudDbPath);

    // Insert a sync_state entry
    await execQuery(
      `INSERT INTO sync_state (entry_id, field_id, value, hlc_ts, hlc_counter, node_id)
       VALUES ('e1', 'f1', 'hello', 1000, 0, 'node-A')`,
      [],
      localDbPath,
    );

    // Insert a pending push to queue
    await execQuery(
      `INSERT INTO sync_queue (operation, entry_id, field_id, value, hlc_ts, hlc_counter, node_id)
       VALUES ('push', 'e1', 'f1', 'hello', 1000, 0, 'node-A')`,
      [],
      localDbPath,
    );

    const svc = createSyncQueueService(cloud, 'node-A', localDbPath);
    const result = await svc.drainOnce();

    // Surface any internal drain error to aid debugging
    if (svc.getLastError()) throw new Error(`drainOnce failed: ${svc.getLastError()}`);
    expect(result.pushed).toBeGreaterThan(0);

    const cloudState = await cloud.getAll();
    expect(cloudState.length).toBeGreaterThan(0);
    expect(cloudState[0].value).toBe('hello');

    const queueRows = await runQuery<{ status: string }>(
      `SELECT status FROM sync_queue WHERE entry_id = 'e1'`,
      [],
      localDbPath,
    );
    expect(queueRows[0].status).toBe('done');
  });

  it('convergence: two nodes make conflicting edits, sync converges', async () => {
    const localDbA = join(testDir, 'node-a.duckdb');
    const localDbB = join(testDir, 'node-b.duckdb');

    await setupLocalDb(localDbA);
    await setupLocalDb(localDbB);

    const cloud = createMockCloud(cloudDbPath);

    // Node A writes field with higher ts
    await execQuery(
      `INSERT INTO sync_state (entry_id, field_id, value, hlc_ts, hlc_counter, node_id)
       VALUES ('e1', 'f1', 'node-a-value', 2000, 0, 'node-A')`,
      [],
      localDbA,
    );
    await execQuery(
      `INSERT INTO sync_queue (operation, entry_id, field_id, value, hlc_ts, hlc_counter, node_id)
       VALUES ('push', 'e1', 'f1', 'node-a-value', 2000, 0, 'node-A')`,
      [],
      localDbA,
    );

    // Node B writes the same field with lower ts
    await execQuery(
      `INSERT INTO sync_state (entry_id, field_id, value, hlc_ts, hlc_counter, node_id)
       VALUES ('e1', 'f1', 'node-b-value', 1000, 0, 'node-B')`,
      [],
      localDbB,
    );
    await execQuery(
      `INSERT INTO sync_queue (operation, entry_id, field_id, value, hlc_ts, hlc_counter, node_id)
       VALUES ('push', 'e1', 'f1', 'node-b-value', 1000, 0, 'node-B')`,
      [],
      localDbB,
    );

    const svcA = createSyncQueueService(cloud, 'node-A', localDbA);
    const svcB = createSyncQueueService(cloud, 'node-B', localDbB);

    // Both nodes drain (push their state, then pull)
    await svcA.drainOnce();
    await svcB.drainOnce();

    // After sync, cloud should have node-A's value (higher HLC)
    const cloudAll = await cloud.getAll();
    const cloudField = cloudAll.find((s) => s.entryId === 'e1' && s.fieldId === 'f1');
    expect(cloudField?.value).toBe('node-a-value');

    await closeDb(localDbA);
    await closeDb(localDbB);
  });
});

// ============================================================
// Sync status tests
// ============================================================

describe('sync status', () => {
  it('pending count matches queue depth before drain', async () => {
    await setupLocalDb(localDbPath);

    // Insert 5 pending items
    for (let i = 0; i < 5; i++) {
      await execQuery(
        `INSERT INTO sync_queue (operation, entry_id, field_id, value, hlc_ts, hlc_counter, node_id)
         VALUES ('push', 'e${i}', 'f1', 'v${i}', ${1000 + i}, 0, 'node-A')`,
        [],
        localDbPath,
      );
    }

    interface CntRow { cnt: number }
    const rows = await runQuery<CntRow>(
      `SELECT COUNT(*) AS cnt FROM sync_queue WHERE status = 'pending'`,
      [],
      localDbPath,
    );
    expect(Number(rows[0].cnt)).toBe(5);
  });

  it('lastSyncAt updates after drain completes', async () => {
    await setupLocalDb(localDbPath);
    const cloud = createMockCloud(cloudDbPath);

    await execQuery(
      `INSERT INTO sync_state (entry_id, field_id, value, hlc_ts, hlc_counter, node_id)
       VALUES ('e1', 'f1', 'v1', 1000, 0, 'node-A')`,
      [],
      localDbPath,
    );
    await execQuery(
      `INSERT INTO sync_queue (operation, entry_id, field_id, value, hlc_ts, hlc_counter, node_id)
       VALUES ('push', 'e1', 'f1', 'v1', 1000, 0, 'node-A')`,
      [],
      localDbPath,
    );

    const svc = createSyncQueueService(cloud, 'node-A', localDbPath);
    expect(svc.getLastSyncAt()).toBeNull();

    await svc.drainOnce();
    expect(svc.getLastSyncAt()).not.toBeNull();
    expect(svc.isOnline()).toBe(true);

    interface CntRow { cnt: number }
    const pendingRows = await runQuery<CntRow>(
      `SELECT COUNT(*) AS cnt FROM sync_queue WHERE status = 'pending'`,
      [],
      localDbPath,
    );
    expect(Number(pendingRows[0].cnt)).toBe(0);
  });
});

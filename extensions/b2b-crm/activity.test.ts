import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { closeDb, execQuery, getConnection } from './db.js';
import { createObjects, createPivotViews } from './objects.js';
import { createStandaloneTables } from './tables.js';
import { logEvent, startSession, getEventsForEntity, getSessionEvents, type ActivityEvent } from './capture.js';
import { computeEngagementScores, getEngagementScore } from './scoring.js';
import { findNeglectedEntities } from './neglect.js';
import { detectAnomalies } from './anomaly.js';
import { getStakeholderMap, detectStakeholderRisks } from './stakeholder-graph.js';
import { computeDealMomentum } from './momentum.js';

// ── helpers ───────────────────────────────────────────────────────────────────

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

async function insertEntry(objectName: string, path: string): Promise<string> {
  const id = randomUUID();
  const conn = await getConnection(path);
  try {
    await conn.run(
      `INSERT INTO entries (id, object_id) VALUES (?, (SELECT id FROM objects WHERE name = ?))`,
      id, objectName,
    );
  } finally {
    await conn.close();
  }
  return id;
}

async function insertField(entryId: string, objectName: string, fieldName: string, value: string, path: string): Promise<void> {
  const conn = await getConnection(path);
  try {
    await conn.run(
      `INSERT INTO entry_fields (entry_id, field_id, value)
       VALUES (?, (SELECT id FROM fields WHERE object_id=(SELECT id FROM objects WHERE name=?) AND name=?), ?)
       ON CONFLICT (entry_id, field_id) DO UPDATE SET value = excluded.value`,
      entryId, objectName, fieldName, value,
    );
  } finally {
    await conn.close();
  }
}

async function insertTransition(entryId: string, toStatus: string, durationSecs: number, daysAgo: number, path: string): Promise<void> {
  const conn = await getConnection(path);
  try {
    await conn.run(
      `INSERT INTO transition_history (entry_id, object_name, to_status, duration_seconds, changed_at)
       VALUES (?, 'deal', ?, ?, CURRENT_TIMESTAMP - (? * INTERVAL '1 day'))`,
      entryId, toStatus, durationSecs, daysAgo,
    );
  } finally {
    await conn.close();
  }
}

beforeEach(() => {
  const ts = Date.now();
  testDir = join(tmpdir(), `b2b-activity-test-${ts}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  dbPath = join(testDir, 'test.duckdb');
});

afterEach(async () => {
  await closeDb(dbPath);
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Event capture ─────────────────────────────────────────────────────────────

describe('capture', () => {
  it('logEvent stores event and getEventsForEntity retrieves it', async () => {
    await setupFullDb(dbPath);
    const entityId = await insertEntry('account', dbPath);
    const event: ActivityEvent = { eventType: 'view', entityType: 'account', entityId };
    await logEvent(event, dbPath);
    const events = await getEventsForEntity('account', entityId, 10, dbPath);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('view');
    expect(events[0].entityId).toBe(entityId);
  });

  it('returns most recent events first', async () => {
    await setupFullDb(dbPath);
    const entityId = await insertEntry('account', dbPath);
    await logEvent({ eventType: 'view', entityType: 'account', entityId }, dbPath);
    await logEvent({ eventType: 'update', entityType: 'account', entityId }, dbPath);
    const events = await getEventsForEntity('account', entityId, 10, dbPath);
    expect(events[0].eventType).toBe('update');
  });
});

// ── Navigation sequences ──────────────────────────────────────────────────────

describe('navigation', () => {
  it('session events have incrementing sequence numbers', async () => {
    await setupFullDb(dbPath);
    const entityId = await insertEntry('account', dbPath);
    const sessionId = startSession();
    const types: Array<ActivityEvent['eventType']> = ['view', 'update', 'navigate', 'search', 'view'];
    for (const eventType of types) {
      await logEvent({ eventType, entityType: 'account', entityId, sessionId }, dbPath);
    }
    const events = await getSessionEvents(sessionId, dbPath);
    expect(events).toHaveLength(5);
    expect(events.map((e, i) => i + 1)).toEqual([1, 2, 3, 4, 5]);
    // Verify session_id in all events
    const conn = await getConnection(dbPath);
    try {
      const rows = await conn.all<{ sequence_number: number }>(
        `SELECT sequence_number FROM activity_events WHERE session_id = ? ORDER BY sequence_number`,
        sessionId,
      );
      expect(rows.map((r) => r.sequence_number)).toEqual([1, 2, 3, 4, 5]);
    } finally {
      await conn.close();
    }
  });
});

// ── Engagement scoring ────────────────────────────────────────────────────────

describe('scoring', () => {
  it('entity with recent activity scores higher than entity with distant activity', async () => {
    await setupFullDb(dbPath);
    const activeId = await insertEntry('account', dbPath);
    const inactiveId = await insertEntry('account', dbPath);

    // active: 5 events in last 2 days
    const conn = await getConnection(dbPath);
    try {
      for (let i = 0; i < 5; i++) {
        await conn.run(
          `INSERT INTO activity_events (id, event_type, entity_type, entity_id, occurred_at) VALUES (?, 'view', 'account', ?, CURRENT_TIMESTAMP - (? * INTERVAL '1 day'))`,
          randomUUID(), activeId, i % 2,
        );
      }
      // inactive: 1 event 60 days ago
      await conn.run(
        `INSERT INTO activity_events (id, event_type, entity_type, entity_id, occurred_at) VALUES (?, 'view', 'account', ?, CURRENT_TIMESTAMP - (60 * INTERVAL '1 day'))`,
        randomUUID(), inactiveId,
      );
    } finally {
      await conn.close();
    }

    const scores = await computeEngagementScores('account', 90, dbPath);
    const activeScore = scores.find((s) => s.entityId === activeId);
    const inactiveScore = scores.find((s) => s.entityId === inactiveId);

    expect(activeScore).toBeDefined();
    expect(activeScore!.score).toBeGreaterThan(0);
    expect(inactiveScore).toBeDefined();
    expect(activeScore!.score).toBeGreaterThan(inactiveScore!.score);
  });

  it('getEngagementScore returns null if no activity in window', async () => {
    await setupFullDb(dbPath);
    const entityId = await insertEntry('account', dbPath);
    const result = await getEngagementScore('account', entityId, 30, dbPath);
    expect(result).toBeNull();
  });
});

// ── Neglect detection ─────────────────────────────────────────────────────────

describe('neglect', () => {
  it('flags account with no activity in 31 days, ignores recent account', async () => {
    await setupFullDb(dbPath);
    const neglectedId = await insertEntry('account', dbPath);
    const activeId = await insertEntry('account', dbPath);

    const conn = await getConnection(dbPath);
    try {
      await conn.run(
        `INSERT INTO activity_events (id, event_type, entity_type, entity_id, occurred_at) VALUES (?, 'view', 'account', ?, CURRENT_TIMESTAMP - (31 * INTERVAL '1 day'))`,
        randomUUID(), neglectedId,
      );
      await conn.run(
        `INSERT INTO activity_events (id, event_type, entity_type, entity_id, occurred_at) VALUES (?, 'view', 'account', ?, CURRENT_TIMESTAMP - INTERVAL '1 hour')`,
        randomUUID(), activeId,
      );
    } finally {
      await conn.close();
    }

    const neglected = await findNeglectedEntities('account', 30, dbPath);
    const ids = neglected.map((n) => n.entityId);
    expect(ids).toContain(neglectedId);
    expect(ids).not.toContain(activeId);
  });

  it('flags entity with no events at all', async () => {
    await setupFullDb(dbPath);
    const neverTouchedId = await insertEntry('account', dbPath);
    const neglected = await findNeglectedEntities('account', 30, dbPath);
    expect(neglected.some((n) => n.entityId === neverTouchedId)).toBe(true);
    const row = neglected.find((n) => n.entityId === neverTouchedId);
    expect(row?.lastActivity).toBeNull();
  });
});

// ── Anomaly detection ─────────────────────────────────────────────────────────

describe('anomaly', () => {
  it('detects spike of 10x normal activity', async () => {
    await setupFullDb(dbPath);
    const entityId = await insertEntry('account', dbPath);

    const conn = await getConnection(dbPath);
    try {
      // 30 days of normal baseline: 1 event per day
      for (let d = 30; d >= 1; d--) {
        await conn.run(
          `INSERT INTO activity_events (id, event_type, entity_type, entity_id, occurred_at) VALUES (?, 'view', 'account', ?, CURRENT_TIMESTAMP - (? * INTERVAL '1 day'))`,
          randomUUID(), entityId, d,
        );
      }
      // Today: 10 events (spike)
      for (let i = 0; i < 10; i++) {
        await conn.run(
          `INSERT INTO activity_events (id, event_type, entity_type, entity_id, occurred_at) VALUES (?, 'view', 'account', ?, CURRENT_TIMESTAMP - (? * INTERVAL '1 hour'))`,
          randomUUID(), entityId, i,
        );
      }
    } finally {
      await conn.close();
    }

    const anomalies = await detectAnomalies('account', 30, 2.0, dbPath);
    expect(anomalies.length).toBeGreaterThan(0);
    const anomaly = anomalies.find((a) => a.entityId === entityId);
    expect(anomaly).toBeDefined();
    expect(anomaly!.zScore).toBeGreaterThan(2.0);
  });
});

// ── Stakeholder graph ─────────────────────────────────────────────────────────

describe('stakeholder', () => {
  it('getStakeholderMap returns correct nodes and edges', async () => {
    await setupFullDb(dbPath);
    const dealId = await insertEntry('deal', dbPath);
    const contact1Id = await insertEntry('contact', dbPath);
    const contact2Id = await insertEntry('contact', dbPath);
    await insertField(contact1Id, 'contact', 'First Name', 'Alice', dbPath);
    await insertField(contact2Id, 'contact', 'First Name', 'Bob', dbPath);

    const conn = await getConnection(dbPath);
    try {
      await conn.run(
        `INSERT INTO contact_deal_roles (contact_entry_id, deal_entry_id, role) VALUES (?, ?, 'champion')`,
        contact1Id, dealId,
      );
      await conn.run(
        `INSERT INTO contact_deal_roles (contact_entry_id, deal_entry_id, role) VALUES (?, ?, 'decision_maker')`,
        contact2Id, dealId,
      );
      await conn.run(
        `INSERT INTO stakeholder_edges (from_contact_id, to_contact_id, relationship_type, deal_id, weight) VALUES (?, ?, 'champions_for', ?, 1.5)`,
        contact1Id, contact2Id, dealId,
      );
    } finally {
      await conn.close();
    }

    const map = await getStakeholderMap(dealId, dbPath);
    expect(map.dealId).toBe(dealId);
    expect(map.nodes).toHaveLength(2);
    expect(map.edges).toHaveLength(1);
    expect(map.edges[0].type).toBe('champions_for');
    expect(map.riskFactors).not.toContain('No decision maker identified');
    expect(map.riskFactors).not.toContain('Single-threaded deal — only one contact engaged');
  });

  it('detectStakeholderRisks flags single-threaded deal', async () => {
    await setupFullDb(dbPath);
    const dealId = await insertEntry('deal', dbPath);
    const contactId = await insertEntry('contact', dbPath);
    await insertField(contactId, 'contact', 'First Name', 'Solo', dbPath);

    const conn = await getConnection(dbPath);
    try {
      await conn.run(
        `INSERT INTO contact_deal_roles (contact_entry_id, deal_entry_id, role) VALUES (?, ?, 'influencer')`,
        contactId, dealId,
      );
    } finally {
      await conn.close();
    }

    const risks = await detectStakeholderRisks(dealId, dbPath);
    expect(risks).toContain('No decision maker identified');
    expect(risks).toContain('Single-threaded deal — only one contact engaged');
  });
});

// ── Deal momentum ─────────────────────────────────────────────────────────────

describe('momentum', () => {
  it('stalling deal scores lower than on_track deal', async () => {
    await setupFullDb(dbPath);
    const stallingDealId = await insertEntry('deal', dbPath);
    const onTrackDealId = await insertEntry('deal', dbPath);
    await insertField(stallingDealId, 'deal', 'Deal Name', 'Stalling Deal', dbPath);
    await insertField(onTrackDealId, 'deal', 'Deal Name', 'On Track Deal', dbPath);

    // Stalling: avg days = 10, current stage = 25 days (2.5x average)
    await insertTransition(stallingDealId, 'qualified', 864000, 35, dbPath);  // 10 days duration, 35 days ago
    await insertTransition(stallingDealId, 'proposal',  864000, 25, dbPath);  // stuck here 25 days

    // On-track: avg days = 10, current stage = 5 days (0.5x average)
    await insertTransition(onTrackDealId, 'qualified', 864000, 15, dbPath);
    await insertTransition(onTrackDealId, 'proposal',  864000, 5, dbPath);

    const results = await computeDealMomentum(undefined, dbPath);
    const stalling = results.find((r) => r.dealId === stallingDealId);
    const onTrack = results.find((r) => r.dealId === onTrackDealId);

    expect(stalling).toBeDefined();
    expect(onTrack).toBeDefined();
    expect(['stalling', 'at_risk']).toContain(stalling!.signal);
    expect(['on_track', 'accelerating']).toContain(onTrack!.signal);
    expect(onTrack!.momentumScore).toBeGreaterThan(stalling!.momentumScore);
  });
});

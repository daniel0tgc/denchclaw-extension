import { createHash } from 'node:crypto';
import { getConnection, runQuery } from './db.js';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string;
  actorId?: string;
  details?: Record<string, unknown>;
}

interface AuditRow {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  actor_id: string | null;
  details: string | null;
  prev_hash: string | null;
  hash: string;
  // DuckDB returns TIMESTAMP columns as JavaScript Date objects via duckdb-async
  created_at: Date | string;
}

/**
 * Normalizes a TIMESTAMP value (Date object or string) to a millisecond-precision ISO 8601 string.
 * DuckDB stores TIMESTAMP with microsecond precision but JavaScript Date has millisecond precision,
 * so round-tripping through DuckDB preserves milliseconds exactly.
 * Keeping milliseconds also ensures unique ordering for rows inserted within the same second.
 */
function normalizeTimestamp(ts: Date | string): string {
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  return d.toISOString(); // e.g. "2026-04-30T22:17:04.123Z"
}

/**
 * Computes the SHA-256 hash for one audit row.
 * Input: prev_hash + action + entity_type + entity_id + actor_id + JSON(details) + created_at
 */
function computeHash(
  prevHash: string | null,
  action: string,
  entityType: string,
  entityId: string,
  actorId: string | null,
  details: Record<string, unknown> | null,
  createdAt: Date | string,
): string {
  const payload = [
    prevHash ?? '',
    action,
    entityType,
    entityId,
    actorId ?? '',
    details ? JSON.stringify(details) : '',
    normalizeTimestamp(createdAt),
  ].join('|');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Appends a tamper-evident entry to the audit log.
 * Each entry's hash includes the previous entry's hash, forming a chain.
 */
export async function appendAuditLog(
  entry: AuditEntry,
  dbPath?: string,
): Promise<void> {
  const conn = await getConnection(dbPath);
  try {
    // Get the last row's hash (or null for first entry)
    const lastRows = await conn.all<Pick<AuditRow, 'hash'>>(
      `SELECT hash FROM audit_log ORDER BY created_at DESC, id DESC LIMIT 1`,
    );
    const prevHash = lastRows.length > 0 ? lastRows[0].hash : null;
    // Use millisecond-precision ISO string — round-trips through DuckDB TIMESTAMP correctly
    const now = normalizeTimestamp(new Date());

    const hash = computeHash(
      prevHash,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.actorId ?? null,
      entry.details ?? null,
      now,
    );

    await conn.run(
      `INSERT INTO audit_log (action, entity_type, entity_id, actor_id, details, prev_hash, hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.actorId ?? null,
      entry.details ? JSON.stringify(entry.details) : null,
      prevHash,
      hash,
      now,
    );
  } finally {
    await conn.close();
  }
}

/**
 * Verifies the integrity of the audit chain by recomputing each row's hash.
 * Returns { valid: true } if the chain is intact, or { valid: false, brokenAt: rowIndex } (1-based).
 */
export async function verifyAuditChain(
  dbPath?: string,
): Promise<{ valid: boolean; brokenAt?: number }> {
  const rows = await runQuery<AuditRow>(
    `SELECT id, action, entity_type, entity_id, actor_id, details, prev_hash, hash, created_at
     FROM audit_log
     ORDER BY created_at ASC, id ASC`,
    [],
    dbPath,
  );

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let detailsParsed: Record<string, unknown> | null = null;
    if (row.details) {
      try {
        detailsParsed = JSON.parse(row.details) as Record<string, unknown>;
      } catch {
        return { valid: false, brokenAt: i + 1 };
      }
    }

    const expected = computeHash(
      row.prev_hash,
      row.action,
      row.entity_type,
      row.entity_id,
      row.actor_id,
      detailsParsed,
      row.created_at,
    );

    if (expected !== row.hash) {
      return { valid: false, brokenAt: i + 1 };
    }
  }

  return { valid: true };
}

/**
 * Returns the audit trail for a specific entity, ordered newest-first.
 */
export async function getAuditTrail(
  entityType: string,
  entityId: string,
  dbPath?: string,
): Promise<AuditEntry[]> {
  const rows = await runQuery<AuditRow>(
    `SELECT action, entity_type, entity_id, actor_id, details
     FROM audit_log
     WHERE entity_type = ? AND entity_id = ?
     ORDER BY created_at DESC, id DESC`,
    [entityType, entityId],
    dbPath,
  );

  return rows.map((r) => ({
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    actorId: r.actor_id ?? undefined,
    details: r.details ? (JSON.parse(r.details) as Record<string, unknown>) : undefined,
  }));
}

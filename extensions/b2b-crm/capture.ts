import { randomUUID } from 'node:crypto';
import { getConnection } from './db.js';

export type EventType =
  | 'view' | 'create' | 'update' | 'delete' | 'search'
  | 'export' | 'import' | 'sync' | 'stage_change' | 'navigate';

export interface ActivityEvent {
  eventType: EventType;
  entityType: string;
  entityId: string;
  userId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

interface ActivityEventRow {
  id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  user_id: string | null;
  session_id: string | null;
  sequence_number: number | null;
  metadata: string | null;
  occurred_at: Date;
}

function rowToEvent(r: ActivityEventRow): ActivityEvent {
  return {
    eventType: r.event_type as EventType,
    entityType: r.entity_type,
    entityId: r.entity_id,
    userId: r.user_id ?? undefined,
    sessionId: r.session_id ?? undefined,
    metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : undefined,
  };
}

/** Generates a new session ID for a navigation sequence. */
export function startSession(): string {
  return randomUUID();
}

/**
 * Inserts an activity event into activity_events.
 * If sessionId is provided, auto-assigns sequence_number as MAX + 1 within the session.
 */
export async function logEvent(event: ActivityEvent, dbPath?: string): Promise<void> {
  const conn = await getConnection(dbPath);
  try {
    let seqNum: number | null = null;
    if (event.sessionId) {
      const rows = await conn.all<{ max_seq: number | bigint | null }>(
        `SELECT MAX(sequence_number) AS max_seq FROM activity_events WHERE session_id = ?`,
        event.sessionId,
      );
      const prev = rows[0]?.max_seq;
      seqNum = prev != null ? Number(prev) + 1 : 1;
    }
    await conn.run(
      `INSERT INTO activity_events (id, event_type, entity_type, entity_id, user_id, session_id, sequence_number, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(),
      event.eventType,
      event.entityType,
      event.entityId,
      event.userId ?? null,
      event.sessionId ?? null,
      seqNum,
      event.metadata ? JSON.stringify(event.metadata) : null,
    );
  } finally {
    await conn.close();
  }
}

/** Returns all events for an entity, most recent first. */
export async function getEventsForEntity(
  entityType: string,
  entityId: string,
  limit = 50,
  dbPath?: string,
): Promise<ActivityEvent[]> {
  const conn = await getConnection(dbPath);
  try {
    const rows = await conn.all<ActivityEventRow>(
      `SELECT * FROM activity_events
       WHERE entity_type = ? AND entity_id = ?
       ORDER BY occurred_at DESC
       LIMIT ?`,
      entityType, entityId, limit,
    );
    return rows.map(rowToEvent);
  } finally {
    await conn.close();
  }
}

/** Returns all events after the given date, ascending. */
export async function getEventsSince(since: Date, dbPath?: string): Promise<ActivityEvent[]> {
  const conn = await getConnection(dbPath);
  try {
    const rows = await conn.all<ActivityEventRow>(
      `SELECT * FROM activity_events WHERE occurred_at > ? ORDER BY occurred_at ASC`,
      since.toISOString(),
    );
    return rows.map(rowToEvent);
  } finally {
    await conn.close();
  }
}

/** Returns events for a session in sequence order — reconstructs the navigation journey. */
export async function getSessionEvents(sessionId: string, dbPath?: string): Promise<ActivityEvent[]> {
  const conn = await getConnection(dbPath);
  try {
    const rows = await conn.all<ActivityEventRow>(
      `SELECT * FROM activity_events WHERE session_id = ? ORDER BY sequence_number ASC`,
      sessionId,
    );
    return rows.map(rowToEvent);
  } finally {
    await conn.close();
  }
}

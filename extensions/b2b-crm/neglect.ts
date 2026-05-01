import { getConnection } from './db.js';

export interface NeglectedEntity {
  entityId: string;
  entityType: string;
  lastActivity: Date | null;
  daysSinceActivity: number;
}

/**
 * Returns entities of the given type that have had no activity within the threshold.
 * Includes entities with zero activity (never touched). Sorted most-neglected first.
 *
 * Default thresholds: 30 days for accounts/contacts, 14 days for deals.
 */
export async function findNeglectedEntities(
  entityType: string,
  thresholdDays?: number,
  dbPath?: string,
): Promise<NeglectedEntity[]> {
  const threshold = thresholdDays ?? (entityType === 'deal' ? 14 : 30);

  const conn = await getConnection(dbPath);
  try {
    const rows = await conn.all<{
      entity_id: string;
      last_activity: Date | null;
      days_since: number | bigint | null;
    }>(
      `SELECT
         e.id AS entity_id,
         MAX(ae.occurred_at) AS last_activity,
         COALESCE(
           DATEDIFF('day', MAX(ae.occurred_at), CURRENT_TIMESTAMP),
           ?
         ) AS days_since
       FROM entries e
       JOIN objects o ON e.object_id = o.id AND o.name = ?
       LEFT JOIN activity_events ae
         ON ae.entity_id = e.id AND ae.entity_type = ?
       GROUP BY e.id
       HAVING COALESCE(
         DATEDIFF('day', MAX(ae.occurred_at), CURRENT_TIMESTAMP),
         ?
       ) >= ?
       ORDER BY days_since DESC`,
      threshold + 1,  // sentinel for null (no activity ever)
      entityType,
      entityType,
      threshold + 1,
      threshold,
    );

    return rows.map((r) => ({
      entityId: r.entity_id,
      entityType,
      lastActivity: r.last_activity ? new Date(r.last_activity) : null,
      daysSinceActivity: Number(r.days_since),
    }));
  } finally {
    await conn.close();
  }
}

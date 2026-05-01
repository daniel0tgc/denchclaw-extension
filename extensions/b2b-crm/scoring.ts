import { getConnection } from './db.js';

export interface EngagementScore {
  entityId: string;
  entityType: string;
  score: number;
  recency: number;
  frequency: number;
  depth: number;
  lastActivity: Date;
}

const SCORING_SQL = `
  WITH per_entity AS (
    SELECT entity_id, entity_type,
      COUNT(*) AS event_count,
      MAX(occurred_at) AS last_activity,
      SUM(CASE event_type
        WHEN 'create'       THEN 3.0
        WHEN 'update'       THEN 2.0
        WHEN 'stage_change' THEN 2.5
        WHEN 'view'         THEN 1.0
        WHEN 'search'       THEN 0.5
        ELSE 1.0
      END) AS depth_sum
    FROM activity_events
    WHERE entity_type = ?
      AND occurred_at >= CURRENT_TIMESTAMP - (? * INTERVAL '1 day')
    GROUP BY entity_id, entity_type
  ),
  normed AS (
    SELECT *,
      MAX(event_count) OVER () AS max_count,
      MAX(depth_sum)   OVER () AS max_depth
    FROM per_entity
  )
  SELECT
    entity_id,
    entity_type,
    last_activity,
    (1.0 / (1.0 + DATEDIFF('day', last_activity, CURRENT_TIMESTAMP))) AS recency,
    CASE WHEN max_count <= 1 THEN 1.0
         ELSE LN(1.0 + event_count) / LN(1.0 + max_count) END AS frequency,
    CASE WHEN max_depth = 0 THEN 0.0
         ELSE depth_sum / max_depth END AS depth
  FROM normed
`;

interface ScoringRow {
  entity_id: string;
  entity_type: string;
  last_activity: Date;
  recency: number;
  frequency: number;
  depth: number;
}

function rowToScore(r: ScoringRow): EngagementScore {
  const recency = Number(r.recency);
  const frequency = Number(r.frequency);
  const depth = Number(r.depth);
  return {
    entityId: r.entity_id,
    entityType: r.entity_type,
    score: 0.4 * recency + 0.3 * frequency + 0.3 * depth,
    recency,
    frequency,
    depth,
    lastActivity: new Date(r.last_activity),
  };
}

/**
 * Returns engagement scores for all entities of the given type that had activity
 * within the window. Entities outside the window are omitted (score = 0 effectively).
 */
export async function computeEngagementScores(
  entityType: string,
  windowDays = 90,
  dbPath?: string,
): Promise<EngagementScore[]> {
  const conn = await getConnection(dbPath);
  try {
    const rows = await conn.all<ScoringRow>(SCORING_SQL, entityType, windowDays);
    return rows.map(rowToScore);
  } finally {
    await conn.close();
  }
}

/**
 * Returns the engagement score for a single entity, or null if no activity in window.
 */
export async function getEngagementScore(
  entityType: string,
  entityId: string,
  windowDays = 90,
  dbPath?: string,
): Promise<EngagementScore | null> {
  const conn = await getConnection(dbPath);
  try {
    const rows = await conn.all<ScoringRow>(
      SCORING_SQL + ' WHERE entity_id = ?',
      entityType, windowDays, entityId,
    );
    return rows.length > 0 ? rowToScore(rows[0]) : null;
  } finally {
    await conn.close();
  }
}

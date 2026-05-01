import { getConnection } from './db.js';

export interface ActivityAnomaly {
  entityId: string;
  entityType: string;
  metric: string;
  currentValue: number;
  rollingAvg: number;
  stdDev: number;
  zScore: number;
}

/**
 * Detects anomalies in daily activity counts using a rolling z-score.
 * Returns entities whose most recent day count deviates from the 30-day rolling
 * average by more than zScoreThreshold standard deviations.
 */
export async function detectAnomalies(
  entityType: string,
  windowDays = 30,
  zScoreThreshold = 2.0,
  dbPath?: string,
): Promise<ActivityAnomaly[]> {
  const conn = await getConnection(dbPath);
  try {
    const rows = await conn.all<{
      entity_id: string;
      current_cnt: number | bigint;
      avg_cnt: number;
      std_cnt: number | null;
      z_score: number | null;
      day: Date;
    }>(
      `WITH daily_counts AS (
         SELECT entity_id,
           DATE_TRUNC('day', occurred_at) AS day,
           COUNT(*) AS cnt
         FROM activity_events
         WHERE entity_type = ?
         GROUP BY entity_id, DATE_TRUNC('day', occurred_at)
       ),
       rolling AS (
         SELECT entity_id, day, cnt AS current_cnt,
           AVG(cnt) OVER (
             PARTITION BY entity_id
             ORDER BY day
             ROWS BETWEEN ? PRECEDING AND CURRENT ROW
           ) AS avg_cnt,
           STDDEV(cnt) OVER (
             PARTITION BY entity_id
             ORDER BY day
             ROWS BETWEEN ? PRECEDING AND CURRENT ROW
           ) AS std_cnt
         FROM daily_counts
       ),
       latest AS (
         SELECT entity_id, current_cnt, avg_cnt, std_cnt, day,
           ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY day DESC) AS rn
         FROM rolling
       )
       SELECT entity_id, current_cnt, avg_cnt, std_cnt, day,
         (current_cnt - avg_cnt) / NULLIF(std_cnt, 0) AS z_score
       FROM latest
       WHERE rn = 1
         AND ABS((current_cnt - avg_cnt) / NULLIF(std_cnt, 0)) > ?`,
      entityType,
      windowDays - 1,  // ROWS BETWEEN N PRECEDING means window size = N+1
      windowDays - 1,
      zScoreThreshold,
    );

    return rows.map((r) => ({
      entityId: r.entity_id,
      entityType,
      metric: 'daily_event_count',
      currentValue: Number(r.current_cnt),
      rollingAvg: Number(r.avg_cnt),
      stdDev: Number(r.std_cnt ?? 0),
      zScore: Number(r.z_score ?? 0),
    }));
  } finally {
    await conn.close();
  }
}

import { getConnection } from './db.js';

export interface DealMomentum {
  dealId: string;
  dealName: string;
  currentStage: string;
  daysInCurrentStage: number;
  avgDaysPerStage: number;
  stageVelocity: number;
  closeDateDrift: number;
  momentumScore: number;
  signal: 'accelerating' | 'on_track' | 'stalling' | 'at_risk';
}

interface MomentumRow {
  entry_id: string;
  deal_name: string | null;
  current_stage: string | null;
  days_in_stage: number | bigint;
  avg_days: number | null;
  stage_count: number | bigint;
  total_days: number | bigint | null;
  expected_close: string | null;
  last_activity: Date | null;
}

function classifySignal(
  daysInStage: number,
  avgDays: number,
  closeDateDrift: number,
  lastActivityDaysAgo: number | null,
): DealMomentum['signal'] {
  const stalling = daysInStage > 1.5 * avgDays;
  if (stalling) {
    if (closeDateDrift > 14 || (lastActivityDaysAgo != null && lastActivityDaysAgo >= 14)) {
      return 'at_risk';
    }
    return 'stalling';
  }
  if (daysInStage < 0.5 * avgDays && closeDateDrift <= 0) return 'accelerating';
  return 'on_track';
}

/**
 * Computes deal momentum for one deal (by dealId) or all deals (omit dealId).
 * Uses transition_history for stage durations and v_deal for expected close date.
 */
export async function computeDealMomentum(dealId?: string, dbPath?: string): Promise<DealMomentum[]> {
  const conn = await getConnection(dbPath);
  try {
    const whereClause = dealId ? 'AND th.entry_id = ?' : '';
    const params: unknown[] = dealId ? [dealId] : [];

    const rows = await conn.all<MomentumRow>(
      `WITH last_transition AS (
         SELECT entry_id,
           to_status AS current_stage,
           DATEDIFF('day', changed_at, CURRENT_TIMESTAMP) AS days_in_stage,
           ROW_NUMBER() OVER (PARTITION BY entry_id ORDER BY changed_at DESC) AS rn
         FROM transition_history
         WHERE object_name = 'deal'
       ),
       avg_stage AS (
         SELECT entry_id,
           AVG(duration_seconds) / 86400.0 AS avg_days,
           COUNT(*) AS stage_count,
           DATEDIFF('day', MIN(changed_at), CURRENT_TIMESTAMP) AS total_days
         FROM transition_history
         WHERE object_name = 'deal'
         GROUP BY entry_id
       ),
       last_activity AS (
         SELECT entity_id,
           MAX(occurred_at) AS last_active
         FROM activity_events WHERE entity_type = 'deal'
         GROUP BY entity_id
       )
       SELECT
         lt.entry_id,
         vd."Deal Name" AS deal_name,
         lt.current_stage,
         lt.days_in_stage,
         COALESCE(a.avg_days, 0) AS avg_days,
         COALESCE(a.stage_count, 0) AS stage_count,
         COALESCE(a.total_days, 0) AS total_days,
         vd."Expected Close" AS expected_close,
         la.last_active AS last_activity
       FROM last_transition lt
       LEFT JOIN v_deal vd ON vd.entry_id = lt.entry_id
       LEFT JOIN avg_stage a ON a.entry_id = lt.entry_id
       LEFT JOIN last_activity la ON la.entity_id = lt.entry_id
       WHERE lt.rn = 1 ${whereClause}`,
      ...params,
    );

    return rows.map((r) => {
      const daysInStage = Number(r.days_in_stage);
      const avgDays = Number(r.avg_days) || 30;
      const stageCount = Number(r.stage_count);
      const totalDays = Number(r.total_days) || 1;
      const stageVelocity = stageCount / totalDays;

      // closeDateDrift: positive = pushed out (worse), negative = pulled in
      let closeDateDrift = 0;
      if (r.expected_close) {
        const closeMs = new Date(r.expected_close).getTime();
        const todayMs = Date.now();
        closeDateDrift = Math.floor((closeMs - todayMs) / 86_400_000);
        // Negate to match spec: positive = pushed out
        closeDateDrift = closeDateDrift < 0 ? Math.abs(closeDateDrift) : 0;
      }

      const lastActivityDaysAgo = r.last_activity
        ? Math.floor((Date.now() - new Date(r.last_activity).getTime()) / 86_400_000)
        : null;

      const momentumScore = stageVelocity * (1 / (1 + daysInStage / Math.max(avgDays, 1)));

      return {
        dealId: r.entry_id,
        dealName: r.deal_name ?? r.entry_id,
        currentStage: r.current_stage ?? 'unknown',
        daysInCurrentStage: daysInStage,
        avgDaysPerStage: avgDays,
        stageVelocity,
        closeDateDrift,
        momentumScore,
        signal: classifySignal(daysInStage, avgDays, closeDateDrift, lastActivityDaysAgo),
      };
    });
  } finally {
    await conn.close();
  }
}

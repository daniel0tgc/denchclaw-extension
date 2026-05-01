import { getEngagementScore } from './scoring.js';
import { findNeglectedEntities } from './neglect.js';

export interface EnrichedResult {
  id: string;
  score: number;
  engagement_score: number | null;
  neglect_flag: boolean;
  days_since_activity: number | null;
}

/**
 * Enriches search results with live intelligence fields from activity_events.
 * Runs one engagement score query and one neglect query per call.
 * Returns results in the same order as the input array.
 */
export async function enrichSearchResults(
  results: Array<{ id: string; score: number }>,
  entityType: string,
  dbPath?: string,
): Promise<EnrichedResult[]> {
  if (results.length === 0) return [];

  // Fetch neglected entity IDs for this type (30-day default threshold)
  const neglected = await findNeglectedEntities(entityType, undefined, dbPath);
  const neglectedIds = new Set(neglected.map((n) => n.entityId));
  const daysSinceMap = new Map(neglected.map((n) => [n.entityId, n.daysSinceActivity]));

  const enriched: EnrichedResult[] = [];
  for (const r of results) {
    const engScore = await getEngagementScore(entityType, r.id, 90, dbPath);
    const isNeglected = neglectedIds.has(r.id);
    enriched.push({
      id: r.id,
      score: r.score,
      engagement_score: engScore ? engScore.score : null,
      neglect_flag: isNeglected,
      days_since_activity: daysSinceMap.get(r.id) ?? null,
    });
  }
  return enriched;
}

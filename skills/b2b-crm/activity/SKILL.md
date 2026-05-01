---
name: b2b-activity
description: Query engagement scores, neglect flags, stakeholder maps, deal momentum, attention heatmaps, and activity anomalies.
metadata: { "openclaw": { "inject": true, "always": true } }
---

# Activity Intelligence

Use this skill when the user asks about which accounts need attention, which deals are stalling, who the key stakeholders are, or what CRM activity patterns look like.

All queries run directly against the `activity_events`, `transition_history`, `stakeholder_edges`, and `contact_deal_roles` tables. Reference PIVOT views (`v_account`, `v_contact`, `v_deal`) for field data.

## 1. Engagement Scores

Engagement is scored on recency (how recently the entity was touched), frequency (how often), and depth (which event types — create/update > view > search).

Score formula: `0.4 * recency + 0.3 * frequency + 0.3 * depth`

Query engagement scores for all accounts in the last 30 days:
```sql
WITH per_entity AS (
  SELECT entity_id, entity_type, COUNT(*) AS cnt,
    MAX(occurred_at) AS last_activity,
    SUM(CASE event_type
      WHEN 'create' THEN 3 WHEN 'update' THEN 2 WHEN 'stage_change' THEN 2.5
      WHEN 'view' THEN 1 WHEN 'search' THEN 0.5 ELSE 1 END) AS depth_sum
  FROM activity_events
  WHERE entity_type = 'account'
    AND occurred_at >= CURRENT_TIMESTAMP - (30 * INTERVAL '1 day')
  GROUP BY entity_id, entity_type
),
normed AS (
  SELECT *, MAX(cnt) OVER () AS max_cnt, MAX(depth_sum) OVER () AS max_depth FROM per_entity
)
SELECT entity_id,
  0.4 * (1.0 / (1.0 + DATEDIFF('day', last_activity, CURRENT_TIMESTAMP)))
  + 0.3 * (CASE WHEN max_cnt <= 1 THEN 1.0 ELSE LN(1+cnt)/LN(1+max_cnt) END)
  + 0.3 * (CASE WHEN max_depth = 0 THEN 0.0 ELSE depth_sum/max_depth END) AS score,
  last_activity
FROM normed
ORDER BY score DESC;
```

## 2. Attention Heatmap

Which accounts get the most attention (event count)?
```sql
SELECT entity_id, COUNT(*) AS event_count,
  MAX(occurred_at) AS last_activity
FROM activity_events
WHERE entity_type = 'account'
GROUP BY entity_id
ORDER BY event_count DESC
LIMIT 20;
```

## 3. Neglect Detection

Find accounts with no activity in 30+ days (or no activity ever):
```sql
SELECT e.id AS entity_id, MAX(ae.occurred_at) AS last_activity,
  COALESCE(DATEDIFF('day', MAX(ae.occurred_at), CURRENT_TIMESTAMP), 999) AS days_since
FROM entries e
JOIN objects o ON e.object_id = o.id AND o.name = 'account'
LEFT JOIN activity_events ae ON ae.entity_id = e.id AND ae.entity_type = 'account'
GROUP BY e.id
HAVING COALESCE(DATEDIFF('day', MAX(ae.occurred_at), CURRENT_TIMESTAMP), 999) >= 30
ORDER BY days_since DESC;
```

For deals (14-day threshold):
```sql
SELECT e.id AS entity_id, MAX(ae.occurred_at) AS last_activity,
  COALESCE(DATEDIFF('day', MAX(ae.occurred_at), CURRENT_TIMESTAMP), 999) AS days_since
FROM entries e
JOIN objects o ON e.object_id = o.id AND o.name = 'deal'
LEFT JOIN activity_events ae ON ae.entity_id = e.id AND ae.entity_type = 'deal'
GROUP BY e.id
HAVING COALESCE(DATEDIFF('day', MAX(ae.occurred_at), CURRENT_TIMESTAMP), 999) >= 14
ORDER BY days_since DESC;
```

## 4. Activity Timeline for an Entity

Reconstruct the full activity history for a specific account or contact:
```sql
SELECT event_type, entity_type, user_id, session_id, sequence_number, occurred_at, metadata
FROM activity_events
WHERE entity_id = 'ENTITY_ID_HERE'
ORDER BY occurred_at DESC
LIMIT 50;
```

## 5. Navigation Sequences

Reconstruct a user's navigation journey within a session:
```sql
SELECT sequence_number, event_type, entity_type, entity_id, occurred_at, metadata
FROM activity_events
WHERE session_id = 'SESSION_ID_HERE'
ORDER BY sequence_number ASC;
```

Find sessions that touched a specific account:
```sql
SELECT DISTINCT session_id
FROM activity_events
WHERE entity_id = 'ACCOUNT_ID_HERE' AND entity_type = 'account';
```

## 6. Anomaly Detection (Z-Score)

Find entities with activity spikes (current day count > 2 standard deviations above rolling average):
```sql
WITH daily AS (
  SELECT entity_id, DATE_TRUNC('day', occurred_at) AS day, COUNT(*) AS cnt
  FROM activity_events WHERE entity_type = 'account'
  GROUP BY entity_id, DATE_TRUNC('day', occurred_at)
),
rolling AS (
  SELECT entity_id, day, cnt,
    AVG(cnt) OVER (PARTITION BY entity_id ORDER BY day ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS avg_cnt,
    STDDEV(cnt) OVER (PARTITION BY entity_id ORDER BY day ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS std_cnt
  FROM daily
),
latest AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY day DESC) AS rn FROM rolling
)
SELECT entity_id, cnt AS current_count, avg_cnt, std_cnt,
  (cnt - avg_cnt) / NULLIF(std_cnt, 0) AS z_score
FROM latest
WHERE rn = 1
  AND ABS((cnt - avg_cnt) / NULLIF(std_cnt, 0)) > 2.0
ORDER BY ABS((cnt - avg_cnt) / NULLIF(std_cnt, 0)) DESC;
```

## 7. Stakeholder Map for a Deal

Get all contacts involved in a deal with their roles:
```sql
SELECT cdr.contact_entry_id, vc."First Name", vc."Last Name",
  vc."Job Title", cdr.role, MAX(ae.occurred_at) AS last_interaction
FROM contact_deal_roles cdr
JOIN v_contact vc ON vc.entry_id = cdr.contact_entry_id
LEFT JOIN activity_events ae ON ae.entity_id = cdr.contact_entry_id AND ae.entity_type = 'contact'
WHERE cdr.deal_entry_id = 'DEAL_ID_HERE'
GROUP BY cdr.contact_entry_id, vc."First Name", vc."Last Name", vc."Job Title", cdr.role
ORDER BY cdr.role;
```

Stakeholder edges (relationships between contacts):
```sql
SELECT from_contact_id, to_contact_id, relationship_type, weight, last_interaction_at
FROM stakeholder_edges
WHERE deal_id = 'DEAL_ID_HERE';
```

Influence scoring (role weight × recency decay):
```sql
SELECT cdr.contact_entry_id, vc."First Name", cdr.role,
  CASE cdr.role
    WHEN 'decision_maker' THEN 5
    WHEN 'champion' THEN 4
    WHEN 'influencer' THEN 3
    WHEN 'end_user' THEN 2
    WHEN 'technical_evaluator' THEN 2
    WHEN 'blocker' THEN -3 ELSE 1 END *
  (1.0 / (1.0 + COALESCE(DATEDIFF('day', MAX(ae.occurred_at), CURRENT_TIMESTAMP), 30)))
  AS influence_score
FROM contact_deal_roles cdr
JOIN v_contact vc ON vc.entry_id = cdr.contact_entry_id
LEFT JOIN activity_events ae ON ae.entity_id = cdr.contact_entry_id
WHERE cdr.deal_entry_id = 'DEAL_ID_HERE'
GROUP BY cdr.contact_entry_id, vc."First Name", cdr.role
ORDER BY influence_score DESC;
```

Risk flags to check manually:
- No decision_maker in contact_deal_roles → deal lacks buying authority
- Champion's last_interaction > 14 days ago → relationship at risk
- Blocker present but no champion → deal blocked with no advocate
- Only one contact_entry_id in contact_deal_roles → single-threaded, high risk

## 8. Deal Momentum

Stage velocity and stall detection from transition_history:
```sql
WITH last_t AS (
  SELECT entry_id, to_status AS current_stage, changed_at,
    DATEDIFF('day', changed_at, CURRENT_TIMESTAMP) AS days_in_stage,
    ROW_NUMBER() OVER (PARTITION BY entry_id ORDER BY changed_at DESC) AS rn
  FROM transition_history WHERE object_name = 'deal'
),
avg_t AS (
  SELECT entry_id, AVG(duration_seconds) / 86400.0 AS avg_days, COUNT(*) AS transitions,
    DATEDIFF('day', MIN(changed_at), CURRENT_TIMESTAMP) AS total_days
  FROM transition_history WHERE object_name = 'deal'
  GROUP BY entry_id
)
SELECT lt.entry_id, vd."Deal Name", lt.current_stage,
  lt.days_in_stage,
  COALESCE(a.avg_days, 30) AS avg_days_per_stage,
  COALESCE(a.transitions, 0) / GREATEST(a.total_days, 1) AS stage_velocity,
  CASE
    WHEN lt.days_in_stage < 0.5 * COALESCE(a.avg_days, 30) THEN 'accelerating'
    WHEN lt.days_in_stage <= COALESCE(a.avg_days, 30)       THEN 'on_track'
    WHEN lt.days_in_stage > 1.5 * COALESCE(a.avg_days, 30) THEN 'stalling'
    ELSE 'at_risk'
  END AS signal
FROM last_t lt
LEFT JOIN v_deal vd ON vd.entry_id = lt.entry_id
LEFT JOIN avg_t a ON a.entry_id = lt.entry_id
WHERE lt.rn = 1
ORDER BY lt.days_in_stage DESC;
```

## 9. Search Intent Classification

Classify recent search events by user intent based on metadata:
```sql
SELECT session_id, occurred_at,
  CASE
    WHEN metadata->>'entity_type' = 'deal'                          THEN 'deal_review'
    WHEN metadata->>'filters' ILIKE '%industry%'
      OR metadata->>'filters' ILIKE '%employee%'                    THEN 'prospecting'
    WHEN metadata->>'filters' ILIKE '%hq_%'
      OR metadata->>'query' ILIKE '%city%'
      OR metadata->>'query' ILIKE '%country%'                       THEN 'territory_planning'
    WHEN metadata->>'query' ILIKE '%stage%'
      OR metadata->>'query' ILIKE '%pipeline%'                      THEN 'pipeline_review'
    ELSE 'general'
  END AS intent
FROM activity_events
WHERE event_type = 'search'
ORDER BY occurred_at DESC
LIMIT 50;
```

Aggregate search intent distribution:
```sql
SELECT
  CASE
    WHEN metadata->>'entity_type' = 'deal' THEN 'deal_review'
    WHEN metadata->>'filters' ILIKE '%industry%' OR metadata->>'filters' ILIKE '%employee%' THEN 'prospecting'
    WHEN metadata->>'filters' ILIKE '%hq_%' THEN 'territory_planning'
    ELSE 'general'
  END AS intent,
  COUNT(*) AS count
FROM activity_events WHERE event_type = 'search'
GROUP BY intent ORDER BY count DESC;
```

## Notes

- `occurred_at` uses `CURRENT_TIMESTAMP` (not `NOW()`) for consistency in DuckDB.
- `DATEDIFF('day', earlier, later)` returns a positive BIGINT — wrap with `Number()` in TypeScript.
- `metadata` is stored as JSON VARCHAR — use `->>'key'` to extract fields.
- `session_id` is a UUID string generated by `startSession()` in `capture.ts`.
- All `entity_id` values are UUIDs that correspond to `entries.id` in the EAV schema.
- `{{WORKSPACE_PATH}}` is the workspace directory (e.g., `~/.openclaw-dench/workspace/`).

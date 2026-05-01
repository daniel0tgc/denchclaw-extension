---
name: deal-pipeline
description: Deal pipeline stage transitions, line item management, transition history, and deal momentum scoring.
metadata: { "openclaw": { "inject": true, "always": true } }
---

# Deal Pipeline Management

Pipeline stages in order: `prospecting` → `qualified` → `proposal` → `negotiation` → `won` → `lost`.

---

## Moving a Deal to a New Stage

**Always** log to `transition_history` when changing stage. Compute `duration_seconds` from the last transition.

```sql
-- 1. Get last transition to compute duration
SELECT changed_at
FROM transition_history
WHERE entry_id = $deal_id
ORDER BY changed_at DESC
LIMIT 1;
-- capture as $last_changed_at (NULL if first transition)

-- 2. Get current stage name
SELECT s.name AS current_stage
FROM entries e
JOIN statuses s ON s.id = e.status_id
WHERE e.id = $deal_id;
-- capture as $from_status

-- 3. Move the deal
UPDATE entries
SET status_id = (
  SELECT id FROM statuses
  WHERE object_id = (SELECT id FROM objects WHERE name = 'deal')
    AND name = $to_stage
),
updated_at = CURRENT_TIMESTAMP
WHERE id = $deal_id;

-- 4. Log the transition
INSERT INTO transition_history
  (entry_id, object_name, from_status, to_status, changed_by, duration_seconds)
VALUES (
  $deal_id,
  'deal',
  $from_status,
  $to_stage,
  $user_id,
  CASE
    WHEN $last_changed_at IS NULL THEN NULL
    ELSE DATEDIFF('second', $last_changed_at::TIMESTAMP, CURRENT_TIMESTAMP)
  END
);
```

---

## Line Items

### Add a Line Item

```sql
INSERT INTO line_items (deal_entry_id, product_name, quantity, unit_price)
VALUES ($deal_id, 'Enterprise License', 10, 5000.00);
-- total column is computed: quantity * unit_price
```

### Update a Line Item

```sql
UPDATE line_items
SET quantity = 15, updated_at = CURRENT_TIMESTAMP
WHERE id = $line_item_id AND deal_entry_id = $deal_id;
```

### Remove a Line Item

```sql
DELETE FROM line_items WHERE id = $line_item_id AND deal_entry_id = $deal_id;
```

### Total Deal Value from Line Items

```sql
SELECT
  SUM(quantity * unit_price) AS total_value,
  COUNT(*) AS item_count
FROM line_items
WHERE deal_entry_id = $deal_id;
```

### All Line Items for a Deal

```sql
SELECT product_name, quantity, unit_price, total
FROM line_items
WHERE deal_entry_id = $deal_id
ORDER BY created_at;
```

---

## Transition History

### Full Stage History for a Deal

```sql
SELECT
  from_status,
  to_status,
  changed_by,
  changed_at,
  duration_seconds,
  ROUND(duration_seconds / 86400.0, 1) AS duration_days
FROM transition_history
WHERE entry_id = $deal_id
ORDER BY changed_at;
```

### Days Spent in Current Stage

```sql
SELECT
  DATEDIFF('day',
    (SELECT MAX(changed_at) FROM transition_history WHERE entry_id = $deal_id),
    CURRENT_TIMESTAMP
  ) AS days_in_current_stage;
```

### Average Days Per Stage (Historical Baseline)

```sql
SELECT
  to_status AS stage,
  ROUND(AVG(duration_seconds) / 86400.0, 1) AS avg_days
FROM transition_history
WHERE object_name = 'deal'
  AND duration_seconds IS NOT NULL
GROUP BY to_status
ORDER BY AVG(duration_seconds);
```

---

## Pipeline Analytics

### Deals by Stage

```sql
SELECT
  s.name AS stage,
  s.color,
  COUNT(e.id) AS deal_count,
  SUM(ef.value::NUMERIC) AS total_value
FROM entries e
JOIN statuses s ON s.id = e.status_id
LEFT JOIN entry_fields ef ON ef.entry_id = e.id
  AND ef.field_id = (
    SELECT id FROM fields
    WHERE object_id = (SELECT id FROM objects WHERE name = 'deal')
      AND name = 'Deal Value'
  )
WHERE e.object_id = (SELECT id FROM objects WHERE name = 'deal')
GROUP BY s.name, s.color, s.sort_order
ORDER BY s.sort_order;
```

### Conversion Rate Between Stages

```sql
-- Deals that reached proposal vs deals that reached qualified
SELECT
  qualified.cnt AS qualified_count,
  proposal.cnt  AS proposal_count,
  ROUND(100.0 * proposal.cnt / NULLIF(qualified.cnt, 0), 1) AS qualified_to_proposal_pct
FROM
  (SELECT COUNT(DISTINCT entry_id) AS cnt FROM transition_history
   WHERE to_status = 'qualified' AND object_name = 'deal') qualified,
  (SELECT COUNT(DISTINCT entry_id) AS cnt FROM transition_history
   WHERE to_status = 'proposal'  AND object_name = 'deal') proposal;
```

### Average Time Per Stage

```sql
SELECT
  to_status AS stage,
  COUNT(*) AS transitions,
  ROUND(AVG(duration_seconds) / 86400.0, 1) AS avg_days,
  ROUND(MIN(duration_seconds) / 86400.0, 1) AS min_days,
  ROUND(MAX(duration_seconds) / 86400.0, 1) AS max_days
FROM transition_history
WHERE object_name = 'deal' AND duration_seconds IS NOT NULL
GROUP BY to_status
ORDER BY
  CASE to_status
    WHEN 'prospecting' THEN 1 WHEN 'qualified' THEN 2
    WHEN 'proposal' THEN 3 WHEN 'negotiation' THEN 4
    WHEN 'won' THEN 5 WHEN 'lost' THEN 6 ELSE 7
  END;
```

### Stalled Deals (Overdue in Stage)

```sql
-- Deals stuck longer than 1.5× the historical average for their current stage
WITH avg_days AS (
  SELECT to_status, AVG(duration_seconds) / 86400.0 AS avg_d
  FROM transition_history
  WHERE object_name = 'deal' AND duration_seconds IS NOT NULL
  GROUP BY to_status
),
current_stage AS (
  SELECT
    e.id AS deal_id,
    s.name AS stage,
    DATEDIFF('day',
      MAX(th.changed_at),
      CURRENT_TIMESTAMP
    ) AS days_in_stage
  FROM entries e
  JOIN statuses s ON s.id = e.status_id
  LEFT JOIN transition_history th ON th.entry_id = e.id
  WHERE e.object_id = (SELECT id FROM objects WHERE name = 'deal')
    AND s.name NOT IN ('won', 'lost')
  GROUP BY e.id, s.name
)
SELECT
  cs.deal_id,
  d."Deal Name",
  cs.stage,
  cs.days_in_stage,
  ROUND(a.avg_d, 1) AS avg_days_for_stage
FROM current_stage cs
JOIN v_deal d ON d.entry_id = cs.deal_id
LEFT JOIN avg_days a ON a.to_status = cs.stage
WHERE cs.days_in_stage > COALESCE(a.avg_d * 1.5, 30)
ORDER BY cs.days_in_stage DESC;
```

### Win Rate

```sql
SELECT
  ROUND(100.0 * won.cnt / NULLIF(won.cnt + lost.cnt, 0), 1) AS win_rate_pct,
  won.cnt  AS won,
  lost.cnt AS lost
FROM
  (SELECT COUNT(DISTINCT entry_id) AS cnt FROM transition_history WHERE to_status = 'won'  AND object_name = 'deal') won,
  (SELECT COUNT(DISTINCT entry_id) AS cnt FROM transition_history WHERE to_status = 'lost' AND object_name = 'deal') lost;
```

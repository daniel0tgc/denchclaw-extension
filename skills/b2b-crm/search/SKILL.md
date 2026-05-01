---
name: b2b-search
description: Search accounts, contacts, and deals with full-text search, boolean filters, faceted counts, and intelligence field sorting.
metadata: { "openclaw": { "inject": true, "always": true } }
---

# B2B CRM Search

Use this skill when the user wants to find, filter, or browse accounts, contacts, or deals. All search queries run directly against the DuckDB PIVOT views (`v_account`, `v_contact`, `v_deal`) or the FTS staging tables (`fts_account`, `fts_contact`, `fts_deal`).

## 1. Substring Search (ILIKE)

Substring search is the simplest fallback. Use ILIKE for case-insensitive matching on any text column.

Search accounts by company name or domain:
```sql
SELECT entry_id, "Company Name", "Domain", "Industry"
FROM v_account
WHERE "Company Name" ILIKE '%acme%' OR "Domain" ILIKE '%acme%'
ORDER BY "Company Name"
LIMIT 20;
```

Search contacts by name or email:
```sql
SELECT entry_id, "First Name", "Last Name", "Email Address", "Job Title"
FROM v_contact
WHERE "First Name" ILIKE '%sarah%'
   OR "Last Name"  ILIKE '%johnson%'
   OR "Email Address" ILIKE '%sarah%'
ORDER BY "Last Name", "First Name"
LIMIT 20;
```

## 2. Full-Text Search (FTS / BM25)

FTS uses DuckDB's BM25 ranking over pre-built staging tables. Requires `setupFTSIndexes()` to have been called first.

The FTS staging tables are: `fts_account`, `fts_contact`, `fts_deal`.
The match function is a scalar function in the `fts_main_<table>` schema.

Search accounts by relevance:
```sql
SELECT score, entry_id
FROM (
  SELECT fts_main_fts_account.match_bm25(entry_id, 'manufacturing steel') AS score, entry_id
  FROM fts_account
)
WHERE score IS NOT NULL
ORDER BY score DESC
LIMIT 20;
```

Search contacts by relevance:
```sql
SELECT score, entry_id
FROM (
  SELECT fts_main_fts_contact.match_bm25(entry_id, 'procurement director') AS score, entry_id
  FROM fts_contact
)
WHERE score IS NOT NULL
ORDER BY score DESC
LIMIT 20;
```

Search deals by relevance:
```sql
SELECT score, entry_id
FROM (
  SELECT fts_main_fts_deal.match_bm25(entry_id, 'enterprise software') AS score, entry_id
  FROM fts_deal
)
WHERE score IS NOT NULL
ORDER BY score DESC
LIMIT 20;
```

## 3. Combine FTS with Filters

Join FTS results back to the PIVOT view to apply additional filters and retrieve full record data:

```sql
WITH fts_ranked AS (
  SELECT fts_main_fts_account.match_bm25(entry_id, 'manufacturing') AS score, entry_id
  FROM fts_account
)
SELECT a.entry_id, a."Company Name", a."Industry", a."Employee Count", r.score
FROM v_account a
JOIN fts_ranked r ON a.entry_id = r.entry_id
WHERE r.score IS NOT NULL
  AND a."Industry" = 'Manufacturing'
  AND a."Employee Count"::NUMERIC > 500
ORDER BY r.score DESC
LIMIT 20;
```

## 4. Boolean Filters (No FTS)

When the user provides structured filters (e.g., industry + size range), query the PIVOT view directly with a WHERE clause.

Single filter:
```sql
SELECT entry_id, "Company Name", "Industry", "Employee Count"
FROM v_account
WHERE "Industry" = 'Manufacturing'
ORDER BY "Company Name"
LIMIT 20;
```

Compound AND filter:
```sql
SELECT entry_id, "Company Name", "Industry", "Employee Count", "HQ Country"
FROM v_account
WHERE "Industry" = 'Manufacturing'
  AND "Employee Count"::NUMERIC > 500
  AND "HQ Country" = 'USA'
ORDER BY "Employee Count"::NUMERIC DESC
LIMIT 20;
```

OR filter:
```sql
SELECT entry_id, "Company Name", "Industry"
FROM v_account
WHERE "Industry" = 'Energy' OR "Industry" = 'Chemicals'
ORDER BY "Company Name"
LIMIT 20;
```

IN filter:
```sql
SELECT entry_id, "Company Name", "Industry"
FROM v_account
WHERE "Industry" IN ('Manufacturing', 'Energy', 'Mining')
ORDER BY "Company Name"
LIMIT 50;
```

## 5. Faceted Counts

Facets show the distribution of values for a field. Always use them without LIMIT to get a complete distribution. Run one query per facet field.

Industry distribution for all accounts:
```sql
SELECT "Industry", COUNT(*) AS count
FROM v_account
WHERE "Industry" IS NOT NULL
GROUP BY "Industry"
ORDER BY count DESC;
```

Industry distribution with an active filter (facets update as user filters):
```sql
SELECT "Industry", COUNT(*) AS count
FROM v_account
WHERE "Industry" IS NOT NULL
  AND "HQ Country" = 'USA'
GROUP BY "Industry"
ORDER BY count DESC;
```

Employee size bucket distribution:
```sql
SELECT
  CASE
    WHEN "Employee Count"::NUMERIC < 50   THEN '1–49'
    WHEN "Employee Count"::NUMERIC < 200  THEN '50–199'
    WHEN "Employee Count"::NUMERIC < 1000 THEN '200–999'
    ELSE '1000+'
  END AS size_bucket,
  COUNT(*) AS count
FROM v_account
WHERE "Employee Count" IS NOT NULL
GROUP BY size_bucket
ORDER BY MIN("Employee Count"::NUMERIC);
```

## 6. Pagination

Use LIMIT and OFFSET for stable pagination. Always include an ORDER BY to ensure consistent page results.

Page 1 (first 20):
```sql
SELECT entry_id, "Company Name", "Industry", "Employee Count"
FROM v_account
WHERE "Industry" = 'Manufacturing'
ORDER BY "Company Name" ASC
LIMIT 20 OFFSET 0;
```

Page 2 (next 20):
```sql
SELECT entry_id, "Company Name", "Industry", "Employee Count"
FROM v_account
WHERE "Industry" = 'Manufacturing'
ORDER BY "Company Name" ASC
LIMIT 20 OFFSET 20;
```

## 7. Sort by Any Column

All PIVOT view columns are sortable. Use double-quoted names for multi-word fields.

Sort by employee count descending:
```sql
SELECT entry_id, "Company Name", "Employee Count"
FROM v_account
ORDER BY "Employee Count"::NUMERIC DESC NULLS LAST
LIMIT 50;
```

Sort by expected close date:
```sql
SELECT entry_id, "Deal Name", "Deal Value", "Expected Close"
FROM v_deal
ORDER BY "Expected Close"::DATE ASC NULLS LAST
LIMIT 20;
```

## 8. Sort by Intelligence Fields

After Phase 5 enrichment, search results can be sorted by engagement score, neglect flag, and days since activity. Query the `enrichSearchResults()` output or use the engagement scoring tables directly.

Sort accounts by engagement score (most engaged first):
```sql
SELECT entry_id, "Company Name", "Industry"
FROM v_account
ORDER BY engagement_score DESC NULLS LAST
LIMIT 20;
```

Sort by days since activity (most neglected first):
```sql
SELECT entry_id, "Company Name", "Industry"
FROM v_account
ORDER BY days_since_activity DESC NULLS LAST
LIMIT 20;
```

Flag neglected accounts (no activity in 30+ days):
```sql
SELECT a.entry_id, a."Company Name", a."Industry"
FROM v_account a
LEFT JOIN (
  SELECT entity_id, MAX(occurred_at) AS last_activity
  FROM activity_events
  WHERE entity_type = 'account'
  GROUP BY entity_id
) ae ON a.entry_id = ae.entity_id
WHERE ae.last_activity IS NULL
   OR ae.last_activity < CURRENT_TIMESTAMP - INTERVAL '30 days'
ORDER BY ae.last_activity ASC NULLS FIRST
LIMIT 20;
```

## Notes

- All field names use display names with double-quotes in SQL: `"Company Name"`, not `company_name`.
- Numeric fields stored as VARCHAR — always cast: `"Employee Count"::NUMERIC`.
- Date fields stored as VARCHAR — always cast: `"Expected Close"::DATE`.
- FTS uses `stopwords='none'` — all terms including common English words are indexed.
- The FTS query string must be a string literal (parameters don't work with `match_bm25`).
- `{{WORKSPACE_PATH}}` is the workspace directory (e.g., `~/.openclaw-dench/workspace/`).

# DESIGN.md — DenchClaw B2B CRM Extension

## Architecture Overview

This extension adds B2B account management to DenchClaw as a native plugin + skills package. It integrates at three levels:

1. **EAV data layer** — accounts, contacts, and deals defined as DenchClaw objects (rows in `objects`, `fields`, `entries`, `entry_fields`), rendering natively in the web UI kanban and table views
2. **Plugin tools** — sync, import/export, and search tools registered via `api.registerTool()`, callable by the DenchClaw agent
3. **Skills** — markdown SKILL.md files that teach the agent SQL patterns for CRUD, pipeline management, search, and activity analytics

```
                         ┌─────────────────────────┐
                         │     DenchClaw Agent      │
                         │  (reads skills, calls    │
                         │   tools, runs SQL)       │
                         └───────┬──────┬───────────┘
                                 │      │
                    ┌────────────┘      └────────────┐
                    ▼                                ▼
           ┌──────────────┐                 ┌──────────────┐
           │    Skills     │                 │ Plugin Tools  │
           │  (markdown)   │                 │ (TypeScript)  │
           ├──────────────┤                 ├──────────────┤
           │ b2b-crm      │                 │ sync_push     │
           │ deal-pipeline │                 │ sync_pull     │
           │ search        │                 │ sync_status   │
           │ activity      │                 │ csv_import    │
           └──────────────┘                 │ csv_export    │
                                            └──────┬───────┘
                                                   │
                              ┌─────────────────────┼──────────────────┐
                              ▼                     ▼                  ▼
                    ┌──────────────┐     ┌──────────────┐    ┌──────────────┐
                    │   DuckDB     │     │  Sync Queue  │    │  Mock Cloud   │
                    │ workspace.db │     │  (table)     │    │ (2nd DuckDB)  │
                    ├──────────────┤     └──────┬───────┘    └──────────────┘
                    │ EAV tables   │            │
                    │ PIVOT views  │◄───────────┘
                    │ Standalone   │   drain service
                    │  tables      │   writes merged
                    └──────────────┘   state back
```

The extension registers a background service via `api.registerService()` that runs the sync queue drain on a configurable interval. All sync writes land in `sync_queue` first, never writing directly to the EAV tables — this respects DuckDB's single-writer constraint and ensures user writes are never blocked by sync operations.

---

## Data Model

### Design Decision: EAV-Native for CRM Objects

CRM objects (account, contact, deal) are defined as EAV entries, not standalone tables. This was a deliberate choice:

**Why EAV:** DenchClaw's web UI renders objects from `objects` + `fields` + `.object.yaml` metadata. Standalone tables would be invisible to the UI — we'd need to build our own rendering layer. EAV makes the extension feel native: accounts appear in the sidebar, deals render as kanban boards, contacts show in table views. Custom fields work automatically.

**Tradeoff:** EAV queries are slower than direct table scans. All values are VARCHAR, requiring casts for numeric operations. PIVOT views mitigate this — they flatten the EAV into queryable columns at view-resolution time, and DuckDB's columnar engine handles the pivots efficiently.

### EAV Object Definitions

**Account** (12 fields):
```
Company Name (text, required), Domain (url), Industry (enum), Employee Count (number),
Annual Revenue (number), HQ City (text), HQ Country (text), Owner (user),
Phone (phone), Website (url), Description (richtext), Tags (tags)
Statuses: prospect → active → churned
```

**Contact** (10 fields):
```
First Name (text, required), Last Name (text, required), Email Address (email, required),
Phone Number (phone), Job Title (text), Department (text), Account (relation → account, many_to_one),
LinkedIn URL (url), Notes (richtext), Tags (tags)
Statuses: active, inactive
```

**Deal** (10 fields):
```
Deal Name (text, required), Account (relation → account, many_to_one), Deal Value (number),
Currency (enum), Expected Close (date), Owner (user), Lead Source (enum),
Probability (number), Description (richtext), Tags (tags)
Pipeline: prospecting → qualified → proposal → negotiation → won/lost
```

### PIVOT Views

Each object gets a `v_<name>` view that flattens EAV into columns:

```sql
CREATE OR REPLACE VIEW v_account AS
PIVOT (
  SELECT e.id as entry_id, e.created_at, e.updated_at,
         f.name as field_name, ef.value
  FROM entries e
  JOIN entry_fields ef ON ef.entry_id = e.id
  JOIN fields f ON f.id = ef.field_id
  WHERE e.object_id = (SELECT id FROM objects WHERE name = 'account')
    AND f.type != 'action'
) ON field_name IN ('Company Name', 'Domain', 'Industry', 'Employee Count',
  'Annual Revenue', 'HQ City', 'HQ Country', 'Owner', 'Phone', 'Website',
  'Description', 'Tags') USING first(value);
```

The agent queries PIVOT views for reads using quoted field names: `SELECT "Company Name" FROM v_account WHERE "Industry" = 'Manufacturing'`. Writes go through the EAV tables (INSERT into `entries` + `entry_fields`). This separation keeps reads fast and writes schema-flexible.

### Standalone Tables

Internal tables that don't need web UI rendering:

```sql
line_items (id, deal_entry_id, product_name, quantity, unit_price, total GENERATED)
transition_history (id, entry_id, object_name, from_status, to_status, changed_by, changed_at, duration_seconds)
contact_deal_roles (contact_entry_id, deal_entry_id, role, assigned_at)
stakeholder_edges (id, from_contact_id, to_contact_id, relationship_type, deal_id, weight, last_interaction_at, created_at)
activity_events (id, event_type, entity_type, entity_id, user_id, session_id, sequence_number, metadata JSON, occurred_at)
sync_state (entry_id, field_id, value, hlc_ts, hlc_counter, node_id)
sync_queue (id, operation, entry_id, field_id, value, hlc_ts, hlc_counter, node_id, status, created_at, processed_at)
import_errors (id, import_batch_id, row_number, raw_data JSON, error_reason, created_at)
audit_log (id, action, entity_type, entity_id, actor_id, details JSON, prev_hash, hash, created_at)
```

### Contact Roles: Junction Table

A contact's role is relative to a specific deal, not absolute:

```sql
contact_deal_roles (
  contact_entry_id VARCHAR NOT NULL,
  deal_entry_id VARCHAR NOT NULL,
  role VARCHAR NOT NULL CHECK (role IN ('champion', 'decision_maker', 'blocker',
                                        'influencer', 'end_user', 'technical_evaluator')),
  PRIMARY KEY (contact_entry_id, deal_entry_id, role)
)
```

Sarah can be a champion on Deal A and a blocker on Deal B. A simpler approach (role field on contact) would fail this requirement — roles are per-relationship, not per-person. The skill teaches the agent the join pattern:

```sql
SELECT c."First Name", c."Last Name", cdr.role
FROM v_contact c
JOIN contact_deal_roles cdr ON c.entry_id = cdr.contact_entry_id
WHERE cdr.deal_entry_id = ?
```

### Stakeholder Mapping / Relationship Graph

Industrial B2B deals involve many contacts per account with complex internal politics. The `stakeholder_edges` table models this as a directed graph:

```sql
stakeholder_edges (
  id VARCHAR PRIMARY KEY,
  from_contact_id VARCHAR NOT NULL,
  to_contact_id VARCHAR NOT NULL,
  relationship_type VARCHAR NOT NULL CHECK (relationship_type IN
    ('reports_to', 'influences', 'blocks', 'champions_for', 'collaborates_with')),
  deal_id VARCHAR,           -- optional: scoped to a specific deal
  weight DOUBLE DEFAULT 1.0, -- interaction-recency-weighted influence
  last_interaction_at TIMESTAMP
)
```

**Why a graph, not just roles:** `contact_deal_roles` captures what role a contact plays on a deal (champion, blocker). The graph captures *relationships between contacts* — who reports to whom, who influences whom. Sarah being a champion is useful; knowing Sarah reports to the VP who is the actual decision maker is actionable.

**Influence scoring:** Each node's influence score combines role weight (decision_maker=5, champion=4, influencer=3, end_user=2, blocker=-3) with interaction recency decay: `role_weight * (1 / (1 + days_since_interaction))`. A champion you talked to yesterday has more influence than one you haven't reached in 30 days.

**Risk detection:** The stakeholder graph enables automated risk flags:
- No decision maker identified for a deal
- Champion has gone cold (no interaction in 14+ days)
- Blocker present with no counter-champion
- Single-threaded deal (only one contact engaged)

The skill teaches the agent to traverse the graph:
```sql
SELECT c."First Name", c."Last Name", se.relationship_type, se.weight
FROM stakeholder_edges se
JOIN v_contact c ON c.entry_id = se.from_contact_id
WHERE se.deal_id = ?
ORDER BY se.weight DESC
```

---

## Sync Protocol

### The Problem

Two sales reps edit the same account offline. Rep A updates the phone number. Rep B updates the industry. When both reconnect and sync:

- **Record-level LWW**: one rep's entire change overwrites the other's. Data lost.
- **Field-level LWW with wall clocks**: correct in the common case, but clock skew across machines can cause the wrong field to win.
- **Field-level CRDTs with HLC**: formally correct. Each field carries a Hybrid Logical Clock. Merge is deterministic regardless of sync order. Different-field edits auto-merge with zero conflicts.

### Design Decision: Field-Level LWW-Register CRDTs

Each field value is a `(value, HLC)` tuple. On merge, higher HLC wins.

**Hybrid Logical Clock (HLC):**
```
HLC = { ts: number, counter: number, nodeId: string }
```
- `ts`: `max(local.ts, Date.now())` — tracks physical time but never goes backward
- `counter`: tie-breaker when two events have the same millisecond timestamp
- `nodeId`: final lexicographic tie-breaker (arbitrary but deterministic)

**Why HLC over wall clocks:** If Machine A's clock is 5 minutes ahead, a wall-clock LWW would let A's stale edits overwrite B's fresh edits for 5 minutes. HLC's `max(local, remote, now)` on receive means clocks only move forward — once B receives A's timestamp, B's clock jumps ahead, and all subsequent B edits correctly win.

**Why field-level, not record-level:** In practice, two reps rarely edit the same field on the same record. Field-level granularity means the vast majority of concurrent edits auto-merge with no conflict at all.

### Sync State Table

```sql
sync_state (
  entry_id VARCHAR NOT NULL,
  field_id VARCHAR NOT NULL,
  value VARCHAR,
  hlc_ts BIGINT NOT NULL,        -- physical time in ms
  hlc_counter INTEGER NOT NULL,  -- same-ms tie-breaker
  node_id VARCHAR NOT NULL,      -- originating machine
  PRIMARY KEY (entry_id, field_id)
)
```

Every local write to `entry_fields` also upserts `sync_state` with the current HLC. This is the source of truth for conflict resolution — the `entry_fields` table stores the winning value, `sync_state` stores the clock metadata.

### Sync Queue Architecture

```
User writes ──► entry_fields + sync_state (direct, immediate)
                     │
                     ▼
              sync_queue (INSERT pending push)
                     │
                     ▼ (background drain, configurable interval)
              ┌──────┴──────┐
              │  Push phase  │ ── local sync_state ──► mock cloud
              │  Pull phase  │ ◄── remote sync_state ── mock cloud
              │  Merge phase │ ── CRDT merge ──► entry_fields + sync_state
              └─────────────┘
```

**Why a queue:** DuckDB is single-writer. If the sync tool writes directly during a drain cycle, user writes block until sync finishes. The queue decouples these: user writes go to `entry_fields` immediately, sync changes land in `sync_queue` as pending items. The drain service processes the queue during idle moments, serializing all writes through a single connection.

**Queue drain cycle:**
1. Read pending `push` items from `sync_queue`
2. Mark them `processing`
3. Push local `sync_state` to mock cloud
4. Pull remote state from mock cloud (all entries modified since last pull)
5. For each remote field state, merge with local via CRDT (higher HLC wins)
6. Write merged results to `entry_fields` and `sync_state`
7. Mark queue items `done`

### Mock Cloud

A second DuckDB instance (`workspace-cloud.duckdb`) with the same `sync_state` schema. This demonstrates the full protocol — push, pull, merge, conflict resolution — without requiring real cloud infrastructure. The protocol is identical to what a real cloud implementation would use; only the transport layer changes.

### Conflict Scenarios and Resolution

| Scenario | Result |
|----------|--------|
| A edits phone, B edits industry (same account) | Auto-merge. Both values preserved. Zero conflict. |
| A edits phone to X, B edits phone to Y | Higher HLC wins. If tied on ts, higher counter wins. If tied on both, lexicographic nodeId breaks tie. Deterministic. |
| A deletes account, B edits it | Delete is a field-level write (set value to tombstone marker). If delete's HLC > edit's HLC, delete wins. Otherwise edit wins and record reappears. |
| A is offline for 2 hours, B makes 50 edits | On reconnect, A pushes stale state. Cloud already has B's higher-HLC values. Merge keeps B's values for all fields B touched. A's offline edits to other fields are preserved. |

### Sync Status Indicator

A `b2b_crm_sync_status` tool exposes sync queue state to the agent:

```typescript
{ pending: 12, failed: 0, lastSyncAt: "2025-04-30T14:23:00Z", isOnline: true }
```

The agent surfaces this conversationally — "12 changes pending sync" or "all synced as of 2 minutes ago." This builds trust during offline/reconnect scenarios: the user knows their local edits aren't lost, just queued. Implementation is a single query: `SELECT COUNT(*) FROM sync_queue WHERE status = 'pending'`.

---

## Search Architecture

### Design Decision: DuckDB-Native Search

No external search engine. DuckDB provides:

1. **Full-text search** via the FTS extension (`PRAGMA create_fts_index`)
2. **Substring search** via `ILIKE '%term%'` fallback
3. **Boolean filters** via SQL WHERE clauses
4. **Faceted counts** via `GROUP BY` aggregations
5. **Stable sort** via `ORDER BY column ASC/DESC`

**Why not an external search layer:** DuckDB is embedded and columnar. Analytical queries (GROUP BY, COUNT, aggregation) are its strength. Adding Tantivy or MeiliSearch would mean a second process, a sync mechanism to keep the search index consistent with DuckDB, and more failure modes — all for marginal relevance ranking improvement over BM25.

### FTS Index Setup

DuckDB's `PRAGMA create_fts_index` only works on real tables, not views. The extension materializes flat staging tables from the PIVOT views first, then indexes those:

```sql
INSTALL fts;
LOAD fts;

-- Materialize staging table from PIVOT view
CREATE OR REPLACE TABLE fts_account AS
  SELECT entry_id, "Company Name", "Domain", "Industry",
         "HQ City", "HQ Country", "Description"
  FROM v_account;

-- Index the staging table
PRAGMA create_fts_index('fts_account', 'entry_id',
  'Company Name', 'Domain', 'Industry', 'HQ City', 'HQ Country', 'Description',
  stopwords='none', overwrite=1);
```

`stopwords='none'` is required — the default English stopword list silently excludes common CRM terms (company, product, service, world). `overwrite=1` makes the pragma idempotent. The same pattern applies to `fts_contact` and `fts_deal`.

### Boolean Filter Builder

Filters are represented as a recursive tree:

```typescript
interface FilterGroup {
  logic: 'AND' | 'OR';
  clauses: Array<FilterClause | FilterGroup>;  // nested groups for complex queries
}
```

The builder outputs parameterized SQL:

```sql
-- Input: { logic: 'AND', clauses: [
--   { field: 'Industry', operator: 'eq', value: 'Manufacturing' },
--   { field: 'Employee Count', operator: 'gt', value: 500 }
-- ]}
-- Output:
SELECT * FROM v_account WHERE ("Industry" = ? AND "Employee Count" > ?)
-- Params: ['Manufacturing', 500]
```

### Faceted Counts

For each faceted field, a single GROUP BY query:

```sql
SELECT "Industry", COUNT(*) as count
FROM v_account
WHERE /* active filter applied */
GROUP BY "Industry"
ORDER BY count DESC
```

Facets update dynamically as filters change — applying an industry filter updates the employee_count facets to reflect only that industry's distribution.

### Intelligence Field Enrichment

Search results are enriched with activity intelligence data, exposed as sortable columns:

```sql
SELECT a.*,
  COALESCE(eng.score, 0) AS engagement_score,
  CASE WHEN DATEDIFF('day', MAX(ae.occurred_at), CURRENT_TIMESTAMP) > 30
       THEN true ELSE false END AS neglect_flag,
  DATEDIFF('day', MAX(ae.occurred_at), CURRENT_TIMESTAMP) AS days_since_activity
FROM v_account a
LEFT JOIN activity_events ae ON ae.entity_id = a.entry_id AND ae.entity_type = 'account'
LEFT JOIN (/* engagement scoring subquery */) eng ON eng.entity_id = a.entry_id
GROUP BY a.entry_id, ...
ORDER BY engagement_score DESC
```

This means the agent can answer "show me neglected high-value accounts" or "sort accounts by engagement" directly in search results without a separate analytics query. The enrichment function (`enrichSearchResults`) wraps the base search query with LEFT JOINs to the activity layer, keeping search and intelligence loosely coupled — search works without activity data, activity data enhances search when present.

### Scale

10K accounts is a small dataset for DuckDB's columnar engine. Full table scans with GROUP BY complete in single-digit milliseconds. FTS index lookup is similarly fast. No pagination or incremental loading strategy needed at this scale — the bottleneck would be network, not query time.

---

## Activity Intelligence

### Two-Layer Architecture

**Layer 1 — Capture:** Every CRM operation (create, update, view, delete, stage change, search, import, export, sync) writes an event to `activity_events`:

```sql
activity_events (
  id VARCHAR PRIMARY KEY,
  event_type VARCHAR NOT NULL,      -- 'create', 'update', 'view', 'stage_change', etc.
  entity_type VARCHAR NOT NULL,     -- 'account', 'contact', 'deal'
  entity_id VARCHAR NOT NULL,
  user_id VARCHAR,
  session_id VARCHAR,               -- groups events into navigation sessions
  sequence_number INTEGER,          -- ordering within a session
  metadata JSON,                    -- event-specific details (fields changed, search query, etc.)
  occurred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
```

**Layer 2 — Analysis:** Pure SQL queries over the event table. DuckDB's analytical engine makes this efficient:

### Engagement Scoring

```sql
Score = 0.4 × recency + 0.3 × frequency + 0.3 × depth

recency  = 1 / (1 + days_since_last_activity)     -- decays toward 0
frequency = ln(1 + event_count) / ln(1 + max_count) -- log-scaled, 0-1
depth    = weighted_event_sum / max_depth           -- create=3, update=2, view=1
```

**Why this formula:** Recency dominates because a recently-touched account is more likely to need follow-up than one touched frequently months ago. Frequency and depth together capture engagement quality — an account with 50 views but no edits (low depth) is different from one with 10 views and 5 updates (high depth).

### Neglect Detection

```sql
SELECT e.entry_id, e."Company Name", MAX(ae.occurred_at) as last_activity,
       DATEDIFF('day', MAX(ae.occurred_at), CURRENT_TIMESTAMP) as days_inactive
FROM v_account e
LEFT JOIN activity_events ae ON ae.entity_id = e.entry_id AND ae.entity_type = 'account'
GROUP BY e.entry_id, e."Company Name"
HAVING MAX(ae.occurred_at) IS NULL
   OR DATEDIFF('day', MAX(ae.occurred_at), CURRENT_TIMESTAMP) > ?  -- threshold: 30 days
ORDER BY days_inactive DESC
```

### Anomaly Detection (Z-Score)

Detects sudden spikes or drops in activity per entity:

```sql
WITH daily AS (
  SELECT entity_id, DATE_TRUNC('day', occurred_at) AS day, COUNT(*) AS cnt
  FROM activity_events WHERE entity_type = ?
  GROUP BY entity_id, day
),
stats AS (
  SELECT entity_id,
    AVG(cnt) OVER w AS avg_cnt,
    STDDEV(cnt) OVER w AS std_cnt,
    cnt, day
  FROM daily
  WINDOW w AS (PARTITION BY entity_id ORDER BY day ROWS BETWEEN 29 PRECEDING AND CURRENT ROW)
)
SELECT * FROM stats
WHERE ABS((cnt - avg_cnt) / NULLIF(std_cnt, 0)) > 2.0  -- z-score threshold
```

**Why z-score over more sophisticated methods:** It requires no training data, runs as a single SQL query, and catches the patterns that matter most for CRM: a dormant account suddenly receiving 10 views (competitor research?), or an active deal going silent (deal at risk?). More sophisticated time-series models would add complexity without proportional value at this data scale.

### Navigation Sequences

Events are grouped into sessions via `session_id` with `sequence_number` tracking ordering within each session. This captures navigation patterns — how a rep moves through the CRM during a work session:

```sql
SELECT event_type, entity_type, entity_id, sequence_number
FROM activity_events
WHERE session_id = ?
ORDER BY sequence_number ASC
```

A session like `view account → view contact → view deal → update deal` tells a different story than `search → view account → search → view account` — the first is deal progression, the second is prospecting. The activity skill teaches the agent to recognize these patterns and surface them as behavioral insights.

### Search Intent Classification

The activity skill includes SQL patterns that classify user intent from event metadata. Rather than a ML classifier, this is a rule-based approach over the `metadata->>'filters'` field:

| Pattern | Intent | What it means |
|---------|--------|---------------|
| Filters on `status = 'prospect'` or `industry` | `prospecting` | Rep is hunting for new opportunities |
| Filters on `deal.status` or `close_date` | `deal_review` | Rep is managing active pipeline |
| Filters on `hq_city`, `hq_country`, `owner` | `territory_planning` | Manager reviewing team coverage |
| No distinguishing pattern | `general` | Default fallback |

The skill teaches the agent to query:
```sql
SELECT metadata->>'$.intent' as intent, COUNT(*) as cnt
FROM activity_events
WHERE event_type = 'search' AND user_id = ?
GROUP BY intent
ORDER BY cnt DESC
```

This gives the agent context: "You've been mostly prospecting this week — want me to find accounts matching your usual filters?"

### Deal Momentum Scoring

Beyond backward-looking engagement scores, deal momentum is a forward-looking velocity metric that answers "is this deal progressing or dying?" It composes four signals from existing data:

| Signal | Source | Computation |
|--------|--------|-------------|
| Days in current stage | `transition_history` | `DATEDIFF('day', last_transition.changed_at, CURRENT_TIMESTAMP)` |
| Average days per stage | `transition_history` | `AVG(duration_seconds) / 86400` across historical transitions |
| Stage velocity | `v_deal` + `transition_history` | stages advanced / days since deal creation |
| Close date drift | `v_deal` | `DATEDIFF('day', original_close_date, current_close_date)` — negative means pushed out |

**Signal classification:**
- `accelerating`: daysInCurrentStage < 0.5 * avgDaysPerStage AND closeDateDrift <= 0
- `on_track`: daysInCurrentStage <= avgDaysPerStage
- `stalling`: daysInCurrentStage > 1.5 * avgDaysPerStage
- `at_risk`: stalling AND (closeDateDrift > 14 OR no champion interaction in 14 days)

**Why this matters for industrial B2B:** Deal cycles in manufacturing and energy are long — weeks per stage. A deal that sat in "qualified" for 45 days when the average is 20 is stalling, and the rep may not notice until it's too late. Momentum scoring combined with stakeholder risk detection ("champion went cold 3 weeks ago") gives the agent a concrete signal to surface: "Deal X is at risk — stuck in qualified for 2.3x the average, and your champion Sarah hasn't been contacted in 18 days."

---

## Schema Evolution

### The Problem

Two nodes run different versions of the extension. Node A adds a `linkedin_company_url` field to accounts. Node B doesn't know about this field yet. When they sync:

- Without schema evolution: B receives `entry_fields` rows referencing a `field_id` it doesn't have. Queries fail or silently drop the data.
- With schema evolution: B detects the unknown field, queues the values in `pending_field_values`, and applies the field definition when its extension updates.

### Design Decision: Schema Version Tracking + Forward Sync

Each node tracks its schema version. During sync, schema changes (new field definitions) are pushed alongside data changes.

**Schema version table:**
```sql
schema_versions (
  id VARCHAR PRIMARY KEY,
  object_name VARCHAR NOT NULL,
  field_name VARCHAR NOT NULL,
  field_type VARCHAR NOT NULL,
  version INTEGER NOT NULL,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  node_id VARCHAR NOT NULL
)
```

**Pending field values:**
```sql
pending_field_values (
  id VARCHAR PRIMARY KEY,
  entry_id VARCHAR NOT NULL,
  field_name VARCHAR NOT NULL,  -- stores remote field_id for unknown fields
  value VARCHAR,
  hlc_ts BIGINT NOT NULL,
  hlc_counter INTEGER NOT NULL,
  node_id VARCHAR NOT NULL,
  received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
```

**Implementation note:** The `field_name` column stores the *remote field_id* (not the human-readable name) when a value arrives for an unknown field. After schema sync creates the matching field locally, the drain function looks up `WHERE id = field_name` to apply pending values. This reuses the existing column rather than adding a separate `field_id` column.

### Sync Integration

Schema changes propagate during the normal drain cycle:

1. **Push phase:** Along with `sync_state`, push any new `schema_versions` entries since last sync
2. **Pull phase:** Receive remote `schema_versions`. For each:
   - If the field already exists locally: no-op
   - If the field is new and the object exists: auto-apply (INSERT into `fields`, rebuild PIVOT view)
   - If the field is new but the object doesn't exist: queue in `pending_field_values`
3. **Data with unknown fields:** If `entry_fields` data arrives referencing a field_id that doesn't exist locally, store in `pending_field_values` until the schema catches up

**Why this approach:** EAV makes schema evolution natural — adding a field is an INSERT into `fields`, not an ALTER TABLE. The hard part is coordinating when two nodes have different field sets. This approach handles the common case (one node is ahead) without complex version negotiation. The pending queue ensures no data is lost even when schema and data arrive out of order.

---

## Security Model

### What's Built

**Tenant isolation:** A `TenantContext` wrapper that injects `tenant_id = ?` into every query. All tenant-scoped tables carry a `tenant_id` column. The wrapper prevents cross-tenant data access at the query layer.

**PII encryption:** AES-256-GCM field-level encryption for marked fields (first_name, last_name, email, phone on contacts). Encryption key is per-tenant, passed via plugin config. Encryption happens at the write boundary (before INSERT into entry_fields), decryption at the read boundary (after SELECT). The DuckDB column stores ciphertext; PIVOT views return ciphertext unless decrypted by the application layer.

Format: `base64(12-byte-IV || ciphertext || 16-byte-auth-tag)`

**Hash-chained audit trail:** Every mutation appends to `audit_log` with:
```
hash = SHA-256(prev_hash || action || entity_type || entity_id || actor_id || details || timestamp)
```
The chain is tamper-evident: modifying any row breaks the hash chain from that point forward. `verifyAuditChain()` walks the log and recomputes hashes to detect tampering.

### What's Designed Only

**MITM prevention:** TLS 1.3 for transport. Request signing with HMAC-SHA256 over `method + path + body + timestamp + nonce`. Server rejects requests older than 30 seconds (replay window) or with reused nonces (nonce cache with TTL). Certificate pinning in the client for the cloud endpoint.

**Credential rotation:** Sliding window refresh tokens. When a token is refreshed, the old token remains valid for a 60-second grace period (handles in-flight requests). Rotation is automatic — the sync service handles token refresh transparently.

**Data lifecycle on disconnect:** Three-tier TTL policy:
- Hot (0–30 days): full data retained, full sync active
- Warm (30–90 days): data retained, sync paused, manual trigger only
- Cold (90+ days): PII fields zeroed, aggregate metrics retained, full purge available on demand

These are infrastructure-level concerns that would require real cloud infrastructure to demonstrate. The protocol design is documented here; implementation would be straightforward once the cloud endpoint exists.

---

## Import/Export

### CSV Import Pipeline

```
Raw CSV bytes ──► Encoding Detection ──► UTF-8 Normalization ──► Parse
                                                                   │
                  ┌────────────────────────────────────────────────┘
                  ▼
         Column Mapping ──► Validation ──► Dedup Check ──► Insert or Log Error
                                                              │          │
                                                              ▼          ▼
                                                       entry_fields  import_errors
```

**Encoding handling:** Detect UTF-8/16, ISO-8859-1, Windows-1252 via BOM and byte pattern analysis. Normalize to UTF-8 before parsing. This catches the most common encoding issues from Excel exports (Windows-1252 smart quotes, ISO-8859-1 accented characters).

**Column mapping:** User provides `[{ csvColumn: "Company", objectField: "name" }]`. The mapper translates CSV column names to EAV field IDs. Unmapped columns are ignored. Missing required fields trigger row-level errors.

**Validation per field type:**
- `email`: RFC 5322 regex
- `number`: parseFloat, reject NaN
- `phone`: strip non-digit characters, validate length 7–15
- `date`: parse ISO 8601, MM/DD/YYYY, DD-MM-YYYY
- `url`: require protocol prefix
- `required`: reject row if null/empty

**Error handling — skip-and-log:**
```sql
-- Valid rows:
INSERT INTO entries (...) + INSERT INTO entry_fields (...)

-- Invalid rows:
INSERT INTO import_errors (import_batch_id, row_number, raw_data, error_reason)
VALUES (?, ?, ?::JSON, ?)
```

Return value: `{ batchId, totalRows: 10000, imported: 9997, skipped: 3, errors: [...] }`

The agent can query `import_errors` to surface issues: "3 rows failed import — row 47 had invalid email 'notanemail', row 4721 was missing required field 'name', row 9003 had duplicate domain."

**Deduplication:** Exact match on email (contacts) or domain (accounts). Checks both existing data and within-batch duplicates. Duplicates are flagged, not automatically skipped — the agent surfaces them for user decision.

### CSV Export

Query PIVOT view with optional filter, output RFC 4180 CSV. Properly escapes quotes and commas. Header row matches field labels.

---

## Testing Strategy

### What's Tested and Why

| Test file | What it covers | Why these paths matter |
|-----------|---------------|----------------------|
| `sync.test.ts` | HLC arithmetic, CRDT merge, conflict resolution, queue drain, convergence | Sync correctness is the hardest claim to verify. If the CRDT merge has a bug, data silently corrupts. These tests prove convergence under all conflict scenarios. |
| `schema-evolution.test.ts` | Schema version tracking, field addition sync, unknown field queuing, pending value application | Schema drift between nodes can silently drop data. These tests prove fields sync correctly and no data is lost when schema arrives out of order. |
| `import.test.ts` | Adversarial CSV (bad encoding, missing fields, duplicates, quoted newlines), partial failure, dedup | Import is the main data ingestion path. Real-world CSVs are messy. These tests prove the system doesn't choke on bad data. |
| `search.test.ts` | FTS ranking, boolean filters, faceted counts, intelligence field sorting, 10K-scale performance | Search is the primary read path. Incorrect filters or counts would make the tool unreliable. Intelligence enrichment and scale test prove it works beyond toy data. |
| `activity.test.ts` | Scoring formula, neglect detection, anomaly z-scores, navigation sequences, search intent classification | Activity intelligence is the differentiating feature. If scoring is wrong, the agent gives bad advice. Session/sequence tests prove navigation patterns are captured correctly. |
| `security.test.ts` | Tenant isolation, PII encryption round-trip, audit chain integrity, tamper detection | Security bugs are silent until exploited. These tests prove the invariants hold. |

### What's Not Tested

- Web UI rendering (DenchClaw's responsibility, not the extension's)
- Real network sync (mock cloud covers the protocol; transport is a thin layer)
- Agent behavior (skills are prompt engineering; testing requires the full agent loop)

---

## Scope Decisions

### Built

| Feature | Status | Notes |
|---------|--------|-------|
| Account/Contact/Deal EAV objects | Complete | All fields, statuses, PIVOT views, .object.yaml files |
| Contact-deal role junction | Complete | Per-deal roles, skill teaches join pattern |
| Deal pipeline + transition history | Complete | Stage changes logged with duration |
| Line items with computed totals | Complete | Standalone table, deal value = sum of line items |
| Bidirectional sync with CRDTs | Complete | HLC + field-level LWW-Register, mock cloud |
| Sync queue (single-writer safe) | Complete | Background drain, user writes never blocked |
| Full-text search (DuckDB FTS) | Complete | BM25 ranking + ILIKE substring fallback |
| Boolean filter builder | Complete | Nested AND/OR with parameterized SQL |
| Faceted counts | Complete | Dynamic counts per field value |
| Activity event capture | Complete | All CRUD operations logged |
| Engagement scoring | Complete | Recency × frequency × depth formula |
| Neglect detection | Complete | Configurable threshold per entity type |
| Navigation sequences (sessions) | Complete | session_id + sequence_number on activity_events |
| Search intent classification | Complete | Rule-based SQL patterns in activity skill |
| Intelligence field enrichment | Complete | engagement_score, neglect_flag, days_since_activity sortable in search |
| Anomaly detection (z-score) | Complete | Rolling 30-day window |
| Schema evolution | Complete | Schema version tracking, field sync, pending_field_values for unknown fields |
| Stakeholder relationship graph | Complete | Directed graph with influence scoring and automated risk detection |
| Deal momentum scoring | Complete | Forward-looking velocity metric from transition_history + close date drift |
| Sync status indicator | Complete | Queue depth + last sync time surfaced conversationally by agent |
| Tenant isolation | Complete | Query-level enforcement via wrapper |
| PII encryption (AES-256-GCM) | Complete | Field-level, per-tenant key |
| Audit trail (hash-chained) | Complete | Tamper-evident, verifiable |
| CSV import (skip-and-log) | Complete | Encoding detection, validation, dedup |
| CSV export | Complete | Filtered PIVOT view output |
| Skills (4 SKILL.md files) | Complete | Agent-ready SQL patterns |

### Designed Only (in this document)

| Feature | Why designed only |
|---------|------------------|
| MITM prevention (TLS pinning + HMAC signing) | Requires real network infrastructure. Protocol is fully specified above. |
| Credential rotation (sliding window) | Requires real auth service. Token lifecycle design is documented. |
| Data lifecycle tiering (hot/warm/cold) | Operational concern requiring real cloud. TTL policy is specified. |
| Fuzzy deduplication (Levenshtein, phonetic) | Exact-match dedup handles the common case. Fuzzy matching is a significant algorithmic addition with diminishing returns for v1. |

### Cut

| Feature | Why cut |
|---------|---------|
| Real-time conflict resolution UI | CRDTs handle merge automatically and deterministically. A manual merge UI is a separate frontend feature that adds complexity without improving correctness. |
| Real cloud sync endpoint | The mock cloud demonstrates the full protocol. Replacing it with a real endpoint is a transport-layer change — the sync logic, CRDT merge, and queue architecture are identical. |

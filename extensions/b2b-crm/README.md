# DenchClaw B2B CRM Extension

A native DenchClaw extension that adds full B2B account management with bidirectional cloud sync, full-text search, activity intelligence, tenant isolation, CSV import/export, and hash-chained audit trails — all built on DuckDB and DenchClaw's EAV data model.

---

## Architecture

See [DESIGN.md](../../DESIGN.md) for the full architecture. In brief:

- **EAV objects** — accounts, contacts, and deals defined as DenchClaw objects, rendering natively in the web UI (table views for accounts/contacts, kanban board for deals)
- **Plugin tools** — sync, import, export tools registered via `api.registerTool()`, callable by the DenchClaw agent
- **Skills** — `skills/b2b-crm/` markdown files teaching the agent SQL patterns for CRUD, pipeline, search, and activity analytics
- **Background service** — sync queue drain running on a configurable interval (default 30s)

---

## Setup

### Prerequisites

- Node.js 22+
- pnpm 9+
- DenchClaw repo cloned locally

### Install

```bash
# From the DenchClaw repo root
pnpm install
```

DuckDB's native binary will be compiled from source on first install (~5 min on Apple Silicon).

### Configure the extension

Add to your DenchClaw config (or `openclaw.plugin.json` `configSchema`):

```json
{
  "plugins": {
    "b2b-crm": {
      "enabled": true,
      "workspacePath": "~/.openclaw-dench/workspace",
      "syncIntervalMs": 30000,
      "encryptionKey": "<base64-encoded 32-byte key>",
      "tenantId": "your-org-id"
    }
  }
}
```

`workspacePath` defaults to `~/.openclaw-dench/workspace`. The extension creates the DuckDB file, workspace object directories, and `.object.yaml` files automatically on first load.

### Run

```bash
pnpm dev
# or
openclaw --profile dench
```

The extension self-initializes: creates all EAV tables, inserts object/field definitions, creates PIVOT views, and builds FTS indexes on first start.

---

## What's Implemented

### Account Management
- **EAV objects**: account (12 fields), contact (10 fields), deal (10 fields with 6 pipeline stages)
- **PIVOT views**: `v_account`, `v_contact`, `v_deal` — flat queryable views over the EAV model
- **Relation fields**: contacts linked to accounts, deals linked to accounts
- **Contact-deal roles**: champion, decision_maker, blocker, influencer, end_user, technical_evaluator
- **Stakeholder edges**: directed graph between contacts with relationship type + deal scope
- **Deal line items**: `line_items` table with computed total
- **Pipeline transitions**: `transition_history` table logs every stage change with duration

### Bidirectional Sync
- **Hybrid Logical Clock (HLC)**: monotonic, cross-node timestamp with counter tiebreak and node ID
- **LWW-Register CRDT**: field-level last-write-wins merge — commutative, deterministic, convergent
- **Sync queue**: all sync writes buffered in `sync_queue` table; drain service runs on interval
- **Mock cloud**: second DuckDB instance at `workspace-cloud.duckdb` simulates the sync target
- **Tools**: `b2b_crm_sync_push`, `b2b_crm_sync_pull`, `b2b_crm_sync_status`
- **Schema evolution sync**: field additions propagate between nodes; unknown fields buffered in `pending_field_values` without crashing

### Search & Discovery
- **Full-text search**: DuckDB FTS BM25 over `fts_account`, `fts_contact`, `fts_deal` staging tables
- **Boolean filters**: `buildFilterSQL()` — recursive AND/OR with `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in`, `not_in`; auto-casts numeric operators for VARCHAR PIVOT columns
- **Faceted counts**: `getFacetedCounts()` — per-field COUNT distribution, filtered or unfiltered
- **Intelligence enrichment**: search results enriched with `engagement_score`, `neglect_flag`, `days_since_activity`

### Activity Intelligence
- **Event capture**: `logEvent()` inserts into `activity_events` with session ID and auto-incrementing sequence number
- **Engagement scoring**: recency (40%) + frequency (30%) + depth (30%) using DuckDB CTEs and window functions
- **Neglect detection**: LEFT JOIN to find entities with no events past threshold (30d accounts, 14d active deals)
- **Anomaly detection**: rolling 30-day z-score flags activity spikes (|z| > 2.0)
- **Stakeholder graph**: influence scoring with role-weight × recency decay; risk detection (no decision maker, single-threaded, cold champion, uncountered blocker)
- **Deal momentum**: stage velocity from `transition_history` — classifies as accelerating / on_track / stalling / at_risk

### Security
- **Tenant isolation**: `createTenantContext(tenantId)` injects `tenant_id = ?` into all WHERE clauses
- **PII encryption**: AES-256-GCM field-level encryption for contact PII fields (First Name, Last Name, Email Address, Phone Number)
- **Hash-chained audit trail**: SHA-256 chain where each `audit_log` row's hash covers the previous row's hash — `verifyAuditChain()` detects tampering

### CSV Import/Export
- **Import tool** (`b2b_crm_import_csv`): RFC 4180 parser, column mapping, per-field validation (email regex, number parse, URL protocol, date formats), skip-and-log error handling, deduplication
- **Export tool** (`b2b_crm_export_csv`): RFC 4180 CSV from PIVOT views with optional field selection and filter
- **Encoding detection**: UTF-8, UTF-16LE/BE, ISO-8859-1, Windows-1252 via BOM + byte analysis

---

## Designed-Only (Not Fully Implemented)

The following items were architecturally designed but intentionally scoped out of this implementation:

- **Real cloud sync target** — the sync protocol is fully functional but targets a second local DuckDB file (`workspace-cloud.duckdb`), not a real API endpoint. The `MockCloud` interface matches what a real cloud adapter would need.
- **TenantContext INSERT injection** — the tenant wrapper only injects `tenant_id` into WHERE clauses. INSERT statements must include `tenant_id` in VALUES manually; there is no automatic injection at write time.
- **MITM protection / transport security** — the sync protocol has no TLS or authentication layer. Designed for local-only use in this version.
- **Data lifecycle / GDPR deletion** — the `PII_FIELDS` set and `encryption.ts` are in place, but there is no automated purge or DSAR export workflow.
- **UI-triggered activity capture** — `logEvent()` is fully functional but is not yet hooked into the DenchClaw web UI lifecycle events; it must be called programmatically.

---

## How to Exercise Each Feature

### Account / Contact / Deal CRUD

Use DenchClaw chat:
```
Create an account for Apex Manufacturing in the energy sector with 500 employees
Add a contact John Smith at Apex Manufacturing, email john@apex.com, role: champion
Create a deal "Q3 Expansion" linked to Apex Manufacturing worth $500,000
```

Query directly:
```sql
SELECT "Company Name", "Industry", "Employee Count" FROM v_account LIMIT 10;
SELECT "First Name", "Last Name", "Email Address" FROM v_contact LIMIT 10;
SELECT "Deal Name", "Deal Value", "Currency" FROM v_deal LIMIT 10;
```

### Sync

```
-- Push local changes to the sync queue
b2b_crm_sync_push

-- Pull from cloud and merge
b2b_crm_sync_pull

-- Check queue depth
b2b_crm_sync_status
```

### Search

```
-- FTS search for accounts
SELECT entry_id, score FROM fts_account WHERE match_bm25(entry_id, 'manufacturing texas') IS NOT NULL;

-- Filter by industry + size
SELECT "Company Name" FROM v_account
WHERE "Industry" = 'Energy' AND "Employee Count"::NUMERIC > 1000;

-- Faceted counts by industry
SELECT "Industry", COUNT(*) FROM v_account GROUP BY "Industry" ORDER BY COUNT(*) DESC;
```

### CSV Import

```
b2b_crm_import_csv
  csvContent: "Company Name,Domain,Industry\nApex Corp,https://apex.com,Manufacturing"
  objectName: account
  mappings: [{ csvColumn: "Company Name", objectField: "Company Name" }, ...]
```

### Activity Intelligence

```sql
-- Engagement scores
SELECT entity_id, score FROM (
  SELECT entity_id, entity_type,
    0.4 * (1.0 / (1.0 + DATEDIFF('day', MAX(occurred_at), CURRENT_TIMESTAMP))) +
    0.3 * LN(1 + COUNT(*)) / 5.0 +
    0.3 * SUM(CASE event_type WHEN 'create' THEN 3 WHEN 'update' THEN 2 ELSE 1 END) / 30.0 AS score
  FROM activity_events WHERE entity_type = 'account'
  GROUP BY entity_id, entity_type
) ORDER BY score DESC;

-- Neglected accounts
SELECT e.id, MAX(ae.occurred_at) AS last_activity
FROM entries e
JOIN objects o ON e.object_id = o.id
LEFT JOIN activity_events ae ON ae.entity_id = e.id AND ae.entity_type = 'account'
WHERE o.name = 'account'
GROUP BY e.id
HAVING MAX(ae.occurred_at) < CURRENT_TIMESTAMP - (30 * INTERVAL '1 day') OR MAX(ae.occurred_at) IS NULL;
```

### Security

```typescript
// Verify audit trail integrity
import { verifyAuditChain } from './audit.js';
const result = await verifyAuditChain(dbPath);
// { valid: true } or { valid: false, brokenAt: 5 }
```

---

## Running Tests

```bash
# Full test suite (146 tests, 10 files)
pnpm vitest run --config extensions/vitest.config.ts

# Individual test files
pnpm vitest run --config extensions/vitest.config.ts extensions/b2b-crm/sync.test.ts
pnpm vitest run --config extensions/vitest.config.ts extensions/b2b-crm/schema-evolution.test.ts
pnpm vitest run --config extensions/vitest.config.ts extensions/b2b-crm/search.test.ts
pnpm vitest run --config extensions/vitest.config.ts extensions/b2b-crm/activity.test.ts
pnpm vitest run --config extensions/vitest.config.ts extensions/b2b-crm/import.test.ts
pnpm vitest run --config extensions/vitest.config.ts extensions/b2b-crm/security.test.ts
```

To generate 10K synthetic accounts for scale testing:

```typescript
import { generateSyntheticAccounts } from './generate-fixtures.js';
await generateSyntheticAccounts(10_000, dbPath);
```

---

## Known Limitations

- **DuckDB BIGINT → JavaScript BigInt**: DuckDB returns all `BIGINT` columns as JavaScript `bigint`. Every read of `hlc_ts`, `hlc_counter`, `DATEDIFF` results, and COUNT aggregates must be wrapped in `Number()`. This is handled throughout the codebase.
- **DuckDB FTS on views**: `PRAGMA create_fts_index` only works on real tables, not views. FTS staging tables (`fts_account`, `fts_contact`, `fts_deal`) must be refreshed after bulk inserts by re-calling `setupFTSIndexes()`.
- **DuckDB FTS match_bm25 parameter binding**: The `match_bm25` function does not accept parameterized query strings — only literals. The codebase uses sanitized string interpolation (stripping quotes and special characters). Do not pass untrusted input directly.
- **Single-writer DuckDB**: All sync writes go through the `sync_queue` drain service to respect DuckDB's single-writer constraint. Concurrent writes from multiple processes are not supported.
- **Mock cloud only**: The sync target is a second DuckDB file, not a real network endpoint. Production use would require a cloud adapter implementing the `MockCloud` interface.
- **csv-import.ts is 302 lines** (over the 200-line guideline): parser, validation, and import engine are tightly coupled; splitting would add more surface than it removes.
- **Workspace path is not automatically created** if the parent directory doesn't exist. The extension calls `mkdirSync(..., { recursive: true })` but the parent of the workspace path must be accessible.

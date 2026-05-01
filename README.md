<p align="center">
  <a href="https://denchclaw.com">
    <img src="assets/denchclaw-hero.png" alt="DenchClaw — AI CRM, hosted locally on your Mac. Built on OpenClaw." width="680" />
  </a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/denchclaw"><img src="https://img.shields.io/npm/v/denchclaw?style=for-the-badge&color=000" alt="npm version"></a>&nbsp;
  <a href="https://discord.gg/PDFXNVQj9n"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord"></a>&nbsp;
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

<p align="center">
  <a href="https://denchclaw.com">Website</a> · <a href="https://discord.gg/PDFXNVQj9n">Discord</a> · <a href="https://skills.sh">Skills Store</a> · <a href="https://www.youtube.com/watch?v=pfACTbc3Bh4&t=44s">Demo Video</a>
</p>

<br />

<p align="center">
  <a href="https://denchclaw.com">
    <img src="assets/denchclaw-app.png" alt="DenchClaw Web UI — workspace, object tables, and AI chat" width="780" />
  </a>
  <br />
  <a href="https://www.youtube.com/watch?v=pfACTbc3Bh4&t=44s">Demo Video</a> · <a href="https://discord.gg/PDFXNVQj9n">Join our Discord Server</a>
</p>

<br />

> **This is a fork of [DenchHQ/DenchClaw](https://github.com/DenchHQ/DenchClaw)** maintained by [@daniel0tgc](https://github.com/daniel0tgc).
> See [Changes from upstream](#changes-from-upstream-denchclaw) for what's different.

---

## Changes from Upstream DenchClaw

This fork adds the following on top of the official [DenchHQ/DenchClaw](https://github.com/DenchHQ/DenchClaw):

### macOS Sonoma (14+) Fix

macOS Sonoma sets a kernel-level `com.apple.provenance` attribute on files downloaded via npm. This causes `readFileSync` to fail with `EPERM: operation not permitted` on OpenClaw's bundled plugin files, preventing DenchClaw from starting on any macOS 14+ machine.

**Fix applied in `src/cli/bootstrap-external.ts`:**
- `--ignore-scripts` added to all `npm install openclaw` calls so the blocked postinstall does not abort the install
- `unblockOpenClawInstall()` rewrites each JS dist file via a `temp+rename` inode swap — content is fetched **in-memory** from the npm tarball (no disk write = no provenance) for files that are blocked
- The OpenClaw update flow now uses `npm install -g --ignore-scripts` + unblock instead of `openclaw update --yes`, so updates don't re-introduce the block

This fix is transparent on Linux and Windows (the unblock function is a no-op when files are already readable).

### Extensions

The `extensions/` directory contains custom OpenClaw plugins that are automatically loaded when you run this fork:

| Extension | Description |
|---|---|
| `dench-ai-gateway` | Dench Cloud AI model routing |
| `dench-identity` | Identity and auth helpers |
| `exa-search` | Web search via Exa |
| `posthog-analytics` | Analytics event tracking |
| `apollo-enrichment` | Contact/company data enrichment |
| `b2b-crm` | **Full B2B CRM** — accounts, contacts, deals, sync, search, activity intelligence, CSV import/export, audit trail |

---

## Install (from this fork)

**Node 22+ and pnpm required.**

```bash
git clone https://github.com/daniel0tgc/denchclaw-extension.git
cd denchclaw-extension

pnpm install
pnpm build

# First time only — builds the web UI (~3 min)
pnpm web:build && pnpm web:prepack

# Run (opens at localhost:3100)
DENCH_API_KEY=your_key_from_dench.com/api pnpm dev
```

Get your Dench API key at **[dench.com/api](https://dench.com/api)**.

After the first-time build, subsequent runs are just:

```bash
DENCH_API_KEY=your_key pnpm dev
```

> **Note on DuckDB:** `pnpm install` compiles the DuckDB native binary from source (~5 min on Apple Silicon, one-time cost).

---

## AI Agent Setup Prompt

```
Install DenchClaw (an OpenClaw CRM Framwork) by running "npx denchclaw", when it asks to update OpenClaw, update it as DenchClaw requires up to date OpenClaw. When it asks for my Dench API Key, help me fetch it from dench.com/api and set it up. Remember that DenchClaw creates a new OpenClaw Gateway (~/.openclaw-dench) on port 19001 by default, and a new main agent in that gateway working in ~/.openclaw-dench/workspace directory (Separate from the usual non-DenchClaw OpenClaw gateway that usually sits in ~/.openclaw). All DenchClaw config sits in ~/.openclaw-dench/openclaw.json. Remember that anytime you interface with DenchClaw using openclaw commands, you must use "openclaw --profile dench" as a prefix, for example, to restart gateway, run "openclaw --profile dench gateway restart". After everything is setup, DenchClaw will be accessible at localhost:3100 by default. If for some reason that Port 19001 and 3100 or those ranges are taken, make sure to kill those ports/processes and then retry npx denchclaw. Also, sometimes if the Web UI on port 3100 crashes, just run "npx denchclaw update" to boot it back up. Remember to refer to https://github.com/DenchHQ/DenchClaw (DenchClaw's official GitHub Repository) for more information.
```

---

## Commands

```bash
pnpm dev                     # start DenchClaw (localhost:3100)
pnpm build                   # rebuild CLI after code changes
pnpm web:build               # rebuild web UI (run after web changes)
pnpm web:prepack             # finalize standalone web build

# OpenClaw gateway commands (always use --profile dench)
openclaw --profile dench gateway restart
openclaw --profile dench gateway status
openclaw --profile dench devices list
openclaw --profile dench devices approve --latest

openclaw --profile dench config set gateway.port 19001
openclaw --profile dench gateway install --force --port 19001
openclaw --profile dench uninstall
```

### Daemonless / Docker

```bash
export DENCHCLAW_DAEMONLESS=1
openclaw --profile dench gateway --port 19001  # start gateway as foreground process
```

Or pass `--skip-daemon-install` per command:

```bash
pnpm dev --skip-daemon-install
```

---

## B2B CRM Extension

The `b2b-crm` extension (`extensions/b2b-crm/`) adds a complete B2B CRM layer to DenchClaw: account/contact/deal management with bidirectional cloud sync, full-text search, activity intelligence, tenant isolation, CSV import/export, and hash-chained audit trails — all built natively on DuckDB and DenchClaw's EAV data model.

See [`DESIGN.md`](DESIGN.md) for the full architecture and data model.

### What's Implemented

**Account Management**
- EAV objects: account (12 fields), contact (10 fields), deal (10 fields with 6 pipeline stages)
- PIVOT views: `v_account`, `v_contact`, `v_deal` — flat queryable views over the EAV model
- Contact-deal roles: champion, decision_maker, blocker, influencer, end_user, technical_evaluator
- Stakeholder edges: directed graph between contacts with relationship type + deal scope
- Deal line items with computed total; pipeline transition history with duration

**Bidirectional Sync**
- Hybrid Logical Clock (HLC): monotonic, cross-node timestamp with counter tiebreak
- LWW-Register CRDT: field-level last-write-wins merge — commutative, deterministic, convergent
- Sync queue: all writes buffered in `sync_queue`; background drain runs on configurable interval (default 30s)
- Schema evolution: field additions sync between nodes; unknown fields buffered without crashing
- Tools: `b2b_crm_sync_push`, `b2b_crm_sync_pull`, `b2b_crm_sync_status`

**Search & Discovery**
- Full-text search: DuckDB FTS BM25 over flat staging tables (materialized from PIVOT views)
- Boolean filter builder: recursive AND/OR with all comparison operators, auto-cast for numeric fields
- Faceted counts: per-field COUNT distribution, updates dynamically as filters change
- Intelligence enrichment: search results sortable by `engagement_score`, `neglect_flag`, `days_since_activity`

**Activity Intelligence**
- Event capture: `logEvent()` with session ID and sequence number for navigation tracking
- Engagement scoring: recency (40%) + frequency (30%) + depth (30%)
- Neglect detection: entities with no activity past threshold (30d accounts, 14d deals)
- Anomaly detection: rolling 30-day z-score flags activity spikes (|z| > 2.0)
- Stakeholder graph: influence scoring (role-weight × recency decay) + automated risk detection
- Deal momentum: classifies deals as accelerating / on_track / stalling / at_risk

**Security**
- Tenant isolation: `createTenantContext(tenantId)` injects `tenant_id = ?` into all WHERE clauses
- PII encryption: AES-256-GCM field-level encryption for contact PII fields
- Hash-chained audit trail: SHA-256 chain — `verifyAuditChain()` detects any tampering

**CSV Import/Export**
- Import: RFC 4180 parser, encoding detection (UTF-8/16, ISO-8859-1, Windows-1252), column mapping, per-field validation, skip-and-log error handling, deduplication
- Export: filtered PIVOT view output as RFC 4180 CSV

### Designed-Only (Not Fully Implemented)

- **Real cloud sync target** — sync protocol is complete but targets a second local DuckDB file (`workspace-cloud.duckdb`), not a live endpoint
- **TenantContext INSERT injection** — `tenant_id` is only injected into WHERE clauses; INSERT statements must include it manually in VALUES
- **MITM protection / transport security** — designed for local-only use; no TLS layer on sync
- **Data lifecycle / GDPR deletion** — encryption and PII field marking are in place; automated purge workflow is not

### Configure the B2B CRM Extension

The extension self-initializes on first load. To customize, edit `~/.openclaw-dench/openclaw.json`:

```json
{
  "plugins": {
    "b2b-crm": {
      "enabled": true,
      "config": {
        "workspacePath": "~/.openclaw-dench/workspace",
        "syncIntervalMs": 30000,
        "encryptionKey": "<base64-encoded 32-byte key>",
        "tenantId": "your-org-id"
      }
    }
  }
}
```

### How to Exercise Each Feature

**Account / Contact / Deal CRUD** — use DenchClaw chat:
```
Create an account for Apex Manufacturing in the energy sector with 500 employees
Add a contact John Smith at Apex Manufacturing, email john@apex.com, role: champion
Create a deal "Q3 Expansion" linked to Apex Manufacturing worth $500,000
```

Or query directly:
```sql
SELECT "Company Name", "Industry", "Employee Count" FROM v_account LIMIT 10;
SELECT "First Name", "Last Name", "Email Address" FROM v_contact LIMIT 10;
SELECT "Deal Name", "Deal Value", "Currency" FROM v_deal LIMIT 10;
```

**Sync:**
```
b2b_crm_sync_push    -- queue local changes for cloud
b2b_crm_sync_pull    -- pull from cloud and CRDT-merge
b2b_crm_sync_status  -- show pending count + last sync time
```

**Search:**
```sql
-- FTS (BM25 ranked)
SELECT entry_id FROM fts_account WHERE match_bm25(entry_id, 'manufacturing texas') IS NOT NULL;

-- Boolean filter
SELECT "Company Name" FROM v_account
WHERE "Industry" = 'Energy' AND "Employee Count"::NUMERIC > 1000;

-- Faceted counts
SELECT "Industry", COUNT(*) FROM v_account GROUP BY "Industry" ORDER BY COUNT(*) DESC;
```

**CSV Import:**
```
b2b_crm_import_csv
  csvContent: "Company Name,Domain,Industry\nApex Corp,https://apex.com,Manufacturing"
  objectName: account
  mappings: [{ csvColumn: "Company Name", objectField: "Company Name" }]
```

**Activity Intelligence:**
```sql
-- Engagement scores
SELECT entity_id,
  0.4 * (1.0 / (1.0 + DATEDIFF('day', MAX(occurred_at), CURRENT_TIMESTAMP))) +
  0.3 * LN(1 + COUNT(*)) / 5.0 +
  0.3 * SUM(CASE event_type WHEN 'create' THEN 3 WHEN 'update' THEN 2 ELSE 1 END) / 30.0 AS score
FROM activity_events WHERE entity_type = 'account'
GROUP BY entity_id ORDER BY score DESC;

-- Neglected accounts
SELECT e.id, MAX(ae.occurred_at) AS last_activity
FROM entries e JOIN objects o ON e.object_id = o.id
LEFT JOIN activity_events ae ON ae.entity_id = e.id AND ae.entity_type = 'account'
WHERE o.name = 'account'
GROUP BY e.id
HAVING MAX(ae.occurred_at) < CURRENT_TIMESTAMP - (30 * INTERVAL '1 day')
    OR MAX(ae.occurred_at) IS NULL;
```

### Running Tests

```bash
# Full test suite (146 tests, 6 b2b-crm test files)
pnpm vitest run --config extensions/vitest.config.ts

# Individual test files
pnpm vitest run --config extensions/vitest.config.ts extensions/b2b-crm/sync.test.ts
pnpm vitest run --config extensions/vitest.config.ts extensions/b2b-crm/schema-evolution.test.ts
pnpm vitest run --config extensions/vitest.config.ts extensions/b2b-crm/search.test.ts
pnpm vitest run --config extensions/vitest.config.ts extensions/b2b-crm/activity.test.ts
pnpm vitest run --config extensions/vitest.config.ts extensions/b2b-crm/import.test.ts
pnpm vitest run --config extensions/vitest.config.ts extensions/b2b-crm/security.test.ts
```

To generate 10K synthetic accounts for scale/search testing:

```typescript
import { generateSyntheticAccounts } from './extensions/b2b-crm/generate-fixtures.js';
await generateSyntheticAccounts(10_000, dbPath);
```

### Known Limitations

- **DuckDB BIGINT → BigInt**: DuckDB returns `BIGINT` columns as JavaScript `bigint`. All reads of `hlc_ts`, `hlc_counter`, `DATEDIFF`, and COUNT aggregates are wrapped in `Number()` throughout the codebase.
- **FTS requires real tables**: `PRAGMA create_fts_index` doesn't work on views. FTS staging tables (`fts_account`, `fts_contact`, `fts_deal`) are materialized at startup and must be refreshed after bulk inserts by calling `setupFTSIndexes()` again.
- **FTS query binding**: `match_bm25` doesn't accept parameterized queries — the codebase sanitizes input (strips quotes/special chars) before interpolating. Don't pass untrusted input directly.
- **Single-writer DuckDB**: All sync writes go through the queue service. Concurrent writes from multiple processes are not supported.
- **Mock cloud only**: The sync target is a second local DuckDB file. Replace `MockCloud` with a real adapter for production use.

---

## Troubleshooting

### Chat messages return 404 / agent never responds

**Symptom:** The browser console shows repeated `GET /api/chat/stream?sessionId=xxx 404 (Not Found)`, and sending a message in the UI shows "Failed to start agent: pairing required: device is asking for more scopes than currently approved."

**Root cause:** This is a version migration gap in the upstream DenchClaw repo. The web runtime (`apps/web/lib/agent-runner.ts`) requests five operator scopes when connecting to the gateway (`operator.admin`, `operator.approvals`, `operator.pairing`, `operator.read`, `operator.write`). If the stored `~/.openclaw-dench/identity/device-auth.json` was approved under an older version that only granted `operator.pairing`, every new `POST /api/chat` call is rejected before any agent run is created — which is why the subsequent `GET /api/chat/stream` returns 404 (no run exists to stream).

The problem is made worse by the `b2b-crm` extension: registering new agent tools triggers the gateway's scope re-evaluation, so existing installs that worked before adding the extension start failing.

**This fork's fix:** `src/cli/bootstrap-external.ts` now calls `shouldResetDeviceAuth()` before starting the web runtime. If `device-auth.json` exists but is missing any of the five required operator scopes, it is deleted so the web runtime sends a fresh pairing request. The existing `attemptBootstrapDevicePairing` step then auto-approves it. Running `pnpm dev` or `npx denchclaw update` will self-heal silently (you will see "Resetting stale gateway device token (scope upgrade)…" once in the console).

**Manual fix (if needed):**

```bash
openclaw --profile dench devices list
openclaw --profile dench devices approve --latest
npx denchclaw restart
```

### `pairing required`

If the Control UI shows `gateway connect failed: pairing required`, list pending devices and approve:

```bash
openclaw --profile dench devices list
openclaw --profile dench devices approve --latest
```

Then restart the web runtime:

```bash
npx denchclaw restart
```

This also happens when new extension tools are registered (e.g. first run after adding `b2b-crm`). Approving the device re-grants the updated scope.

### `EPERM: operation not permitted` on macOS

If you see this error on a non-macOS-Sonoma machine or after a system upgrade, the fix is already built into this fork's install flow. If it persists, try:

```bash
openclaw --profile dench gateway stop
openclaw --profile dench gateway install --force
openclaw --profile dench gateway restart
```

### Web UI not loading (`localhost:3100`)

```bash
npx denchclaw update   # re-boots the web runtime
```

---

## Development

```bash
git clone https://github.com/daniel0tgc/denchclaw-extension.git
cd denchclaw-extension

pnpm install
pnpm build

pnpm dev
```

Web UI development:

```bash
pnpm web:dev
```

Adding a new extension: create a folder under `extensions/` with an `openclaw.plugin.json` and a `package.json`. Register it in the `managedBundledPlugins` array in `src/cli/bootstrap-external.ts` so it auto-installs on startup.

---

## Upstream

This fork tracks [DenchHQ/DenchClaw](https://github.com/DenchHQ/DenchClaw). To pull upstream changes:

```bash
git pull origin main   # origin points to DenchHQ/DenchClaw
```

The macOS fix and the `b2b-crm` extension are both in `src/cli/bootstrap-external.ts` and `extensions/b2b-crm/` — neither conflicts with upstream feature work.

---

## Open Source

MIT Licensed. Fork it, extend it, make it yours.

<p align="center">
  <a href="https://github.com/DenchHQ/DenchClaw"><img src="https://img.shields.io/github/stars/DenchHQ/DenchClaw?style=for-the-badge" alt="GitHub stars"></a>
</p>

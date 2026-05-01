# Debugging.md — DenchClaw B2B CRM Extension

<!--
  RUN AFTER completing all tasks in a phase, BEFORE writing the phase summary in Done.md.
  Every check must pass. If a check fails after 3 fix attempts, output BLOCKED.
  Do NOT mark a phase complete in Done.md until every check here is [x].
-->

---

## Phase 0 — Scaffold

**0.D1 — Directory structure exists**
```bash
test -d extensions/b2b-crm && echo "PASS" || echo "FAIL: missing extension dir"
test -f extensions/b2b-crm/package.json && echo "PASS" || echo "FAIL: missing package.json"
test -f extensions/b2b-crm/openclaw.plugin.json && echo "PASS" || echo "FAIL: missing manifest"
test -f extensions/b2b-crm/index.ts && echo "PASS" || echo "FAIL: missing index.ts"
test -d skills/b2b-crm/deal-pipeline && echo "PASS" || echo "FAIL: missing deal-pipeline skill dir"
test -d skills/b2b-crm/search && echo "PASS" || echo "FAIL: missing search skill dir"
test -d skills/b2b-crm/activity && echo "PASS" || echo "FAIL: missing activity skill dir"
```
Why this breaks: Missing extension files means the gateway can't discover or load the plugin. Flat layout (no src/ subdirs) matches real DenchClaw extension convention.
- [ ] Extension directory and required files exist

**0.D2 — Plugin manifest is valid JSON**
```bash
node -e "JSON.parse(require('fs').readFileSync('extensions/b2b-crm/openclaw.plugin.json', 'utf8')); console.log('PASS')"
```
Why this breaks: DenchClaw gateway won't load the extension if manifest is malformed.
- [ ] Manifest parses as valid JSON

**0.D3 — TypeScript compiles**
```bash
pnpm tsc --noEmit
```
Why this breaks: Any type error in the skeleton propagates to every downstream phase.
- [ ] Zero TypeScript errors

**0.D4 — .object.yaml files parse as valid YAML**
```bash
node -e "
const yaml = require('yaml');
const fs = require('fs');
['workspace/account/.object.yaml', 'workspace/contact/.object.yaml', 'workspace/deal/.object.yaml'].forEach(f => {
  try { yaml.parse(fs.readFileSync(f, 'utf8')); console.log('PASS: ' + f); }
  catch(e) { console.log('FAIL: ' + f + ' — ' + e.message); }
});
"
```
Why this breaks: DenchClaw web UI reads .object.yaml to render sidebar and views. Invalid YAML = invisible objects.
- [ ] All three .object.yaml files parse

**0.D5 — Skill files have valid YAML frontmatter**
```bash
for f in skills/b2b-crm/SKILL.md skills/b2b-crm/deal-pipeline/SKILL.md skills/b2b-crm/search/SKILL.md skills/b2b-crm/activity/SKILL.md; do
  head -1 "$f" | grep -q "^---" && echo "PASS: $f" || echo "FAIL: $f missing frontmatter"
done
```
Why this breaks: DenchClaw skill loader requires YAML frontmatter to register the skill.
- [ ] All skill files have frontmatter

---

## Phase 1 — Account Management

**1.D1 — EAV objects exist in DuckDB**
```bash
# Run from DenchClaw workspace directory
duckdb workspace.duckdb "SELECT name FROM objects WHERE name IN ('account', 'contact', 'deal') ORDER BY name;"
```
Expected: 3 rows (account, contact, deal).
Why this breaks: No objects = no entries, no fields, no PIVOT views, nothing renders.
- [ ] All three objects exist

**1.D2 — Fields are correct count per object**
```bash
duckdb workspace.duckdb "
  SELECT o.name, COUNT(f.id) as field_count
  FROM objects o JOIN fields f ON f.object_id = o.id
  WHERE o.name IN ('account', 'contact', 'deal')
  GROUP BY o.name ORDER BY o.name;
"
```
Expected: account=12, contact=10, deal=10.
Why this breaks: Missing fields mean the agent can't set data. Extra fields create phantom UI columns.
- [ ] Field counts match spec

**1.D3 — Deal pipeline has 6 statuses in correct order**
```bash
duckdb workspace.duckdb "
  SELECT s.name, s.sort_order
  FROM statuses s JOIN objects o ON s.object_id = o.id
  WHERE o.name = 'deal'
  ORDER BY s.sort_order;
"
```
Expected: prospecting(1), qualified(2), proposal(3), negotiation(4), won(5), lost(6).
Why this breaks: Wrong sort order = kanban board shows stages in wrong sequence. Missing stages = deals can't progress.
- [ ] 6 statuses in correct order

**1.D4 — PIVOT views return columns**
```bash
duckdb workspace.duckdb "SELECT column_name FROM information_schema.columns WHERE table_name = 'v_account' ORDER BY ordinal_position;"
duckdb workspace.duckdb "SELECT column_name FROM information_schema.columns WHERE table_name = 'v_contact' ORDER BY ordinal_position;"
duckdb workspace.duckdb "SELECT column_name FROM information_schema.columns WHERE table_name = 'v_deal' ORDER BY ordinal_position;"
```
Expected: Each view has id, created_at, updated_at, status + all object-specific field columns.
Why this breaks: PIVOT views are the agent's primary read interface. Missing columns = agent can't query data.
- [ ] v_account has expected columns
- [ ] v_contact has expected columns
- [ ] v_deal has expected columns

**1.D5 — Standalone tables exist**
```bash
duckdb workspace.duckdb "SELECT table_name FROM information_schema.tables WHERE table_name IN ('line_items', 'transition_history', 'contact_deal_roles', 'stakeholder_edges') ORDER BY table_name;"
```
Expected: 4 rows.
Why this breaks: Line items needed for deal value. Transition history needed for pipeline analytics. Junction table needed for contact roles. Stakeholder edges needed for relationship graph.
- [ ] All four standalone tables exist

**1.D6 — Contact-deal role constraint works**
```bash
duckdb workspace.duckdb "
  INSERT INTO contact_deal_roles VALUES ('test-contact', 'test-deal', 'champion', CURRENT_TIMESTAMP);
  INSERT INTO contact_deal_roles VALUES ('test-contact', 'test-deal', 'invalid_role', CURRENT_TIMESTAMP);
" 2>&1 | grep -q "CHECK" && echo "PASS: constraint rejects invalid role" || echo "FAIL: no constraint"
# Clean up
duckdb workspace.duckdb "DELETE FROM contact_deal_roles WHERE contact_entry_id = 'test-contact';"
```
Why this breaks: Without the CHECK constraint, any string can be a role — breaks the agent's role-based queries.
- [ ] Invalid roles rejected by constraint

**1.D7 — Stakeholder edge constraint works**
```bash
duckdb workspace.duckdb "
  INSERT INTO stakeholder_edges (id, from_contact_id, to_contact_id, relationship_type) VALUES ('test-edge', 'c1', 'c2', 'reports_to');
  INSERT INTO stakeholder_edges (id, from_contact_id, to_contact_id, relationship_type) VALUES ('test-edge2', 'c1', 'c2', 'invalid_type');
" 2>&1 | grep -q "CHECK" && echo "PASS: constraint rejects invalid relationship_type" || echo "FAIL: no constraint"
duckdb workspace.duckdb "DELETE FROM stakeholder_edges WHERE id IN ('test-edge', 'test-edge2');"
```
Why this breaks: Without the CHECK constraint, arbitrary relationship types break graph queries and scoring logic.
- [ ] Invalid relationship types rejected by constraint

**1.D8 — CRUD round-trip works**
```bash
# Insert a test account via EAV, then read it back via PIVOT view
duckdb workspace.duckdb "
  INSERT INTO entries (id, object_id, created_at, updated_at)
  SELECT 'test-acct-001', id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM objects WHERE name = 'account';

  INSERT INTO entry_fields (entry_id, field_id, value)
  SELECT 'test-acct-001', f.id, 'Apex Manufacturing'
  FROM fields f JOIN objects o ON f.object_id = o.id
  WHERE o.name = 'account' AND f.name = 'Company Name';

  SELECT \"Company Name\" FROM v_account WHERE entry_id = 'test-acct-001';
"
# Clean up
duckdb workspace.duckdb "DELETE FROM entry_fields WHERE entry_id = 'test-acct-001'; DELETE FROM entries WHERE id = 'test-acct-001';"
```
Expected: Returns 'Apex Manufacturing' in the "Company Name" column.
Why this breaks: If PIVOT view doesn't reflect EAV writes, the entire data layer is broken.
- [ ] CRUD round-trip returns correct data

---

## Phase 2 — Sync Protocol

**2.D1 — HLC monotonicity**
```bash
pnpm vitest run extensions/b2b-crm/sync.test.ts -t "HLC"
```
Why this breaks: Non-monotonic HLC means clocks go backward, making LWW resolution nondeterministic.
- [ ] HLC tests pass

**2.D2 — CRDT merge determinism**
```bash
pnpm vitest run extensions/b2b-crm/sync.test.ts -t "CRDT"
```
Verify: merge(A, B) === merge(B, A) for all test cases (commutativity).
Why this breaks: If merge is order-dependent, two nodes syncing in different order get different results.
- [ ] CRDT merge is commutative

**2.D3 — Same-field conflict resolves deterministically**
```bash
pnpm vitest run extensions/b2b-crm/sync.test.ts -t "conflict"
```
Scenario: Node A sets phone="111", Node B sets phone="222" — after sync, both have the same value.
Why this breaks: Non-deterministic conflict resolution = data divergence = the core promise of sync is broken.
- [ ] Conflicting same-field edits converge

**2.D4 — Different-field edits auto-merge**
```bash
pnpm vitest run extensions/b2b-crm/sync.test.ts -t "auto-merge"
```
Scenario: Node A sets phone, Node B sets industry — after sync, both values preserved.
Why this breaks: If different-field edits conflict, every concurrent edit becomes a conflict — unusable.
- [ ] Different-field edits preserved

**2.D5 — Queue drain pushes and pulls**
```bash
pnpm vitest run extensions/b2b-crm/sync.test.ts -t "queue"
```
Why this breaks: If queue drain doesn't work, sync never actually happens.
- [ ] Queue drain test passes

**2.D6 — Mock cloud state matches after sync**
```bash
pnpm vitest run extensions/b2b-crm/sync.test.ts -t "convergence"
```
After full push+pull cycle, local sync_state and cloud sync_state should be identical for all shared entries.
Why this breaks: State divergence between local and cloud means the next sync will produce wrong results.
- [ ] Local and cloud converge

**2.D7 — Sync status tool returns correct counts**
```bash
pnpm vitest run extensions/b2b-crm/sync.test.ts -t "sync status"
```
Verify: after queuing 5 items, sync_status returns pending=5. After drain, pending=0 and lastSyncAt is populated.
Why this breaks: If sync status is wrong, the agent gives misleading information about sync state.
- [ ] Sync status test passes

**2.D8 — sync_state and sync_queue tables exist**
```bash
duckdb workspace.duckdb "SELECT table_name FROM information_schema.tables WHERE table_name IN ('sync_state', 'sync_queue') ORDER BY table_name;"
```
Expected: 2 rows.
Why this breaks: Sync tools have nowhere to write.
- [ ] Both sync tables exist

---

## Phase 3 — Schema Evolution

**3.D1 — Schema version table exists**
```bash
duckdb workspace.duckdb "SELECT * FROM b2b_crm_schema_version LIMIT 1;"
```
Why this breaks: Without version tracking, nodes can't detect schema divergence.
- [ ] Schema version table exists

**3.D2 — Field addition syncs correctly**
```bash
pnpm vitest run extensions/b2b-crm/schema-evolution.test.ts -t "field addition"
```
Scenario: Node A adds a custom field to account, syncs to Node B — Node B creates the field.
Why this breaks: If schema changes don't sync, new fields are invisible to other nodes.
- [ ] Field addition syncs

**3.D3 — Unknown fields don't crash sync**
```bash
pnpm vitest run extensions/b2b-crm/schema-evolution.test.ts -t "unknown field"
```
Scenario: Node B receives a field value for a field_id it doesn't have yet — should queue it, not crash.
Why this breaks: One node upgrading before the other would break sync entirely.
- [ ] Unknown fields handled gracefully

**3.D4 — Migration forward-compatibility**
```bash
pnpm vitest run extensions/b2b-crm/schema-evolution.test.ts -t "migration"
```
Why this breaks: If migrations can't apply on a node that already has newer data, upgrade path is broken.
- [ ] Migration tests pass

---

## Phase 4 — Search & Discovery

**4.D1 — FTS index creates without error**
```bash
duckdb workspace.duckdb "INSTALL fts; LOAD fts; SELECT 1;" && echo "PASS" || echo "FAIL"
```
Why this breaks: FTS extension must be installed before creating indexes.
- [x] FTS extension loads

**4.D2 — FTS search returns ranked results**
```bash
pnpm vitest run extensions/b2b-crm/search.test.ts -t "FTS"
```
Why this breaks: If FTS doesn't return results, search is text-matching only (slow at scale).
- [x] FTS search test passes

**4.D3 — Boolean filter produces correct results**
```bash
pnpm vitest run extensions/b2b-crm/search.test.ts -t "filter"
```
Why this breaks: Wrong filter SQL = wrong results = users can't find their data.
- [x] Boolean filter test passes

**4.D4 — Faceted counts match data**
```bash
pnpm vitest run extensions/b2b-crm/search.test.ts -t "facet"
```
Verify: SUM of all facet counts for a field equals total row count (no double-counting).
Why this breaks: Incorrect facets mislead users about data distribution.
- [x] Faceted count test passes

**4.D5 — Intelligence fields are sortable**
```bash
pnpm vitest run extensions/b2b-crm/search.test.ts -t "intelligence sort"
```
Verify: search results can be sorted by engagement_score and neglect_flag columns.
Why this breaks: Case study explicitly requires "stable sort by any column including intelligence fields."
- [x] Sort by intelligence fields works

**4.D6 — Pagination is stable**
```bash
pnpm vitest run extensions/b2b-crm/search.test.ts -t "pagination"
```
Verify: page 1 + page 2 together equal the first 2*pageSize results of an unpaginated query.
Why this breaks: Unstable pagination = duplicate or missing records across pages.
- [x] Pagination test passes

---

## Phase 5 — Activity Intelligence

**5.D1 — Event capture logs to activity_events**
```bash
pnpm vitest run extensions/b2b-crm/activity.test.ts -t "capture"
```
Why this breaks: No events = no intelligence. Everything downstream depends on this.
- [x] Event capture test passes

**5.D2 — Navigation sequences tracked**
```bash
pnpm vitest run extensions/b2b-crm/activity.test.ts -t "navigation"
```
Verify: sequential events within a session have the same session_id and incrementing sequence numbers.
Why this breaks: Without sequences, you can't reconstruct user journeys for pattern analysis.
- [x] Navigation sequence test passes

**5.D3 — Engagement score non-zero for active entities**
```bash
pnpm vitest run extensions/b2b-crm/activity.test.ts -t "scoring"
```
Verify: entity with 10 events in last 7 days has score > 0. Entity with 0 events has score = 0.
Why this breaks: Zero scores for active entities means the scoring formula is broken.
- [x] Engagement scoring test passes

**5.D4 — Neglect detection flags stale accounts**
```bash
pnpm vitest run extensions/b2b-crm/activity.test.ts -t "neglect"
```
Verify: entity with no events in 31 days is flagged. Entity with event yesterday is not.
Why this breaks: False positives or missed neglect flags degrade trust in the intelligence layer.
- [x] Neglect detection test passes

**5.D5 — Anomaly detection catches spikes**
```bash
pnpm vitest run extensions/b2b-crm/activity.test.ts -t "anomaly"
```
Verify: entity with 10x normal activity count triggers z-score > 2.0.
Why this breaks: Missed anomalies = missed sales signals.
- [x] Anomaly detection test passes

**5.D6 — Stakeholder graph scoring works**
```bash
pnpm vitest run extensions/b2b-crm/activity.test.ts -t "stakeholder"
```
Verify: creates stakeholder edges for a deal, getStakeholderMap returns correct graph, influence scoring weights decision_maker > champion > influencer, risk detection flags single-threaded deal (only 1 contact).
Why this breaks: If stakeholder scoring is wrong, the agent misjudges deal risk and gives bad advice about who to engage.
- [x] Stakeholder graph test passes

**5.D7 — Deal momentum scoring works**
```bash
pnpm vitest run extensions/b2b-crm/activity.test.ts -t "momentum"
```
Verify: deal with recent stage transition scores higher momentum than deal stuck in same stage for 2x average. Signal classification: stalling deal correctly flagged vs on_track deal.
Why this breaks: If momentum scoring is wrong, the agent can't distinguish healthy deals from dying ones.
- [x] Deal momentum test passes

**5.D8 — Search intent classification in skill**
Verify: `skills/b2b-crm/activity/SKILL.md` contains SQL patterns for classifying search events by intent.
```bash
grep -q "intent" skills/b2b-crm/activity/SKILL.md && echo "PASS" || echo "FAIL: missing intent classification"
```
Why this breaks: Case study explicitly lists "search intent classification" under Activity Intelligence.
- [x] Skill covers search intent

---

## Phase 6 — Security + Import/Export

**6.D1 — Tenant isolation prevents cross-tenant read**
```bash
pnpm vitest run extensions/b2b-crm/security.test.ts -t "tenant"
```
Verify: TenantContext for tenant_A cannot see data inserted by tenant_B.
Why this breaks: Cross-tenant data leak = security failure = assessment fail.
- [x] Tenant isolation test passes

**6.D2 — PII encryption round-trip**
```bash
pnpm vitest run extensions/b2b-crm/security.test.ts -t "encryption"
```
Verify: encrypt("John") != "John" AND decrypt(encrypt("John")) == "John".
Why this breaks: If encryption doesn't work, PII is stored in plaintext.
- [x] Encryption round-trip test passes

**6.D3 — Audit chain integrity**
```bash
pnpm vitest run extensions/b2b-crm/security.test.ts -t "audit"
```
Verify: 10 entries → verifyAuditChain() returns valid. Tamper one entry → returns invalid with correct index.
Why this breaks: If tampering goes undetected, the audit trail is theater.
- [x] Audit chain test passes

**6.D4 — Clean CSV imports successfully**
```bash
pnpm vitest run extensions/b2b-crm/import.test.ts -t "clean"
```
Why this breaks: If even clean CSVs fail, the feature is broken.
- [x] Clean CSV import passes

**6.D5 — Adversarial CSV skips bad rows, imports good ones**
```bash
pnpm vitest run extensions/b2b-crm/import.test.ts -t "adversarial"
```
Verify: 100 rows, 3 bad → imported=97, errors=3, each error has row number + reason.
Why this breaks: All-or-nothing import is unacceptable. Row-level error logging is required.
- [x] Adversarial CSV test passes

**6.D6 — Encoding edge cases handled**
```bash
pnpm vitest run extensions/b2b-crm/import.test.ts -t "encoding"
```
Verify: ISO-8859-1 CSV with accented characters imports correctly as UTF-8.
Why this breaks: Excel exports from non-English locales are often ISO-8859-1 or Windows-1252.
- [x] Encoding test passes

**6.D7 — Deduplication works**
```bash
pnpm vitest run extensions/b2b-crm/import.test.ts -t "dedup"
```
Verify: importing 50 accounts where 10 have domains already in DB → 40 imported, 10 flagged.
Why this breaks: Duplicate imports create data quality nightmares.
- [x] Dedup test passes

**6.D8 — CSV export produces valid CSV**
```bash
pnpm vitest run extensions/b2b-crm/import.test.ts -t "export"
```
Verify: exported CSV has correct header row, values match DB, commas/quotes properly escaped.
Why this breaks: If export is malformed, downstream tools can't read it.
- [x] Export test passes

---

## Phase 7 — Integration + Testing + Polish

**7.D1 — Full test suite passes**
```bash
pnpm vitest run
```
Expected: 0 failures across all test files.
Why this breaks: Any failure means a regression was introduced during integration.
- [x] All tests pass (146 tests, 10 files, 0 failures)

**7.D2 — TypeScript compiles clean**
```bash
pnpm tsc --noEmit
```
Why this breaks: Type errors in production code mean runtime crashes.
- [x] Zero TypeScript errors (b2b-crm extension)

**7.D3 — Lint passes**
```bash
pnpm oxlint
```
Why this breaks: Lint errors indicate code quality issues. Assessors will notice.
- [x] Zero lint errors (0 warnings, 0 errors)

**7.D4 — Build succeeds**
```bash
pnpm tsdown
```
Why this breaks: If it doesn't build, it doesn't ship.
- [x] Build succeeds

**7.D5 — Extension loads in DenchClaw**
```bash
openclaw --profile dench
# Check extension loaded in gateway logs
```
Why this breaks: The deliverable is a DenchClaw extension. If it doesn't load, nothing else matters.
- [ ] MANUAL CHECK REQUIRED: run `openclaw --profile dench`, verify `[b2b-crm] Schema initialized` in logs

**7.D6 — README covers all required sections**
```bash
for section in "setup" "implemented" "designed-only" "exercise" "tests" "limitations"; do
  grep -qi "$section" extensions/b2b-crm/README.md && echo "PASS: $section" || echo "FAIL: missing $section"
done
```
Why this breaks: Case study explicitly requires: "setup instructions, what's implemented vs. designed-only, how to exercise each feature, how to run tests, known limitations."
- [x] README has all required sections (all 6 PASS)

**7.D7 — 10K synthetic accounts queryable**
```bash
duckdb workspace.duckdb "SELECT COUNT(*) FROM v_account;"
```
Expected: >= 10000.
Why this breaks: Case study says "search across 10K+ records." They will test this.
- [x] 10K+ accounts seeded in workspace.duckdb (confirmed: 10000 rows via programmatic query)

**7.D8 — End-to-end: create account via agent**
Manual check — use DenchClaw chat to say "Create an account for Apex Manufacturing in the energy sector with 500 employees":
1. Account appears in v_account
2. Activity event logged
3. Account searchable via FTS
Why this breaks: This is the golden path they'll test first.
- [ ] MANUAL CHECK REQUIRED: verify via DenchClaw chat

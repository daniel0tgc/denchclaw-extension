/**
 * Auto-merge duplicate `people` entries by normalized email or phone key.
 *
 * Why this exists:
 *
 *   The Gmail/Calendar sync paths already dedupe in-memory via a
 *   `normalizeEmailKey -> entry_id` map preloaded from DuckDB
 *   (see `gmail-sync.ts#buildCacheFromDb` and `ensurePerson`). That works
 *   while a single sync run is in flight, but if the DB *already* contains
 *   duplicate rows — from an interrupted backfill, a process crash, a
 *   future manual import, or an Apollo enrichment pass — the cache
 *   silently picks one entry_id per key and orphans the others. The
 *   orphans then keep showing up in the People list and the Team tab on
 *   the Company profile (the Kubeace duplicate-`dileep@kubeace.com` bug).
 *
 * What this does:
 *
 *   1. `findDuplicateGroups()` scans every `people` entry, computes a
 *      normalized key per row (`email:<...>` and/or `phone:<...>`), and
 *      uses union-find to collapse rows that share *any* key into a
 *      single connected component. So if A↔B by email and B↔C by phone,
 *      all three end up in the same group.
 *
 *   2. `mergeDuplicatePeople()` picks a canonical winner per group
 *      (oldest `entries.created_at`, tie-break by id), copies the loser's
 *      missing scalar fields onto the canonical, rewrites every
 *      `relation` reference to the loser across all 7 known
 *      people-relation fields (`email_thread.Participants`,
 *      `email_message.From|To|Cc`, `calendar_event.Organizer|Attendees`,
 *      `interaction.Person`), and finally hard-deletes the loser entry +
 *      its `entry_fields` rows.
 *
 * Field-combine rule:
 *
 *   For each loser scalar field, copy to canonical *only if the canonical
 *   doesn't already have a value for that field*. Existing canonical
 *   values win. We don't trust the loser to be more correct because the
 *   canonical is the older row and has accumulated more user signals.
 *
 *   Strength Score will be re-aggregated by the sync-runner's call to
 *   `recomputeAllScores()` immediately after merging, so the canonical's
 *   stale score is replaced with one computed from the union of
 *   interactions across canonical + (now-remapped) losers.
 */

import {
  duckdbExecOnFileAsync,
  duckdbPathAsync,
  duckdbQueryAsync,
  parseRelationValue,
} from "./workspace";
import {
  ONBOARDING_OBJECT_IDS,
} from "./workspace-schema-migrations";
import { loadCrmFieldMaps } from "./crm-queries";
import { normalizeEmailKey } from "./email-domain";
import { normalizePhoneKey } from "./phone-normalize";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DuplicateGroup = {
  /** First key encountered for this group, used for logging only. */
  representativeKey: string;
  /** All normalized keys associated with this group (email:* and/or phone:*). */
  keys: string[];
  /** Canonical winner — kept after merge. */
  canonicalId: string;
  /** Losers — fields copied onto canonical, then deleted. */
  loserIds: string[];
};

export type PersonMergeReport = {
  /** Number of duplicate groups (>1 entries sharing keys). */
  groupsFound: number;
  /** Total loser entries deleted across all groups. */
  rowsMerged: number;
  /** entry_fields rows copied from a loser onto its canonical. */
  fieldsCopied: number;
  /** entry_fields relation rows remapped from loser → canonical. */
  relationsRemapped: number;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
};

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Union-find for transitive grouping
// ---------------------------------------------------------------------------

class UnionFind {
  private parent = new Map<string, string>();

  find(x: string): string {
    let cur = x;
    while (this.parent.has(cur)) {
      const p = this.parent.get(cur);
      if (!p || p === cur) {break;}
      cur = p;
    }
    // Path compression — flatten so future lookups are O(1).
    let walk = x;
    while (this.parent.has(walk)) {
      const p = this.parent.get(walk);
      if (!p || p === walk) {break;}
      this.parent.set(walk, cur);
      walk = p;
    }
    return cur;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) {return;}
    this.parent.set(rb, ra);
  }

  /** Ensure `x` is in the structure even if it has no peers. */
  add(x: string): void {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
    }
  }
}

// ---------------------------------------------------------------------------
// Group discovery
// ---------------------------------------------------------------------------

type PersonRow = {
  entry_id: string;
  created_at: string | null;
  email: string | null;
  phone: string | null;
};

/**
 * Scan all `people` entries and compute their normalized email + phone keys.
 * Group by union-find so transitive matches collapse to one component.
 *
 * Returns an empty array when there are no duplicates — the sync runner can
 * skip the (slightly expensive) merge SQL entirely.
 */
export async function findDuplicateGroups(): Promise<DuplicateGroup[]> {
  const fieldMaps = await loadCrmFieldMaps();
  const emailFieldId = fieldMaps.people["Email Address"];
  const phoneFieldId = fieldMaps.people["Phone Number"];

  // If neither field is in the workspace yet (fresh / un-migrated DB),
  // there's nothing to merge.
  if (!emailFieldId && !phoneFieldId) {return [];}

  const peopleObjectId = ONBOARDING_OBJECT_IDS.people;
  const emailExpr = emailFieldId
    ? `MAX(CASE WHEN ef.field_id = ${sqlString(emailFieldId)} THEN ef.value END)`
    : `NULL`;
  const phoneExpr = phoneFieldId
    ? `MAX(CASE WHEN ef.field_id = ${sqlString(phoneFieldId)} THEN ef.value END)`
    : `NULL`;

  const sql = `
    SELECT
      e.id AS entry_id,
      CAST(e.created_at AS VARCHAR) AS created_at,
      ${emailExpr} AS email,
      ${phoneExpr} AS phone
    FROM entries e
    LEFT JOIN entry_fields ef ON ef.entry_id = e.id
    WHERE e.object_id = ${sqlString(peopleObjectId)}
    GROUP BY e.id, e.created_at
    ORDER BY e.created_at ASC, e.id ASC;
  `;

  const rows = await duckdbQueryAsync<PersonRow>(sql);
  if (rows.length === 0) {return [];}

  // Build (entry_id -> rowMeta) and (key -> [entry_ids]) maps.
  const meta = new Map<string, { createdAt: string | null }>();
  const keyToIds = new Map<string, string[]>();
  for (const row of rows) {
    meta.set(row.entry_id, { createdAt: row.created_at });
    const keys: string[] = [];
    const emailKey = normalizeEmailKey(row.email);
    if (emailKey) {keys.push(`email:${emailKey}`);}
    const phoneKey = normalizePhoneKey(row.phone);
    if (phoneKey) {keys.push(`phone:${phoneKey}`);}
    for (const key of keys) {
      let bucket = keyToIds.get(key);
      if (!bucket) {
        bucket = [];
        keyToIds.set(key, bucket);
      }
      bucket.push(row.entry_id);
    }
  }

  // Union all entries that share any key.
  const uf = new UnionFind();
  const idToKeys = new Map<string, string[]>();
  for (const [key, ids] of keyToIds) {
    if (ids.length < 2) {continue;}
    const root = ids[0];
    uf.add(root);
    for (const id of ids) {
      uf.add(id);
      uf.union(root, id);
      let kbucket = idToKeys.get(id);
      if (!kbucket) {
        kbucket = [];
        idToKeys.set(id, kbucket);
      }
      if (!kbucket.includes(key)) {kbucket.push(key);}
    }
  }

  // Bucket entries by their union-find root.
  const groupsByRoot = new Map<string, string[]>();
  for (const id of idToKeys.keys()) {
    const root = uf.find(id);
    let bucket = groupsByRoot.get(root);
    if (!bucket) {
      bucket = [];
      groupsByRoot.set(root, bucket);
    }
    bucket.push(id);
  }

  const groups: DuplicateGroup[] = [];
  for (const ids of groupsByRoot.values()) {
    if (ids.length < 2) {continue;}
    // Pick canonical: earliest created_at, tie-break by id ascending.
    const sorted = [...ids].sort((a, b) => {
      const aMeta = meta.get(a);
      const bMeta = meta.get(b);
      const aTs = aMeta?.createdAt ?? "";
      const bTs = bMeta?.createdAt ?? "";
      if (aTs !== bTs) {return aTs < bTs ? -1 : 1;}
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const canonicalId = sorted[0];
    const loserIds = sorted.slice(1);
    const allKeys = new Set<string>();
    for (const id of ids) {
      for (const key of idToKeys.get(id) ?? []) {allKeys.add(key);}
    }
    groups.push({
      representativeKey: idToKeys.get(canonicalId)?.[0] ?? Array.from(allKeys)[0] ?? "",
      keys: Array.from(allKeys),
      canonicalId,
      loserIds,
    });
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Relation-field metadata
// ---------------------------------------------------------------------------

type PeopleRelationField = {
  /** field_id on the related object (e.g. email_message.From's field id). */
  fieldId: string;
  /** "many_to_one" stores a single id; "many_to_many" stores a JSON array. */
  cardinality: "many_to_one" | "many_to_many";
  /** Human-readable label, used for logging only. */
  label: string;
};

/**
 * Gather every field that holds a relation TO `people`. These are the rows
 * we need to rewrite when a loser is deleted so dangling FKs don't appear.
 *
 * Looked up dynamically via `loadCrmFieldMaps` so a fresh workspace whose
 * schema is mid-migration doesn't crash on a missing field.
 */
async function collectPeopleRelationFields(): Promise<PeopleRelationField[]> {
  const fm = await loadCrmFieldMaps();
  const out: PeopleRelationField[] = [];
  const push = (
    fieldId: string | undefined,
    cardinality: PeopleRelationField["cardinality"],
    label: string,
  ): void => {
    if (fieldId) {out.push({ fieldId, cardinality, label });}
  };

  push(fm.email_thread["Participants"], "many_to_many", "email_thread.Participants");
  push(fm.email_message["From"], "many_to_one", "email_message.From");
  push(fm.email_message["To"], "many_to_many", "email_message.To");
  push(fm.email_message["Cc"], "many_to_many", "email_message.Cc");
  push(fm.calendar_event["Organizer"], "many_to_one", "calendar_event.Organizer");
  push(fm.calendar_event["Attendees"], "many_to_many", "calendar_event.Attendees");
  push(fm.interaction["Person"], "many_to_one", "interaction.Person");

  return out;
}

// ---------------------------------------------------------------------------
// Merge a single (canonical, loser) pair
// ---------------------------------------------------------------------------

type MergePairCounters = {
  fieldsCopied: number;
  relationsRemapped: number;
};

/**
 * Build the SQL needed to merge one loser into its canonical winner.
 * Returns the assembled statements plus counters that the caller folds
 * into the per-run report. Does NOT execute anything — the caller batches
 * many pairs and commits once per workspace DB.
 *
 * `canonicalFieldIds` is shared mutable state across all pairs in a group:
 * the caller seeds it with the canonical's *current* field ids, and this
 * function adds entries for every field it queues an INSERT for. Without
 * that reservation, two losers in the same group that both supply a field
 * the canonical lacks would each queue an INSERT, blowing the
 * `UNIQUE(entry_id, field_id)` constraint when the batch executes.
 */
async function planMergePair(params: {
  canonicalId: string;
  loserId: string;
  relationFields: PeopleRelationField[];
  canonicalFieldIds: Set<string>;
}): Promise<{ statements: string[]; counters: MergePairCounters }> {
  const { canonicalId, loserId, relationFields, canonicalFieldIds } = params;
  const statements: string[] = [];
  const counters: MergePairCounters = { fieldsCopied: 0, relationsRemapped: 0 };

  // ── 1. Copy loser's missing scalar fields onto the canonical ─────────
  const loserFields = await duckdbQueryAsync<{ field_id: string; value: string | null }>(
    `SELECT field_id, value FROM entry_fields WHERE entry_id = ${sqlString(loserId)};`,
  );

  for (const row of loserFields) {
    if (canonicalFieldIds.has(row.field_id)) {continue;}
    if (row.value === null) {continue;}
    statements.push(
      `INSERT INTO entry_fields (entry_id, field_id, value) VALUES (${sqlString(
        canonicalId,
      )}, ${sqlString(row.field_id)}, ${sqlString(row.value)});`,
    );
    counters.fieldsCopied += 1;
    // Reserve so a later loser in the same group doesn't try to re-copy.
    canonicalFieldIds.add(row.field_id);
  }

  // ── 2. Remap relation FKs ────────────────────────────────────────────
  if (relationFields.length > 0) {
    // many_to_one: a simple UPDATE per field.
    const m2oFieldIds = relationFields
      .filter((f) => f.cardinality === "many_to_one")
      .map((f) => f.fieldId);
    if (m2oFieldIds.length > 0) {
      const inList = m2oFieldIds.map(sqlString).join(", ");
      // Count first so the report is accurate; UPDATE returns affected
      // rows but the duckdb CLI doesn't surface that in our exec helper.
      const m2oCountRows = await duckdbQueryAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM entry_fields WHERE field_id IN (${inList}) AND value = ${sqlString(
          loserId,
        )};`,
      );
      const m2oCount = Number(m2oCountRows[0]?.n ?? 0);
      if (m2oCount > 0) {
        statements.push(
          `UPDATE entry_fields SET value = ${sqlString(
            canonicalId,
          )} WHERE field_id IN (${inList}) AND value = ${sqlString(loserId)};`,
        );
        counters.relationsRemapped += m2oCount;
      }
    }

    // many_to_many: parse JSON, replace loser with canonical, dedupe, write back.
    // We do per-row UPDATEs because each row's array is unique. The LIKE
    // predicate is good enough — the values are quoted UUIDs so no false
    // positives in practice.
    const m2mFieldIds = relationFields
      .filter((f) => f.cardinality === "many_to_many")
      .map((f) => f.fieldId);
    if (m2mFieldIds.length > 0) {
      const inList = m2mFieldIds.map(sqlString).join(", ");
      const safeLoserForLike = loserId.replace(/'/g, "''");
      const m2mRows = await duckdbQueryAsync<{
        id: string;
        value: string;
      }>(
        `SELECT id, value FROM entry_fields WHERE field_id IN (${inList}) AND value LIKE '%"${safeLoserForLike}"%';`,
      );
      for (const row of m2mRows) {
        const ids = parseRelationValue(row.value);
        const replaced = ids.map((id) => (id === loserId ? canonicalId : id));
        // Dedupe while preserving order of first occurrence.
        const seen = new Set<string>();
        const compact: string[] = [];
        for (const id of replaced) {
          if (id && !seen.has(id)) {
            seen.add(id);
            compact.push(id);
          }
        }
        const newValue = JSON.stringify(compact);
        statements.push(
          `UPDATE entry_fields SET value = ${sqlString(newValue)} WHERE id = ${sqlString(row.id)};`,
        );
        counters.relationsRemapped += 1;
      }
    }
  }

  // ── 3. Delete the loser ──────────────────────────────────────────────
  // CHECKPOINT between the two DELETEs is required: DuckDB's foreign-key
  // enforcement (entries.id ← entry_fields.entry_id) reads from a stale
  // index when both deletes happen back-to-back in the same connection,
  // so the second DELETE bails with "still referenced by a foreign key in
  // a different table" even though the first DELETE just emptied the
  // referencing rows. CHECKPOINT flushes the index. We deliberately do
  // *not* wrap the merge in BEGIN TRANSACTION / COMMIT — DuckDB rejects
  // CHECKPOINT inside a transaction ("transaction has transaction local
  // changes") and its FK check appears even more permissive at the
  // batch level than per-statement, so the auto-commit-per-statement
  // mode is the path that actually works. Each statement is individually
  // idempotent (and a re-run of `mergeDuplicatePeople` recovers any
  // partial mid-batch failure), so we don't lose much by skipping the
  // explicit transaction.
  statements.push(`DELETE FROM entry_fields WHERE entry_id = ${sqlString(loserId)};`);
  statements.push(`CHECKPOINT;`);
  statements.push(`DELETE FROM entries WHERE id = ${sqlString(loserId)};`);

  return { statements, counters };
}

// ---------------------------------------------------------------------------
// Public: run the full merge pass
// ---------------------------------------------------------------------------

/**
 * Find and merge every duplicate-people group in the active workspace's
 * DuckDB. Idempotent: running twice in a row reports `rowsMerged: 0` on
 * the second run because the first run consolidated everything.
 *
 * Designed to be cheap when there's nothing to do: a single GROUP BY
 * scan of `entries × entry_fields` for the people object. Only runs the
 * (more expensive) per-pair merge SQL when actual duplicates exist.
 */
export async function mergeDuplicatePeople(): Promise<PersonMergeReport> {
  const startedAt = Date.now();
  const empty: PersonMergeReport = {
    groupsFound: 0,
    rowsMerged: 0,
    fieldsCopied: 0,
    relationsRemapped: 0,
    durationMs: 0,
  };

  const dbPath = await duckdbPathAsync();
  if (!dbPath) {
    return { ...empty, durationMs: Date.now() - startedAt };
  }

  const groups = await findDuplicateGroups();
  if (groups.length === 0) {
    return { ...empty, durationMs: Date.now() - startedAt };
  }

  const relationFields = await collectPeopleRelationFields();

  let totalFieldsCopied = 0;
  let totalRelationsRemapped = 0;
  let totalRowsMerged = 0;

  for (const group of groups) {
    // Read the canonical's current field ids ONCE per group, then thread
    // the same Set through every per-loser plan. This prevents two losers
    // that each supply the same field (e.g. both have a Phone Number the
    // canonical lacks) from both queuing INSERTs and tripping
    // `UNIQUE(entry_id, field_id)` when the batch executes.
    const canonicalFieldIdsRows = await duckdbQueryAsync<{ field_id: string }>(
      `SELECT field_id FROM entry_fields WHERE entry_id = ${sqlString(group.canonicalId)};`,
    );
    const canonicalFieldIds = new Set(canonicalFieldIdsRows.map((r) => r.field_id));

    // Run all statements for the group in one stdin pipe so DuckDB
    // executes them sequentially in a single CLI process. We don't wrap
    // in BEGIN/COMMIT (see `planMergePair` for why DuckDB's FK check
    // forces us into auto-commit). Each statement is individually
    // idempotent — a partial mid-batch failure is recovered by the next
    // call to `mergeDuplicatePeople`.
    const groupStatements: string[] = [];
    for (const loserId of group.loserIds) {
      const { statements, counters } = await planMergePair({
        canonicalId: group.canonicalId,
        loserId,
        relationFields,
        canonicalFieldIds,
      });
      groupStatements.push(...statements);
      totalFieldsCopied += counters.fieldsCopied;
      totalRelationsRemapped += counters.relationsRemapped;
    }

    const ok = await duckdbExecOnFileAsync(dbPath, groupStatements.join("\n"));
    if (!ok) {
      // Don't throw — keep going so one bad group doesn't block the rest
      // of a sync run from completing. Surface to stderr for triage.
      console.error(
        `[people-merge] failed to merge group with canonical=${group.canonicalId}, ` +
          `losers=[${group.loserIds.join(",")}], keys=[${group.keys.join(",")}]`,
      );
      continue;
    }
    totalRowsMerged += group.loserIds.length;
  }

  return {
    groupsFound: groups.length,
    rowsMerged: totalRowsMerged,
    fieldsCopied: totalFieldsCopied,
    relationsRemapped: totalRelationsRemapped,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Idempotent DuckDB schema migrations for the Gmail/Calendar onboarding.
 *
 * Reads existing rows from `objects` and `fields` and adds anything missing
 * — never drops or rewrites user-curated rows. Safe to call on first init
 * or on every web-app startup.
 *
 * For brand-new workspaces, `assets/seed/schema.sql` already includes the
 * full schema; this module exists for the (large) population of existing
 * `workspace.duckdb` files that pre-date the onboarding feature.
 */

import {
  duckdbExecAsync,
  duckdbExecOnFileAsync,
  duckdbQueryAsync,
  duckdbPathAsync,
} from "./workspace";

// ---------------------------------------------------------------------------
// Object IDs (seed_*) — must stay stable so re-runs are idempotent.
// ---------------------------------------------------------------------------

const PEOPLE_OBJECT_ID = "seed_obj_people_00000000000000";
const COMPANY_OBJECT_ID = "seed_obj_company_0000000000000";
const EMAIL_THREAD_OBJECT_ID = "seed_obj_email_thread_000000000";
const EMAIL_MESSAGE_OBJECT_ID = "seed_obj_email_message_00000000";
const CALENDAR_EVENT_OBJECT_ID = "seed_obj_calendar_event_0000000";
const INTERACTION_OBJECT_ID = "seed_obj_interaction_00000000000";

const SOURCE_ENUM_VALUES = '["Manual","Gmail","Calendar"]';
const SOURCE_ENUM_COLORS = '["#94a3b8","#ef4444","#3b82f6"]';

const SENDER_TYPE_ENUM_VALUES =
  '["Person","Marketing","Transactional","Notification","Mailing List","Automated"]';
const SENDER_TYPE_ENUM_COLORS =
  '["#22c55e","#ef4444","#3b82f6","#f59e0b","#8b5cf6","#94a3b8"]';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FieldDef = {
  /** 32-char-ish stable ID, padded to fit existing seed_fld_* convention. */
  id: string;
  name: string;
  type:
    | "text"
    | "email"
    | "phone"
    | "url"
    | "richtext"
    | "number"
    | "date"
    | "boolean"
    | "enum"
    | "relation";
  required?: boolean;
  enumValues?: string;
  enumColors?: string;
  enumMultiple?: boolean;
  relatedObjectId?: string;
  relationshipType?: "many_to_one" | "many_to_many";
  sortOrder: number;
};

type ObjectDef = {
  id: string;
  name: string;
  description: string;
  icon: string;
  defaultView: "table" | "kanban" | "calendar" | "timeline" | "gallery" | "list";
  immutable?: boolean;
  sortOrder: number;
  fields: FieldDef[];
};

export type MigrationResult = {
  ok: boolean;
  workspaceDb: string | null;
  changedObjects: string[];
  addedFields: Array<{ object: string; field: string }>;
  recreatedViews: string[];
  error?: string;
};

// ---------------------------------------------------------------------------
// Field definitions — additions to existing objects
// ---------------------------------------------------------------------------

const PEOPLE_NEW_FIELDS: FieldDef[] = [
  {
    id: "seed_fld_people_source_00000000",
    name: "Source",
    type: "enum",
    enumValues: SOURCE_ENUM_VALUES,
    enumColors: SOURCE_ENUM_COLORS,
    sortOrder: 10,
  },
  {
    id: "seed_fld_people_strength_000000",
    name: "Strength Score",
    type: "number",
    sortOrder: 11,
  },
  {
    id: "seed_fld_people_lastinter_00000",
    name: "Last Interaction At",
    type: "date",
    sortOrder: 12,
  },
  {
    id: "seed_fld_people_jobtitle_000000",
    name: "Job Title",
    type: "text",
    sortOrder: 13,
  },
  {
    id: "seed_fld_people_linkedin_000000",
    name: "LinkedIn URL",
    type: "url",
    sortOrder: 14,
  },
  {
    id: "seed_fld_people_avatar_url_0000",
    name: "Avatar URL",
    type: "url",
    sortOrder: 15,
  },
];

const COMPANY_NEW_FIELDS: FieldDef[] = [
  {
    id: "seed_fld_company_source_0000000",
    name: "Source",
    type: "enum",
    enumValues: SOURCE_ENUM_VALUES,
    enumColors: SOURCE_ENUM_COLORS,
    sortOrder: 10,
  },
  {
    id: "seed_fld_company_domain_0000000",
    name: "Domain",
    type: "text",
    sortOrder: 11,
  },
  {
    id: "seed_fld_company_strength_00000",
    name: "Strength Score",
    type: "number",
    sortOrder: 12,
  },
  {
    id: "seed_fld_company_lastinter_0000",
    name: "Last Interaction At",
    type: "date",
    sortOrder: 13,
  },
];

// ---------------------------------------------------------------------------
// Object definitions — wholesale new tables
// ---------------------------------------------------------------------------

const NEW_OBJECTS: ObjectDef[] = [
  {
    id: EMAIL_THREAD_OBJECT_ID,
    name: "email_thread",
    description: "Email thread synced from Gmail",
    icon: "messages-square",
    defaultView: "table",
    immutable: true,
    sortOrder: 10,
    fields: [
      {
        id: "seed_fld_emthread_subject_0000",
        name: "Subject",
        type: "text",
        required: true,
        sortOrder: 0,
      },
      {
        id: "seed_fld_emthread_lastat_00000",
        name: "Last Message At",
        type: "date",
        sortOrder: 1,
      },
      {
        id: "seed_fld_emthread_count_000000",
        name: "Message Count",
        type: "number",
        sortOrder: 2,
      },
      {
        id: "seed_fld_emthread_people_00000",
        name: "Participants",
        type: "relation",
        relatedObjectId: PEOPLE_OBJECT_ID,
        relationshipType: "many_to_many",
        sortOrder: 3,
      },
      {
        id: "seed_fld_emthread_company_0000",
        name: "Companies",
        type: "relation",
        relatedObjectId: COMPANY_OBJECT_ID,
        relationshipType: "many_to_many",
        sortOrder: 4,
      },
      {
        id: "seed_fld_emthread_threadid_000",
        name: "Gmail Thread ID",
        type: "text",
        required: true,
        sortOrder: 5,
      },
    ],
  },
  {
    id: EMAIL_MESSAGE_OBJECT_ID,
    name: "email_message",
    description: "Single email message synced from Gmail",
    icon: "mail",
    defaultView: "table",
    immutable: true,
    sortOrder: 11,
    fields: [
      {
        id: "seed_fld_emmsg_subject_0000000",
        name: "Subject",
        type: "text",
        sortOrder: 0,
      },
      {
        id: "seed_fld_emmsg_sentat_000000000",
        name: "Sent At",
        type: "date",
        sortOrder: 1,
      },
      {
        id: "seed_fld_emmsg_from_00000000000",
        name: "From",
        type: "relation",
        relatedObjectId: PEOPLE_OBJECT_ID,
        relationshipType: "many_to_one",
        sortOrder: 2,
      },
      {
        id: "seed_fld_emmsg_to_0000000000000",
        name: "To",
        type: "relation",
        relatedObjectId: PEOPLE_OBJECT_ID,
        relationshipType: "many_to_many",
        sortOrder: 3,
      },
      {
        id: "seed_fld_emmsg_cc_0000000000000",
        name: "Cc",
        type: "relation",
        relatedObjectId: PEOPLE_OBJECT_ID,
        relationshipType: "many_to_many",
        sortOrder: 4,
      },
      {
        id: "seed_fld_emmsg_thread_000000000",
        name: "Thread",
        type: "relation",
        relatedObjectId: EMAIL_THREAD_OBJECT_ID,
        relationshipType: "many_to_one",
        sortOrder: 5,
      },
      {
        id: "seed_fld_emmsg_preview_00000000",
        name: "Body Preview",
        type: "text",
        sortOrder: 6,
      },
      {
        id: "seed_fld_emmsg_body_00000000000",
        name: "Body",
        type: "richtext",
        sortOrder: 7,
      },
      {
        id: "seed_fld_emmsg_attach_0000000000",
        name: "Has Attachments",
        type: "boolean",
        sortOrder: 8,
      },
      {
        id: "seed_fld_emmsg_msgid_0000000000",
        name: "Gmail Message ID",
        type: "text",
        required: true,
        sortOrder: 9,
      },
      {
        id: "seed_fld_emmsg_sndtype_00000000",
        name: "Sender Type",
        type: "enum",
        enumValues: SENDER_TYPE_ENUM_VALUES,
        enumColors: SENDER_TYPE_ENUM_COLORS,
        sortOrder: 10,
      },
    ],
  },
  {
    id: CALENDAR_EVENT_OBJECT_ID,
    name: "calendar_event",
    description: "Calendar event synced from Google Calendar",
    icon: "calendar",
    defaultView: "calendar",
    immutable: true,
    sortOrder: 12,
    fields: [
      {
        id: "seed_fld_calev_title_0000000000",
        name: "Title",
        type: "text",
        required: true,
        sortOrder: 0,
      },
      {
        id: "seed_fld_calev_start_0000000000",
        name: "Start At",
        type: "date",
        required: true,
        sortOrder: 1,
      },
      {
        id: "seed_fld_calev_end_000000000000",
        name: "End At",
        type: "date",
        sortOrder: 2,
      },
      {
        id: "seed_fld_calev_organ_0000000000",
        name: "Organizer",
        type: "relation",
        relatedObjectId: PEOPLE_OBJECT_ID,
        relationshipType: "many_to_one",
        sortOrder: 3,
      },
      {
        id: "seed_fld_calev_attend_000000000",
        name: "Attendees",
        type: "relation",
        relatedObjectId: PEOPLE_OBJECT_ID,
        relationshipType: "many_to_many",
        sortOrder: 4,
      },
      {
        id: "seed_fld_calev_company_00000000",
        name: "Companies",
        type: "relation",
        relatedObjectId: COMPANY_OBJECT_ID,
        relationshipType: "many_to_many",
        sortOrder: 5,
      },
      {
        id: "seed_fld_calev_meettype_0000000",
        name: "Meeting Type",
        type: "enum",
        enumValues: '["One on One","Small Group","Large Group"]',
        enumColors: '["#22c55e","#3b82f6","#94a3b8"]',
        sortOrder: 6,
      },
      {
        id: "seed_fld_calev_eventid_00000000",
        name: "Google Event ID",
        type: "text",
        required: true,
        sortOrder: 7,
      },
    ],
  },
  {
    id: INTERACTION_OBJECT_ID,
    name: "interaction",
    description: "Email or meeting between you and a contact (used for ranking)",
    icon: "activity",
    defaultView: "timeline",
    immutable: true,
    sortOrder: 13,
    fields: [
      {
        id: "seed_fld_inter_type_00000000000",
        name: "Type",
        type: "enum",
        enumValues: '["Email","Meeting"]',
        enumColors: '["#3b82f6","#22c55e"]',
        sortOrder: 0,
      },
      {
        id: "seed_fld_inter_occurred_0000000",
        name: "Occurred At",
        type: "date",
        required: true,
        sortOrder: 1,
      },
      {
        id: "seed_fld_inter_person_000000000",
        name: "Person",
        type: "relation",
        relatedObjectId: PEOPLE_OBJECT_ID,
        relationshipType: "many_to_one",
        sortOrder: 2,
      },
      {
        id: "seed_fld_inter_company_00000000",
        name: "Company",
        type: "relation",
        relatedObjectId: COMPANY_OBJECT_ID,
        relationshipType: "many_to_one",
        sortOrder: 3,
      },
      {
        id: "seed_fld_inter_email_0000000000",
        name: "Email",
        type: "relation",
        relatedObjectId: EMAIL_MESSAGE_OBJECT_ID,
        relationshipType: "many_to_one",
        sortOrder: 4,
      },
      {
        id: "seed_fld_inter_event_0000000000",
        name: "Event",
        type: "relation",
        relatedObjectId: CALENDAR_EVENT_OBJECT_ID,
        relationshipType: "many_to_one",
        sortOrder: 5,
      },
      {
        id: "seed_fld_inter_direction_000000",
        name: "Direction",
        type: "enum",
        enumValues: '["Sent","Received","Internal"]',
        enumColors: '["#22c55e","#3b82f6","#94a3b8"]',
        sortOrder: 6,
      },
      {
        id: "seed_fld_inter_score_0000000000",
        name: "Score Contribution",
        type: "number",
        sortOrder: 7,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

function escSql(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) {return "NULL";}
  if (typeof value === "boolean") {return value ? "true" : "false";}
  if (typeof value === "number") {return String(value);}
  return `'${value.replace(/'/g, "''")}'`;
}

function buildFieldInsertSql(objectId: string, def: FieldDef): string {
  const parts = [
    escSql(def.id),
    escSql(objectId),
    escSql(def.name),
    escSql(def.type),
    def.required === true ? "true" : "false",
    def.relatedObjectId ? escSql(def.relatedObjectId) : "NULL",
    def.relationshipType ? escSql(def.relationshipType) : "NULL",
    def.enumValues ? `${escSql(def.enumValues)}::JSON` : "NULL",
    def.enumColors ? `${escSql(def.enumColors)}::JSON` : "NULL",
    def.enumMultiple === true ? "true" : "false",
    String(def.sortOrder),
  ].join(", ");

  return `INSERT INTO fields (id, object_id, name, type, required, related_object_id, relationship_type, enum_values, enum_colors, enum_multiple, sort_order) VALUES (${parts});`;
}

function buildObjectInsertSql(def: ObjectDef): string {
  const parts = [
    escSql(def.id),
    escSql(def.name),
    escSql(def.description),
    escSql(def.icon),
    escSql(def.defaultView),
    def.immutable === true ? "true" : "false",
    String(def.sortOrder),
  ].join(", ");

  return `INSERT INTO objects (id, name, description, icon, default_view, immutable, sort_order) VALUES (${parts});`;
}

function buildPivotViewSql(viewName: string, objectId: string, fieldNames: string[]): string {
  if (fieldNames.length === 0) {
    return `DROP VIEW IF EXISTS ${viewName};`;
  }
  const inList = fieldNames.map((name) => `'${name.replace(/'/g, "''")}'`).join(", ");
  return `CREATE OR REPLACE VIEW ${viewName} AS
PIVOT (
  SELECT e.id as entry_id, e.created_at, e.updated_at,
         f.name as field_name, ef.value
  FROM entries e
  JOIN entry_fields ef ON ef.entry_id = e.id
  JOIN fields f ON f.id = ef.field_id
  WHERE e.object_id = '${objectId}'
) ON field_name IN (${inList}) USING first(value);`;
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

async function fetchObjectIds(): Promise<Set<string>> {
  const rows = await duckdbQueryAsync<{ id: string }>(`SELECT id FROM objects;`);
  return new Set(rows.map((row) => row.id));
}

async function fetchFieldNames(objectId: string): Promise<Set<string>> {
  const safeId = objectId.replace(/'/g, "''");
  const rows = await duckdbQueryAsync<{ name: string }>(
    `SELECT name FROM fields WHERE object_id = '${safeId}';`,
  );
  return new Set(rows.map((row) => row.name));
}

async function fetchAllFieldNames(objectId: string): Promise<string[]> {
  const safeId = objectId.replace(/'/g, "''");
  const rows = await duckdbQueryAsync<{ name: string; sort_order: number | null }>(
    `SELECT name, sort_order FROM fields WHERE object_id = '${safeId}' ORDER BY sort_order, name;`,
  );
  return rows.map((row) => row.name);
}

// ---------------------------------------------------------------------------
// Per-object migrations
// ---------------------------------------------------------------------------

async function ensureFieldsForObject(
  dbPath: string,
  objectName: string,
  objectId: string,
  newFields: FieldDef[],
): Promise<{ added: string[] }> {
  const existing = await fetchFieldNames(objectId);
  const additions = newFields.filter((field) => !existing.has(field.name));
  if (additions.length === 0) {
    return { added: [] };
  }
  const sql = additions.map((def) => buildFieldInsertSql(objectId, def)).join("\n");
  const ok = await duckdbExecOnFileAsync(dbPath, sql);
  if (!ok) {
    throw new Error(`Failed to add ${additions.length} field(s) to ${objectName}.`);
  }
  return { added: additions.map((field) => field.name) };
}

async function ensureNewObject(
  dbPath: string,
  def: ObjectDef,
  existingObjectIds: Set<string>,
): Promise<{ created: boolean; addedFields: string[] }> {
  const exists = existingObjectIds.has(def.id);
  let created = false;
  if (!exists) {
    const ok = await duckdbExecOnFileAsync(dbPath, buildObjectInsertSql(def));
    if (!ok) {
      throw new Error(`Failed to create ${def.name} object.`);
    }
    created = true;
  }

  const added = await ensureFieldsForObject(dbPath, def.name, def.id, def.fields);
  return { created, addedFields: added.added };
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

const VIEW_NAMES: Array<{ object: string; objectId: string; viewName: string }> = [
  { object: "people", objectId: PEOPLE_OBJECT_ID, viewName: "v_people" },
  { object: "company", objectId: COMPANY_OBJECT_ID, viewName: "v_company" },
  { object: "email_thread", objectId: EMAIL_THREAD_OBJECT_ID, viewName: "v_email_thread" },
  { object: "email_message", objectId: EMAIL_MESSAGE_OBJECT_ID, viewName: "v_email_message" },
  { object: "calendar_event", objectId: CALENDAR_EVENT_OBJECT_ID, viewName: "v_calendar_event" },
  { object: "interaction", objectId: INTERACTION_OBJECT_ID, viewName: "v_interaction" },
];

/**
 * Apply all onboarding-related migrations against the active workspace's
 * DuckDB. Idempotent: returns details about anything actually changed.
 */
export async function ensureLatestSchema(): Promise<MigrationResult> {
  const dbPath = await duckdbPathAsync();
  if (!dbPath) {
    return {
      ok: false,
      workspaceDb: null,
      changedObjects: [],
      addedFields: [],
      recreatedViews: [],
      error: "No workspace database found.",
    };
  }

  const result: MigrationResult = {
    ok: true,
    workspaceDb: dbPath,
    changedObjects: [],
    addedFields: [],
    recreatedViews: [],
  };

  try {
    // ── 0. Schema columns that are new since v1 ───────────────────────────
    // `hidden_in_sidebar` lets the workspace tree skip CRM-only objects
    // (email_thread, email_message, calendar_event, interaction) that have
    // dedicated UI. Idempotent: ALTER TABLE … ADD COLUMN IF NOT EXISTS.
    const columnSql = [
      `ALTER TABLE objects ADD COLUMN IF NOT EXISTS hidden_in_sidebar BOOLEAN DEFAULT false;`,
      `UPDATE objects SET hidden_in_sidebar = true WHERE name IN (`
        + `'email_thread', 'email_message', 'calendar_event', 'interaction'`
        + `) AND (hidden_in_sidebar IS NULL OR hidden_in_sidebar = false);`,
    ].join("\n");
    const colsOk = await duckdbExecOnFileAsync(dbPath, columnSql);
    if (!colsOk) {
      // Non-fatal — table doesn't exist yet on a brand-new DB; the seed
      // schema already includes the column.
    }

    const existingObjectIds = await fetchObjectIds();

    // Existing-object field additions
    const peopleAdditions = await ensureFieldsForObject(
      dbPath,
      "people",
      PEOPLE_OBJECT_ID,
      PEOPLE_NEW_FIELDS,
    );
    if (peopleAdditions.added.length > 0) {
      result.changedObjects.push("people");
      for (const field of peopleAdditions.added) {
        result.addedFields.push({ object: "people", field });
      }
    }

    const companyAdditions = await ensureFieldsForObject(
      dbPath,
      "company",
      COMPANY_OBJECT_ID,
      COMPANY_NEW_FIELDS,
    );
    if (companyAdditions.added.length > 0) {
      result.changedObjects.push("company");
      for (const field of companyAdditions.added) {
        result.addedFields.push({ object: "company", field });
      }
    }

    // New objects
    for (const def of NEW_OBJECTS) {
      const out = await ensureNewObject(dbPath, def, existingObjectIds);
      if (out.created) {
        result.changedObjects.push(def.name);
      }
      for (const field of out.addedFields) {
        result.addedFields.push({ object: def.name, field });
      }
    }

    // Views — always rebuild so they reflect the current set of fields.
    const viewSqlParts: string[] = [];
    for (const view of VIEW_NAMES) {
      const fieldNames = await fetchAllFieldNames(view.objectId);
      if (fieldNames.length === 0) {
        continue;
      }
      viewSqlParts.push(buildPivotViewSql(view.viewName, view.objectId, fieldNames));
      result.recreatedViews.push(view.viewName);
    }
    if (viewSqlParts.length > 0) {
      const ok = await duckdbExecOnFileAsync(dbPath, viewSqlParts.join("\n"));
      if (!ok) {
        // Non-fatal — schema is fine without views, but flag it.
        result.error = "View regeneration failed; schema is intact but v_* views may be stale.";
      }
    }

    return result;
  } catch (err) {
    result.ok = false;
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Helpers exported for the sync pipeline
// ---------------------------------------------------------------------------

export const ONBOARDING_OBJECT_IDS = {
  people: PEOPLE_OBJECT_ID,
  company: COMPANY_OBJECT_ID,
  email_thread: EMAIL_THREAD_OBJECT_ID,
  email_message: EMAIL_MESSAGE_OBJECT_ID,
  calendar_event: CALENDAR_EVENT_OBJECT_ID,
  interaction: INTERACTION_OBJECT_ID,
} as const;

/**
 * Fetch a map of `{ field name → field id }` for an object so the sync
 * pipeline can do `INSERT INTO entry_fields (entry_id, field_id, value)`
 * without re-querying for every row.
 */
export async function fetchFieldIdMap(objectId: string): Promise<Record<string, string>> {
  const safeId = objectId.replace(/'/g, "''");
  const rows = await duckdbQueryAsync<{ id: string; name: string }>(
    `SELECT id, name FROM fields WHERE object_id = '${safeId}';`,
  );
  const out: Record<string, string> = {};
  for (const row of rows) {
    out[row.name] = row.id;
  }
  return out;
}

/** Convenience: drop in DDL to ensure schema before any sync work. */
export async function runIdempotentMigrations(): Promise<MigrationResult> {
  // Touch the duckdb path through the standard helper so we honour
  // OPENCLAW_WORKSPACE / active workspace overrides.
  void (await duckdbExecAsync(`SELECT 1;`));
  return ensureLatestSchema();
}

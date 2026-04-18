import {
  ONBOARDING_OBJECT_IDS,
} from "@/lib/workspace-schema-migrations";
import {
  buildEntryProjection,
  jsonArrayContains,
  loadCrmFieldMaps,
  safeQuery,
  sqlString,
} from "@/lib/crm-queries";
import { extractEmailHost } from "@/lib/email-domain";
import { deriveWebsite } from "@/lib/website-from-domain";
import { getConnectionStrengthBucket } from "@/lib/connection-strength-label";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Person = {
  id: string;
  name: string | null;
  email: string | null;
  company_name: string | null;
  phone: string | null;
  status: string | null;
  source: string | null;
  strength_score: number | null;
  strength_label: string;
  strength_color: string;
  last_interaction_at: string | null;
  job_title: string | null;
  linkedin_url: string | null;
  avatar_url: string | null;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type Company = {
  id: string;
  name: string | null;
  domain: string | null;
  website: string | null;
  industry: string | null;
  type: string | null;
  source: string | null;
  strength_score: number | null;
};

type ThreadSummary = {
  id: string;
  subject: string | null;
  last_message_at: string | null;
  message_count: number | null;
  gmail_thread_id: string | null;
};

type EventSummary = {
  id: string;
  title: string | null;
  start_at: string | null;
  end_at: string | null;
  meeting_type: string | null;
  google_event_id: string | null;
};

type InteractionsSummary = {
  email_count: number;
  meeting_count: number;
  total: number;
  last_outbound_at: string | null;
  last_inbound_at: string | null;
};

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const personId = id?.trim();
  if (!personId) {
    return Response.json({ error: "Missing person id." }, { status: 400 });
  }

  const fieldMaps = await loadCrmFieldMaps();

  // ─── 1. Person row ────────────────────────────────────────────────────
  const personSql = buildEntryProjection({
    objectId: ONBOARDING_OBJECT_IDS.people,
    fieldMap: fieldMaps.people,
    aliasedFields: [
      { name: "Full Name", alias: "name" },
      { name: "Email Address", alias: "email" },
      { name: "Phone Number", alias: "phone" },
      { name: "Company", alias: "company_name" },
      { name: "Status", alias: "status" },
      { name: "Source", alias: "source" },
      { name: "Strength Score", alias: "strength_score" },
      { name: "Last Interaction At", alias: "last_interaction_at" },
      { name: "Job Title", alias: "job_title" },
      { name: "LinkedIn URL", alias: "linkedin_url" },
      { name: "Avatar URL", alias: "avatar_url" },
      { name: "Notes", alias: "notes" },
    ],
    whereSql: `e.id = ${sqlString(personId)}`,
  });
  const personRows = await safeQuery<Record<string, string | null>>(personSql);
  if (personRows.length === 0) {
    return Response.json({ error: "Person not found." }, { status: 404 });
  }
  const personRaw = personRows[0];
  const strengthScoreNum = personRaw.strength_score ? Number(personRaw.strength_score) : 0;
  const bucket = getConnectionStrengthBucket(strengthScoreNum);
  const person: Person = {
    id: String(personRaw.entry_id),
    name: personRaw.name,
    email: personRaw.email,
    company_name: personRaw.company_name,
    phone: personRaw.phone,
    status: personRaw.status,
    source: personRaw.source,
    strength_score: Number.isFinite(strengthScoreNum) ? strengthScoreNum : null,
    strength_label: bucket.label,
    strength_color: bucket.color,
    last_interaction_at: personRaw.last_interaction_at,
    job_title: personRaw.job_title,
    linkedin_url: personRaw.linkedin_url,
    avatar_url: personRaw.avatar_url,
    notes: personRaw.notes,
    created_at: personRaw.created_at,
    updated_at: personRaw.updated_at,
  };

  // ─── 2. Resolve company by domain match (or by Company text field name) ─
  let company: Company | null = null;
  const personHost = person.email ? extractEmailHost(person.email) : null;
  if (personHost) {
    const domainFieldId = fieldMaps.company["Domain"];
    if (domainFieldId) {
      const safeDomain = personHost.replace(/'/g, "''");
      const companyRows = await safeQuery<{ entry_id: string }>(`
        SELECT entry_id FROM entry_fields
        WHERE field_id = ${sqlString(domainFieldId)}
          AND (LOWER(value) = '${safeDomain}' OR '${safeDomain}' LIKE '%.' || LOWER(value))
        LIMIT 1;
      `);
      if (companyRows.length > 0) {
        company = await loadCompany(companyRows[0].entry_id, fieldMaps.company);
      }
    }
  }

  // ─── 3. Email threads where person is in Participants ─────────────────
  const participantsFieldId = fieldMaps.email_thread["Participants"];
  let threads: ThreadSummary[] = [];
  if (participantsFieldId) {
    const containsExpr = jsonArrayContains(
      `MAX(CASE WHEN ef.field_id = '${participantsFieldId.replace(/'/g, "''")}' THEN ef.value END)`,
      person.id,
    );
    const threadProjection = buildEntryProjection({
      objectId: ONBOARDING_OBJECT_IDS.email_thread,
      fieldMap: fieldMaps.email_thread,
      aliasedFields: [
        { name: "Subject", alias: "subject" },
        { name: "Last Message At", alias: "last_message_at" },
        { name: "Message Count", alias: "message_count" },
        { name: "Gmail Thread ID", alias: "gmail_thread_id" },
      ],
    });
    const threadSql = `
      SELECT * FROM (${threadProjection}) sub
      WHERE EXISTS (
        SELECT 1 FROM entry_fields p
        WHERE p.entry_id = sub.entry_id
          AND p.field_id = '${participantsFieldId.replace(/'/g, "''")}'
          AND p.value LIKE '%"${person.id.replace(/"/g, '""').replace(/'/g, "''")}"%'
      )
      ORDER BY last_message_at DESC NULLS LAST
      LIMIT 50;
    `;
    void containsExpr;
    const threadRows = await safeQuery<Record<string, string | null>>(threadSql);
    threads = threadRows.map((row) => ({
      id: String(row.entry_id),
      subject: row.subject,
      last_message_at: row.last_message_at,
      message_count: row.message_count ? Number(row.message_count) : null,
      gmail_thread_id: row.gmail_thread_id,
    }));
  }

  // ─── 4. Calendar events where person is in Attendees ──────────────────
  const attendeesFieldId = fieldMaps.calendar_event["Attendees"];
  let events: EventSummary[] = [];
  if (attendeesFieldId) {
    const eventProjection = buildEntryProjection({
      objectId: ONBOARDING_OBJECT_IDS.calendar_event,
      fieldMap: fieldMaps.calendar_event,
      aliasedFields: [
        { name: "Title", alias: "title" },
        { name: "Start At", alias: "start_at" },
        { name: "End At", alias: "end_at" },
        { name: "Meeting Type", alias: "meeting_type" },
        { name: "Google Event ID", alias: "google_event_id" },
      ],
    });
    const eventSql = `
      SELECT * FROM (${eventProjection}) sub
      WHERE EXISTS (
        SELECT 1 FROM entry_fields a
        WHERE a.entry_id = sub.entry_id
          AND a.field_id = '${attendeesFieldId.replace(/'/g, "''")}'
          AND a.value LIKE '%"${person.id.replace(/"/g, '""').replace(/'/g, "''")}"%'
      )
      ORDER BY start_at DESC NULLS LAST
      LIMIT 50;
    `;
    const eventRows = await safeQuery<Record<string, string | null>>(eventSql);
    events = eventRows.map((row) => ({
      id: String(row.entry_id),
      title: row.title,
      start_at: row.start_at,
      end_at: row.end_at,
      meeting_type: row.meeting_type,
      google_event_id: row.google_event_id,
    }));
  }

  // ─── 5. Interaction summary ───────────────────────────────────────────
  const summary = await loadInteractionSummary(person.id, fieldMaps);

  // Compose final payload.
  return Response.json({
    person,
    company: company
      ? {
          ...company,
          website: company.website ?? deriveWebsite(company.domain ?? null),
        }
      : null,
    derived_website: deriveWebsite(person.email),
    threads,
    events,
    interactions_summary: summary,
  });
}

async function loadCompany(
  companyEntryId: string,
  companyFieldMap: Record<string, string>,
): Promise<Company> {
  const sql = buildEntryProjection({
    objectId: ONBOARDING_OBJECT_IDS.company,
    fieldMap: companyFieldMap,
    aliasedFields: [
      { name: "Company Name", alias: "name" },
      { name: "Domain", alias: "domain" },
      { name: "Website", alias: "website" },
      { name: "Industry", alias: "industry" },
      { name: "Type", alias: "type" },
      { name: "Source", alias: "source" },
      { name: "Strength Score", alias: "strength_score" },
    ],
    whereSql: `e.id = ${sqlString(companyEntryId)}`,
  });
  const rows = await safeQuery<Record<string, string | null>>(sql);
  const row = rows[0] ?? null;
  return {
    id: companyEntryId,
    name: row?.name ?? null,
    domain: row?.domain ?? null,
    website: row?.website ?? null,
    industry: row?.industry ?? null,
    type: row?.type ?? null,
    source: row?.source ?? null,
    strength_score: row?.strength_score ? Number(row.strength_score) : null,
  };
}

async function loadInteractionSummary(
  personId: string,
  fieldMaps: Awaited<ReturnType<typeof loadCrmFieldMaps>>,
): Promise<InteractionsSummary> {
  const personRelFieldId = fieldMaps.interaction["Person"];
  const typeFieldId = fieldMaps.interaction["Type"];
  const occurredFieldId = fieldMaps.interaction["Occurred At"];
  const directionFieldId = fieldMaps.interaction["Direction"];
  if (!personRelFieldId) {
    return { email_count: 0, meeting_count: 0, total: 0, last_outbound_at: null, last_inbound_at: null };
  }
  const safePerson = personId.replace(/'/g, "''");
  const sql = `
    SELECT
      COUNT(DISTINCT i.entry_id) AS total,
      SUM(CASE WHEN i.type = 'Email' THEN 1 ELSE 0 END) AS email_count,
      SUM(CASE WHEN i.type = 'Meeting' THEN 1 ELSE 0 END) AS meeting_count,
      MAX(CASE WHEN i.direction = 'Sent' THEN i.occurred_at END) AS last_outbound_at,
      MAX(CASE WHEN i.direction = 'Received' THEN i.occurred_at END) AS last_inbound_at
    FROM (
      SELECT
        e.id AS entry_id,
        ${typeFieldId ? `MAX(CASE WHEN ef.field_id = '${typeFieldId.replace(/'/g, "''")}' THEN ef.value END)` : "NULL"} AS type,
        ${occurredFieldId ? `MAX(CASE WHEN ef.field_id = '${occurredFieldId.replace(/'/g, "''")}' THEN ef.value END)` : "NULL"} AS occurred_at,
        ${directionFieldId ? `MAX(CASE WHEN ef.field_id = '${directionFieldId.replace(/'/g, "''")}' THEN ef.value END)` : "NULL"} AS direction
      FROM entries e
      JOIN entry_fields person_rel ON person_rel.entry_id = e.id
        AND person_rel.field_id = '${personRelFieldId.replace(/'/g, "''")}'
        AND person_rel.value = '${safePerson}'
      LEFT JOIN entry_fields ef ON ef.entry_id = e.id
      WHERE e.object_id = '${ONBOARDING_OBJECT_IDS.interaction}'
      GROUP BY e.id
    ) i;
  `;
  const rows = await safeQuery<{
    total: number | string | null;
    email_count: number | string | null;
    meeting_count: number | string | null;
    last_outbound_at: string | null;
    last_inbound_at: string | null;
  }>(sql);
  const row = rows[0];
  return {
    email_count: row?.email_count ? Number(row.email_count) : 0,
    meeting_count: row?.meeting_count ? Number(row.meeting_count) : 0,
    total: row?.total ? Number(row.total) : 0,
    last_outbound_at: row?.last_outbound_at ?? null,
    last_inbound_at: row?.last_inbound_at ?? null,
  };
}

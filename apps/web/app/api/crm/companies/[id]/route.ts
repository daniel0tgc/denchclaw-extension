import {
  ONBOARDING_OBJECT_IDS,
} from "@/lib/workspace-schema-migrations";
import {
  buildEntryProjection,
  loadCrmFieldMaps,
  safeQuery,
  sqlString,
} from "@/lib/crm-queries";
import { deriveWebsite } from "@/lib/website-from-domain";
import { getConnectionStrengthBucket } from "@/lib/connection-strength-label";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const companyId = id?.trim();
  if (!companyId) {
    return Response.json({ error: "Missing company id." }, { status: 400 });
  }

  const fieldMaps = await loadCrmFieldMaps();

  // ─── 1. Company row ──────────────────────────────────────────────────
  const companySql = buildEntryProjection({
    objectId: ONBOARDING_OBJECT_IDS.company,
    fieldMap: fieldMaps.company,
    aliasedFields: [
      { name: "Company Name", alias: "name" },
      { name: "Domain", alias: "domain" },
      { name: "Website", alias: "website" },
      { name: "Industry", alias: "industry" },
      { name: "Type", alias: "type" },
      { name: "Source", alias: "source" },
      { name: "Strength Score", alias: "strength_score" },
      { name: "Last Interaction At", alias: "last_interaction_at" },
      { name: "Notes", alias: "notes" },
    ],
    whereSql: `e.id = ${sqlString(companyId)}`,
  });
  const companyRows = await safeQuery<Record<string, string | null>>(companySql);
  if (companyRows.length === 0) {
    return Response.json({ error: "Company not found." }, { status: 404 });
  }
  const raw = companyRows[0];
  const strengthScoreNum = raw.strength_score ? Number(raw.strength_score) : 0;
  const bucket = getConnectionStrengthBucket(strengthScoreNum);
  const company = {
    id: String(raw.entry_id),
    name: raw.name,
    domain: raw.domain,
    website: raw.website ?? deriveWebsite(raw.domain ?? null),
    industry: raw.industry,
    type: raw.type,
    source: raw.source,
    strength_score: Number.isFinite(strengthScoreNum) ? strengthScoreNum : null,
    strength_label: bucket.label,
    strength_color: bucket.color,
    last_interaction_at: raw.last_interaction_at,
    notes: raw.notes,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };

  // ─── 2. People at this company (match by domain on People.Email Address) ─
  type PersonRow = Record<string, string | null>;
  let people: Array<{
    id: string;
    name: string | null;
    email: string | null;
    job_title: string | null;
    strength_score: number | null;
    strength_label: string;
    strength_color: string;
    last_interaction_at: string | null;
    avatar_url: string | null;
  }> = [];
  if (company.domain) {
    const safeDomain = company.domain.replace(/'/g, "''").toLowerCase();
    const peopleProjection = buildEntryProjection({
      objectId: ONBOARDING_OBJECT_IDS.people,
      fieldMap: fieldMaps.people,
      aliasedFields: [
        { name: "Full Name", alias: "name" },
        { name: "Email Address", alias: "email" },
        { name: "Job Title", alias: "job_title" },
        { name: "Strength Score", alias: "strength_score" },
        { name: "Last Interaction At", alias: "last_interaction_at" },
        { name: "Avatar URL", alias: "avatar_url" },
      ],
    });
    const sql = `
      SELECT * FROM (${peopleProjection}) sub
      WHERE LOWER(SUBSTR(sub.email, INSTR(sub.email, '@') + 1)) = '${safeDomain}'
         OR LOWER(SUBSTR(sub.email, INSTR(sub.email, '@') + 1)) LIKE '%.${safeDomain}'
      ORDER BY TRY_CAST(sub.strength_score AS DOUBLE) DESC NULLS LAST,
               sub.last_interaction_at DESC NULLS LAST
      LIMIT 100;
    `;
    const peopleRows = await safeQuery<PersonRow>(sql);
    people = peopleRows.map((row) => {
      const score = row.strength_score ? Number(row.strength_score) : 0;
      const personBucket = getConnectionStrengthBucket(score);
      return {
        id: String(row.entry_id),
        name: row.name,
        email: row.email,
        job_title: row.job_title,
        strength_score: Number.isFinite(score) ? score : null,
        strength_label: personBucket.label,
        strength_color: personBucket.color,
        last_interaction_at: row.last_interaction_at,
        avatar_url: row.avatar_url,
      };
    });
  }

  // ─── 3. Email threads where Company is in Companies relation ─────────
  const threadCompaniesFieldId = fieldMaps.email_thread["Companies"];
  let threads: Array<{
    id: string;
    subject: string | null;
    last_message_at: string | null;
    message_count: number | null;
    gmail_thread_id: string | null;
  }> = [];
  if (threadCompaniesFieldId) {
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
    const safeId = company.id.replace(/"/g, '""').replace(/'/g, "''");
    const sql = `
      SELECT * FROM (${threadProjection}) sub
      WHERE EXISTS (
        SELECT 1 FROM entry_fields c
        WHERE c.entry_id = sub.entry_id
          AND c.field_id = '${threadCompaniesFieldId.replace(/'/g, "''")}'
          AND c.value LIKE '%"${safeId}"%'
      )
      ORDER BY last_message_at DESC NULLS LAST
      LIMIT 50;
    `;
    const rows = await safeQuery<Record<string, string | null>>(sql);
    threads = rows.map((row) => ({
      id: String(row.entry_id),
      subject: row.subject,
      last_message_at: row.last_message_at,
      message_count: row.message_count ? Number(row.message_count) : null,
      gmail_thread_id: row.gmail_thread_id,
    }));
  }

  // ─── 4. Calendar events where Company is in Companies relation ───────
  const eventCompaniesFieldId = fieldMaps.calendar_event["Companies"];
  let events: Array<{
    id: string;
    title: string | null;
    start_at: string | null;
    end_at: string | null;
    meeting_type: string | null;
  }> = [];
  if (eventCompaniesFieldId) {
    const eventProjection = buildEntryProjection({
      objectId: ONBOARDING_OBJECT_IDS.calendar_event,
      fieldMap: fieldMaps.calendar_event,
      aliasedFields: [
        { name: "Title", alias: "title" },
        { name: "Start At", alias: "start_at" },
        { name: "End At", alias: "end_at" },
        { name: "Meeting Type", alias: "meeting_type" },
      ],
    });
    const safeId = company.id.replace(/"/g, '""').replace(/'/g, "''");
    const sql = `
      SELECT * FROM (${eventProjection}) sub
      WHERE EXISTS (
        SELECT 1 FROM entry_fields c
        WHERE c.entry_id = sub.entry_id
          AND c.field_id = '${eventCompaniesFieldId.replace(/'/g, "''")}'
          AND c.value LIKE '%"${safeId}"%'
      )
      ORDER BY start_at DESC NULLS LAST
      LIMIT 50;
    `;
    const rows = await safeQuery<Record<string, string | null>>(sql);
    events = rows.map((row) => ({
      id: String(row.entry_id),
      title: row.title,
      start_at: row.start_at,
      end_at: row.end_at,
      meeting_type: row.meeting_type,
    }));
  }

  // ─── 5. Summary stats ────────────────────────────────────────────────
  const summary = {
    people_count: people.length,
    thread_count: threads.length,
    event_count: events.length,
    strongest_contact: people[0]?.name ?? people[0]?.email ?? null,
  };

  return Response.json({
    company,
    people,
    threads,
    events,
    summary,
  });
}

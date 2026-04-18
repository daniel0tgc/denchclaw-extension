import {
  ONBOARDING_OBJECT_IDS,
} from "@/lib/workspace-schema-migrations";
import {
  buildEntryProjection,
  loadCrmFieldMaps,
  safeQuery,
  sqlString,
} from "@/lib/crm-queries";
import { hydrateMessageBodies, type MessageNeedingHydration } from "@/lib/gmail-body-hydrate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Message = {
  id: string;
  subject: string | null;
  sent_at: string | null;
  preview: string | null;
  body: string | null;
  has_attachments: boolean;
  gmail_message_id: string | null;
  sender_type: string | null;
  from_person_id: string | null;
  to_person_ids: string[];
  cc_person_ids: string[];
};

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await ctx.params;
  const id = threadId?.trim();
  if (!id) {
    return Response.json({ error: "Missing thread id." }, { status: 400 });
  }

  const fieldMaps = await loadCrmFieldMaps();

  const threadFieldId = fieldMaps.email_message["Thread"];
  if (!threadFieldId) {
    return Response.json({ error: "Schema migration didn't run — Thread field missing." }, { status: 500 });
  }

  const projection = buildEntryProjection({
    objectId: ONBOARDING_OBJECT_IDS.email_message,
    fieldMap: fieldMaps.email_message,
    aliasedFields: [
      { name: "Subject", alias: "subject" },
      { name: "Sent At", alias: "sent_at" },
      { name: "Body Preview", alias: "preview" },
      { name: "Body", alias: "body" },
      { name: "Has Attachments", alias: "has_attachments" },
      { name: "Gmail Message ID", alias: "gmail_message_id" },
      { name: "Sender Type", alias: "sender_type" },
      { name: "From", alias: "from_relation" },
      { name: "To", alias: "to_relation" },
      { name: "Cc", alias: "cc_relation" },
      { name: "Thread", alias: "thread_relation" },
    ],
  });

  const sql = `
    SELECT * FROM (${projection}) sub
    WHERE thread_relation = ${sqlString(id)}
    ORDER BY sent_at ASC NULLS LAST;
  `;
  const rows = await safeQuery<Record<string, string | null>>(sql);

  // Hydrate everyone we reference (From/To/Cc) in one go
  const allPersonIds = new Set<string>();
  for (const row of rows) {
    if (row.from_relation) {allPersonIds.add(row.from_relation);}
    for (const id of parseRelationIds(row.to_relation)) {allPersonIds.add(id);}
    for (const id of parseRelationIds(row.cc_relation)) {allPersonIds.add(id);}
  }
  const peopleNameFieldId = fieldMaps.people["Full Name"];
  const peopleEmailFieldId = fieldMaps.people["Email Address"];
  const peopleAvatarFieldId = fieldMaps.people["Avatar URL"];
  const personById = new Map<string, { id: string; name: string | null; email: string | null; avatar_url: string | null }>();
  if (allPersonIds.size > 0 && (peopleNameFieldId || peopleEmailFieldId)) {
    const inList = Array.from(allPersonIds).map((pid) => sqlString(pid)).join(", ");
    const peopleSql = `
      SELECT
        e.id AS person_id,
        ${peopleNameFieldId ? `MAX(CASE WHEN ef.field_id = '${peopleNameFieldId}' THEN ef.value END)` : "NULL"} AS name,
        ${peopleEmailFieldId ? `MAX(CASE WHEN ef.field_id = '${peopleEmailFieldId}' THEN ef.value END)` : "NULL"} AS email,
        ${peopleAvatarFieldId ? `MAX(CASE WHEN ef.field_id = '${peopleAvatarFieldId}' THEN ef.value END)` : "NULL"} AS avatar_url
      FROM entries e
      LEFT JOIN entry_fields ef ON ef.entry_id = e.id
      WHERE e.object_id = '${ONBOARDING_OBJECT_IDS.people}'
        AND e.id IN (${inList})
      GROUP BY e.id;
    `;
    const peopleRows = await safeQuery<{
      person_id: string;
      name: string | null;
      email: string | null;
      avatar_url: string | null;
    }>(peopleSql);
    for (const row of peopleRows) {
      personById.set(row.person_id, {
        id: row.person_id,
        name: row.name,
        email: row.email,
        avatar_url: row.avatar_url,
      });
    }
  }

  // ─── Lazy-hydrate full bodies from Composio for messages that only
  // have a preview. The sync stores just the snippet (Composio's verbose
  // page mode exceeds the gateway 413 cap at 50-message pages), so the
  // first time a thread is opened we fetch the full bodies in parallel,
  // persist them back to DuckDB, and merge into the response. Subsequent
  // opens skip the fetch entirely because `row.body` is now populated.
  const toHydrate: MessageNeedingHydration[] = [];
  for (const row of rows) {
    if ((row.body ?? "").trim() === "" && row.gmail_message_id) {
      toHydrate.push({
        entryId: String(row.entry_id),
        gmailMessageId: row.gmail_message_id,
      });
    }
  }

  const hydrated = await hydrateMessageBodies(toHydrate);

  const messages: Message[] = rows.map((row) => {
    const entryId = String(row.entry_id);
    const fetchedBody = hydrated.bodies.get(entryId);
    return {
      id: entryId,
      subject: row.subject,
      sent_at: row.sent_at,
      preview: row.preview,
      body: fetchedBody ?? row.body,
      has_attachments: row.has_attachments === "true",
      gmail_message_id: row.gmail_message_id,
      sender_type: row.sender_type,
      from_person_id: row.from_relation || null,
      to_person_ids: parseRelationIds(row.to_relation),
      cc_person_ids: parseRelationIds(row.cc_relation),
    };
  });

  return Response.json({
    thread_id: id,
    messages,
    people: Array.from(personById.values()),
    body_hydration: {
      attempted: toHydrate.length,
      fetched: hydrated.bodies.size,
      failed: hydrated.failed,
      skipped: hydrated.skipped,
    },
  });
}

function parseRelationIds(value: string | null): string[] {
  if (!value) {return [];}
  const trimmed = value.trim();
  if (!trimmed) {return [];}
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {return parsed.map(String).filter(Boolean);}
    } catch {
      return [trimmed];
    }
  }
  return [trimmed];
}

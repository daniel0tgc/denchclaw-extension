/**
 * Google Calendar backfill + incremental sync.
 *
 * Same shape as `gmail-sync.ts`:
 *
 *   1. Page through `GOOGLECALENDAR_LIST_EVENTS` over a window (default
 *      5 years back → 1 year forward).
 *   2. For each event: parse attendees + organizer, ensure People rows,
 *      insert a `calendar_event` entry, link via relations, then emit
 *      one `interaction` row per non-self attendee with the meeting
 *      score weight (1:1 = 8x email, group = 3x or 0.5x).
 *   3. Persist a `syncToken` cursor for the next incremental tick.
 *
 * Self-attendee filtering uses the OAuthed Gmail account email. A more
 * robust approach (Calendar API has its own profile endpoint) is a
 * follow-up; for v1 most users will sign into both with the same Google
 * account and this works fine.
 */

import { randomUUID } from "node:crypto";
import {
  duckdbExecOnFileAsync,
  duckdbPathAsync,
  duckdbQueryAsync,
} from "./workspace";
import {
  ONBOARDING_OBJECT_IDS,
  fetchFieldIdMap,
} from "./workspace-schema-migrations";
import {
  ComposioToolNoConnectionError,
  executeComposioTool,
  resolveToolSlug,
} from "./composio-execute";
import { normalizeEmailKey, parseEmailAddress, rootDomainFromEmail } from "./email-domain";
import {
  readPersonalDomainsOverrides,
  writeSyncCursors,
} from "./denchclaw-state";
import {
  meetingDirectness,
  meetingTypeWeight,
  recencyDecay,
  roundScore,
  type MeetingResponse,
} from "./strength-score";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CalendarSyncProgress = {
  phase: "starting" | "calendar" | "complete" | "error";
  message: string;
  eventsProcessed: number;
  peopleProcessed: number;
};

export type CalendarSyncOptions = {
  connectionId: string;
  signal?: AbortSignal;
  onProgress?: (event: CalendarSyncProgress) => void;
  /** Self email — used to filter out the OAuthed user from attendee People rows. */
  selfEmail?: string | null;
  pageSize?: number;
  maxPages?: number;
};

export type CalendarSyncSummary = {
  ok: boolean;
  eventsProcessed: number;
  peopleProcessed: number;
  pagesProcessed: number;
  syncToken: string | null;
  error?: string;
};

type Attendee = {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  organizer?: boolean;
  self?: boolean;
};

type CalendarEvent = {
  id?: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Attendee[];
  organizer?: { email?: string; displayName?: string };
  status?: string;
  recurringEventId?: string;
};

type CalendarListResponse = {
  data?: {
    items?: CalendarEvent[];
    nextPageToken?: string | null;
    nextSyncToken?: string | null;
  };
  items?: CalendarEvent[];
  nextPageToken?: string | null;
  nextSyncToken?: string | null;
};

// ---------------------------------------------------------------------------
// Small repeats from gmail-sync — kept duplicated to avoid churning the
// public API of a shared "sync helpers" module before we're sure both
// pipelines want the same abstraction.
// ---------------------------------------------------------------------------

function sql(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) {return "NULL";}
  if (typeof value === "boolean") {return value ? "true" : "false";}
  if (typeof value === "number") {return Number.isFinite(value) ? String(value) : "NULL";}
  return `'${value.replace(/'/g, "''")}'`;
}

class StatementBatch {
  private parts: string[] = [];
  add(statement: string): void {
    this.parts.push(statement.endsWith(";") ? statement : `${statement};`);
  }
  isEmpty(): boolean {
    return this.parts.length === 0;
  }
  toSql(): string {
    return this.parts.join("\n");
  }
}

function emitInsertEntry(batch: StatementBatch, params: { id: string; objectId: string }): void {
  batch.add(`INSERT INTO entries (id, object_id) VALUES (${sql(params.id)}, ${sql(params.objectId)})`);
}

function emitInsertField(
  batch: StatementBatch,
  params: { entryId: string; fieldId: string; value: string | number | boolean | null },
): void {
  if (params.value === null || params.value === undefined) {return;}
  const value =
    typeof params.value === "string"
      ? params.value
      : typeof params.value === "boolean"
        ? params.value
          ? "true"
          : "false"
        : String(params.value);
  batch.add(
    `INSERT INTO entry_fields (entry_id, field_id, value) VALUES (${sql(params.entryId)}, ${sql(
      params.fieldId,
    )}, ${sql(value)})`,
  );
}

function emitUpsertField(
  batch: StatementBatch,
  params: { entryId: string; fieldId: string; value: string | number | boolean | null },
): void {
  if (params.value === null || params.value === undefined) {return;}
  const value =
    typeof params.value === "string"
      ? params.value
      : typeof params.value === "boolean"
        ? params.value
          ? "true"
          : "false"
        : String(params.value);
  batch.add(
    `DELETE FROM entry_fields WHERE entry_id = ${sql(params.entryId)} AND field_id = ${sql(params.fieldId)}`,
  );
  batch.add(
    `INSERT INTO entry_fields (entry_id, field_id, value) VALUES (${sql(params.entryId)}, ${sql(
      params.fieldId,
    )}, ${sql(value)})`,
  );
}

// ---------------------------------------------------------------------------
// Field-id maps
// ---------------------------------------------------------------------------

type FieldMaps = {
  people: Record<string, string>;
  company: Record<string, string>;
  calendar_event: Record<string, string>;
  interaction: Record<string, string>;
};

async function loadFieldMaps(): Promise<FieldMaps> {
  // Serialize the lookups — concurrent duckdb CLI processes thrash the
  // file lock and most return empty silently. See gmail-sync.ts for the
  // same fix.
  const people = await fetchFieldIdMap(ONBOARDING_OBJECT_IDS.people);
  const company = await fetchFieldIdMap(ONBOARDING_OBJECT_IDS.company);
  const calendar_event = await fetchFieldIdMap(ONBOARDING_OBJECT_IDS.calendar_event);
  const interaction = await fetchFieldIdMap(ONBOARDING_OBJECT_IDS.interaction);
  return { people, company, calendar_event, interaction };
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

type CalendarCache = {
  peopleByEmail: Map<string, string>;
  companyByDomain: Map<string, string>;
  eventByGoogleId: Set<string>;
};

async function buildCache(fieldMaps: FieldMaps): Promise<CalendarCache> {
  const cache: CalendarCache = {
    peopleByEmail: new Map(),
    companyByDomain: new Map(),
    eventByGoogleId: new Set(),
  };

  const peopleEmailFieldId = fieldMaps.people["Email Address"];
  if (peopleEmailFieldId) {
    const rows = await duckdbQueryAsync<{ entry_id: string; value: string }>(
      `SELECT entry_id, value FROM entry_fields WHERE field_id = '${peopleEmailFieldId}';`,
    );
    for (const row of rows) {
      const key = normalizeEmailKey(row.value);
      if (key) {cache.peopleByEmail.set(key, row.entry_id);}
    }
  }
  const companyDomainFieldId = fieldMaps.company["Domain"];
  if (companyDomainFieldId) {
    const rows = await duckdbQueryAsync<{ entry_id: string; value: string }>(
      `SELECT entry_id, value FROM entry_fields WHERE field_id = '${companyDomainFieldId}';`,
    );
    for (const row of rows) {
      const domain = row.value?.trim().toLowerCase();
      if (domain) {cache.companyByDomain.set(domain, row.entry_id);}
    }
  }
  const eventGoogleFieldId = fieldMaps.calendar_event["Google Event ID"];
  if (eventGoogleFieldId) {
    const rows = await duckdbQueryAsync<{ value: string }>(
      `SELECT value FROM entry_fields WHERE field_id = '${eventGoogleFieldId}';`,
    );
    for (const row of rows) {
      if (row.value) {cache.eventByGoogleId.add(row.value);}
    }
  }

  return cache;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function eventStartIso(event: CalendarEvent): string | null {
  const start = event.start?.dateTime ?? event.start?.date;
  if (!start) {return null;}
  const ts = Date.parse(start);
  if (!Number.isFinite(ts)) {return null;}
  return new Date(ts).toISOString();
}

function eventEndIso(event: CalendarEvent): string | null {
  const end = event.end?.dateTime ?? event.end?.date;
  if (!end) {return null;}
  const ts = Date.parse(end);
  if (!Number.isFinite(ts)) {return null;}
  return new Date(ts).toISOString();
}

function backfillTimeMin(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 5);
  return d.toISOString();
}
function backfillTimeMax(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString();
}

function deriveCompanyNameFromDomain(domain: string): string {
  const head = domain.split(".")[0];
  return head
    .split(/[-_]/g)
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Per-event ingestion
// ---------------------------------------------------------------------------

function ensurePersonForCalendar(params: {
  attendee: Attendee;
  fieldMaps: FieldMaps;
  cache: CalendarCache;
  batch: StatementBatch;
  domainOverrides: { add: string[]; remove: string[] };
  selfEmails: Set<string>;
}): { entryId: string; isSelf: boolean; companyId?: string } | null {
  const parsed = parseEmailAddress(params.attendee.email ?? null);
  if (!parsed) {return null;}
  const key = normalizeEmailKey(parsed.address);
  if (!key) {return null;}
  const isSelf = params.attendee.self === true || params.selfEmails.has(key);
  // Resolve the company once up-front so cached-person paths can still
  // surface the companyId to the interaction emitter.
  const domain = rootDomainFromEmail(parsed.address, params.domainOverrides);
  const cachedId = params.cache.peopleByEmail.get(key);
  if (cachedId) {
    const cachedCompanyId = domain ? params.cache.companyByDomain.get(domain) : undefined;
    return { entryId: cachedId, isSelf, companyId: cachedCompanyId };
  }
  if (isSelf) {return { entryId: "", isSelf };}

  const entryId = randomUUID();
  params.cache.peopleByEmail.set(key, entryId);
  emitInsertEntry(params.batch, { id: entryId, objectId: ONBOARDING_OBJECT_IDS.people });

  const displayName = (params.attendee.displayName ?? parsed.name)?.trim();
  if (params.fieldMaps.people["Full Name"] && displayName) {
    emitInsertField(params.batch, {
      entryId,
      fieldId: params.fieldMaps.people["Full Name"],
      value: displayName,
    });
  }
  if (params.fieldMaps.people["Email Address"]) {
    emitInsertField(params.batch, {
      entryId,
      fieldId: params.fieldMaps.people["Email Address"],
      value: parsed.address,
    });
  }
  if (params.fieldMaps.people["Source"]) {
    emitInsertField(params.batch, {
      entryId,
      fieldId: params.fieldMaps.people["Source"],
      value: "Calendar",
    });
  }

  let resolvedCompanyId: string | undefined;
  if (domain) {
    let companyId = params.cache.companyByDomain.get(domain);
    if (!companyId) {
      companyId = randomUUID();
      params.cache.companyByDomain.set(domain, companyId);
      emitInsertEntry(params.batch, {
        id: companyId,
        objectId: ONBOARDING_OBJECT_IDS.company,
      });
      if (params.fieldMaps.company["Company Name"]) {
        emitInsertField(params.batch, {
          entryId: companyId,
          fieldId: params.fieldMaps.company["Company Name"],
          value: deriveCompanyNameFromDomain(domain),
        });
      }
      if (params.fieldMaps.company["Domain"]) {
        emitInsertField(params.batch, {
          entryId: companyId,
          fieldId: params.fieldMaps.company["Domain"],
          value: domain,
        });
      }
      if (params.fieldMaps.company["Source"]) {
        emitInsertField(params.batch, {
          entryId: companyId,
          fieldId: params.fieldMaps.company["Source"],
          value: "Calendar",
        });
      }
    }
    resolvedCompanyId = companyId;
    // people.Company is now a many_to_one relation to company; write the
    // company entry id (not the derived name).
    if (params.fieldMaps.people["Company"]) {
      emitInsertField(params.batch, {
        entryId,
        fieldId: params.fieldMaps.people["Company"],
        value: companyId,
      });
    }
  }

  return { entryId, isSelf, companyId: resolvedCompanyId };
}

function processEvent(params: {
  event: CalendarEvent;
  selfEmails: Set<string>;
  domainOverrides: { add: string[]; remove: string[] };
  fieldMaps: FieldMaps;
  cache: CalendarCache;
  batch: StatementBatch;
}): { added: boolean; newPeople: number } {
  const { event, selfEmails, domainOverrides, fieldMaps, cache, batch } = params;
  const eventId = event.id?.trim();
  if (!eventId) {return { added: false, newPeople: 0 };}
  if (cache.eventByGoogleId.has(eventId)) {return { added: false, newPeople: 0 };}
  const startIso = eventStartIso(event);
  if (!startIso) {return { added: false, newPeople: 0 };}
  if (event.status === "cancelled") {return { added: false, newPeople: 0 };}

  const beforeCachedPeople = cache.peopleByEmail.size;
  const attendees = event.attendees ?? [];
  const organizerEmail = event.organizer?.email ?? null;
  const includeOrganizer = organizerEmail && !attendees.some((a) => a.email === organizerEmail);
  const allAttendees = includeOrganizer
    ? [
        {
          email: organizerEmail,
          displayName: event.organizer?.displayName,
          organizer: true,
          responseStatus: "accepted",
          self: selfEmails.has(normalizeEmailKey(organizerEmail) ?? organizerEmail.toLowerCase()),
        } satisfies Attendee,
        ...attendees,
      ]
    : attendees;

  const resolved = allAttendees
    .map((a) => ({
      attendee: a,
      info: ensurePersonForCalendar({
        attendee: a,
        fieldMaps,
        cache,
        batch,
        domainOverrides,
        selfEmails,
      }),
    }))
    .filter((r) => r.info !== null) as Array<{
    attendee: Attendee;
    info: { entryId: string; isSelf: boolean; companyId?: string };
  }>;

  const nonSelf = resolved.filter((r) => !r.info.isSelf && r.info.entryId);
  const totalAttendeeCount = resolved.length || 1;

  // Insert calendar_event
  const eventEntryId = randomUUID();
  cache.eventByGoogleId.add(eventId);
  emitInsertEntry(batch, { id: eventEntryId, objectId: ONBOARDING_OBJECT_IDS.calendar_event });
  if (fieldMaps.calendar_event["Title"]) {
    emitInsertField(batch, {
      entryId: eventEntryId,
      fieldId: fieldMaps.calendar_event["Title"],
      value: (event.summary ?? "(no title)").slice(0, 500),
    });
  }
  if (fieldMaps.calendar_event["Start At"]) {
    emitInsertField(batch, {
      entryId: eventEntryId,
      fieldId: fieldMaps.calendar_event["Start At"],
      value: startIso,
    });
  }
  const endIso = eventEndIso(event);
  if (endIso && fieldMaps.calendar_event["End At"]) {
    emitInsertField(batch, {
      entryId: eventEntryId,
      fieldId: fieldMaps.calendar_event["End At"],
      value: endIso,
    });
  }
  if (fieldMaps.calendar_event["Google Event ID"]) {
    emitInsertField(batch, {
      entryId: eventEntryId,
      fieldId: fieldMaps.calendar_event["Google Event ID"],
      value: eventId,
    });
  }
  const organizerInfo = resolved.find((r) => r.attendee.organizer || r.attendee.email === organizerEmail);
  if (organizerInfo && organizerInfo.info.entryId && !organizerInfo.info.isSelf && fieldMaps.calendar_event["Organizer"]) {
    emitInsertField(batch, {
      entryId: eventEntryId,
      fieldId: fieldMaps.calendar_event["Organizer"],
      value: organizerInfo.info.entryId,
    });
  }
  if (fieldMaps.calendar_event["Attendees"] && nonSelf.length > 0) {
    emitInsertField(batch, {
      entryId: eventEntryId,
      fieldId: fieldMaps.calendar_event["Attendees"],
      value: JSON.stringify(nonSelf.map((r) => r.info.entryId)),
    });
  }
  // Companies aggregate
  const companyIds = new Set<string>();
  for (const r of resolved) {
    const parsed = parseEmailAddress(r.attendee.email ?? null);
    if (!parsed) {continue;}
    const domain = rootDomainFromEmail(parsed.address, domainOverrides);
    if (!domain) {continue;}
    const cid = cache.companyByDomain.get(domain);
    if (cid) {companyIds.add(cid);}
  }
  if (fieldMaps.calendar_event["Companies"] && companyIds.size > 0) {
    emitInsertField(batch, {
      entryId: eventEntryId,
      fieldId: fieldMaps.calendar_event["Companies"],
      value: JSON.stringify(Array.from(companyIds)),
    });
  }
  if (fieldMaps.calendar_event["Meeting Type"]) {
    const meetingType =
      totalAttendeeCount <= 2
        ? "One on One"
        : totalAttendeeCount <= 5
          ? "Small Group"
          : "Large Group";
    emitInsertField(batch, {
      entryId: eventEntryId,
      fieldId: fieldMaps.calendar_event["Meeting Type"],
      value: meetingType,
    });
  }

  // Interaction rows for each non-self attendee
  const startMs = Date.parse(startIso);
  const ageDays = Math.max(0, (Date.now() - startMs) / (1000 * 60 * 60 * 24));
  const baseWeight = meetingTypeWeight(totalAttendeeCount);
  const decay = recencyDecay(ageDays);

  for (const r of nonSelf) {
    const interactionId = randomUUID();
    emitInsertEntry(batch, { id: interactionId, objectId: ONBOARDING_OBJECT_IDS.interaction });
    if (fieldMaps.interaction["Type"]) {
      emitInsertField(batch, {
        entryId: interactionId,
        fieldId: fieldMaps.interaction["Type"],
        value: "Meeting",
      });
    }
    if (fieldMaps.interaction["Occurred At"]) {
      emitInsertField(batch, {
        entryId: interactionId,
        fieldId: fieldMaps.interaction["Occurred At"],
        value: startIso,
      });
    }
    if (fieldMaps.interaction["Person"]) {
      emitInsertField(batch, {
        entryId: interactionId,
        fieldId: fieldMaps.interaction["Person"],
        value: r.info.entryId,
      });
    }
    if (r.info.companyId && fieldMaps.interaction["Company"]) {
      emitInsertField(batch, {
        entryId: interactionId,
        fieldId: fieldMaps.interaction["Company"],
        value: r.info.companyId,
      });
    }
    if (fieldMaps.interaction["Event"]) {
      emitInsertField(batch, {
        entryId: interactionId,
        fieldId: fieldMaps.interaction["Event"],
        value: eventEntryId,
      });
    }
    if (fieldMaps.interaction["Direction"]) {
      emitInsertField(batch, {
        entryId: interactionId,
        fieldId: fieldMaps.interaction["Direction"],
        value: "Internal",
      });
    }
    const role: "organizer" | "attendee" =
      r.attendee.organizer || r.attendee.email === organizerEmail ? "organizer" : "attendee";
    const response: MeetingResponse =
      r.attendee.responseStatus === "tentative"
        ? "tentative"
        : r.attendee.responseStatus === "declined"
          ? "declined"
          : r.attendee.responseStatus === "accepted"
            ? "accepted"
            : "needsAction";
    const directness = meetingDirectness(role, response);
    const score = roundScore(baseWeight * decay * directness);
    if (fieldMaps.interaction["Score Contribution"]) {
      emitInsertField(batch, {
        entryId: interactionId,
        fieldId: fieldMaps.interaction["Score Contribution"],
        value: score,
      });
    }

    // Bump person.Last Interaction At
    if (fieldMaps.people["Last Interaction At"]) {
      emitUpsertField(batch, {
        entryId: r.info.entryId,
        fieldId: fieldMaps.people["Last Interaction At"],
        value: startIso,
      });
    }
  }

  const newPeople = cache.peopleByEmail.size - beforeCachedPeople;
  return { added: true, newPeople };
}

// ---------------------------------------------------------------------------
// Composio paging
// ---------------------------------------------------------------------------

async function fetchCalendarPage(opts: {
  connectionId: string;
  pageToken: string | null;
  pageSize: number;
  signal?: AbortSignal;
}): Promise<{
  events: CalendarEvent[];
  nextPageToken: string | null;
  syncToken: string | null;
}> {
  // Canonical slug per the gateway's `composio/tools/search` is
  // `GOOGLECALENDAR_EVENTS_LIST` (NOT `GOOGLECALENDAR_LIST_EVENTS`).
  // The toolkit's input params are camelCase here — `calendarId`,
  // `timeMin`, `timeMax`, `maxResults`, `pageToken`, `singleEvents`,
  // `orderBy` — not snake_case like Gmail's tools.
  const slug = await resolveToolSlug({
    toolkitSlug: "google-calendar",
    preferredSlugs: ["GOOGLECALENDAR_EVENTS_LIST"],
    signal: opts.signal,
  });
  try {
    const result = await executeComposioTool<CalendarListResponse>({
      toolSlug: slug,
      connectedAccountId: opts.connectionId,
      arguments: {
        calendarId: "primary",
        // Window must stay the same across paginated requests — Google
        // Calendar returns 400 if you drop timeMin/timeMax mid-pagination.
        timeMin: backfillTimeMin(),
        timeMax: backfillTimeMax(),
        maxResults: opts.pageSize,
        ...(opts.pageToken ? { pageToken: opts.pageToken } : {}),
        singleEvents: true,
        orderBy: "startTime",
      },
      signal: opts.signal,
      context: "calendar-page",
    });
    const data = result.data?.data ?? result.data;
    return {
      events: (data?.items ?? []),
      nextPageToken: typeof data?.nextPageToken === "string" ? data.nextPageToken : null,
      syncToken: typeof data?.nextSyncToken === "string" ? data.nextSyncToken : null,
    };
  } catch (err) {
    if (err instanceof ComposioToolNoConnectionError) {throw err;}
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public entry: backfill
// ---------------------------------------------------------------------------

export async function runCalendarBackfill(opts: CalendarSyncOptions): Promise<CalendarSyncSummary> {
  const dbPath = await duckdbPathAsync();
  if (!dbPath) {throw new Error("No workspace database found.");}
  const fieldMaps = await loadFieldMaps();
  const cache = await buildCache(fieldMaps);
  const overrides = readPersonalDomainsOverrides();
  const domainOverrides = { add: overrides.add, remove: overrides.remove };
  const selfEmails = new Set<string>();
  if (opts.selfEmail) {
    const key = normalizeEmailKey(opts.selfEmail) ?? opts.selfEmail.toLowerCase();
    selfEmails.add(key);
  }

  opts.onProgress?.({
    phase: "starting",
    message: "Connecting to Google Calendar…",
    eventsProcessed: 0,
    peopleProcessed: cache.peopleByEmail.size,
  });

  let pageToken: string | null = null;
  let pages = 0;
  let totalAdded = 0;
  let totalNewPeople = 0;
  let lastSyncToken: string | null = null;
  const pageSize = opts.pageSize ?? 250;
  const maxPages = opts.maxPages ?? Infinity;

  while (pages < maxPages) {
    if (opts.signal?.aborted) {throw opts.signal.reason ?? new Error("Aborted");}
    const page = await fetchCalendarPage({
      connectionId: opts.connectionId,
      pageToken,
      pageSize,
      signal: opts.signal,
    });

    if (page.events.length === 0 && !page.nextPageToken) {break;}

    const batch = new StatementBatch();
    let pageAdded = 0;
    let pageNewPeople = 0;
    for (const event of page.events) {
      const out = processEvent({
        event,
        selfEmails,
        domainOverrides,
        fieldMaps,
        cache,
        batch,
      });
      if (out.added) {pageAdded += 1;}
      pageNewPeople += out.newPeople;
    }
    if (!batch.isEmpty()) {
      const ok = await duckdbExecOnFileAsync(dbPath, batch.toSql());
      if (!ok) {throw new Error("Failed to commit Calendar page to DuckDB.");}
    }

    totalAdded += pageAdded;
    totalNewPeople += pageNewPeople;
    pages += 1;
    pageToken = page.nextPageToken;
    if (page.syncToken) {lastSyncToken = page.syncToken;}

    writeSyncCursors({
      calendar: {
        backfillPageToken: pageToken,
        eventsProcessed: cache.eventByGoogleId.size,
        syncToken: lastSyncToken ?? undefined,
      },
    });

    opts.onProgress?.({
      phase: "calendar",
      message: `Loaded ${cache.eventByGoogleId.size.toLocaleString()} events${
        pageToken ? " — still going…" : "."
      }`,
      eventsProcessed: cache.eventByGoogleId.size,
      peopleProcessed: cache.peopleByEmail.size,
    });

    if (!pageToken) {break;}
  }

  writeSyncCursors({
    calendar: {
      backfillPageToken: null,
      eventsProcessed: cache.eventByGoogleId.size,
      syncToken: lastSyncToken ?? undefined,
      lastBackfillCompletedAt: new Date().toISOString(),
    },
  });

  return {
    ok: true,
    eventsProcessed: totalAdded,
    peopleProcessed: totalNewPeople,
    pagesProcessed: pages,
    syncToken: lastSyncToken,
  };
}

// ---------------------------------------------------------------------------
// Public entry: incremental
// ---------------------------------------------------------------------------

export async function runCalendarIncremental(opts: {
  connectionId: string;
  syncToken: string;
  selfEmail?: string | null;
  signal?: AbortSignal;
}): Promise<CalendarSyncSummary> {
  const dbPath = await duckdbPathAsync();
  if (!dbPath) {throw new Error("No workspace database found.");}
  const fieldMaps = await loadFieldMaps();
  const cache = await buildCache(fieldMaps);
  const overrides = readPersonalDomainsOverrides();
  const domainOverrides = { add: overrides.add, remove: overrides.remove };
  const selfEmails = new Set<string>();
  if (opts.selfEmail) {
    const key = normalizeEmailKey(opts.selfEmail) ?? opts.selfEmail.toLowerCase();
    selfEmails.add(key);
  }

  const slug = await resolveToolSlug({
    toolkitSlug: "google-calendar",
    preferredSlugs: ["GOOGLECALENDAR_EVENTS_LIST"],
    signal: opts.signal,
  });
  const result = await executeComposioTool<CalendarListResponse>({
    toolSlug: slug,
    connectedAccountId: opts.connectionId,
    arguments: {
      calendarId: "primary",
      syncToken: opts.syncToken,
      singleEvents: true,
    },
    signal: opts.signal,
    context: "calendar-incremental",
  });
  const data = result.data?.data ?? result.data;
  const events = (data?.items ?? []);
  const batch = new StatementBatch();
  let added = 0;
  let newPeople = 0;
  for (const event of events) {
    const out = processEvent({
      event,
      selfEmails,
      domainOverrides,
      fieldMaps,
      cache,
      batch,
    });
    if (out.added) {added += 1;}
    newPeople += out.newPeople;
  }
  if (!batch.isEmpty()) {
    const ok = await duckdbExecOnFileAsync(dbPath, batch.toSql());
    if (!ok) {throw new Error("Calendar incremental commit failed.");}
  }
  const nextSyncToken = typeof data?.nextSyncToken === "string" ? data.nextSyncToken : opts.syncToken;
  writeSyncCursors({
    calendar: {
      syncToken: nextSyncToken,
      eventsProcessed: cache.eventByGoogleId.size,
      lastPolledAt: new Date().toISOString(),
    },
  });

  return {
    ok: true,
    eventsProcessed: added,
    peopleProcessed: newPeople,
    pagesProcessed: 1,
    syncToken: nextSyncToken,
  };
}

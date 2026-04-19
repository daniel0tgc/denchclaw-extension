/**
 * Gmail backfill + incremental sync.
 *
 * Pipeline:
 *
 *   1. `GMAIL_GET_PROFILE` → capture self email + baseline `historyId`.
 *   2. Page through `GMAIL_FETCH_EMAILS` until exhausted (resumable via
 *      `sync-cursors.json#gmail.backfillPageToken`).
 *   3. For each message: parse headers, upsert people/company/thread/message
 *      and one `interaction` row per non-self counterparty.
 *   4. After backfill, the runner calls `recomputeAllScores` so the
 *      People/Company `Strength Score` columns reflect the new interactions.
 *
 * Key correctness invariants:
 *
 * - Re-running on the same workspace is a no-op (uniqueness keyed on
 *   Gmail Message ID + Gmail Thread ID + lowercased email + root domain).
 * - A crash between pages loses ≤100 messages of work, never more — the
 *   page-token is flushed *before* we process the next page.
 * - "Self" addresses (the OAuthed mailbox + manual aliases) are excluded
 *   from People upserts so the user doesn't show up as their own contact.
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
  executeComposioTool,
  resolveToolSlug,
  invalidateToolSlug,
  ComposioToolNoConnectionError,
} from "./composio-execute";
import {
  parseEmailAddress,
  parseEmailAddressList,
  normalizeEmailKey,
  rootDomainFromEmail,
} from "./email-domain";
import { readPersonalDomainsOverrides, writeSyncCursors } from "./denchclaw-state";
import { roundScore, scoreEmailInteraction, type EmailRole } from "./strength-score";
import { classifySender, type SenderKind } from "./email-classifier";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GmailSyncProgress = {
  phase: "starting" | "gmail" | "scoring" | "complete" | "error";
  message: string;
  messagesProcessed: number;
  peopleProcessed: number;
  companiesProcessed: number;
  threadsProcessed: number;
  error?: string;
};

export type GmailSyncOptions = {
  connectionId: string;
  signal?: AbortSignal;
  onProgress?: (event: GmailSyncProgress) => void;
  /** Tightens the page size for tests; defaults to 100 (Composio cap is ~100). */
  pageSize?: number;
  /** Hard cap on pages processed in one run; defaults to Infinity. */
  maxPages?: number;
};

export type GmailSyncSummary = {
  ok: boolean;
  messagesProcessed: number;
  peopleProcessed: number;
  companiesProcessed: number;
  threadsProcessed: number;
  selfEmail: string | null;
  historyId: string | null;
  pagesProcessed: number;
  resumedFromPageToken: boolean;
  error?: string;
};

type ComposioGmailMessageHeader = { name: string; value: string };

/**
 * Composio normalizes the raw Gmail API response into top-level convenience
 * fields. We see both shapes in the wild:
 *
 * - `messageId` / `threadId` / `messageTimestamp` (ISO 8601) at the top level.
 * - `subject` / `sender` / `to` / `messageText` / `attachmentList` at the top level.
 * - `payload.headers[]` still carries the raw Gmail headers (From/To/Cc/Bcc/...),
 *   which is the only place we can find Cc/Bcc.
 *
 * `messageText` already contains the body; `attachmentList` is a non-empty
 * array iff there are attachments.
 */
type ComposioGmailMessage = {
  /** Composio normalized message id (canonical). */
  messageId?: string;
  /** Raw Gmail API id, included as a fallback in case Composio shape changes. */
  id?: string;
  threadId?: string;
  labelIds?: string[];
  /** ISO 8601 string. */
  messageTimestamp?: string;
  /** Legacy raw Gmail epoch-ms string. */
  internalDate?: string;
  subject?: string;
  /** "Display Name <email@host>" or just the address. */
  sender?: string;
  /** Comma-separated To recipients. */
  to?: string;
  /** Full decoded body. Empty when fetched with `verbose: false`. */
  messageText?: string;
  attachmentList?: unknown[];
  snippet?: string;
  display_url?: string;
  /** Composio's "metadata" view of the message — has `body` (snippet) + `subject`. */
  preview?: {
    body?: string;
    subject?: string;
  };
  payload?: {
    headers?: ComposioGmailMessageHeader[];
    parts?: Array<{ mimeType?: string; body?: { data?: string } }>;
    body?: { data?: string };
    mimeType?: string;
  };
};

type ComposioGmailFetchResponse = {
  data?: {
    messages?: ComposioGmailMessage[];
    nextPageToken?: string | null;
    historyId?: string;
    resultSizeEstimate?: number;
  };
  successful?: boolean;
  error?: string | null;
  // The gateway sometimes flattens to top-level shape; tolerate both.
  messages?: ComposioGmailMessage[];
  nextPageToken?: string | null;
  historyId?: string;
};

type ComposioGmailProfileResponse = {
  data?: {
    emailAddress?: string;
    historyId?: string;
    messagesTotal?: number;
  };
  emailAddress?: string;
  historyId?: string;
  messagesTotal?: number;
};

// ---------------------------------------------------------------------------
// Field-id resolution
// ---------------------------------------------------------------------------

type FieldIdMaps = {
  people: Record<string, string>;
  company: Record<string, string>;
  email_thread: Record<string, string>;
  email_message: Record<string, string>;
  interaction: Record<string, string>;
};

async function loadFieldIdMaps(): Promise<FieldIdMaps> {
  // Serialize the field-map lookups instead of running them concurrently:
  // each call spawns a duckdb CLI process that takes the file lock, and
  // five concurrent processes thrash the lock — most lose and return
  // empty maps silently, which then breaks the upsert pipeline because
  // `fieldMaps.people["Full Name"]` evaluates to undefined and we skip
  // the entry_fields INSERTs.
  const people = await fetchFieldIdMap(ONBOARDING_OBJECT_IDS.people);
  const company = await fetchFieldIdMap(ONBOARDING_OBJECT_IDS.company);
  const email_thread = await fetchFieldIdMap(ONBOARDING_OBJECT_IDS.email_thread);
  const email_message = await fetchFieldIdMap(ONBOARDING_OBJECT_IDS.email_message);
  const interaction = await fetchFieldIdMap(ONBOARDING_OBJECT_IDS.interaction);
  return { people, company, email_thread, email_message, interaction };
}

// ---------------------------------------------------------------------------
// Existing-row caches (loaded once, mutated as we insert)
// ---------------------------------------------------------------------------

type SyncCache = {
  /** lowercased email (post `normalizeEmailKey`) → people entry_id */
  peopleByEmail: Map<string, string>;
  /** root domain → company entry_id */
  companyByDomain: Map<string, string>;
  /** Gmail Thread ID → email_thread entry_id */
  threadByGmailId: Map<string, string>;
  /** Gmail Message ID → email_message entry_id (skip dup inserts) */
  messageByGmailId: Set<string>;
  /** Per-thread aggregate state, keyed by thread entry_id */
  threadState: Map<
    string,
    {
      messageCount: number;
      lastMessageAt: number;
      participants: Set<string>;
      companies: Set<string>;
    }
  >;
};

async function buildCacheFromDb(fieldMaps: FieldIdMaps): Promise<SyncCache> {
  const cache: SyncCache = {
    peopleByEmail: new Map(),
    companyByDomain: new Map(),
    threadByGmailId: new Map(),
    messageByGmailId: new Set(),
    threadState: new Map(),
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

  const threadGmailFieldId = fieldMaps.email_thread["Gmail Thread ID"];
  if (threadGmailFieldId) {
    const rows = await duckdbQueryAsync<{ entry_id: string; value: string }>(
      `SELECT entry_id, value FROM entry_fields WHERE field_id = '${threadGmailFieldId}';`,
    );
    for (const row of rows) {
      const id = row.value?.trim();
      if (id) {cache.threadByGmailId.set(id, row.entry_id);}
    }
  }

  const messageGmailFieldId = fieldMaps.email_message["Gmail Message ID"];
  if (messageGmailFieldId) {
    const rows = await duckdbQueryAsync<{ value: string }>(
      `SELECT value FROM entry_fields WHERE field_id = '${messageGmailFieldId}';`,
    );
    for (const row of rows) {
      const id = row.value?.trim();
      if (id) {cache.messageByGmailId.add(id);}
    }
  }

  return cache;
}

// ---------------------------------------------------------------------------
// SQL helpers (escape + builders)
// ---------------------------------------------------------------------------

function sql(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) {return "NULL";}
  if (typeof value === "boolean") {return value ? "true" : "false";}
  if (typeof value === "number") {return Number.isFinite(value) ? String(value) : "NULL";}
  return `'${value.replace(/'/g, "''")}'`;
}

type PendingStatement = string;

class StatementBatch {
  private parts: PendingStatement[] = [];

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
  batch.add(
    `INSERT INTO entries (id, object_id) VALUES (${sql(params.id)}, ${sql(params.objectId)})`,
  );
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
  // entry_fields has UNIQUE(entry_id, field_id) → use DELETE + INSERT
  // pattern (DuckDB doesn't support ON CONFLICT semantics universally for
  // composite uniques as of the version we're on).
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
    `DELETE FROM entry_fields WHERE entry_id = ${sql(params.entryId)} AND field_id = ${sql(
      params.fieldId,
    )}`,
  );
  batch.add(
    `INSERT INTO entry_fields (entry_id, field_id, value) VALUES (${sql(params.entryId)}, ${sql(
      params.fieldId,
    )}, ${sql(value)})`,
  );
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

function getHeader(message: ComposioGmailMessage, name: string): string | null {
  const headers = message.payload?.headers ?? [];
  const target = name.toLowerCase();
  for (const header of headers) {
    if (header.name?.toLowerCase() === target) {
      return header.value ?? null;
    }
  }
  return null;
}

/**
 * Resolve the timestamp using whichever shape Composio returned for this
 * message. Order of preference: ISO `messageTimestamp` (Composio normalized),
 * legacy `internalDate` (epoch ms string), then the `Date:` header. Falls
 * back to "now" if none parse so a malformed message doesn't crash the
 * whole page commit.
 */
function parseInternalDate(message: ComposioGmailMessage): number {
  const iso = message.messageTimestamp;
  if (iso) {
    const ts = Date.parse(iso);
    if (Number.isFinite(ts)) {return ts;}
  }
  const epoch = message.internalDate;
  if (epoch) {
    const num = Number(epoch);
    if (Number.isFinite(num)) {return num;}
  }
  const dateHeader = getHeader(message, "Date");
  if (dateHeader) {
    const ts = Date.parse(dateHeader);
    if (Number.isFinite(ts)) {return ts;}
  }
  return Date.now();
}

/**
 * Read a header preferring Composio's flat top-level fields (`subject`,
 * `sender`, `to`) before falling back to `payload.headers[]`. Cc/Bcc are
 * only present in the headers array.
 */
function readMessageHeader(
  message: ComposioGmailMessage,
  header: "From" | "To" | "Cc" | "Bcc" | "Subject",
): string | null {
  switch (header) {
    case "From":
      return message.sender ?? getHeader(message, "From");
    case "To":
      return message.to ?? getHeader(message, "To");
    case "Subject":
      return message.subject ?? getHeader(message, "Subject");
    case "Cc":
    case "Bcc":
      return getHeader(message, header);
  }
}

function decodeBase64Url(value: string): string {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const base64 = `${padded}${padding}`;
    return Buffer.from(base64, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

function extractBodyPreview(message: ComposioGmailMessage): { preview: string; body: string } {
  // Body content sources in priority order — HTML wins so that the
  // sandboxed iframe in the inbox renders a real email instead of a
  // plain-text mirror image:
  //   1. text/html part walked from `payload` (richest render).
  //   2. text/plain part walked from `payload`.
  //   3. `messageText` — Composio's normalized plain-text body (only
  //      present when the page was fetched with `verbose: true`; always
  //      plain text, never HTML).
  //   4. `preview.body` — Composio's HTML-decoded snippet, present in
  //      both verbose and metadata-only modes.
  //   5. `snippet` — raw Gmail snippet, only there in raw-API responses.
  //
  // We always store *some* preview so the UI doesn't render an empty
  // cell for "Body Preview"; the full body is only persisted when we
  // actually have it (HTML preferred, plain text accepted).
  let htmlBody = "";
  let textBody = "";

  function walk(part: ComposioGmailMessage["payload"] | undefined): void {
    if (!part) {return;}
    const mime = (part.mimeType ?? "").toLowerCase();
    const data = part.body?.data;
    if (typeof data === "string" && data) {
      const decoded = decodeBase64Url(data);
      if (decoded) {
        if (mime.startsWith("text/html") && !htmlBody) {
          htmlBody = decoded;
        } else if ((mime.startsWith("text/plain") || !mime) && !textBody) {
          textBody = decoded;
        }
      }
    }
    for (const child of part.parts ?? []) {
      walk(child);
    }
  }
  walk(message.payload);

  const direct = (message.messageText ?? "").trim();
  const body = htmlBody || textBody || direct || "";

  // Preview should always be plain text — it's shown inline in lists,
  // not rendered as HTML. Prefer the actual snippets over stripped HTML.
  const previewSource =
    (message.snippet ?? "").trim() ||
    (message.preview?.body ?? "").trim() ||
    direct ||
    textBody ||
    htmlBody;
  const preview = previewSource.replace(/\s+/g, " ").slice(0, 500);

  return { preview, body };
}

function hasAttachments(message: ComposioGmailMessage): boolean {
  if (Array.isArray(message.attachmentList) && message.attachmentList.length > 0) {
    return true;
  }
  const payload = message.payload;
  function walk(part: ComposioGmailMessage["payload"] | undefined): boolean {
    if (!part) {return false;}
    if (part.parts) {
      for (const child of part.parts) {
        const mime = (child.mimeType ?? "").toLowerCase();
        if (mime && !mime.startsWith("text/") && !mime.startsWith("multipart/")) {
          return true;
        }
        if (walk(child)) {return true;}
      }
    }
    return false;
  }
  return walk(payload);
}

// ---------------------------------------------------------------------------
// Self-identity
// ---------------------------------------------------------------------------

async function fetchSelfProfile(opts: {
  connectionId: string;
  signal?: AbortSignal;
}): Promise<{ email: string | null; historyId: string | null }> {
  const slug = await resolveToolSlug({
    toolkitSlug: "gmail",
    preferredSlugs: ["GMAIL_GET_PROFILE"],
    signal: opts.signal,
  });
  const result = await executeComposioTool<ComposioGmailProfileResponse>({
    toolSlug: slug,
    connectedAccountId: opts.connectionId,
    arguments: { user_id: "me" },
    signal: opts.signal,
    context: "gmail-profile",
  });
  const data = result.data?.data ?? result.data;
  return {
    email: typeof data?.emailAddress === "string" ? data.emailAddress.toLowerCase() : null,
    historyId: typeof data?.historyId === "string" ? data.historyId : null,
  };
}

// ---------------------------------------------------------------------------
// One-message ingestion (mutates `cache`, appends SQL to `batch`)
// ---------------------------------------------------------------------------

type ProcessOutcome = {
  added: boolean;
  newPeople: number;
  newCompanies: number;
  newThread: boolean;
  interactionsCreated: number;
};

function processMessage(params: {
  message: ComposioGmailMessage;
  selfEmails: Set<string>;
  domainOverrides: { add: string[]; remove: string[] };
  fieldMaps: FieldIdMaps;
  cache: SyncCache;
  batch: StatementBatch;
}): ProcessOutcome {
  const { message, selfEmails, domainOverrides, fieldMaps, cache, batch } = params;
  // Composio puts the canonical id in `messageId`; older shapes use raw
  // Gmail's `id`. Accept both so we don't silently drop messages on a
  // gateway/Composio response shape change.
  const messageId = (message.messageId ?? message.id)?.trim();
  const threadId = message.threadId?.trim();
  if (!messageId || !threadId) {
    return { added: false, newPeople: 0, newCompanies: 0, newThread: false, interactionsCreated: 0 };
  }
  if (cache.messageByGmailId.has(messageId)) {
    // Already ingested in a prior run.
    return { added: false, newPeople: 0, newCompanies: 0, newThread: false, interactionsCreated: 0 };
  }

  const fromHeader = readMessageHeader(message, "From");
  const toHeader = readMessageHeader(message, "To");
  const ccHeader = readMessageHeader(message, "Cc");
  const subject = (readMessageHeader(message, "Subject") ?? "").trim();
  const sentAtMs = parseInternalDate(message);
  const sentAtIso = new Date(sentAtMs).toISOString();
  const fromParsed = parseEmailAddress(fromHeader);
  const toParsed = parseEmailAddressList(toHeader);
  const ccParsed = parseEmailAddressList(ccHeader);
  const { preview, body } = extractBodyPreview(message);
  const hasAttach = hasAttachments(message);

  // Classify the sender BEFORE we promote anyone to People/Company. For
  // bulk mail (newsletters, receipts, notifications, mailing lists,
  // automated system mail) we still insert the email_message row so the
  // user can search it, but we do NOT create a Person row for the sender,
  // do NOT auto-create the sender's domain as a Company, and do NOT emit
  // an Interaction row from the sender side. Recipients (To/Cc) keep
  // going through ensurePerson because a real coworker CC'd on a
  // forwarded newsletter is still a relationship signal.
  const fromKey = fromParsed ? normalizeEmailKey(fromParsed.address) : null;
  const verdict = classifySender({
    fromAddress: fromParsed?.address ?? null,
    toAddresses: toParsed.map((t) => t.address),
    ccAddresses: ccParsed.map((c) => c.address),
    selfEmails,
    subject,
    labelIds: message.labelIds ?? [],
    getHeader: (name) => getHeader(message, name),
    senderIsKnownContact: fromKey ? cache.peopleByEmail.has(fromKey) : false,
  });
  const skipFromGraph = verdict.isBulk;

  let newPeople = 0;
  let newCompanies = 0;

  // Helper: upsert a person + their company; return the entry_id.
  function ensurePerson(
    parsedAddress: ReturnType<typeof parseEmailAddress>,
  ): { entryId: string; isSelf: boolean } | null {
    if (!parsedAddress) {return null;}
    const key = normalizeEmailKey(parsedAddress.address);
    if (!key) {return null;}
    const isSelf = selfEmails.has(key);
    const cachedId = cache.peopleByEmail.get(key);
    if (cachedId) {
      return { entryId: cachedId, isSelf };
    }
    if (isSelf) {
      // Don't create a People row for the user's own mailbox.
      return { entryId: "", isSelf };
    }

    const entryId = randomUUID();
    cache.peopleByEmail.set(key, entryId);
    newPeople += 1;
    emitInsertEntry(batch, { id: entryId, objectId: ONBOARDING_OBJECT_IDS.people });
    if (fieldMaps.people["Full Name"] && parsedAddress.name) {
      emitInsertField(batch, {
        entryId,
        fieldId: fieldMaps.people["Full Name"],
        value: parsedAddress.name,
      });
    }
    if (fieldMaps.people["Email Address"]) {
      emitInsertField(batch, {
        entryId,
        fieldId: fieldMaps.people["Email Address"],
        value: parsedAddress.address,
      });
    }
    if (fieldMaps.people["Source"]) {
      emitInsertField(batch, {
        entryId,
        fieldId: fieldMaps.people["Source"],
        value: "Gmail",
      });
    }

    // Company auto-create
    const domain = rootDomainFromEmail(parsedAddress.address, domainOverrides);
    if (domain) {
      let companyId = cache.companyByDomain.get(domain);
      if (!companyId) {
        companyId = randomUUID();
        cache.companyByDomain.set(domain, companyId);
        newCompanies += 1;
        emitInsertEntry(batch, { id: companyId, objectId: ONBOARDING_OBJECT_IDS.company });
        if (fieldMaps.company["Company Name"]) {
          emitInsertField(batch, {
            entryId: companyId,
            fieldId: fieldMaps.company["Company Name"],
            value: deriveCompanyNameFromDomain(domain),
          });
        }
        if (fieldMaps.company["Domain"]) {
          emitInsertField(batch, {
            entryId: companyId,
            fieldId: fieldMaps.company["Domain"],
            value: domain,
          });
        }
        if (fieldMaps.company["Source"]) {
          emitInsertField(batch, {
            entryId: companyId,
            fieldId: fieldMaps.company["Source"],
            value: "Gmail",
          });
        }
      }
      // Link person → company via the legacy "Company" text field for v_people compat.
      if (fieldMaps.people["Company"]) {
        emitInsertField(batch, {
          entryId,
          fieldId: fieldMaps.people["Company"],
          value: deriveCompanyNameFromDomain(domain),
        });
      }
    }

    return { entryId, isSelf };
  }

  // For bulk senders, skip the Person + Company auto-create and pretend
  // the From counterparty doesn't exist in the People graph. The
  // email_message itself still gets the sender headers stored as raw text.
  const fromInfo = skipFromGraph ? null : ensurePerson(fromParsed);
  const toInfos = toParsed.map((p) => ({ parsed: p, info: ensurePerson(p) }));
  const ccInfos = ccParsed.map((p) => ({ parsed: p, info: ensurePerson(p) }));

  // ---- Thread upsert ----
  let threadEntryId = cache.threadByGmailId.get(threadId);
  let newThread = false;
  if (!threadEntryId) {
    threadEntryId = randomUUID();
    cache.threadByGmailId.set(threadId, threadEntryId);
    cache.threadState.set(threadEntryId, {
      messageCount: 0,
      lastMessageAt: 0,
      participants: new Set<string>(),
      companies: new Set<string>(),
    });
    newThread = true;
    emitInsertEntry(batch, { id: threadEntryId, objectId: ONBOARDING_OBJECT_IDS.email_thread });
    if (fieldMaps.email_thread["Subject"]) {
      emitInsertField(batch, {
        entryId: threadEntryId,
        fieldId: fieldMaps.email_thread["Subject"],
        value: subject || "(no subject)",
      });
    }
    if (fieldMaps.email_thread["Gmail Thread ID"]) {
      emitInsertField(batch, {
        entryId: threadEntryId,
        fieldId: fieldMaps.email_thread["Gmail Thread ID"],
        value: threadId,
      });
    }
  }

  const threadState = cache.threadState.get(threadEntryId)!;
  threadState.messageCount += 1;
  if (sentAtMs > threadState.lastMessageAt) {
    threadState.lastMessageAt = sentAtMs;
  }
  for (const info of [fromInfo, ...toInfos.map((t) => t.info), ...ccInfos.map((c) => c.info)]) {
    if (info && info.entryId && !info.isSelf) {
      threadState.participants.add(info.entryId);
    }
  }
  // Don't link the bulk sender's domain to the thread's Companies — we
  // don't want every "Stripe Receipt" thread to falsely tag the company
  // "Stripe" if Stripe also has real human contacts in the workspace.
  const addressesForCompanies = skipFromGraph
    ? [...toParsed, ...ccParsed]
    : [fromParsed, ...toParsed, ...ccParsed];
  for (const parsed of addressesForCompanies) {
    if (!parsed) {continue;}
    const domain = rootDomainFromEmail(parsed.address, domainOverrides);
    if (domain) {
      const companyId = cache.companyByDomain.get(domain);
      if (companyId) {threadState.companies.add(companyId);}
    }
  }

  // ---- Message insert ----
  const messageEntryId = randomUUID();
  cache.messageByGmailId.add(messageId);
  emitInsertEntry(batch, { id: messageEntryId, objectId: ONBOARDING_OBJECT_IDS.email_message });
  if (fieldMaps.email_message["Gmail Message ID"]) {
    emitInsertField(batch, {
      entryId: messageEntryId,
      fieldId: fieldMaps.email_message["Gmail Message ID"],
      value: messageId,
    });
  }
  if (fieldMaps.email_message["Subject"]) {
    emitInsertField(batch, {
      entryId: messageEntryId,
      fieldId: fieldMaps.email_message["Subject"],
      value: subject,
    });
  }
  if (fieldMaps.email_message["Sent At"]) {
    emitInsertField(batch, {
      entryId: messageEntryId,
      fieldId: fieldMaps.email_message["Sent At"],
      value: sentAtIso,
    });
  }
  if (fieldMaps.email_message["From"] && fromInfo?.entryId && !fromInfo.isSelf) {
    emitInsertField(batch, {
      entryId: messageEntryId,
      fieldId: fieldMaps.email_message["From"],
      value: fromInfo.entryId,
    });
  }
  const toIds = toInfos
    .map((t) => t.info?.entryId)
    .filter((id): id is string => Boolean(id) && !toInfos.find((x) => x.info?.entryId === id)?.info?.isSelf);
  if (fieldMaps.email_message["To"] && toIds.length > 0) {
    emitInsertField(batch, {
      entryId: messageEntryId,
      fieldId: fieldMaps.email_message["To"],
      value: JSON.stringify(toIds),
    });
  }
  const ccIds = ccInfos
    .map((c) => c.info?.entryId)
    .filter((id): id is string => Boolean(id) && !ccInfos.find((x) => x.info?.entryId === id)?.info?.isSelf);
  if (fieldMaps.email_message["Cc"] && ccIds.length > 0) {
    emitInsertField(batch, {
      entryId: messageEntryId,
      fieldId: fieldMaps.email_message["Cc"],
      value: JSON.stringify(ccIds),
    });
  }
  if (fieldMaps.email_message["Thread"]) {
    emitInsertField(batch, {
      entryId: messageEntryId,
      fieldId: fieldMaps.email_message["Thread"],
      value: threadEntryId,
    });
  }
  if (fieldMaps.email_message["Body Preview"]) {
    emitInsertField(batch, {
      entryId: messageEntryId,
      fieldId: fieldMaps.email_message["Body Preview"],
      value: preview,
    });
  }
  if (fieldMaps.email_message["Body"] && body) {
    emitInsertField(batch, {
      entryId: messageEntryId,
      fieldId: fieldMaps.email_message["Body"],
      value: body.slice(0, 50_000),
    });
  }
  if (fieldMaps.email_message["Has Attachments"]) {
    emitInsertField(batch, {
      entryId: messageEntryId,
      fieldId: fieldMaps.email_message["Has Attachments"],
      value: hasAttach ? "true" : "false",
    });
  }
  if (fieldMaps.email_message["Sender Type"]) {
    emitInsertField(batch, {
      entryId: messageEntryId,
      fieldId: fieldMaps.email_message["Sender Type"],
      value: senderKindToLabel(verdict.kind),
    });
  }

  // ---- Interaction rows: one per non-self counterparty ----
  const ageDays = Math.max(0, (Date.now() - sentAtMs) / (1000 * 60 * 60 * 24));
  const direction: "Sent" | "Received" | "Internal" = fromInfo?.isSelf
    ? "Sent"
    : toInfos.some((t) => t.info?.isSelf) || ccInfos.some((c) => c.info?.isSelf)
      ? "Received"
      : "Internal";
  const interactionDirectionEnum = direction;

  let interactionsCreated = 0;
  function emitInteraction(personEntryId: string, role: EmailRole): void {
    if (!personEntryId) {return;}
    const interactionId = randomUUID();
    interactionsCreated += 1;
    emitInsertEntry(batch, { id: interactionId, objectId: ONBOARDING_OBJECT_IDS.interaction });
    if (fieldMaps.interaction["Type"]) {
      emitInsertField(batch, {
        entryId: interactionId,
        fieldId: fieldMaps.interaction["Type"],
        value: "Email",
      });
    }
    if (fieldMaps.interaction["Occurred At"]) {
      emitInsertField(batch, {
        entryId: interactionId,
        fieldId: fieldMaps.interaction["Occurred At"],
        value: sentAtIso,
      });
    }
    if (fieldMaps.interaction["Person"]) {
      emitInsertField(batch, {
        entryId: interactionId,
        fieldId: fieldMaps.interaction["Person"],
        value: personEntryId,
      });
    }
    if (fieldMaps.interaction["Email"]) {
      emitInsertField(batch, {
        entryId: interactionId,
        fieldId: fieldMaps.interaction["Email"],
        value: messageEntryId,
      });
    }
    if (fieldMaps.interaction["Direction"]) {
      emitInsertField(batch, {
        entryId: interactionId,
        fieldId: fieldMaps.interaction["Direction"],
        value: interactionDirectionEnum,
      });
    }
    const score = roundScore(
      scoreEmailInteraction({
        ageDays,
        role,
        // We don't have full thread topology in one page yet; bonuses get
        // re-applied during nightly recompute when we have the full graph.
      }),
    );
    if (fieldMaps.interaction["Score Contribution"]) {
      emitInsertField(batch, {
        entryId: interactionId,
        fieldId: fieldMaps.interaction["Score Contribution"],
        value: score,
      });
    }
  }

  if (fromInfo && !fromInfo.isSelf && fromInfo.entryId) {
    emitInteraction(fromInfo.entryId, "from");
  }
  for (const t of toInfos) {
    if (t.info && !t.info.isSelf && t.info.entryId) {emitInteraction(t.info.entryId, "to");}
  }
  for (const c of ccInfos) {
    if (c.info && !c.info.isSelf && c.info.entryId) {emitInteraction(c.info.entryId, "cc");}
  }

  // Update People.Last Interaction At for everyone we touched.
  for (const info of [fromInfo, ...toInfos.map((t) => t.info), ...ccInfos.map((c) => c.info)]) {
    if (!info || info.isSelf || !info.entryId) {continue;}
    if (fieldMaps.people["Last Interaction At"]) {
      emitUpsertField(batch, {
        entryId: info.entryId,
        fieldId: fieldMaps.people["Last Interaction At"],
        value: sentAtIso,
      });
    }
  }

  return {
    added: true,
    newPeople,
    newCompanies,
    newThread,
    interactionsCreated,
  };
}

function deriveCompanyNameFromDomain(domain: string): string {
  // "acme.co.uk" → "Acme"; "media-design.com" → "Media Design"
  const head = domain.split(".")[0];
  return head
    .split(/[-_]/g)
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");
}

/**
 * Map the classifier's lowercase `SenderKind` to the human label used in
 * the `email_message.Sender Type` enum (must match the values declared in
 * SENDER_TYPE_ENUM_VALUES in workspace-schema-migrations.ts).
 */
function senderKindToLabel(kind: SenderKind): string {
  switch (kind) {
    case "person":
      return "Person";
    case "marketing":
      return "Marketing";
    case "transactional":
      return "Transactional";
    case "notification":
      return "Notification";
    case "mailing_list":
      return "Mailing List";
    case "automated":
      return "Automated";
  }
}

// ---------------------------------------------------------------------------
// Per-page driver
// ---------------------------------------------------------------------------

function flushThreadAggregates(params: {
  cache: SyncCache;
  fieldMaps: FieldIdMaps;
  batch: StatementBatch;
  touchedThreads: Set<string>;
}): void {
  for (const threadEntryId of params.touchedThreads) {
    const state = params.cache.threadState.get(threadEntryId);
    if (!state) {continue;}
    if (params.fieldMaps.email_thread["Message Count"]) {
      emitUpsertField(params.batch, {
        entryId: threadEntryId,
        fieldId: params.fieldMaps.email_thread["Message Count"],
        value: state.messageCount,
      });
    }
    if (state.lastMessageAt > 0 && params.fieldMaps.email_thread["Last Message At"]) {
      emitUpsertField(params.batch, {
        entryId: threadEntryId,
        fieldId: params.fieldMaps.email_thread["Last Message At"],
        value: new Date(state.lastMessageAt).toISOString(),
      });
    }
    if (params.fieldMaps.email_thread["Participants"] && state.participants.size > 0) {
      emitUpsertField(params.batch, {
        entryId: threadEntryId,
        fieldId: params.fieldMaps.email_thread["Participants"],
        value: JSON.stringify(Array.from(state.participants)),
      });
    }
    if (params.fieldMaps.email_thread["Companies"] && state.companies.size > 0) {
      emitUpsertField(params.batch, {
        entryId: threadEntryId,
        fieldId: params.fieldMaps.email_thread["Companies"],
        value: JSON.stringify(Array.from(state.companies)),
      });
    }
  }
}

async function fetchPage(opts: {
  connectionId: string;
  pageToken: string | null;
  pageSize: number;
  signal?: AbortSignal;
}): Promise<{
  messages: ComposioGmailMessage[];
  nextPageToken: string | null;
  historyId: string | null;
}> {
  const slug = await resolveToolSlug({
    toolkitSlug: "gmail",
    preferredSlugs: ["GMAIL_FETCH_EMAILS"],
    signal: opts.signal,
  });
  try {
    const result = await executeComposioTool<ComposioGmailFetchResponse>({
      toolSlug: slug,
      connectedAccountId: opts.connectionId,
      arguments: {
        user_id: "me",
        max_results: opts.pageSize,
        page_token: opts.pageToken ?? "",
        query: "in:anywhere -in:spam -in:trash",
        ids_only: false,
        // verbose=false uses Composio's optimized "metadata only" path:
        // ~75% smaller payload, returns subject/sender/recipient/time/labels
        // — everything we need for People/Company/Thread linking + ranking.
        // verbose=true at 100 messages/page hits Composio's HTTP 413 cap;
        // bodies + attachments are fetched lazily when the user opens an
        // individual thread.
        verbose: false,
        include_spam_trash: false,
      },
      signal: opts.signal,
      context: "gmail-page",
    });
    const data = result.data?.data ?? result.data;
    const messages = (data?.messages ?? []);
    return {
      messages,
      nextPageToken: typeof data?.nextPageToken === "string" ? data.nextPageToken : null,
      historyId: typeof data?.historyId === "string" ? data.historyId : null,
    };
  } catch (err) {
    if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 404) {
      // Likely a renamed slug — invalidate cache and retry once.
      invalidateToolSlug("gmail", ["GMAIL_FETCH_EMAILS"]);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public entry: backfill
// ---------------------------------------------------------------------------

export async function runGmailBackfill(opts: GmailSyncOptions): Promise<GmailSyncSummary> {
  const dbPath = await duckdbPathAsync();
  if (!dbPath) {
    throw new Error("No workspace database found. Open or create a workspace first.");
  }

  opts.onProgress?.({
    phase: "starting",
    message: "Connecting to Gmail…",
    messagesProcessed: 0,
    peopleProcessed: 0,
    companiesProcessed: 0,
    threadsProcessed: 0,
  });

  const fieldMaps = await loadFieldIdMaps();
  const profile = await fetchSelfProfile({ connectionId: opts.connectionId, signal: opts.signal });
  const selfEmail = profile.email;
  const selfEmails = new Set<string>();
  if (selfEmail) {selfEmails.add(normalizeEmailKey(selfEmail) ?? selfEmail);}

  const cache = await buildCacheFromDb(fieldMaps);
  const overrides = readPersonalDomainsOverrides();
  const domainOverrides = { add: overrides.add, remove: overrides.remove };

  // Resume from cursor if present.
  let pageToken: string | null = null;
  let resumed = false;
  let totalMessages = 0;
  let totalPeople = 0;
  let totalCompanies = 0;
  let totalThreads = 0;
  let pages = 0;
  // 50 messages/page in metadata mode keeps the gateway response well under
  // the ~1MB Composio cap even for inboxes with very long threading
  // headers. The Composio max for `max_results` is 100; we cap lower for
  // headroom against unusually heavy headers (DKIM bundles, etc).
  const pageSize = opts.pageSize ?? 50;
  const maxPages = opts.maxPages ?? Infinity;

  // Persist a "started" marker so a refresh shows progress instead of
  // re-running the profile fetch from scratch.
  writeSyncCursors({
    gmail: {
      backfillPageToken: null,
      messagesProcessed: cache.messageByGmailId.size,
    },
  });

  while (pages < maxPages) {
    if (opts.signal?.aborted) {
      throw opts.signal.reason ?? new Error("Aborted");
    }

    const page = await fetchPage({
      connectionId: opts.connectionId,
      pageToken,
      pageSize,
      signal: opts.signal,
    });

    if (page.messages.length === 0 && !page.nextPageToken) {
      // Empty page = nothing to do, exit cleanly.
      break;
    }

    const batch = new StatementBatch();
    const touchedThreads = new Set<string>();
    let pageNewMessages = 0;
    let pageNewPeople = 0;
    let pageNewCompanies = 0;
    let pageNewThreads = 0;

    for (const message of page.messages) {
      const outcome = processMessage({
        message,
        selfEmails,
        domainOverrides,
        fieldMaps,
        cache,
        batch,
      });
      if (outcome.added) {
        pageNewMessages += 1;
        if (message.threadId) {
          const tid = cache.threadByGmailId.get(message.threadId);
          if (tid) {touchedThreads.add(tid);}
        }
      }
      pageNewPeople += outcome.newPeople;
      pageNewCompanies += outcome.newCompanies;
      if (outcome.newThread) {pageNewThreads += 1;}
    }

    flushThreadAggregates({ cache, fieldMaps, batch, touchedThreads });

    if (!batch.isEmpty()) {
      const sql = batch.toSql();
      const ok = await duckdbExecOnFileAsync(dbPath, sql);
      if (!ok) {
        const preview = sql.length > 600 ? `${sql.slice(0, 300)}\n...\n${sql.slice(-300)}` : sql;
        throw new Error(`Failed to commit Gmail page to DuckDB. SQL preview:\n${preview}`);
      }
    }

    totalMessages += pageNewMessages;
    totalPeople += pageNewPeople;
    totalCompanies += pageNewCompanies;
    totalThreads += pageNewThreads;
    pages += 1;

    pageToken = page.nextPageToken;

    // Persist cursor *after* we've committed the page so a crash doesn't lose work.
    writeSyncCursors({
      gmail: {
        backfillPageToken: pageToken,
        messagesProcessed: cache.messageByGmailId.size,
        historyId: page.historyId ?? profile.historyId ?? undefined,
      },
    });

    opts.onProgress?.({
      phase: "gmail",
      message: `Loaded ${cache.messageByGmailId.size.toLocaleString()} messages, ${
        cache.peopleByEmail.size
      } people, ${cache.companyByDomain.size} companies${pageToken ? " — still going…" : "."}`,
      messagesProcessed: cache.messageByGmailId.size,
      peopleProcessed: cache.peopleByEmail.size,
      companiesProcessed: cache.companyByDomain.size,
      threadsProcessed: cache.threadByGmailId.size,
    });

    if (!pageToken) {break;}
    if (!resumed && pageToken !== null) {resumed = true;}
  }

  // Mark backfill complete in the cursor file.
  writeSyncCursors({
    gmail: {
      backfillPageToken: null,
      messagesProcessed: cache.messageByGmailId.size,
      historyId: profile.historyId ?? undefined,
      lastBackfillCompletedAt: new Date().toISOString(),
    },
  });

  return {
    ok: true,
    messagesProcessed: totalMessages,
    peopleProcessed: totalPeople,
    companiesProcessed: totalCompanies,
    threadsProcessed: totalThreads,
    selfEmail,
    historyId: profile.historyId,
    pagesProcessed: pages,
    resumedFromPageToken: resumed,
  };
}

// ---------------------------------------------------------------------------
// Public entry: incremental polling
// ---------------------------------------------------------------------------

type ComposioGmailHistoryResponse = {
  data?: {
    history?: Array<{ messages?: Array<{ id: string }>; messagesAdded?: Array<{ message: { id: string } }> }>;
    historyId?: string;
  };
  history?: Array<{ messages?: Array<{ id: string }>; messagesAdded?: Array<{ message: { id: string } }> }>;
  historyId?: string;
};

export async function runGmailIncremental(opts: {
  connectionId: string;
  startHistoryId: string;
  signal?: AbortSignal;
  onProgress?: (event: GmailSyncProgress) => void;
}): Promise<GmailSyncSummary> {
  const dbPath = await duckdbPathAsync();
  if (!dbPath) {throw new Error("No workspace database found.");}
  const fieldMaps = await loadFieldIdMaps();
  const profile = await fetchSelfProfile({ connectionId: opts.connectionId, signal: opts.signal });
  const selfEmails = new Set<string>();
  if (profile.email) {selfEmails.add(normalizeEmailKey(profile.email) ?? profile.email);}

  const cache = await buildCacheFromDb(fieldMaps);
  const overrides = readPersonalDomainsOverrides();
  const domainOverrides = { add: overrides.add, remove: overrides.remove };

  const historySlug = await resolveToolSlug({
    toolkitSlug: "gmail",
    preferredSlugs: ["GMAIL_LIST_HISTORY"],
    signal: opts.signal,
  });
  const historyResult = await executeComposioTool<ComposioGmailHistoryResponse>({
    toolSlug: historySlug,
    connectedAccountId: opts.connectionId,
    arguments: {
      user_id: "me",
      start_history_id: opts.startHistoryId,
      history_types: ["messageAdded"],
    },
    signal: opts.signal,
    context: "gmail-incremental",
  });
  const data = historyResult.data?.data ?? historyResult.data;
  const newIds = new Set<string>();
  for (const entry of data?.history ?? []) {
    for (const m of entry.messages ?? []) {
      if (m?.id) {newIds.add(m.id);}
    }
    for (const m of entry.messagesAdded ?? []) {
      if (m?.message?.id) {newIds.add(m.message.id);}
    }
  }

  const fetchSlug = await resolveToolSlug({
    toolkitSlug: "gmail",
    preferredSlugs: ["GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", "GMAIL_GET_MESSAGE"],
    signal: opts.signal,
  });

  const batch = new StatementBatch();
  const touchedThreads = new Set<string>();
  let added = 0;
  let newPeople = 0;
  let newCompanies = 0;

  for (const id of newIds) {
    if (opts.signal?.aborted) {break;}
    if (cache.messageByGmailId.has(id)) {continue;}
    let messageEnvelope: { data?: ComposioGmailMessage } | ComposioGmailMessage;
    try {
      const r = await executeComposioTool<{ data?: ComposioGmailMessage } | ComposioGmailMessage>({
        toolSlug: fetchSlug,
        connectedAccountId: opts.connectionId,
        arguments: { user_id: "me", message_id: id, format: "full" },
        signal: opts.signal,
        context: "gmail-incremental-fetch",
      });
      messageEnvelope = r.data;
    } catch (err) {
      if (err instanceof ComposioToolNoConnectionError) {throw err;}
      continue; // skip individual fetch failures so one bad message doesn't break the tick
    }
    const message =
      (messageEnvelope as { data?: ComposioGmailMessage })?.data ?? (messageEnvelope as ComposioGmailMessage);
    if (!message?.id) {continue;}
    const outcome = processMessage({
      message,
      selfEmails,
      domainOverrides,
      fieldMaps,
      cache,
      batch,
    });
    if (outcome.added) {
      added += 1;
      if (message.threadId) {
        const tid = cache.threadByGmailId.get(message.threadId);
        if (tid) {touchedThreads.add(tid);}
      }
    }
    newPeople += outcome.newPeople;
    newCompanies += outcome.newCompanies;
  }

  flushThreadAggregates({ cache, fieldMaps, batch, touchedThreads });

  if (!batch.isEmpty()) {
    const ok = await duckdbExecOnFileAsync(dbPath, batch.toSql());
    if (!ok) {throw new Error("Incremental Gmail commit failed.");}
  }

  writeSyncCursors({
    gmail: {
      historyId: data?.historyId ?? profile.historyId ?? opts.startHistoryId,
      lastPolledAt: new Date().toISOString(),
    },
  });

  return {
    ok: true,
    messagesProcessed: added,
    peopleProcessed: newPeople,
    companiesProcessed: newCompanies,
    threadsProcessed: touchedThreads.size,
    selfEmail: profile.email,
    historyId: data?.historyId ?? profile.historyId,
    pagesProcessed: 1,
    resumedFromPageToken: false,
  };
}

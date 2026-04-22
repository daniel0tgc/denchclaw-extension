/**
 * Lazy-load full email bodies from Gmail (via Composio) on demand.
 *
 * The sync loop stores only a short preview (Composio's `verbose: true`
 * mode exceeds the gateway's HTTP 413 cap when fetched in pages), so
 * every row's "Body" field is NULL at rest. The first time a user opens
 * a thread we backfill the bodies for that thread's messages in parallel
 * and persist them to DuckDB so future opens are instant and offline.
 *
 * This module is intentionally small and carefully scoped so it can be
 * swapped for a proper full-body sync step when two-way Gmail integration
 * ships; callers stay the same.
 */

import {
  duckdbExecOnFileAsync,
  duckdbPathAsync,
} from "./workspace";
import { ONBOARDING_OBJECT_IDS, fetchFieldIdMap } from "./workspace-schema-migrations";
import {
  executeComposioTool,
  resolveToolSlug,
  ComposioToolNoConnectionError,
} from "./composio-execute";
import { readConnections } from "./denchclaw-state";

// ---------------------------------------------------------------------------
// Types that mirror Composio's Gmail shape (kept local so callers don't
// have to import from the big gmail-sync file).
// ---------------------------------------------------------------------------

type ComposioGmailPart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: ComposioGmailPart[];
};

type ComposioGmailMessage = {
  id?: string;
  messageId?: string;
  messageText?: string;
  snippet?: string;
  preview?: { body?: string };
  payload?: ComposioGmailPart;
};

// ---------------------------------------------------------------------------
// Base64URL + payload walking (duplicated from gmail-sync — intentional:
// keeping this helper self-contained + cheap to import from API routes).
// ---------------------------------------------------------------------------

function decodeBase64Url(value: string): string {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    return Buffer.from(`${padded}${padding}`, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

/**
 * Pull the best body string out of a full Gmail message payload.
 *
 * Preference order — HTML wins so the sandboxed iframe in
 * `message-body.tsx` can render a real marketing email with images,
 * links, layout and typography:
 *
 *   1. first text/html part found walking the MIME tree (richest render)
 *   2. first text/plain part walked from the MIME tree
 *   3. top-level `messageText` (Composio's normalized plain-text body —
 *      always plain text, never HTML, so it's a fallback only)
 *   4. preview / snippet (very last resort)
 *
 * IMPORTANT: do not short-circuit on `messageText` before walking the
 * MIME tree. Composio populates `messageText` with the decoded plain
 * text body alongside the full payload. Returning it early was the
 * cause of every newsletter rendering as plain text — the HTML part
 * was right there in `payload`, we just never looked at it.
 */
export function extractFullBody(message: ComposioGmailMessage): string {
  let htmlBody = "";
  let textBody = "";

  function walk(part: ComposioGmailPart | undefined): void {
    if (!part) return;
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
    for (const child of part.parts ?? []) walk(child);
  }
  walk(message.payload);

  if (htmlBody) return htmlBody;
  if (textBody) return textBody;

  const direct = (message.messageText ?? "").trim();
  if (direct) return direct;

  const fallback = (message.preview?.body ?? message.snippet ?? "").trim();
  return fallback;
}

// ---------------------------------------------------------------------------
// HTML detection — kept in sync with `looksLikeHtml` in
// `apps/web/app/components/crm/inbox/message-body.tsx`. The client uses
// the same regex to decide between iframe rendering and the
// preformatted plain-text fallback; the server uses it to decide
// whether a stored body is "real" rich content or a stale plain-text
// body that predates the extractFullBody fix and should be re-hydrated.
// ---------------------------------------------------------------------------

const HTML_SHAPE_RE =
  /<!doctype|<html|<body|<head|<table|<div|<p\b|<a\s|<br\s*\/?>|<img\s|<\/[a-z]/i;

export function bodyLooksLikeHtml(input: string | null | undefined): boolean {
  if (!input) return false;
  return HTML_SHAPE_RE.test(input);
}

// ---------------------------------------------------------------------------
// Hydration entry points
// ---------------------------------------------------------------------------

export type MessageNeedingHydration = {
  entryId: string;
  gmailMessageId: string;
};

export type HydrateResult = {
  /** Map of email_message.entry_id → fully decoded body string. */
  bodies: Map<string, string>;
  /** Count of messages that didn't return anything (404, no body). */
  failed: number;
  /** True when no Gmail connection exists; hydrate was skipped entirely. */
  skipped: boolean;
};

/**
 * Fetch full bodies for the given messages from Composio (in parallel),
 * persist them to DuckDB, and return the updated map. Safe to call
 * repeatedly: messages whose body was already fetched on a prior call
 * simply skip the network hop because the caller only passes messages
 * that still have a NULL body.
 *
 * Bounded parallelism — hitting Composio with 50+ concurrent message
 * fetches is rude to their rate limits and rarely faster than 8-wide
 * concurrency because of network + deserialization cost.
 */
export async function hydrateMessageBodies(
  messages: ReadonlyArray<MessageNeedingHydration>,
  opts: { signal?: AbortSignal } = {},
): Promise<HydrateResult> {
  const bodies = new Map<string, string>();
  if (messages.length === 0) {
    return { bodies, failed: 0, skipped: false };
  }

  const connections = readConnections();
  if (!connections.gmail?.connectionId) {
    // No Gmail connection — user hasn't onboarded, or disconnected. We
    // silently skip so the UI still renders whatever preview we have.
    return { bodies, failed: 0, skipped: true };
  }

  const connectionId = connections.gmail.connectionId;

  let slug: string;
  try {
    slug = await resolveToolSlug({
      toolkitSlug: "gmail",
      preferredSlugs: ["GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", "GMAIL_GET_MESSAGE"],
      signal: opts.signal,
    });
  } catch {
    return { bodies, failed: messages.length, skipped: true };
  }

  let failed = 0;

  // Bounded concurrency: 6 parallel fetches is the sweet spot between
  // Composio rate limits (typically 60 rpm) and user-perceived latency.
  const CONCURRENCY = 6;
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < messages.length) {
      if (opts.signal?.aborted) return;
      const idx = cursor;
      cursor += 1;
      const msg = messages[idx];
      try {
        const r = await executeComposioTool<
          { data?: ComposioGmailMessage } | ComposioGmailMessage
        >({
          toolSlug: slug,
          connectedAccountId: connectionId,
          arguments: { user_id: "me", message_id: msg.gmailMessageId, format: "full" },
          signal: opts.signal,
          context: "gmail-body-hydrate",
        });
        const envelope = r.data;
        const message =
          (envelope as { data?: ComposioGmailMessage })?.data ??
          (envelope as ComposioGmailMessage);
        const body = extractFullBody(message);
        if (body) {
          bodies.set(msg.entryId, body);
        } else {
          failed += 1;
        }
      } catch (err) {
        if (err instanceof ComposioToolNoConnectionError) {
          // Stop early — further fetches will all fail the same way.
          failed += messages.length - bodies.size;
          break;
        }
        failed += 1;
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, messages.length) }, worker);
  await Promise.all(workers);

  // ─── Persist fetched bodies back to DuckDB ────────────────────────────
  if (bodies.size > 0) {
    await persistBodies(bodies);
  }

  return { bodies, failed, skipped: false };
}

/**
 * Small helper that writes the fetched bodies to the DuckDB entry_fields
 * table so subsequent thread-opens don't re-fetch. Caps at 50k chars per
 * body (same ceiling gmail-sync uses for stored bodies).
 */
async function persistBodies(bodies: Map<string, string>): Promise<void> {
  const dbPath = await duckdbPathAsync();
  if (!dbPath) return;

  const fieldMap = await fetchFieldIdMap(ONBOARDING_OBJECT_IDS.email_message);
  const bodyFieldId = fieldMap["Body"];
  if (!bodyFieldId) return;

  const safeFieldId = bodyFieldId.replace(/'/g, "''");
  const statements: string[] = [];
  for (const [entryId, rawBody] of bodies) {
    const truncated = rawBody.length > 50_000 ? rawBody.slice(0, 50_000) : rawBody;
    const safeEntry = entryId.replace(/'/g, "''");
    const safeBody = truncated.replace(/'/g, "''");
    // Upsert: delete-then-insert so a second call for the same message
    // replaces the previous value instead of producing duplicates.
    statements.push(
      `DELETE FROM entry_fields WHERE entry_id = '${safeEntry}' AND field_id = '${safeFieldId}'`,
    );
    statements.push(
      `INSERT INTO entry_fields (entry_id, field_id, value) VALUES ('${safeEntry}', '${safeFieldId}', '${safeBody}')`,
    );
  }

  await duckdbExecOnFileAsync(dbPath, statements.join(";\n") + ";");
}

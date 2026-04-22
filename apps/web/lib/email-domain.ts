/**
 * Email-address utilities used by the Gmail/Calendar ingestion pipeline.
 *
 * - `parseEmailAddress(value)` accepts headers like `"Sarah Chen" <sarah@acme.com>`
 *   and returns the lowercased address + display name.
 * - `extractRootDomain(address, overrides?)` returns the **registrable
 *   domain** (e.g. `app.acme.co.uk` → `acme.co.uk`) using the Public Suffix
 *   List, or `null` for personal-email-provider addresses.
 *
 * Both helpers are tolerant of malformed input — they return `null` on
 * anything that isn't a parseable email so callers can `continue` cleanly
 * without wrapping in try/catch.
 */

import psl from "psl";
import { buildPersonalDomainSet } from "./personal-email-blocklist";

// ---------------------------------------------------------------------------
// Address parsing
// ---------------------------------------------------------------------------

const ANGLE_BRACKET_RE = /<([^>]+)>/;
const QUOTED_NAME_RE = /^"([^"]+)"\s*/;

export type ParsedEmailAddress = {
  /** Lowercased, trimmed address (`sarah@acme.com`). */
  address: string;
  /** Display name if extractable (`Sarah Chen`), otherwise `null`. */
  name: string | null;
  /** The original raw string, unmodified — useful for logging. */
  raw: string;
};

/**
 * Parse a single email-header value. Handles the common formats:
 * - `"Sarah Chen" <sarah@acme.com>` → name + address
 * - `Sarah Chen <sarah@acme.com>`   → name + address
 * - `<sarah@acme.com>`              → address only
 * - `sarah@acme.com`                → address only
 *
 * Returns `null` if no parseable email address is present.
 */
export function parseEmailAddress(input: string | null | undefined): ParsedEmailAddress | null {
  if (typeof input !== "string") {return null;}
  const raw = input.trim();
  if (!raw) {return null;}

  let address: string | null = null;
  let name: string | null = null;

  const bracketMatch = raw.match(ANGLE_BRACKET_RE);
  if (bracketMatch) {
    address = bracketMatch[1]?.trim().toLowerCase() ?? null;
    const namePart = raw.slice(0, bracketMatch.index).trim();
    if (namePart) {
      const quoted = namePart.match(QUOTED_NAME_RE);
      name = quoted ? quoted[1].trim() : namePart.replace(/^['"]|['"]$/g, "").trim();
    }
  } else {
    address = raw.toLowerCase();
  }

  if (!address || !isLooseEmailAddress(address)) {
    return null;
  }

  return { address, name: name && name.length > 0 ? name : null, raw };
}

/**
 * Parse a comma-separated header value (`To`, `Cc`, etc.) into a deduped
 * list of email addresses. Skips quoted-comma cases inside display names.
 */
export function parseEmailAddressList(input: string | null | undefined): ParsedEmailAddress[] {
  if (typeof input !== "string") {return [];}
  const trimmed = input.trim();
  if (!trimmed) {return [];}

  const parts = splitOnUnquotedCommas(trimmed);
  const out: ParsedEmailAddress[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const parsed = parseEmailAddress(part);
    if (!parsed) {continue;}
    if (seen.has(parsed.address)) {continue;}
    seen.add(parsed.address);
    out.push(parsed);
  }
  return out;
}

function splitOnUnquotedCommas(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  let inAngle = false;
  for (const ch of input) {
    if (ch === '"' && !inAngle) {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (ch === "<" && !inQuotes) {
      inAngle = true;
      current += ch;
      continue;
    }
    if (ch === ">" && !inQuotes) {
      inAngle = false;
      current += ch;
      continue;
    }
    if (ch === "," && !inQuotes && !inAngle) {
      const trimmed = current.trim();
      if (trimmed) {out.push(trimmed);}
      current = "";
      continue;
    }
    current += ch;
  }
  const last = current.trim();
  if (last) {out.push(last);}
  return out;
}

const LOOSE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isLooseEmailAddress(value: string): boolean {
  return LOOSE_EMAIL_RE.test(value);
}

// ---------------------------------------------------------------------------
// Domain extraction
// ---------------------------------------------------------------------------

/**
 * Extract the host portion of an address (everything after the `@`).
 * Returns lowercased without trailing whitespace; `null` if the address
 * is malformed.
 */
export function extractEmailHost(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) {return null;}
  return address.slice(at + 1).trim().toLowerCase();
}

/**
 * Extract the *registrable* domain for an email address using the Public
 * Suffix List. Examples:
 *
 * - `sarah@app.acme.co.uk`   → `acme.co.uk`
 * - `sarah@mail.example.com` → `example.com`
 * - `sarah@gmail.com`        → `null` (personal-email blocklist)
 * - `not-an-address`         → `null`
 *
 * If `overrides` is omitted, the bundled list is used. Pass overrides
 * read from `.denchclaw/personal-domains.json` to honour user edits.
 */
export function extractRootDomain(
  address: string,
  overrides?: { add?: ReadonlyArray<string>; remove?: ReadonlyArray<string> },
): string | null {
  const host = extractEmailHost(address);
  if (!host) {return null;}

  const blocklist = buildPersonalDomainSet(overrides);
  if (blocklist.has(host)) {return null;}

  // Use psl to compute the registrable domain (e.g. acme.co.uk).
  const parsed = psl.parse(host);
  if (!parsed || "error" in parsed && parsed.error) {return null;}
  const root = (parsed as { domain: string | null }).domain;
  if (!root) {return null;}

  if (blocklist.has(root)) {return null;}
  return root;
}

/**
 * Convenience wrapper used by sync code: parse an address and return its
 * root domain in one step.
 */
export function rootDomainFromEmail(
  address: string,
  overrides?: { add?: ReadonlyArray<string>; remove?: ReadonlyArray<string> },
): string | null {
  const parsed = parseEmailAddress(address);
  if (!parsed) {return null;}
  return extractRootDomain(parsed.address, overrides);
}

/**
 * Normalize a raw email address for use as a uniqueness key. Lowercases,
 * trims, and strips an optional `+tag` (so `sarah+work@acme.com` and
 * `sarah@acme.com` both normalize to `sarah@acme.com`).
 *
 * Returns `null` if the input doesn't look like an address.
 */
export function normalizeEmailKey(input: string | null | undefined): string | null {
  const parsed = parseEmailAddress(input);
  if (!parsed) {return null;}
  const at = parsed.address.lastIndexOf("@");
  if (at <= 0) {return parsed.address;}
  const local = parsed.address.slice(0, at);
  const host = parsed.address.slice(at + 1);
  const plusIdx = local.indexOf("+");
  const cleanLocal = plusIdx >= 0 ? local.slice(0, plusIdx) : local;
  if (!cleanLocal) {return parsed.address;}
  return `${cleanLocal}@${host}`;
}

/**
 * Derive a clickable website URL from an email address or raw domain.
 *
 * For corporate domains, returns `https://<root-domain>` so the profile UI
 * can show a "visit website" link without manual data entry. For personal
 * email providers (gmail.com, yahoo.com, etc.) returns null — there's no
 * meaningful "company website" for a Gmail address.
 *
 * Used by:
 *   - person-header.tsx (the "website" row under the contact card)
 *   - company-header.tsx (the canonical website link in the header)
 *   - inbox-view.tsx (sender favicon + tooltip)
 */

import { extractRootDomain, parseEmailAddress } from "./email-domain";

export type WebsiteOverrides = {
  add?: ReadonlyArray<string>;
  remove?: ReadonlyArray<string>;
};

/**
 * Take a raw email-or-domain string. Returns a normalized URL like
 * `https://acme.com`, or `null` if it's a personal-email provider, an
 * unparseable address, or otherwise unsuitable for a public link.
 *
 * Examples:
 *   "sarah@app.acme.co.uk" → "https://acme.co.uk"
 *   "Sarah <sarah@acme.com>" → "https://acme.com"
 *   "acme.com" → "https://acme.com"
 *   "sarah@gmail.com" → null
 *   "garbage" → null
 */
export function deriveWebsite(
  emailOrDomain: string | null | undefined,
  overrides?: WebsiteOverrides,
): string | null {
  if (!emailOrDomain || typeof emailOrDomain !== "string") {return null;}
  const trimmed = emailOrDomain.trim();
  if (!trimmed) {return null;}

  // If it parses as an email, use the domain side.
  if (trimmed.includes("@") || trimmed.includes("<")) {
    const parsed = parseEmailAddress(trimmed);
    if (!parsed) {return null;}
    const root = extractRootDomain(parsed.address, overrides);
    if (!root) {return null;}
    return formatWebsite(root);
  }

  // Otherwise treat the input as a bare domain (e.g. "acme.com").
  const cleaned = trimmed
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
  if (!cleaned || cleaned.includes(" ") || !cleaned.includes(".")) {return null;}

  // Run the same blocklist check by faking an address.
  const fakeRoot = extractRootDomain(`x@${cleaned}`, overrides);
  if (!fakeRoot) {return null;}
  return formatWebsite(fakeRoot);
}

/**
 * Convenience wrapper: returns the bare hostname suitable for showing
 * next to a label (e.g. `acme.co.uk` rather than `https://acme.co.uk`).
 * Useful in compact list rows.
 */
export function deriveDisplayDomain(
  emailOrDomain: string | null | undefined,
  overrides?: WebsiteOverrides,
): string | null {
  const url = deriveWebsite(emailOrDomain, overrides);
  if (!url) {return null;}
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function formatWebsite(domain: string): string {
  return `https://${domain.toLowerCase()}`;
}

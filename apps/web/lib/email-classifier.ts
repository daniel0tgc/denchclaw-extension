/**
 * Layered classifier for "is this Gmail message a real person-to-person
 * conversation, or is it a newsletter / receipt / notification / mailing
 * list / automated system mail that should NOT promote the sender to a
 * Person/Company/Interaction in the CRM graph?"
 *
 * Three-tier design (Tier C is intentionally folded into Tier B's score):
 *
 *   Tier A — single signal proves bulk (short-circuit)
 *     · `List-Id` header present                       → mailing_list
 *     · `Precedence: bulk|list|junk`                   → automated/mailing_list
 *     · `Auto-Submitted ≠ no`                          → automated
 *     · ESP fingerprint headers (X-Mailgun-*, etc.)    → kind inferred below
 *     · `From: mailer-daemon@` / `postmaster@`         → automated
 *
 *   Tier B — aggregate score ≥ 3 ⇒ bulk
 *     +2  List-Unsubscribe present
 *     +1  List-Unsubscribe-Post: List-Unsubscribe=One-Click
 *     +2  noreply / notifications / news / marketing local-part
 *     +1  soft-shared local-part (info, hello, support, team, …)
 *     +2  Gmail labels CATEGORY_PROMOTIONS|SOCIAL|FORUMS
 *     +1  Gmail label CATEGORY_UPDATES
 *     +2  X-Mailer matches MailChimp/SendGrid/HubSpot/Klaviyo/etc.
 *     +2  From host is in ESP send-through domain set
 *     +1  null Return-Path (`<>`)
 *     +1  Return-Path registrable-domain mismatch with From
 *     +1  Self is Bcc-only (not in To/Cc) — classic blast shape
 *     +2  ESP fingerprint headers carried over from Tier A path
 *
 *   Tier D — rescue (overrides Tier B):
 *     · `In-Reply-To` references one of our outgoing Message-Ids
 *     · sender is already a known contact AND aggregate score < 4
 *
 * Returns a structured verdict so callers can decide what to do (skip
 * People upsert, skip interaction row, tag the message, etc.) without
 * re-running the predicate.
 *
 * References:
 *   - RFC 2369 / RFC 8058 (List-Unsubscribe)
 *   - RFC 2919 (List-Id)
 *   - RFC 3834 (Auto-Submitted, Precedence)
 *   - Gmail 2024 sender requirements (Feedback-ID)
 *   - Rspamd headers.lua (X-Mailer / Interspire fingerprints)
 */

import { isEspDomain } from "./esp-domains";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SenderKind =
  | "person"
  | "marketing"
  | "transactional"
  | "notification"
  | "mailing_list"
  | "automated";

export type ClassifyConfidence = "high" | "medium" | "low";

export type NewsletterVerdict = {
  kind: SenderKind;
  /** Convenience: kind !== "person". */
  isBulk: boolean;
  /** Human-readable reasons; useful for tooltips, debugging, audit logs. */
  signals: string[];
  confidence: ClassifyConfidence;
};

export type HeaderReader = (name: string) => string | null;

export type ClassifyParams = {
  fromAddress: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  /** Lowercased + plus-tag-stripped self addresses (see `normalizeEmailKey`). */
  selfEmails: Set<string>;
  subject: string;
  /** Gmail labelIds[] for the message — used for CATEGORY_* signals. */
  labelIds: string[];
  /** Reads a single header by name, case-insensitive. */
  getHeader: HeaderReader;
  /** Optional rescue: this message is a reply to one of our outgoing messages. */
  hasInReplyToOurMessage?: boolean;
  /** Optional rescue: the sender is already in our People graph. */
  senderIsKnownContact?: boolean;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOREPLY_LOCAL_PARTS = new Set<string>([
  "noreply", "no-reply", "no_reply", "donotreply", "do-not-reply", "do_not_reply",
  "notifications", "notification", "notify", "notif",
  "news", "newsletter", "newsletters", "broadcast",
  "mailer", "mail", "mailman", "mailings", "mailings-noreply",
  "digest", "digests",
  "alert", "alerts", "alerting",
  "updates", "update",
  "marketing", "promo", "promos", "promotions", "deals", "offer", "offers",
  "campaign", "campaigns",
  "bounce", "bounces", "bounced",
  "automated", "auto", "system", "robot", "bot",
  "postmaster", "mailer-daemon", "mail-daemon",
  "support-noreply", "noreply-support",
  "members", "member-services", "billing-noreply",
]);

/**
 * "Soft" no-reply: often a real human at small companies; only counts when
 * combined with another bulk signal.
 */
const SOFT_SHARED_LOCAL_PARTS = new Set<string>([
  "info", "hello", "hi", "team", "contact", "support", "help", "sales",
  "press", "media", "founders", "ceo", "admin", "general", "office",
  "service", "services",
]);

/**
 * Subject keywords commonly seen in transactional mail. Used only to tag
 * `kind`, never to flip the verdict — many marketing emails contain these too.
 */
const TRANSACTIONAL_SUBJECT_HINTS = [
  "receipt", "invoice", "order #", "your order", "order confirmation",
  "payment", "subscription renewed", "renewed your",
  "you're booked", "your booking",
  "confirmation", "verify your", "verification code", "one-time", "otp",
  "password reset", "reset your password", "magic link", "sign in link",
  "shipping update", "tracking", "shipped", "delivered",
  "your statement", "invoice attached",
];

/**
 * ESP fingerprint headers — presence of any of these is a strong "bulk
 * infrastructure" signal. Pulled from Rspamd's `headers.lua` patterns.
 */
const ESP_HEADER_NAMES = [
  "X-Mailgun-Sid", "X-Mailgun-Variables", "X-Mailgun-Tag", "X-Mailgun-Track",
  "X-SES-Outgoing", "X-SES-Configuration-Set", "X-SES-Source-Arn",
  "X-Mc-User", "X-Mc-Template",                       // Mandrill
  "X-Mailchimp-Campaign", "X-Mailchimp-Id",
  "X-Mailchimp-Mandrill-Id",
  "X-Postmark-Tag", "X-Pm-Message-Id",
  "X-Loops-Email-Id",
  "X-Customer-Io-Message-Id", "X-Customer-Io-Tag",
  "X-Cm-Sender-Id",                                   // Campaign Monitor
  "X-Mailer-LID", "X-Mailer-RecptId", "X-Mailer-SID", // Interspire
  "X-Convertkit-Mid",
  "X-Sg-Eid", "X-Sg-Id",                              // SendGrid
  "X-Campaign", "X-Campaign-Id", "X-Mailer-Campaign",
  "X-Klaviyo-Message-Id", "X-Klaviyo-Account-Id",
  "X-Substack-Post-Id",
  "X-Beehiiv-Post-Id",
  "X-Iterable-Campaign",
  "X-Marketo-Lead-Id",
  "X-Pardot-Track",
  "X-ActOn-Outbound", "X-Acton-Tag",
  "X-Eloqua-Encrypted-Recipient-Id",
];

const X_MAILER_BULK_PATTERN = /(MailChimp|SendGrid|Mailgun|Constant\s*Contact|HubSpot|Iterable|Klaviyo|Customer\.io|Substack|Beehiiv|ConvertKit|Marketo|Pardot|Eloqua|ActOn|Postmark|SparkPost)/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function localPart(address: string): string {
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(0, at).toLowerCase() : address.toLowerCase();
}

function hostPart(address: string): string {
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(at + 1).toLowerCase() : "";
}

function registrableDomain(host: string): string {
  // Cheap version — full PSL check is overkill; we only need to compare
  // two hosts at the same-ish granularity to catch ESP relay shape.
  const parts = host.split(".");
  if (parts.length <= 2) {return host;}
  return parts.slice(-2).join(".");
}

function domainsDifferAtRegistrable(a: string, b: string): boolean {
  return registrableDomain(a) !== registrableDomain(b);
}

// ---------------------------------------------------------------------------
// Public: classifySender
// ---------------------------------------------------------------------------

export function classifySender(params: ClassifyParams): NewsletterVerdict {
  const signals: string[] = [];
  const fromHost = params.fromAddress ? hostPart(params.fromAddress) : "";
  const fromLocal = params.fromAddress ? localPart(params.fromAddress) : "";

  // ─── Tier D rescue: replies-to-our-message → always person ───────────────
  if (params.hasInReplyToOurMessage) {
    return {
      kind: "person",
      isBulk: false,
      confidence: "high",
      signals: ["replies to one of our outgoing messages"],
    };
  }

  // ─── Tier A: single signal proves bulk ───────────────────────────────────

  if (params.getHeader("List-Id")) {
    signals.push("has List-Id header");
    return { kind: "mailing_list", isBulk: true, confidence: "high", signals };
  }

  const precedence = (params.getHeader("Precedence") ?? "").toLowerCase().trim();
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") {
    signals.push(`Precedence: ${precedence}`);
    return {
      kind: precedence === "list" ? "mailing_list" : "automated",
      isBulk: true,
      confidence: "high",
      signals,
    };
  }

  const autoSubmitted = (params.getHeader("Auto-Submitted") ?? "").toLowerCase().trim();
  if (autoSubmitted && autoSubmitted !== "no") {
    signals.push(`Auto-Submitted: ${autoSubmitted}`);
    return { kind: "automated", isBulk: true, confidence: "high", signals };
  }

  if (fromLocal === "mailer-daemon" || fromLocal === "postmaster" || fromLocal === "mail-daemon") {
    signals.push(`From local-part: ${fromLocal}`);
    return { kind: "automated", isBulk: true, confidence: "high", signals };
  }

  // ─── Tier B: aggregate score ─────────────────────────────────────────────
  let score = 0;

  const espHeaderHits = ESP_HEADER_NAMES.filter((h) => params.getHeader(h) !== null);
  if (espHeaderHits.length > 0) {
    signals.push(`ESP headers: ${espHeaderHits.slice(0, 3).join(", ")}`);
    score += 2;
  }

  if (params.getHeader("Feedback-ID")) {
    signals.push("has Feedback-ID");
    score += 1; // not enough alone but contributes
  }

  const listUnsubscribe = params.getHeader("List-Unsubscribe");
  if (listUnsubscribe) {
    signals.push("has List-Unsubscribe");
    score += 2;
  }
  if (params.getHeader("List-Unsubscribe-Post")) {
    signals.push("has List-Unsubscribe-Post");
    score += 1;
  }

  if (NOREPLY_LOCAL_PARTS.has(fromLocal)) {
    signals.push(`From local-part: ${fromLocal}`);
    score += 2;
  } else if (SOFT_SHARED_LOCAL_PARTS.has(fromLocal)) {
    signals.push(`From local-part (soft): ${fromLocal}`);
    score += 1;
  }

  if (params.labelIds.includes("CATEGORY_PROMOTIONS")) {
    signals.push("Gmail CATEGORY_PROMOTIONS");
    score += 2;
  }
  if (params.labelIds.includes("CATEGORY_SOCIAL")) {
    signals.push("Gmail CATEGORY_SOCIAL");
    score += 2;
  }
  if (params.labelIds.includes("CATEGORY_FORUMS")) {
    signals.push("Gmail CATEGORY_FORUMS");
    score += 2;
  }
  if (params.labelIds.includes("CATEGORY_UPDATES")) {
    signals.push("Gmail CATEGORY_UPDATES");
    score += 1;
  }

  const xMailer = params.getHeader("X-Mailer") ?? "";
  if (xMailer && X_MAILER_BULK_PATTERN.test(xMailer)) {
    signals.push(`X-Mailer matches bulk: ${xMailer.slice(0, 40)}`);
    score += 2;
  }

  if (fromHost && isEspDomain(fromHost)) {
    signals.push(`From host is ESP send-through: ${fromHost}`);
    score += 2;
  }

  const returnPath = (params.getHeader("Return-Path") ?? "").trim();
  if (returnPath === "<>" || returnPath === "") {
    if (returnPath === "<>") {
      signals.push("null Return-Path");
      score += 1;
    }
  } else if (params.fromAddress) {
    const cleanedRp = returnPath.replace(/^<|>$/g, "").trim();
    const rpHost = hostPart(cleanedRp);
    if (rpHost && fromHost && domainsDifferAtRegistrable(rpHost, fromHost)) {
      signals.push(`Return-Path domain differs from From (${rpHost} vs ${fromHost})`);
      score += 1;
    }
  }

  // Self is Bcc-only — classic blast shape.
  if (params.selfEmails.size > 0 && params.fromAddress) {
    const inTo = params.toAddresses.some((a) => params.selfEmails.has(a.toLowerCase()));
    const inCc = params.ccAddresses.some((a) => params.selfEmails.has(a.toLowerCase()));
    if (!inTo && !inCc) {
      signals.push("self is Bcc-only (not in To/Cc)");
      score += 1;
    }
  }

  // ─── Tier D rescue: known contact + low score ⇒ keep as person ──────────
  if (params.senderIsKnownContact && score < 4) {
    return {
      kind: "person",
      isBulk: false,
      confidence: "medium",
      signals: ["sender is known prior contact (overrides weak signals)"],
    };
  }

  // ─── Decide ──────────────────────────────────────────────────────────────
  if (score >= 3) {
    const kind = inferKind({
      labelIds: params.labelIds,
      subject: params.subject,
      fromLocal,
      hasFeedbackId: !!params.getHeader("Feedback-ID"),
    });
    return {
      kind,
      isBulk: true,
      confidence: score >= 5 ? "high" : "medium",
      signals,
    };
  }

  return {
    kind: "person",
    isBulk: false,
    confidence: "high",
    signals: signals.length > 0 ? signals : ["no bulk signals matched"],
  };
}

function inferKind(params: {
  labelIds: string[];
  subject: string;
  fromLocal: string;
  hasFeedbackId: boolean;
}): SenderKind {
  if (params.labelIds.includes("CATEGORY_PROMOTIONS")) {return "marketing";}
  if (params.labelIds.includes("CATEGORY_FORUMS")) {return "mailing_list";}
  if (params.labelIds.includes("CATEGORY_SOCIAL")) {return "notification";}

  const subjectLower = params.subject.toLowerCase();
  if (TRANSACTIONAL_SUBJECT_HINTS.some((h) => subjectLower.includes(h))) {
    return "transactional";
  }

  if (/^(receipt|billing|invoice|orders?|payment)s?$/.test(params.fromLocal)) {
    return "transactional";
  }
  if (/^(news|newsletter|marketing|promo|deals|offers|campaign)/.test(params.fromLocal)) {
    return "marketing";
  }
  if (/^(notifications?|alerts?|updates?)/.test(params.fromLocal)) {
    return "notification";
  }
  if (params.labelIds.includes("CATEGORY_UPDATES")) {return "transactional";}

  return "automated";
}

/**
 * Convenience boolean for the common case in the sync loop.
 */
export function isNewsletterLike(params: ClassifyParams): boolean {
  return classifySender(params).isBulk;
}

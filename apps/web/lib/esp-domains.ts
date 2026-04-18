/**
 * Bundled set of ESP (Email Service Provider) send-through domains.
 *
 * When a `From:` address resolves to one of these (or a subdomain),
 * the message went through bulk-send infrastructure and almost certainly
 * isn't person-to-person mail.
 *
 * Kept as a separate file so the classifier predicate stays small and the
 * list is easy to extend without touching detection logic.
 *
 * Most well-configured senders use DKIM-aligned custom domains — these
 * raw ESP hosts only show up for poorly-configured small senders or
 * during ESP free trials. So this list is more of a safety net than a
 * primary detection signal.
 */

const BUNDLED_ESP_DOMAINS: ReadonlyArray<string> = [
  // SendGrid
  "sendgrid.net",
  "sendgrid.com",
  "u.sendgrid.com",

  // Mailgun
  "mailgun.org",
  "mailgun.com",
  "mg.mailgun.org",

  // AWS SES
  "amazonses.com",
  "email-bounces.amazonses.com",

  // Mailchimp / Mandrill
  "mandrillapp.com",
  "mcsv.net",
  "mcdlv.net",
  "rsgsv.net",
  "list-manage.com",

  // Postmark
  "postmarkapp.com",
  "pm-bounces.com",
  "mtasv.net",

  // SparkPost
  "sparkpostmail.com",
  "e.sparkpost.com",

  // Customer.io
  "customeriomail.com",

  // Loops
  "loops.so",
  "mail.loops.so",

  // Klaviyo
  "klaviyomail.com",

  // ConvertKit
  "convertkit-mail.com",
  "convertkit-mail2.com",
  "convertkit-mail4.com",
  "ck.page",

  // Substack
  "substack.com",
  "email.substack.com",

  // Beehiiv
  "mail.beehiiv.com",
  "email.beehiiv.com",

  // Iterable
  "iterable.com",
  "iterable.email",

  // Mailjet
  "mailjet.com",
  "mailjet-spm.com",

  // MailerSend
  "mailersend.com",

  // Resend
  "resend.dev",

  // Action Network
  "actionnetworkmail.com",

  // Constant Contact
  "in.constantcontact.com",
  "constantcontact.com",

  // Drip
  "getdrip.com",

  // ActiveCampaign
  "activehosted.com",

  // Eloqua
  "eloqua.com",

  // Marketo
  "marketo.com",
  "mktomail.com",

  // Pardot / Salesforce Marketing Cloud
  "pardot.com",
  "marketingcloud.com",
  "exacttarget.com",
  "exct.net",
];

const BUNDLED_SET = new Set<string>(BUNDLED_ESP_DOMAINS.map((d) => d.toLowerCase()));

/**
 * Check whether a host is a known ESP send-through domain (exact match
 * or any subdomain of one). Caller passes the lowercased host portion of
 * an email address.
 */
export function isEspDomain(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (!normalized) return false;
  if (BUNDLED_SET.has(normalized)) return true;
  for (const esp of BUNDLED_SET) {
    if (normalized.endsWith(`.${esp}`)) return true;
  }
  return false;
}

export const BUNDLED_ESP_DOMAINS_LIST: ReadonlyArray<string> = BUNDLED_ESP_DOMAINS;

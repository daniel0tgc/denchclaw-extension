/**
 * Personal-email-provider blocklist.
 *
 * Domains in this list are *not* auto-promoted to Companies during the
 * Gmail backfill — every contact from these domains is just a personal
 * contact, not a corporate counterparty. Users can extend or override
 * via `.denchclaw/personal-domains.json` (see `denchclaw-state.ts`).
 *
 * The list intentionally errs on the side of including more providers,
 * not fewer: false positives ("we missed that 'foo' is actually a
 * company") are recoverable in seconds via the Domain settings panel,
 * but false negatives ("we created 4,000 fake companies for every
 * gmail.com sender") are a much louder UX failure.
 */

const BUNDLED_PERSONAL_DOMAINS: ReadonlyArray<string> = [
  // Google
  "gmail.com",
  "googlemail.com",

  // Microsoft
  "hotmail.com",
  "hotmail.co.uk",
  "hotmail.fr",
  "hotmail.de",
  "hotmail.it",
  "hotmail.es",
  "outlook.com",
  "outlook.co.uk",
  "outlook.de",
  "outlook.fr",
  "outlook.it",
  "outlook.es",
  "outlook.jp",
  "outlook.in",
  "outlook.ie",
  "outlook.com.au",
  "live.com",
  "live.co.uk",
  "live.de",
  "live.fr",
  "live.it",
  "live.com.au",
  "msn.com",
  "passport.com",

  // Yahoo
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.co.in",
  "yahoo.co.jp",
  "yahoo.co.id",
  "yahoo.com.au",
  "yahoo.com.br",
  "yahoo.com.mx",
  "yahoo.com.sg",
  "yahoo.de",
  "yahoo.fr",
  "yahoo.es",
  "yahoo.it",
  "yahoo.ca",
  "ymail.com",
  "rocketmail.com",

  // Apple
  "icloud.com",
  "me.com",
  "mac.com",

  // AOL / Verizon
  "aol.com",
  "aol.co.uk",
  "aol.de",
  "aol.fr",
  "verizon.net",

  // Privacy / advanced personal
  "protonmail.com",
  "proton.me",
  "pm.me",
  "tutanota.com",
  "tuta.io",
  "fastmail.com",
  "fastmail.fm",
  "hushmail.com",
  "mailfence.com",
  "disroot.org",
  "riseup.net",
  "posteo.de",
  "posteo.net",
  "ctemplar.com",
  "kolabnow.com",
  "runbox.com",

  // International majors
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "gmx.us",
  "web.de",
  "t-online.de",
  "freenet.de",
  "yandex.com",
  "yandex.ru",
  "ya.ru",
  "mail.ru",
  "list.ru",
  "bk.ru",
  "inbox.ru",
  "rambler.ru",
  "qq.com",
  "163.com",
  "126.com",
  "yeah.net",
  "sina.com",
  "sina.cn",
  "sohu.com",
  "aliyun.com",
  "foxmail.com",
  "naver.com",
  "daum.net",
  "hanmail.net",
  "nate.com",
  "rediffmail.com",
  "sify.com",
  "indiatimes.com",
  "uol.com.br",
  "bol.com.br",
  "terra.com.br",
  "ig.com.br",
  "globo.com",
  "libero.it",
  "alice.it",
  "tin.it",
  "tiscali.it",
  "virgilio.it",
  "wanadoo.fr",
  "orange.fr",
  "free.fr",
  "laposte.net",
  "sfr.fr",
  "neuf.fr",
  "club-internet.fr",
  "telia.com",
  "bredband.net",
  "comhem.se",
  "swipnet.se",
  "online.no",
  "broadpark.no",
  "telenor.no",
  "ziggo.nl",
  "kpnmail.nl",
  "hetnet.nl",
  "planet.nl",
  "home.nl",
  "telenet.be",
  "skynet.be",
  "scarlet.be",

  // Generic / catch-all consumer
  "mail.com",
  "email.com",
  "inbox.com",
  "usa.com",
  "europe.com",
  "asia.com",
  "post.com",
  "consultant.com",
  "engineer.com",
  "techie.com",
  "writeme.com",
  "iname.com",
  "lawyer.com",
  "doctor.com",
  "myself.com",
  "europemail.com",
  "earthlink.net",
  "att.net",
  "comcast.net",
  "sbcglobal.net",
  "bellsouth.net",
  "cox.net",
  "charter.net",
  "frontier.com",
  "frontiernet.net",
  "embarqmail.com",
  "centurylink.net",
  "windstream.net",
  "juno.com",
  "netzero.net",
  "netscape.net",
  "rogers.com",
  "shaw.ca",
  "telus.net",
  "sympatico.ca",
  "videotron.ca",
  "bigpond.com",
  "bigpond.net.au",
  "optusnet.com.au",
  "iinet.net.au",
  "tpg.com.au",
  "internode.on.net",

  // Disposable / temporary mail (worth blocking from auto-companies anyway)
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "guerrillamail.org",
  "10minutemail.com",
  "tempmail.com",
  "temp-mail.org",
  "throwawaymail.com",
  "trashmail.com",
  "yopmail.com",
  "sharklasers.com",
  "spam4.me",
  "maildrop.cc",
  "dispostable.com",
  "getnada.com",
  "burnermail.io",
  "mintemail.com",
  "fakeinbox.com",
];

const BUNDLED_SET = new Set<string>(BUNDLED_PERSONAL_DOMAINS.map((d) => d.toLowerCase()));

/**
 * Resolve the effective personal-domain set: the bundled list, minus any
 * domains the user explicitly removed, plus any they explicitly added.
 *
 * Pass the overrides loaded from `.denchclaw/personal-domains.json` via
 * `readPersonalDomainsOverrides`. Return value is a `Set<string>` for O(1)
 * lookup during ingestion.
 */
export function buildPersonalDomainSet(overrides?: {
  add?: ReadonlyArray<string>;
  remove?: ReadonlyArray<string>;
}): Set<string> {
  const set = new Set<string>(BUNDLED_SET);
  if (overrides?.remove) {
    for (const domain of overrides.remove) {
      const normalized = domain.trim().toLowerCase();
      if (normalized) {set.delete(normalized);}
    }
  }
  if (overrides?.add) {
    for (const domain of overrides.add) {
      const normalized = domain.trim().toLowerCase();
      if (normalized) {set.add(normalized);}
    }
  }
  return set;
}

/** The bundled list, exposed for diagnostics and the Settings UI. */
export const BUNDLED_PERSONAL_DOMAINS_LIST: ReadonlyArray<string> = BUNDLED_PERSONAL_DOMAINS;

/** Quick check against the *bundled* list only (no overrides). Mostly useful for tests. */
export function isBundledPersonalDomain(domain: string): boolean {
  return BUNDLED_SET.has(domain.trim().toLowerCase());
}

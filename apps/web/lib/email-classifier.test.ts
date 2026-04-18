import { describe, expect, it } from "vitest";
import { classifySender, isNewsletterLike, type ClassifyParams } from "./email-classifier";

function makeParams(overrides: Partial<ClassifyParams> & {
  headers?: Record<string, string>;
}): ClassifyParams {
  const headers = overrides.headers ?? {};
  return {
    fromAddress: overrides.fromAddress ?? null,
    toAddresses: overrides.toAddresses ?? ["kumar@dench.com"],
    ccAddresses: overrides.ccAddresses ?? [],
    selfEmails: overrides.selfEmails ?? new Set(["kumar@dench.com"]),
    subject: overrides.subject ?? "Hello",
    labelIds: overrides.labelIds ?? ["INBOX"],
    getHeader: (name) => {
      const target = name.toLowerCase();
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === target) return v;
      }
      return null;
    },
    hasInReplyToOurMessage: overrides.hasInReplyToOurMessage,
    senderIsKnownContact: overrides.senderIsKnownContact,
  };
}

describe("classifySender — Tier A short-circuits", () => {
  it("flags mailing_list when List-Id present", () => {
    const v = classifySender(makeParams({
      fromAddress: "list@googlegroups.com",
      headers: { "List-Id": "<mygroup.googlegroups.com>" },
    }));
    expect(v.kind).toBe("mailing_list");
    expect(v.isBulk).toBe(true);
    expect(v.confidence).toBe("high");
  });

  it("flags automated for Precedence: bulk", () => {
    const v = classifySender(makeParams({
      fromAddress: "alerts@datadog.com",
      headers: { Precedence: "bulk" },
    }));
    expect(v.isBulk).toBe(true);
    expect(v.kind).toBe("automated");
  });

  it("flags mailing_list for Precedence: list", () => {
    const v = classifySender(makeParams({
      fromAddress: "list@cool.io",
      headers: { Precedence: "list" },
    }));
    expect(v.kind).toBe("mailing_list");
  });

  it("flags automated for vacation responder (Auto-Submitted)", () => {
    const v = classifySender(makeParams({
      fromAddress: "sarah@acme.com",
      headers: { "Auto-Submitted": "auto-replied" },
      subject: "Out of office: I'm away until April 30",
    }));
    expect(v.isBulk).toBe(true);
    expect(v.kind).toBe("automated");
  });

  it("ignores Auto-Submitted: no", () => {
    const v = classifySender(makeParams({
      fromAddress: "sarah@acme.com",
      headers: { "Auto-Submitted": "no" },
    }));
    expect(v.kind).toBe("person");
  });

  it("flags mailer-daemon as automated", () => {
    const v = classifySender(makeParams({
      fromAddress: "mailer-daemon@googlemail.com",
      subject: "Delivery Status Notification",
    }));
    expect(v.kind).toBe("automated");
    expect(v.isBulk).toBe(true);
  });
});

describe("classifySender — Tier B aggregate scoring", () => {
  it("Substack newsletter (List-Unsubscribe + CATEGORY_PROMOTIONS + ESP)", () => {
    const v = classifySender(makeParams({
      fromAddress: "newsletter@substack.com",
      labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
      headers: {
        "List-Unsubscribe": "<https://substack.com/unsub/abc>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        "X-Substack-Post-Id": "12345",
        "Feedback-ID": "abc:substack:m:p",
      },
      subject: "Your weekly digest",
    }));
    expect(v.isBulk).toBe(true);
    expect(v.kind).toBe("marketing");
    expect(v.confidence).toBe("high");
  });

  it("Stripe receipt (List-Unsubscribe + Feedback-ID + transactional subject)", () => {
    const v = classifySender(makeParams({
      fromAddress: "receipts@stripe.com",
      labelIds: ["INBOX", "CATEGORY_UPDATES"],
      headers: {
        "List-Unsubscribe": "<https://stripe.com/unsub>",
        "Feedback-ID": "stripe:receipts:m:t",
      },
      subject: "Your receipt from Acme Corp",
    }));
    expect(v.isBulk).toBe(true);
    expect(v.kind).toBe("transactional");
  });

  it("GitHub notification (CATEGORY_UPDATES + noreply local-part)", () => {
    const v = classifySender(makeParams({
      fromAddress: "notifications@github.com",
      labelIds: ["INBOX", "CATEGORY_UPDATES"],
      subject: "Re: [DenchHQ/DenchClaw] PR review",
    }));
    expect(v.isBulk).toBe(true);
    expect(v.kind).toBe("notification");
  });

  it("Lu.ma calendar invite confirmation", () => {
    const v = classifySender(makeParams({
      fromAddress: "notifications@lu.ma",
      labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
      headers: {
        "List-Unsubscribe": "<mailto:unsub@lu.ma>",
      },
      subject: "You're going to Builders Table",
    }));
    expect(v.isBulk).toBe(true);
    // Marketing because of CATEGORY_PROMOTIONS in inferKind precedence.
    expect(["marketing", "notification"]).toContain(v.kind);
  });

  it("X-Mailer matching MailChimp pattern triggers bulk", () => {
    const v = classifySender(makeParams({
      fromAddress: "team@startup.com",
      headers: {
        "X-Mailer": "MailChimp Mailer - **CID3a7b8f**",
        "List-Unsubscribe": "<mailto:unsub@startup.com>",
      },
    }));
    expect(v.isBulk).toBe(true);
  });

  it("ESP host (sendgrid.net) bumps score", () => {
    const v = classifySender(makeParams({
      fromAddress: "bounces@bounces.sendgrid.net",
      labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
    }));
    expect(v.isBulk).toBe(true);
  });

  it("self in Bcc-only contributes +1 (combines with other signals)", () => {
    const v = classifySender(makeParams({
      fromAddress: "marketing@bigco.com",
      toAddresses: ["someone-else@example.com"],
      ccAddresses: [],
      selfEmails: new Set(["kumar@dench.com"]),
      headers: { "List-Unsubscribe": "<https://example>" },
    }));
    expect(v.isBulk).toBe(true);
  });
});

describe("classifySender — real-person paths", () => {
  it("plain human-from-human → person", () => {
    const v = classifySender(makeParams({
      fromAddress: "sarah@acme.com",
      subject: "Quick question about the deal",
    }));
    expect(v.kind).toBe("person");
    expect(v.isBulk).toBe(false);
  });

  it("mark@stripe.com writing personally → person (despite Stripe also sending receipts)", () => {
    const v = classifySender(makeParams({
      fromAddress: "mark@stripe.com",
      subject: "Lunch next week?",
    }));
    expect(v.kind).toBe("person");
  });

  it("forwarded newsletter (real From, original List-* stripped) → person", () => {
    // When a person hits Forward in Gmail, the wrapper headers don't carry
    // the original List-Unsubscribe. Predicate sees a normal From → person.
    const v = classifySender(makeParams({
      fromAddress: "vedant@dench.com",
      subject: "Fwd: Y Combinator weekly digest",
    }));
    expect(v.kind).toBe("person");
  });

  it("cold-outbound SDR (no bulk infrastructure markers) → person", () => {
    // We accept this — they ARE a person typing real text, just at scale.
    const v = classifySender(makeParams({
      fromAddress: "alex@startup.com",
      subject: "Quick intro - I think Dench would love what we do",
    }));
    expect(v.kind).toBe("person");
  });

  it("known contact + soft signals are rescued back to person", () => {
    const v = classifySender(makeParams({
      fromAddress: "support@acme.com",
      headers: {
        "List-Unsubscribe": "<https://acme.com/unsub>",
      },
      senderIsKnownContact: true,
    }));
    // List-Unsubscribe (+2) + soft local-part 'support' (+1) = 3, but rescued.
    expect(v.kind).toBe("person");
  });

  it("known contact does NOT rescue from Tier A (List-Id)", () => {
    const v = classifySender(makeParams({
      fromAddress: "list@googlegroups.com",
      headers: { "List-Id": "<x.googlegroups.com>" },
      senderIsKnownContact: true,
    }));
    expect(v.isBulk).toBe(true);
  });

  it("In-Reply-To rescue short-circuits everything", () => {
    const v = classifySender(makeParams({
      fromAddress: "noreply@bigco.com",
      headers: { "List-Unsubscribe": "<x>" },
      hasInReplyToOurMessage: true,
    }));
    expect(v.kind).toBe("person");
    expect(v.confidence).toBe("high");
  });

  it("just CATEGORY_UPDATES alone does NOT classify as bulk", () => {
    // CATEGORY_UPDATES contributes only +1; needs another signal to fire.
    const v = classifySender(makeParams({
      fromAddress: "boss@company.com",
      labelIds: ["INBOX", "CATEGORY_UPDATES"],
    }));
    expect(v.kind).toBe("person");
  });
});

describe("classifySender — kind inference", () => {
  it("CATEGORY_PROMOTIONS → marketing", () => {
    const v = classifySender(makeParams({
      fromAddress: "deals@somesite.com",
      labelIds: ["CATEGORY_PROMOTIONS"],
      headers: { "List-Unsubscribe": "<x>" },
    }));
    expect(v.kind).toBe("marketing");
  });

  it("CATEGORY_FORUMS → mailing_list", () => {
    const v = classifySender(makeParams({
      fromAddress: "user@example.com",
      labelIds: ["CATEGORY_FORUMS"],
      headers: { "List-Unsubscribe": "<x>" },
    }));
    expect(v.kind).toBe("mailing_list");
  });

  it("CATEGORY_SOCIAL → notification", () => {
    const v = classifySender(makeParams({
      fromAddress: "notifications@linkedin.com",
      labelIds: ["CATEGORY_SOCIAL"],
      headers: { "List-Unsubscribe": "<x>" },
    }));
    expect(v.kind).toBe("notification");
  });

  it("transactional subject with bulk signals → transactional", () => {
    const v = classifySender(makeParams({
      fromAddress: "billing@vendor.com",
      labelIds: ["CATEGORY_UPDATES"],
      headers: { "List-Unsubscribe": "<x>" },
      subject: "Invoice #12345 attached",
    }));
    expect(v.kind).toBe("transactional");
  });
});

describe("isNewsletterLike", () => {
  it("returns the boolean for the common case", () => {
    expect(isNewsletterLike(makeParams({
      fromAddress: "sarah@acme.com",
    }))).toBe(false);

    expect(isNewsletterLike(makeParams({
      fromAddress: "noreply@bigco.com",
      headers: { "List-Unsubscribe": "<x>" },
      labelIds: ["CATEGORY_PROMOTIONS"],
    }))).toBe(true);
  });
});

describe("classifySender — signals are surfaced", () => {
  it("returns a non-empty signals array for a clean person", () => {
    const v = classifySender(makeParams({ fromAddress: "sarah@acme.com" }));
    expect(v.signals.length).toBeGreaterThan(0);
    expect(v.signals[0]).toMatch(/no bulk signals/);
  });

  it("returns multiple signals for a heavily-flagged newsletter", () => {
    const v = classifySender(makeParams({
      fromAddress: "newsletter@substack.com",
      labelIds: ["CATEGORY_PROMOTIONS"],
      headers: {
        "List-Unsubscribe": "<x>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        "X-Substack-Post-Id": "1",
      },
    }));
    expect(v.signals.length).toBeGreaterThanOrEqual(3);
    expect(v.signals.some((s) => s.includes("List-Unsubscribe"))).toBe(true);
    expect(v.signals.some((s) => s.includes("CATEGORY_PROMOTIONS"))).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  extractEmailHost,
  extractRootDomain,
  normalizeEmailKey,
  parseEmailAddress,
  parseEmailAddressList,
  rootDomainFromEmail,
} from "./email-domain";

describe("parseEmailAddress", () => {
  it("parses bare addresses", () => {
    expect(parseEmailAddress("sarah@acme.com")).toEqual({
      address: "sarah@acme.com",
      name: null,
      raw: "sarah@acme.com",
    });
  });

  it("parses display name + address", () => {
    expect(parseEmailAddress('"Sarah Chen" <sarah@acme.com>')).toEqual({
      address: "sarah@acme.com",
      name: "Sarah Chen",
      raw: '"Sarah Chen" <sarah@acme.com>',
    });
  });

  it("parses unquoted display name + address", () => {
    expect(parseEmailAddress("Sarah Chen <sarah@acme.com>")).toEqual({
      address: "sarah@acme.com",
      name: "Sarah Chen",
      raw: "Sarah Chen <sarah@acme.com>",
    });
  });

  it("lowercases addresses but preserves display name casing", () => {
    expect(parseEmailAddress("Sarah Chen <Sarah@Acme.COM>")?.address).toBe("sarah@acme.com");
    expect(parseEmailAddress("Sarah Chen <Sarah@Acme.COM>")?.name).toBe("Sarah Chen");
  });

  it("returns null for unparseable input", () => {
    expect(parseEmailAddress("")).toBeNull();
    expect(parseEmailAddress(null)).toBeNull();
    expect(parseEmailAddress(undefined)).toBeNull();
    expect(parseEmailAddress("not an email")).toBeNull();
    expect(parseEmailAddress("not@anything")).toBeNull();
    expect(parseEmailAddress("Sarah <broken")).toBeNull();
  });

  it("strips trailing whitespace and surrounding quotes", () => {
    expect(parseEmailAddress("  sarah@acme.com  ")?.address).toBe("sarah@acme.com");
  });
});

describe("parseEmailAddressList", () => {
  it("splits on commas and dedupes", () => {
    const list = parseEmailAddressList(
      'Sarah <sarah@acme.com>, james@techcorp.io, "Sarah Chen" <sarah@acme.com>',
    );
    expect(list.map((p) => p.address)).toEqual(["sarah@acme.com", "james@techcorp.io"]);
  });

  it("does not split commas inside quoted display names", () => {
    const list = parseEmailAddressList(
      '"Chen, Sarah" <sarah@acme.com>, "Wilson, James" <james@techcorp.io>',
    );
    expect(list).toHaveLength(2);
    expect(list[0]?.name).toBe("Chen, Sarah");
    expect(list[1]?.name).toBe("Wilson, James");
  });

  it("returns [] on empty / null input", () => {
    expect(parseEmailAddressList(null)).toEqual([]);
    expect(parseEmailAddressList("")).toEqual([]);
    expect(parseEmailAddressList("   ")).toEqual([]);
  });
});

describe("extractEmailHost", () => {
  it("returns lowercased host", () => {
    expect(extractEmailHost("Sarah@Acme.COM")).toBe("acme.com");
  });
  it("returns null for invalid addresses", () => {
    expect(extractEmailHost("not-an-email")).toBeNull();
    expect(extractEmailHost("@acme.com")).toBeNull();
    expect(extractEmailHost("sarah@")).toBeNull();
  });
});

describe("extractRootDomain", () => {
  it("returns the registrable domain for normal corporate addresses", () => {
    expect(extractRootDomain("sarah@acme.com")).toBe("acme.com");
    expect(extractRootDomain("eng+team@app.acme.co.uk")).toBe("acme.co.uk");
    expect(extractRootDomain("user@mail.example.com")).toBe("example.com");
  });

  it("returns null for personal-email-provider addresses", () => {
    expect(extractRootDomain("sarah@gmail.com")).toBeNull();
    expect(extractRootDomain("sarah@yahoo.co.uk")).toBeNull();
    expect(extractRootDomain("sarah@protonmail.com")).toBeNull();
  });

  it("respects user overrides — added domains are excluded too", () => {
    expect(
      extractRootDomain("sarah@weirdcorp.test", { add: ["weirdcorp.test"] }),
    ).toBeNull();
  });

  it("respects user overrides — removed domains pass through as company", () => {
    expect(extractRootDomain("sarah@yahoo.com", { remove: ["yahoo.com"] })).toBe("yahoo.com");
  });

  it("returns null for malformed addresses", () => {
    expect(extractRootDomain("not-an-email")).toBeNull();
  });
});

describe("rootDomainFromEmail", () => {
  it("threads through parseEmailAddress + extractRootDomain", () => {
    expect(rootDomainFromEmail("Sarah Chen <sarah@acme.com>")).toBe("acme.com");
    expect(rootDomainFromEmail("Sarah <sarah@gmail.com>")).toBeNull();
    expect(rootDomainFromEmail("garbage")).toBeNull();
  });
});

describe("normalizeEmailKey", () => {
  it("lowercases and strips +tags", () => {
    expect(normalizeEmailKey("Sarah+work@Acme.COM")).toBe("sarah@acme.com");
    expect(normalizeEmailKey("sarah@acme.com")).toBe("sarah@acme.com");
  });
  it("returns null for invalid input", () => {
    expect(normalizeEmailKey("not-an-email")).toBeNull();
    expect(normalizeEmailKey(null)).toBeNull();
  });
});

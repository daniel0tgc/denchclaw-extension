import { describe, expect, it } from "vitest";
import { deriveDisplayDomain, deriveWebsite } from "./website-from-domain";

describe("deriveWebsite", () => {
  it("returns https://<root> for normal corporate addresses", () => {
    expect(deriveWebsite("sarah@acme.com")).toBe("https://acme.com");
    expect(deriveWebsite("eng+team@app.acme.co.uk")).toBe("https://acme.co.uk");
    expect(deriveWebsite("user@mail.example.com")).toBe("https://example.com");
  });

  it("accepts display-name + address format", () => {
    expect(deriveWebsite('"Sarah Chen" <sarah@acme.com>')).toBe("https://acme.com");
    expect(deriveWebsite("Sarah Chen <sarah@acme.com>")).toBe("https://acme.com");
  });

  it("accepts a bare domain too", () => {
    expect(deriveWebsite("acme.com")).toBe("https://acme.com");
    expect(deriveWebsite("https://acme.com")).toBe("https://acme.com");
    expect(deriveWebsite("https://www.acme.com/about")).toBe("https://acme.com");
  });

  it("returns null for personal-email providers", () => {
    expect(deriveWebsite("sarah@gmail.com")).toBeNull();
    expect(deriveWebsite("sarah@yahoo.co.uk")).toBeNull();
    expect(deriveWebsite("sarah@protonmail.com")).toBeNull();
  });

  it("returns null for unparseable / nonsense input", () => {
    expect(deriveWebsite(null)).toBeNull();
    expect(deriveWebsite("")).toBeNull();
    expect(deriveWebsite("not-an-address")).toBeNull();
    expect(deriveWebsite("foo bar")).toBeNull();
  });

  it("respects user overrides — added domain becomes personal too", () => {
    expect(
      deriveWebsite("sarah@weirdcorp.test", { add: ["weirdcorp.test"] }),
    ).toBeNull();
  });

  it("respects user overrides — removed domain becomes a corporate site", () => {
    expect(deriveWebsite("sarah@yahoo.com", { remove: ["yahoo.com"] })).toBe(
      "https://yahoo.com",
    );
  });
});

describe("deriveDisplayDomain", () => {
  it("returns the bare hostname for compact rows", () => {
    expect(deriveDisplayDomain("sarah@app.acme.co.uk")).toBe("acme.co.uk");
    expect(deriveDisplayDomain("acme.com")).toBe("acme.com");
  });

  it("returns null when there's no derivable site", () => {
    expect(deriveDisplayDomain("sarah@gmail.com")).toBeNull();
    expect(deriveDisplayDomain(null)).toBeNull();
  });
});

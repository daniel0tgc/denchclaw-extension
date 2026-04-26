import { describe, expect, it } from "vitest";
import {
  BUNDLED_PERSONAL_DOMAINS_LIST,
  buildPersonalDomainSet,
  isBundledPersonalDomain,
} from "./personal-email-blocklist";

describe("personal-email blocklist", () => {
  describe("isBundledPersonalDomain", () => {
    it("matches the most common consumer providers", () => {
      for (const domain of [
        "gmail.com",
        "yahoo.com",
        "outlook.com",
        "hotmail.com",
        "icloud.com",
        "protonmail.com",
        "aol.com",
        "qq.com",
        "yandex.com",
      ]) {
        expect(isBundledPersonalDomain(domain)).toBe(true);
      }
    });

    it("does not match obvious corporate domains", () => {
      for (const domain of [
        "acme.com",
        "stripe.com",
        "cloudflare.com",
        "openai.com",
      ]) {
        expect(isBundledPersonalDomain(domain)).toBe(false);
      }
    });

    it("is case-insensitive and trims whitespace", () => {
      expect(isBundledPersonalDomain("Gmail.COM")).toBe(true);
      expect(isBundledPersonalDomain(" gmail.com ")).toBe(true);
    });
  });

  describe("buildPersonalDomainSet", () => {
    it("starts from the bundled list when no overrides are given", () => {
      const set = buildPersonalDomainSet();
      expect(set.size).toBe(BUNDLED_PERSONAL_DOMAINS_LIST.length);
      expect(set.has("gmail.com")).toBe(true);
    });

    it("removes domains that the user wants treated as company", () => {
      const set = buildPersonalDomainSet({ remove: ["yahoo.com"] });
      expect(set.has("gmail.com")).toBe(true);
      expect(set.has("yahoo.com")).toBe(false);
    });

    it("adds user-supplied personal-email domains", () => {
      const set = buildPersonalDomainSet({ add: ["weirdcorp-as-personal.test"] });
      expect(set.has("weirdcorp-as-personal.test")).toBe(true);
      expect(set.has("gmail.com")).toBe(true);
    });

    it("normalizes case and whitespace on overrides", () => {
      const set = buildPersonalDomainSet({
        add: [" Custom-Personal.IO "],
        remove: ["GMAIL.com "],
      });
      expect(set.has("custom-personal.io")).toBe(true);
      expect(set.has("gmail.com")).toBe(false);
    });

    it("handles duplicates gracefully", () => {
      const set = buildPersonalDomainSet({
        add: ["gmail.com", "yahoo.com"],
        remove: ["nonexistent.test"],
      });
      expect(set.has("gmail.com")).toBe(true);
      expect(set.has("yahoo.com")).toBe(true);
    });
  });
});

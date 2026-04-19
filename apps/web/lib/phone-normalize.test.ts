import { describe, expect, it } from "vitest";
import { normalizePhoneKey } from "./phone-normalize";

describe("normalizePhoneKey", () => {
  it("strips formatting characters", () => {
    expect(normalizePhoneKey("(555) 234-5678")).toBe("5552345678");
    expect(normalizePhoneKey("555.234.5678")).toBe("5552345678");
    expect(normalizePhoneKey("555 234 5678")).toBe("5552345678");
    expect(normalizePhoneKey("555-234-5678")).toBe("5552345678");
  });

  it("collapses leading 1 on 11-digit US numbers so country-code variants merge", () => {
    expect(normalizePhoneKey("+1 (555) 234-5678")).toBe("5552345678");
    expect(normalizePhoneKey("15552345678")).toBe("5552345678");
    expect(normalizePhoneKey("1-555-234-5678")).toBe("5552345678");
    expect(normalizePhoneKey("(555) 234-5678")).toBe("5552345678");
  });

  it("preserves country code on non-11-digit international numbers", () => {
    expect(normalizePhoneKey("+44 20 7946 0958")).toBe("442079460958");
    expect(normalizePhoneKey("+91 98765 43210")).toBe("919876543210");
    expect(normalizePhoneKey("+33 1 23 45 67 89")).toBe("33123456789");
  });

  it("accepts short but plausible phone numbers (>= 7 digits)", () => {
    expect(normalizePhoneKey("555-1234")).toBe("5551234");
    expect(normalizePhoneKey("555 12 34")).toBe("5551234");
  });

  it("rejects too-short input as junk", () => {
    expect(normalizePhoneKey("x1234")).toBeNull();
    expect(normalizePhoneKey("123")).toBeNull();
    expect(normalizePhoneKey("12345")).toBeNull();
  });

  it("rejects empty / null / non-string input", () => {
    expect(normalizePhoneKey("")).toBeNull();
    expect(normalizePhoneKey("   ")).toBeNull();
    expect(normalizePhoneKey(null)).toBeNull();
    expect(normalizePhoneKey(undefined)).toBeNull();
    // @ts-expect-error - exercising runtime safety
    expect(normalizePhoneKey(12345)).toBeNull();
  });

  it("rejects non-numeric junk", () => {
    expect(normalizePhoneKey("not a phone")).toBeNull();
    expect(normalizePhoneKey("hello world")).toBeNull();
  });

  it("is idempotent: feeding the result back returns the same key", () => {
    const key = normalizePhoneKey("+1 (555) 234-5678");
    expect(key).not.toBeNull();
    expect(normalizePhoneKey(key)).toBe(key);
  });
});

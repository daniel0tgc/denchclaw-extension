import { describe, expect, it } from "vitest";
import { avatarFromName, colorFromString, initialsFromName } from "./avatar-initials";

describe("initialsFromName", () => {
  it("returns 2 initials for first + last", () => {
    expect(initialsFromName("Sarah Chen")).toBe("SC");
    expect(initialsFromName("james wilson")).toBe("JW");
  });

  it("returns 1 initial for a single name", () => {
    expect(initialsFromName("Mark")).toBe("M");
  });

  it("uses first + last (skips middles) for 3+ name parts", () => {
    expect(initialsFromName("John D. Rockefeller")).toBe("JR");
    expect(initialsFromName("María de los Ángeles García")).toBe("MG");
  });

  it("falls back to local-part for email input", () => {
    expect(initialsFromName("mark@dench.com")).toBe("M");
    expect(initialsFromName("sarah.chen@acme.com")).toBe("SC");
    expect(initialsFromName("first_last@x.com")).toBe("FL");
  });

  it("is case-insensitive in source but always uppercase in output", () => {
    expect(initialsFromName("sarah CHEN")).toBe("SC");
  });

  it("returns ? for empty / null / whitespace", () => {
    expect(initialsFromName(null)).toBe("?");
    expect(initialsFromName(undefined)).toBe("?");
    expect(initialsFromName("")).toBe("?");
    expect(initialsFromName("   ")).toBe("?");
  });
});

describe("colorFromString", () => {
  it("is deterministic across calls", () => {
    const a = colorFromString("Sarah Chen");
    const b = colorFromString("Sarah Chen");
    expect(a).toBe(b);
  });

  it("produces different colors for different inputs (typically)", () => {
    const a = colorFromString("Sarah Chen");
    const b = colorFromString("James Wilson");
    // Not guaranteed, but vanishingly unlikely with FNV + 13-color palette
    // for these two specific inputs.
    expect(a).not.toBe(b);
  });

  it("returns a valid hex color", () => {
    expect(colorFromString("anything")).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("falls back to a stable color for empty input", () => {
    const empty1 = colorFromString("");
    const empty2 = colorFromString(null);
    expect(empty1).toBe(empty2);
  });
});

describe("avatarFromName", () => {
  it("bundles initials + colors", () => {
    const a = avatarFromName("Sarah Chen");
    expect(a.initials).toBe("SC");
    expect(a.background).toMatch(/^#[0-9a-f]{6}$/i);
    expect(a.foreground).toBe("#0c0a09");
  });

  it("supports an explicit key for stable color seeding", () => {
    const a = avatarFromName("Sarah Chen", "kumar@dench.com");
    const b = avatarFromName("Different Name", "kumar@dench.com");
    expect(a.background).toBe(b.background); // same key → same color
    expect(a.initials).not.toBe(b.initials);
  });
});

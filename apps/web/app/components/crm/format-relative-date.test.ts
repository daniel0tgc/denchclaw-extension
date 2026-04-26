import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { formatAbsoluteDate, formatDayLabel, formatRelativeDate } from "./format-relative-date";

const NOW = new Date("2026-04-16T12:00:00Z").getTime();

describe("formatRelativeDate", () => {
  beforeAll(() => {
    vi.useFakeTimers({ now: NOW });
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("returns 'just now' for sub-minute differences", () => {
    expect(formatRelativeDate(new Date(NOW - 30_000))).toBe("just now");
  });

  it("returns minutes for sub-hour", () => {
    expect(formatRelativeDate(new Date(NOW - 5 * 60_000))).toMatch(/5m ago/);
  });

  it("returns hours for sub-day", () => {
    expect(formatRelativeDate(new Date(NOW - 3 * 60 * 60_000))).toMatch(/3h ago/);
  });

  it("returns days for sub-week", () => {
    expect(formatRelativeDate(new Date(NOW - 2 * 24 * 60 * 60_000))).toMatch(/2d ago/);
  });

  it("supports future dates", () => {
    expect(formatRelativeDate(new Date(NOW + 5 * 60_000))).toMatch(/in 5m/);
  });

  it("returns empty string for null / undefined / invalid", () => {
    expect(formatRelativeDate(null)).toBe("");
    expect(formatRelativeDate(undefined)).toBe("");
    expect(formatRelativeDate("not-a-date")).toBe("");
  });
});

describe("formatAbsoluteDate", () => {
  it("returns a Month Day, Year · time string", () => {
    const out = formatAbsoluteDate("2026-04-16T17:38:00Z");
    expect(out).toMatch(/Apr 16, 2026/);
  });

  it("handles invalid input", () => {
    expect(formatAbsoluteDate(null)).toBe("");
    expect(formatAbsoluteDate("garbage")).toBe("");
  });
});

describe("formatDayLabel", () => {
  beforeAll(() => {
    vi.useFakeTimers({ now: NOW });
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("returns 'Today' for today's date", () => {
    expect(formatDayLabel(new Date(NOW))).toBe("Today");
  });

  it("returns 'Yesterday' for yesterday", () => {
    expect(formatDayLabel(new Date(NOW - 24 * 60 * 60_000))).toBe("Yesterday");
  });

  it("returns a full label for arbitrary dates", () => {
    const out = formatDayLabel(new Date(NOW - 7 * 24 * 60 * 60_000));
    expect(out).not.toBe("Today");
    expect(out).not.toBe("Yesterday");
    expect(out.length).toBeGreaterThan(3);
  });
});

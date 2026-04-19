import { describe, expect, it } from "vitest";
import { bucketByDate, bucketLabel } from "./activity-timeline";

// Fixed "now" — Thursday, April 16, 2026, 12:00 local.
// ISO week of that date starts Monday April 13, 2026.
const NOW = new Date(2026, 3, 16, 12, 0, 0);

function dt(year: number, month1Indexed: number, day: number, hour = 12): Date {
  return new Date(year, month1Indexed - 1, day, hour, 0, 0);
}

describe("bucketByDate", () => {
  it("returns 'today' for the same calendar day", () => {
    expect(bucketByDate(dt(2026, 4, 16, 8), NOW)).toBe("today");
    expect(bucketByDate(dt(2026, 4, 16, 23), NOW)).toBe("today");
  });

  it("returns 'yesterday' for the previous calendar day", () => {
    expect(bucketByDate(dt(2026, 4, 15, 9), NOW)).toBe("yesterday");
  });

  it("returns 'this_week' for an earlier day in the current ISO week (Mon-Sun)", () => {
    // Monday Apr 13 (start of the week) and Tuesday Apr 14 — both in this week,
    // neither today nor yesterday.
    expect(bucketByDate(dt(2026, 4, 13, 9), NOW)).toBe("this_week");
    expect(bucketByDate(dt(2026, 4, 14, 9), NOW)).toBe("this_week");
  });

  it("returns 'last_week' for the prior Mon-Sun window", () => {
    // Apr 6 (Mon) and Apr 12 (Sun) bracket last week.
    expect(bucketByDate(dt(2026, 4, 6, 9), NOW)).toBe("last_week");
    expect(bucketByDate(dt(2026, 4, 12, 23), NOW)).toBe("last_week");
  });

  it("returns 'this_month' for earlier days in the same month that aren't this/last week", () => {
    // Apr 1-5 are in April but before last week's Mon (Apr 6).
    expect(bucketByDate(dt(2026, 4, 1, 9), NOW)).toBe("this_month");
    expect(bucketByDate(dt(2026, 4, 5, 9), NOW)).toBe("this_month");
  });

  it("returns 'older:YYYY-MM' for prior months", () => {
    expect(bucketByDate(dt(2026, 3, 28, 9), NOW)).toBe("older:2026-03");
    expect(bucketByDate(dt(2026, 1, 5, 9), NOW)).toBe("older:2026-01");
    expect(bucketByDate(dt(2025, 12, 31, 9), NOW)).toBe("older:2025-12");
  });

  it("zero-pads single-digit months in the older bucket key", () => {
    // February 2026 → "older:2026-02" (not "older:2026-2").
    expect(bucketByDate(dt(2026, 2, 14, 9), NOW)).toBe("older:2026-02");
  });

  it("returns 'unknown' for null / undefined / invalid input", () => {
    expect(bucketByDate(null, NOW)).toBe("unknown");
    expect(bucketByDate(undefined, NOW)).toBe("unknown");
    expect(bucketByDate("not-a-date", NOW)).toBe("unknown");
    expect(bucketByDate(NaN, NOW)).toBe("unknown");
  });

  it("accepts ISO strings, Date objects, and millisecond timestamps", () => {
    expect(bucketByDate("2026-04-16T08:00:00", NOW)).toBe("today");
    expect(bucketByDate(dt(2026, 4, 15, 9), NOW)).toBe("yesterday");
    expect(bucketByDate(dt(2026, 4, 14, 9).getTime(), NOW)).toBe("this_week");
  });

  it("handles week boundaries when 'now' is on Monday (today consumes the week's only weekday)", () => {
    const monday = new Date(2026, 3, 13, 12, 0, 0); // Mon Apr 13
    // Apr 12 (Sun) of the previous ISO week — should land in last_week, not yesterday.
    expect(bucketByDate(dt(2026, 4, 12, 9), monday)).toBe("yesterday");
    // Apr 11 (Sat) — also in last week.
    expect(bucketByDate(dt(2026, 4, 11, 9), monday)).toBe("last_week");
  });
});

describe("bucketLabel", () => {
  it("renders stable labels for the fixed buckets", () => {
    expect(bucketLabel("today")).toBe("Today");
    expect(bucketLabel("yesterday")).toBe("Yesterday");
    expect(bucketLabel("this_week")).toBe("Earlier this week");
    expect(bucketLabel("last_week")).toBe("Last week");
    expect(bucketLabel("this_month")).toBe("Earlier this month");
    expect(bucketLabel("unknown")).toBe("Unknown date");
  });

  it("renders 'Month YYYY' for older:YYYY-MM keys", () => {
    expect(bucketLabel("older:2026-03")).toMatch(/March 2026/);
    expect(bucketLabel("older:2025-12")).toMatch(/December 2025/);
    expect(bucketLabel("older:2026-01")).toMatch(/January 2026/);
  });

  it("returns the raw key for unrecognized formats (defensive fallback)", () => {
    expect(bucketLabel("garbage")).toBe("garbage");
  });
});

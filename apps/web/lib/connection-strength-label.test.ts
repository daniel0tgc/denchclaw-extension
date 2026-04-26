import { describe, expect, it } from "vitest";
import {
  getConnectionStrengthBucket,
  getConnectionStrengthLabel,
  STRENGTH_LABELS,
} from "./connection-strength-label";

describe("getConnectionStrengthLabel", () => {
  it("returns the right bucket for each range", () => {
    expect(getConnectionStrengthLabel(1500)).toBe("Inner circle");
    expect(getConnectionStrengthLabel(500)).toBe("Inner circle");
    expect(getConnectionStrengthLabel(499)).toBe("Strong");
    expect(getConnectionStrengthLabel(100)).toBe("Strong");
    expect(getConnectionStrengthLabel(99)).toBe("Active");
    expect(getConnectionStrengthLabel(20)).toBe("Active");
    expect(getConnectionStrengthLabel(19.9)).toBe("Weak");
    expect(getConnectionStrengthLabel(1)).toBe("Weak");
    expect(getConnectionStrengthLabel(0.5)).toBe("Cold");
    expect(getConnectionStrengthLabel(0)).toBe("Cold");
  });

  it("collapses negatives / NaN / null / undefined to Cold", () => {
    expect(getConnectionStrengthLabel(-5)).toBe("Cold");
    expect(getConnectionStrengthLabel(NaN)).toBe("Cold");
    expect(getConnectionStrengthLabel(null)).toBe("Cold");
    expect(getConnectionStrengthLabel(undefined)).toBe("Cold");
  });

  it("accepts numeric strings (DuckDB stores Score as VARCHAR)", () => {
    expect(getConnectionStrengthLabel("1565.5817")).toBe("Inner circle");
    expect(getConnectionStrengthLabel("75.0")).toBe("Active");
    expect(getConnectionStrengthLabel("not a number")).toBe("Cold");
  });
});

describe("getConnectionStrengthBucket", () => {
  it("includes a stable color per bucket", () => {
    expect(getConnectionStrengthBucket(1000).color).toBe("#6366f1");
    expect(getConnectionStrengthBucket(50).color).toBe("#3b82f6");
    expect(getConnectionStrengthBucket(0).color).toBe("#94a3b8");
  });

  it("ranks higher buckets above lower ones", () => {
    const inner = getConnectionStrengthBucket(1000);
    const cold = getConnectionStrengthBucket(0);
    expect(inner.rank).toBeGreaterThan(cold.rank);
  });
});

describe("STRENGTH_LABELS", () => {
  it("is ordered from strongest to coldest", () => {
    expect(STRENGTH_LABELS).toEqual(["Inner circle", "Strong", "Active", "Weak", "Cold"]);
  });
});

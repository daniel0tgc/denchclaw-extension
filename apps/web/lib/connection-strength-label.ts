/**
 * Bucket the raw `Strength Score` into a human-readable label + color.
 *
 * Mirrors dench-2025's `getConnectionStrengthLabel`. The numeric ranges
 * roughly map to:
 *
 *   ≥ 500   "Inner circle"   co-founders, family, daily collaborators
 *   ≥ 100   "Strong"         active business partner / close client
 *   ≥ 20    "Active"         regular thread, monthly cadence
 *   ≥ 1     "Weak"           a few exchanges, real but not warm
 *   = 0     "Cold"           imported but no scored interactions
 *
 * The labels are also used by the People · Strongest saved view as a
 * sortable enum (DESC = "Inner circle" first).
 */

export type StrengthLabel = "Inner circle" | "Strong" | "Active" | "Weak" | "Cold";

export type StrengthBucket = {
  label: StrengthLabel;
  /** Tailwind-class-friendly hex color for the badge dot/background. */
  color: string;
  /** 0–4, useful for sort/order operations. */
  rank: number;
};

const BUCKETS: ReadonlyArray<StrengthBucket & { min: number }> = [
  { min: 500, label: "Inner circle", color: "#6366f1", rank: 4 }, // indigo-500
  { min: 100, label: "Strong",       color: "#22c55e", rank: 3 }, // green-500
  { min: 20,  label: "Active",       color: "#3b82f6", rank: 2 }, // blue-500
  { min: 1,   label: "Weak",         color: "#f59e0b", rank: 1 }, // amber-500
  { min: 0,   label: "Cold",         color: "#94a3b8", rank: 0 }, // slate-400
];

/**
 * Resolve a Strength Score (or any numeric-coercible input) to its bucket.
 * Non-finite / null / negative inputs all collapse to "Cold".
 */
export function getConnectionStrengthBucket(score: number | string | null | undefined): StrengthBucket {
  const num = typeof score === "string" ? Number(score) : score ?? 0;
  if (!Number.isFinite(num) || (num) < 0) {
    const cold = BUCKETS[BUCKETS.length - 1];
    return { label: cold.label, color: cold.color, rank: cold.rank };
  }
  const target = num;
  for (const bucket of BUCKETS) {
    if (target >= bucket.min) {
      return { label: bucket.label, color: bucket.color, rank: bucket.rank };
    }
  }
  const cold = BUCKETS[BUCKETS.length - 1];
  return { label: cold.label, color: cold.color, rank: cold.rank };
}

/**
 * Convenience: just the label string. Use this in list rows where you
 * don't need the color.
 */
export function getConnectionStrengthLabel(score: number | string | null | undefined): StrengthLabel {
  return getConnectionStrengthBucket(score).label;
}

export const STRENGTH_LABELS: ReadonlyArray<StrengthLabel> = [
  "Inner circle",
  "Strong",
  "Active",
  "Weak",
  "Cold",
];

"use client";

import { getConnectionStrengthBucket } from "@/lib/connection-strength-label";

/**
 * Compact pill that shows the bucketed Strength label + colored dot.
 * Used in person/company headers and list rows.
 */
export function ConnectionStrengthChip({
  score,
  size = "md",
  showLabel = true,
}: {
  score: number | string | null | undefined;
  size?: "sm" | "md";
  showLabel?: boolean;
}) {
  const bucket = getConnectionStrengthBucket(score);
  const dotSize = size === "sm" ? 6 : 8;
  const padding = size === "sm" ? "1px 6px" : "2px 8px";
  const fontSize = size === "sm" ? 10 : 11;

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full font-medium"
      style={{
        background: "var(--color-surface-hover)",
        color: "var(--color-text)",
        padding,
        fontSize,
        lineHeight: 1.4,
      }}
      title={`Connection strength: ${bucket.label}`}
    >
      <span
        aria-hidden
        style={{
          width: dotSize,
          height: dotSize,
          borderRadius: 99,
          background: bucket.color,
          flexShrink: 0,
        }}
      />
      {showLabel && bucket.label}
    </span>
  );
}

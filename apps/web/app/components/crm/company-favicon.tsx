"use client";

import { useState } from "react";

/**
 * Square-rounded "logo" tile for a Company. Mirrors dench-2025's pattern:
 * fetch the favicon from Google's s2 service (0 setup, works for nearly
 * every public-facing company domain) and gracefully fall back to a
 * letter monogram if the image errors.
 *
 * Sizes match `PersonAvatar` for visual consistency in mixed lists.
 */
export function CompanyFavicon({
  domain,
  name,
  size = "md",
  className = "",
}: {
  domain?: string | null;
  name?: string | null;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const px = SIZE_PX[size];
  const fontPx = Math.max(10, Math.round(px * 0.42));

  const cleanedDomain = domain?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const faviconUrl = cleanedDomain
    ? `https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(cleanedDomain)}`
    : null;
  const initial = (name ?? cleanedDomain ?? "?").charAt(0).toUpperCase();

  const showImg = !!faviconUrl && !imgFailed;

  return (
    <span
      className={`inline-flex items-center justify-center rounded-xl overflow-hidden shrink-0 ${className}`}
      style={{
        width: px,
        height: px,
        background: "var(--color-surface-hover)",
        border: "1px solid var(--color-border)",
        color: "var(--color-text)",
        fontSize: fontPx,
        fontWeight: 600,
        lineHeight: 1,
      }}
      aria-label={name ?? cleanedDomain ?? "Company"}
    >
      {showImg ? (
        <img
          src={faviconUrl ?? undefined}
          alt=""
          width={Math.round(px * 0.65)}
          height={Math.round(px * 0.65)}
          decoding="async"
          loading="lazy"
          onError={() => setImgFailed(true)}
          style={{ objectFit: "contain" }}
        />
      ) : (
        initial
      )}
    </span>
  );
}

const SIZE_PX: Record<NonNullable<Parameters<typeof CompanyFavicon>[0]["size"]>, number> = {
  sm: 24,
  md: 36,
  lg: 48,
  xl: 64,
};

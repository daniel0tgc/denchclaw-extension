"use client";

import { useState } from "react";
import { avatarFromName } from "@/lib/avatar-initials";

/**
 * Round avatar with three rendering modes (in priority order):
 *
 *   1. If `src` is a valid image URL, render it as `<img>`.
 *   2. If the image fails to load, fall back to initials with a
 *      deterministic background color seeded from `name` or `seed`.
 *   3. If no name available, show "?" on a neutral background.
 *
 * Sizes: `sm` = 24px, `md` = 36px, `lg` = 48px, `xl` = 64px.
 * Default `md` matches the existing `UserBadge` from entry-detail-panel.
 */
export function PersonAvatar({
  src,
  name,
  seed,
  size = "md",
  className = "",
  onError,
}: {
  src?: string | null;
  name?: string | null;
  /** Override the color seed (e.g. use email so two "Sarah Chens" look different). */
  seed?: string | null;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
  /** Called once if the image 404s or errors out — lets parents mount
   *  their own fallback (e.g. try a different provider). */
  onError?: () => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const theme = avatarFromName(name ?? null, seed ?? undefined);
  const px = SIZE_PX[size];
  const fontPx = Math.max(10, Math.round(px * 0.4));

  const showImg = !!src && !imgFailed;

  return (
    <span
      className={`inline-flex items-center justify-center rounded-full overflow-hidden shrink-0 ${className}`}
      style={{
        width: px,
        height: px,
        background: showImg ? "transparent" : theme.background,
        color: theme.foreground,
        fontSize: fontPx,
        fontWeight: 600,
        lineHeight: 1,
      }}
      aria-label={name ?? "Avatar"}
    >
      {showImg ? (
        <img
          src={src ?? undefined}
          alt={name ?? ""}
          width={px}
          height={px}
          decoding="async"
          loading="lazy"
          onError={() => {
            setImgFailed(true);
            onError?.();
          }}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        theme.initials
      )}
    </span>
  );
}

const SIZE_PX: Record<NonNullable<Parameters<typeof PersonAvatar>[0]["size"]>, number> = {
  sm: 24,
  md: 36,
  lg: 48,
  xl: 64,
};

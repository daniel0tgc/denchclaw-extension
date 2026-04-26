/**
 * Avatar helpers — initials from a name + deterministic background color
 * derived from the same string. Used as the fallback when there's no
 * `Avatar URL` field set on a Person.
 *
 * Visual language matches the existing `UserBadge` inline styling in
 * `entry-detail-panel.tsx` so adding a new <PersonAvatar /> doesn't
 * introduce a second look across the app.
 */

/**
 * Resolve up to 2 initials from a display name. Falls back gracefully:
 *
 *   "Sarah Chen" → "SC"
 *   "Mark"        → "M"
 *   "mark@x.com"  → "M"        (uses local-part)
 *   "John D. Rockefeller" → "JR"   (first + last only, skips middle)
 *   "" / null     → "?"
 *
 * Always uppercase, always at most 2 chars.
 */
export function initialsFromName(name: string | null | undefined): string {
  if (!name || typeof name !== "string") {return "?";}
  const trimmed = name.trim();
  if (!trimmed) {return "?";}

  // Email-like input → use the local-part as the source name.
  let source = trimmed;
  if (trimmed.includes("@")) {
    const local = trimmed.slice(0, trimmed.indexOf("@"));
    if (local) {source = local;}
  }
  // Strip common punctuation/separators.
  source = source.replace(/[._+-]/g, " ").trim();
  if (!source) {return "?";}

  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {return "?";}
  if (parts.length === 1) {
    const first = parts[0];
    return (first.charAt(0) || "?").toUpperCase();
  }
  const first = parts[0].charAt(0);
  const last = parts[parts.length - 1].charAt(0);
  return `${first}${last}`.toUpperCase();
}

/**
 * Deterministic background color from any string. Same input → same
 * color across reloads + across users (so two people staring at the
 * same workspace see Sarah Chen with the same avatar tint).
 *
 * Avoids harsh saturated colors; keeps within a soft "CRM-pastel" set
 * so the avatars don't fight the rest of the UI for attention.
 */
const AVATAR_PALETTE: ReadonlyArray<string> = [
  "#fda4af", // rose-300
  "#fbcfe8", // pink-200
  "#d8b4fe", // purple-300
  "#a5b4fc", // indigo-300
  "#93c5fd", // blue-300
  "#7dd3fc", // sky-300
  "#67e8f9", // cyan-300
  "#5eead4", // teal-300
  "#86efac", // green-300
  "#bef264", // lime-300
  "#fde68a", // amber-200
  "#fdba74", // orange-300
  "#fca5a5", // red-300
];

export function colorFromString(input: string | null | undefined): string {
  const text = (input ?? "").trim();
  if (!text) {return AVATAR_PALETTE[0];}
  // FNV-1a 32-bit — small, deterministic, no deps.
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const idx = Math.abs(hash) % AVATAR_PALETTE.length;
  return AVATAR_PALETTE[idx];
}

/**
 * Bundle: initials + background color + foreground color picked for
 * legibility on the chosen background. The foreground heuristic is a
 * simple "use neutral-900 on light backgrounds, neutral-50 on dark".
 *
 * The CRM avatar component uses this directly so consumers don't have
 * to re-derive the contrast color.
 */
export type AvatarTheme = {
  initials: string;
  background: string;
  foreground: string;
};

export function avatarFromName(name: string | null | undefined, key?: string): AvatarTheme {
  const initials = initialsFromName(name);
  const background = colorFromString(key ?? name ?? "");
  const foreground = "#0c0a09"; // stone-950 — every palette entry is light enough for it
  return { initials, background, foreground };
}

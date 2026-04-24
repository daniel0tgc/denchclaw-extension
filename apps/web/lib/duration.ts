/**
 * Duration string helpers shared between API routes and config readers.
 *
 * OpenClaw config values (e.g. `agents.defaults.heartbeat.every`) are written
 * as compact strings like `"24h"`, `"30m"`, `"1h30m"`, `"45s"`, or `"2d"`.
 * These helpers parse them into milliseconds so callers can compare against
 * timestamps without re-implementing the same regex everywhere.
 *
 * Lives in `lib/` (not in a route file) because Next.js route handlers are
 * only allowed to export specific fields (`GET`, `POST`, `dynamic`, etc.) —
 * any other named export fails the build.
 */

/**
 * Parse OpenClaw duration strings like "24h", "30m", "1h30m", "45s", "2d"
 * into milliseconds. Compound units sum (e.g. "1h30m" -> 5_400_000).
 * Returns null for empty input or strings with no recognisable units, and
 * also for inputs with junk between/around the duration tokens
 * (e.g. "24h junk" -> null) so we don't silently accept malformed config.
 */
export function parseDurationToMs(value: string): number | null {
  if (typeof value !== "string") {return null;}
  const trimmed = value.trim();
  if (!trimmed) {return null;}
  const unitMs: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  const matches = trimmed.matchAll(/(\d+)\s*([smhd])/gi);
  let total = 0;
  let matched = false;
  let consumed = 0;
  for (const m of matches) {
    matched = true;
    const amount = Number(m[1]);
    const unit = m[2].toLowerCase();
    total += amount * unitMs[unit];
    consumed += m[0].length;
  }
  if (!matched) {return null;}
  const stripped = trimmed.replaceAll(/\s+/g, "");
  if (consumed !== stripped.length) {return null;}
  return total;
}

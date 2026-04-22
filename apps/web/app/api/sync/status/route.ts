/**
 * Per-source sync health snapshot for the workspace UI.
 *
 * Returns whatever `getSyncStatus()` from `sync-runner.ts` is holding
 * for the Gmail + Calendar incremental loops, plus a synthesized
 * `gmailFresh` / `calendarFresh` boolean derived from the on-disk
 * sync-cursors file. The fresh booleans let the workspace render a
 * "we haven't successfully polled in N hours" banner even right after
 * a process restart, before the in-memory `lastSuccessAt` has had a
 * chance to populate from a real tick.
 *
 * No auth: this is workspace-local read-only state with no secrets in
 * the response. Same threat model as `/api/onboarding/sync/progress`.
 *
 * Why a polling endpoint instead of SSE:
 *
 * - The workspace banner only needs to flip every ~minute; sub-second
 *   updates would be over-engineering for an error state.
 * - SSE clients leak fd's during dev hot-reload more than fetch does,
 *   and we already pay the SSE cost in the onboarding wizard.
 * - Polling makes it trivial to render the banner from a server
 *   component or a /healthz curl, both of which we'd want eventually.
 */

import { getSyncStatus, type SyncSourceStatus } from "@/lib/sync-runner";
import { readSyncCursors } from "@/lib/denchclaw-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Anything older than this counts as "stale" — the polling cron runs
// every 5 minutes, so 30 minutes covers at least 6 ticks of slack
// before we accuse the loop of being broken.
const STALE_AFTER_MS = 30 * 60 * 1000;

type ResponseBody = {
  gmail: SyncSourceStatus & { lastPolledAt: string | null; stale: boolean };
  calendar: SyncSourceStatus & { lastPolledAt: string | null; stale: boolean };
  /**
   * ISO timestamp of when the response was generated. The UI uses this
   * as the "now" reference for staleness math so client clock skew
   * doesn't show false-positive stale banners on a freshly-booted
   * machine that hasn't NTP'd yet.
   */
  serverNow: string;
};

function classify(
  status: SyncSourceStatus,
  lastPolledAt: string | null,
  nowMs: number,
): SyncSourceStatus & { lastPolledAt: string | null; stale: boolean } {
  // Use whichever signal of "still working" is most recent. The
  // in-memory `lastSuccessAt` only spans the current Next.js process
  // lifetime, but the on-disk `lastPolledAt` survives restarts — taking
  // the max of both means a fresh process boot doesn't claim "stale"
  // for 30 minutes on a workspace that's actually been polling fine.
  const inMemoryMs = status.lastSuccessAt ? Date.parse(status.lastSuccessAt) : 0;
  const onDiskMs = lastPolledAt ? Date.parse(lastPolledAt) : 0;
  const newestSuccessMs = Math.max(
    Number.isFinite(inMemoryMs) ? inMemoryMs : 0,
    Number.isFinite(onDiskMs) ? onDiskMs : 0,
  );
  const stale = newestSuccessMs > 0 && nowMs - newestSuccessMs > STALE_AFTER_MS;
  return { ...status, lastPolledAt, stale };
}

export async function GET() {
  const status = getSyncStatus();
  const cursors = readSyncCursors();
  const nowMs = Date.now();
  const body: ResponseBody = {
    gmail: classify(status.gmail, cursors.gmail?.lastPolledAt ?? null, nowMs),
    calendar: classify(status.calendar, cursors.calendar?.lastPolledAt ?? null, nowMs),
    serverNow: new Date(nowMs).toISOString(),
  };
  return Response.json(body, {
    headers: {
      // Banner needs to flip the moment a tick succeeds/fails — no
      // intermediate caching.
      "Cache-Control": "no-store",
    },
  });
}

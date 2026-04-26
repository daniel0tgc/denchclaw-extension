import { startBackfill } from "@/lib/sync-runner";
import { writeSyncCursors } from "@/lib/denchclaw-state";
import { runEmailCleanup } from "@/lib/email-classifier-cleanup";
import { trackServer } from "@/lib/telemetry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = { restart?: unknown; cleanup?: unknown };

export async function POST(req: Request) {
  let body: Body = {};
  try {
    body = (await req.json().catch(() => ({}))) as Body;
  } catch {
    body = {};
  }

  // `cleanup: true` runs the retroactive newsletter classifier sweep
  // BEFORE kicking off any new sync. Idempotent — safe to call repeatedly.
  // Returns the summary as `cleanup` in the response so the caller can
  // surface deletion counts.
  let cleanupSummary: Awaited<ReturnType<typeof runEmailCleanup>> | null = null;
  if (body.cleanup === true) {
    try {
      cleanupSummary = await runEmailCleanup();
      trackServer("onboarding_email_cleanup_ran", {
        ok: cleanupSummary.ok,
        demoted: cleanupSummary.messagesDemoted,
        people_deleted: cleanupSummary.peopleDeleted,
        companies_deleted: cleanupSummary.companiesDeleted,
      });
    } catch (err) {
      cleanupSummary = {
        ok: false,
        messagesProcessed: 0,
        messagesReclassified: 0,
        messagesDemoted: 0,
        fromRelationsCleared: 0,
        interactionsDeleted: 0,
        peopleDeleted: 0,
        companiesDeleted: 0,
        backupPath: null,
        error: err instanceof Error ? err.message : "Cleanup failed.",
      };
    }
  }

  // `restart: true` lets a developer (or a "Sync now" button) re-trigger a
  // backfill without re-doing the wizard. We zero out the saved cursors so
  // the next run starts from the very first page again — useful when an
  // earlier run silently failed and there's nothing in DuckDB yet.
  if (body.restart === true) {
    writeSyncCursors({
      gmail: {
        backfillPageToken: null,
        historyId: undefined,
        messagesProcessed: 0,
        lastBackfillCompletedAt: undefined,
      },
      calendar: {
        backfillPageToken: null,
        syncToken: undefined,
        eventsProcessed: 0,
        lastBackfillCompletedAt: undefined,
      },
    });
  }

  const result = startBackfill({});
  if (!result.started && !result.alreadyRunning) {
    return Response.json(
      { error: result.reason ?? "Could not start sync.", cleanup: cleanupSummary },
      { status: 400 },
    );
  }
  trackServer("onboarding_sync_started", {
    already_running: result.alreadyRunning,
    restart: body.restart === true,
    cleanup: body.cleanup === true,
  });
  return Response.json({
    started: result.started,
    alreadyRunning: result.alreadyRunning,
    cleanup: cleanupSummary,
  });
}

import type { AnyAgentTool, OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { runQuery } from './db.js';
import type { SyncQueueService } from './sync-queue.js';

interface CountRow {
  cnt: number;
}

interface LastSyncRow {
  last_sync: string | null;
}

export function registerSyncStatusTool(
  api: OpenClawPluginApi,
  queueService: SyncQueueService,
  dbPath?: string,
): void {
  api.registerTool({
    name: 'b2b_crm_sync_status',
    label: 'B2B CRM Sync Status',
    description:
      'Show current sync queue depth and last sync timestamp. Surfaces pending operations so the user knows what has not yet synced to cloud.',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async (_toolCallId: string, _params: Record<string, unknown>) => {
      const [pendingRows, failedRows, lastSyncRows] = await Promise.all([
        runQuery<CountRow>(
          `SELECT COUNT(*) AS cnt FROM sync_queue WHERE status = 'pending'`,
          [],
          dbPath,
        ),
        runQuery<CountRow>(
          `SELECT COUNT(*) AS cnt FROM sync_queue WHERE status = 'failed'`,
          [],
          dbPath,
        ),
        runQuery<LastSyncRow>(
          `SELECT MAX(processed_at)::VARCHAR AS last_sync FROM sync_queue WHERE status = 'done'`,
          [],
          dbPath,
        ),
      ]);

      const pending = Number(pendingRows[0]?.cnt ?? 0);
      const failed = Number(failedRows[0]?.cnt ?? 0);
      const lastSyncAt = lastSyncRows[0]?.last_sync ?? queueService.getLastSyncAt()?.toISOString() ?? null;

      const result = {
        pending,
        failed,
        lastSyncAt,
        isOnline: queueService.isOnline(),
      };

      const summary = pending > 0
        ? `${pending} change(s) pending sync${failed > 0 ? `, ${failed} failed` : ''}.`
        : lastSyncAt
        ? `All synced as of ${lastSyncAt}.`
        : 'No sync activity yet.';

      return {
        content: [{ type: 'text' as const, text: `${summary}\n${JSON.stringify(result, null, 2)}` }],
        details: result,
      };
    },
  } as AnyAgentTool);
}

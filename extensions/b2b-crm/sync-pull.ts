import type { AnyAgentTool, OpenClawPluginApi } from 'openclaw/plugin-sdk';
import type { SyncQueueService } from './sync-queue.js';

export function registerSyncPullTool(
  api: OpenClawPluginApi,
  queueService: SyncQueueService,
): void {
  api.registerTool({
    name: 'b2b_crm_sync_pull',
    label: 'B2B CRM Sync Pull',
    description:
      'Pull latest changes from cloud and merge with local state.',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async (_toolCallId: string, _params: Record<string, unknown>) => {
      const stats = await queueService.drainOnce();
      const result = {
        pulled: stats.pulled,
        pushed: stats.pushed,
        conflictsResolved: stats.conflicts,
        message:
          stats.pulled > 0
            ? `Pulled ${stats.pulled} field update(s), resolved ${stats.conflicts} conflict(s).`
            : 'No new changes from cloud.',
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  } as AnyAgentTool);
}

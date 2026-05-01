import type { AnyAgentTool, OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { getConnection } from './db.js';
import { incrementHLC, type HLC } from './hlc.js';

interface SyncStateRow {
  entry_id: string;
  field_id: string;
  value: string | null;
  hlc_ts: number;
  hlc_counter: number;
  node_id: string;
}

export function registerSyncPushTool(
  api: OpenClawPluginApi,
  getLocalHlc: () => HLC,
  nodeId: string,
  dbPath?: string,
): void {
  api.registerTool({
    name: 'b2b_crm_sync_push',
    label: 'B2B CRM Sync Push',
    description: 'Push local CRM changes to cloud. Queues changes for async processing.',
    parameters: {
      type: 'object',
      properties: {
        entryIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Entry IDs to push. Omit for all pending.',
        },
      },
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const entryIds = Array.isArray(params['entryIds'])
        ? (params['entryIds'] as string[])
        : null;

      const conn = await getConnection(dbPath);
      let queued = 0;
      try {
        let stateRows: SyncStateRow[];
        if (entryIds && entryIds.length > 0) {
          const placeholders = entryIds.map(() => '?').join(', ');
          stateRows = await conn.all<SyncStateRow>(
            `SELECT entry_id, field_id, value, hlc_ts, hlc_counter, node_id
             FROM sync_state WHERE entry_id IN (${placeholders})`,
            ...entryIds,
          );
        } else {
          stateRows = await conn.all<SyncStateRow>(
            'SELECT entry_id, field_id, value, hlc_ts, hlc_counter, node_id FROM sync_state',
          );
        }

        if (stateRows.length > 0) {
          const hlc = incrementHLC(getLocalHlc());
          await conn.run('BEGIN');
          try {
            for (const row of stateRows) {
              await conn.run(
                `INSERT INTO sync_queue (operation, entry_id, field_id, value, hlc_ts, hlc_counter, node_id)
                 VALUES ('push', ?, ?, ?, ?, ?, ?)`,
                row.entry_id,
                row.field_id,
                row.value,
                hlc.ts,
                hlc.counter,
                nodeId,
              );
            }
            await conn.run('COMMIT');
            queued = stateRows.length;
          } catch (err) {
            await conn.run('ROLLBACK');
            throw err;
          }
        }
      } finally {
        await conn.close();
      }

      const result = { queued, message: `Queued ${queued} field state(s) for sync push.` };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  } as AnyAgentTool);
}

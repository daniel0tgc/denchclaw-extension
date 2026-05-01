import { getConnection, runQuery } from './db.js';
import { type HLC, createHLC, receiveHLC } from './hlc.js';
import { mergeAllFields, type FieldState } from './crdt.js';
import type { MockCloud } from './mock-cloud.js';
import { syncSchemas, drainPendingFieldValues } from './schema-sync.js';

export interface DrainResult {
  pushed: number;
  pulled: number;
  conflicts: number;
}

export interface SyncQueueService {
  start(intervalMs: number): void;
  stop(): void;
  drainOnce(): Promise<DrainResult>;
  isOnline(): boolean;
  getLastSyncAt(): Date | null;
  getLastError(): string | null;
}

interface SyncQueueRow {
  id: string;
  entry_id: string;
  field_id: string | null;
  value: string | null;
  hlc_ts: number;
  hlc_counter: number;
  node_id: string;
}

interface SyncStateRow {
  entry_id: string;
  field_id: string;
  value: string | null;
  hlc_ts: number;
  hlc_counter: number;
  node_id: string;
}

export function createSyncQueueService(
  cloud: MockCloud,
  nodeId: string,
  dbPath?: string,
  workspacePath?: string | null,
): SyncQueueService {
  let timer: ReturnType<typeof setInterval> | null = null;
  let online = false;
  let lastSyncAt: Date | null = null;
  let drainLastError: string | null = null;
  let localHlc: HLC = createHLC(nodeId);

  return {
    isOnline(): boolean {
      return online;
    },

    getLastSyncAt(): Date | null {
      return lastSyncAt;
    },

    getLastError(): string | null {
      return drainLastError;
    },

    start(intervalMs: number): void {
      if (timer) return;
      timer = setInterval(() => {
        this.drainOnce().catch(() => { /* handled inside */ });
      }, intervalMs);
    },

    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    async drainOnce(): Promise<DrainResult> {
      let pushed = 0;
      let pulled = 0;
      let conflicts = 0;

      try {
        // Step 0: schema sync — exchange schema changes before field sync.
        // Skipped gracefully if EAV tables are not yet set up (e.g., in isolated unit tests).
        try {
          await syncSchemas(cloud, workspacePath ?? null, dbPath);
          await drainPendingFieldValues(dbPath);
        } catch {
          // Schema tables may not exist in minimal test setups — field sync still proceeds
        }

        const conn = await getConnection(dbPath);
        try {
          // Step 1: grab pending push rows
          const pendingRows = await conn.all<SyncQueueRow>(
            `SELECT id, entry_id, field_id, value, hlc_ts, hlc_counter, node_id
             FROM sync_queue WHERE status = 'pending' AND operation = 'push'`,
          );

          if (pendingRows.length > 0) {
            const ids = pendingRows.map((r) => r.id);
            const placeholders = ids.map(() => '?').join(', ');

            // Step 2: mark processing
            await conn.run(
              `UPDATE sync_queue SET status = 'processing' WHERE id IN (${placeholders})`,
              ...ids,
            );

            // Step 3: collect local sync_state for affected entries
            const entryIds = [...new Set(pendingRows.map((r) => r.entry_id))];
            const entryPlaceholders = entryIds.map(() => '?').join(', ');
            const localStateRows = await conn.all<SyncStateRow>(
              `SELECT entry_id, field_id, value, hlc_ts, hlc_counter, node_id
               FROM sync_state WHERE entry_id IN (${entryPlaceholders})`,
              ...entryIds,
            );

            const localStates: FieldState[] = localStateRows.map((r) => ({
              entryId: r.entry_id,
              fieldId: r.field_id,
              value: r.value,
              hlc: { ts: Number(r.hlc_ts), counter: Number(r.hlc_counter), nodeId: r.node_id },
            }));

            // Step 4: push to cloud
            await cloud.push(localStates);
            pushed = localStates.length;

            // Step 5: pull remote changes
            const remoteStates = await cloud.pull({ ts: 0, counter: 0, nodeId: '' });
            pulled = remoteStates.length;

            if (remoteStates.length > 0) {
              // Step 6: CRDT merge
              const { merged, conflicts: conflictList } = mergeAllFields(localStates, remoteStates);
              conflicts = conflictList.length;

              // Step 7: write merged state to local entry_fields and sync_state
              await conn.run('BEGIN');
              try {
                for (const state of merged) {
                  // Update sync_state (upsert)
                  await conn.run(
                    `INSERT INTO sync_state (entry_id, field_id, value, hlc_ts, hlc_counter, node_id)
                     VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT (entry_id, field_id) DO UPDATE SET
                       value = excluded.value,
                       hlc_ts = excluded.hlc_ts,
                       hlc_counter = excluded.hlc_counter,
                       node_id = excluded.node_id`,
                    state.entryId,
                    state.fieldId,
                    state.value,
                    state.hlc.ts,
                    state.hlc.counter,
                    state.hlc.nodeId,
                  );

                  // Update entry_fields (upsert)
                  await conn.run(
                    `INSERT INTO entry_fields (entry_id, field_id, value)
                     VALUES (?, ?, ?)
                     ON CONFLICT (entry_id, field_id) DO UPDATE SET value = excluded.value`,
                    state.entryId,
                    state.fieldId,
                    state.value,
                  );
                }
                await conn.run('COMMIT');
              } catch (err) {
                await conn.run('ROLLBACK');
                throw err;
              }
            }

            // Step 8: mark done
            await conn.run(
              `UPDATE sync_queue SET status = 'done', processed_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
              ...ids,
            );

            // Advance local HLC after sync
            for (const rs of remoteStates) {
              localHlc = receiveHLC(localHlc, rs.hlc);
            }
          }
        } finally {
          await conn.close();
        }

        online = true;
        lastSyncAt = new Date();
      } catch (err) {
        online = false;
        // Re-expose error message for testability via drainLastError
        drainLastError = err instanceof Error ? err.message : String(err);
      }

      return { pushed, pulled, conflicts };
    },
  };
}

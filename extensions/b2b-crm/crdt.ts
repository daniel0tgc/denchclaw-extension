import { type HLC, compareHLC } from './hlc.js';

export interface FieldState {
  entryId: string;
  fieldId: string;
  value: string | null;
  hlc: HLC;
}

export interface ConflictRecord {
  field: FieldState;
  winner: 'local' | 'remote';
}

export function mergeFieldState(local: FieldState, remote: FieldState): FieldState {
  const cmp = compareHLC(local.hlc, remote.hlc);
  if (cmp >= 0) return local;
  return remote;
}

export function mergeAllFields(
  localStates: FieldState[],
  remoteStates: FieldState[],
): { merged: FieldState[]; conflicts: ConflictRecord[] } {
  const localMap = new Map<string, FieldState>();
  for (const state of localStates) {
    localMap.set(`${state.entryId}:${state.fieldId}`, state);
  }

  const remoteMap = new Map<string, FieldState>();
  for (const state of remoteStates) {
    remoteMap.set(`${state.entryId}:${state.fieldId}`, state);
  }

  const merged: FieldState[] = [];
  const conflicts: ConflictRecord[] = [];

  const allKeys = new Set([...localMap.keys(), ...remoteMap.keys()]);

  for (const key of allKeys) {
    const local = localMap.get(key);
    const remote = remoteMap.get(key);

    if (local && !remote) {
      merged.push(local);
    } else if (!local && remote) {
      merged.push(remote);
    } else if (local && remote) {
      const cmp = compareHLC(local.hlc, remote.hlc);
      if (cmp > 0) {
        merged.push(local);
        conflicts.push({ field: remote, winner: 'local' });
      } else if (cmp < 0) {
        merged.push(remote);
        conflicts.push({ field: local, winner: 'remote' });
      } else {
        // Equal HLC — remote wins (arbitrary but deterministic)
        merged.push(remote);
        conflicts.push({ field: local, winner: 'remote' });
      }
    }
  }

  return { merged, conflicts };
}

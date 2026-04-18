"use client";

/**
 * Local-only state for the CRM inbox: starred threads, read/unread state,
 * and selected (checkbox) state. Lives in `localStorage` because we
 * don't yet have schema fields for any of these — Gmail two-way sync is
 * a separate milestone. When that ships, swap the storage for a real
 * fetch and the consumers stay the same.
 *
 * Keyed per workspace + scope so two workspaces don't share star state.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

type Scope = "starred" | "read" | "selected";

const KEY_PREFIX = "denchclaw.crm-inbox";

function storageKey(scope: Scope, workspaceId: string): string {
  return `${KEY_PREFIX}:${workspaceId}:${scope}`;
}

function readSet(scope: Scope, workspaceId: string): Set<string> {
  if (typeof window === "undefined") {return new Set();}
  try {
    const raw = window.localStorage.getItem(storageKey(scope, workspaceId));
    if (!raw) {return new Set();}
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((v): v is string => typeof v === "string"));
    }
  } catch {
    /* ignore corrupt entries */
  }
  return new Set();
}

function writeSet(scope: Scope, workspaceId: string, value: Set<string>): void {
  if (typeof window === "undefined") {return;}
  try {
    window.localStorage.setItem(
      storageKey(scope, workspaceId),
      JSON.stringify(Array.from(value)),
    );
  } catch {
    /* quota exceeded — drop silently */
  }
}

/**
 * Generic toggleable-set hook backed by localStorage. Returns the current
 * Set, a `has(id)` checker, and `toggle / set / unset / clear` mutators.
 *
 * Cross-tab sync is wired via the storage event so opening the inbox in
 * a second tab reflects star/read changes without a refresh.
 */
function useToggleableSet(scope: Scope, workspaceId: string) {
  const [version, setVersion] = useState(0);
  const set = useMemo(() => readSet(scope, workspaceId), [scope, workspaceId, version]);

  // Cross-tab sync
  useEffect(() => {
    if (typeof window === "undefined") {return;}
    const key = storageKey(scope, workspaceId);
    const handler = (e: StorageEvent) => {
      if (e.key === key) {setVersion((v) => v + 1);}
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [scope, workspaceId]);

  const toggle = useCallback(
    (id: string) => {
      const next = readSet(scope, workspaceId);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      writeSet(scope, workspaceId, next);
      setVersion((v) => v + 1);
    },
    [scope, workspaceId],
  );

  const setOn = useCallback(
    (id: string) => {
      const next = readSet(scope, workspaceId);
      if (!next.has(id)) {
        next.add(id);
        writeSet(scope, workspaceId, next);
        setVersion((v) => v + 1);
      }
    },
    [scope, workspaceId],
  );

  const setOff = useCallback(
    (id: string) => {
      const next = readSet(scope, workspaceId);
      if (next.has(id)) {
        next.delete(id);
        writeSet(scope, workspaceId, next);
        setVersion((v) => v + 1);
      }
    },
    [scope, workspaceId],
  );

  const setMany = useCallback(
    (ids: ReadonlyArray<string>, on: boolean) => {
      const next = readSet(scope, workspaceId);
      let changed = false;
      for (const id of ids) {
        if (on && !next.has(id)) {
          next.add(id);
          changed = true;
        } else if (!on && next.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      if (changed) {
        writeSet(scope, workspaceId, next);
        setVersion((v) => v + 1);
      }
    },
    [scope, workspaceId],
  );

  const clear = useCallback(() => {
    writeSet(scope, workspaceId, new Set());
    setVersion((v) => v + 1);
  }, [scope, workspaceId]);

  const has = useCallback((id: string) => set.has(id), [set]);

  return { set, has, toggle, setOn, setOff, setMany, clear };
}

/**
 * Starred threads. UI surfaces this in the row + conversation header.
 * Mock until two-way Gmail sync wires `Starred` field on email_thread.
 */
export function useStarredThreads(workspaceId: string) {
  return useToggleableSet("starred", workspaceId);
}

/**
 * Read state. We store the SET of read thread ids — anything not in the
 * set is rendered as "unread" (bold subject + accent dot). When a thread
 * is opened we mark it read.
 */
export function useReadState(workspaceId: string) {
  return useToggleableSet("read", workspaceId);
}

/**
 * Bulk-select state for the checkbox column. Lives only for the session
 * — we still persist via localStorage so a refresh doesn't blow away an
 * in-progress selection, but the toolbar offers a Clear action.
 */
export function useSelectedThreads(workspaceId: string) {
  return useToggleableSet("selected", workspaceId);
}

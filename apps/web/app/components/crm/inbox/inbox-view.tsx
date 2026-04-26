"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { InboxLayout } from "./inbox-layout";
import { InboxToolbar } from "./inbox-toolbar";
import { ThreadList } from "./thread-list";
import { ConversationPane } from "./conversation-pane";
import { KeyboardShortcutsHelp } from "./keyboard-shortcuts-help";
import { useInboxHotkeys } from "./use-inbox-hotkeys";
import {
  useReadState,
  useSelectedThreads,
  useStarredThreads,
} from "@/lib/crm-inbox-state";
import type { SenderFilter, Thread } from "./types";

const DEFAULT_LIMIT = 100;

/**
 * Top-level Inbox component for the CRM main panel. Composes:
 *
 *   InboxLayout (two-pane resizable)
 *   ├─ left: InboxToolbar + ThreadList
 *   └─ right: ConversationPane
 *
 * Owns:
 *   - URL state: ?crm=inbox&q=…&sender=person|all|automated&thread=<id>
 *   - Server fetch (debounced on search)
 *   - Selection/star/read state via the localStorage hooks
 *   - Keyboard navigation (j/k/o/Enter/Esc/x/s/e/?/“/”)
 */
export function InboxView({
  onOpenPerson,
}: {
  onOpenPerson?: (id: string) => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // ─── URL state ─────────────────────────────────────────────────────────
  const initialThread = searchParams.get("thread");
  const initialSearch = searchParams.get("q") ?? "";
  const initialSenderRaw = searchParams.get("sender");
  const initialSender: SenderFilter =
    initialSenderRaw === "all" || initialSenderRaw === "automated"
      ? initialSenderRaw
      : "person";

  const [search, setSearch] = useState(initialSearch);
  const [senderFilter] = useState<SenderFilter>(initialSender);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(initialThread);
  const [focusedIndex, setFocusedIndex] = useState<number>(0);
  const [helpOpen, setHelpOpen] = useState(false);

  const [threads, setThreads] = useState<Thread[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Persisted local state (star / read / selected)
  const workspaceId = "default"; // TODO: thread workspace id once exposed
  const starred = useStarredThreads(workspaceId);
  const readState = useReadState(workspaceId);
  const selection = useSelectedThreads(workspaceId);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Fetch (debounced on search/sender) ───────────────────────────────
  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (search.trim()) {params.set("q", search.trim());}
        params.set("sender", senderFilter);
        params.set("limit", String(DEFAULT_LIMIT));
        const res = await fetch(`/api/crm/inbox?${params.toString()}`, {
          cache: "no-store",
          signal,
        });
        if (!res.ok) {throw new Error(`HTTP ${res.status}`);}
        const body = (await res.json()) as { threads: Thread[]; total: number };
        setThreads(body.threads);
        setTotal(body.total);
      } catch (err) {
        if ((err as Error).name === "AbortError") {return;}
        setError(err instanceof Error ? err.message : "Failed to load inbox.");
      } finally {
        setLoading(false);
      }
    },
    [search, senderFilter],
  );

  useEffect(() => {
    if (debounceRef.current) {clearTimeout(debounceRef.current);}
    const controller = new AbortController();
    debounceRef.current = setTimeout(() => {
      void load(controller.signal);
    }, 150);
    return () => {
      controller.abort();
      if (debounceRef.current) {clearTimeout(debounceRef.current);}
    };
  }, [load]);

  // ─── URL sync (write) ──────────────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("crm", "inbox");
    if (search.trim()) {params.set("q", search.trim());}
    else {params.delete("q");}
    if (senderFilter !== "person") {params.set("sender", senderFilter);}
    else {params.delete("sender");}
    if (selectedThreadId) {params.set("thread", selectedThreadId);}
    else {params.delete("thread");}
    const next = `/?${params.toString()}`;
    if (next !== `${window.location.pathname}${window.location.search}`) {
      router.replace(next, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional one-way write
  }, [search, senderFilter, selectedThreadId, router]);

  // Keep focusedIndex pointing to the selected thread.
  useEffect(() => {
    if (!selectedThreadId) {return;}
    const idx = threads.findIndex((t) => t.id === selectedThreadId);
    if (idx >= 0) {setFocusedIndex(idx);}
  }, [selectedThreadId, threads]);

  // Mark selected thread as read once loaded.
  useEffect(() => {
    if (selectedThreadId) {
      readState.setOn(selectedThreadId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- readState mutators are stable
  }, [selectedThreadId]);

  const selectedThread = useMemo(
    () => threads.find((t) => t.id === selectedThreadId) ?? null,
    [threads, selectedThreadId],
  );
  const focusedThread = threads[focusedIndex] ?? null;

  // ─── Handlers ──────────────────────────────────────────────────────────
  const handleSelect = useCallback(
    (thread: Thread) => {
      setSelectedThreadId(thread.id);
      setFocusedIndex(threads.findIndex((t) => t.id === thread.id));
    },
    [threads],
  );

  const handleClose = useCallback(() => {
    setSelectedThreadId(null);
  }, []);

  const handleBulkAction = useCallback(
    (action: "read" | "star" | "archive") => {
      const ids = Array.from(selection.set);
      if (action === "read") {
        selection.set.forEach((id) => readState.setOn(id));
      } else if (action === "star") {
        ids.forEach((id) => starred.toggle(id));
      } else {
        // Archive — no-op + toast (pending two-way sync)
        if (typeof window !== "undefined") {
          window.alert(
            "Read-only inbox — archive will work once two-way Gmail sync ships.",
          );
        }
      }
    },
    [selection, readState, starred],
  );

  // ─── Hotkeys ───────────────────────────────────────────────────────────
  useInboxHotkeys(
    {
      next: () => {
        if (threads.length === 0) {return;}
        const next = Math.min(threads.length - 1, focusedIndex + 1);
        setFocusedIndex(next);
        const thread = threads[next];
        if (thread) {handleSelect(thread);}
      },
      prev: () => {
        if (threads.length === 0) {return;}
        const prev = Math.max(0, focusedIndex - 1);
        setFocusedIndex(prev);
        const thread = threads[prev];
        if (thread) {handleSelect(thread);}
      },
      openSelected: () => {
        if (focusedThread) {handleSelect(focusedThread);}
      },
      back: () => {
        if (helpOpen) {
          setHelpOpen(false);
          return;
        }
        setSelectedThreadId(null);
      },
      focusSearch: () => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      },
      toggleSelectedBulk: () => {
        if (focusedThread) {selection.toggle(focusedThread.id);}
      },
      toggleStar: () => {
        if (focusedThread) {starred.toggle(focusedThread.id);}
      },
      archiveSelected: () => {
        handleBulkAction("archive");
      },
      openHelp: () => setHelpOpen(true),
    },
    !helpOpen,
  );

  // Auto-scroll focused row into view
  useEffect(() => {
    if (!focusedThread) {return;}
    const el = document.querySelector<HTMLElement>(
      `[data-thread-row="true"][data-thread-id="${cssEscape(focusedThread.id)}"]`,
    );
    if (el) {
      el.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
  }, [focusedThread]);

  return (
    <>
      <InboxLayout
        hasSelection={!!selectedThread}
        list={
          <div
            className="flex h-full min-h-0 flex-col"
            style={{ background: "var(--color-bg)" }}
          >
            <InboxToolbar
              ref={searchInputRef}
              search={search}
              onSearchChange={setSearch}
              selectedCount={selection.set.size}
              onClearSelection={selection.clear}
              onBulkAction={handleBulkAction}
              onOpenShortcuts={() => setHelpOpen(true)}
            />
            <div className="flex-1 min-h-0 overflow-y-auto">
              {error && (
                <div
                  className="px-4 py-3 text-[13px]"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  {error}
                </div>
              )}
              <ThreadList
                threads={threads}
                loading={loading}
                selectedThreadId={selectedThreadId}
                selectedIds={selection.set}
                isRead={readState.has}
                isStarred={starred.has}
                onSelect={handleSelect}
                onToggleSelected={selection.toggle}
                onToggleStarred={starred.toggle}
              />
              {!loading && total > threads.length && (
                <div
                  className="px-4 py-3 text-[12px]"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  Showing {threads.length.toLocaleString()} of {total.toLocaleString()} threads.
                </div>
              )}
            </div>
          </div>
        }
        conversation={
          <ConversationPane
            selectedThread={selectedThread}
            starred={selectedThread ? starred.has(selectedThread.id) : false}
            onToggleStar={() => {
              if (selectedThread) {starred.toggle(selectedThread.id);}
            }}
            onOpenPerson={onOpenPerson}
            onClose={handleClose}
          />
        }
      />
      <KeyboardShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  );
}

// CSS.escape polyfill for older runtime contexts (Node test envs)
function cssEscape(value: string): string {
  if (typeof window !== "undefined" && typeof window.CSS?.escape === "function") {
    return window.CSS.escape(value);
  }
  return value.replace(/['"\\]/g, "\\$&");
}

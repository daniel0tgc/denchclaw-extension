"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CrmEmptyState, CrmLoadingState } from "../crm-list-shell";
import { ConversationHeader } from "./conversation-header";
import { MessageCard } from "./message-card";
import { QuickReply } from "./quick-reply";
import type { Participant } from "./participant-chips";
import type { Message, Thread } from "./types";

type ThreadDetail = {
  thread_id: string;
  messages: Message[];
  people: Participant[];
};

/**
 * Right pane (or full-pane on mobile / focus-mode). Loads the selected
 * thread, renders messages with the latest expanded by default, and
 * shows a fixed visual reply composer at the bottom.
 *
 * Slide-in animation: when `selectedThread.id` changes, the inner pane
 * fades + translates in from the right ~10px so the user perceives the
 * swap rather than a brittle full re-render.
 */
export function ConversationPane({
  selectedThread,
  starred,
  onToggleStar,
  onOpenPerson,
  onClose,
  onToggleFocus,
  focusMode,
}: {
  selectedThread: Thread | null;
  starred: boolean;
  onToggleStar: () => void;
  onOpenPerson?: (id: string) => void;
  /** Single-pane drilldown back-to-list. */
  onClose?: () => void;
  onToggleFocus?: () => void;
  focusMode?: boolean;
}) {
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load + refresh when the selected thread changes.
  useEffect(() => {
    if (!selectedThread) {
      setDetail(null);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/crm/inbox/${encodeURIComponent(selectedThread.id)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) {throw new Error(`HTTP ${res.status}`);}
        const body = (await res.json()) as ThreadDetail;
        setDetail(body);
      } catch (err) {
        if ((err as Error).name === "AbortError") {return;}
        setError(err instanceof Error ? err.message : "Failed to load this thread.");
      } finally {
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [selectedThread]);

  // Slide-in animation: bump a key on every thread change.
  const animationKey = selectedThread?.id ?? "empty";

  // People map for quick lookup inside MessageCard.
  const peopleMap = useMemo<Map<string, Participant>>(() => {
    const map = new Map<string, Participant>();
    if (detail?.people) {
      for (const p of detail.people) {map.set(p.id, p);}
    }
    if (selectedThread?.participants) {
      for (const p of selectedThread.participants) {
        if (!map.has(p.id)) {map.set(p.id, p);}
      }
    }
    return map;
  }, [detail, selectedThread]);

  // Auto-scroll to the bottom-most message on first paint of a thread.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (detail && scrollerRef.current) {
      // Wait one frame so the DOM has the new message cards mounted.
      requestAnimationFrame(() => {
        const el = scrollerRef.current;
        if (!el) {return;}
        el.scrollTop = el.scrollHeight;
      });
    }
  }, [detail]);

  const handleClose = useCallback(() => {
    onClose?.();
  }, [onClose]);

  if (!selectedThread) {
    return (
      <div
        className="flex h-full min-h-0 flex-col items-center justify-center px-8 text-center"
        style={{ background: "var(--color-main-bg)" }}
      >
        <span
          className="font-instrument italic text-2xl"
          style={{ color: "var(--color-text-muted)" }}
        >
          Pick a thread
        </span>
        <p
          className="mt-2 text-[13px] max-w-xs"
          style={{
            color: "var(--color-text-muted)",
            fontFamily: '"Bookerly", Georgia, serif',
          }}
        >
          Click any conversation in the list to read it here. Use{" "}
          <kbd className="rounded border px-1.5 py-0.5 text-[11px]">j</kbd> /{" "}
          <kbd className="rounded border px-1.5 py-0.5 text-[11px]">k</kbd> to navigate.
        </p>
      </div>
    );
  }

  const lastMessageId = detail?.messages.at(-1)?.id;

  return (
    <div
      key={animationKey}
      className="flex h-full min-h-0 flex-col motion-safe:animate-[conv-slide-in_180ms_ease-out]"
      style={{ background: "var(--color-main-bg)" }}
    >
      <style>{`
        @keyframes conv-slide-in {
          from { opacity: 0; transform: translate3d(8px, 0, 0); }
          to { opacity: 1; transform: translate3d(0, 0, 0); }
        }
      `}</style>
      <ConversationHeader
        subject={selectedThread.subject}
        participants={selectedThread.participants}
        gmailThreadId={selectedThread.gmail_thread_id}
        threadId={selectedThread.id}
        starred={starred}
        onToggleStar={onToggleStar}
        onOpenPerson={onOpenPerson}
        onToggleFocus={onToggleFocus}
        focusMode={focusMode}
        onClose={handleClose}
      />
      <div
        ref={scrollerRef}
        className="flex-1 min-h-0 overflow-y-auto px-6 py-5"
      >
        <div className="mx-auto w-full max-w-3xl space-y-3">
          {loading && !detail && <CrmLoadingState label="Loading conversation…" />}
          {error && (
            <CrmEmptyState
              title="Couldn't load this thread"
              description={error}
            />
          )}
          {detail?.messages.map((msg) => (
            <MessageCard
              key={msg.id}
              message={msg}
              people={peopleMap}
              defaultExpanded={msg.id === lastMessageId}
              onOpenPerson={onOpenPerson}
            />
          ))}
          {detail && detail.messages.length === 0 && (
            <CrmEmptyState
              title="This thread has no messages"
              description="Likely a stub from a manual insert."
            />
          )}
          {detail && detail.messages.length > 0 && (
            <div className="pt-3">
              <QuickReply
                recipientName={
                  selectedThread.primary_sender_name ??
                  selectedThread.primary_sender_email ??
                  null
                }
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

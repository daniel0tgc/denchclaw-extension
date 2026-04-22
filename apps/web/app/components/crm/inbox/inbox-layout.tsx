"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

const STORAGE_KEY = "denchclaw.crm-inbox.list-width";
const MIN_WIDTH = 320;
const MAX_WIDTH = 640;
const DEFAULT_WIDTH = 420;
const COLLAPSE_BREAKPOINT = 900;

/**
 * Responsive shell for the inbox.
 *
 * Modes:
 *   - desktop (>= 900px)
 *       → two-pane split, resizable drag handle between list + reader.
 *         Width is persisted to localStorage so it's stable across visits.
 *   - narrow (<  900px)
 *       → single-pane drilldown. Show list when no thread is selected,
 *         otherwise show conversation pane (with back-to-list affordance
 *         baked into ConversationHeader).
 */
export function InboxLayout({
  list,
  conversation,
  hasSelection,
}: {
  list: ReactNode;
  conversation: ReactNode;
  hasSelection: boolean;
}) {
  const [width, setWidth] = useState<number>(DEFAULT_WIDTH);
  const [isNarrow, setIsNarrow] = useState<boolean>(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Hydrate persisted width.
  useEffect(() => {
    if (typeof window === "undefined") {return;}
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = parseInt(raw, 10);
        if (Number.isFinite(parsed)) {
          setWidth(clamp(parsed, MIN_WIDTH, MAX_WIDTH));
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Track narrow viewport via container width — using ResizeObserver on
  // the layout itself so we adapt to the workspace shell's main panel
  // resizing, not just the viewport.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined" || !containerRef.current) {return;}
    const observer = new ResizeObserver(([entry]) => {
      setIsNarrow(entry.contentRect.width < COLLAPSE_BREAKPOINT);
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: width };
  }, [width]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) {return;}
      const delta = e.clientX - dragRef.current.startX;
      const next = clamp(dragRef.current.startWidth + delta, MIN_WIDTH, MAX_WIDTH);
      setWidth(next);
    };
    const onUp = () => {
      if (dragRef.current) {
        try {
          window.localStorage.setItem(STORAGE_KEY, String(width));
        } catch {
          /* ignore */
        }
      }
      dragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [width]);

  // ─── Single-pane (narrow) ─────────────────────────────────────────────
  if (isNarrow) {
    return (
      <div ref={containerRef} className="h-full min-h-0 w-full">
        {hasSelection ? conversation : list}
      </div>
    );
  }

  // ─── Two-pane split ───────────────────────────────────────────────────
  return (
    <div ref={containerRef} className="flex h-full min-h-0 w-full">
      <div
        className="flex h-full min-h-0 flex-col"
        style={{
          width,
          minWidth: MIN_WIDTH,
          background: "var(--color-bg)",
          borderRight: "1px solid var(--color-border)",
        }}
      >
        {list}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={handleMouseDown}
        className="shrink-0 cursor-col-resize transition-colors"
        style={{
          width: 4,
          background: "transparent",
          marginLeft: -2,
          marginRight: -2,
          zIndex: 1,
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.background = "var(--color-accent-light)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = "transparent";
        }}
      />
      <div className="flex-1 min-w-0 h-full min-h-0">{conversation}</div>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

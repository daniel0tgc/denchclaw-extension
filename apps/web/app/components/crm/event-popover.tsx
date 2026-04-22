"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  EventDetailBody,
  type EventListItemSummary,
} from "./event-list-item";

const POPOVER_WIDTH = 360;
const POPOVER_MAX_HEIGHT = 480;
const VIEWPORT_PAD = 8;

type EventPopoverProps = {
  event: EventListItemSummary;
  /** The clicked chip's bounding rect (viewport coords). */
  anchor: DOMRect;
  onClose: () => void;
  onOpenPerson?: (id: string) => void;
  onOpenCompany?: (id: string) => void;
};

/**
 * Anchored floating popover used by the CRM Calendar grid view. Mounts the
 * shared `EventDetailBody` (same lazy-hydration component used by the list
 * view's inline expand) so loading / error / detail states stay consistent.
 *
 * Positioning: prefers right-of-anchor, falls back to left, then clamps
 * inside the viewport. Closes on backdrop click, Escape, or the × button.
 * Uses `position: fixed` so anchor coords from `getBoundingClientRect()`
 * map directly.
 */
export function EventPopover({
  event,
  anchor,
  onClose,
  onOpenPerson,
  onOpenCompany,
}: EventPopoverProps) {
  // Avoid rendering the portal during SSR.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {onClose();}
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const position = useMemo(() => {
    if (typeof window === "undefined") {return { left: 0, top: 0 };}
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Prefer right-of-anchor; fall back to left; finally clamp.
    let left = anchor.right + VIEWPORT_PAD;
    if (left + POPOVER_WIDTH + VIEWPORT_PAD > vw) {
      const leftAttempt = anchor.left - POPOVER_WIDTH - VIEWPORT_PAD;
      left = leftAttempt >= VIEWPORT_PAD
        ? leftAttempt
        : Math.max(VIEWPORT_PAD, Math.min(vw - POPOVER_WIDTH - VIEWPORT_PAD, anchor.left));
    }

    let top = anchor.top;
    if (top + POPOVER_MAX_HEIGHT + VIEWPORT_PAD > vh) {
      top = Math.max(VIEWPORT_PAD, vh - POPOVER_MAX_HEIGHT - VIEWPORT_PAD);
    }
    if (top < VIEWPORT_PAD) {top = VIEWPORT_PAD;}

    return { left, top };
  }, [anchor]);

  if (!mounted) {return null;}

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[60]"
        onClick={onClose}
        style={{ background: "transparent" }}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={event.title?.trim() || "Meeting details"}
        className="fixed z-[61] flex flex-col rounded-xl overflow-hidden"
        style={{
          left: position.left,
          top: position.top,
          width: POPOVER_WIDTH,
          maxHeight: POPOVER_MAX_HEIGHT,
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          boxShadow: "var(--shadow-lg)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex shrink-0 items-center justify-between gap-2 px-4 py-2.5"
          style={{ borderBottom: "1px solid var(--color-border)" }}
        >
          <p
            className="truncate text-[13px] font-medium"
            style={{ color: "var(--color-text)" }}
          >
            {event.title?.trim() || "(no title)"}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 p-1 rounded cursor-pointer"
            style={{ color: "var(--color-text-muted)" }}
            aria-label="Close"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <EventDetailBody
            eventId={event.id}
            fallbackEvent={event}
            onOpenPerson={onOpenPerson}
            onOpenCompany={onOpenCompany}
          />
        </div>
      </div>
    </>,
    document.body,
  );
}

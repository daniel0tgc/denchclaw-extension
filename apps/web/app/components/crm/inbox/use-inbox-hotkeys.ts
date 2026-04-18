"use client";

import { useEffect } from "react";

/**
 * Centralized keyboard shortcut handler for the CRM inbox. Mirrors
 * Gmail's defaults so muscle memory carries over:
 *
 *   j / ↓        next thread
 *   k / ↑        previous thread
 *   o / Enter    open the focused thread (and focus conversation pane)
 *   Esc          back to list (single-pane) or blur conversation
 *   /            focus search
 *   x            toggle bulk-select on the focused thread
 *   s            star / unstar the focused thread
 *   e            archive (no-op + toast for now)
 *   ?            open shortcuts cheatsheet
 *
 * Listens at the document level, but bails out if the active element
 * is an editable field (input / textarea / contentEditable) so typing
 * in search or the reply composer doesn't trigger navigation.
 */
export type InboxHotkeyHandlers = {
  next: () => void;
  prev: () => void;
  openSelected: () => void;
  back: () => void;
  focusSearch: () => void;
  toggleSelectedBulk: () => void;
  toggleStar: () => void;
  archiveSelected: () => void;
  openHelp: () => void;
};

export function useInboxHotkeys(handlers: InboxHotkeyHandlers, enabled = true): void {
  useEffect(() => {
    if (!enabled) {return;}
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) {return;}
      if (isEditingField(e.target)) {
        // Allow Esc to blur even from inputs.
        if (e.key === "Escape") {
          (e.target as HTMLElement).blur?.();
        }
        return;
      }
      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          handlers.next();
          return;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          handlers.prev();
          return;
        case "o":
        case "Enter":
          e.preventDefault();
          handlers.openSelected();
          return;
        case "Escape":
          e.preventDefault();
          handlers.back();
          return;
        case "/":
          e.preventDefault();
          handlers.focusSearch();
          return;
        case "x":
          e.preventDefault();
          handlers.toggleSelectedBulk();
          return;
        case "s":
          e.preventDefault();
          handlers.toggleStar();
          return;
        case "e":
          e.preventDefault();
          handlers.archiveSelected();
          return;
        case "?":
          e.preventDefault();
          handlers.openHelp();
          return;
        default:
          return;
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [enabled, handlers]);
}

function isEditingField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {return false;}
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {return true;}
  if (target.isContentEditable) {return true;}
  return false;
}

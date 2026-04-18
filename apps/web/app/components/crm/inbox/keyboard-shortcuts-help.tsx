"use client";

import { useEffect } from "react";

const SHORTCUTS: ReadonlyArray<{ keys: string[]; label: string }> = [
  { keys: ["j", "↓"], label: "Next thread" },
  { keys: ["k", "↑"], label: "Previous thread" },
  { keys: ["o", "Enter"], label: "Open selected thread" },
  { keys: ["Esc"], label: "Back to list" },
  { keys: ["/"], label: "Focus search" },
  { keys: ["x"], label: "Toggle bulk-select on focused thread" },
  { keys: ["s"], label: "Star / unstar focused thread" },
  { keys: ["e"], label: "Archive (read-only — toasts for now)" },
  { keys: ["?"], label: "Open this help" },
];

/**
 * Shortcut cheatsheet popover. Opens via `?` (handled by useInboxHotkeys)
 * and dismisses on Esc / outside click.
 */
export function KeyboardShortcutsHelp({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) {return;}
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) {return null;}

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8"
      style={{ background: "rgba(0,0,0,0.35)" }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Inbox keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border overflow-hidden"
        style={{
          background: "var(--color-surface)",
          borderColor: "var(--color-border-strong)",
          boxShadow: "var(--shadow-xl)",
        }}
      >
        <header
          className="flex items-center justify-between px-5 py-3"
          style={{ borderBottom: "1px solid var(--color-border)" }}
        >
          <h2
            className="font-instrument tracking-tight"
            style={{ color: "var(--color-text)", fontSize: "1.25rem" }}
          >
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 transition-colors hover:bg-[var(--color-surface-hover)]"
            style={{ color: "var(--color-text-muted)" }}
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>
        <ul className="divide-y" style={{ borderColor: "var(--color-border)" }}>
          {SHORTCUTS.map((s) => (
            <li
              key={s.label}
              className="flex items-center justify-between px-5 py-2.5 text-[13px]"
              style={{ borderBottom: "1px solid var(--color-border)" }}
            >
              <span style={{ color: "var(--color-text)" }}>{s.label}</span>
              <span className="flex items-center gap-1">
                {s.keys.map((k) => (
                  <kbd
                    key={k}
                    className="inline-flex items-center justify-center rounded border px-1.5 py-0.5 text-[11px] tabular-nums"
                    style={{
                      background: "var(--color-bg)",
                      borderColor: "var(--color-border)",
                      color: "var(--color-text)",
                      minWidth: 22,
                      fontFamily: "ui-monospace, SFMono-Regular, monospace",
                    }}
                  >
                    {k}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

"use client";

import { type ReactNode } from "react";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "blocked"
  | "error";

/**
 * List-row presentation for each source on the setup step. Intentionally
 * NOT a card — the whole setup section is one visual block with thin
 * dividers between rows (Linear/Raycast flavor), so the brand logos get to
 * breathe naked instead of being boxed in another chip. The action slot
 * still belongs to the caller so each source can own its own flow.
 */
export function ConnectionRow({
  icon,
  title,
  description,
  status,
  statusLabel,
  secondaryLabel,
  actions,
  disabledReason,
  required,
  id,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  status: ConnectionStatus;
  statusLabel?: string;
  secondaryLabel?: string;
  actions: ReactNode;
  disabledReason?: string;
  required?: boolean;
  id?: string;
}) {
  const isBlocked = status === "blocked";
  const isConnected = status === "connected";
  const secondary = secondaryLabel ?? description;
  const showDisabledLine = isBlocked && disabledReason;

  return (
    <div
      id={id}
      className="group flex items-center gap-4 py-4"
      style={{ opacity: isBlocked ? 0.55 : 1 }}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center">
        {icon}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3
            className="text-[14px] font-medium tracking-tight"
            style={{ color: "var(--color-text)" }}
          >
            {title}
          </h3>
          {isConnected && <ConnectedTick />}
          {!isConnected && required && (
            <span
              className="text-[10.5px] font-medium uppercase tracking-[0.1em]"
              style={{ color: "var(--color-text-muted)", opacity: 0.7 }}
            >
              Required
            </span>
          )}
          {statusLabel && !isConnected && (
            <span
              className="text-[10.5px] font-medium uppercase tracking-[0.1em]"
              style={{ color: "var(--color-text-muted)", opacity: 0.7 }}
            >
              {statusLabel}
            </span>
          )}
        </div>
        <p
          className="mt-0.5 truncate text-[12.5px]"
          style={{ color: "var(--color-text-muted)" }}
        >
          {showDisabledLine ? disabledReason : secondary}
        </p>
      </div>

      {actions !== null && actions !== undefined && (
        <div className="shrink-0">{actions}</div>
      )}
    </div>
  );
}

function ConnectedTick() {
  return (
    <span
      aria-label="Connected"
      className="inline-flex h-4 w-4 items-center justify-center rounded-full"
      style={{
        background: "rgba(22, 163, 74, 0.15)",
        color: "var(--color-success, #16a34a)",
      }}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </span>
  );
}

// Back-compat: some callers may still import the old name.
export { ConnectionRow as ConnectionCard };

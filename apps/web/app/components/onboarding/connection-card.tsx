"use client";

import { type ReactNode } from "react";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "blocked"
  | "error";

/**
 * Shared presentational card used for each source on the setup step. Owns
 * the visual frame (icon, title, description, status chip, right-aligned
 * action slot) but not the connection logic itself — each source injects
 * its own action button(s). Status chip colors derive from CSS variables
 * so the card respects both light and dark themes.
 */
export function ConnectionCard({
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

  return (
    <div
      id={id}
      className="rounded-2xl transition-[background,border-color,box-shadow] duration-200"
      style={{
        background: "var(--color-surface)",
        border: `1px solid ${
          status === "connected"
            ? "var(--color-border-strong)"
            : "var(--color-border)"
        }`,
        boxShadow: status === "connected" ? "var(--shadow-sm)" : "none",
        opacity: isBlocked ? 0.65 : 1,
      }}
    >
      <div className="flex items-center gap-4 px-4 py-4 sm:px-5">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
          style={{
            background: "var(--color-surface-hover)",
            color: "var(--color-text)",
          }}
        >
          {icon}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3
              className="text-[14px] font-semibold tracking-tight"
              style={{ color: "var(--color-text)" }}
            >
              {title}
            </h3>
            {required && status !== "connected" && (
              <span
                className="rounded-full px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-[0.12em]"
                style={{
                  background: "var(--color-surface-hover)",
                  color: "var(--color-text-muted)",
                }}
              >
                Required
              </span>
            )}
            <StatusChip status={status} label={statusLabel} />
          </div>
          <p
            className="mt-1 text-[12.5px] leading-relaxed"
            style={{ color: "var(--color-text-muted)" }}
          >
            {secondaryLabel ?? description}
          </p>
          {isBlocked && disabledReason && (
            <p
              className="mt-1 text-[11.5px]"
              style={{ color: "var(--color-text-muted)" }}
            >
              {disabledReason}
            </p>
          )}
        </div>

        <div className="shrink-0">{actions}</div>
      </div>
    </div>
  );
}

function StatusChip({ status, label }: { status: ConnectionStatus; label?: string }) {
  const resolved = label ?? defaultLabel(status);
  if (!resolved) {return null;}
  const tone = toneFor(status);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
      style={{ background: tone.bg, color: tone.fg }}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: tone.dot }}
      />
      {resolved}
    </span>
  );
}

function toneFor(status: ConnectionStatus): { bg: string; fg: string; dot: string } {
  switch (status) {
    case "connected":
      return {
        bg: "rgba(22, 163, 74, 0.12)",
        fg: "var(--color-success)",
        dot: "var(--color-success)",
      };
    case "connecting":
      return {
        bg: "var(--color-accent-light)",
        fg: "var(--color-accent)",
        dot: "var(--color-accent)",
      };
    case "error":
      return {
        bg: "rgba(220, 38, 38, 0.12)",
        fg: "var(--color-error)",
        dot: "var(--color-error)",
      };
    case "blocked":
    case "idle":
    default:
      return {
        bg: "var(--color-surface-hover)",
        fg: "var(--color-text-muted)",
        dot: "var(--color-text-muted)",
      };
  }
}

function defaultLabel(status: ConnectionStatus): string | null {
  switch (status) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "error":
      return "Error";
    case "blocked":
      return "Locked";
    case "idle":
    default:
      return "Not connected";
  }
}

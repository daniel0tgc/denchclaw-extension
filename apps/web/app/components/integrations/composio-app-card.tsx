"use client";

import type { ComposioToolkit } from "@/lib/composio";

export function ComposioAppCard({
  toolkit,
  activeConnections,
  totalConnections,
  featured,
  onClick,
}: {
  toolkit: ComposioToolkit;
  activeConnections: number;
  totalConnections?: number;
  featured?: boolean;
  onClick: () => void;
}) {
  const connected = activeConnections > 0;
  const accountCountLabel = `${activeConnections} account${activeConnections === 1 ? "" : "s"} connected`;
  const primaryLabel = connected ? "Manage" : "Connect";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${primaryLabel} ${toolkit.name}`}
      className="group flex h-full w-full flex-col rounded-2xl border p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-sm"
      style={{
        borderColor: connected ? "rgba(16, 185, 129, 0.28)" : "var(--color-border)",
        background: connected ? "rgba(16, 185, 129, 0.08)" : "var(--color-background-soft, var(--color-surface-hover))",
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border"
            style={{
              background: "var(--color-surface-hover)",
              borderColor: "var(--color-border)",
            }}
          >
            {toolkit.logo ? (
              <img
                src={toolkit.logo}
                alt=""
                className="h-7 w-7 object-contain"
                loading="lazy"
              />
            ) : (
              <span
                className="text-sm font-semibold uppercase"
                style={{ color: "var(--color-text-muted)" }}
              >
                {toolkit.name.slice(0, 2)}
              </span>
            )}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-base font-semibold text-foreground">
                {toolkit.name}
              </span>
              {featured && !connected && (
                <span
                  className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                  style={{
                    background: "var(--color-surface-hover)",
                    color: "var(--color-text-muted)",
                    border: "1px solid var(--color-border)",
                  }}
                >
                  Popular
                </span>
              )}
            </div>
            <p className="mt-1 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              {toolkit.tools_count} tool{toolkit.tools_count === 1 ? "" : "s"}
            </p>
          </div>
        </div>

        <span
          className="inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-[10px] font-medium"
          style={{
            background: connected ? "rgba(16, 185, 129, 0.15)" : "var(--color-surface-hover)",
            color: connected ? "rgb(74 222 128)" : "var(--color-text-muted)",
            border: connected ? "1px solid rgba(16, 185, 129, 0.24)" : "1px solid var(--color-border)",
          }}
        >
          {connected ? accountCountLabel : "Not connected"}
        </span>
      </div>

      <div className="mt-4 flex flex-1 flex-col justify-between gap-3">
        {toolkit.description ? (
          <p className="text-sm leading-5 text-muted-foreground">
            {toolkit.description}
          </p>
        ) : (
          <div />
        )}

        <div className="flex items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            {toolkit.categories.slice(0, 2).map((category) => (
              <span
                key={category}
                className="inline-flex items-center rounded-full px-2 py-1"
                style={{
                  background: "var(--color-surface-hover)",
                  color: "var(--color-text-muted)",
                  border: "1px solid var(--color-border)",
                }}
              >
                {category}
              </span>
            ))}
            {connected && typeof totalConnections === "number" && totalConnections > activeConnections && (
              <span className="text-muted-foreground">
                {totalConnections} total connection{totalConnections === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <span className="font-medium text-foreground transition-colors group-hover:text-[var(--color-accent)]">
            {primaryLabel}
          </span>
        </div>
      </div>
    </button>
  );
}

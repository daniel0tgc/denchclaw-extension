"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import type { OnboardingState } from "@/lib/denchclaw-state";
import type { LiveStats } from "./preview-workspace-mock";

type ProgressEvent = {
  phase:
    | "starting"
    | "gmail"
    | "calendar"
    | "scoring"
    | "merging"
    | "complete"
    | "error";
  message: string;
  messagesProcessed?: number;
  peopleProcessed?: number;
  companiesProcessed?: number;
  threadsProcessed?: number;
  eventsProcessed?: number;
  error?: string;
};

const READY_THRESHOLD = 2_000;

/**
 * Step 3 left pane. Kicks off the backfill (if not already started) and
 * subscribes to the existing SSE progress feed. The bulk of the real-time
 * stats render on the right via `liveStats`; the left pane shows the active
 * phase, the latest log line, and the primary "I'm ready" CTA.
 */
export function SyncStep({
  state,
  onAdvance,
  onLiveStats,
}: {
  state: OnboardingState;
  onAdvance: (next: OnboardingState) => void;
  onLiveStats?: (stats: LiveStats) => void;
}) {
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<ProgressEvent | null>(null);
  const [readyToOpen, setReadyToOpen] = useState(false);
  const [completing, setCompleting] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  const startedExisting =
    state.backfill?.gmail?.startedAt !== undefined ||
    state.backfill?.calendar?.startedAt !== undefined;

  const beginSync = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/onboarding/sync/start", { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setStarted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start sync.");
    }
  }, []);

  useEffect(() => {
    if (started || startedExisting) {return;}
    void beginSync();
  }, [beginSync, started, startedExisting]);

  useEffect(() => {
    if (eventSourceRef.current) {return;}
    const es = new EventSource("/api/onboarding/sync/progress");
    eventSourceRef.current = es;

    es.addEventListener("progress", (event) => {
      try {
        const data = JSON.parse(event.data) as ProgressEvent;
        setLatest(data);
        onLiveStats?.({
          messages: data.messagesProcessed ?? 0,
          people: data.peopleProcessed ?? 0,
          companies: data.companiesProcessed ?? 0,
          events: data.eventsProcessed ?? 0,
        });
        if ((data.messagesProcessed ?? 0) >= READY_THRESHOLD) {
          setReadyToOpen(true);
        }
        if (data.phase === "complete") {
          setReadyToOpen(true);
        }
        if (data.phase === "error") {
          setError(data.error ?? "Sync hit an unrecoverable error.");
        }
      } catch {
        // ignore malformed events
      }
    });

    es.addEventListener("error", () => {
      // SSE auto-reconnects; UI keeps showing the last known state.
    });

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [onLiveStats]);

  const handleOpen = useCallback(async () => {
    setCompleting(true);
    try {
      const res = await fetch("/api/onboarding/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "backfill", to: "complete" }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const next = (await res.json()) as OnboardingState;
      onAdvance(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not finish onboarding.");
    } finally {
      setCompleting(false);
    }
  }, [onAdvance]);

  const isComplete = latest?.phase === "complete";

  return (
    <div className="space-y-8">
      <div>
        <p
          className="mb-3 text-xs font-semibold uppercase tracking-[0.18em]"
          style={{ color: "var(--color-text-muted)" }}
        >
          Step 3 · Syncing
        </p>
        <h1
          className="font-instrument text-[34px] leading-[1.1] tracking-tight"
          style={{ color: "var(--color-text)" }}
        >
          Building your workspace.
        </h1>
        <p
          className="mt-3 text-[14.5px] leading-relaxed"
          style={{ color: "var(--color-text-muted)" }}
        >
          We&apos;re paginating through your inbox and calendar now. You can
          jump in as soon as there&apos;s a useful first cut — the rest backfills
          quietly in the background.
        </p>
      </div>

      <PhaseTimeline phase={latest?.phase ?? "starting"} />

      <div
        className="rounded-2xl px-5 py-5"
        style={{
          background: "var(--color-surface-hover)",
          border: "1px solid var(--color-border)",
        }}
      >
        <div className="flex items-center gap-2">
          <PhaseDot phase={latest?.phase ?? "starting"} active={!isComplete} />
          <span
            className="text-[11px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: "var(--color-text-muted)" }}
          >
            {phaseLabel(latest?.phase)}
          </span>
        </div>
        <p
          className="mt-2 text-[14px] leading-relaxed"
          style={{ color: "var(--color-text)" }}
        >
          {latest?.message ?? "Warming up the pipes…"}
        </p>
      </div>

      {error && (
        <div
          className="rounded-xl px-4 py-3 text-[13px]"
          style={{
            background: "rgba(239, 68, 68, 0.08)",
            color: "var(--color-error)",
            border: "1px solid rgba(239, 68, 68, 0.2)",
          }}
        >
          {error}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 pt-2">
        <p className="text-[12px]" style={{ color: "var(--color-text-muted)" }}>
          {readyToOpen
            ? "Enough data loaded — head in whenever you're ready."
            : "Hold tight. We'll unlock this as soon as the first cut is useful."}
        </p>
        <Button
          onClick={() => void handleOpen()}
          disabled={!readyToOpen || completing}
        >
          {completing ? "Finishing…" : "I'm ready"}
        </Button>
      </div>
    </div>
  );
}

function PhaseTimeline({ phase }: { phase: ProgressEvent["phase"] }) {
  const phases: Array<{ id: ProgressEvent["phase"]; label: string }> = [
    { id: "gmail", label: "Email" },
    { id: "calendar", label: "Calendar" },
    { id: "merging", label: "Dedupe" },
    { id: "scoring", label: "Rank" },
  ];
  const order: ProgressEvent["phase"][] = [
    "starting",
    "gmail",
    "calendar",
    "merging",
    "scoring",
    "complete",
  ];
  const currentIdx = order.indexOf(phase);
  return (
    <div className="flex items-center gap-2">
      {phases.map((p, idx) => {
        const pIdx = order.indexOf(p.id);
        const done = currentIdx > pIdx || phase === "complete";
        const active = currentIdx === pIdx;
        return (
          <div key={p.id} className="flex flex-1 items-center gap-2">
            <span
              className="flex h-5 w-5 items-center justify-center rounded-full text-[9.5px] font-semibold transition-colors"
              style={{
                background: done
                  ? "var(--color-accent)"
                  : active
                    ? "var(--color-accent-light)"
                    : "var(--color-surface-hover)",
                color: done
                  ? "#fff"
                  : active
                    ? "var(--color-accent)"
                    : "var(--color-text-muted)",
                border: done
                  ? "1px solid var(--color-accent)"
                  : `1px solid var(--color-border)`,
              }}
            >
              {done ? (
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                idx + 1
              )}
            </span>
            <span
              className="text-[11px] font-medium tracking-tight"
              style={{
                color:
                  done || active
                    ? "var(--color-text)"
                    : "var(--color-text-muted)",
              }}
            >
              {p.label}
            </span>
            {idx < phases.length - 1 && (
              <span
                className="ml-1 h-[2px] flex-1 rounded-full"
                style={{
                  background: done
                    ? "var(--color-accent)"
                    : "var(--color-border)",
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function PhaseDot({
  phase,
  active,
}: {
  phase: ProgressEvent["phase"];
  active: boolean;
}) {
  const color =
    phase === "error"
      ? "var(--color-error)"
      : phase === "complete"
        ? "var(--color-success)"
        : "var(--color-accent)";
  return (
    <span className="relative flex h-2.5 w-2.5 items-center justify-center">
      <span
        className="relative h-2 w-2 rounded-full"
        style={{ background: color }}
      />
      {active && (
        <span
          aria-hidden
          className="absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping"
          style={{ background: color }}
        />
      )}
    </span>
  );
}

function phaseLabel(phase: ProgressEvent["phase"] | undefined): string {
  switch (phase) {
    case "starting":
      return "Starting";
    case "gmail":
      return "Loading email";
    case "calendar":
      return "Loading calendar";
    case "merging":
      return "Merging duplicates";
    case "scoring":
      return "Ranking relationships";
    case "complete":
      return "Done";
    case "error":
      return "Error";
    default:
      return "Working";
  }
}

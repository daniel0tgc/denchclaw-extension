"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import type { OnboardingState } from "@/lib/denchclaw-state";

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

export function SyncStep({
  state,
  onAdvance,
}: {
  state: OnboardingState;
  onAdvance: (next: OnboardingState) => void;
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

  // Auto-kick the sync the first time the user lands on this step.
  useEffect(() => {
    if (started || startedExisting) {return;}
    void beginSync();
  }, [beginSync, started, startedExisting]);

  // Subscribe to progress SSE.
  useEffect(() => {
    if (eventSourceRef.current) {return;}
    const es = new EventSource("/api/onboarding/sync/progress");
    eventSourceRef.current = es;

    es.addEventListener("progress", (event) => {
      try {
        const data = JSON.parse((event).data) as ProgressEvent;
        setLatest(data);
        if (
          (data.messagesProcessed ?? 0) >= READY_THRESHOLD &&
          !readyToOpen
        ) {
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
      // SSE will auto-reconnect; we keep showing the latest known state.
    });

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [readyToOpen]);

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

  const phaseLabel = (phase: ProgressEvent["phase"] | undefined): string => {
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
  };

  const messages = latest?.messagesProcessed ?? 0;
  const people = latest?.peopleProcessed ?? 0;
  const companies = latest?.companiesProcessed ?? 0;
  const events = latest?.eventsProcessed ?? 0;

  return (
    <div className="space-y-8">
      <div>
        <p
          className="mb-3 text-xs font-semibold uppercase tracking-[0.18em]"
          style={{ color: "var(--color-text-muted)" }}
        >
          Sync
        </p>
        <h1
          className="font-instrument text-4xl tracking-tight"
          style={{ color: "var(--color-text)" }}
        >
          Building your workspace
        </h1>
        <p
          className="mt-3 text-[15px] leading-relaxed"
          style={{ color: "var(--color-text-muted)" }}
        >
          We&apos;re paginating through your inbox now. The People view starts
          populating once the first couple thousand messages are in — you can
          jump in then; the rest backfills in the background.
        </p>
      </div>

      <div
        className="rounded-2xl px-5 py-5"
        style={{
          background: "var(--color-surface-hover)",
          border: "1px solid var(--color-border)",
        }}
      >
        <div className="flex items-center justify-between">
          <span
            className="text-[11px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: "var(--color-text-muted)" }}
          >
            {phaseLabel(latest?.phase)}
          </span>
          {latest && latest.phase !== "complete" && latest.phase !== "error" && (
            <span
              className="inline-block h-2 w-2 animate-pulse rounded-full"
              style={{ background: "var(--color-accent)" }}
            />
          )}
        </div>
        <p
          className="mt-2 text-[15px] leading-relaxed"
          style={{ color: "var(--color-text)" }}
        >
          {latest?.message ?? "Connecting…"}
        </p>

        <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Messages" value={messages} />
          <Stat label="People" value={people} />
          <Stat label="Companies" value={companies} />
          <Stat label="Events" value={events} />
        </dl>
      </div>

      {error && (
        <div
          className="rounded-xl px-4 py-3 text-[13px]"
          style={{
            background: "rgba(239, 68, 68, 0.08)",
            color: "rgb(252, 165, 165)",
            border: "1px solid rgba(239, 68, 68, 0.2)",
          }}
        >
          {error}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 pt-2">
        <p className="text-[12px]" style={{ color: "var(--color-text-muted)" }}>
          {readyToOpen
            ? "Enough data loaded — open the workspace whenever you're ready."
            : "Hold on while we load enough to give you a useful first view."}
        </p>
        <Button
          onClick={() => void handleOpen()}
          disabled={!readyToOpen || completing}
        >
          {completing ? "Opening…" : "Open workspace"}
        </Button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt
        className="text-[10px] font-medium uppercase tracking-[0.16em]"
        style={{ color: "var(--color-text-muted)" }}
      >
        {label}
      </dt>
      <dd
        className="mt-1 font-instrument text-xl"
        style={{ color: "var(--color-text)" }}
      >
        {value.toLocaleString()}
      </dd>
    </div>
  );
}

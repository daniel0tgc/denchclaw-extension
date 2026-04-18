"use client";

import { useState } from "react";
import { Button } from "../ui/button";
import type { OnboardingState } from "@/lib/denchclaw-state";

const HIGHLIGHTS: Array<{ title: string; description: string }> = [
  {
    title: "Your inbox, your machine",
    description: "Emails, contacts and calendar events sync into a local DuckDB. Nothing leaves your laptop unless you say so.",
  },
  {
    title: "Strongest connections, ranked",
    description: "We score every relationship by how recent and reciprocal it is. The People view leads with the contacts that matter today.",
  },
  {
    title: "Real-time refresh",
    description: "Once connected, new emails and meetings flow into the workspace automatically — no manual refresh needed.",
  },
];

export function WelcomeStep({
  state,
  onAdvance,
}: {
  state: OnboardingState;
  onAdvance: (next: OnboardingState) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleStart() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "welcome", to: "identity" }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const next = (await res.json()) as OnboardingState;
      onAdvance(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start onboarding.");
    } finally {
      setSubmitting(false);
    }
  }

  void state;

  return (
    <div className="space-y-8">
      <div>
        <p
          className="mb-3 text-xs font-semibold uppercase tracking-[0.18em]"
          style={{ color: "var(--color-text-muted)" }}
        >
          Welcome
        </p>
        <h1
          className="font-instrument text-4xl tracking-tight"
          style={{ color: "var(--color-text)" }}
        >
          Let&apos;s set up your CRM
        </h1>
        <p
          className="mt-3 text-[15px] leading-relaxed"
          style={{ color: "var(--color-text-muted)" }}
        >
          DenchClaw is a local-first CRM. We&apos;ll connect your Gmail and
          Calendar, then build a People and Companies view from your real
          relationships — sorted by who matters most.
        </p>
      </div>

      <ul className="space-y-4">
        {HIGHLIGHTS.map((item) => (
          <li key={item.title} className="flex gap-3">
            <span
              aria-hidden
              className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
              style={{
                background: "var(--color-accent)",
                color: "#fff",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
            <div>
              <p
                className="text-[14px] font-medium"
                style={{ color: "var(--color-text)" }}
              >
                {item.title}
              </p>
              <p
                className="mt-0.5 text-[13px] leading-relaxed"
                style={{ color: "var(--color-text-muted)" }}
              >
                {item.description}
              </p>
            </div>
          </li>
        ))}
      </ul>

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
          Takes about 2 minutes.
        </p>
        <Button onClick={() => void handleStart()} disabled={submitting}>
          {submitting ? "Starting…" : "Get started"}
        </Button>
      </div>
    </div>
  );
}

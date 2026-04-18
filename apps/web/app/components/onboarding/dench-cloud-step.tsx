"use client";

import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import type { OnboardingState } from "@/lib/denchclaw-state";

type DenchCloudStatus = {
  configured: boolean;
  source: "cli" | "web" | null;
  primaryModel: string | null;
};

const HIGHLIGHTS: string[] = [
  "AI models — Claude, GPT, and more, no separate API keys",
  "1,000+ app integrations through Composio (Gmail, Slack, Notion…)",
  "Web search, voice (ElevenLabs), and image generation built-in",
];

export function DenchCloudStep({
  state,
  onAdvance,
}: {
  state: OnboardingState;
  onAdvance: (next: OnboardingState) => void;
}) {
  const [status, setStatus] = useState<DenchCloudStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoAdvanced, setAutoAdvanced] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/onboarding/dench-cloud", { cache: "no-store" });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as DenchCloudStatus;
        if (cancelled) {return;}
        setStatus(data);
      } catch (err) {
        if (cancelled) {return;}
        setError(err instanceof Error ? err.message : "Could not check Dench Cloud.");
      } finally {
        if (!cancelled) {setLoading(false);}
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-advance if Dench Cloud was already configured by the CLI bootstrap.
  useEffect(() => {
    if (autoAdvanced) {return;}
    if (!status?.configured) {return;}
    if (state.denchCloud?.source === "cli") {return;} // already recorded
    setAutoAdvanced(true);
    void (async () => {
      try {
        const res = await fetch("/api/onboarding/dench-cloud", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ acceptCli: true }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        const next = (await res.json()) as OnboardingState;
        onAdvance(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not record Dench Cloud.");
      }
    })();
  }, [autoAdvanced, onAdvance, state.denchCloud?.source, status?.configured]);

  async function handleConnect(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setError("Paste your Dench Cloud API key to continue.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/onboarding/dench-cloud", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: trimmed }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const next = (await res.json()) as OnboardingState;
      onAdvance(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the API key.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSkip() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/onboarding/dench-cloud", {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const next = (await res.json()) as OnboardingState;
      onAdvance(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not skip.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <div
          className="h-4 w-40 animate-pulse rounded"
          style={{ background: "var(--color-surface-hover)" }}
        />
        <div
          className="h-10 w-full animate-pulse rounded"
          style={{ background: "var(--color-surface-hover)" }}
        />
      </div>
    );
  }

  if (status?.configured) {
    return (
      <div className="space-y-6">
        <div>
          <p
            className="mb-3 text-xs font-semibold uppercase tracking-[0.18em]"
            style={{ color: "var(--color-text-muted)" }}
          >
            Dench Cloud
          </p>
          <h1
            className="font-instrument text-4xl tracking-tight"
            style={{ color: "var(--color-text)" }}
          >
            Already connected
          </h1>
          <p
            className="mt-3 text-[15px] leading-relaxed"
            style={{ color: "var(--color-text-muted)" }}
          >
            Looks like you set up Dench Cloud during the CLI bootstrap. Carrying on…
          </p>
        </div>
        {status.primaryModel && (
          <div
            className="rounded-xl px-4 py-3 text-[13px]"
            style={{
              background: "var(--color-surface-hover)",
              color: "var(--color-text-muted)",
            }}
          >
            Primary model: <strong style={{ color: "var(--color-text)" }}>{status.primaryModel}</strong>
          </div>
        )}
      </div>
    );
  }

  return (
    <form className="space-y-8" onSubmit={(e) => void handleConnect(e)}>
      <div>
        <p
          className="mb-3 text-xs font-semibold uppercase tracking-[0.18em]"
          style={{ color: "var(--color-text-muted)" }}
        >
          Dench Cloud
        </p>
        <h1
          className="font-instrument text-4xl tracking-tight"
          style={{ color: "var(--color-text)" }}
        >
          Connect Dench Cloud
        </h1>
        <p
          className="mt-3 text-[15px] leading-relaxed"
          style={{ color: "var(--color-text-muted)" }}
        >
          Dench Cloud powers AI models, voice, web search, and the Composio
          integrations behind the Gmail/Calendar sync. You can skip this step and
          run DenchClaw without it — but Gmail import won&apos;t be available.
        </p>
      </div>

      <ul className="space-y-2.5">
        {HIGHLIGHTS.map((item) => (
          <li
            key={item}
            className="flex gap-3 text-[13px]"
            style={{ color: "var(--color-text-muted)" }}
          >
            <span
              aria-hidden
              className="mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
              style={{ background: "var(--color-accent)", color: "#fff" }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
            {item}
          </li>
        ))}
      </ul>

      <div className="space-y-2">
        <Label htmlFor="dench-cloud-key">Dench Cloud API key</Label>
        <Input
          id="dench-cloud-key"
          type="password"
          placeholder="dench_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="off"
          disabled={submitting}
        />
        <p className="text-[12px]" style={{ color: "var(--color-text-muted)" }}>
          Get a key at{" "}
          <a
            href="https://dench.com/api"
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--color-accent)" }}
          >
            dench.com/api
          </a>
          .
        </p>
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
        <button
          type="button"
          onClick={() => void handleSkip()}
          disabled={submitting}
          className="text-[13px] underline-offset-4 transition-colors hover:underline disabled:opacity-50"
          style={{ color: "var(--color-text-muted)" }}
        >
          Skip — use DenchClaw without Gmail sync
        </button>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Validating…" : "Connect"}
        </Button>
      </div>
    </form>
  );
}

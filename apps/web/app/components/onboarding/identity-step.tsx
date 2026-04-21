"use client";

import { useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import type { OnboardingState } from "@/lib/denchclaw-state";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Step 1 left pane. Identity capture, rewritten for the split-screen shell:
 * "why" copy moves to the editorial right pane so we can keep the left
 * column tight — just a headline, two fields, and the continue CTA.
 *
 * On submit we call the identity API which records the name/email and then
 * advances the server state to `identity`. If we're coming in from the old
 * `welcome` step (first paint on a brand-new workspace), the state machine
 * will first need a `welcome → identity` transition, so we PUT that first.
 */
export function IdentityStep({
  state,
  onAdvance,
  onTypingChange,
}: {
  state: OnboardingState;
  onAdvance: (next: OnboardingState) => void;
  onTypingChange?: (next: { name: string; email: string }) => void;
}) {
  const [name, setName] = useState(state.identity?.name ?? "");
  const [email, setEmail] = useState(state.identity?.email ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleNameChange(next: string) {
    setName(next);
    onTypingChange?.({ name: next, email });
  }

  function handleEmailChange(next: string) {
    setEmail(next);
    onTypingChange?.({ name, email: next });
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName) {
      setError("Please enter your name.");
      return;
    }
    if (!EMAIL_RE.test(trimmedEmail)) {
      setError("Please enter a valid email address.");
      return;
    }
    setSubmitting(true);
    try {
      // If we're still on the legacy "welcome" bootstrap, first walk forward.
      if (state.currentStep === "welcome") {
        const res = await fetch("/api/onboarding/state", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from: "welcome", to: "identity" }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
      }

      const res = await fetch("/api/onboarding/identity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmedName, email: trimmedEmail }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const next = (await res.json()) as OnboardingState;
      onAdvance(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save identity.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-8" onSubmit={(e) => void handleSubmit(e)}>
      <div>
        <p
          className="mb-3 text-xs font-semibold uppercase tracking-[0.18em]"
          style={{ color: "var(--color-text-muted)" }}
        >
          Step 1 · About you
        </p>
        <h1
          className="font-instrument text-[34px] leading-[1.1] tracking-tight"
          style={{ color: "var(--color-text)" }}
        >
          Let&apos;s start with your name.
        </h1>
        <p
          className="mt-3 text-[14.5px] leading-relaxed"
          style={{ color: "var(--color-text-muted)" }}
        >
          We&apos;ll use this on your workspace header — and to greet you when
          things finish syncing.
        </p>
      </div>

      <div className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="onboarding-name">Full name</Label>
          <Input
            id="onboarding-name"
            type="text"
            placeholder="Sarah Chen"
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            autoComplete="name"
            autoFocus
            disabled={submitting}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="onboarding-email">Work email</Label>
          <Input
            id="onboarding-email"
            type="email"
            placeholder="sarah@acme.com"
            value={email}
            onChange={(e) => handleEmailChange(e.target.value)}
            autoComplete="email"
            disabled={submitting}
          />
          <p className="text-[12px]" style={{ color: "var(--color-text-muted)" }}>
            Tip: use the same email you&apos;ll connect to Gmail next.
          </p>
        </div>
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
          Takes about 2 minutes total.
        </p>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Continue"}
        </Button>
      </div>
    </form>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type OnboardingState,
  type OnboardingStep,
} from "@/lib/denchclaw-state";
import { WelcomeStep } from "./welcome-step";
import { IdentityStep } from "./identity-step";
import { DenchCloudStep } from "./dench-cloud-step";
import { ConnectGmailStep } from "./connect-gmail-step";
import { ConnectCalendarStep } from "./connect-calendar-step";
import { SyncStep } from "./sync-step";
import { CompleteStep } from "./complete-step";

const STEP_LABELS: Record<OnboardingStep, string> = {
  welcome: "Welcome",
  identity: "About you",
  "dench-cloud": "Dench Cloud",
  "connect-gmail": "Connect Gmail",
  "connect-calendar": "Connect Calendar",
  backfill: "Sync your inbox",
  complete: "All set",
};

const VISIBLE_STEPS: OnboardingStep[] = [
  "welcome",
  "identity",
  "dench-cloud",
  "connect-gmail",
  "connect-calendar",
  "backfill",
];

/**
 * Top-level orchestrator. Owns the in-memory copy of `OnboardingState`,
 * delegates rendering to the per-step component, and refetches state from
 * the server after every transition so a refresh resumes exactly here.
 */
export function OnboardingWizard({ initialState }: { initialState: OnboardingState }) {
  const [state, setState] = useState<OnboardingState>(initialState);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/onboarding/state", { cache: "no-store" });
      if (res.ok) {
        const next = (await res.json()) as OnboardingState;
        setState(next);
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (state.currentStep === "complete") {
      window.location.assign("/");
    }
  }, [state.currentStep]);

  const stepIndex = useMemo(
    () => Math.max(0, VISIBLE_STEPS.indexOf(state.currentStep)),
    [state.currentStep],
  );

  const handleAdvance = useCallback(
    (next: OnboardingState) => {
      setState(next);
    },
    [],
  );

  return (
    <div
      className="min-h-screen w-full"
      style={{ background: "var(--color-background)" }}
    >
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 px-6 py-10 lg:flex-row lg:gap-16 lg:py-16">
        {/* Progress rail */}
        <aside className="lg:w-72 lg:shrink-0">
          <div className="mb-8 flex items-center gap-2">
            <div
              className="flex h-9 w-9 items-center justify-center rounded-xl text-sm font-bold"
              style={{
                background: "var(--color-accent)",
                color: "#fff",
              }}
            >
              D
            </div>
            <span
              className="font-instrument text-xl tracking-tight"
              style={{ color: "var(--color-text)" }}
            >
              DenchClaw
            </span>
          </div>

          <ol className="space-y-1.5">
            {VISIBLE_STEPS.map((step, idx) => {
              const isCurrent = step === state.currentStep;
              const isCompleted = state.completedSteps.includes(step) || idx < stepIndex;
              return (
                <li key={step} className="flex items-center gap-3">
                  <span
                    aria-hidden
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
                    style={{
                      background: isCompleted
                        ? "var(--color-accent)"
                        : isCurrent
                          ? "var(--color-surface-hover)"
                          : "var(--color-surface)",
                      color: isCompleted
                        ? "#fff"
                        : isCurrent
                          ? "var(--color-text)"
                          : "var(--color-text-muted)",
                      border: isCurrent
                        ? "1px solid var(--color-accent)"
                        : "1px solid var(--color-border)",
                    }}
                  >
                    {isCompleted ? (
                      <svg
                        width="12"
                        height="12"
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
                    className="text-[13px]"
                    style={{
                      color: isCurrent
                        ? "var(--color-text)"
                        : isCompleted
                          ? "var(--color-text-muted)"
                          : "var(--color-text-muted)",
                      fontWeight: isCurrent ? 600 : 500,
                    }}
                  >
                    {STEP_LABELS[step]}
                  </span>
                </li>
              );
            })}
          </ol>

          {refreshing && (
            <p
              className="mt-6 text-[11px] uppercase tracking-wider"
              style={{ color: "var(--color-text-muted)" }}
            >
              Syncing…
            </p>
          )}
        </aside>

        {/* Step body */}
        <main className="flex-1">
          <div
            className="mx-auto max-w-xl rounded-3xl"
            style={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              boxShadow: "var(--shadow-sm)",
            }}
          >
            <div className="px-8 py-10 sm:px-12 sm:py-14">
              <StepContent state={state} onAdvance={handleAdvance} onRefresh={refresh} />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function StepContent({
  state,
  onAdvance,
  onRefresh,
}: {
  state: OnboardingState;
  onAdvance: (next: OnboardingState) => void;
  onRefresh: () => Promise<void>;
}) {
  switch (state.currentStep) {
    case "welcome":
      return <WelcomeStep state={state} onAdvance={onAdvance} />;
    case "identity":
      return <IdentityStep state={state} onAdvance={onAdvance} />;
    case "dench-cloud":
      return <DenchCloudStep state={state} onAdvance={onAdvance} />;
    case "connect-gmail":
      return <ConnectGmailStep state={state} onAdvance={onAdvance} onRefresh={onRefresh} />;
    case "connect-calendar":
      return (
        <ConnectCalendarStep state={state} onAdvance={onAdvance} onRefresh={onRefresh} />
      );
    case "backfill":
      return <SyncStep state={state} onAdvance={onAdvance} />;
    case "complete":
      return <CompleteStep state={state} />;
    default:
      return <WelcomeStep state={state} onAdvance={onAdvance} />;
  }
}

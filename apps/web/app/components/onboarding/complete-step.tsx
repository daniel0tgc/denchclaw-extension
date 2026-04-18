"use client";

import { useEffect } from "react";
import type { OnboardingState } from "@/lib/denchclaw-state";

export function CompleteStep({ state }: { state: OnboardingState }) {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.location.assign("/");
    }, 600);
    return () => window.clearTimeout(timer);
  }, []);

  void state;

  return (
    <div className="flex flex-col items-center justify-center gap-5 py-6 text-center">
      <span
        aria-hidden
        className="flex h-14 w-14 items-center justify-center rounded-full"
        style={{ background: "var(--color-accent)", color: "#fff" }}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
      <h1
        className="font-instrument text-3xl tracking-tight"
        style={{ color: "var(--color-text)" }}
      >
        You&apos;re all set
      </h1>
      <p className="text-[14px]" style={{ color: "var(--color-text-muted)" }}>
        Opening your workspace…
      </p>
    </div>
  );
}

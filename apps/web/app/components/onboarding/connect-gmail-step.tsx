"use client";

import { ConnectToolkitStep } from "./connect-toolkit-step";
import type { OnboardingState } from "@/lib/denchclaw-state";

const BENEFITS: string[] = [
  "We pull every email — sent, received, threads, attachments — into your local DuckDB.",
  "Senders and recipients become People rows, deduped by lowercased email address.",
  "Email domains turn into Companies, with personal-domain hits (gmail.com, etc.) skipped.",
];

export function ConnectGmailStep({
  state,
  onAdvance,
  onRefresh,
}: {
  state: OnboardingState;
  onAdvance: (next: OnboardingState) => void;
  onRefresh: () => Promise<void>;
}) {
  return (
    <ConnectToolkitStep
      state={state}
      onAdvance={onAdvance}
      onRefresh={onRefresh}
      toolkitName="Gmail"
      toolkitSlug="gmail"
      storageKey="gmail"
      headline="Connect Gmail"
      description="We need read access to your inbox so we can build your People view. Auth happens through Composio's OAuth flow — credentials are scoped to Dench Cloud, not stored locally."
      benefits={BENEFITS}
      fromStep="connect-gmail"
      toStep="connect-calendar"
    />
  );
}

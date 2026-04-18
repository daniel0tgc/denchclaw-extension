"use client";

import { ConnectToolkitStep } from "./connect-toolkit-step";
import type { OnboardingState } from "@/lib/denchclaw-state";

const BENEFITS: string[] = [
  "Past five years of meetings + a year of upcoming events become Calendar Event rows.",
  "Attendees link to People; meeting size determines weight in the Strongest-Connection score.",
  "1:1 meetings count as 8× a single email when ranking your closest relationships.",
];

export function ConnectCalendarStep({
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
      toolkitName="Google Calendar"
      toolkitSlug="google-calendar"
      storageKey="calendar"
      headline="Connect Google Calendar"
      description="Calendar events boost the Strongest-Connection score — 1:1 meetings count for a lot, group meetings for less. Optional, but skipping it weakens the ranking."
      benefits={BENEFITS}
      fromStep="connect-calendar"
      toStep="backfill"
      allowSkip
    />
  );
}
